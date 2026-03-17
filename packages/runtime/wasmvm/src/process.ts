/**
 * JS host_process syscall implementations.
 *
 * Manages a virtual process table where each child process runs in its own
 * Worker thread. Uses SharedArrayBuffer + Atomics for blocking waitpid.
 *
 * Provides the host_process import functions that the WASM module calls:
 * proc_spawn, proc_waitpid, proc_kill, proc_getpid, proc_getppid,
 * fd_pipe, fd_dup, fd_dup2.
 */

import { WorkerAdapter } from './worker-adapter.ts';
import { FDTable, ERRNO_SUCCESS, ERRNO_EBADF, FILETYPE_UNKNOWN, RIGHT_FD_READ, RIGHT_FD_WRITE } from './fd-table.ts';
import { VFS } from './vfs.ts';
// @ts-ignore -- wasi-polyfill.js has no declaration file yet
import { WasiPolyfill, WasiProcExit } from './wasi-polyfill.ts';

import type * as WorkerThreadsModule from 'node:worker_threads';

// Eagerly import worker_threads for synchronous Worker creation.
// This is critical: proc_spawn must create Workers synchronously so that
// the child starts running on a separate OS thread before the parent
// WASM enters a busy-loop (e.g., timeout's try_wait loop).
let _WorkerThreads: typeof WorkerThreadsModule | null = null;
try {
  _WorkerThreads = await import('node:worker_threads');
} catch {
  // Not in Node.js (browser environment)
}

// WASI errno codes used by process operations
const ERRNO_ESRCH = 71;   // No such process
const ERRNO_CHILD = 10;   // No child processes
const ERRNO_INVAL = 28;   // Invalid argument
const ERRNO_ENOSYS = 52;  // Function not implemented

// SharedArrayBuffer layout for wait synchronization:
// Int32Array index 0: exit code (written by child/kill)
// Int32Array index 1: completion flag (0 = running, 1 = done)
const WAIT_BUFFER_SIZE = 8; // 2 x Int32 = 8 bytes
const IDX_EXIT_CODE = 0;
const IDX_DONE_FLAG = 1;

// SharedArrayBuffer layout for spawn-ready synchronization:
// Int32Array index 0: ready flag (0 = not ready, 1 = ready)
const READY_BUFFER_SIZE = 4; // 1 x Int32
const IDX_READY = 0;

// Timeout for child Worker readiness (milliseconds)
const SPAWN_READY_TIMEOUT_MS = 5000;
const ERRNO_TIMEDOUT = 73; // WASI ETIMEDOUT

/**
 * Unified handle interface for Worker instances from both
 * WorkerAdapter (browser/Node) and raw node:worker_threads.
 */
export interface WorkerHandle {
  postMessage(data: unknown, transferList?: Transferable[]): void;
  onMessage?(handler: (data: ChildWorkerMessage) => void): void;
  onError?(handler: (err: Error) => void): void;
  terminate(): void | Promise<number>;
  _worker?: WorkerThreadsModule.Worker;
}

/** Message sent from a child worker upon completion. */
export interface ChildWorkerMessage {
  exitCode?: number;
  stdout?: Uint8Array;
  stderr?: Uint8Array;
  vfsChanges?: VfsSnapshotEntry[];
}

/** A single VFS snapshot entry for transfer between workers. */
export interface VfsSnapshotEntry {
  type: string;
  path: string;
  data?: Uint8Array;
  mode?: number;
  target?: string;
}

/** Pipe buffer used by fd_pipe and inline execution. */
export interface PipeBuffer {
  buffer: Uint8Array;
  readOffset: number;
  writeOffset: number;
  _readerId?: number;  // FD of exclusive reader — assertion fires if two readers consume same pipe
}

/** Resource attached to an FDTable entry. */
export interface FDResource {
  type: string;
  pipe?: PipeBuffer;
  end?: 'read' | 'write';
  name?: string;
}

/** An FDTable entry as returned by FDTable.get(). */
export interface FDEntry {
  resource: FDResource;
  filetype: number;
  rightsBase: bigint;
  rightsInheriting: bigint;
  fdflags: number;
  cursor: bigint;
  path: string | null;
}

/** An entry in the virtual process table. */
export interface ProcessEntry {
  pid: number;
  worker: WorkerHandle | null;
  waitBuffer: SharedArrayBuffer;
  waitView: Int32Array;
  readyBuffer: SharedArrayBuffer;
  readyView: Int32Array;
  status: 'running' | 'exited';
  exitCode: number;
  exitTime?: number;
  stdout?: Uint8Array;
  stderr?: Uint8Array;
  vfsChanges?: VfsSnapshotEntry[];
}

