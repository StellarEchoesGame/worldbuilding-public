import { readFile, writeFile } from 'node:fs/promises';
const source = JSON.parse(await readFile('src/data/prompt-records.json', 'utf8'));
await writeFile('public/records/concept-prompts.json', JSON.stringify(source, null, 2) + '\n');
