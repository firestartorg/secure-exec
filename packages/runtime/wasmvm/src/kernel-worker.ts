/**
 * Worker entry for WasmVM kernel-integrated execution.
 *
 * Runs a single WASM command inside a worker thread. Communicates
 * with the main thread via SharedArrayBuffer RPC for synchronous
 * kernel calls (file I/O, VFS, process spawn) and postMessage for
 * stdout/stderr streaming.
 *
 * proc_spawn is provided as a host_process import so brush-shell
 * pipeline stages route through KernelInterface.spawn() to the
 * correct runtime driver.
 */

import { workerData, parentPort } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { WasiPolyfill, WasiProcExit } from './wasi-polyfill.ts';
import { UserManager } from './user.ts';
import { FDTable } from '../test/helpers/test-fd-table.ts';
import {
  FILETYPE_CHARACTER_DEVICE,
  FILETYPE_REGULAR_FILE,
  ERRNO_SUCCESS,
  ERRNO_EINVAL,
} from './wasi-constants.ts';
import { VfsError } from './wasi-types.ts';
import type { WasiVFS, WasiInode, VfsStat, VfsSnapshotEntry } from './wasi-types.ts';
import type { WasiFileIO } from './wasi-file-io.ts';
import type { WasiProcessIO } from './wasi-process-io.ts';
import {
  SIG_IDX_STATE,
  SIG_IDX_ERRNO,
  SIG_IDX_INT_RESULT,
  SIG_IDX_DATA_LEN,
  SIG_STATE_IDLE,
  SIG_STATE_READY,
  RPC_WAIT_TIMEOUT_MS,
  type WorkerInitData,
  type SyscallRequest,
} from './syscall-rpc.ts';

const port = parentPort!;
const init = workerData as WorkerInitData;

// -------------------------------------------------------------------------
// RPC client — blocks worker thread until main thread responds
// -------------------------------------------------------------------------

const signalArr = new Int32Array(init.signalBuf);
const dataArr = new Uint8Array(init.dataBuf);

function rpcCall(call: string, args: Record<string, unknown>): {
  errno: number;
  intResult: number;
  data: Uint8Array;
} {
  // Reset signal
  Atomics.store(signalArr, SIG_IDX_STATE, SIG_STATE_IDLE);

  // Post request
  const msg: SyscallRequest = { type: 'syscall', call, args };
  port.postMessage(msg);

  // Block until response
  const result = Atomics.wait(signalArr, SIG_IDX_STATE, SIG_STATE_IDLE, RPC_WAIT_TIMEOUT_MS);
  if (result === 'timed-out') {
    return { errno: 76 /* EIO */, intResult: 0, data: new Uint8Array(0) };
  }

  // Read response
  const errno = Atomics.load(signalArr, SIG_IDX_ERRNO);
  const intResult = Atomics.load(signalArr, SIG_IDX_INT_RESULT);
  const dataLen = Atomics.load(signalArr, SIG_IDX_DATA_LEN);
  const data = dataLen > 0 ? dataArr.slice(0, dataLen) : new Uint8Array(0);

  // Reset for next call
  Atomics.store(signalArr, SIG_IDX_STATE, SIG_STATE_IDLE);

  return { errno, intResult, data };
}

// -------------------------------------------------------------------------
// Local FD table — mirrors kernel state for rights checking / routing
// -------------------------------------------------------------------------

const fdTable = new FDTable();

// -------------------------------------------------------------------------
// Kernel-backed WasiFileIO
// -------------------------------------------------------------------------

function createKernelFileIO(): WasiFileIO {
  return {
    fdRead(fd, maxBytes) {
      const res = rpcCall('fdRead', { fd, length: maxBytes });
      return { errno: res.errno, data: res.data };
    },
    fdWrite(fd, data) {
      const res = rpcCall('fdWrite', { fd, data: Array.from(data) });
      return { errno: res.errno, written: res.intResult };
    },
    fdOpen(path, dirflags, oflags, fdflags, rightsBase, rightsInheriting) {
      // Map WASI oflags to POSIX open flags for kernel
      let flags = 0;
      if (oflags & 0x1) flags |= 0o100;   // O_CREAT
      if (oflags & 0x2) flags |= 0o200;   // O_EXCL
      if (oflags & 0x4) flags |= 0o1000;  // O_TRUNC
      if (fdflags & 0x1) flags |= 0o2000; // O_APPEND
      if (rightsBase & 2n) flags |= 1;     // O_WRONLY

      const res = rpcCall('fdOpen', { path, flags, mode: 0o666 });
      if (res.errno !== 0) return { errno: res.errno, fd: -1, filetype: 0 };

      // Mirror in local FDTable for polyfill rights checking
      const localFd = fdTable.open(
        { type: 'vfsFile', ino: 0, path },
        { filetype: FILETYPE_REGULAR_FILE, rightsBase, rightsInheriting, fdflags, path },
      );
      return { errno: 0, fd: localFd, filetype: FILETYPE_REGULAR_FILE };
    },
    fdSeek(fd, offset, whence) {
      const res = rpcCall('fdSeek', { fd, offset: offset.toString(), whence });
      return { errno: res.errno, newOffset: BigInt(res.intResult) };
    },
    fdClose(fd) {
      fdTable.close(fd);
      const res = rpcCall('fdClose', { fd });
      return res.errno;
    },
    fdPread(fd, maxBytes, _offset) {
      const res = rpcCall('fdRead', { fd, length: maxBytes });
      return { errno: res.errno, data: res.data };
    },
    fdPwrite(fd, data, _offset) {
      const res = rpcCall('fdWrite', { fd, data: Array.from(data) });
      return { errno: res.errno, written: res.intResult };
    },
  };
}

