import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const publicDirectory = path.join(repository, 'wiki/public');
const conceptDirectory = await realpath(path.join(repository, 'concepts'));
const manifest = JSON.parse(await readFile(new URL('../asset-sources.json', import.meta.url), 'utf8'));
const destinations = new Set();
const sources = [];
const hash = data => createHash('sha256').update(data).digest('hex');
const inside = (base, file) => file.startsWith(base + path.sep);

if (manifest.version !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) {
  throw new Error('Expected a nonempty version 1 asset-sources.json.');
}
for (const entry of manifest.files) {
  if (!/^concepts\//.test(entry.source) || /\\/.test(entry.source + entry.destination)
      || !/^(art\/|records\/neighborhood\/)/.test(entry.destination)
      || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
    throw new Error(`Invalid asset mapping: ${JSON.stringify(entry)}`);
  }
  const source = await realpath(path.resolve(repository, entry.source));
  const destination = path.resolve(publicDirectory, entry.destination);
  const managedDestination = inside(path.join(publicDirectory, 'art'), destination)
    || inside(path.join(publicDirectory, 'records/neighborhood'), destination);
  if (!inside(conceptDirectory, source) || !managedDestination
      || destinations.has(destination)) {
    throw new Error(`Out-of-scope or duplicate asset mapping: ${entry.destination}`);
  }
  const bytes = await readFile(source);
  if (hash(bytes) !== entry.sha256) {
    throw new Error(`Source SHA-256 mismatch: ${entry.source}. Restore the pinned source or deliberately review and update the manifest.`);
  }
  destinations.add(destination);
  sources.push({ source, destination, sha256: entry.sha256 });
}

// Validate every input before writing any delivery copy. These directories are
// generated; reject unlisted files instead of silently publishing stale art.
async function rejectUnlisted(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Generated asset cannot be a symlink: ${file}`);
    if (entry.isDirectory()) await rejectUnlisted(file);
    else if (!destinations.has(file)) throw new Error(`Unlisted generated asset: ${file}`);
  }
}
await rejectUnlisted(path.join(publicDirectory, 'art'));
await rejectUnlisted(path.join(publicDirectory, 'records/neighborhood'));
for (const entry of sources) {
  await mkdir(path.dirname(entry.destination), { recursive: true });
  await copyFile(entry.source, entry.destination);
  if (hash(await readFile(entry.destination)) !== entry.sha256) {
    throw new Error(`Copied asset SHA-256 mismatch: ${entry.destination}`);
  }
}
console.log(JSON.stringify({ generatedAssets: sources.length, source: 'concepts/', manifest: 'asset-sources.json' }));
