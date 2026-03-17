/**
 * Tests for worker-entry.js — WASM bootstrap worker.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VFS } from '../src/vfs.ts';
import { executeCommand, StreamCallback } from '../src/worker-entry.ts';
import { WorkerAdapter } from '../src/worker-adapter.ts';
import { createRingBuffer, RingBufferWriter } from '../src/ring-buffer.ts';
import type { VfsSnapshotEntry } from '../src/vfs.ts';

/**
 * The executeCommand function's second parameter type (CommandMessage) includes
 * wasmModule which is redundant since it's also the first parameter.
 * The function doesn't read wasmModule from options, so we cast our partial objects.
 */
type CommandOptions = Parameters<typeof executeCommand>[1];

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Minimal WASM test modules ---

/**
 * Minimal WASM module that imports proc_exit and calls it with exit code 42.
 * Equivalent WAT:
 *   (module
 *     (type (func (param i32)))
 *     (type (func))
 *     (import "wasi_snapshot_preview1" "proc_exit" (func (type 0)))
 *     (func (type 1) i32.const 42 call 0)
 *     (memory 1)
 *     (export "memory" (memory 0))
 *     (export "_start" (func 1))
 *   )
 */
const WASM_EXIT_42 = new Uint8Array([
  0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00, // header
  // Type section
  0x01, 0x08, 0x02,
  0x60, 0x01, 0x7F, 0x00, // (param i32) -> ()
  0x60, 0x00, 0x00,       // () -> ()
  // Import section
  0x02, 0x24, 0x01,
  0x16, // module name len 22
  0x77, 0x61, 0x73, 0x69, 0x5F, 0x73, 0x6E, 0x61, 0x70, 0x73, 0x68,
  0x6F, 0x74, 0x5F, 0x70, 0x72, 0x65, 0x76, 0x69, 0x65, 0x77, 0x31,
  0x09, // field name len 9
  0x70, 0x72, 0x6F, 0x63, 0x5F, 0x65, 0x78, 0x69, 0x74,
  0x00, 0x00, // func type 0
  // Function section
  0x03, 0x02, 0x01, 0x01,
  // Memory section
  0x05, 0x03, 0x01, 0x00, 0x01,
  // Export section
  0x07, 0x13, 0x02,
  0x06, 0x6D, 0x65, 0x6D, 0x6F, 0x72, 0x79, 0x02, 0x00, // "memory" memory 0
  0x06, 0x5F, 0x73, 0x74, 0x61, 0x72, 0x74, 0x00, 0x01, // "_start" func 1
  // Code section
  0x0A, 0x08, 0x01,
  0x06, // code entry size
  0x00, // 0 locals
  0x41, 0x2A, // i32.const 42
  0x10, 0x00, // call 0
  0x0B, // end
]);

/**
 * Minimal WASM module that calls proc_exit(0) — success case.
 * Same as WASM_EXIT_42 but with exit code 0.
 */
const WASM_EXIT_0 = new Uint8Array([
  0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x08, 0x02, 0x60, 0x01, 0x7F, 0x00, 0x60, 0x00, 0x00,
  0x02, 0x24, 0x01, 0x16,
  0x77, 0x61, 0x73, 0x69, 0x5F, 0x73, 0x6E, 0x61, 0x70, 0x73, 0x68,
  0x6F, 0x74, 0x5F, 0x70, 0x72, 0x65, 0x76, 0x69, 0x65, 0x77, 0x31,
  0x09, 0x70, 0x72, 0x6F, 0x63, 0x5F, 0x65, 0x78, 0x69, 0x74,
  0x00, 0x00,
  0x03, 0x02, 0x01, 0x01,
  0x05, 0x03, 0x01, 0x00, 0x01,
  0x07, 0x13, 0x02,
  0x06, 0x6D, 0x65, 0x6D, 0x6F, 0x72, 0x79, 0x02, 0x00,
  0x06, 0x5F, 0x73, 0x74, 0x61, 0x72, 0x74, 0x00, 0x01,
  0x0A, 0x08, 0x01, 0x06, 0x00,
  0x41, 0x00, // i32.const 0
  0x10, 0x00, 0x0B,
]);