/** Default waitpid timeout: 60 seconds */
const WAITPID_TIMEOUT_MS = 60_000;

/** Zombie processes older than this are cleaned up (milliseconds). */
const ZOMBIE_TTL_MS = 60_000;

/** Options for constructing a ProcessManager. */
export interface ProcessManagerOptions {
  fdTable: FDTable;
  getMemory: () => WebAssembly.Memory | null;
  workerScript?: string | URL;
  wasmModule?: WebAssembly.Module;
  vfs?: VFS;
  pid?: number;
  ppid?: number;
  /** Timeout in milliseconds for blocking waitpid calls (default: 60000). */
  waitpidTimeoutMs?: number;
  /** Callback to write data to parent's stdout (used by inline child execution). */
  writeStdout?: (data: Uint8Array) => void;
  /** Callback to write data to parent's stderr (used by inline child execution). */
  writeStderr?: (data: Uint8Array) => void;
}

/** Options passed to child worker spawn. */
interface SpawnOptions {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  stdin?: Uint8Array | null;
  vfsSnapshot: VfsSnapshotEntry[] | null;
}

/** Result of inline (synchronous) child execution. */
interface InlineResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

/** Host process import functions exposed to WASM. */
export interface HostProcessImports {
  proc_spawn(
    argv_ptr: number, argv_len: number,
    envp_ptr: number, envp_len: number,
    stdin_fd: number, stdout_fd: number, stderr_fd: number,
    cwd_ptr: number, cwd_len: number, ret_pid: number
  ): number;
  proc_waitpid(pid: number, options: number, ret_status: number): number;
  proc_kill(pid: number, signal: number): number;
  proc_getpid(ret_pid: number): number;
  proc_getppid(ret_pid: number): number;
  fd_pipe(ret_read_fd: number, ret_write_fd: number): number;
  fd_dup(fd: number, ret_new_fd: number): number;
  fd_dup2(old_fd: number, new_fd: number): number;
  sleep_ms(milliseconds: number): number;
}

/**
 * Manages virtual processes spawned from WASM code.
 *
 * Each spawned child gets a virtual PID, runs in a Worker, and uses
 * SharedArrayBuffer for synchronization so the parent can block on waitpid.
 */
export class ProcessManager {
  private _fdTable: FDTable;
  private _getMemory: () => WebAssembly.Memory | null;
  private _workerScript: string | URL | null;
  private _wasmModule: WebAssembly.Module | null;
  private _vfs: VFS | null;
  private _pid: number;
  private _ppid: number;
  private _adapter: WorkerAdapter;
  private _processTable: Map<number, ProcessEntry>;
  private _nextPid: number;
  private _waitpidTimeoutMs: number;
  private _writeStdout: ((data: Uint8Array) => void) | null;
  private _writeStderr: ((data: Uint8Array) => void) | null;

  constructor(options: ProcessManagerOptions) {
    this._fdTable = options.fdTable;
    this._getMemory = options.getMemory;
    this._workerScript = options.workerScript || null;
    this._wasmModule = options.wasmModule || null;
    this._vfs = options.vfs || null;
    this._pid = options.pid ?? 1;
    this._ppid = options.ppid ?? 0;
    this._adapter = new WorkerAdapter();
    this._waitpidTimeoutMs = options.waitpidTimeoutMs ?? WAITPID_TIMEOUT_MS;
    this._writeStdout = options.writeStdout || null;
    this._writeStderr = options.writeStderr || null;

    this._processTable = new Map();

    // PID allocation starts at pid+1
    this._nextPid = this._pid + 1;
  }

  /**
   * Remove zombie processes (exited but not waited on) older than ZOMBIE_TTL_MS.
   * Called at the start of each proc_spawn to prevent unbounded growth.
   */
  private _cleanupZombies(): void {
    const now = Date.now();
    for (const [pid, entry] of this._processTable) {
      if (entry.status === 'exited' && entry.exitTime != null &&
          (now - entry.exitTime) > ZOMBIE_TTL_MS) {
        this._processTable.delete(pid);
      }
    }
  }

  /** Number of entries in the process table (for diagnostics/testing). */
  get processTableSize(): number {
    return this._processTable.size;
  }

  /** Set the WASM module for child processes. */
  setModule(mod: WebAssembly.Module): void {
    this._wasmModule = mod;
  }

  /** Set the VFS reference (for snapshotting to children). */
  setVfs(vfs: VFS): void {
    this._vfs = vfs;
  }

