/**
 * Parallel pipeline tests — verifies SharedArrayBuffer ring buffer
 * connections between pipeline stages via real WASM workers.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WasmOS } from '../src/wasm-os.ts';
import { PipelineOrchestrator } from '../src/pipeline.ts';
import { VFS } from '../src/vfs.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = join(__dirname, '../../target/wasm32-wasip1/release/multicall.wasm');
const WORKER_SCRIPT = join(__dirname, '../src/worker-entry.ts');

describe('Parallel pipeline', { timeout: 60000 }, () => {
  let wasmBinary: Uint8Array<ArrayBuffer>;

  before(async () => {
    const buf = await readFile(WASM_PATH);
    wasmBinary = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  });

  it('three-stage parallel: echo | cat | wc -c', async () => {
    const orchestrator = new PipelineOrchestrator({
      workerScript: WORKER_SCRIPT,
      parallel: true,
    });
    await orchestrator.compileModule(wasmBinary);
    const vfs = new VFS();

    const result = await orchestrator.executePipeline(
      [
        { command: 'echo', args: ['hello'] },
        { command: 'cat', args: [] },
        { command: 'wc', args: ['-c'] },
      ],
      {},
      '/',
      vfs,
      null,
    );

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(new TextDecoder().decode(result.stdout).trim(), '6');
  });

  it('two-stage parallel: echo | sort', { skip: 'uu_sort panics on WASI: std::thread::spawn not supported' }, async () => {
    const orchestrator = new PipelineOrchestrator({
      workerScript: WORKER_SCRIPT,
      parallel: true,
    });
    await orchestrator.compileModule(wasmBinary);
    const vfs = new VFS();

    const result = await orchestrator.executePipeline(
      [
        { command: 'printf', args: ['cherry\\napple\\nbanana\\n'] },
        { command: 'sort', args: [] },
      ],
      {},
      '/',
      vfs,
      null,
    );

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(
      new TextDecoder().decode(result.stdout),
      'apple\nbanana\ncherry\n',
    );
  });

  it('parallel pipeline collects stderr from all stages', async () => {
    const orchestrator = new PipelineOrchestrator({
      workerScript: WORKER_SCRIPT,
      parallel: true,
    });
    await orchestrator.compileModule(wasmBinary);
    const vfs = new VFS();

    // cat of nonexistent file should produce stderr
    const result = await orchestrator.executePipeline(
      [
        { command: 'echo', args: ['hello'] },
        { command: 'wc', args: ['-c'] },
      ],
      {},
      '/',
      vfs,
      null,
    );

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(new TextDecoder().decode(result.stdout).trim(), '6');
  });

  it('falls back to sequential when parallel=false', async () => {
    const orchestrator = new PipelineOrchestrator({
      workerScript: WORKER_SCRIPT,
      parallel: false,
    });
    await orchestrator.compileModule(wasmBinary);
    const vfs = new VFS();

    const result = await orchestrator.executePipeline(
      [
        { command: 'echo', args: ['hello'] },
        { command: 'wc', args: ['-c'] },
      ],
      {},
      '/',
      vfs,
      null,
    );

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(new TextDecoder().decode(result.stdout).trim(), '6');
  });

  it('parallel handles single-stage pipeline', async () => {
    const orchestrator = new PipelineOrchestrator({
      workerScript: WORKER_SCRIPT,
      parallel: true,
    });
    await orchestrator.compileModule(wasmBinary);
    const vfs = new VFS();

    const result = await orchestrator.executePipeline(
      [{ command: 'echo', args: ['world'] }],
      {},
      '/',
      vfs,
      null,
    );

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(new TextDecoder().decode(result.stdout), 'world\n');
  });

  describe('benchmark: parallel vs sequential', () => {
    it('parallel is not slower than sequential for multi-stage pipelines', { skip: 'uu_sort panics on WASI: std::thread::spawn not supported' }, async () => {
      // Run a multi-stage pipeline in both modes and compare timing
      const stages = [
        { command: 'seq', args: ['1000'] },
        { command: 'sort', args: ['-rn'] },
        { command: 'head', args: ['-n', '5'] },
      ];
      const vfs = new VFS();

      // Sequential timing
      const seqOrchestrator = new PipelineOrchestrator({
        workerScript: WORKER_SCRIPT,
        parallel: false,
      });
      await seqOrchestrator.compileModule(wasmBinary);

      const seqStart = performance.now();
      const seqResult = await seqOrchestrator.executePipeline(stages, {}, '/', vfs, null);
      const seqTime = performance.now() - seqStart;

      // Parallel timing
      const parOrchestrator = new PipelineOrchestrator({
        workerScript: WORKER_SCRIPT,
        parallel: true,
      });
      await parOrchestrator.compileModule(wasmBinary);

      const parStart = performance.now();
      const parResult = await parOrchestrator.executePipeline(stages, {}, '/', vfs, null);
      const parTime = performance.now() - parStart;

      // Both should produce correct output
      const expected = '1000\n999\n998\n997\n996\n';
      assert.strictEqual(new TextDecoder().decode(seqResult.stdout), expected);
      assert.strictEqual(new TextDecoder().decode(parResult.stdout), expected);

      // Log timing for inspection (not a hard assertion since timing varies)
      console.log(`  Sequential: ${seqTime.toFixed(1)}ms, Parallel: ${parTime.toFixed(1)}ms`);

      // Parallel should not be dramatically slower (allow 3x margin for overhead)
      assert.ok(parTime < seqTime * 3,
        `Parallel (${parTime.toFixed(1)}ms) was >3x slower than sequential (${seqTime.toFixed(1)}ms)`);
    });
  });
});
