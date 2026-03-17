/**
 * Tests for process.js -- ProcessManager host_process syscall implementations.
 */

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert';
import { FDTable, ERRNO_SUCCESS, ERRNO_EBADF, FILETYPE_UNKNOWN, RIGHT_FD_READ, RIGHT_FD_WRITE } from '../src/fd-table.ts';
import type { PipeBuffer } from '../src/fd-table.ts';
import { ProcessManager } from '../src/process.ts';
import type { HostProcessImports } from '../src/process.ts';
import { VFS } from '../src/vfs.ts';
import { WasiPolyfill } from '../src/wasi-polyfill.ts';

// WASI errno codes
const ERRNO_ESRCH = 71;
const ERRNO_ENOSYS = 52;

/**
 * Helper to create a minimal WASM memory for testing.
 * Allocates 1 page (64KB) of memory.
 */
function createTestMemory(sizePages = 1): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial: sizePages });
}

/**
 * Helper to create a ProcessManager with a mock memory.
 */
function createTestProcessManager(options: {
  fdTable?: FDTable;
  memory?: WebAssembly.Memory;
  pid?: number;
  ppid?: number;
  workerScript?: string | null;
  wasmModule?: WebAssembly.Module | null;
  vfs?: null;
} = {}) {
  const fdTable = options.fdTable || new FDTable();
  const memory = options.memory || createTestMemory();
  const pm = new ProcessManager({
    fdTable,
    getMemory: () => memory,
    pid: options.pid ?? 1,
    ppid: options.ppid ?? 0,
    workerScript: options.workerScript || undefined,
    wasmModule: options.wasmModule || undefined,
    vfs: options.vfs || undefined,
  });
  return { pm, fdTable, memory };
}

// ================================================================
// proc_getpid / proc_getppid tests
// ================================================================

describe('ProcessManager - proc_getpid', () => {
  test('returns current process PID', () => {
    const { pm, memory } = createTestProcessManager({ pid: 42 });
    const imports = pm.getImports();
    const retPtr = 256;

    const errno = imports.proc_getpid(retPtr);
    assert.strictEqual(errno, ERRNO_SUCCESS);

    const dv = new DataView(memory.buffer);
    assert.strictEqual(dv.getUint32(retPtr, true), 42);
  });

  test('returns default PID 1', () => {
    const { pm, memory } = createTestProcessManager();
    const imports = pm.getImports();
    const retPtr = 256;

    const errno = imports.proc_getpid(retPtr);
    assert.strictEqual(errno, ERRNO_SUCCESS);
    assert.strictEqual(new DataView(memory.buffer).getUint32(retPtr, true), 1);
  });

  test('returns ENOSYS when memory unavailable', () => {
    const fdTable = new FDTable();
    const pm = new ProcessManager({
      fdTable,
      getMemory: () => null,
      pid: 1,
      ppid: 0,
    });
    const imports = pm.getImports();
    assert.strictEqual(imports.proc_getpid(0), ERRNO_ENOSYS);
  });
});

describe('ProcessManager - proc_getppid', () => {
  test('returns parent process PID', () => {
    const { pm, memory } = createTestProcessManager({ ppid: 10 });
    const imports = pm.getImports();
    const retPtr = 256;

    const errno = imports.proc_getppid(retPtr);
    assert.strictEqual(errno, ERRNO_SUCCESS);
    assert.strictEqual(new DataView(memory.buffer).getUint32(retPtr, true), 10);
  });

  test('returns default PPID 0', () => {
    const { pm, memory } = createTestProcessManager();
    const imports = pm.getImports();
    const retPtr = 256;

    const errno = imports.proc_getppid(retPtr);
    assert.strictEqual(errno, ERRNO_SUCCESS);
    assert.strictEqual(new DataView(memory.buffer).getUint32(retPtr, true), 0);
  });
});

// ================================================================
// fd_pipe tests
// ================================================================

