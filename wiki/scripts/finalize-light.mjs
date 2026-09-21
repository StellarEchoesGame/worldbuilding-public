import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
// Starlight's HTML shell has a dark SSR default. Fix it in the static output too,
// so the paper palette remains correct before JavaScript and without JavaScript.
async function visit(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) await visit(file);
    else if (file.endsWith('.html')) {
      const html = await readFile(file, 'utf8');
      await writeFile(file, html.replace(/(<html\b[^>]*\bdata-theme=)["']dark["']/, '$1"light"'));
    }
  }
}
await visit('dist');
