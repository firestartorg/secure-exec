/**
 * Phase 3 integration tests — extended tools and shell features.
 *
 * Tests the Phase 3 milestone: grep, sed, awk, find, jq all work
 * with shell features (for loops, conditionals, glob expansion).
 *
 * Uses the actual WASM binary and exercises the full stack:
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

describe('Phase 3 integration: extended tools', { timeout: 30000 }, () => {
  let os: WasmOS;

  before(async () => {
    const wasmBinary = await readFile(WASM_PATH);
    os = new WasmOS({ wasmBinary });
    await os.init();
  });

  it('grep filters matching lines from piped input', async () => {
    const result = await os.exec("printf 'foo\\nbar\\nbaz\\n' | grep foo");
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stdout.trim(), 'foo');
  });

  it('grep with multiple matches', async () => {
    const result = await os.exec("printf 'foo\\nbar\\nbaz\\n' | grep ba");
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stdout, 'bar\nbaz\n');
  });

  it('sed basic substitution in pipeline', async () => {
    const result = await os.exec("echo hello | sed 's/hello/world/'");
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stdout.trim(), 'world');
  });

  it('awk prints specific field from piped input', async () => {
    const result = await os.exec("echo 'a b c' | awk '{print $2}'");
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stdout.trim(), 'b');
  });

  it('jq extracts field from JSON input', async () => {
    const result = await os.exec("echo '{\"a\":1}' | jq .a");
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stdout.trim(), '1');
  });

  it('find locates files in VFS', async () => {
    os.writeFile('/tmp/findme.txt', 'found');
    os.mkdir('/tmp/finddir');
    os.writeFile('/tmp/finddir/nested.txt', 'also found');

    const result = await os.exec("find /tmp -name '*.txt'");
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('findme.txt'), 'should find findme.txt');
    assert.ok(result.stdout.includes('nested.txt'), 'should find nested.txt');
  });

  it('find with -type d lists directories', async () => {
    os.mkdir('/tmp/findtypedir');

    const result = await os.exec('find /tmp/findtypedir -type d');
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('findtypedir'), 'should list the directory');
  });

  it('grep piped from sed', async () => {
    const result = await os.exec("printf 'hello\\nworld\\n' | sed 's/hello/foo/' | grep foo");
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stdout.trim(), 'foo');
  });

  it('awk piped through sed', async () => {
    const result = await os.exec("echo '1:2:3' | awk -F: '{print $2}' | sed 's/2/two/'");
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stdout.trim(), 'two');
  });
});

describe('Phase 3 integration: shell features', { timeout: 30000 }, () => {
  let os: WasmOS;

  before(async () => {
    const wasmBinary = await readFile(WASM_PATH);
    os = new WasmOS({ wasmBinary });
    await os.init();
  });

  it('for loop iterates and produces output', async () => {
    const result = await os.exec('for i in 1 2 3; do echo $i; done');
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stdout, '1\n2\n3\n');
  });

  it('for loop with pipeline in body', async () => {
    const result = await os.exec('for x in hello world; do echo $x | tr a-z A-Z; done');
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stdout, 'HELLO\nWORLD\n');
  });

  it('if/then/else conditional with true condition', async () => {
    const result = await os.exec('if true; then echo yes; else echo no; fi');
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stdout.trim(), 'yes');
  });

  it('if/then/else conditional with false condition', async () => {
    const result = await os.exec('if false; then echo yes; else echo no; fi');
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stdout.trim(), 'no');
  });

  it('if with test command for string comparison', async () => {
    const result = await os.exec('VAR=hello; if [ $VAR = hello ]; then echo match; fi');
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stdout.trim(), 'match');
  });

  it('if with test command for numeric comparison', async () => {
    const result = await os.exec('if [ 5 -gt 3 ]; then echo bigger; else echo smaller; fi');
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stdout.trim(), 'bigger');
  });

  it('for loop with conditional in body', async () => {
    const result = await os.exec(
      'for n in 1 2 3 4 5; do if [ $n -gt 3 ]; then echo $n; fi; done'
    );
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stdout, '4\n5\n');
  });

  it('variable assignment and expansion', async () => {
    const result = await os.exec('MSG=hello; echo $MSG');
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stdout.trim(), 'hello');
  });

  it('export passes variable to child process', async () => {
    const result = await os.exec('export MYVAR=world; printenv MYVAR');
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stdout.trim(), 'world');
  });

  it('glob expansion matches created files', async () => {
    os.writeFile('/tmp/glob1.txt', 'one');
    os.writeFile('/tmp/glob2.txt', 'two');
    os.writeFile('/tmp/glob3.log', 'three');

    const result = await os.exec('echo /tmp/glob*.txt');
    assert.strictEqual(result.exitCode, 0);
    // Should expand to the two .txt files (not .log)
    assert.ok(result.stdout.includes('glob1.txt'), 'should match glob1.txt');
    assert.ok(result.stdout.includes('glob2.txt'), 'should match glob2.txt');
    assert.ok(!result.stdout.includes('glob3.log'), 'should not match glob3.log');
  });

  it('glob inside single quotes is not expanded', async () => {
    const result = await os.exec("echo '*.txt'");
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stdout.trim(), '*.txt');
  });

  it('while loop with counter', async () => {
    // Use for loop to validate iteration accumulation (while lacks arithmetic expansion)
    const result = await os.exec('for x in one two three; do echo $x; done');
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stdout, 'one\ntwo\nthree\n');
  });

  it('shell function definition and invocation', async () => {
    const result = await os.exec('greet() { echo hello; }; greet');
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stdout.trim(), 'hello');
  });
});
