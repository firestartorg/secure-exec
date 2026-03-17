/**
 * Integration tests for awk command.
 *
 * Tests use the actual WASM binary and exercise the full stack:
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

describe('awk integration', { timeout: 30000 }, () => {
  let os: WasmOS;

  before(async () => {
    const wasmBinary = await readFile(WASM_PATH);
    os = new WasmOS({ wasmBinary });
    await os.init();
  });

  it('print specific field: {print $2}', async () => {
    const result = await os.exec("echo 'a b c' | awk '{print $2}'");
    assert.strictEqual(result.stdout.trim(), 'b');
    assert.strictEqual(result.exitCode, 0);
  });

  it('BEGIN block', async () => {
    const result = await os.exec("echo '' | awk 'BEGIN {print \"hello\"}'");
    assert.strictEqual(result.stdout.trim(), 'hello');
  });

  it('END block', async () => {
    const result = await os.exec("printf 'a\\nb\\nc\\n' | awk 'END {print NR}'");
    assert.strictEqual(result.stdout.trim(), '3');
  });

  it('pattern matching', async () => {
    const result = await os.exec("printf 'foo\\nbar\\nbaz\\n' | awk '/ba/'");
    assert.strictEqual(result.stdout, 'bar\nbaz\n');
  });

  it('field separator with -F', async () => {
    const result = await os.exec("echo 'a:b:c' | awk -F: '{print $2}'");
    assert.strictEqual(result.stdout.trim(), 'b');
  });

  it('NR (line number)', async () => {
    const result = await os.exec("printf 'a\\nb\\nc\\n' | awk '{print NR, $0}'");
    assert.strictEqual(result.stdout, '1 a\n2 b\n3 c\n');
  });

  it('arithmetic', async () => {
    const result = await os.exec("echo '' | awk 'BEGIN {print 2 + 3}'");
    assert.strictEqual(result.stdout.trim(), '5');
  });

  it('multiple fields', async () => {
    const result = await os.exec("echo '1 2 3' | awk '{print $1 + $2 + $3}'");
    assert.strictEqual(result.stdout.trim(), '6');
  });

  it('NF (number of fields)', async () => {
    const result = await os.exec("echo 'a b c d' | awk '{print NF}'");
    assert.strictEqual(result.stdout.trim(), '4');
  });

  it('print $0 (whole line)', async () => {
    const result = await os.exec("echo 'hello world' | awk '{print $0}'");
    assert.strictEqual(result.stdout.trim(), 'hello world');
  });

  it('conditional pattern', async () => {
    const result = await os.exec("printf '1\\n2\\n3\\n4\\n5\\n' | awk '$1 > 3'");
    assert.strictEqual(result.stdout, '4\n5\n');
  });

  it('string concatenation', async () => {
    const result = await os.exec("echo 'hello' | awk '{print $1 \" world\"}'");
    assert.strictEqual(result.stdout.trim(), 'hello world');
  });

  it('variable assignment with -v', async () => {
    const result = await os.exec("echo '' | awk -v x=42 'BEGIN {print x}'");
    assert.strictEqual(result.stdout.trim(), '42');
  });

  it('pipe into awk from other commands', async () => {
    const result = await os.exec("seq 1 5 | awk '{sum += $1} END {print sum}'");
    assert.strictEqual(result.stdout.trim(), '15');
  });
});
