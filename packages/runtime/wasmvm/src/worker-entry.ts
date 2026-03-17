/**
 * Worker entry script for WASM bootstrap.
 *
 * Receives a command message, instantiates the WASM module with WASI
 * and custom host imports, calls _start (which dispatches via WASI args),
 * and returns results including stdout, stderr, exit code, and VFS changes.
 *
 * Works in both Node.js (worker_threads) and browser (Web Workers).
 */

import { FDTable } from './fd-table.ts';
import { VFS } from './vfs.ts';
import type { VfsSnapshotEntry } from './vfs.ts';
import { WasiPolyfill, WasiProcExit } from './wasi-polyfill.ts';
import { ProcessManager } from './process.ts';
import { UserManager } from './user.ts';
import { RingBufferReader, RingBufferWriter } from './ring-buffer.ts';

interface CommandMessage {
  wasmModule: WebAssembly.Module;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  stdin?: Uint8Array | string | null;
  vfsSnapshot?: VfsSnapshotEntry[] | null;
  stdinBuffer?: SharedArrayBuffer | null;
  stdoutBuffer?: SharedArrayBuffer | null;
  waitBuffer?: SharedArrayBuffer;
  readyBuffer?: SharedArrayBuffer;
  streaming?: boolean;
}

interface CommandResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
  vfsChanges: VfsSnapshotEntry[];
  error?: string;
}

/** Callback for streaming I/O messages from the worker. */
export type StreamCallback = (msg: { type: string; data?: Uint8Array; exitCode?: number; vfsChanges?: VfsSnapshotEntry[] }) => void;

/**
 * Execute a command in a fresh WASM instance.
 */
export async function executeCommand(wasmModule: WebAssembly.Module, options: CommandMessage, streamCallback?: StreamCallback): Promise<CommandResult> {
  const {
    command,
    args = [],
    env = {},
    cwd = '/',
    stdin = null,
    vfsSnapshot = null,
    stdinBuffer = null,
    stdoutBuffer = null,
    streaming = false,
  } = options;

  const fdTable = new FDTable();
  const vfs = vfsSnapshot ? VFS.fromSnapshot(vfsSnapshot) : new VFS();

  const wasi = new WasiPolyfill(fdTable, vfs, {
    args: [command, ...args],
    env,
    stdin,
  });

  // Memory reference set after instantiation
  let wasmMemory: WebAssembly.Memory | null = null;

  // Resolve worker script path for subprocess spawning
  const workerScript = new URL('./worker-entry.ts', import.meta.url);

  // Create ProcessManager for host_process syscalls.
  // Wire up stdout/stderr callbacks so inline-executed children can write
  // to this process's stdout/stderr buffers.
  const processManager = new ProcessManager({
    fdTable,
    getMemory: () => wasmMemory,
    workerScript,
    wasmModule,
    vfs,
    pid: 1,
    ppid: 0,
    writeStdout: (data: Uint8Array) => wasi.appendStdout(data),
    writeStderr: (data: Uint8Array) => wasi.appendStderr(data),
  });

  // Create UserManager for host_user syscalls
  const userManager = new UserManager({
    getMemory: () => wasmMemory,
    fdTable,
  });

  const imports = {
    wasi_snapshot_preview1: wasi.getImports(),
    host_process: processManager.getImports(),
    host_user: userManager.getImports(),
  };

  const instance = await WebAssembly.instantiate(wasmModule, imports as unknown as WebAssembly.Imports);

  if (!instance.exports.memory) {
    throw new Error('WASM module does not export memory');
  }
  if (typeof instance.exports._start !== 'function') {
    throw new Error('WASM module does not export _start');
  }

  wasmMemory = instance.exports.memory as WebAssembly.Memory;
  wasi.setMemory(wasmMemory);

  // Wire up ring buffers for parallel pipeline mode
  let stdoutWriter: RingBufferWriter | null = null;
  if (stdinBuffer) {
    const reader = new RingBufferReader(stdinBuffer);
    wasi.setStdinReader((buf, offset, length) => reader.read(buf, offset, length));
  }
  if (stdoutBuffer) {
    stdoutWriter = new RingBufferWriter(stdoutBuffer);
    wasi.setStdoutWriter((buf, offset, length) => stdoutWriter!.write(buf, offset, length));
  }

  // Wire up streaming callbacks — post stdout/stderr chunks immediately
  if (streaming && streamCallback) {
    wasi.setStdoutWriter((buf, offset, length) => {
      streamCallback({ type: 'stdout', data: buf.slice(offset, offset + length) });
      return length;
    });
    wasi.setStderrWriter((buf, offset, length) => {
      streamCallback({ type: 'stderr', data: buf.slice(offset, offset + length) });
      return length;
    });
  }

  let exitCode = 0;
  try {
    (instance.exports._start as () => void)();
  } catch (e) {
    if (e instanceof WasiProcExit || (e instanceof Error && e.name === 'WasiProcExit')) {
      exitCode = (e as WasiProcExit).exitCode;
    } else if (e instanceof WebAssembly.RuntimeError) {
      exitCode = 128;
    } else {
      throw e;
    }
  }

  // Close stdout ring buffer to signal EOF to downstream stage
  if (stdoutWriter) {
    stdoutWriter.close();
  }

  return {
    exitCode,
    stdout: wasi.stdout,
    stderr: wasi.stderr,
    vfsChanges: vfs.snapshot(),
  };
}

