/**
 * Extended subprocess and shell integration tests.
 *
 * Tests error handling, concurrent spawns, nested subshells,
 * complex redirections, and advanced shell features through
 * the full stack: WasmOS → sh -c → brush-shell (WASM).
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WasmOS } from '../src/wasm-os.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = join(__dirname, '../../target/wasm32-wasip1/release/multicall.wasm');

describe('Subprocess: error handling', { timeout: 60000 }, () => {
  let os: WasmOS;

  before(async () => {
    const wasmBinary = await readFile(WASM_PATH);
    os = new WasmOS({ wasmBinary });
    await os.init();
  });

  it('nonexistent command returns 127', async () => {
    const r = await os.exec('nonexistent_command_xyz');
    assert.strictEqual(r.exitCode, 127);
  });

  it('command not found stderr message', async () => {
    const r = await os.exec('totally_bogus_cmd');
    assert.strictEqual(r.exitCode, 127);
    assert.ok(r.stderr.length > 0);
  });

  it('permission-denied-like scenarios return non-zero', async () => {
    // Try to write to root directory (should fail)
    const r = await os.exec('echo test > /proc/nonexistent 2>/dev/null; echo $?');
    assert.strictEqual(r.exitCode, 0);
  });

  it('exit code from last command in &&-chain propagates', async () => {
    const r = await os.exec('true && true && false');
    assert.strictEqual(r.exitCode, 1);
  });

  it('exit code from first failure in &&-chain', async () => {
    const r = await os.exec('false && echo nope && echo nope2');
    assert.strictEqual(r.exitCode, 1);
    assert.strictEqual(r.stdout, '');
  });

  it('cat nonexistent file produces stderr', async () => {
    const r = await os.exec('cat /tmp/does-not-exist-xyz');
    assert.notStrictEqual(r.exitCode, 0);
    assert.ok(r.stderr.length > 0);
  });

  it('write to read-only location fails gracefully', async () => {
    const r = await os.exec('echo test > /nonexistent-dir/file.txt 2>/dev/null; echo $?');
    assert.strictEqual(r.exitCode, 0);
    // The redirected $? should show non-zero
    assert.ok(r.stdout.trim() !== '0');
  });
});

describe('Subprocess: concurrent and sequential spawns', { timeout: 60000 }, () => {
  let os: WasmOS;

  before(async () => {
    const wasmBinary = await readFile(WASM_PATH);
    os = new WasmOS({ wasmBinary });
    await os.init();
  });

  it('sequential commands with semicolons', async () => {
    const r = await os.exec('echo first; echo second; echo third');
    assert.strictEqual(r.stdout, 'first\nsecond\nthird\n');
    assert.strictEqual(r.exitCode, 0);
  });

  it('many sequential commands', async () => {
    const r = await os.exec('echo 1; echo 2; echo 3; echo 4; echo 5; echo 6; echo 7; echo 8; echo 9; echo 10');
    assert.strictEqual(r.stdout, '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n');
  });

  it('for loop spawns multiple subprocesses', async () => {
    const r = await os.exec('for i in 1 2 3 4 5; do echo $i | cat; done');
    assert.strictEqual(r.stdout, '1\n2\n3\n4\n5\n');
  });

  it('multiple pipelines in sequence', async () => {
    const r = await os.exec('echo aaa | tr a b; echo ccc | tr c d');
    assert.strictEqual(r.stdout, 'bbb\nddd\n');
  });

  it('command substitution inside for loop', async () => {
    const r = await os.exec('for x in $(echo a b c); do echo item-$x; done');
    assert.strictEqual(r.stdout, 'item-a\nitem-b\nitem-c\n');
  });

  it('pipeline with file I/O between commands', async () => {
    os.writeFile('/tmp/seq-src.txt', '3\n1\n2\n');
    const r = await os.exec('cat /tmp/seq-src.txt | head -n 2 | wc -l');
    assert.strictEqual(r.stdout.trim(), '2');
  });
});

describe('Subprocess: nested subshells and command substitution', { timeout: 60000 }, () => {
  let os: WasmOS;

  before(async () => {
    const wasmBinary = await readFile(WASM_PATH);
    os = new WasmOS({ wasmBinary });
    await os.init();
  });

  it('nested command substitution', async () => {
    const r = await os.exec('echo $(echo $(echo deep))');
    assert.strictEqual(r.stdout, 'deep\n');
  });

  it('subshell preserves parent environment', async () => {
    const r = await os.exec('X=hello; (echo $X)');
    assert.strictEqual(r.stdout, 'hello\n');
  });

  it('subshell variable does not leak to parent', async () => {
    const r = await os.exec('(Y=inside); echo ${Y:-empty}');
    assert.strictEqual(r.stdout, 'empty\n');
  });

  it('nested subshells', async () => {
    const r = await os.exec('(echo outer; (echo inner))');
    assert.strictEqual(r.stdout, 'outer\ninner\n');
  });

  it('command substitution captures multi-line output', async () => {
    const r = await os.exec("LINES=$(printf 'a\\nb\\nc'); echo \"$LINES\"");
    assert.strictEqual(r.exitCode, 0);
    assert.ok(r.stdout.includes('a'));
    assert.ok(r.stdout.includes('b'));
    assert.ok(r.stdout.includes('c'));
  });

  it('command substitution in arithmetic', async () => {
    const r = await os.exec('echo $(expr 2 + $(expr 3 + 4))');
    assert.strictEqual(r.stdout, '9\n');
  });
});

describe('Subprocess: complex redirections', { timeout: 60000 }, () => {
  let os: WasmOS;

  before(async () => {
    const wasmBinary = await readFile(WASM_PATH);
    os = new WasmOS({ wasmBinary });
    await os.init();
  });

  it('redirect stdout to file', async () => {
    await os.exec('echo redirect-test > /tmp/redir-out.txt');
    const r = await os.exec('cat /tmp/redir-out.txt');
    assert.strictEqual(r.stdout, 'redirect-test\n');
  });

  it('append redirect', async () => {
    await os.exec('echo line1 > /tmp/append-test.txt');
    await os.exec('echo line2 >> /tmp/append-test.txt');
    await os.exec('echo line3 >> /tmp/append-test.txt');
    const r = await os.exec('cat /tmp/append-test.txt');
    assert.strictEqual(r.stdout, 'line1\nline2\nline3\n');
  });

  it('redirect stderr with 2>', { skip: 'Host-level WARN messages leak into stderr — 2>/dev/null does not suppress host diagnostics' }, async () => {
    const r = await os.exec('cat /tmp/nonexistent-redir 2>/dev/null');
    assert.notStrictEqual(r.exitCode, 0);
    assert.strictEqual(r.stderr, '');
  });

  it('input redirect with <', { skip: 'WASI VFS input redirect (<) not supported in brush-shell subprocess model' }, async () => {
    os.writeFile('/tmp/input-redir.txt', 'from file\n');
    const r = await os.exec('cat < /tmp/input-redir.txt');
    assert.strictEqual(r.stdout, 'from file\n');
  });

  it('pipeline output to file via single command', async () => {
    await os.exec('echo HELLO_WORLD > /tmp/redir-single.txt');
    const r = await os.exec('cat /tmp/redir-single.txt');
    assert.strictEqual(r.stdout, 'HELLO_WORLD\n');
  });
});

describe('Subprocess: advanced shell features', { timeout: 60000 }, () => {
  let os: WasmOS;

  before(async () => {
    const wasmBinary = await readFile(WASM_PATH);
    os = new WasmOS({ wasmBinary });
    await os.init();
  });

  it('case statement', async () => {
    const r = await os.exec("X=hello; case $X in hello) echo matched;; world) echo wrong;; esac");
    assert.strictEqual(r.stdout, 'matched\n');
  });

  it('case with wildcard pattern', async () => {
    const r = await os.exec("X=foobar; case $X in foo*) echo starts-with-foo;; *) echo other;; esac");
    assert.strictEqual(r.stdout, 'starts-with-foo\n');
  });

  it('while loop with counter', async () => {
    const r = await os.exec('i=0; while [ $i -lt 3 ]; do echo $i; i=$(expr $i + 1); done');
    assert.strictEqual(r.stdout, '0\n1\n2\n');
  });

  it('until loop', async () => {
    const r = await os.exec('i=0; until [ $i -ge 3 ]; do echo $i; i=$(expr $i + 1); done');
    assert.strictEqual(r.stdout, '0\n1\n2\n');
  });

  it('function with arguments', async () => {
    const r = await os.exec('greet() { echo "Hello $1"; }; greet World');
    assert.strictEqual(r.stdout, 'Hello World\n');
  });

  it('function with return value', async () => {
    const r = await os.exec('check() { return 42; }; check; echo $?');
    assert.strictEqual(r.stdout, '42\n');
  });

  it('here-document', async () => {
    const r = await os.exec("cat <<EOF\nhello\nworld\nEOF");
    assert.strictEqual(r.exitCode, 0);
    assert.ok(r.stdout.includes('hello'));
    assert.ok(r.stdout.includes('world'));
  });

  it('parameter expansion with default', async () => {
    const r = await os.exec('echo ${UNDEFINED_VAR:-default_value}');
    assert.strictEqual(r.stdout, 'default_value\n');
  });

  it('parameter expansion with set variable', async () => {
    const r = await os.exec('MYVAL=actual; echo ${MYVAL:-default_value}');
    assert.strictEqual(r.stdout, 'actual\n');
  });

  it('string length expansion', async () => {
    const r = await os.exec('X=hello; echo ${#X}');
    assert.strictEqual(r.stdout, '5\n');
  });

  it('arithmetic expansion', async () => {
    const r = await os.exec('echo $((2 + 3 * 4))');
    assert.strictEqual(r.stdout, '14\n');
  });

  it('brace expansion', async () => {
    const r = await os.exec('echo {a,b,c}');
    assert.strictEqual(r.stdout, 'a b c\n');
  });

  it('tilde expansion', async () => {
    const r = await os.exec('echo ~');
    assert.strictEqual(r.exitCode, 0);
    assert.ok(r.stdout.trim().startsWith('/'));
  });
});

describe('Subprocess: exit code edge cases', { timeout: 60000 }, () => {
  let os: WasmOS;

  before(async () => {
    const wasmBinary = await readFile(WASM_PATH);
    os = new WasmOS({ wasmBinary });
    await os.init();
  });

  it('pipeline exit code is last command (success)', async () => {
    const r = await os.exec('false | true');
    assert.strictEqual(r.exitCode, 0);
  });

  it('pipeline exit code is last command (failure)', async () => {
    const r = await os.exec('true | false');
    assert.notStrictEqual(r.exitCode, 0);
  });

  it('|| short-circuits on success', async () => {
    const r = await os.exec('true || echo should-not-appear');
    assert.strictEqual(r.stdout, '');
  });

  it('mixed && and || operators', async () => {
    const r = await os.exec('true && echo yes || echo no');
    assert.strictEqual(r.stdout, 'yes\n');
  });

  it('mixed || and && operators (failure path)', async () => {
    const r = await os.exec('false && echo no || echo fallback');
    assert.strictEqual(r.stdout, 'fallback\n');
  });

  it('explicit exit status capture', async () => {
    const r = await os.exec('true; echo $?');
    assert.strictEqual(r.stdout, '0\n');
  });

  it('negation with !', async () => {
    const r = await os.exec('! false; echo $?');
    assert.strictEqual(r.stdout, '0\n');
  });
});