// -------------------------------------------------------------------------
// Kernel-backed WasiProcessIO
// -------------------------------------------------------------------------

function createKernelProcessIO(): WasiProcessIO {
  return {
    getArgs() {
      return [init.command, ...init.args];
    },
    getEnviron() {
      return init.env;
    },
    fdFdstatGet(fd) {
      const entry = fdTable.get(fd);
      if (!entry) {
        return { errno: 8 /* EBADF */, filetype: 0, fdflags: 0, rightsBase: 0n, rightsInheriting: 0n };
      }
      return {
        errno: 0,
        filetype: entry.filetype,
        fdflags: entry.fdflags,
        rightsBase: entry.rightsBase,
        rightsInheriting: entry.rightsInheriting,
      };
    },
    procExit(exitCode) {
      // Exit notification handled by WasiProcExit exception path
    },
  };
}

// -------------------------------------------------------------------------
// Kernel-backed VFS proxy — routes through RPC
// -------------------------------------------------------------------------

function createKernelVfs(): WasiVFS {
  const decoder = new TextDecoder();

  return {
    exists(path: string): boolean {
      const res = rpcCall('vfsExists', { path });
      return res.errno === 0 && res.intResult === 1;
    },
    mkdir(path: string): void {
      const res = rpcCall('vfsMkdir', { path });
      if (res.errno !== 0) throw new VfsError('EACCES', path);
    },
    mkdirp(path: string): void {
      const segments = path.split('/').filter(Boolean);
      let current = '';
      for (const seg of segments) {
        current += '/' + seg;
        const exists = rpcCall('vfsExists', { path: current });
        if (exists.errno === 0 && exists.intResult === 0) {
          rpcCall('vfsMkdir', { path: current });
        }
      }
    },
    writeFile(path: string, data: Uint8Array | string): void {
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      rpcCall('vfsWriteFile', { path, data: Array.from(bytes) });
    },
    readFile(path: string): Uint8Array {
      const res = rpcCall('vfsReadFile', { path });
      if (res.errno !== 0) throw new VfsError('ENOENT', path);
      return res.data;
    },
    readdir(path: string): string[] {
      const res = rpcCall('vfsReaddir', { path });
      if (res.errno !== 0) throw new VfsError('ENOENT', path);
      return JSON.parse(decoder.decode(res.data));
    },
    stat(path: string): VfsStat {
      const res = rpcCall('vfsStat', { path });
      if (res.errno !== 0) throw new VfsError('ENOENT', path);
      return JSON.parse(decoder.decode(res.data));
    },
    lstat(path: string): VfsStat {
      return this.stat(path);
    },
    unlink(path: string): void {
      const res = rpcCall('vfsUnlink', { path });
      if (res.errno !== 0) throw new VfsError('ENOENT', path);
    },
    rmdir(path: string): void {
      const res = rpcCall('vfsRmdir', { path });
      if (res.errno !== 0) throw new VfsError('ENOENT', path);
    },
    rename(oldPath: string, newPath: string): void {
      const res = rpcCall('vfsRename', { oldPath, newPath });
      if (res.errno !== 0) throw new VfsError('ENOENT', oldPath);
    },
    symlink(target: string, linkPath: string): void {
      const res = rpcCall('vfsSymlink', { target, linkPath });
      if (res.errno !== 0) throw new VfsError('EEXIST', linkPath);
    },
    readlink(path: string): string {
      const res = rpcCall('vfsReadlink', { path });
      if (res.errno !== 0) throw new VfsError('EINVAL', path);
      return decoder.decode(res.data);
    },
    chmod(_path: string, _mode: number): void {
      // No-op — permissions handled by kernel
    },
    getIno(_path: string): number | null {
      return null;
    },
    getInodeByIno(_ino: number): WasiInode | null {
      return null;
    },
    snapshot(): VfsSnapshotEntry[] {
      return [];
    },
  };
}

// -------------------------------------------------------------------------
// Host process imports — proc_spawn routes through kernel
// -------------------------------------------------------------------------

