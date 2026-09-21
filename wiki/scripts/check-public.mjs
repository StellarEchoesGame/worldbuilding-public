import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = path.resolve('dist');
const walk = async (dir) => (await Promise.all((await readdir(dir, {withFileTypes:true})).map(async e => e.isDirectory() ? walk(path.join(dir,e.name)) : [path.join(dir,e.name)]))).flat();
const files = await walk(root);
const available = new Set(files);
const errors = [];
let links = 0;
let htmlPages = 0;
const forbidden = [/\/Users\//i,/redacted-handle/i,/127\.0\.0\.1/,/\.secret\//i,/feishu\.cn/i,/CLOUDFLARE_GLOBAL_API_KEY/,/X-Auth-Key/i,/sk-[A-Za-z0-9]{24,}/];
for (const file of files) {
  const relative = path.relative(root,file);
  if (/\.env(?:\.|$)|(?:^|\/)node_modules\/|\.map$/.test(relative)) errors.push(`Unexpected public file: ${relative}`);
  const size = (await stat(file)).size;
  if (size > 25 * 1024 * 1024) errors.push(`Exceeds Pages per-file limit: ${relative}`);
  if (!/\.(html|json|txt|js|css)$/.test(file)) continue;
  const text = await readFile(file,'utf8');
  for (const re of forbidden) if (re.test(text)) errors.push(`Private material marker ${re} in ${relative}`);
  if (!file.endsWith('.html')) continue;
  htmlPages++;
  if (!/<html\b[^>]*data-theme="light"/.test(text)) errors.push(`Not light at first render: ${relative}`);
  if (text.includes('<starlight-theme-select')) errors.push(`Unexpected theme switch: ${relative}`);
  const route = relative.replace(/index\.html$/, '');
  for (const match of text.matchAll(/(?:href|src)=["']([^"']+)["']/g)) {
    const link = match[1].replaceAll('&amp;','&');
    if (/^(?:mailto:|tel:|data:|blob:)/.test(link)) continue;
    const url = new URL(link, `https://wiki.stellar-echoes.online/${route}`);
    if (url.origin !== 'https://wiki.stellar-echoes.online') continue;
    links++;
    const decoded = decodeURIComponent(url.pathname);
    // Starlight's special 404.html has a /404/ canonical URL. It is expected
    // to be served with a 404 status by Pages, rather than a content route.
    if (relative === '404.html' && decoded === '/404/') continue;
    const candidate = path.join(root, decoded);
    if (!available.has(candidate) && !available.has(path.join(candidate,'index.html'))) errors.push(`Missing ${link} from ${relative}`);
  }
}
if (htmlPages < 16) errors.push(`Expected home, gallery, 13 articles and 404; got ${htmlPages} HTML pages`);
const searchFiles = files.filter(f => f.includes('/pagefind/') && f.endsWith('.pf_index'));
if (searchFiles.length === 0) errors.push('Missing built Pagefind search index');
const sourceAssets = JSON.parse(await readFile('asset-sources.json', 'utf8'));
for (const asset of sourceAssets.files) {
  try {
    const bytes = await readFile(path.join(root, asset.destination));
    if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) {
      errors.push(`Built asset differs from pinned concept source: ${asset.destination}`);
    }
  } catch (error) {
    errors.push(`Missing pinned asset: ${asset.destination} (${error.code})`);
  }
}
const archive = JSON.parse(await readFile('src/data/prompt-records.json', 'utf8'));
const exported = JSON.parse(await readFile(path.join(root,'records/concept-prompts.json'), 'utf8'));
if (JSON.stringify(archive) !== JSON.stringify(exported)) errors.push('Public prompt export differs from source');
const imageFiles = files.filter(f => f.includes('/art/') && f.endsWith('.png')).map(f => '/' + path.relative(root,f));
const images = archive.records.map(r => r.image);
if (images.length !== new Set(images).size || new Set(archive.records.map(r=>r.id)).size !== images.length) errors.push('Duplicate prompt record');
for (const image of imageFiles) if (!images.includes(image)) errors.push(`Missing prompt provenance: ${image}`);
for (const record of archive.records) {
  if (!imageFiles.includes(record.image)) errors.push(`Missing prompt image: ${record.image}`);
  if (!record.steps.length || record.steps.some(step => !step.prompt || !step.prompt.trim())) errors.push(`Empty generation prompt: ${record.id}`);
  for (const step of record.steps) for (const reference of step.referenceImages || []) if (!images.includes(reference)) errors.push(`Unknown reference image: ${reference}`);
}
const index = await readFile(path.join(root,'prompts/index.html'),'utf8');
const decode = text => text.replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&quot;','"').replaceAll('&#39;',"'").replaceAll('&amp;','&');
const rendered = Array.from(index.matchAll(/<pre\b[^>]*class="prompt-text"[^>]*>([\s\S]*?)<\/pre>/g), m=>decode(m[1]));
const originals = archive.records.flatMap(record=>record.steps.map(step=>step.prompt));
if (JSON.stringify(rendered) !== JSON.stringify(originals)) errors.push('Rendered prompts differ from complete source text');
for (const record of archive.records) if (!index.includes(`id="${record.id}"`)) errors.push(`Missing permanent prompt anchor: ${record.id}`);
console.log(JSON.stringify({promptImages:images.length,originalPromptSteps:originals.length,renderedPromptSteps:rendered.length,pinnedAssets:sourceAssets.files.length}));
console.log(JSON.stringify({files:files.length,htmlPages,internalReferences:links,searchIndexes:searchFiles.length,errors},null,2));
if (errors.length) process.exit(1);
