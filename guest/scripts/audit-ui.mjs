import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (/\.(tsx|jsx)$/.test(entry.name)) files.push(path);
  }
  return files;
}

const files = (await walk('src')).filter((path) => !path.includes('/agent/'));
const violations = [];
const ids = new Map();
for (const file of files) {
  const source = await readFile(file, 'utf8');
  if (/<(button|input|textarea|select|a)(\s|>)/.test(source)) violations.push(file + ': raw interactive JSX element');
  for (const match of source.matchAll(/agentId=["']([^"']+)["']/g)) {
    const prior = ids.get(match[1]);
    if (prior) violations.push(file + ': duplicate agentId "' + match[1] + '" also in ' + prior);
    else ids.set(match[1], file);
  }
}
if (violations.length) {
  console.error('Agent instrumentation audit failed:\n' + violations.join('\n'));
  process.exit(1);
}
console.log('Agent instrumentation audit passed for ' + ids.size + ' targets.');
