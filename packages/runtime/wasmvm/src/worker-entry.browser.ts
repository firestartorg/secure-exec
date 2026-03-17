/**
 * Browser Web Worker entry script for WASM bootstrap.
 *
 * This is the browser-specific version of worker-entry.js.
 * It receives command messages via postMessage and executes them
 * using the full WASM + WASI stack.
 */

import { FDTable } from './fd-table.ts';
import { VFS } from './vfs.ts';
import type { VfsSnapshotEntry } from './vfs.ts';
import { WasiPolyfill, WasiProcExit } from './wasi-polyfill.ts';
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
type StreamCallback = (msg: { type: string; data?: Uint8Array; exitCode?: number; vfsChanges?: VfsSnapshotEntry[] }) => void;

/**
 * Execute a command in a fresh WASM instance (browser version).
 * ProcessManager is omitted — subprocess spawning not supported in browser workers.
 */
async function executeCommand(wasmModule: WebAssembly.Module, options: CommandMessage, streamCallback?: StreamCallback): Promise<CommandResult> {
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

  let wasmMemory: WebAssembly.Memory | null = null;

  const userManager = new UserManager({
    getMemory: () => wasmMemory,
    fdTable,
  });

  // Stub host_process imports (no subprocess support in browser workers)
  // Return ENOSYS (52) for unsupported ops, not -1
  const ENOSYS = 52;
  const hostProcessStubs = {
    proc_spawn: () => ENOSYS,
    proc_waitpid: () => ENOSYS,
    proc_kill: () => ENOSYS,
    proc_getpid: () => 1,
    proc_getppid: () => 0,
    fd_pipe: () => ENOSYS,
    fd_dup: () => ENOSYS,
    fd_dup2: () => ENOSYS,
    sleep_ms: (milliseconds: number) => {
      if (milliseconds <= 0) return 0;
      const sab = new SharedArrayBuffer(4);
      const view = new Int32Array(sab);
      Atomics.wait(view, 0, 0, milliseconds);
      return 0; // ERRNO_SUCCESS
    },
  };

  const imports = {
    wasi_snapshot_preview1: wasi.getImports(),
    host_process: hostProcessStubs,
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

// Browser Web Worker message handler
(self as DedicatedWorkerGlobalScope).onmessage = async (event: MessageEvent<CommandMessage>) => {
  const msg = event.data;
  const post = (data: unknown) => (self as DedicatedWorkerGlobalScope).postMessage(data);

  // Signal readyBuffer immediately — confirms this Worker is alive
  // and processing has started. Parent may block on this.
  if (msg.readyBuffer) {
    const readyView = new Int32Array(msg.readyBuffer);
    Atomics.store(readyView, 0, 1);  // IDX_READY = 1
    Atomics.notify(readyView, 0);    // wake parent
  }

  // In streaming mode, post stdout/stderr chunks as they are written
  const streamCallback: StreamCallback | undefined = msg.streaming
    ? (streamMsg) => post(streamMsg)
    : undefined;

  try {
    const result = await executeCommand(msg.wasmModule, msg, streamCallback);

    if (msg.waitBuffer) {
      const waitView = new Int32Array(msg.waitBuffer);
      Atomics.store(waitView, 0, result.exitCode);
      Atomics.store(waitView, 1, 1);
      Atomics.notify(waitView, 1);
    }

    if (msg.streaming) {
      post({ type: 'exit', exitCode: result.exitCode, vfsChanges: result.vfsChanges });
    } else {
      post({
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        vfsChanges: result.vfsChanges,
      });
    }
  } catch (e) {
    if (msg.waitBuffer) {
      const waitView = new Int32Array(msg.waitBuffer);
      Atomics.store(waitView, 0, 1);
      Atomics.store(waitView, 1, 1);
      Atomics.notify(waitView, 1);
    }

    if (msg.streaming) {
      post({ type: 'stderr', data: new TextEncoder().encode(`worker error: ${(e as Error).message}\n`) });
      post({ type: 'exit', exitCode: 1, vfsChanges: [] });
    } else {
      post({
        exitCode: 1,
        stdout: new Uint8Array(0),
        stderr: new TextEncoder().encode(`worker error: ${(e as Error).message}\n`),
        vfsChanges: [],
        error: (e as Error).message,
      });
    }
  }
};
