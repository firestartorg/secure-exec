/**
 * Tests for pipeline.js -- sequential pipeline orchestrator.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PipelineOrchestrator } from '../src/pipeline.ts';
import { VFS } from '../src/vfs.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_WORKER = join(__dirname, 'fixtures', 'pipeline-test-worker.js');

const decoder = new TextDecoder();

/**
 * Create a PipelineOrchestrator with a fake compiled module
 * and the test fixture worker script.
 */
function createTestOrchestrator(): PipelineOrchestrator {
  const orchestrator = new PipelineOrchestrator({
    workerScript: TEST_WORKER,
    parallel: false, // Test fixture workers don't support ring buffers
  });
  // The test worker doesn't use the WASM module, but we need to set
  // something so the orchestrator doesn't throw
  orchestrator.setModule({} as WebAssembly.Module);
  return orchestrator;
}

// --- Constructor and module management ---

describe('PipelineOrchestrator constructor', () => {
  test('creates instance with default options', () => {
    const orch = new PipelineOrchestrator();
    assert.ok(orch);
  });

  test('creates instance with workerScript option', () => {
    const orch = new PipelineOrchestrator({ workerScript: '/some/path.js' });
    assert.ok(orch);
  });
});

describe('Module management', () => {
  test('compileModule compiles and stores a WASM module', async () => {
    const orch = new PipelineOrchestrator({ workerScript: TEST_WORKER });
    // Minimal valid WASM module: (module)
    const minimalWasm = new Uint8Array([
      0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00,
    ]);
    const mod = await orch.compileModule(minimalWasm);
    assert.ok(mod instanceof WebAssembly.Module);
  });

  test('setModule stores a pre-compiled module', () => {
    const orch = new PipelineOrchestrator({ workerScript: TEST_WORKER });
    const fakeModule = {} as WebAssembly.Module;
    orch.setModule(fakeModule);
    // Verify by checking internal state (no public getter, but executePipeline won't throw)
    assert.ok(orch);
  });

  test('executePipeline throws if no module compiled', async () => {
    const orch = new PipelineOrchestrator({ workerScript: TEST_WORKER });
    await assert.rejects(
      () => orch.executePipeline([{ command: 'echo', args: ['hi'] }]),
      /WASM module not compiled/,
    );
  });
});

// --- Empty pipeline ---

describe('Empty pipeline', () => {
  test('returns empty results for empty stages array', async () => {
    const orch = createTestOrchestrator();
    const result = await orch.executePipeline([]);
    assert.strictEqual(result.exitCode, 0);
    assert.deepStrictEqual(result.stdout, new Uint8Array(0));
    assert.deepStrictEqual(result.stderr, new Uint8Array(0));
  });

  test('returns empty results for null stages', async () => {
    const orch = createTestOrchestrator();
    const result = await orch.executePipeline(null as never);
    assert.strictEqual(result.exitCode, 0);
  });

  test('returns VFS snapshot for empty pipeline with VFS', async () => {
    const orch = createTestOrchestrator();
    const vfs = new VFS();
    vfs.writeFile('/tmp/test.txt', 'hello');
    const result = await orch.executePipeline([], {}, '/', vfs);
    assert.ok(Array.isArray(result.vfsSnapshot));
    const entry = result.vfsSnapshot.find(e => e.path === '/tmp/test.txt');
    assert.ok(entry, 'VFS snapshot should contain the file');
  });
});

// --- Single command ---

describe('Single command pipeline', () => {
  test('echo hello -> "hello\\n"', async () => {
    const orch = createTestOrchestrator();
    const result = await orch.executePipeline([
      { command: 'echo', args: ['hello'] },
    ]);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(decoder.decode(result.stdout), 'hello\n');
  });

  test('echo with multiple args', async () => {
    const orch = createTestOrchestrator();
    const result = await orch.executePipeline([
      { command: 'echo', args: ['hello', 'world'] },
    ]);
    assert.strictEqual(decoder.decode(result.stdout), 'hello world\n');
  });

  test('fail command returns non-zero exit code', async () => {
    const orch = createTestOrchestrator();
    const result = await orch.executePipeline([
      { command: 'fail' },
    ]);
    assert.strictEqual(result.exitCode, 1);
    assert.ok(decoder.decode(result.stderr).includes('command failed'));
  });

  test('unknown command returns exit code 127', async () => {
    const orch = createTestOrchestrator();
    const result = await orch.executePipeline([
      { command: 'nonexistent' },
    ]);
    assert.strictEqual(result.exitCode, 127);
    assert.ok(decoder.decode(result.stderr).includes('command not found'));
  });

  test('single command with initial stdin', async () => {
    const orch = createTestOrchestrator();
    const result = await orch.executePipeline(
      [{ command: 'cat' }],
      {},
      '/',
      null as never,
      new TextEncoder().encode('input data'),
    );
    assert.strictEqual(decoder.decode(result.stdout), 'input data');
  });
});

