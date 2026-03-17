/**
 * Phase 1 integration tests — pipeline execution via brush-shell.
 *
 * With the brush-shell migration (US-005), all commands are executed via
 * `sh -c '<command>'`. Pipelines are handled internally by brush-shell
 * using proc_spawn (US-006: child process support).
 *
 * Tests multi-stage pipelines, command substitution, subshells, and
 * exit code propagation using the actual WASM binary.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WasmOS } from '../src/wasm-os.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = join(__dirname, '../../target/wasm32-wasip1/release/multicall.wasm');

describe('Phase 1 integration: single commands via brush-shell', { timeout: 30000 }, () => {
  let os: WasmOS;

  before(async () => {
    const wasmBinary = await readFile(WASM_PATH);
    os = new WasmOS({ wasmBinary });
    await os.init();
  });

  it('echo hello outputs hello', async () => {
    const result = await os.exec('echo hello');
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stdout, 'hello\n');
  });
});

describe('Phase 1 integration: pipelines via brush-shell', { timeout: 30000 }, () => {
  let os: WasmOS;

  before(async () => {
    const wasmBinary = await readFile(WASM_PATH);
    os = new WasmOS({ wasmBinary });
    await os.init();
  });

  it('echo hello | cat outputs hello', async () => {
    const result = await os.exec('echo hello | cat');
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stdout, 'hello\n');
  });

  it('echo hello | cat | wc -c outputs 6', async () => {
    const result = await os.exec('echo hello | cat | wc -c');
    assert.strictEqual(result.exitCode, 0);
    const count = result.stdout.trim();
    assert.strictEqual(count, '6', `expected byte count 6, got '${count}'`);
  });

  it('echo hello | sort -r outputs hello', { skip: 'uu_sort panics on WASI: std::thread::spawn not supported' }, async () => {
    const result = await os.exec('echo hello | sort -r');
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stdout, 'hello\n');
  });

  it('echo hello | tr a-z A-Z | wc -c outputs correct count', async () => {
    const result = await os.exec('echo hello | tr a-z A-Z | wc -c');
    assert.strictEqual(result.exitCode, 0);
    const count = result.stdout.trim();
    assert.strictEqual(count, '6', `expected byte count 6, got '${count}'`);
  });
});

describe('Phase 1 integration: command substitution', { timeout: 30000 }, () => {
  let os: WasmOS;

  before(async () => {
    const wasmBinary = await readFile(WASM_PATH);
    os = new WasmOS({ wasmBinary });
    await os.init();
  });

  it('echo $(echo hello) outputs hello', async () => {
    const result = await os.exec('echo $(echo hello)');
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stdout, 'hello\n');
  });

  it('variable assignment with command substitution', async () => {
    const result = await os.exec('VAR=$(echo world); echo hello $VAR');
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stdout, 'hello world\n');
  });
});

describe('Phase 1 integration: subshells', { timeout: 30000 }, () => {
  let os: WasmOS;

  before(async () => {
    const wasmBinary = await readFile(WASM_PATH);
    os = new WasmOS({ wasmBinary });
    await os.init();
  });

  it('(echo sub) outputs sub', async () => {
    const result = await os.exec('(echo sub)');
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stdout, 'sub\n');
  });
});

describe('Phase 1 integration: exit code propagation', { timeout: 30000 }, () => {
  let os: WasmOS;

  before(async () => {
    const wasmBinary = await readFile(WASM_PATH);
    os = new WasmOS({ wasmBinary });
    await os.init();
  });

  it('true returns exit code 0', async () => {
    const result = await os.exec('true');
    assert.strictEqual(result.exitCode, 0);
  });

  it('false returns non-zero exit code', async () => {
    const result = await os.exec('false');
    assert.notStrictEqual(result.exitCode, 0);
  });

  it('pipeline exit code is from last command', async () => {
    const result = await os.exec('echo hello | true');
    assert.strictEqual(result.exitCode, 0);
  });

  it('pipeline with failing last command', async () => {
    const result = await os.exec('echo hello | false');
    assert.notStrictEqual(result.exitCode, 0);
  });
});