  /**
   * Get the WASI import object for host_process functions.
   * All functions follow the wasi-ext signatures (return errno, out-params via pointers).
   */
  getImports(): HostProcessImports {
    return {
      proc_spawn: (argv_ptr: number, argv_len: number, envp_ptr: number, envp_len: number,
                   stdin_fd: number, stdout_fd: number, stderr_fd: number,
                   cwd_ptr: number, cwd_len: number, ret_pid: number): number => {
        return this._procSpawn(argv_ptr, argv_len, envp_ptr, envp_len,
                               stdin_fd, stdout_fd, stderr_fd,
                               cwd_ptr, cwd_len, ret_pid);
      },
      proc_waitpid: (pid: number, options: number, ret_status: number): number => {
        return this._procWaitpid(pid, options, ret_status);
      },
      proc_kill: (pid: number, signal: number): number => {
        return this._procKill(pid, signal);
      },
      proc_getpid: (ret_pid: number): number => {
        return this._procGetpid(ret_pid);
      },
      proc_getppid: (ret_pid: number): number => {
        return this._procGetppid(ret_pid);
      },
      fd_pipe: (ret_read_fd: number, ret_write_fd: number): number => {
        return this._fdPipe(ret_read_fd, ret_write_fd);
      },
      fd_dup: (fd: number, ret_new_fd: number): number => {
        return this._fdDup(fd, ret_new_fd);
      },
      fd_dup2: (old_fd: number, new_fd: number): number => {
        return this._fdDup2(old_fd, new_fd);
      },
      sleep_ms: (milliseconds: number): number => {
        return this._sleepMs(milliseconds);
      },
    };
  }

  // ================================================================
  // Process management
  // ================================================================