describe('ProcessManager - fd_pipe', () => {
  test('creates a pipe and returns two fds', () => {
    const { pm, memory, fdTable } = createTestProcessManager();
    const imports = pm.getImports();
    const readPtr = 256;
    const writePtr = 260;

    const errno = imports.fd_pipe(readPtr, writePtr);
    assert.strictEqual(errno, ERRNO_SUCCESS);

    const dv = new DataView(memory.buffer);
    const readFd = dv.getUint32(readPtr, true);
    const writeFd = dv.getUint32(writePtr, true);

    // Both fds should be valid (>= 3 since 0/1/2 are stdio)
    assert.ok(readFd >= 3, `readFd should be >= 3, got ${readFd}`);
    assert.ok(writeFd >= 3, `writeFd should be >= 3, got ${writeFd}`);
    assert.notStrictEqual(readFd, writeFd, 'read and write fds should differ');

    // Both should be in the fd table
    assert.ok(fdTable.has(readFd));
    assert.ok(fdTable.has(writeFd));

    // Resources should be pipe type
    const readEntry = fdTable.get(readFd)!;
    const writeEntry = fdTable.get(writeFd)!;
    assert.strictEqual(readEntry.resource.type, 'pipe');
    assert.strictEqual(readEntry.resource.end, 'read');
    assert.strictEqual(writeEntry.resource.type, 'pipe');
    assert.strictEqual(writeEntry.resource.end, 'write');

    // Both ends should share the same pipe buffer
    assert.strictEqual(readEntry.resource.pipe, writeEntry.resource.pipe);
  });

  test('creates multiple independent pipes', () => {
    const { pm, memory } = createTestProcessManager();
    const imports = pm.getImports();
    const dv = new DataView(memory.buffer);

    imports.fd_pipe(256, 260);
    const r1 = dv.getUint32(256, true);
    const w1 = dv.getUint32(260, true);

    imports.fd_pipe(264, 268);
    const r2 = dv.getUint32(264, true);
    const w2 = dv.getUint32(268, true);

    // All four fds should be unique
    const fds = new Set([r1, w1, r2, w2]);
    assert.strictEqual(fds.size, 4);
  });

  test('returns ENOSYS when memory unavailable', () => {
    const fdTable = new FDTable();
    const pm = new ProcessManager({
      fdTable,
      getMemory: () => null,
    });
    const imports = pm.getImports();
    assert.strictEqual(imports.fd_pipe(0, 4), ERRNO_ENOSYS);
  });
});

// ================================================================
// fd_dup tests
// ================================================================

describe('ProcessManager - fd_dup', () => {
  test('duplicates an existing fd', () => {
    const { pm, memory, fdTable } = createTestProcessManager();
    const imports = pm.getImports();
    const retPtr = 256;

    // Dup stdout (fd 1)
    const errno = imports.fd_dup(1, retPtr);
    assert.strictEqual(errno, ERRNO_SUCCESS);

    const newFd = new DataView(memory.buffer).getUint32(retPtr, true);
    assert.ok(newFd >= 3);
    assert.ok(fdTable.has(newFd));

    // Should point to the same resource
    const origEntry = fdTable.get(1)!;
    const dupEntry = fdTable.get(newFd)!;
    assert.strictEqual(origEntry.resource, dupEntry.resource);
  });

  test('returns EBADF for invalid fd', () => {
    const { pm, memory } = createTestProcessManager();
    const imports = pm.getImports();
    const retPtr = 256;

    const errno = imports.fd_dup(999, retPtr);
    assert.strictEqual(errno, ERRNO_EBADF);
  });
});

// ================================================================
// fd_dup2 tests
// ================================================================

describe('ProcessManager - fd_dup2', () => {
  test('duplicates fd to specific number', () => {
    const { pm, fdTable } = createTestProcessManager();
    const imports = pm.getImports();

    // Open a resource manually (use a preopen resource for testing)
    const fd3 = fdTable.open({ type: 'preopen', path: '/test' } as import('../src/fd-table.js').FDResource);

    // Dup fd 1 (stdout) to fd 3
    const errno = imports.fd_dup2(1, fd3);
    assert.strictEqual(errno, ERRNO_SUCCESS);

    // fd3 should now point to stdout's resource
    const entry = fdTable.get(fd3)!;
    assert.strictEqual(entry.resource.type, 'stdio');
    assert.strictEqual(entry.resource.name, 'stdout');
  });

  test('returns EBADF for invalid source fd', () => {
    const { pm } = createTestProcessManager();
    const imports = pm.getImports();

    const errno = imports.fd_dup2(999, 5);
    assert.strictEqual(errno, ERRNO_EBADF);
  });

  test('same fd is a no-op', () => {
    const { pm } = createTestProcessManager();
    const imports = pm.getImports();

    const errno = imports.fd_dup2(1, 1);
    assert.strictEqual(errno, ERRNO_SUCCESS);
  });
});

// ================================================================
// proc_spawn tests
// ================================================================

