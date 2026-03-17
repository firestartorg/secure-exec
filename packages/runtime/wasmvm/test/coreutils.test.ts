/**
 * Phase 1 integration tests — coreutils commands.
 *
 * These tests use the actual WASM binary and exercise the full stack:
 * WasmOS → sh -c → PipelineOrchestrator → Worker → brush-shell (WASM).
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WasmOS } from '../src/wasm-os.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = join(__dirname, '../../target/wasm32-wasip1/release/multicall.wasm');

describe('Phase 1 integration: coreutils', { timeout: 30000 }, () => {
  let os: WasmOS;

  before(async () => {
    const wasmBinary = await readFile(WASM_PATH);
    os = new WasmOS({ wasmBinary });
    await os.init();
  });

  it('echo hello outputs hello with newline and exit code 0', async () => {
    const result = await os.exec('echo hello');
    assert.strictEqual(result.stdout, 'hello\n');
    assert.strictEqual(result.exitCode, 0);
  });

  it('true returns exit code 0', async () => {
    const result = await os.exec('true');
    assert.strictEqual(result.exitCode, 0);
  });

  it('false returns exit code 1', async () => {
    const result = await os.exec('false');
    assert.strictEqual(result.exitCode, 1);
  });

  it('echo hello > /tmp/f.txt && cat /tmp/f.txt outputs hello', async () => {
    const result = await os.exec('echo hello > /tmp/f.txt && cat /tmp/f.txt');
    assert.strictEqual(result.stdout, 'hello\n');
    assert.strictEqual(result.exitCode, 0);
  });

  it('cat nonexistent returns non-zero exit code and stderr', async () => {
    const result = await os.exec('cat nonexistent');
    assert.notStrictEqual(result.exitCode, 0);
    assert.ok(result.stderr.length > 0, 'stderr should contain an error message');
  });

  it('ls /tmp shows files after writing them', async () => {
    // Write files via programmatic API
    os.writeFile('/tmp/alpha.txt', 'aaa');
    os.writeFile('/tmp/beta.txt', 'bbb');

    const result = await os.exec('ls /tmp');
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('alpha.txt'), 'should list alpha.txt');
    assert.ok(result.stdout.includes('beta.txt'), 'should list beta.txt');
  });
});