  /** Spawn a child process. */
  private _procSpawn(
    argv_ptr: number, argv_len: number,
    envp_ptr: number, envp_len: number,
    stdin_fd: number, stdout_fd: number, stderr_fd: number,
    cwd_ptr: number, cwd_len: number, ret_pid: number
  ): number {
    // Clean up zombie processes before allocating new PIDs
    this._cleanupZombies();

    const mem = this._getMemory();
    if (!mem) return ERRNO_ENOSYS;

    if (!this._wasmModule || !this._workerScript) {
      return ERRNO_ENOSYS;
    }

    const memBytes = new Uint8Array(mem.buffer);
    const dv = new DataView(mem.buffer);

    // Deserialize argv: null-separated byte buffer
    const argvBytes = memBytes.slice(argv_ptr, argv_ptr + argv_len);
    const argv = deserializeNullSeparated(argvBytes);

    // Deserialize envp: null-separated byte buffer (KEY=VALUE pairs)
    const envpBytes = memBytes.slice(envp_ptr, envp_ptr + envp_len);
    const envpStrings = deserializeNullSeparated(envpBytes);
    const env: Record<string, string> = {};
    for (const s of envpStrings) {
      const eq = s.indexOf('=');
      if (eq >= 0) {
        env[s.substring(0, eq)] = s.substring(eq + 1);
      }
    }

    // Deserialize cwd
    const cwdBytes = memBytes.slice(cwd_ptr, cwd_ptr + cwd_len);
    const cwd = new TextDecoder().decode(cwdBytes);

    // Allocate PID
    const childPid = this._nextPid++;

    // Create SharedArrayBuffer for wait synchronization
    const waitBuffer = new SharedArrayBuffer(WAIT_BUFFER_SIZE);
    const waitView = new Int32Array(waitBuffer);
    // Initialize: exit code = 0, done flag = 0 (running)
    Atomics.store(waitView, IDX_EXIT_CODE, 0);
    Atomics.store(waitView, IDX_DONE_FLAG, 0);

    // Extract command and args
    const command = argv[0] || '';
    const args = argv.slice(1);

    // Resolve stdio fd entries for pipe/stdio detection
    const stdinEntry = (stdin_fd < 0xFFFFFFFF) ? this._fdTable.get(stdin_fd) as FDEntry | null : null;
    const stdoutEntry = (stdout_fd < 0xFFFFFFFF) ? this._fdTable.get(stdout_fd) as FDEntry | null : null;
    const stderrEntry = (stderr_fd < 0xFFFFFFFF) ? this._fdTable.get(stderr_fd) as FDEntry | null : null;

    // In-process dispatch optimization: always execute children inline
    // (synchronous WASM instantiation) rather than spawning Workers.
    // This avoids Worker overhead and ensures stdout/stderr forwarding works
    // correctly for both piped and inherited stdio.
    if (this._wasmModule) {
      const result = this._executeInline(command, args, env, cwd, stdinEntry);

      // Forward child stdout to appropriate destination
      if (result.stdout.length > 0) {
        if (stdoutEntry?.resource?.type === 'pipe' && stdoutEntry.resource.pipe) {
          this._writeToPipe(stdoutEntry.resource.pipe, result.stdout);
        } else if (stdoutEntry?.resource?.type === 'stdio') {
          const name = (stdoutEntry.resource as { name?: string }).name;
          if (name === 'stdout' && this._writeStdout) this._writeStdout(result.stdout);
          else if (name === 'stderr' && this._writeStderr) this._writeStderr(result.stdout);
        }
      }

      // Forward child stderr to appropriate destination
      if (result.stderr.length > 0) {
        if (stderrEntry?.resource?.type === 'pipe' && stderrEntry.resource.pipe) {
          this._writeToPipe(stderrEntry.resource.pipe, result.stderr);
        } else if (stderrEntry?.resource?.type === 'stdio') {
          const name = (stderrEntry.resource as { name?: string }).name;
          if (name === 'stderr' && this._writeStderr) this._writeStderr(result.stderr);
          else if (name === 'stdout' && this._writeStdout) this._writeStdout(result.stderr);
        }
      }

      // Close the child's stdio fds (simulates child exit closing its copies)
      if (stdin_fd < 0xFFFFFFFF && stdin_fd > 2) this._fdTable.close(stdin_fd);
      if (stdout_fd < 0xFFFFFFFF && stdout_fd > 2) this._fdTable.close(stdout_fd);
      if (stderr_fd < 0xFFFFFFFF && stderr_fd > 2) this._fdTable.close(stderr_fd);

      // Create readyBuffer (pre-signaled — inline child is already done)
      const readyBuffer = new SharedArrayBuffer(READY_BUFFER_SIZE);
      const readyView = new Int32Array(readyBuffer);
      Atomics.store(readyView, IDX_READY, 1);

      // Mark child as already exited
      const entry: ProcessEntry = {
        pid: childPid,
        worker: null,
        waitBuffer,
        waitView,
        readyBuffer,
        readyView,
        status: 'exited',
        exitCode: result.exitCode,
        exitTime: Date.now(),
      };
      Atomics.store(waitView, IDX_EXIT_CODE, result.exitCode);
      Atomics.store(waitView, IDX_DONE_FLAG, 1);
      this._processTable.set(childPid, entry);

      dv.setUint32(ret_pid, childPid, true);
      return ERRNO_SUCCESS;
    }

    // Fallback: Worker-based execution (used when wasmModule is not available)
    // Get VFS snapshot for child
    const vfsSnapshot = this._vfs ? this._vfs.snapshot() : null;

    // Create readyBuffer for spawn-ready synchronization
    const readyBuffer = new SharedArrayBuffer(READY_BUFFER_SIZE);
    const readyView = new Int32Array(readyBuffer);
    Atomics.store(readyView, IDX_READY, 0);

    // Spawn worker SYNCHRONOUSLY -- this is critical for commands like
    // `timeout` that busy-loop calling try_wait. The Worker must be
    // created and start running on a separate OS thread before we
    // return to WASM, because the WASM event loop will be blocked.
    const entry: ProcessEntry = {
      pid: childPid,
      worker: null,
      waitBuffer,
      waitView,
      readyBuffer,
      readyView,
      status: 'running',
      exitCode: 0,
    };
    this._processTable.set(childPid, entry);

    // Spawn the worker synchronously using pre-imported worker_threads
    this._spawnChildSync(entry, {
      command,
      args,
      env,
      cwd,
      vfsSnapshot,
    });

    // Block until child Worker signals readiness (message handler installed
    // and processing started). This prevents race conditions where the
    // parent calls waitpid before the child has begun executing.
    // Returns 'ok' (notified), 'not-equal' (already ready), or 'timed-out'.
    const readyResult = Atomics.wait(entry.readyView, IDX_READY, 0, SPAWN_READY_TIMEOUT_MS);
    if (readyResult === 'timed-out') {
      // Child Worker failed to initialize within timeout — clean up
      entry.exitCode = 128;
      entry.status = 'exited';
      Atomics.store(entry.waitView, IDX_EXIT_CODE, 128);
      Atomics.store(entry.waitView, IDX_DONE_FLAG, 1);
      Atomics.notify(entry.waitView, IDX_DONE_FLAG);
      if (entry.worker) entry.worker.terminate();
      this._processTable.delete(childPid);
      return ERRNO_TIMEDOUT;
    }

    // Write child PID to return pointer
    dv.setUint32(ret_pid, childPid, true);

    return ERRNO_SUCCESS;
  }

