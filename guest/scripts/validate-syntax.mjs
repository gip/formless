import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) files.push(path);
  }
  return files;
}

const diagnostics = [];
for (const file of await walk('src')) {
  const source = await readFile(file, 'utf8');
  const result = ts.transpileModule(source, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  for (const diagnostic of result.diagnostics || []) {
    diagnostics.push(file + ': ' + ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '));
  }
}
if (diagnostics.length) {
  console.error('TypeScript syntax validation failed:\n' + diagnostics.join('\n'));
  process.exit(1);
}
console.log('TypeScript syntax validation passed.');