/**
 * Minimal WASM module that traps (unreachable instruction).
 * WAT: (module (func (export "_start") unreachable) (memory (export "memory") 1))
 */
const WASM_TRAP = new Uint8Array([
  0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00,
  // Type section
  0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
  // Function section
  0x03, 0x02, 0x01, 0x00,
  // Memory section
  0x05, 0x03, 0x01, 0x00, 0x01,
  // Export section
  0x07, 0x13, 0x02,
  0x06, 0x6D, 0x65, 0x6D, 0x6F, 0x72, 0x79, 0x02, 0x00,
  0x06, 0x5F, 0x73, 0x74, 0x61, 0x72, 0x74, 0x00, 0x00,
  // Code section
  0x0A, 0x05, 0x01, 0x03, 0x00,
  0x00, // unreachable
  0x0B, // end
]);

/**
 * Minimal WASM module that writes "hello\n" to stdout (fd 1) then calls proc_exit(0).
 */
const WASM_HELLO_STDOUT = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x10, 0x03, 0x60, 0x04, 0x7f, 0x7f, 0x7f,
  0x7f, 0x01, 0x7f, 0x60, 0x01, 0x7f, 0x00, 0x60, 0x00, 0x00, 0x02, 0x46, 0x02, 0x16, 0x77, 0x61,
  0x73, 0x69, 0x5f, 0x73, 0x6e, 0x61, 0x70, 0x73, 0x68, 0x6f, 0x74, 0x5f, 0x70, 0x72, 0x65, 0x76,
  0x69, 0x65, 0x77, 0x31, 0x08, 0x66, 0x64, 0x5f, 0x77, 0x72, 0x69, 0x74, 0x65, 0x00, 0x00, 0x16,
  0x77, 0x61, 0x73, 0x69, 0x5f, 0x73, 0x6e, 0x61, 0x70, 0x73, 0x68, 0x6f, 0x74, 0x5f, 0x70, 0x72,
  0x65, 0x76, 0x69, 0x65, 0x77, 0x31, 0x09, 0x70, 0x72, 0x6f, 0x63, 0x5f, 0x65, 0x78, 0x69, 0x74,
  0x00, 0x01, 0x03, 0x02, 0x01, 0x02, 0x05, 0x03, 0x01, 0x00, 0x01, 0x07, 0x13, 0x02, 0x06, 0x6d,
  0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00, 0x06, 0x5f, 0x73, 0x74, 0x61, 0x72, 0x74, 0x00, 0x02,
  0x0a, 0x25, 0x01, 0x23, 0x00, 0x41, 0xe4, 0x00, 0x41, 0x00, 0x36, 0x02, 0x00, 0x41, 0xe8, 0x00,
  0x41, 0x06, 0x36, 0x02, 0x00, 0x41, 0x01, 0x41, 0xe4, 0x00, 0x41, 0x01, 0x41, 0xc8, 0x01, 0x10,
  0x00, 0x1a, 0x41, 0x00, 0x10, 0x01, 0x0b, 0x0b, 0x0c, 0x01, 0x00, 0x41, 0x00, 0x0b, 0x06, 0x68,
  0x65, 0x6c, 0x6c, 0x6f, 0x0a,
]);

/**
 * Minimal WASM module that writes "hello\n" to stdout and "err\n" to stderr,
 * then calls proc_exit(0).
 */