  /**
   * Write data into a pipe buffer (matching WASI polyfill format).
   */
  private _writeToPipe(pipe: PipeBuffer, data: Uint8Array): void {
    if (!data || data.length === 0) return;
    const needed = pipe.writeOffset + data.length;
    if (needed > pipe.buffer.length) {
      const newBuf = new Uint8Array(Math.max(needed, pipe.buffer.length * 2));
      newBuf.set(pipe.buffer);
      pipe.buffer = newBuf;
    }
    pipe.buffer.set(data, pipe.writeOffset);
    pipe.writeOffset += data.length;
  }

  /**
   * Execute a child command synchronously (inline) using a fresh WASM instance.
   *
   * Used when pipes connect parent and child -- the parent will read from
   * pipes via fd_read before calling waitpid, so data must be available
   * immediately after proc_spawn returns.
   */
  private _executeInline(
    command: string,
    args: string[],
    env: Record<string, string>,
    cwd: string,
    stdinEntry: FDEntry | null
  ): InlineResult {
    // Snapshot stdin data from pipe buffer without mutating parent's pipe state.
    // The child gets its own copy; the parent's readOffset remains unchanged
    // so that no data is lost or double-consumed.
    let stdinData: Uint8Array | null = null;
    if (stdinEntry?.resource?.type === 'pipe' && stdinEntry.resource.pipe) {
      const pipe = stdinEntry.resource.pipe;
      const available = pipe.writeOffset - pipe.readOffset;
      if (available > 0) {
        stdinData = pipe.buffer.slice(pipe.readOffset, pipe.readOffset + available);
        // Do NOT advance pipe.readOffset — child has its own snapshot
      }
    }

    // Create a fresh execution environment for the child.
    // Share the parent's VFS so file modifications (touch, mkdir, etc.)
    // persist after the inline child completes. This is safe because
    // inline execution is synchronous — no concurrent VFS access.
    const childFdTable = new FDTable();
    const childVfs = this._vfs || new VFS();
    const childWasi = new WasiPolyfill(childFdTable, childVfs, {
      args: [command, ...args],
      env,
      stdin: stdinData,
    });

    // Create a real ProcessManager for the child — enables nested subprocess
    // support (subshells, command substitution, pipelines within pipelines).
    let childMemory: WebAssembly.Memory | null = null;
    const childProcessManager = new ProcessManager({
      fdTable: childFdTable,
      getMemory: () => childMemory,
      workerScript: this._workerScript || undefined,
      wasmModule: this._wasmModule || undefined,
      vfs: childVfs,
      pid: this._nextPid,
      ppid: this._pid,
      writeStdout: (data: Uint8Array) => childWasi.appendStdout(data),
      writeStderr: (data: Uint8Array) => childWasi.appendStderr(data),
    });

    interface HostUserImports {
      getuid(p: number): number;
      getgid(p: number): number;
      geteuid(p: number): number;
      getegid(p: number): number;
      isatty(fd: number, p: number): number;
      getpwuid(uid: number, buf: number, len: number, rlen: number): number;
    }

    const childHostUser: HostUserImports = {
      getuid: (p: number): number => { if (childMemory) new DataView(childMemory.buffer).setUint32(p, 1000, true); return 0; },
      getgid: (p: number): number => { if (childMemory) new DataView(childMemory.buffer).setUint32(p, 1000, true); return 0; },
      geteuid: (p: number): number => { if (childMemory) new DataView(childMemory.buffer).setUint32(p, 1000, true); return 0; },
      getegid: (p: number): number => { if (childMemory) new DataView(childMemory.buffer).setUint32(p, 1000, true); return 0; },
      isatty: (_fd: number, p: number): number => { if (childMemory) new DataView(childMemory.buffer).setUint32(p, 0, true); return 0; },
      getpwuid: (uid: number, buf: number, len: number, rlen: number): number => {
        if (!childMemory) return ERRNO_ENOSYS;
        const s = `user:x:${uid}:1000::/home/user:/bin/sh`;
        const bytes = new TextEncoder().encode(s);
        const n = Math.min(bytes.length, len);
        new Uint8Array(childMemory.buffer).set(bytes.subarray(0, n), buf);
        new DataView(childMemory.buffer).setUint32(rlen, n, true);
        return 0;
      },
    };

    const childImports = {
      wasi_snapshot_preview1: childWasi.getImports(),
      host_process: childProcessManager.getImports() as unknown as WebAssembly.ModuleImports,
      host_user: childHostUser as unknown as WebAssembly.ModuleImports,
    };

    // Instantiate synchronously -- this is the key to inline execution
    let exitCode = 0;
    try {
      const instance = new WebAssembly.Instance(this._wasmModule!, childImports as unknown as WebAssembly.Imports);
      childMemory = instance.exports.memory as WebAssembly.Memory;
      childWasi.setMemory(childMemory);
      (instance.exports._start as () => void)();
    } catch (e: unknown) {
      if (e instanceof WasiProcExit || (e instanceof Error && e.name === 'WasiProcExit')) {
        exitCode = (e as WasiProcExit).exitCode;
      } else if (e instanceof WebAssembly.RuntimeError) {
        exitCode = 128;
      } else {
        // Unexpected error -- treat as crash
        exitCode = 1;
      }
    }

    return {
      exitCode,
      stdout: childWasi.stdout,
      stderr: childWasi.stderr,
    };
  }