// --- Worker message handler ---

async function handleMessage(respond: (data: unknown) => void, msg: CommandMessage): Promise<void> {
  // Signal readyBuffer immediately — confirms this Worker is alive,
  // message handler is installed, and processing has started.
  // The parent blocks on this before returning from proc_spawn.
  if (msg.readyBuffer) {
    const readyView = new Int32Array(msg.readyBuffer);
    Atomics.store(readyView, 0, 1);  // IDX_READY = 1
    Atomics.notify(readyView, 0);    // wake parent
  }

  // In streaming mode, post stdout/stderr chunks as they are written
  const streamCallback: StreamCallback | undefined = msg.streaming
    ? (streamMsg) => respond(streamMsg)
    : undefined;

  try {
    const result = await executeCommand(msg.wasmModule, msg, streamCallback);

    // If a waitBuffer was provided, signal completion directly from
    // this thread using Atomics — the parent may be blocked in WASM
    // and unable to process event-loop messages.
    if (msg.waitBuffer) {
      const waitView = new Int32Array(msg.waitBuffer);
      Atomics.store(waitView, 0, result.exitCode); // IDX_EXIT_CODE
      Atomics.store(waitView, 1, 1);               // IDX_DONE_FLAG
      Atomics.notify(waitView, 1);                  // wake parent
    }

    if (msg.streaming) {
      // In streaming mode, post a final 'exit' message with exit code and VFS changes
      respond({ type: 'exit', exitCode: result.exitCode, vfsChanges: result.vfsChanges });
    } else {
      respond({
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        vfsChanges: result.vfsChanges,
      });
    }
  } catch (e) {
    // Signal error via waitBuffer if available
    if (msg.waitBuffer) {
      const waitView = new Int32Array(msg.waitBuffer);
      Atomics.store(waitView, 0, 1);  // exit code 1
      Atomics.store(waitView, 1, 1);  // done
      Atomics.notify(waitView, 1);
    }

    if (msg.streaming) {
      respond({ type: 'stderr', data: new TextEncoder().encode(`worker error: ${(e as Error).message}\n`) });
      respond({ type: 'exit', exitCode: 1, vfsChanges: [] });
    } else {
      respond({
        exitCode: 1,
        stdout: new Uint8Array(0),
        stderr: new TextEncoder().encode(`worker error: ${(e as Error).message}\n`),
        vfsChanges: [],
        error: (e as Error).message,
      });
    }
  }
}

// Auto-detect worker context and set up message handler
try {
  const { parentPort } = await import('node:worker_threads');
  if (parentPort) {
    // Node.js worker thread
    parentPort.on('message', (msg: CommandMessage) => {
      handleMessage((data) => parentPort!.postMessage(data), msg);
    });
  }
} catch {
  // Not in Node.js — try browser Web Worker
  if (typeof self !== 'undefined' && typeof (self as DedicatedWorkerGlobalScope).postMessage === 'function'
      && typeof (self as typeof globalThis & { window?: unknown }).window === 'undefined') {
    (self as DedicatedWorkerGlobalScope).onmessage = (event: MessageEvent<CommandMessage>) => {
      handleMessage((data) => (self as DedicatedWorkerGlobalScope).postMessage(data), event.data);
    };
  }
}
