import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { FDTable, FILETYPE_REGULAR_FILE, FILETYPE_DIRECTORY, FILETYPE_CHARACTER_DEVICE,
  FDFLAG_APPEND, ERRNO_SUCCESS, ERRNO_EBADF, ERRNO_EINVAL,
  RIGHT_FD_READ, RIGHT_FD_WRITE, RIGHT_FD_SEEK, RIGHT_FD_TELL,
  RIGHT_FD_FDSTAT_SET_FLAGS } from '../src/fd-table.ts';
import { VFS } from '../src/vfs.ts';
import { WasiPolyfill, ERRNO_ESPIPE, ERRNO_EISDIR } from '../src/wasi-polyfill.ts';

// --- Test helpers ---

interface MockMemory {
  buffer: ArrayBuffer;
}

function createMockMemory(size = 65536): MockMemory {
  return { buffer: new ArrayBuffer(size) };
}

/** Write iovec structs into memory at ptr. Each iov = { buf, buf_len }. */
function writeIovecs(memory: MockMemory, ptr: number, iovecs: { buf: number; buf_len: number }[]): void {
  const view = new DataView(memory.buffer);
  for (let i = 0; i < iovecs.length; i++) {
    view.setUint32(ptr + i * 8, iovecs[i].buf, true);
    view.setUint32(ptr + i * 8 + 4, iovecs[i].buf_len, true);
  }
}

/** Write a string into memory at ptr, return the bytes written. */
function writeString(memory: MockMemory, ptr: number, str: string): number {
  const encoded = new TextEncoder().encode(str);
  new Uint8Array(memory.buffer).set(encoded, ptr);
  return encoded.length;
}

/** Read a string from memory at ptr with given length. */
function readString(memory: MockMemory, ptr: number, len: number): string {
  const bytes = new Uint8Array(memory.buffer, ptr, len);
  return new TextDecoder().decode(bytes);
}

/** Read u32 from memory at ptr (little-endian). */
function readU32(memory: MockMemory, ptr: number): number {
  return new DataView(memory.buffer).getUint32(ptr, true);
}

/** Read u64 from memory at ptr (little-endian) as BigInt. */
function readU64(memory: MockMemory, ptr: number): bigint {
  return new DataView(memory.buffer).getBigUint64(ptr, true);
}

/** Create a standard test setup with FDTable, VFS, memory, and WasiPolyfill. */
function createTestSetup(options: Record<string, unknown> = {}) {
  const fdTable = new FDTable();
  const vfs = new VFS();
  const memory = createMockMemory();
  const wasi = new WasiPolyfill(fdTable, vfs, { memory, ...options });
  return { fdTable, vfs, memory, wasi };
}

/** Open a VFS file as an fd in the fdTable, returning the fd number. */
function openVfsFile(fdTable: FDTable, vfs: VFS, path: string, opts: Record<string, unknown> = {}): number {
  const ino = vfs.getIno(path);
  if (ino === null) throw new Error(`File not found: ${path}`);
  return fdTable.open(
    { type: 'vfsFile', ino, path },
    {
      filetype: FILETYPE_REGULAR_FILE,
      path,
      ...opts,
    }
  );
}

// --- Tests ---

