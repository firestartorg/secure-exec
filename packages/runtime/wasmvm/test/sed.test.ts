/**
 * Integration tests for sed command.
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

describe('sed integration', { timeout: 30000 }, () => {
  let os: WasmOS;

  before(async () => {
    const wasmBinary = await readFile(WASM_PATH);
    os = new WasmOS({ wasmBinary });
    await os.init();
  });

  it('basic substitution: s/hello/world/', async () => {
    const result = await os.exec("echo hello | sed 's/hello/world/'");
    assert.strictEqual(result.stdout.trim(), 'world');
    assert.strictEqual(result.exitCode, 0);
  });

  it('global substitution: s/a/b/g', async () => {
    const result = await os.exec("echo aaa | sed 's/a/b/g'");
    assert.strictEqual(result.stdout.trim(), 'bbb');
  });

  it('address range: line numbers', async () => {
    const result = await os.exec("printf 'a\\nb\\nc\\n' | sed '2d'");
    assert.strictEqual(result.stdout, 'a\nc\n');
  });

  it('address range: start,end', async () => {
    const result = await os.exec("printf 'a\\nb\\nc\\nd\\n' | sed '2,3d'");
    assert.strictEqual(result.stdout, 'a\nd\n');
  });

  it('regex address', async () => {
    const result = await os.exec("printf 'foo\\nbar\\nbaz\\n' | sed '/bar/d'");
    assert.strictEqual(result.stdout, 'foo\nbaz\n');
  });

  it('multiple -e expressions', async () => {
    const result = await os.exec("echo hello | sed -e 's/h/H/' -e 's/o/O/'");
    assert.strictEqual(result.stdout.trim(), 'HellO');
  });

  it('delete command: d', async () => {
    const result = await os.exec("printf 'keep\\ndelete\\nkeep\\n' | sed '/delete/d'");
    assert.strictEqual(result.stdout, 'keep\nkeep\n');
  });

  it('print command with -n: only matched lines', async () => {
    const result = await os.exec("printf 'a\\nb\\nc\\n' | sed -n '2p'");
    assert.strictEqual(result.stdout, 'b\n');
  });

  it('substitution with & (whole match)', async () => {
    const result = await os.exec("echo foo | sed 's/foo/[&]/'");
    assert.strictEqual(result.stdout.trim(), '[foo]');
  });

  it('transliterate: y/abc/ABC/', async () => {
    const result = await os.exec("echo abc | sed 'y/abc/ABC/'");
    assert.strictEqual(result.stdout.trim(), 'ABC');
  });

  it('line number address: delete specific line', async () => {
    // Delete last line (line 3) by number
    const result = await os.exec("printf 'a\\nb\\nc\\n' | sed '3d'");
    assert.strictEqual(result.stdout, 'a\nb\n');
  });

  it('negated address: !', async () => {
    const result = await os.exec("printf 'a\\nb\\nc\\n' | sed '2!d'");
    assert.strictEqual(result.stdout, 'b\n');
  });

  it('substitute with different delimiter', async () => {
    const result = await os.exec("echo /usr/bin | sed 's|/usr/bin|/usr/local/bin|'");
    assert.strictEqual(result.stdout.trim(), '/usr/local/bin');
  });

  it('no match returns input unchanged', async () => {
    const result = await os.exec("echo hello | sed 's/xyz/abc/'");
    assert.strictEqual(result.stdout.trim(), 'hello');
  });

  it('case-insensitive substitution: s/hello/world/i matches HELLO', async () => {
    const result = await os.exec("echo HELLO | sed 's/hello/world/i'");
    assert.strictEqual(result.stdout.trim(), 'world');
    assert.strictEqual(result.exitCode, 0);
  });

  it('case-insensitive substitution: s/hello/world/i matches mixed case', async () => {
    const result = await os.exec("echo hElLo | sed 's/hello/world/i'");
    assert.strictEqual(result.stdout.trim(), 'world');
  });

  it('case-insensitive global substitution: s/hello/world/gi', async () => {
    const result = await os.exec("echo 'Hello hello HELLO' | sed 's/hello/world/gi'");
    assert.strictEqual(result.stdout.trim(), 'world world world');
  });

  it('case-insensitive address: /hello/Id deletes lines case-insensitively', async () => {
    const result = await os.exec("printf 'HELLO\\nworld\\nhElLo\\n' | sed '/hello/Id'");
    assert.strictEqual(result.stdout, 'world\n');
  });

  it('default (no i flag) remains case-sensitive', async () => {
    const result = await os.exec("echo HELLO | sed 's/hello/world/'");
    assert.strictEqual(result.stdout.trim(), 'HELLO');
  });
});