describe('ProcessManager - proc_spawn', () => {
  test('returns ENOSYS when wasmModule not set', () => {
    const { pm, memory } = createTestProcessManager();
    const imports = pm.getImports();

    // Write argv to memory: "echo\0hello\0"
    const argv = new TextEncoder().encode('echo\0hello\0');
    new Uint8Array(memory.buffer).set(argv, 512);

    const envp = new TextEncoder().encode('PATH=/bin\0');
    new Uint8Array(memory.buffer).set(envp, 640);

    const cwd = new TextEncoder().encode('/');
    new Uint8Array(memory.buffer).set(cwd, 768);

    const errno = imports.proc_spawn(
      512, argv.length,  // argv
      640, envp.length,  // envp
      0, 1, 2,           // stdin/stdout/stderr
      768, cwd.length,   // cwd
      800                // ret_pid
    );

    assert.strictEqual(errno, ERRNO_ENOSYS);
  });

  test('returns ENOSYS when memory unavailable', () => {
    const fdTable = new FDTable();
    const pm = new ProcessManager({
      fdTable,
      getMemory: () => null,
    });
    const imports = pm.getImports();

    const errno = imports.proc_spawn(0, 0, 0, 0, 0, 1, 2, 0, 0, 0);
    assert.strictEqual(errno, ERRNO_ENOSYS);
  });
});

describe('ProcessManager - proc_spawn with mock worker', () => {
  test('allocates PID and returns success', async () => {
    // Use a fixture worker that immediately responds
    const { dirname: dirnameFn, join: joinFn } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const __dirname = dirnameFn(fileURLToPath(import.meta.url));
    const fixtureWorker = joinFn(__dirname, 'fixtures', 'process-test-worker.js');

    const memory = createTestMemory();
    const fdTable = new FDTable();
    // Create a fake WASM module (just need a truthy value for the guard check)
    const fakeModule = {} as WebAssembly.Module;

    const pm = new ProcessManager({
      fdTable,
      getMemory: () => memory,
      pid: 1,
      ppid: 0,
      workerScript: fixtureWorker,
      wasmModule: fakeModule,
    });
    const imports = pm.getImports();

    // Write argv: "echo\0hello\0"
    const argv = new TextEncoder().encode('echo\0hello\0');
    new Uint8Array(memory.buffer).set(argv, 512);

    // Write envp: "PATH=/bin\0"
    const envp = new TextEncoder().encode('PATH=/bin\0');
    new Uint8Array(memory.buffer).set(envp, 640);

    // Write cwd: "/"
    const cwd = new TextEncoder().encode('/');
    new Uint8Array(memory.buffer).set(cwd, 768);

    const retPidPtr = 800;
    const errno = imports.proc_spawn(
      512, argv.length,
      640, envp.length,
      0, 1, 2,
      768, cwd.length,
      retPidPtr
    );

    assert.strictEqual(errno, ERRNO_SUCCESS);

    const childPid = new DataView(memory.buffer).getUint32(retPidPtr, true);
    assert.ok(childPid >= 2, `child PID should be >= 2, got ${childPid}`);
  });
});

// ================================================================
// proc_waitpid tests
// ================================================================

describe('ProcessManager - proc_waitpid', () => {
  test('returns ESRCH for unknown PID', () => {
    const { pm, memory } = createTestProcessManager();
    const imports = pm.getImports();

    const errno = imports.proc_waitpid(999, 0, 256);
    assert.strictEqual(errno, ERRNO_ESRCH);
  });

  // Removed: 'blocks and returns exit code after child completes'
  // This test used a mock Worker fixture but proc_spawn now always uses inline
  // execution when wasmModule is set, so the Worker path is unreachable.
});

// ================================================================
// proc_kill tests
// ================================================================