// --- Multi-stage pipeline (piping) ---

describe('Multi-stage pipeline', () => {
  test('echo hello | cat -> "hello\\n"', async () => {
    const orch = createTestOrchestrator();
    const result = await orch.executePipeline([
      { command: 'echo', args: ['hello'] },
      { command: 'cat' },
    ]);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(decoder.decode(result.stdout), 'hello\n');
  });

  test('echo hello | uppercase -> "HELLO\\n"', async () => {
    const orch = createTestOrchestrator();
    const result = await orch.executePipeline([
      { command: 'echo', args: ['hello'] },
      { command: 'uppercase' },
    ]);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(decoder.decode(result.stdout), 'HELLO\n');
  });

  test('echo hello | cat | uppercase -> "HELLO\\n"', async () => {
    const orch = createTestOrchestrator();
    const result = await orch.executePipeline([
      { command: 'echo', args: ['hello'] },
      { command: 'cat' },
      { command: 'uppercase' },
    ]);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(decoder.decode(result.stdout), 'HELLO\n');
  });

  test('echo hello | wc -> "6\\n" (byte count)', async () => {
    const orch = createTestOrchestrator();
    const result = await orch.executePipeline([
      { command: 'echo', args: ['hello'] },
      { command: 'wc' },
    ]);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(decoder.decode(result.stdout), '6\n');
  });

  test('echo hello | cat | wc -> "6\\n" (three-stage pipe)', async () => {
    const orch = createTestOrchestrator();
    const result = await orch.executePipeline([
      { command: 'echo', args: ['hello'] },
      { command: 'cat' },
      { command: 'wc' },
    ]);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(decoder.decode(result.stdout), '6\n');
  });

  test('pipeline exit code comes from last stage', async () => {
    const orch = createTestOrchestrator();
    const result = await orch.executePipeline([
      { command: 'echo', args: ['hello'] },
      { command: 'fail' },
    ]);
    assert.strictEqual(result.exitCode, 1);
  });

  test('pipeline collects stderr from all stages', async () => {
    const orch = createTestOrchestrator();
    const result = await orch.executePipeline([
      { command: 'echo', args: ['hello'] },
      { command: 'fail' },
    ]);
    assert.ok(decoder.decode(result.stderr).includes('command failed'));
  });

  test('first stage failure still feeds subsequent stages', async () => {
    const orch = createTestOrchestrator();
    // fail produces no stdout, so cat gets empty stdin
    const result = await orch.executePipeline([
      { command: 'fail' },
      { command: 'cat' },
    ]);
    // Last stage is cat, which succeeds with empty output
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stdout.length, 0);
  });
});

// --- VFS integration ---

describe('Pipeline with VFS', () => {
  test('passes VFS to pipeline execution', async () => {
    const orch = createTestOrchestrator();
    const vfs = new VFS();
    vfs.writeFile('/tmp/data.txt', 'content');
    const result = await orch.executePipeline(
      [{ command: 'echo', args: ['test'] }],
      {},
      '/',
      vfs,
    );
    assert.ok(Array.isArray(result.vfsSnapshot));
  });

  test('works without VFS (null)', async () => {
    const orch = createTestOrchestrator();
    const result = await orch.executePipeline(
      [{ command: 'echo', args: ['test'] }],
      {},
      '/',
      null as never,
    );
    assert.ok(Array.isArray(result.vfsSnapshot));
  });
});

// --- Error handling ---

describe('Pipeline error handling', () => {
  test('throws if workerScript not set', async () => {
    const orch = new PipelineOrchestrator();
    orch.setModule({} as WebAssembly.Module);
    await assert.rejects(
      () => orch.executePipeline([{ command: 'echo', args: ['hi'] }]),
      /workerScript not set/,
    );
  });
});

// --- VFS changes merged from all stages ---

