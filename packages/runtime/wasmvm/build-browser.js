#!/usr/bin/env node
/**
 * Build browser ESM bundle using esbuild.
 *
 * Produces:
 *   dist/wasm-os.browser.js       - Main ESM bundle
 *   dist/worker-entry.browser.js  - Worker entry bundle (loaded as Web Worker)
 */

import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const hostDir = join(__dirname, '..');
const distDir = join(hostDir, 'dist');

// Ensure dist directory exists
mkdirSync(distDir, { recursive: true });

const esbuild = 'npx esbuild';

// Bundle main entry point (excludes Node.js builtins)
console.log('Building wasm-os.browser.js...');
execSync(`${esbuild} src/index.ts \
  --bundle \
  --format=esm \
  --platform=browser \
  --target=es2022 \
  --outfile=dist/wasm-os.browser.js \
  --external:node:worker_threads \
  --external:node:test \
  --external:node:assert \
  --external:node:assert/strict \
  --external:node:child_process \
  --external:node:fs \
  --external:node:fs/promises \
  --external:node:path \
  --external:node:url`,
  { cwd: hostDir, stdio: 'inherit' },
);

// Bundle browser-specific worker entry (no Node.js dependencies)
console.log('Building worker-entry.browser.js...');
execSync(`${esbuild} src/worker-entry.browser.ts \
  --bundle \
  --format=esm \
  --platform=browser \
  --target=es2022 \
  --outfile=dist/worker-entry.browser.js`,
  { cwd: hostDir, stdio: 'inherit' },
);

console.log('\nBrowser build complete:');
execSync('ls -lh dist/', { cwd: hostDir, stdio: 'inherit' });
