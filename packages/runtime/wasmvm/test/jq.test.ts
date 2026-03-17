/**
 * Integration tests for jq command (via jaq).
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

describe('jq integration', { timeout: 30000 }, () => {
  let os: WasmOS;

  before(async () => {
    const wasmBinary = await readFile(WASM_PATH);
    os = new WasmOS({ wasmBinary });
    await os.init();
  });

  it('extract field: .a from object', async () => {
    const result = await os.exec('echo \'{"a":1}\' | jq .a');
    assert.strictEqual(result.stdout.trim(), '1');
    assert.strictEqual(result.exitCode, 0);
  });

  it('iterate array: .[]', async () => {
    const result = await os.exec('echo \'[1,2,3]\' | jq .[]');
    assert.strictEqual(result.stdout.trim(), '1\n2\n3');
    assert.strictEqual(result.exitCode, 0);
  });

  it('identity filter: .', async () => {
    const result = await os.exec('echo \'{"x":42}\' | jq .');
    // Pretty printed output
    const parsed = JSON.parse(result.stdout.trim());
    assert.deepStrictEqual(parsed, { x: 42 });
    assert.strictEqual(result.exitCode, 0);
  });

  it('pipe filters: .a | . + 1', async () => {
    const result = await os.exec('echo \'{"a":5}\' | jq ".a | . + 1"');
    assert.strictEqual(result.stdout.trim(), '6');
    assert.strictEqual(result.exitCode, 0);
  });

  it('select filter', async () => {
    const result = await os.exec('echo \'[1,2,3,4,5]\' | jq "[.[] | select(. > 3)]"');
    const parsed = JSON.parse(result.stdout.trim());
    assert.deepStrictEqual(parsed, [4, 5]);
  });

  it('map filter', async () => {
    const result = await os.exec('echo \'[1,2,3]\' | jq "[.[] | . * 2]"');
    const parsed = JSON.parse(result.stdout.trim());
    assert.deepStrictEqual(parsed, [2, 4, 6]);
  });

  it('object construction', async () => {
    const result = await os.exec('echo \'{"a":1,"b":2}\' | jq -c "{sum: (.a + .b)}"');
    assert.strictEqual(result.stdout.trim(), '{"sum":3}');
  });

  it('length filter', async () => {
    const result = await os.exec('echo \'[1,2,3,4]\' | jq length');
    assert.strictEqual(result.stdout.trim(), '4');
  });

  it('keys filter', async () => {
    const result = await os.exec('echo \'{"b":2,"a":1}\' | jq -c keys');
    assert.strictEqual(result.stdout.trim(), '["a","b"]');
  });

  it('compact output with -c', async () => {
    const result = await os.exec('echo \'{"a":1,"b":2}\' | jq -c .');
    assert.strictEqual(result.stdout.trim(), '{"a":1,"b":2}');
  });

  it('raw output with -r', async () => {
    const result = await os.exec('echo \'{"name":"hello"}\' | jq -r .name');
    assert.strictEqual(result.stdout.trim(), 'hello');
  });

  it('null input with -n', async () => {
    const result = await os.exec('echo "" | jq -n "1 + 2"');
    assert.strictEqual(result.stdout.trim(), '3');
  });

  it('string interpolation', async () => {
    const result = await os.exec('echo \'{"name":"world"}\' | jq -r \'"Hello \\(.name)"\'');
    assert.strictEqual(result.stdout.trim(), 'Hello world');
  });

  it('nested field access', async () => {
    const result = await os.exec('echo \'{"a":{"b":{"c":42}}}\' | jq .a.b.c');
    assert.strictEqual(result.stdout.trim(), '42');
  });

  it('array indexing', async () => {
    const result = await os.exec('echo \'[10,20,30]\' | jq ".[1]"');
    assert.strictEqual(result.stdout.trim(), '20');
  });

  it('type filter', async () => {
    const result = await os.exec('echo \'42\' | jq -r type');
    assert.strictEqual(result.stdout.trim(), 'number');
  });

  it('if-then-else', async () => {
    const result = await os.exec('echo \'5\' | jq "if . > 3 then \\"big\\" else \\"small\\" end"');
    assert.strictEqual(result.stdout.trim(), '"big"');
  });

  it('multiple outputs piped', async () => {
    const result = await os.exec('echo \'{"a":1,"b":2}\' | jq -c "[.a, .b]"');
    assert.strictEqual(result.stdout.trim(), '[1,2]');
  });
});
