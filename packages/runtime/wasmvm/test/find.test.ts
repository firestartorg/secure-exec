/**
 * Integration tests for find command.
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

describe('find integration', { timeout: 30000 }, () => {
  let os: WasmOS;

  before(async () => {
    const wasmBinary = await readFile(WASM_PATH);
    os = new WasmOS({ wasmBinary });
    await os.init();
  });

  it('find /tmp -name with glob pattern matches .txt files', async () => {
    // Create test files
    await os.exec('touch /tmp/a.txt');
    await os.exec('touch /tmp/b.txt');
    await os.exec('touch /tmp/c.log');

    const result = await os.exec("find /tmp -name '*.txt'");
    assert.strictEqual(result.exitCode, 0);
    const lines = result.stdout.trim().split('\n').sort();
    assert.ok(lines.includes('/tmp/a.txt'), 'should find a.txt');
    assert.ok(lines.includes('/tmp/b.txt'), 'should find b.txt');
    assert.ok(!lines.some(l => l.includes('c.log')), 'should not match c.log');
  });

  it('find /tmp -type d lists directories', async () => {
    await os.exec('mkdir -p /tmp/testdir');
    await os.exec('touch /tmp/testfile');

    const result = await os.exec('find /tmp/testdir -type d');
    assert.strictEqual(result.exitCode, 0);
    const lines = result.stdout.trim().split('\n');
    assert.ok(lines.includes('/tmp/testdir'), 'should find testdir');
  });

  it('find /tmp -type f lists only files', async () => {
    await os.exec('mkdir -p /tmp/ftest');
    await os.exec('touch /tmp/ftest/file1.txt');
    await os.exec('mkdir -p /tmp/ftest/subdir');

    const result = await os.exec('find /tmp/ftest -type f');
    assert.strictEqual(result.exitCode, 0);
    const lines = result.stdout.trim().split('\n');
    assert.ok(lines.some(l => l.includes('file1.txt')), 'should find file1.txt');
    assert.ok(!lines.some(l => l.endsWith('/tmp/ftest/subdir')), 'should not list directory as file');
  });

  it('find with -name and -type combined', async () => {
    await os.exec('mkdir -p /tmp/combo');
    await os.exec('touch /tmp/combo/readme.md');
    await os.exec('touch /tmp/combo/notes.md');
    await os.exec('touch /tmp/combo/data.csv');

    const result = await os.exec("find /tmp/combo -name '*.md' -type f");
    assert.strictEqual(result.exitCode, 0);
    const lines = result.stdout.trim().split('\n').sort();
    assert.strictEqual(lines.length, 2);
    assert.ok(lines[0].includes('notes.md'));
    assert.ok(lines[1].includes('readme.md'));
  });

  it('find with no expression lists everything recursively', async () => {
    await os.exec('mkdir -p /tmp/rectest/sub');
    await os.exec('touch /tmp/rectest/sub/deep.txt');

    const result = await os.exec('find /tmp/rectest');
    assert.strictEqual(result.exitCode, 0);
    const lines = result.stdout.trim().split('\n');
    assert.ok(lines.includes('/tmp/rectest'), 'should include start path');
    assert.ok(lines.includes('/tmp/rectest/sub'), 'should include subdir');
    assert.ok(lines.includes('/tmp/rectest/sub/deep.txt'), 'should include deep file');
  });

  it('find with -maxdepth limits recursion', async () => {
    await os.exec('mkdir -p /tmp/deptest/a/b');
    await os.exec('touch /tmp/deptest/a/b/deep.txt');

    const result = await os.exec('find /tmp/deptest -maxdepth 1');
    assert.strictEqual(result.exitCode, 0);
    const lines = result.stdout.trim().split('\n');
    assert.ok(lines.includes('/tmp/deptest'), 'should include start');
    assert.ok(lines.includes('/tmp/deptest/a'), 'should include depth 1');
    assert.ok(!lines.some(l => l.includes('/tmp/deptest/a/b')), 'should not include depth 2');
  });

  it('find with -mindepth skips shallow entries', async () => {
    await os.exec('mkdir -p /tmp/mintest/sub');
    await os.exec('touch /tmp/mintest/sub/file.txt');

    const result = await os.exec('find /tmp/mintest -mindepth 2');
    assert.strictEqual(result.exitCode, 0);
    const lines = result.stdout.trim().split('\n');
    assert.ok(!lines.includes('/tmp/mintest'), 'should not include depth 0');
    assert.ok(!lines.includes('/tmp/mintest/sub'), 'should not include depth 1');
    assert.ok(lines.includes('/tmp/mintest/sub/file.txt'), 'should include depth 2');
  });

  it('find with -iname for case-insensitive matching', async () => {
    await os.exec('mkdir -p /tmp/itest');
    await os.exec('touch /tmp/itest/README.md');
    await os.exec('touch /tmp/itest/readme.md');

    const result = await os.exec("find /tmp/itest -iname 'readme*'");
    assert.strictEqual(result.exitCode, 0);
    const lines = result.stdout.trim().split('\n');
    assert.strictEqual(lines.length, 2);
  });

  it('find piped to wc -l counts matching files', async () => {
    await os.exec('mkdir -p /tmp/wctest');
    await os.exec('touch /tmp/wctest/a.txt');
    await os.exec('touch /tmp/wctest/b.txt');
    await os.exec('touch /tmp/wctest/c.txt');

    const result = await os.exec("find /tmp/wctest -name '*.txt' | wc -l");
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stdout.trim(), '3');
  });

  it('find with negation: ! -name excludes pattern', async () => {
    await os.exec('mkdir -p /tmp/negtest');
    await os.exec('touch /tmp/negtest/keep.txt');
    await os.exec('touch /tmp/negtest/skip.log');

    const result = await os.exec("find /tmp/negtest -type f ! -name '*.log'");
    assert.strictEqual(result.exitCode, 0);
    const lines = result.stdout.trim().split('\n');
    assert.ok(lines.some(l => l.includes('keep.txt')), 'should keep .txt files');
    assert.ok(!lines.some(l => l.includes('skip.log')), 'should exclude .log files');
  });

  it('find in current directory with .', async () => {
    // find with default path should work (uses ".")
    const result = await os.exec('find /tmp/rectest -name deep.txt');
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('deep.txt'));
  });

  it('find with -empty finds empty files', async () => {
    await os.exec('mkdir -p /tmp/emtest');
    await os.exec('touch /tmp/emtest/empty.txt');

    const result = await os.exec('find /tmp/emtest -empty -type f');
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('empty.txt'));
  });

  it('find returns 0 even with no matches', async () => {
    const result = await os.exec("find /tmp -name 'nonexistent_pattern_xyz'");
    assert.strictEqual(result.exitCode, 0);
  });
});