  /**
   * Spawn a child worker SYNCHRONOUSLY using pre-imported worker_threads.
   *
   * This ensures the Worker thread is created and the command message is
   * sent before proc_spawn returns to WASM. The child can then make
   * progress on its own OS thread even while the parent WASM busy-loops.
   */
  private _spawnChildSync(entry: ProcessEntry, options: SpawnOptions): void {
    try {
      if (_WorkerThreads) {
        // Node.js: Worker constructor is synchronous
        const scriptStr = typeof this._workerScript === 'string' ? this._workerScript : (this._workerScript as URL).href;
        const execArgv = scriptStr.endsWith('.ts') ? ['--import', 'tsx'] : [];
        const worker = new _WorkerThreads.Worker(this._workerScript as string | URL, {
          workerData: {},
          execArgv,
        });
        const handle: WorkerHandle = {
          _worker: worker,
          terminate: () => worker.terminate(),
          postMessage: (data: unknown) => worker.postMessage(data),
        };
        entry.worker = handle;

        // Wire up message handler (fires on parent event loop --
        // mainly for collecting stdout/stderr after waitpid unblocks)
        worker.on('message', (data: ChildWorkerMessage) => {
          entry.exitCode = data.exitCode ?? 0;
          entry.status = 'exited';
          entry.exitTime = Date.now();
          entry.stdout = data.stdout;
          entry.stderr = data.stderr;
          entry.vfsChanges = data.vfsChanges;
          // SharedArrayBuffer is updated by the child Worker directly,
          // but set it here too for safety
          Atomics.store(entry.waitView, IDX_EXIT_CODE, entry.exitCode);
          Atomics.store(entry.waitView, IDX_DONE_FLAG, 1);
          Atomics.notify(entry.waitView, IDX_DONE_FLAG);
          worker.terminate();
        });

        worker.on('error', () => {
          entry.exitCode = 1;
          entry.status = 'exited';
          entry.exitTime = Date.now();
          Atomics.store(entry.waitView, IDX_EXIT_CODE, 1);
          Atomics.store(entry.waitView, IDX_DONE_FLAG, 1);
          Atomics.notify(entry.waitView, IDX_DONE_FLAG);
          // Signal ready in case parent is still waiting on readyBuffer
          Atomics.store(entry.readyView, IDX_READY, 1);
          Atomics.notify(entry.readyView, IDX_READY);
          worker.terminate();
        });

        // Send command with waitBuffer and readyBuffer so child can signal
        // directly from its own thread (critical when parent is blocked
        // in WASM busy-loop and can't process event loop messages)
        worker.postMessage({
          wasmModule: this._wasmModule,
          command: options.command,
          args: options.args,
          env: options.env,
          cwd: options.cwd,
          stdin: options.stdin || null,
          vfsSnapshot: options.vfsSnapshot,
          waitBuffer: entry.waitBuffer,
          readyBuffer: entry.readyBuffer,
        });
      } else {
        // Browser: fall back to async spawn via WorkerAdapter
        this._spawnChild(entry, options);
      }
    } catch {
      entry.exitCode = 127;
      entry.status = 'exited';
      entry.exitTime = Date.now();
      Atomics.store(entry.waitView, IDX_EXIT_CODE, 127);
      Atomics.store(entry.waitView, IDX_DONE_FLAG, 1);
      Atomics.notify(entry.waitView, IDX_DONE_FLAG);
      // Signal ready so parent doesn't block on readyBuffer
      Atomics.store(entry.readyView, IDX_READY, 1);
      Atomics.notify(entry.readyView, IDX_READY);
    }
  }