const WASM_HELLO_STDERR = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x10, 0x03, 0x60, 0x04, 0x7f, 0x7f, 0x7f,
  0x7f, 0x01, 0x7f, 0x60, 0x01, 0x7f, 0x00, 0x60, 0x00, 0x00, 0x02, 0x46, 0x02, 0x16, 0x77, 0x61,
  0x73, 0x69, 0x5f, 0x73, 0x6e, 0x61, 0x70, 0x73, 0x68, 0x6f, 0x74, 0x5f, 0x70, 0x72, 0x65, 0x76,
  0x69, 0x65, 0x77, 0x31, 0x08, 0x66, 0x64, 0x5f, 0x77, 0x72, 0x69, 0x74, 0x65, 0x00, 0x00, 0x16,
  0x77, 0x61, 0x73, 0x69, 0x5f, 0x73, 0x6e, 0x61, 0x70, 0x73, 0x68, 0x6f, 0x74, 0x5f, 0x70, 0x72,
  0x65, 0x76, 0x69, 0x65, 0x77, 0x31, 0x09, 0x70, 0x72, 0x6f, 0x63, 0x5f, 0x65, 0x78, 0x69, 0x74,
  0x00, 0x01, 0x03, 0x02, 0x01, 0x02, 0x05, 0x03, 0x01, 0x00, 0x01, 0x07, 0x13, 0x02, 0x06, 0x6d,
  0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00, 0x06, 0x5f, 0x73, 0x74, 0x61, 0x72, 0x74, 0x00, 0x02,
  0x0a, 0x42, 0x01, 0x40, 0x00, 0x41, 0xe4, 0x00, 0x41, 0x00, 0x36, 0x02, 0x00, 0x41, 0xe8, 0x00,
  0x41, 0x06, 0x36, 0x02, 0x00, 0x41, 0x01, 0x41, 0xe4, 0x00, 0x41, 0x01, 0x41, 0xc8, 0x01, 0x10,
  0x00, 0x1a, 0x41, 0xf8, 0x00, 0x41, 0x10, 0x36, 0x02, 0x00, 0x41, 0xfc, 0x00, 0x41, 0x04, 0x36,
  0x02, 0x00, 0x41, 0x02, 0x41, 0xf8, 0x00, 0x41, 0x01, 0x41, 0xc8, 0x01, 0x10, 0x00, 0x1a, 0x41,
  0x00, 0x10, 0x01, 0x0b, 0x0b, 0x15, 0x02, 0x00, 0x41, 0x00, 0x0b, 0x06, 0x68, 0x65, 0x6c, 0x6c,
  0x6f, 0x0a, 0x00, 0x41, 0x10, 0x0b, 0x04, 0x65, 0x72, 0x72, 0x0a,
]);

// --- VFS snapshot tests ---

