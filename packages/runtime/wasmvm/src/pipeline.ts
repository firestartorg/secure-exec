/**
 * Pipeline orchestrator with parallel and sequential execution modes.
 *
 * - Parallel mode (default for multi-stage): spawns all Workers simultaneously
 *   with SharedArrayBuffer ring buffers connecting stdout→stdin between stages.
 *   Stages block on Atomics.wait when buffers are full/empty.
 *
 * - Sequential mode (fallback): runs stages one at a time, feeding stdout of
 *   stage N as stdin of stage N+1 via in-memory Uint8Array passing.
 *
 * Falls back to sequential mode if SharedArrayBuffer is unavailable.
 */

import { WorkerAdapter, WorkerHandle } from './worker-adapter.ts';
import { VFS } from './vfs.ts';
import { createRingBuffer } from './ring-buffer.ts';

/** Default ring buffer capacity: 64KB */
const RING_BUFFER_CAPACITY = 64 * 1024;

export interface PipelineStage {
  command: string;
  args?: string[];
}

export interface PipelineResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
  vfsSnapshot: Array<{ type: string; path: string; data?: Uint8Array; mode?: number; target?: string }>;
}

interface StageMessage {
  wasmModule: WebAssembly.Module | null;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  stdin?: Uint8Array | string | null;
  vfsSnapshot: Array<{ type: string; path: string; data?: Uint8Array; mode?: number; target?: string }> | null;
  stdinBuffer?: SharedArrayBuffer | null;
  stdoutBuffer?: SharedArrayBuffer | null;
}

interface StageResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
  vfsChanges?: Array<{ type: string; path: string; data?: Uint8Array; mode?: number; target?: string }>;
}

export interface PipelineOrchestratorOptions {
  workerScript?: string | URL;
  parallel?: boolean;
}

/**
 * Orchestrates pipeline execution via Workers.
 */
export class PipelineOrchestrator {
  private _workerScript: string | URL | null;
  private _adapter: WorkerAdapter;
  private _compiledModule: WebAssembly.Module | null;
  private _parallel: boolean;

  constructor(options: PipelineOrchestratorOptions = {}) {
    this._workerScript = options.workerScript || null;
    this._adapter = new WorkerAdapter();
    this._compiledModule = null;
    this._parallel = options.parallel !== false;
  }

  /**
   * Pre-compile a WASM binary into a Module for reuse across pipeline stages.
   */
  async compileModule(wasmBinary: BufferSource): Promise<WebAssembly.Module> {
    this._compiledModule = await WebAssembly.compile(wasmBinary);
    return this._compiledModule;
  }

  /**
   * Set a pre-compiled WASM module directly.
   */
  setModule(mod: WebAssembly.Module): void {
    this._compiledModule = mod;
  }

  /**
   * Execute a pipeline of command stages.
   */
  async executePipeline(
    stages: PipelineStage[],
    env: Record<string, string> = {},
    cwd: string = '/',
    vfs: VFS | null = null,
    stdin: Uint8Array | string | null = null,
  ): Promise<PipelineResult> {
    if (!stages || stages.length === 0) {
      return {
        exitCode: 0,
        stdout: new Uint8Array(0),
        stderr: new Uint8Array(0),
        vfsSnapshot: vfs ? vfs.snapshot() : [],
      };
    }

    if (!this._compiledModule) {
      throw new Error('WASM module not compiled. Call compileModule() or setModule() first.');
    }

    // Single-stage: run directly (no ring buffers needed)
    if (stages.length === 1) {
      return this._executeSequential(stages, env, cwd, vfs, stdin);
    }

    // Multi-stage: try parallel mode, fall back to sequential
    if (this._parallel && _hasSharedArrayBuffer()) {
      return this._executeParallel(stages, env, cwd, vfs, stdin);
    }

    return this._executeSequential(stages, env, cwd, vfs, stdin);
  }