function createHostProcessImports(getMemory: () => WebAssembly.Memory | null) {
  return {
    /**
     * proc_spawn routes through KernelInterface.spawn() so brush-shell
     * pipeline stages dispatch to the correct runtime driver.
     */
    proc_spawn(
      command_ptr: number, command_len: number,
      argv_buf_ptr: number, argc: number,
      ret_pid_ptr: number,
    ): number {
      const mem = getMemory();
      if (!mem) return ERRNO_EINVAL;

      const bytes = new Uint8Array(mem.buffer);
      const decoder = new TextDecoder();
      const command = decoder.decode(bytes.slice(command_ptr, command_ptr + command_len));

      // Read argv (ptr+len pairs)
      const args: string[] = [];
      const view = new DataView(mem.buffer);
      for (let i = 0; i < argc; i++) {
        const ptr = view.getUint32(argv_buf_ptr + i * 8, true);
        const len = view.getUint32(argv_buf_ptr + i * 8 + 4, true);
        args.push(decoder.decode(bytes.slice(ptr, ptr + len)));
      }

      // Route through kernel
      const res = rpcCall('spawn', {
        command,
        spawnArgs: args,
        env: init.env,
        cwd: init.cwd,
      });

      if (res.errno !== 0) return res.errno;
      view.setInt32(ret_pid_ptr, res.intResult, true);
      return ERRNO_SUCCESS;
    },

    proc_wait(pid: number, ret_status_ptr: number): number {
      const mem = getMemory();
      if (!mem) return ERRNO_EINVAL;

      const res = rpcCall('waitpid', { pid });
      if (res.errno !== 0) return res.errno;

      new DataView(mem.buffer).setInt32(ret_status_ptr, res.intResult, true);
      return ERRNO_SUCCESS;
    },
  };
}

// -------------------------------------------------------------------------
// Main execution
// -------------------------------------------------------------------------

async function main(): Promise<void> {
  let wasmMemory: WebAssembly.Memory | null = null;
  const getMemory = () => wasmMemory;

  const fileIO = createKernelFileIO();
  const processIO = createKernelProcessIO();
  const vfs = createKernelVfs();

  const polyfill = new WasiPolyfill(fdTable, vfs, {
    fileIO,
    processIO,
    args: [init.command, ...init.args],
    env: init.env,
  });

  // Stream stdout/stderr to main thread
  polyfill.setStdoutWriter((buf, offset, length) => {
    port.postMessage({ type: 'stdout', data: buf.slice(offset, offset + length) });
    return length;
  });
  polyfill.setStderrWriter((buf, offset, length) => {
    port.postMessage({ type: 'stderr', data: buf.slice(offset, offset + length) });
    return length;
  });

  const userManager = new UserManager({
    getMemory,
    fdTable,
    ttyFds: false,
  });

  const hostProcess = createHostProcessImports(getMemory);

  try {
    // Load WASM binary
    const wasmBytes = await readFile(init.wasmBinaryPath);
    const wasmModule = await WebAssembly.compile(wasmBytes);

    const imports: WebAssembly.Imports = {
      wasi_snapshot_preview1: polyfill.getImports() as WebAssembly.ModuleImports,
      host_user: userManager.getImports() as unknown as WebAssembly.ModuleImports,
      host_process: hostProcess as unknown as WebAssembly.ModuleImports,
    };

    const instance = await WebAssembly.instantiate(wasmModule, imports);
    wasmMemory = instance.exports.memory as WebAssembly.Memory;
    polyfill.setMemory(wasmMemory);

    // Run the command
    const start = instance.exports._start as () => void;
    start();

    // Normal exit — flush collected output
    flushOutput(polyfill);
    port.postMessage({ type: 'exit', code: 0 });
  } catch (err) {
    if (err instanceof WasiProcExit) {
      flushOutput(polyfill);
      port.postMessage({ type: 'exit', code: err.exitCode });
    } else {
      const errMsg = err instanceof Error ? err.message : String(err);
      port.postMessage({ type: 'stderr', data: new TextEncoder().encode(errMsg + '\n') });
      port.postMessage({ type: 'exit', code: 1 });
    }
  }
}

/** Flush any remaining collected output (not caught by streaming writers). */
function flushOutput(polyfill: WasiPolyfill): void {
  const stdout = polyfill.stdout;
  if (stdout.length > 0) port.postMessage({ type: 'stdout', data: stdout });
  const stderr = polyfill.stderr;
  if (stderr.length > 0) port.postMessage({ type: 'stderr', data: stderr });
}

main().catch((err) => {
  const errMsg = err instanceof Error ? err.message : String(err);
  port.postMessage({ type: 'stderr', data: new TextEncoder().encode(errMsg + '\n') });
  port.postMessage({ type: 'exit', code: 1 });
});