  /** Spawn a child worker and wire up completion handling (async fallback). */
  private async _spawnChild(entry: ProcessEntry, options: SpawnOptions): Promise<void> {
    try {
      const worker = await this._adapter.spawn(this._workerScript as string | URL, {
        workerData: {},
      });

      entry.worker = worker as WorkerHandle;

      (worker as WorkerHandle).onMessage!((data: ChildWorkerMessage) => {
        // Child completed -- write exit code and signal done
        entry.exitCode = data.exitCode ?? 0;
        entry.status = 'exited';
        entry.exitTime = Date.now();
        Atomics.store(entry.waitView, IDX_EXIT_CODE, entry.exitCode);
        Atomics.store(entry.waitView, IDX_DONE_FLAG, 1);
        Atomics.notify(entry.waitView, IDX_DONE_FLAG);

        // Store stdout/stderr for potential collection
        entry.stdout = data.stdout;
        entry.stderr = data.stderr;
        entry.vfsChanges = data.vfsChanges;

        worker.terminate();
      });

      (worker as WorkerHandle).onError!((_err: Error) => {
        entry.exitCode = 1;
        entry.status = 'exited';
        entry.exitTime = Date.now();
        Atomics.store(entry.waitView, IDX_EXIT_CODE, 1);
        Atomics.store(entry.waitView, IDX_DONE_FLAG, 1);
        Atomics.notify(entry.waitView, IDX_DONE_FLAG);
        worker.terminate();
      });

      // Send the command to the worker
      worker.postMessage({
        wasmModule: this._wasmModule,
        command: options.command,
        args: options.args,
        env: options.env,
        cwd: options.cwd,
        stdin: options.stdin || null,
        vfsSnapshot: options.vfsSnapshot,
        readyBuffer: entry.readyBuffer,
      });
    } catch {
      // Spawn failed -- signal immediate exit with error
      entry.exitCode = 127;
      entry.status = 'exited';
      entry.exitTime = Date.now();
      Atomics.store(entry.waitView, IDX_EXIT_CODE, 127);
      Atomics.store(entry.waitView, IDX_DONE_FLAG, 1);
      Atomics.notify(entry.waitView, IDX_DONE_FLAG);
      // Signal ready so parent doesn't block on readyBuffer
      Atomics.store(entry.readyView, IDX_READY, 1);
      Atomics.notify(entry.readyView, IDX_READY);
    }
  }

  /**
   * Wait for a child process to exit.
   * Blocks via Atomics.wait until the child signals completion.
   */
  private _procWaitpid(pid: number, options: number, ret_status: number): number {
    const mem = this._getMemory();
    if (!mem) return ERRNO_ENOSYS;

    const entry = this._processTable.get(pid);
    if (!entry) return ERRNO_ESRCH;

    const dv = new DataView(mem.buffer);

    // WNOHANG option (1) -- non-blocking check
    const WNOHANG = 1;
    if (options & WNOHANG) {
      const done = Atomics.load(entry.waitView, IDX_DONE_FLAG);
      if (done === 0) {
        // Child still running -- return ECHILD so Rust try_wait returns Ok(None)
        return ERRNO_CHILD;
      }
    } else {
      // Block until child exits (with timeout)
      const waitResult = Atomics.wait(entry.waitView, IDX_DONE_FLAG, 0, this._waitpidTimeoutMs);
      if (waitResult === 'timed-out') {
        // Child hung — force kill with exit code 137 (SIGKILL)
        if (entry.worker) entry.worker.terminate();
        entry.exitCode = 137;
        entry.status = 'exited';
        entry.exitTime = Date.now();
        Atomics.store(entry.waitView, IDX_EXIT_CODE, 137);
        Atomics.store(entry.waitView, IDX_DONE_FLAG, 1);
        Atomics.notify(entry.waitView, IDX_DONE_FLAG);
        try { process.stderr.write(`waitpid: timeout after ${this._waitpidTimeoutMs}ms waiting for PID ${pid}\n`); } catch { /* ignore if stderr unavailable */ }
      }
    }

    // Child has exited -- read exit code
    const exitCode = Atomics.load(entry.waitView, IDX_EXIT_CODE);
    dv.setUint32(ret_status, exitCode, true);

    // Clean up process table entry
    this._processTable.delete(pid);

    return ERRNO_SUCCESS;
  }

