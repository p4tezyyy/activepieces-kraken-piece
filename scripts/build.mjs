import { build } from 'esbuild';
import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
await mkdir('dist/src', { recursive: true });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit'], { stdio: 'inherit' });
await build({ entryPoints: ['src/index.ts'], outfile: 'dist/src/index.js', bundle: true,
  platform: 'node', target: 'node22', format: 'cjs', minify: true, keepNames: true, legalComments: 'eof',
  loader: { '.png': 'dataurl' },
  metafile: true }).then(async r => writeFile('work/bundle-meta.json', JSON.stringify(r.metafile, null, 2)));
await build({ entryPoints: ['src/client.ts', 'src/cli.ts', 'src/poll.ts'], outdir: 'work/test-lib', platform: 'node', target: 'node22', format: 'cjs' });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '--declaration', '--emitDeclarationOnly', '--outDir', 'dist/types'], { stdio: 'inherit' });
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
await mkdir('dist/package/src', { recursive: true });
await copyFile('dist/src/index.js', 'dist/package/src/index.js');
for (const file of ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) await copyFile(file, 'dist/package/' + file);
const manifest = { ...pkg, main: './src/index.js', types: undefined, scripts: {}, devDependencies: undefined, files: ['src/index.js', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md'] };
await writeFile('dist/package/package.json', JSON.stringify(manifest, null, 2) + '\n');
console.log('Built self-contained Activepieces bundle and upload manifest.');