  private async _executeParallel(
    stages: PipelineStage[],
    env: Record<string, string>,
    cwd: string,
    vfs: VFS | null,
    stdin: Uint8Array | string | null,
  ): Promise<PipelineResult> {
    const vfsSnapshot = vfs ? vfs.snapshot() : null;
    const n = stages.length;

    // Create ring buffers between consecutive stages
    const ringBuffers: SharedArrayBuffer[] = [];
    for (let i = 0; i < n - 1; i++) {
      ringBuffers.push(createRingBuffer(RING_BUFFER_CAPACITY));
    }

    // Spawn all workers simultaneously
    const workerPromises = stages.map((stage, i) => {
      const msg: StageMessage = {
        wasmModule: this._compiledModule,
        command: stage.command,
        args: stage.args || [],
        env,
        cwd,
        vfsSnapshot,
        stdin: i === 0 ? stdin : null,
        stdinBuffer: i > 0 ? ringBuffers[i - 1] : null,
        stdoutBuffer: i < n - 1 ? ringBuffers[i] : null,
      };

      return this._executeStage(msg);
    });

    // Wait for all stages to complete
    const results = await Promise.all(workerPromises);

    // Collect stderr from all stages
    const allStderr = results
      .map(r => r.stderr)
      .filter(s => s && s.length > 0);

    // Merge VFS changes from all stages in stage order (last-stage-wins for same path)
    const mergedVfs = _mergeVfsChanges(results.map(r => r.vfsChanges || []));

    // Last stage's result has the final stdout and exit code
    const lastResult = results[n - 1];

    return {
      exitCode: lastResult.exitCode,
      stdout: lastResult.stdout,
      stderr: concatUint8Arrays(allStderr),
      vfsSnapshot: mergedVfs,
    };
  }

  private async _executeSequential(
    stages: PipelineStage[],
    env: Record<string, string>,
    cwd: string,
    vfs: VFS | null,
    stdin: Uint8Array | string | null,
  ): Promise<PipelineResult> {
    const vfsSnapshot = vfs ? vfs.snapshot() : null;
    let currentStdin: Uint8Array | string | null = stdin;
    let lastResult: StageResult | null = null;
    const allStderr: Uint8Array[] = [];
    const allVfsChanges: Array<Array<{ type: string; path: string; data?: Uint8Array; mode?: number; target?: string }>> = [];

    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i];
      const result = await this._executeStage({
        wasmModule: this._compiledModule,
        command: stage.command,
        args: stage.args || [],
        env,
        cwd,
        stdin: currentStdin,
        vfsSnapshot,
      });

      if (result.stderr && result.stderr.length > 0) {
        allStderr.push(result.stderr);
      }

      allVfsChanges.push(result.vfsChanges || []);
      currentStdin = result.stdout;
      lastResult = result;
    }

    const combinedStderr = concatUint8Arrays(allStderr);

    return {
      exitCode: lastResult!.exitCode,
      stdout: lastResult!.stdout,
      stderr: combinedStderr,
      vfsSnapshot: _mergeVfsChanges(allVfsChanges),
    };
  }

  private async _executeStage(msg: StageMessage): Promise<StageResult> {
    if (!this._workerScript) {
      throw new Error('workerScript not set. Pass it in the constructor options.');
    }

    const worker = await this._adapter.spawn(this._workerScript, {
      workerData: {},
    });

    return new Promise<StageResult>((resolve, reject) => {
      let settled = false;

      worker.onMessage((data) => {
        if (settled) return;
        settled = true;
        worker.terminate();
        resolve(data as StageResult);
      });

      worker.onError((err) => {
        if (settled) return;
        settled = true;
        worker.terminate();
        reject(err);
      });

      // Send the command to the worker
      worker.postMessage(msg);
    });
  }
}

/**
 * Merge VFS changes from multiple pipeline stages in stage order.
 * Later stages win for same-path conflicts (last-stage-wins semantics).
 */
function _mergeVfsChanges(
  stageChanges: Array<Array<{ type: string; path: string; data?: Uint8Array; mode?: number; target?: string }>>,
): Array<{ type: string; path: string; data?: Uint8Array; mode?: number; target?: string }> {
  const merged = new Map<string, { type: string; path: string; data?: Uint8Array; mode?: number; target?: string }>();

  for (const changes of stageChanges) {
    for (const entry of changes) {
      merged.set(entry.path, entry);
    }
  }

  return Array.from(merged.values());
}

function _hasSharedArrayBuffer(): boolean {
  return typeof SharedArrayBuffer !== 'undefined';
}

function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  if (arrays.length === 0) return new Uint8Array(0);
  if (arrays.length === 1) return arrays[0];

  let totalLen = 0;
  for (const arr of arrays) {
    totalLen += arr.length;
  }
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}