describe('VFS snapshot', () => {
  test('snapshot() captures directories', () => {
    const vfs = new VFS();
    vfs.mkdir('/tmp/mydir');
    const snap = vfs.snapshot();
    const entry = snap.find(e => e.path === '/tmp/mydir');
    assert.ok(entry, 'should find /tmp/mydir in snapshot');
    assert.strictEqual(entry.type, 'dir');
  });

  test('snapshot() captures files with data', () => {
    const vfs = new VFS();
    vfs.writeFile('/tmp/test.txt', 'hello world');
    const snap = vfs.snapshot();
    const entry = snap.find(e => e.path === '/tmp/test.txt');
    assert.ok(entry, 'should find /tmp/test.txt in snapshot');
    assert.strictEqual(entry.type, 'file');
    assert.deepStrictEqual(entry.data, new TextEncoder().encode('hello world'));
  });

  test('snapshot() captures symlinks', () => {
    const vfs = new VFS();
    vfs.writeFile('/tmp/target.txt', 'content');
    vfs.symlink('/tmp/target.txt', '/tmp/link.txt');
    const snap = vfs.snapshot();
    const entry = snap.find(e => e.path === '/tmp/link.txt');
    assert.ok(entry, 'should find /tmp/link.txt in snapshot');
    assert.strictEqual(entry.type, 'symlink');
    assert.strictEqual(entry.target, '/tmp/target.txt');
  });

  test('snapshot() omits device nodes', () => {
    const vfs = new VFS();
    const snap = vfs.snapshot();
    const devNull = snap.find(e => e.path === '/dev/null');
    assert.strictEqual(devNull, undefined, 'should not include /dev/null');
  });

  test('snapshot() preserves file modes', () => {
    const vfs = new VFS();
    vfs.writeFile('/tmp/exec.sh', '#!/bin/sh');
    vfs.chmod('/tmp/exec.sh', 0o755);
    const snap = vfs.snapshot();
    const entry = snap.find(e => e.path === '/tmp/exec.sh');
    assert.strictEqual(entry!.mode, 0o755);
  });

  test('fromSnapshot() creates VFS with correct files', () => {
    const snap: VfsSnapshotEntry[] = [
      { type: 'dir', path: '/mydir', mode: 0o755 },
      { type: 'file', path: '/mydir/hello.txt', data: new TextEncoder().encode('hello'), mode: 0o644 },
    ];
    const vfs = VFS.fromSnapshot(snap);
    assert.ok(vfs.exists('/mydir'));
    assert.deepStrictEqual(vfs.readFile('/mydir/hello.txt'), new TextEncoder().encode('hello'));
  });

  test('fromSnapshot() creates VFS with symlinks', () => {
    const snap: VfsSnapshotEntry[] = [
      { type: 'file', path: '/tmp/real.txt', data: new TextEncoder().encode('data') },
      { type: 'symlink', path: '/tmp/alias.txt', target: '/tmp/real.txt' },
    ];
    const vfs = VFS.fromSnapshot(snap);
    assert.ok(vfs.exists('/tmp/alias.txt'));
    assert.deepStrictEqual(vfs.readFile('/tmp/alias.txt'), new TextEncoder().encode('data'));
  });

  test('fromSnapshot(null) returns default VFS', () => {
    const vfs = VFS.fromSnapshot(null as unknown as VfsSnapshotEntry[]);
    assert.ok(vfs.exists('/bin'));
    assert.ok(vfs.exists('/tmp'));
    assert.ok(vfs.exists('/home/user'));
  });

  test('snapshot → fromSnapshot roundtrip preserves data', () => {
    const vfs1 = new VFS();
    vfs1.writeFile('/tmp/a.txt', 'alpha');
    vfs1.writeFile('/tmp/b.txt', 'beta');
    vfs1.mkdir('/tmp/sub');
    vfs1.writeFile('/tmp/sub/c.txt', 'gamma');
    vfs1.symlink('/tmp/a.txt', '/tmp/link-a');

    const snap = vfs1.snapshot();
    const vfs2 = VFS.fromSnapshot(snap);

    assert.deepStrictEqual(vfs2.readFile('/tmp/a.txt'), new TextEncoder().encode('alpha'));
    assert.deepStrictEqual(vfs2.readFile('/tmp/b.txt'), new TextEncoder().encode('beta'));
    assert.deepStrictEqual(vfs2.readFile('/tmp/sub/c.txt'), new TextEncoder().encode('gamma'));
    assert.deepStrictEqual(vfs2.readFile('/tmp/link-a'), new TextEncoder().encode('alpha'));
    assert.ok(vfs2.exists('/dev/null'), 'dev nodes should be recreated');
  });
});

// --- executeCommand tests ---

describe('executeCommand', () => {
  test('handles proc_exit with non-zero exit code', async () => {
    const module = await WebAssembly.compile(WASM_EXIT_42);
    const result = await executeCommand(module, { command: 'test', wasmModule: module } as CommandOptions);
    assert.strictEqual(result.exitCode, 42);
    assert.ok(result.stdout instanceof Uint8Array);
    assert.ok(result.stderr instanceof Uint8Array);
    assert.ok(Array.isArray(result.vfsChanges));
  });

  test('handles proc_exit with exit code 0', async () => {
    const module = await WebAssembly.compile(WASM_EXIT_0);
    const result = await executeCommand(module, { command: 'test', wasmModule: module } as CommandOptions);
    assert.strictEqual(result.exitCode, 0);
  });

  test('handles WASM trap as exit code 128', async () => {
    const module = await WebAssembly.compile(WASM_TRAP);
    const result = await executeCommand(module, { command: 'test', wasmModule: module } as CommandOptions);
    assert.strictEqual(result.exitCode, 128);
  });

  test('accepts VFS snapshot and returns vfsChanges', async () => {
    const module = await WebAssembly.compile(WASM_EXIT_0);
    const snapshot: VfsSnapshotEntry[] = [
      { type: 'file', path: '/tmp/input.txt', data: new TextEncoder().encode('data') },
    ];
    const result = await executeCommand(module, {
      command: 'test',
      wasmModule: module,
      vfsSnapshot: snapshot,
    } as CommandOptions);
    // The VFS should contain our pre-populated file
    const fileEntry = result.vfsChanges.find(e => e.path === '/tmp/input.txt');
    assert.ok(fileEntry, 'VFS changes should include pre-populated file');
    assert.deepStrictEqual(fileEntry.data, new TextEncoder().encode('data'));
  });

  test('provides host_process and host_user stub imports', async () => {
    // The WASM_EXIT_0 module doesn't import these, but the import object
    // should still contain them (extra imports are silently ignored)
    const module = await WebAssembly.compile(WASM_EXIT_0);
    const result = await executeCommand(module, { command: 'test', wasmModule: module } as CommandOptions);
    assert.strictEqual(result.exitCode, 0);
  });

  test('accepts env and args options', async () => {
    const module = await WebAssembly.compile(WASM_EXIT_0);
    const result = await executeCommand(module, {
      command: 'echo',
      wasmModule: module,
      args: ['hello', 'world'],
      env: { HOME: '/home/user', PATH: '/bin' },
    } as CommandOptions);
    assert.strictEqual(result.exitCode, 0);
  });

  test('accepts stdin data', async () => {
    const module = await WebAssembly.compile(WASM_EXIT_0);
    const result = await executeCommand(module, {
      command: 'test',
      wasmModule: module,
      stdin: 'input data',
    } as CommandOptions);
    assert.strictEqual(result.exitCode, 0);
  });
});

