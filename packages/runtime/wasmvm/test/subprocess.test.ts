/**
 * Subprocess lifecycle integration tests.
 *
 * Tests the full subprocess spawn/wait/kill cycle between WASM and the JS host:
 * - Worker entry script wires ProcessManager and UserManager
 * - WASM code calls std::process::Command::output() to spawn children
 * - Parent blocks on Atomics.wait until child exits
 * - Child exit code propagates correctly
 * - proc_kill terminates running children
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WasmOS } from '../src/wasm-os.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = join(__dirname, '../../target/wasm32-wasip1/release/multicall.wasm');

describe('Subprocess lifecycle integration', { timeout: 30000 }, () => {
  let os: WasmOS;

  before(async () => {
    const wasmBinary = await readFile(WASM_PATH);
    os = new WasmOS({ wasmBinary });
    await os.init();
  });

  it('spawn-test echo hello spawns child and collects output', async () => {
    const result = await os.exec('spawn-test echo hello');
    assert.strictEqual(result.exitCode, 0, `expected exit 0, got ${result.exitCode}: stderr=${result.stderr}`);
    assert.strictEqual(result.stdout, 'hello\n');
  });

  it('spawn-test true returns exit code 0', async () => {
    const result = await os.exec('spawn-test true');
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stdout, '');
  });

  it('spawn-test false propagates non-zero exit code', async () => {
    const result = await os.exec('spawn-test false');
    assert.notStrictEqual(result.exitCode, 0, 'false should return non-zero exit code');
  });

  it('spawn-test with multiple args passes them to child', async () => {
    const result = await os.exec('spawn-test echo hello world');
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stdout, 'hello world\n');
  });

  it('spawn-test nonexistent returns non-zero exit code', async () => {
    const result = await os.exec('spawn-test nonexistent-command-xyz');
    assert.notStrictEqual(result.exitCode, 0);
  });

  it('spawn-test seq produces expected output', async () => {
    const result = await os.exec('spawn-test seq 3');
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stdout, '1\n2\n3\n');
  });
});