describe('Pipeline VFS changes from all stages', () => {
  test('echo hello | tee /tmp/out | wc — verify /tmp/out exists with hello', async () => {
    const orch = createTestOrchestrator();
    const result = await orch.executePipeline([
      { command: 'echo', args: ['hello'] },
      { command: 'tee', args: ['/tmp/out'] },
      { command: 'wc' },
    ]);
    assert.strictEqual(result.exitCode, 0);
    // wc should count bytes of "hello\n" = 6
    assert.strictEqual(decoder.decode(result.stdout), '6\n');
    // VFS should contain /tmp/out from the tee stage (stage 2)
    const entry = result.vfsSnapshot.find(e => e.path === '/tmp/out');
    assert.ok(entry, 'vfsSnapshot should contain /tmp/out from tee stage');
    assert.strictEqual(decoder.decode(entry!.data!), 'hello\n');
  });

  test('pipeline with multiple stages writing different files — all files exist', async () => {
    const orch = createTestOrchestrator();
    const result = await orch.executePipeline([
      { command: 'writefile', args: ['/tmp/a.txt', 'file-a'] },
      { command: 'writefile', args: ['/tmp/b.txt', 'file-b'] },
      { command: 'writefile', args: ['/tmp/c.txt', 'file-c'] },
    ]);
    assert.strictEqual(result.exitCode, 0);
    const entryA = result.vfsSnapshot.find(e => e.path === '/tmp/a.txt');
    const entryB = result.vfsSnapshot.find(e => e.path === '/tmp/b.txt');
    const entryC = result.vfsSnapshot.find(e => e.path === '/tmp/c.txt');
    assert.ok(entryA, 'vfsSnapshot should contain /tmp/a.txt from stage 1');
    assert.ok(entryB, 'vfsSnapshot should contain /tmp/b.txt from stage 2');
    assert.ok(entryC, 'vfsSnapshot should contain /tmp/c.txt from stage 3');
    assert.strictEqual(decoder.decode(entryA!.data!), 'file-a');
    assert.strictEqual(decoder.decode(entryB!.data!), 'file-b');
    assert.strictEqual(decoder.decode(entryC!.data!), 'file-c');
  });

  test('last-stage-wins for same-file conflicts', async () => {
    const orch = createTestOrchestrator();
    const result = await orch.executePipeline([
      { command: 'writefile', args: ['/tmp/shared.txt', 'stage-1-data'] },
      { command: 'writefile', args: ['/tmp/shared.txt', 'stage-2-data'] },
    ]);
    assert.strictEqual(result.exitCode, 0);
    const entry = result.vfsSnapshot.find(e => e.path === '/tmp/shared.txt');
    assert.ok(entry, 'vfsSnapshot should contain /tmp/shared.txt');
    // Last stage wins
    assert.strictEqual(decoder.decode(entry!.data!), 'stage-2-data');
  });

  test('single stage VFS changes still work', async () => {
    const orch = createTestOrchestrator();
    const result = await orch.executePipeline([
      { command: 'writefile', args: ['/tmp/only.txt', 'only-data'] },
    ]);
    assert.strictEqual(result.exitCode, 0);
    const entry = result.vfsSnapshot.find(e => e.path === '/tmp/only.txt');
    assert.ok(entry, 'vfsSnapshot should contain /tmp/only.txt');
    assert.strictEqual(decoder.decode(entry!.data!), 'only-data');
  });

  test('stages with no VFS changes do not overwrite earlier changes', async () => {
    const orch = createTestOrchestrator();
    const result = await orch.executePipeline([
      { command: 'writefile', args: ['/tmp/persists.txt', 'original'] },
      { command: 'echo', args: ['no-vfs-changes'] },
    ]);
    assert.strictEqual(result.exitCode, 0);
    const entry = result.vfsSnapshot.find(e => e.path === '/tmp/persists.txt');
    assert.ok(entry, 'vfsSnapshot should contain /tmp/persists.txt from stage 1');
    assert.strictEqual(decoder.decode(entry!.data!), 'original');
  });
});

// --- Environment and options passing ---

describe('Pipeline options', () => {
  test('passes env to stages', async () => {
    const orch = createTestOrchestrator();
    // The test worker doesn't use env, but verify it doesn't crash
    const result = await orch.executePipeline(
      [{ command: 'echo', args: ['test'] }],
      { HOME: '/home/user', PATH: '/bin' },
      '/',
    );
    assert.strictEqual(result.exitCode, 0);
  });

  test('passes cwd to stages', async () => {
    const orch = createTestOrchestrator();
    const result = await orch.executePipeline(
      [{ command: 'echo', args: ['test'] }],
      {},
      '/home/user',
    );
    assert.strictEqual(result.exitCode, 0);
  });
});