// --- Worker integration tests ---

interface WorkerResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
  vfsChanges: VfsSnapshotEntry[];
}

describe('worker message handling', () => {
  test('worker responds with result via WorkerAdapter', async () => {
    const module = await WebAssembly.compile(WASM_EXIT_42);
    const adapter = new WorkerAdapter();
    const workerPath = join(__dirname, '..', 'src', 'worker-entry.ts');
    const worker = await adapter.spawn(workerPath);

    try {
      const result = await new Promise<WorkerResult>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('worker timeout')), 5000);
        worker.onMessage((data) => {
          clearTimeout(timer);
          resolve(data as WorkerResult);
        });
        worker.onError((err) => {
          clearTimeout(timer);
          reject(err);
        });
        worker.postMessage({
          wasmModule: module,
          command: 'test',
          args: [],
          env: {},
          cwd: '/',
          stdin: null,
          vfsSnapshot: null,
        });
      });

      assert.strictEqual(result.exitCode, 42);
      assert.ok(result.stdout instanceof Uint8Array);
      assert.ok(result.stderr instanceof Uint8Array);
      assert.ok(Array.isArray(result.vfsChanges));
    } finally {
      worker.terminate();
    }
  });

  test('worker handles success (exit code 0)', async () => {
    const module = await WebAssembly.compile(WASM_EXIT_0);
    const adapter = new WorkerAdapter();
    const workerPath = join(__dirname, '..', 'src', 'worker-entry.ts');
    const worker = await adapter.spawn(workerPath);

    try {
      const result = await new Promise<WorkerResult>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('worker timeout')), 5000);
        worker.onMessage((data) => {
          clearTimeout(timer);
          resolve(data as WorkerResult);
        });
        worker.onError((err) => {
          clearTimeout(timer);
          reject(err);
        });
        worker.postMessage({
          wasmModule: module,
          command: 'test',
          args: [],
          env: {},
          cwd: '/',
          stdin: null,
          vfsSnapshot: null,
        });
      });

      assert.strictEqual(result.exitCode, 0);
    } finally {
      worker.terminate();
    }
  });

  test('worker handles VFS snapshot passthrough', async () => {
    const module = await WebAssembly.compile(WASM_EXIT_0);
    const adapter = new WorkerAdapter();
    const workerPath = join(__dirname, '..', 'src', 'worker-entry.ts');
    const worker = await adapter.spawn(workerPath);

    try {
      const result = await new Promise<WorkerResult>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('worker timeout')), 5000);
        worker.onMessage((data) => {
          clearTimeout(timer);
          resolve(data as WorkerResult);
        });
        worker.onError((err) => {
          clearTimeout(timer);
          reject(err);
        });
        worker.postMessage({
          wasmModule: module,
          command: 'test',
          args: [],
          env: {},
          cwd: '/',
          stdin: null,
          vfsSnapshot: [
            { type: 'file', path: '/tmp/preload.txt', data: new TextEncoder().encode('preloaded') },
          ],
        });
      });

      assert.strictEqual(result.exitCode, 0);
      const fileEntry = result.vfsChanges.find(e => e.path === '/tmp/preload.txt');
      assert.ok(fileEntry, 'vfsChanges should include preloaded file');
    } finally {
      worker.terminate();
    }
  });
});