describe('ProcessManager - proc_kill', () => {
  test('returns ESRCH for unknown PID', () => {
    const { pm } = createTestProcessManager();
    const imports = pm.getImports();

    const errno = imports.proc_kill(999, 9);
    assert.strictEqual(errno, ERRNO_ESRCH);
  });

  // Removed: 'kills a running process'
  // This test used a mock Worker fixture but proc_spawn now always uses inline
  // execution when wasmModule is set, so the Worker path is unreachable.

  test('killing already-exited process returns SUCCESS', async () => {
    const { dirname: dirnameFn, join: joinFn } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const __dirname = dirnameFn(fileURLToPath(import.meta.url));
    const fixtureWorker = joinFn(__dirname, 'fixtures', 'process-test-worker.js');

    const memory = createTestMemory();
    const fdTable = new FDTable();
    const fakeModule = {} as WebAssembly.Module;

    const pm = new ProcessManager({
      fdTable,
      getMemory: () => memory,
      pid: 1,
      ppid: 0,
      workerScript: fixtureWorker,
      wasmModule: fakeModule,
    });
    const imports = pm.getImports();

    // Spawn
    const argv = new TextEncoder().encode('echo\0');
    new Uint8Array(memory.buffer).set(argv, 512);
    const envp = new TextEncoder().encode('\0');
    new Uint8Array(memory.buffer).set(envp, 640);
    const cwd = new TextEncoder().encode('/');
    new Uint8Array(memory.buffer).set(cwd, 768);

    imports.proc_spawn(512, argv.length, 640, envp.length, 0, 1, 2, 768, cwd.length, 800);
    const childPid = new DataView(memory.buffer).getUint32(800, true);

    // Wait for it to complete
    await new Promise(r => setTimeout(r, 200));

    // Kill after exit should be SUCCESS
    const errno = imports.proc_kill(childPid, 9);
    assert.strictEqual(errno, ERRNO_SUCCESS);
  });
});

// ================================================================
// Zombie cleanup tests (US-024)
// ================================================================

describe('ProcessManager - zombie process cleanup (US-024)', () => {
  // Helper to spawn an inline child (will fail since fakeModule can't instantiate, but entry is created)
  function spawnInlineChild(imports: HostProcessImports, memory: WebAssembly.Memory): number {
    const argv = new TextEncoder().encode('echo\0');
    new Uint8Array(memory.buffer).set(argv, 512);
    const envp = new TextEncoder().encode('\0');
    new Uint8Array(memory.buffer).set(envp, 640);
    const cwd = new TextEncoder().encode('/');
    new Uint8Array(memory.buffer).set(cwd, 768);

    const errno = imports.proc_spawn(512, argv.length, 640, envp.length, 0, 1, 2, 768, cwd.length, 800);
    assert.strictEqual(errno, ERRNO_SUCCESS);
    return new DataView(memory.buffer).getUint32(800, true);
  }

  test('inline child creates zombie entry that is cleaned up via waitpid', () => {
    const memory = createTestMemory();
    const fdTable = new FDTable();
    const vfs = new VFS();
    const fakeModule = {} as WebAssembly.Module;

    const pm = new ProcessManager({
      fdTable,
      getMemory: () => memory,
      pid: 1,
      ppid: 0,
      wasmModule: fakeModule,
      workerScript: '/dummy-worker.js',
      vfs: vfs as unknown as undefined,
    });
    const imports = pm.getImports();

    const childPid = spawnInlineChild(imports, memory);

    // Entry should exist (zombie — exited but not waited on)
    assert.strictEqual(pm.processTableSize, 1, 'zombie entry should be in process table');

    // Waitpid on the child — cleans it up normally
    const statusPtr = 900;
    imports.proc_waitpid(childPid, 0, statusPtr);
    assert.strictEqual(pm.processTableSize, 0, 'process table should be empty after waitpid');
  });

  test('zombie entries are cleaned up by subsequent proc_spawn', () => {
    const memory = createTestMemory();
    const fdTable = new FDTable();
    const vfs = new VFS();
    const fakeModule = {} as WebAssembly.Module;

    const pm = new ProcessManager({
      fdTable,
      getMemory: () => memory,
      pid: 1,
      ppid: 0,
      wasmModule: fakeModule,
      workerScript: '/dummy-worker.js',
      vfs: vfs as unknown as undefined,
    });
    const imports = pm.getImports();

    // Spawn first child (creates zombie entry)
    spawnInlineChild(imports, memory);
    assert.strictEqual(pm.processTableSize, 1);

    // Spawn second child — zombie cleanup runs but first entry is < 60s old, so it stays
    spawnInlineChild(imports, memory);
    assert.strictEqual(pm.processTableSize, 2, 'both zombies should still exist (< 60s old)');
  });

  test('multiple spawn/wait cycles keep process table clean', () => {
    const memory = createTestMemory();
    const fdTable = new FDTable();
    const vfs = new VFS();
    const fakeModule = {} as WebAssembly.Module;

    const pm = new ProcessManager({
      fdTable,
      getMemory: () => memory,
      pid: 1,
      ppid: 0,
      wasmModule: fakeModule,
      workerScript: '/dummy-worker.js',
      vfs: vfs as unknown as undefined,
    });
    const imports = pm.getImports();

    // Spawn and wait on 10 children
    for (let i = 0; i < 10; i++) {
      const childPid = spawnInlineChild(imports, memory);
      const statusPtr = 900;
      imports.proc_waitpid(childPid, 0, statusPtr);
    }

    assert.strictEqual(pm.processTableSize, 0, 'process table should be empty after waiting on all children');
  });
});

