/**
 * Build platform widget IIFE bundles into dist/platform-widgets/.
 * TipTap is build-time only — never imported by Node runtime.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  cpSync,
} from 'node:fs';
import { createRequire as nodeCreateRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');
const pkgDir = resolve(__dirname, '../rich-document');
const outDir = resolve(repoRoot, 'dist/platform-widgets/rich-document');
const MAX_RAW_BYTES = 2 * 1024 * 1024;

function fail(msg) {
  console.error(`[build:platform-widgets] ${msg}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    stdio: 'inherit',
    cwd: opts.cwd ?? repoRoot,
    env: process.env,
    shell: false,
  });
  if (r.status !== 0) {
    fail(`${cmd} ${args.join(' ')} failed with exit ${r.status}`);
  }
}

// Ensure nested deps (TipTap etc.)
const lock = join(pkgDir, 'package-lock.json');
if (existsSync(lock)) {
  run('npm', ['ci', '--prefix', pkgDir]);
} else {
  run('npm', ['install', '--prefix', pkgDir, '--include=dev']);
}

mkdirSync(outDir, { recursive: true });

const entry = join(pkgDir, 'src/main.ts');
if (!existsSync(entry)) fail(`missing entry ${entry}`);

const require = nodeCreateRequire(join(pkgDir, 'package.json'));
let esbuild;
try {
  esbuild = require('esbuild');
} catch (e) {
  fail(`cannot load esbuild from rich-document package: ${e instanceof Error ? e.message : String(e)}`);
}

await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  outfile: join(outDir, 'main.js'),
  minify: true,
  sourcemap: false,
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': '"production"',
  },
});

const mainJs = join(outDir, 'main.js');
const size = statSync(mainJs).size;
if (size > MAX_RAW_BYTES) {
  fail(`main.js is ${size} bytes (max ${MAX_RAW_BYTES})`);
}
console.log(`[build:platform-widgets] main.js ${size} bytes`);

cpSync(join(pkgDir, 'src/index.html'), join(outDir, 'index.html'));
cpSync(join(pkgDir, 'src/styles.css'), join(outDir, 'styles.css'));

const html = readFileSync(join(outDir, 'index.html'), 'utf8');
if (!html.includes('src="./main.js"') || html.includes('type="module"')) {
  fail('index.html must load classic IIFE main.js (not type=module)');
}

writeFileSync(
  join(outDir, '.built'),
  `${new Date().toISOString()}\nsize=${size}\n`,
  'utf8',
);

console.log(`[build:platform-widgets] wrote ${outDir}`);