  /** Kill a process by PID. */
  private _procKill(pid: number, signal: number): number {
    const entry = this._processTable.get(pid);
    if (!entry) return ERRNO_ESRCH;

    // If already exited, just return success
    if (entry.status === 'exited') {
      return ERRNO_SUCCESS;
    }

    // Terminate the worker
    if (entry.worker) {
      entry.worker.terminate();
    }

    // Signal killed with exit code 128 + signal (e.g., 128+9=137 for SIGKILL)
    const killExitCode = 128 + (signal || 9);
    entry.exitCode = killExitCode;
    entry.status = 'exited';
    entry.exitTime = Date.now();
    Atomics.store(entry.waitView, IDX_EXIT_CODE, killExitCode);
    Atomics.store(entry.waitView, IDX_DONE_FLAG, 1);
    Atomics.notify(entry.waitView, IDX_DONE_FLAG);

    return ERRNO_SUCCESS;
  }

  /** Get this process's virtual PID. */
  private _procGetpid(ret_pid: number): number {
    const mem = this._getMemory();
    if (!mem) return ERRNO_ENOSYS;
    new DataView(mem.buffer).setUint32(ret_pid, this._pid, true);
    return ERRNO_SUCCESS;
  }

  /** Get the parent process's virtual PID. */
  private _procGetppid(ret_pid: number): number {
    const mem = this._getMemory();
    if (!mem) return ERRNO_ENOSYS;
    new DataView(mem.buffer).setUint32(ret_pid, this._ppid, true);
    return ERRNO_SUCCESS;
  }

  // ================================================================
  // FD operations (delegated to FDTable)
  // ================================================================

  /** Create an anonymous pipe (read/write fd pair). */
  private _fdPipe(ret_read_fd: number, ret_write_fd: number): number {
    const mem = this._getMemory();
    if (!mem) return ERRNO_ENOSYS;

    // Create shared pipe buffer (format matches WASI polyfill expectations)
    const pipe: PipeBuffer = {
      buffer: new Uint8Array(4096),
      readOffset: 0,
      writeOffset: 0,
    };

    const readFd = this._fdTable.open(
      { type: 'pipe', pipe, end: 'read' },
      { filetype: FILETYPE_UNKNOWN, rightsBase: RIGHT_FD_READ, rightsInheriting: 0n, fdflags: 0 }
    );

    const writeFd = this._fdTable.open(
      { type: 'pipe', pipe, end: 'write' },
      { filetype: FILETYPE_UNKNOWN, rightsBase: RIGHT_FD_WRITE, rightsInheriting: 0n, fdflags: 0 }
    );

    const dv = new DataView(mem.buffer);
    dv.setUint32(ret_read_fd, readFd, true);
    dv.setUint32(ret_write_fd, writeFd, true);

    return ERRNO_SUCCESS;
  }

  /** Duplicate a file descriptor. */
  private _fdDup(fd: number, ret_new_fd: number): number {
    const mem = this._getMemory();
    if (!mem) return ERRNO_ENOSYS;

    const newFd = this._fdTable.dup(fd);
    if (newFd < 0) return ERRNO_EBADF;

    new DataView(mem.buffer).setUint32(ret_new_fd, newFd, true);
    return ERRNO_SUCCESS;
  }

  /** Duplicate a file descriptor to a specific number. */
  private _fdDup2(old_fd: number, new_fd: number): number {
    return this._fdTable.dup2(old_fd, new_fd);
  }

  // ================================================================
  // Misc host operations
  // ================================================================

  /** Sleep for the specified number of milliseconds via Atomics.wait. */
  private _sleepMs(milliseconds: number): number {
    if (milliseconds <= 0) return ERRNO_SUCCESS;
    const sab = new SharedArrayBuffer(4);
    const view = new Int32Array(sab);
    Atomics.wait(view, 0, 0, milliseconds);
    return ERRNO_SUCCESS;
  }
}

// ================================================================
// Helpers
// ================================================================

/**
 * Deserialize a null-separated byte buffer into an array of strings.
 * Format: "str1\0str2\0str3\0" -> ["str1", "str2", "str3"]
 */
function deserializeNullSeparated(bytes: Uint8Array): string[] {
  const decoder = new TextDecoder();
  const strings: string[] = [];
  let start = 0;

  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) {
      if (i > start) {
        strings.push(decoder.decode(bytes.subarray(start, i)));
      }
      start = i + 1;
    }
  }

  // Handle trailing content without null terminator
  if (start < bytes.length) {
    strings.push(decoder.decode(bytes.subarray(start)));
  }

  return strings;
}