// --- Streaming mode tests ---

describe('streaming mode', () => {
  test('streaming mode delivers stdout chunks as they are written', async () => {
    const module = await WebAssembly.compile(WASM_HELLO_STDOUT);
    const messages: { type: string; data?: Uint8Array }[] = [];
    const streamCallback: StreamCallback = (msg) => {
      messages.push(msg as { type: string; data?: Uint8Array });
    };
    const result = await executeCommand(module, {
      command: 'echo',
      wasmModule: module,
      streaming: true,
    } as CommandOptions, streamCallback);

    // Should have received at least one stdout message via the callback
    const stdoutMsgs = messages.filter(m => m.type === 'stdout');
    assert.ok(stdoutMsgs.length > 0, 'should receive stdout messages via stream callback');

    // Verify the combined stdout data is "hello\n"
    const combined = new Uint8Array(stdoutMsgs.reduce((n, m) => n + m.data!.length, 0));
    let offset = 0;
    for (const m of stdoutMsgs) {
      combined.set(m.data!, offset);
      offset += m.data!.length;
    }
    assert.deepStrictEqual(combined, new TextEncoder().encode('hello\n'));

    // The result's stdout should be empty since streaming mode bypasses buffering
    assert.strictEqual(result.stdout.length, 0, 'buffered stdout should be empty in streaming mode');
    assert.strictEqual(result.exitCode, 0);
  });

  test('streaming mode delivers stderr chunks as they are written', async () => {
    const module = await WebAssembly.compile(WASM_HELLO_STDERR);
    const messages: { type: string; data?: Uint8Array }[] = [];
    const streamCallback: StreamCallback = (msg) => {
      messages.push(msg as { type: string; data?: Uint8Array });
    };
    const result = await executeCommand(module, {
      command: 'test',
      wasmModule: module,
      streaming: true,
    } as CommandOptions, streamCallback);

    const stdoutMsgs = messages.filter(m => m.type === 'stdout');
    const stderrMsgs = messages.filter(m => m.type === 'stderr');

    assert.ok(stdoutMsgs.length > 0, 'should receive stdout messages');
    assert.ok(stderrMsgs.length > 0, 'should receive stderr messages');

    // Verify stdout data
    const stdoutData = new Uint8Array(stdoutMsgs.reduce((n, m) => n + m.data!.length, 0));
    let off = 0;
    for (const m of stdoutMsgs) { stdoutData.set(m.data!, off); off += m.data!.length; }
    assert.deepStrictEqual(stdoutData, new TextEncoder().encode('hello\n'));

    // Verify stderr data
    const stderrData = new Uint8Array(stderrMsgs.reduce((n, m) => n + m.data!.length, 0));
    off = 0;
    for (const m of stderrMsgs) { stderrData.set(m.data!, off); off += m.data!.length; }
    assert.deepStrictEqual(stderrData, new TextEncoder().encode('err\n'));

    // Buffered output should be empty since streaming bypasses it
    assert.strictEqual(result.stdout.length, 0);
    assert.strictEqual(result.stderr.length, 0);
    assert.strictEqual(result.exitCode, 0);
  });

  test('non-streaming mode still buffers as before', async () => {
    const module = await WebAssembly.compile(WASM_HELLO_STDOUT);
    // No streaming flag, no streamCallback
    const result = await executeCommand(module, {
      command: 'echo',
      wasmModule: module,
    } as CommandOptions);

    // stdout should be buffered in the result
    assert.deepStrictEqual(result.stdout, new TextEncoder().encode('hello\n'));
    assert.strictEqual(result.exitCode, 0);
  });
});

// --- WASM cat module (reads stdin loop, writes to stdout) ---