// ================================================================
// getImports structure tests
// ================================================================

describe('ProcessManager - getImports', () => {
  test('returns object with all required functions', () => {
    const { pm } = createTestProcessManager();
    const imports = pm.getImports();

    const requiredFuncs: (keyof HostProcessImports)[] = [
      'proc_spawn', 'proc_waitpid', 'proc_kill',
      'proc_getpid', 'proc_getppid',
      'fd_pipe', 'fd_dup', 'fd_dup2',
    ];

    for (const name of requiredFuncs) {
      assert.strictEqual(typeof imports[name], 'function', `${name} should be a function`);
    }
  });
});

// ================================================================
// setModule / setVfs tests
// ================================================================

describe('ProcessManager - setModule/setVfs', () => {
  test('setModule sets the wasm module', () => {
    const { pm } = createTestProcessManager();
    const fakeModule = {} as WebAssembly.Module;
    pm.setModule(fakeModule);
    // No direct way to check, but proc_spawn shouldn't return ENOSYS with module set
    // (it would still fail without workerScript though)
  });

  test('setVfs sets the VFS reference', () => {
    const { pm } = createTestProcessManager();
    const fakeVfs = { snapshot: () => [] } as unknown as Parameters<typeof pm.setVfs>[0];
    pm.setVfs(fakeVfs);
    // Verify indirectly -- no error on set
  });
});

// ================================================================
// Deserialize null-separated strings (tested via proc_spawn)
// ================================================================

// ================================================================
// Removed: ProcessManager - spawn ready synchronization (3 tests)
// Removed: ProcessManager - waitpid timeout (US-044) (1 test)
// Removed: ProcessManager - argv/envp deserialization (1 test)
//
// These tests used mock Worker fixtures with `fakeModule = {} as WebAssembly.Module`.
// After the inline execution refactor, proc_spawn always takes the inline
// (synchronous WebAssembly.Instance) path when wasmModule is set, bypassing
// the Worker-based execution path entirely. The mock fixtures never run.
// ================================================================

// ================================================================
// US-040: Pipe race condition in inline execution
// ================================================================

describe('ProcessManager - inline execution pipe snapshot (US-040)', () => {
  test('inline execution does not mutate parent pipe readOffset', () => {
    const memory = createTestMemory();
    const fdTable = new FDTable();
    const vfs = new VFS();
    // Fake WASM module — will cause _executeInline to error but that's OK,
    // we're testing that pipe state is preserved, not child execution.
    const fakeModule = {} as WebAssembly.Module;

    const pm = new ProcessManager({
      fdTable,
      getMemory: () => memory,
      pid: 1,
      ppid: 0,
      wasmModule: fakeModule,
      vfs: vfs as unknown as undefined,
    });
    const imports = pm.getImports();

    // Create a pipe
    const pipePtr = 256;
    const errno = imports.fd_pipe(pipePtr, pipePtr + 4);
    assert.strictEqual(errno, ERRNO_SUCCESS);

    const dv = new DataView(memory.buffer);
    const readFd = dv.getUint32(pipePtr, true);
    const writeFd = dv.getUint32(pipePtr + 4, true);

    // Write data into pipe
    const readEntry = fdTable.get(readFd)!;
    const pipe = (readEntry.resource as { pipe: PipeBuffer }).pipe;
    const testData = new TextEncoder().encode('hello world');
    pipe.buffer.set(testData);
    pipe.writeOffset = testData.length;

    // Verify initial state
    assert.strictEqual(pipe.readOffset, 0);
    assert.strictEqual(pipe.writeOffset, testData.length);

    // Spawn child with pipe read end as stdin — triggers inline execution
    const argv = new TextEncoder().encode('cat\0');
    new Uint8Array(memory.buffer).set(argv, 512);
    const envp = new TextEncoder().encode('\0');
    new Uint8Array(memory.buffer).set(envp, 640);
    const cwd = new TextEncoder().encode('/');
    new Uint8Array(memory.buffer).set(cwd, 768);

    const retPidPtr = 800;
    // Use pipe read fd as stdin — this triggers the inline execution path
    imports.proc_spawn(
      512, argv.length,
      640, envp.length,
      readFd, 1, 2,  // stdin = pipe read end
      768, cwd.length,
      retPidPtr
    );

    // CRITICAL: parent's pipe readOffset must NOT have been mutated
    assert.strictEqual(pipe.readOffset, 0,
      'parent pipe readOffset should be unchanged after inline execution');
    assert.strictEqual(pipe.writeOffset, testData.length,
      'parent pipe writeOffset should be unchanged');

    // Verify data is still readable from the pipe
    const remaining = pipe.writeOffset - pipe.readOffset;
    assert.strictEqual(remaining, testData.length,
      'all pipe data should still be available to parent');
  });
});

