#!/usr/bin/env node
/**
 * Build all distribution bundles using esbuild.
 *
 * Produces:
 *   dist/wasm-os.browser.js       - Browser ESM bundle
 *   dist/worker-entry.browser.js  - Browser worker entry bundle
 *   dist/wasm-os.node.mjs         - Node.js ESM bundle
 *   dist/wasm-os.node.cjs         - Node.js CJS bundle
 */

import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const hostDir = join(__dirname, '..');
const distDir = join(hostDir, 'dist');

mkdirSync(distDir, { recursive: true });

const esbuild = 'npx esbuild';

const nodeExternals = [
  'node:worker_threads',
  'node:test',
  'node:assert',
  'node:assert/strict',
  'node:child_process',
  'node:fs',
  'node:fs/promises',
  'node:path',
  'node:url',
  'node:crypto',
].map(e => `--external:${e}`).join(' ');

// ── Browser bundles ─────────────────────────────────────────────────

console.log('Building wasm-os.browser.js...');
execSync(`${esbuild} src/index.ts \
  --bundle --format=esm --platform=browser --target=es2022 \
  --outfile=dist/wasm-os.browser.js \
  ${nodeExternals}`,
  { cwd: hostDir, stdio: 'inherit' },
);

console.log('Building worker-entry.browser.js...');
execSync(`${esbuild} src/worker-entry.browser.ts \
  --bundle --format=esm --platform=browser --target=es2022 \
  --outfile=dist/worker-entry.browser.js`,
  { cwd: hostDir, stdio: 'inherit' },
);

// ── Node.js ESM bundle ──────────────────────────────────────────────

console.log('Building wasm-os.node.mjs...');
execSync(`${esbuild} src/index.ts \
  --bundle --format=esm --platform=node --target=node18 \
  --outfile=dist/wasm-os.node.mjs \
  ${nodeExternals}`,
  { cwd: hostDir, stdio: 'inherit' },
);

// ── Node.js CJS bundle ─────────────────────────────────────────────

console.log('Building wasm-os.node.cjs...');
execSync(`${esbuild} src/index.ts \
  --bundle --format=cjs --platform=node --target=node18 \
  --outfile=dist/wasm-os.node.cjs \
  ${nodeExternals}`,
  { cwd: hostDir, stdio: 'inherit' },
);

console.log('\nBuild complete:');
execSync('ls -lh dist/', { cwd: hostDir, stdio: 'inherit' });