/**
 * Minimal WASM module that reads from stdin (fd 0) in a loop and writes
 * each chunk to stdout (fd 1), then exits on EOF.
 * Equivalent WAT:
 *   (module
 *     (import "wasi_snapshot_preview1" "fd_read" (func (param i32 i32 i32 i32) (result i32)))
 *     (import "wasi_snapshot_preview1" "fd_write" (func (param i32 i32 i32 i32) (result i32)))
 *     (import "wasi_snapshot_preview1" "proc_exit" (func (param i32)))
 *     (memory (export "memory") 1)
 *     (func (export "_start") (local $nread i32)
 *       (block $done (loop $loop
 *         ;; setup read iov: buf=256, len=1024
 *         (i32.store (i32.const 0) (i32.const 256))
 *         (i32.store (i32.const 4) (i32.const 1024))
 *         ;; fd_read(0, iovs=0, 1, nread=8)
 *         (drop (call $fd_read (i32.const 0) (i32.const 0) (i32.const 1) (i32.const 8)))
 *         ;; if nread == 0, break
 *         (br_if $done (i32.eqz (local.tee $nread (i32.load (i32.const 8)))))
 *         ;; setup write iov: buf=256, len=nread
 *         (i32.store (i32.const 16) (i32.const 256))
 *         (i32.store (i32.const 20) (local.get $nread))
 *         ;; fd_write(1, iovs=16, 1, nwritten=24)
 *         (drop (call $fd_write (i32.const 1) (i32.const 16) (i32.const 1) (i32.const 24)))
 *         (br $loop)))
 *       (call $proc_exit (i32.const 0))))
 */
const WASM_CAT = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x10, 0x03, 0x60, 0x04, 0x7f, 0x7f, 0x7f, 0x7f, 0x01, 0x7f, 0x60, 0x01, 0x7f, 0x00, 0x60, 0x00, 0x00,
  0x02, 0x67, 0x03,
  0x16, 0x77, 0x61, 0x73, 0x69, 0x5f, 0x73, 0x6e, 0x61, 0x70, 0x73, 0x68, 0x6f, 0x74, 0x5f, 0x70, 0x72, 0x65, 0x76, 0x69, 0x65, 0x77, 0x31,
  0x07, 0x66, 0x64, 0x5f, 0x72, 0x65, 0x61, 0x64, 0x00, 0x00,
  0x16, 0x77, 0x61, 0x73, 0x69, 0x5f, 0x73, 0x6e, 0x61, 0x70, 0x73, 0x68, 0x6f, 0x74, 0x5f, 0x70, 0x72, 0x65, 0x76, 0x69, 0x65, 0x77, 0x31,
  0x08, 0x66, 0x64, 0x5f, 0x77, 0x72, 0x69, 0x74, 0x65, 0x00, 0x00,
  0x16, 0x77, 0x61, 0x73, 0x69, 0x5f, 0x73, 0x6e, 0x61, 0x70, 0x73, 0x68, 0x6f, 0x74, 0x5f, 0x70, 0x72, 0x65, 0x76, 0x69, 0x65, 0x77, 0x31,
  0x09, 0x70, 0x72, 0x6f, 0x63, 0x5f, 0x65, 0x78, 0x69, 0x74, 0x00, 0x01,
  0x03, 0x02, 0x01, 0x02,
  0x05, 0x03, 0x01, 0x00, 0x01,
  0x07, 0x13, 0x02, 0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00, 0x06, 0x5f, 0x73, 0x74, 0x61, 0x72, 0x74, 0x00, 0x03,
  0x0a, 0x51, 0x01, 0x4f, 0x01, 0x01, 0x7f, 0x02, 0x40, 0x03, 0x40,
  0x41, 0x00, 0x41, 0x80, 0x02, 0x36, 0x02, 0x00,
  0x41, 0x04, 0x41, 0x80, 0x08, 0x36, 0x02, 0x00,
  0x41, 0x00, 0x41, 0x00, 0x41, 0x01, 0x41, 0x08, 0x10, 0x00, 0x1a,
  0x41, 0x08, 0x28, 0x02, 0x00, 0x22, 0x00, 0x45, 0x0d, 0x01,
  0x41, 0x10, 0x41, 0x80, 0x02, 0x36, 0x02, 0x00,
  0x41, 0x14, 0x20, 0x00, 0x36, 0x02, 0x00,
  0x41, 0x01, 0x41, 0x10, 0x41, 0x01, 0x41, 0x18, 0x10, 0x01, 0x1a,
  0x0c, 0x00, 0x0b, 0x0b, 0x41, 0x00, 0x10, 0x02, 0x0b,
]);