describe('WasiPolyfill', () => {

  describe('constructor', () => {
    it('creates with default options', () => {
      const { wasi } = createTestSetup();
      assert.deepStrictEqual(wasi.args, []);
      assert.deepStrictEqual(wasi.env, {});
      assert.strictEqual(wasi.exitCode, null);
    });

    it('accepts args and env', () => {
      const { wasi } = createTestSetup({
        args: ['echo', 'hello'],
        env: { HOME: '/home/user' },
      });
      assert.deepStrictEqual(wasi.args, ['echo', 'hello']);
      assert.strictEqual(wasi.env.HOME, '/home/user');
    });

    it('pre-opens root directory at fd 3', () => {
      const { wasi } = createTestSetup();
      const preopens = (wasi as unknown as Record<string, unknown>)._preopens as Map<number, string>;
      assert.strictEqual(preopens.size, 1);
      assert.strictEqual(preopens.get(3), '/');
    });

    it('accepts string stdin', () => {
      const { wasi } = createTestSetup({ stdin: 'hello' });
      const stdinData = (wasi as unknown as Record<string, unknown>)._stdinData as Uint8Array | null;
      assert.ok(stdinData instanceof Uint8Array);
      assert.strictEqual(new TextDecoder().decode(stdinData), 'hello');
    });

    it('accepts Uint8Array stdin', () => {
      const data = new TextEncoder().encode('world');
      const { wasi } = createTestSetup({ stdin: data });
      const stdinData = (wasi as unknown as Record<string, unknown>)._stdinData as Uint8Array | null;
      assert.strictEqual(new TextDecoder().decode(stdinData!), 'world');
    });
  });

  describe('setMemory', () => {
    it('sets memory reference', () => {
      const fdTable = new FDTable();
      const vfs = new VFS();
      const wasi = new WasiPolyfill(fdTable, vfs);
      assert.strictEqual(wasi.memory, null);
      const mem = createMockMemory();
      wasi.setMemory(mem as WebAssembly.Memory);
      assert.strictEqual(wasi.memory, mem);
    });
  });

  describe('fd_write', () => {
    it('writes to stdout and collects output', () => {
      const { wasi, memory } = createTestSetup();
      // Write "hello" at memory offset 256
      const len = writeString(memory, 256, 'hello');
      // Set up iovec at offset 0: { buf: 256, buf_len: 5 }
      writeIovecs(memory, 0, [{ buf: 256, buf_len: len }]);
      // nwritten at offset 100
      const errno = wasi.fd_write(1, 0, 1, 100);
      assert.strictEqual(errno, ERRNO_SUCCESS);
      assert.strictEqual(readU32(memory, 100), 5);
      assert.strictEqual(wasi.stdoutString, 'hello');
    });

    it('writes to stderr and collects output', () => {
      const { wasi, memory } = createTestSetup();
      writeString(memory, 256, 'error!');
      writeIovecs(memory, 0, [{ buf: 256, buf_len: 6 }]);
      const errno = wasi.fd_write(2, 0, 1, 100);
      assert.strictEqual(errno, ERRNO_SUCCESS);
      assert.strictEqual(readU32(memory, 100), 6);
      assert.strictEqual(wasi.stderrString, 'error!');
    });

    it('writes multiple iovecs to stdout', () => {
      const { wasi, memory } = createTestSetup();
      writeString(memory, 256, 'hello');
      writeString(memory, 300, ' world');
      writeIovecs(memory, 0, [
        { buf: 256, buf_len: 5 },
        { buf: 300, buf_len: 6 },
      ]);
      const errno = wasi.fd_write(1, 0, 2, 100);
      assert.strictEqual(errno, ERRNO_SUCCESS);
      assert.strictEqual(readU32(memory, 100), 11);
      assert.strictEqual(wasi.stdoutString, 'hello world');
    });

    it('returns EBADF for invalid fd', () => {
      const { wasi, memory } = createTestSetup();
      writeIovecs(memory, 0, [{ buf: 256, buf_len: 5 }]);
      const errno = wasi.fd_write(99, 0, 1, 100);
      assert.strictEqual(errno, ERRNO_EBADF);
    });

    it('writes to VFS file', () => {
      const { wasi, memory, vfs, fdTable } = createTestSetup();
      vfs.writeFile('/tmp/test.txt', '');
      const fd = openVfsFile(fdTable, vfs, '/tmp/test.txt');

      writeString(memory, 256, 'file content');
      writeIovecs(memory, 0, [{ buf: 256, buf_len: 12 }]);
      const errno = wasi.fd_write(fd, 0, 1, 100);
      assert.strictEqual(errno, ERRNO_SUCCESS);
      assert.strictEqual(readU32(memory, 100), 12);

      const content = new TextDecoder().decode(vfs.readFile('/tmp/test.txt'));
      assert.strictEqual(content, 'file content');
    });

    it('writes to VFS file at cursor position', () => {
      const { wasi, memory, vfs, fdTable } = createTestSetup();
      vfs.writeFile('/tmp/test.txt', 'AAAAAAAAAA'); // 10 A's
      const fd = openVfsFile(fdTable, vfs, '/tmp/test.txt');

      // Seek to position 5
      fdTable.get(fd)!.cursor = 5n;

      writeString(memory, 256, 'BB');
      writeIovecs(memory, 0, [{ buf: 256, buf_len: 2 }]);
      const errno = wasi.fd_write(fd, 0, 1, 100);
      assert.strictEqual(errno, ERRNO_SUCCESS);

      const content = new TextDecoder().decode(vfs.readFile('/tmp/test.txt'));
      assert.strictEqual(content, 'AAAAABBAAA');
    });

    it('appends to VFS file with FDFLAG_APPEND', () => {
      const { wasi, memory, vfs, fdTable } = createTestSetup();
      vfs.writeFile('/tmp/test.txt', 'hello');
      const fd = openVfsFile(fdTable, vfs, '/tmp/test.txt', { fdflags: FDFLAG_APPEND });

      writeString(memory, 256, ' world');
      writeIovecs(memory, 0, [{ buf: 256, buf_len: 6 }]);
      const errno = wasi.fd_write(fd, 0, 1, 100);
      assert.strictEqual(errno, ERRNO_SUCCESS);

      const content = new TextDecoder().decode(vfs.readFile('/tmp/test.txt'));
      assert.strictEqual(content, 'hello world');
    });

    it('extends VFS file when writing past end', () => {
      const { wasi, memory, vfs, fdTable } = createTestSetup();
      vfs.writeFile('/tmp/test.txt', 'AB');
      const fd = openVfsFile(fdTable, vfs, '/tmp/test.txt');

      // Seek past end
      fdTable.get(fd)!.cursor = 5n;

      writeString(memory, 256, 'CD');
      writeIovecs(memory, 0, [{ buf: 256, buf_len: 2 }]);
      wasi.fd_write(fd, 0, 1, 100);

      const data = vfs.readFile('/tmp/test.txt');
      assert.strictEqual(data.length, 7); // 5 + 2
      assert.strictEqual(data[0], 65); // 'A'
      assert.strictEqual(data[1], 66); // 'B'
      assert.strictEqual(data[2], 0);  // zero-fill
      assert.strictEqual(data[3], 0);
      assert.strictEqual(data[4], 0);
      assert.strictEqual(data[5], 67); // 'C'
      assert.strictEqual(data[6], 68); // 'D'
    });

    it('discards writes to /dev/null', () => {
      const { wasi, memory, vfs, fdTable } = createTestSetup();
      const ino = vfs.getIno('/dev/null')!;
      const fd = fdTable.open(
        { type: 'vfsFile', ino, path: '/dev/null' },
        { filetype: FILETYPE_REGULAR_FILE }
      );

      writeString(memory, 256, 'discard me');
      writeIovecs(memory, 0, [{ buf: 256, buf_len: 10 }]);
      const errno = wasi.fd_write(fd, 0, 1, 100);
      assert.strictEqual(errno, ERRNO_SUCCESS);
      assert.strictEqual(readU32(memory, 100), 10);
    });
  });

  describe('fd_read', () => {
    it('reads from stdin buffer', () => {
      const { wasi, memory } = createTestSetup({ stdin: 'hello' });
      // iovec at offset 0 pointing to buffer at offset 256, length 10
      writeIovecs(memory, 0, [{ buf: 256, buf_len: 10 }]);
      // nread at offset 100
      const errno = wasi.fd_read(0, 0, 1, 100);
      assert.strictEqual(errno, ERRNO_SUCCESS);
      assert.strictEqual(readU32(memory, 100), 5);
      assert.strictEqual(readString(memory, 256, 5), 'hello');
    });

    it('reads stdin in chunks across multiple calls', () => {
      const { wasi, memory } = createTestSetup({ stdin: 'abcdef' });
      // Read 3 bytes first
      writeIovecs(memory, 0, [{ buf: 256, buf_len: 3 }]);
      wasi.fd_read(0, 0, 1, 100);
      assert.strictEqual(readU32(memory, 100), 3);
      assert.strictEqual(readString(memory, 256, 3), 'abc');

      // Read remaining
      writeIovecs(memory, 0, [{ buf: 256, buf_len: 10 }]);
      wasi.fd_read(0, 0, 1, 100);
      assert.strictEqual(readU32(memory, 100), 3);
      assert.strictEqual(readString(memory, 256, 3), 'def');
    });

    it('returns 0 bytes at stdin EOF', () => {
      const { wasi, memory } = createTestSetup();
      writeIovecs(memory, 0, [{ buf: 256, buf_len: 10 }]);
      const errno = wasi.fd_read(0, 0, 1, 100);
      assert.strictEqual(errno, ERRNO_SUCCESS);
      assert.strictEqual(readU32(memory, 100), 0);
    });

    it('reads from VFS file', () => {
      const { wasi, memory, vfs, fdTable } = createTestSetup();
      vfs.writeFile('/tmp/test.txt', 'file data here');
      const fd = openVfsFile(fdTable, vfs, '/tmp/test.txt');

      writeIovecs(memory, 0, [{ buf: 256, buf_len: 20 }]);
      const errno = wasi.fd_read(fd, 0, 1, 100);
      assert.strictEqual(errno, ERRNO_SUCCESS);
      assert.strictEqual(readU32(memory, 100), 14);
      assert.strictEqual(readString(memory, 256, 14), 'file data here');
    });

    it('reads VFS file with cursor advancement', () => {
      const { wasi, memory, vfs, fdTable } = createTestSetup();
      vfs.writeFile('/tmp/test.txt', 'ABCDEF');
      const fd = openVfsFile(fdTable, vfs, '/tmp/test.txt');

      // Read 3 bytes
      writeIovecs(memory, 0, [{ buf: 256, buf_len: 3 }]);
      wasi.fd_read(fd, 0, 1, 100);
      assert.strictEqual(readU32(memory, 100), 3);
      assert.strictEqual(readString(memory, 256, 3), 'ABC');

      // Read next 3 bytes
      writeIovecs(memory, 0, [{ buf: 256, buf_len: 3 }]);
      wasi.fd_read(fd, 0, 1, 100);
      assert.strictEqual(readU32(memory, 100), 3);
      assert.strictEqual(readString(memory, 256, 3), 'DEF');

      // Read at EOF
      writeIovecs(memory, 0, [{ buf: 256, buf_len: 10 }]);
      wasi.fd_read(fd, 0, 1, 100);
      assert.strictEqual(readU32(memory, 100), 0);
    });

    it('reads with multiple iovecs', () => {
      const { wasi, memory, vfs, fdTable } = createTestSetup();
      vfs.writeFile('/tmp/test.txt', 'ABCDEFGHIJ');
      const fd = openVfsFile(fdTable, vfs, '/tmp/test.txt');

      writeIovecs(memory, 0, [
        { buf: 256, buf_len: 3 },
        { buf: 300, buf_len: 4 },
      ]);
      const errno = wasi.fd_read(fd, 0, 2, 100);
      assert.strictEqual(errno, ERRNO_SUCCESS);
      assert.strictEqual(readU32(memory, 100), 7);
      assert.strictEqual(readString(memory, 256, 3), 'ABC');
      assert.strictEqual(readString(memory, 300, 4), 'DEFG');
    });

    it('returns EBADF for invalid fd', () => {
      const { wasi, memory } = createTestSetup();
      writeIovecs(memory, 0, [{ buf: 256, buf_len: 5 }]);
      const errno = wasi.fd_read(99, 0, 1, 100);
      assert.strictEqual(errno, ERRNO_EBADF);
    });

    it('returns 0 for /dev/null read', () => {
      const { wasi, memory, vfs, fdTable } = createTestSetup();
      const ino = vfs.getIno('/dev/null')!;
      const fd = fdTable.open(
        { type: 'vfsFile', ino, path: '/dev/null' },
        { filetype: FILETYPE_REGULAR_FILE }
      );

      writeIovecs(memory, 0, [{ buf: 256, buf_len: 10 }]);
      const errno = wasi.fd_read(fd, 0, 1, 100);
      assert.strictEqual(errno, ERRNO_SUCCESS);
      assert.strictEqual(readU32(memory, 100), 0);
    });
  });

  describe('fd_seek', () => {
    it('seeks to absolute position (WHENCE_SET)', () => {
      const { wasi, memory, vfs, fdTable } = createTestSetup();
      vfs.writeFile('/tmp/test.txt', 'ABCDEFGHIJ');
      const fd = openVfsFile(fdTable, vfs, '/tmp/test.txt');

      const errno = wasi.fd_seek(fd, 5n, 0, 200);
      assert.strictEqual(errno, ERRNO_SUCCESS);
      assert.strictEqual(readU64(memory, 200), 5n);
      assert.strictEqual(fdTable.get(fd)!.cursor, 5n);
    });

    it('seeks relative to current position (WHENCE_CUR)', () => {
      const { wasi, memory, vfs, fdTable } = createTestSetup();
      vfs.writeFile('/tmp/test.txt', 'ABCDEFGHIJ');
      const fd = openVfsFile(fdTable, vfs, '/tmp/test.txt');
      fdTable.get(fd)!.cursor = 3n;

      const errno = wasi.fd_seek(fd, 4n, 1, 200);
      assert.strictEqual(errno, ERRNO_SUCCESS);
      assert.strictEqual(readU64(memory, 200), 7n);
    });

    it('seeks relative to end (WHENCE_END)', () => {
      const { wasi, memory, vfs, fdTable } = createTestSetup();
      vfs.writeFile('/tmp/test.txt', 'ABCDEFGHIJ'); // 10 bytes
      const fd = openVfsFile(fdTable, vfs, '/tmp/test.txt');

      const errno = wasi.fd_seek(fd, -3n, 2, 200);
      assert.strictEqual(errno, ERRNO_SUCCESS);
      assert.strictEqual(readU64(memory, 200), 7n);
    });

    it('returns ESPIPE for stdio fds', () => {
      const { wasi } = createTestSetup();
      const errno = wasi.fd_seek(0, 0n, 0, 200);
      assert.strictEqual(errno, ERRNO_ESPIPE);
    });

    it('returns ESPIPE for directory fds', () => {
      const { wasi } = createTestSetup();
      // fd 3 is the pre-opened root directory
      const errno = wasi.fd_seek(3, 0n, 0, 200);
      assert.strictEqual(errno, ERRNO_ESPIPE);
    });

    it('returns EINVAL for negative resulting position', () => {
      const { wasi, memory, vfs, fdTable } = createTestSetup();
      vfs.writeFile('/tmp/test.txt', 'ABC');
      const fd = openVfsFile(fdTable, vfs, '/tmp/test.txt');

      const errno = wasi.fd_seek(fd, -10n, 0, 200);
      assert.strictEqual(errno, ERRNO_EINVAL);
    });

    it('returns EINVAL for invalid whence', () => {
      const { wasi, memory, vfs, fdTable } = createTestSetup();
      vfs.writeFile('/tmp/test.txt', 'ABC');
      const fd = openVfsFile(fdTable, vfs, '/tmp/test.txt');

      const errno = wasi.fd_seek(fd, 0n, 99, 200);
      assert.strictEqual(errno, ERRNO_EINVAL);
    });

    it('handles non-BigInt offset gracefully', () => {
      const { wasi, memory, vfs, fdTable } = createTestSetup();
      vfs.writeFile('/tmp/test.txt', 'ABCDEFGHIJ');
      const fd = openVfsFile(fdTable, vfs, '/tmp/test.txt');

      const errno = wasi.fd_seek(fd, 5 as unknown as bigint, 0, 200);
      assert.strictEqual(errno, ERRNO_SUCCESS);
      assert.strictEqual(readU64(memory, 200), 5n);
    });
  });

  describe('fd_tell', () => {
    it('returns current cursor position', () => {
      const { wasi, memory, vfs, fdTable } = createTestSetup();
      vfs.writeFile('/tmp/test.txt', 'ABCDEF');
      const fd = openVfsFile(fdTable, vfs, '/tmp/test.txt');
      fdTable.get(fd)!.cursor = 4n;

      const errno = wasi.fd_tell(fd, 200);
      assert.strictEqual(errno, ERRNO_SUCCESS);
      assert.strictEqual(readU64(memory, 200), 4n);
    });

    it('returns ESPIPE for stdio', () => {
      const { wasi } = createTestSetup();
      const errno = wasi.fd_tell(1, 200);
      assert.strictEqual(errno, ERRNO_ESPIPE);
    });

    it('returns EBADF for invalid fd', () => {
      const { wasi } = createTestSetup();
      const errno = wasi.fd_tell(99, 200);
      assert.strictEqual(errno, ERRNO_EBADF);
    });
  });

  describe('fd_close', () => {
    it('closes a valid fd', () => {
      const { wasi, fdTable, vfs } = createTestSetup();
      vfs.writeFile('/tmp/test.txt', 'data');
      const fd = openVfsFile(fdTable, vfs, '/tmp/test.txt');
      assert.ok(fdTable.has(fd));

      const errno = wasi.fd_close(fd);
      assert.strictEqual(errno, ERRNO_SUCCESS);
      assert.ok(!fdTable.has(fd));
    });

    it('returns EBADF for invalid fd', () => {
      const { wasi } = createTestSetup();
      const errno = wasi.fd_close(99);
      assert.strictEqual(errno, ERRNO_EBADF);
    });

    it('removes preopen entry when closing preopen fd', () => {
      const { wasi } = createTestSetup();
      const preopens = (wasi as unknown as Record<string, unknown>)._preopens as Map<number, string>;
      assert.strictEqual(preopens.get(3), '/');
      wasi.fd_close(3);
      assert.strictEqual(preopens.get(3), undefined);
    });
  });

  describe('fd_fdstat_get', () => {
    it('returns fdstat for stdout', () => {
      const { wasi, memory } = createTestSetup();
      const errno = wasi.fd_fdstat_get(1, 400);
      assert.strictEqual(errno, ERRNO_SUCCESS);

      const view = new DataView(memory.buffer);
      // filetype = CHARACTER_DEVICE = 2
      assert.strictEqual(view.getUint8(400), FILETYPE_CHARACTER_DEVICE);
      // fdflags = FDFLAG_APPEND = 1 (stdout has append flag)
      assert.strictEqual(view.getUint16(402, true), FDFLAG_APPEND);
      // rights_base should be non-zero
      const rightsBase = view.getBigUint64(408, true);
      assert.ok(rightsBase > 0n);
      // Should have write rights
      assert.ok(rightsBase & RIGHT_FD_WRITE);
    });

    it('returns fdstat for stdin', () => {
      const { wasi, memory } = createTestSetup();
      const errno = wasi.fd_fdstat_get(0, 400);
      assert.strictEqual(errno, ERRNO_SUCCESS);

      const view = new DataView(memory.buffer);
      assert.strictEqual(view.getUint8(400), FILETYPE_CHARACTER_DEVICE);
      assert.strictEqual(view.getUint16(402, true), 0); // stdin has no flags
      const rightsBase = view.getBigUint64(408, true);
      assert.ok(rightsBase & RIGHT_FD_READ);
    });

    it('returns fdstat for pre-opened directory', () => {
      const { wasi, memory } = createTestSetup();
      const errno = wasi.fd_fdstat_get(3, 400);
      assert.strictEqual(errno, ERRNO_SUCCESS);

      const view = new DataView(memory.buffer);
      assert.strictEqual(view.getUint8(400), FILETYPE_DIRECTORY);
      // Inheriting rights should be non-zero for directories
      const rightsInheriting = view.getBigUint64(416, true);
      assert.ok(rightsInheriting > 0n);
    });

    it('returns fdstat for regular file', () => {
      const { wasi, memory, vfs, fdTable } = createTestSetup();
      vfs.writeFile('/tmp/test.txt', 'data');
      const fd = openVfsFile(fdTable, vfs, '/tmp/test.txt');

      const errno = wasi.fd_fdstat_get(fd, 400);
      assert.strictEqual(errno, ERRNO_SUCCESS);

      const view = new DataView(memory.buffer);
      assert.strictEqual(view.getUint8(400), FILETYPE_REGULAR_FILE);
      const rightsBase = view.getBigUint64(408, true);
      assert.ok(rightsBase & RIGHT_FD_READ);
      assert.ok(rightsBase & RIGHT_FD_WRITE);
      assert.ok(rightsBase & RIGHT_FD_SEEK);
      assert.ok(rightsBase & RIGHT_FD_TELL);
    });

    it('returns EBADF for invalid fd', () => {
      const { wasi } = createTestSetup();
      const errno = wasi.fd_fdstat_get(99, 400);
      assert.strictEqual(errno, ERRNO_EBADF);
    });
  });

  describe('fd_fdstat_set_flags', () => {
    it('sets fd flags', () => {
      const { wasi, fdTable, vfs } = createTestSetup();
      vfs.writeFile('/tmp/test.txt', 'data');
      const fd = openVfsFile(fdTable, vfs, '/tmp/test.txt');
      assert.strictEqual(fdTable.get(fd)!.fdflags, 0);

      const errno = wasi.fd_fdstat_set_flags(fd, FDFLAG_APPEND);
      assert.strictEqual(errno, ERRNO_SUCCESS);
      assert.strictEqual(fdTable.get(fd)!.fdflags, FDFLAG_APPEND);
    });

    it('returns EBADF for invalid fd', () => {
      const { wasi } = createTestSetup();
      const errno = wasi.fd_fdstat_set_flags(99, 0);
      assert.strictEqual(errno, ERRNO_EBADF);
    });
  });

  describe('fd_prestat_get', () => {
    it('returns prestat for pre-opened directory', () => {
      const { wasi, memory } = createTestSetup();
      const errno = wasi.fd_prestat_get(3, 500);
      assert.strictEqual(errno, ERRNO_SUCCESS);

      const view = new DataView(memory.buffer);
      // pr_type = 0 (PREOPENTYPE_DIR)
      assert.strictEqual(view.getUint8(500), 0);
      // pr_name_len = 1 (length of "/")
      assert.strictEqual(view.getUint32(504, true), 1);
    });

    it('returns EBADF for non-preopen fd', () => {
      const { wasi } = createTestSetup();
      const errno = wasi.fd_prestat_get(0, 500);
      assert.strictEqual(errno, ERRNO_EBADF);
    });

    it('returns EBADF for fd 4 (not pre-opened)', () => {
      const { wasi } = createTestSetup();
      const errno = wasi.fd_prestat_get(4, 500);
      assert.strictEqual(errno, ERRNO_EBADF);
    });
  });

  describe('fd_prestat_dir_name', () => {
    it('writes directory name for pre-opened fd', () => {
      const { wasi, memory } = createTestSetup();
      const errno = wasi.fd_prestat_dir_name(3, 600, 1);
      assert.strictEqual(errno, ERRNO_SUCCESS);
      assert.strictEqual(readString(memory, 600, 1), '/');
    });

    it('returns EBADF for non-preopen fd', () => {
      const { wasi } = createTestSetup();
      const errno = wasi.fd_prestat_dir_name(0, 600, 10);
      assert.strictEqual(errno, ERRNO_EBADF);
    });
  });

  describe('stdout/stderr getters', () => {
    it('stdout getter returns concatenated output', () => {
      const { wasi, memory } = createTestSetup();
      writeString(memory, 256, 'hello');
      writeIovecs(memory, 0, [{ buf: 256, buf_len: 5 }]);
      wasi.fd_write(1, 0, 1, 100);

      writeString(memory, 256, ' world');
      writeIovecs(memory, 0, [{ buf: 256, buf_len: 6 }]);
      wasi.fd_write(1, 0, 1, 100);

      assert.strictEqual(wasi.stdoutString, 'hello world');
      assert.strictEqual(wasi.stdout.length, 11);
    });

    it('stderr getter returns concatenated errors', () => {
      const { wasi, memory } = createTestSetup();
      writeString(memory, 256, 'err1');
      writeIovecs(memory, 0, [{ buf: 256, buf_len: 4 }]);
      wasi.fd_write(2, 0, 1, 100);

      writeString(memory, 256, 'err2');
      writeIovecs(memory, 0, [{ buf: 256, buf_len: 4 }]);
      wasi.fd_write(2, 0, 1, 100);

      assert.strictEqual(wasi.stderrString, 'err1err2');
    });

    it('empty stdout returns empty buffer', () => {
      const { wasi } = createTestSetup();
      assert.strictEqual(wasi.stdout.length, 0);
      assert.strictEqual(wasi.stdoutString, '');
    });
  });

  describe('getImports', () => {
    it('returns object with all core WASI functions', () => {
      const { wasi } = createTestSetup();
      const imports = wasi.getImports();
      const expectedFns = [
        'fd_read', 'fd_write', 'fd_seek', 'fd_tell', 'fd_close',
        'fd_fdstat_get', 'fd_fdstat_set_flags',
        'fd_prestat_get', 'fd_prestat_dir_name',
      ];
      for (const name of expectedFns) {
        assert.strictEqual(typeof (imports as unknown as Record<string, unknown>)[name], 'function', `${name} should be a function`);
      }
    });

    it('import functions delegate correctly', () => {
      const { wasi, memory } = createTestSetup();
      const imports = wasi.getImports();
      // Write via imports object
      writeString(memory, 256, 'via import');
      writeIovecs(memory, 0, [{ buf: 256, buf_len: 10 }]);
      const errno = (imports as unknown as Record<string, Function>).fd_write(1, 0, 1, 100);
      assert.strictEqual(errno, ERRNO_SUCCESS);
      assert.strictEqual(wasi.stdoutString, 'via import');
    });
  });

  describe('fd_read and fd_write integration', () => {
    it('write then read from same VFS file', () => {
      const { wasi, memory, vfs, fdTable } = createTestSetup();
      vfs.writeFile('/tmp/rw.txt', '');
      const fd = openVfsFile(fdTable, vfs, '/tmp/rw.txt');

      // Write
      writeString(memory, 256, 'read me back');
      writeIovecs(memory, 0, [{ buf: 256, buf_len: 12 }]);
      wasi.fd_write(fd, 0, 1, 100);
      assert.strictEqual(readU32(memory, 100), 12);

      // Seek back to start
      wasi.fd_seek(fd, 0n, 0, 200);

      // Read
      writeIovecs(memory, 0, [{ buf: 400, buf_len: 20 }]);
      wasi.fd_read(fd, 0, 1, 100);
      assert.strictEqual(readU32(memory, 100), 12);
      assert.strictEqual(readString(memory, 400, 12), 'read me back');
    });
  });

  describe('pipe support', () => {
    it('reads from pipe buffer', () => {
      const { wasi, memory, fdTable } = createTestSetup();
      const pipeData = new TextEncoder().encode('pipe data');
      const pipe = {
        buffer: pipeData,
        readOffset: 0,
        writeOffset: pipeData.length,
      };
      const fd = fdTable.open(
        { type: 'pipe', pipe, end: 'read' },
        { filetype: FILETYPE_REGULAR_FILE }
      );

      writeIovecs(memory, 0, [{ buf: 256, buf_len: 20 }]);
      const errno = wasi.fd_read(fd, 0, 1, 100);
      assert.strictEqual(errno, ERRNO_SUCCESS);
      assert.strictEqual(readU32(memory, 100), 9);
      assert.strictEqual(readString(memory, 256, 9), 'pipe data');
    });

    it('writes to pipe buffer', () => {
      const { wasi, memory, fdTable } = createTestSetup();
      const pipe = {
        buffer: new Uint8Array(64),
        readOffset: 0,
        writeOffset: 0,
      };
      const fd = fdTable.open(
        { type: 'pipe', pipe, end: 'write' },
        { filetype: FILETYPE_REGULAR_FILE }
      );

      writeString(memory, 256, 'to pipe');
      writeIovecs(memory, 0, [{ buf: 256, buf_len: 7 }]);
      const errno = wasi.fd_write(fd, 0, 1, 100);
      assert.strictEqual(errno, ERRNO_SUCCESS);
      assert.strictEqual(readU32(memory, 100), 7);
      assert.strictEqual(pipe.writeOffset, 7);
      assert.strictEqual(new TextDecoder().decode(pipe.buffer.subarray(0, 7)), 'to pipe');
    });
  });
});