describe('Pipe reader assertion (US-040)', () => {
  test('assertion fires if two readers consume the same pipe', () => {
    const fdTable = new FDTable();
    const vfs = new VFS();

    // Create a shared pipe buffer
    const pipe: PipeBuffer = {
      buffer: new Uint8Array(4096),
      readOffset: 0,
      writeOffset: 0,
    };

    // Write some data
    const data = new TextEncoder().encode('test data');
    pipe.buffer.set(data);
    pipe.writeOffset = data.length;

    // Open two read-end FDs on the same pipe
    const readFd1 = fdTable.open(
      { type: 'pipe', pipe, end: 'read' },
      { filetype: FILETYPE_UNKNOWN, rightsBase: RIGHT_FD_READ, rightsInheriting: 0n, fdflags: 0 }
    );
    const readFd2 = fdTable.open(
      { type: 'pipe', pipe, end: 'read' },
      { filetype: FILETYPE_UNKNOWN, rightsBase: RIGHT_FD_READ, rightsInheriting: 0n, fdflags: 0 }
    );

    // Create a WasiPolyfill instance with a memory to enable fd_read
    const memory = new WebAssembly.Memory({ initial: 1 });
    const wasi = new WasiPolyfill(fdTable, vfs, {});
    wasi.setMemory(memory);

    const memBytes = new Uint8Array(memory.buffer);
    const view = new DataView(memory.buffer);

    // Set up iovec: buf=1024, buf_len=100
    view.setUint32(256, 1024, true);     // iov[0].buf
    view.setUint32(260, 100, true);      // iov[0].buf_len

    const wasiImports = wasi.getImports();

    // First reader should succeed
    const nreadPtr = 512;
    const errno1 = wasiImports.fd_read(readFd1, 256, 1, nreadPtr);
    assert.strictEqual(errno1, 0, 'first reader should succeed');

    // Reset pipe state so there's data for second reader
    pipe.readOffset = 0;

    // Second reader on same pipe should throw assertion error
    assert.throws(
      () => wasiImports.fd_read(readFd2, 256, 1, nreadPtr),
      (err: Error) => {
        assert.ok(err.message.includes('multiple readers'),
          `expected "multiple readers" in error message, got: ${err.message}`);
        return true;
      },
      'reading from same pipe with different fd should throw'
    );
  });

  test('same reader can read from pipe multiple times', () => {
    const fdTable = new FDTable();
    const vfs = new VFS();

    // Create a shared pipe buffer with enough data
    const pipe: PipeBuffer = {
      buffer: new Uint8Array(4096),
      readOffset: 0,
      writeOffset: 0,
    };

    const data = new TextEncoder().encode('hello world, this is enough data');
    pipe.buffer.set(data);
    pipe.writeOffset = data.length;

    const readFd = fdTable.open(
      { type: 'pipe', pipe, end: 'read' },
      { filetype: FILETYPE_UNKNOWN, rightsBase: RIGHT_FD_READ, rightsInheriting: 0n, fdflags: 0 }
    );

    const memory = new WebAssembly.Memory({ initial: 1 });
    const wasi = new WasiPolyfill(fdTable, vfs, {});
    wasi.setMemory(memory);

    const view = new DataView(memory.buffer);
    // iovec: buf=1024, buf_len=5 (read 5 bytes at a time)
    view.setUint32(256, 1024, true);
    view.setUint32(260, 5, true);

    const wasiImports = wasi.getImports();
    const nreadPtr = 512;

    // Multiple reads from the same fd should succeed
    const errno1 = wasiImports.fd_read(readFd, 256, 1, nreadPtr);
    assert.strictEqual(errno1, 0);
    assert.strictEqual(view.getUint32(nreadPtr, true), 5);

    const errno2 = wasiImports.fd_read(readFd, 256, 1, nreadPtr);
    assert.strictEqual(errno2, 0);
    assert.strictEqual(view.getUint32(nreadPtr, true), 5);

    // No assertion error — same reader is fine
  });
});