// --- Streaming stdin tests ---

describe('streaming stdin via ring buffer', () => {
  test('write data to stdin ring buffer while Worker is blocked on fd_read', async () => {
    const module = await WebAssembly.compile(WASM_CAT);
    const stdinSab = createRingBuffer(1024);
    const stdinWriter = new RingBufferWriter(stdinSab);

    const adapter = new WorkerAdapter();
    const workerPath = join(__dirname, '..', 'src', 'worker-entry.ts');
    const worker = await adapter.spawn(workerPath);

    try {
      const stdoutChunks: Uint8Array[] = [];
      const exitPromise = new Promise<{ exitCode: number }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('worker timeout')), 10000);
        worker.onMessage((data: unknown) => {
          const msg = data as { type?: string; data?: Uint8Array; exitCode?: number };
          if (msg.type === 'stdout' && msg.data) {
            stdoutChunks.push(msg.data);
          } else if (msg.type === 'exit') {
            clearTimeout(timer);
            resolve({ exitCode: msg.exitCode ?? 1 });
          }
        });
        worker.onError((err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      // Send command — Worker will block on fd_read waiting for stdin data
      worker.postMessage({
        wasmModule: module,
        command: 'cat',
        args: [],
        env: {},
        cwd: '/',
        stdin: null,
        stdinBuffer: stdinSab,
        streaming: true,
      });

      // Give Worker time to start and block on fd_read
      await new Promise(r => setTimeout(r, 200));

      // Write data to stdin ring buffer — this wakes the Worker
      stdinWriter.write(new TextEncoder().encode('hello from ring buffer'));
      stdinWriter.close();

      const result = await exitPromise;
      assert.strictEqual(result.exitCode, 0);

      // Combine stdout chunks
      const totalLen = stdoutChunks.reduce((n, c) => n + c.length, 0);
      const combined = new Uint8Array(totalLen);
      let offset = 0;
      for (const chunk of stdoutChunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }
      assert.strictEqual(new TextDecoder().decode(combined), 'hello from ring buffer');
    } finally {
      worker.terminate();
    }
  });

  test('close stdin ring buffer delivers EOF', async () => {
    const module = await WebAssembly.compile(WASM_CAT);
    const stdinSab = createRingBuffer(1024);
    const stdinWriter = new RingBufferWriter(stdinSab);

    const adapter = new WorkerAdapter();
    const workerPath = join(__dirname, '..', 'src', 'worker-entry.ts');
    const worker = await adapter.spawn(workerPath);

    try {
      const stdoutChunks: Uint8Array[] = [];
      const exitPromise = new Promise<{ exitCode: number }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('worker timeout')), 10000);
        worker.onMessage((data: unknown) => {
          const msg = data as { type?: string; data?: Uint8Array; exitCode?: number };
          if (msg.type === 'stdout' && msg.data) {
            stdoutChunks.push(msg.data);
          } else if (msg.type === 'exit') {
            clearTimeout(timer);
            resolve({ exitCode: msg.exitCode ?? 1 });
          }
        });
        worker.onError((err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      // Send command — Worker will block on fd_read
      worker.postMessage({
        wasmModule: module,
        command: 'cat',
        args: [],
        env: {},
        cwd: '/',
        stdin: null,
        stdinBuffer: stdinSab,
        streaming: true,
      });

      // Close stdin immediately — signals EOF
      stdinWriter.close();

      const result = await exitPromise;
      assert.strictEqual(result.exitCode, 0);

      // No data was written, so stdout should be empty
      const totalLen = stdoutChunks.reduce((n, c) => n + c.length, 0);
      assert.strictEqual(totalLen, 0, 'stdout should be empty when stdin is closed immediately');
    } finally {
      worker.terminate();
    }
  });
});
