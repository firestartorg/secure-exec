import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FDTable,
  FDEntry,
  FileDescription,
  FILETYPE_REGULAR_FILE,
  FILETYPE_DIRECTORY,
  FILETYPE_CHARACTER_DEVICE,
  FDFLAG_APPEND,
  RIGHT_FD_READ,
  RIGHT_FD_WRITE,
  RIGHT_FD_READDIR,
  RIGHT_PATH_OPEN,
  ERRNO_SUCCESS,
  ERRNO_EBADF,
} from '../src/fd-table.ts';

describe('FDTable', () => {
  describe('stdio pre-allocation', () => {
    it('should pre-allocate fds 0, 1, 2 for stdin, stdout, stderr', () => {
      const table = new FDTable();
      const stdin = table.get(0)!;
      const stdout = table.get(1)!;
      const stderr = table.get(2)!;

      assert.notEqual(stdin, null);
      assert.notEqual(stdout, null);
      assert.notEqual(stderr, null);

      assert.equal((stdin.resource as { name: string }).name, 'stdin');
      assert.equal((stdout.resource as { name: string }).name, 'stdout');
      assert.equal((stderr.resource as { name: string }).name, 'stderr');
    });

    it('should set stdio fds as character devices', () => {
      const table = new FDTable();
      assert.equal(table.get(0)!.filetype, FILETYPE_CHARACTER_DEVICE);
      assert.equal(table.get(1)!.filetype, FILETYPE_CHARACTER_DEVICE);
      assert.equal(table.get(2)!.filetype, FILETYPE_CHARACTER_DEVICE);
    });

    it('should set append flag on stdout and stderr', () => {
      const table = new FDTable();
      assert.equal(table.get(0)!.fdflags, 0);
      assert.equal(table.get(1)!.fdflags, FDFLAG_APPEND);
      assert.equal(table.get(2)!.fdflags, FDFLAG_APPEND);
    });

    it('should start with 3 open fds', () => {
      const table = new FDTable();
      assert.equal(table.size, 3);
    });
  });

  describe('open', () => {
    it('should return fd numbers starting at 3', () => {
      const table = new FDTable();
      const fd = table.open({ type: 'file', data: new Uint8Array() } as never);
      assert.equal(fd, 3);
    });

    it('should increment fd numbers', () => {
      const table = new FDTable();
      const fd1 = table.open({ type: 'file' } as never);
      const fd2 = table.open({ type: 'file' } as never);
      assert.equal(fd1, 3);
      assert.equal(fd2, 4);
    });

    it('should store the resource', () => {
      const table = new FDTable();
      const resource = { type: 'file', data: new Uint8Array([1, 2, 3]) } as never;
      const fd = table.open(resource);
      assert.equal(table.get(fd)!.resource, resource);
    });

    it('should default to FILETYPE_REGULAR_FILE', () => {
      const table = new FDTable();
      const fd = table.open({ type: 'file' } as never);
      assert.equal(table.get(fd)!.filetype, FILETYPE_REGULAR_FILE);
    });

    it('should accept custom filetype', () => {
      const table = new FDTable();
      const fd = table.open({ type: 'dir' } as never, { filetype: FILETYPE_DIRECTORY });
      assert.equal(table.get(fd)!.filetype, FILETYPE_DIRECTORY);
    });

    it('should accept custom rights', () => {
      const table = new FDTable();
      const rights = RIGHT_FD_READ | RIGHT_FD_WRITE;
      const fd = table.open({ type: 'file' } as never, { rightsBase: rights });
      assert.equal(table.get(fd)!.rightsBase, rights);
    });

    it('should accept custom fdflags', () => {
      const table = new FDTable();
      const fd = table.open({ type: 'file' } as never, { fdflags: FDFLAG_APPEND });
      assert.equal(table.get(fd)!.fdflags, FDFLAG_APPEND);
    });

    it('should store the path if provided', () => {
      const table = new FDTable();
      const fd = table.open({ type: 'file' } as never, { path: '/tmp/test.txt' });
      assert.equal(table.get(fd)!.path, '/tmp/test.txt');
    });

    it('should initialize cursor to 0', () => {
      const table = new FDTable();
      const fd = table.open({ type: 'file' } as never);
      assert.equal(table.get(fd)!.cursor, 0n);
    });
  });

  describe('close', () => {
    it('should close an open fd', () => {
      const table = new FDTable();
      const fd = table.open({ type: 'file' } as never);
      assert.equal(table.close(fd), ERRNO_SUCCESS);
      assert.equal(table.get(fd), null);
    });

    it('should return EBADF for invalid fd', () => {
      const table = new FDTable();
      assert.equal(table.close(99), ERRNO_EBADF);
    });

    it('should reduce the number of open fds', () => {
      const table = new FDTable();
      const fd = table.open({ type: 'file' } as never);
      assert.equal(table.size, 4);
      table.close(fd);
      assert.equal(table.size, 3);
    });

    it('should allow closing stdio fds', () => {
      const table = new FDTable();
      assert.equal(table.close(0), ERRNO_SUCCESS);
      assert.equal(table.get(0), null);
    });
  });

  describe('get', () => {
    it('should return the entry for an open fd', () => {
      const table = new FDTable();
      const entry = table.get(0)!;
      assert.notEqual(entry, null);
      assert.equal((entry.resource as { name: string }).name, 'stdin');
    });

    it('should return null for a closed fd', () => {
      const table = new FDTable();
      assert.equal(table.get(99), null);
    });
  });

  describe('dup', () => {
    it('should duplicate an fd', () => {
      const table = new FDTable();
      const resource = { type: 'file', data: 'hello' } as never;
      const fd = table.open(resource);
      const newFd = table.dup(fd);

      assert.notEqual(newFd, fd);
      assert.equal(table.get(newFd)!.resource, resource);
    });

    it('should copy filetype, rights, and flags', () => {
      const table = new FDTable();
      const rights = RIGHT_FD_READ;
      const fd = table.open({ type: 'file' } as never, {
        filetype: FILETYPE_REGULAR_FILE,
        rightsBase: rights,
        fdflags: FDFLAG_APPEND,
      });
      const newFd = table.dup(fd);
      const entry = table.get(newFd)!;

      assert.equal(entry.filetype, FILETYPE_REGULAR_FILE);
      assert.equal(entry.rightsBase, rights);
      assert.equal(entry.fdflags, FDFLAG_APPEND);
    });

    it('should share cursor position via FileDescription', () => {
      const table = new FDTable();
      const fd = table.open({ type: 'file' } as never);
      table.get(fd)!.cursor = 42n;
      const newFd = table.dup(fd);
      assert.equal(table.get(newFd)!.cursor, 42n);
      // Shared: seeking one moves the other
      table.get(fd)!.cursor = 100n;
      assert.equal(table.get(newFd)!.cursor, 100n);
    });

    it('should share the same FileDescription object', () => {
      const table = new FDTable();
      const fd = table.open({ type: 'file' } as never);
      const newFd = table.dup(fd);
      assert.equal(table.get(fd)!.fileDescription, table.get(newFd)!.fileDescription);
    });

    it('should increment FileDescription refCount', () => {
      const table = new FDTable();
      const fd = table.open({ type: 'file' } as never);
      assert.equal(table.get(fd)!.fileDescription.refCount, 1);
      const newFd = table.dup(fd);
      assert.equal(table.get(fd)!.fileDescription.refCount, 2);
    });

    it('should return -1 for invalid fd', () => {
      const table = new FDTable();
      assert.equal(table.dup(99), -1);
    });

    it('should allow independent closure', () => {
      const table = new FDTable();
      const fd = table.open({ type: 'file' } as never);
      const newFd = table.dup(fd);
      table.close(fd);
      assert.equal(table.get(fd), null);
      assert.notEqual(table.get(newFd), null);
    });

    it('close one fd, other fd still works with shared cursor', () => {
      const table = new FDTable();
      const fd = table.open({ type: 'file' } as never);
      table.get(fd)!.cursor = 50n;
      const newFd = table.dup(fd);
      // Close original — duped fd retains cursor
      table.close(fd);
      assert.equal(table.get(newFd)!.cursor, 50n);
      // Can still seek on the remaining fd
      table.get(newFd)!.cursor = 99n;
      assert.equal(table.get(newFd)!.cursor, 99n);
    });

    it('close decrements FileDescription refCount', () => {
      const table = new FDTable();
      const fd = table.open({ type: 'file' } as never);
      const newFd = table.dup(fd);
      const fileDesc = table.get(fd)!.fileDescription;
      assert.equal(fileDesc.refCount, 2);
      table.close(fd);
      assert.equal(fileDesc.refCount, 1);
      table.close(newFd);
      assert.equal(fileDesc.refCount, 0);
    });
  });

  describe('dup2', () => {
    it('should duplicate fd to a specific number', () => {
      const table = new FDTable();
      const resource = { type: 'file', data: 'test' } as never;
      const fd = table.open(resource);
      const result = table.dup2(fd, 10);

      assert.equal(result, ERRNO_SUCCESS);
      assert.equal(table.get(10)!.resource, resource);
    });

    it('should close the target fd if already open', () => {
      const table = new FDTable();
      const res1 = { type: 'file', name: 'first' } as never;
      const res2 = { type: 'file', name: 'second' } as never;
      const fd1 = table.open(res1);
      const fd2 = table.open(res2);

      table.dup2(fd1, fd2);
      assert.equal(table.get(fd2)!.resource, res1);
    });

    it('should be a no-op when oldFd === newFd and fd is valid', () => {
      const table = new FDTable();
      const fd = table.open({ type: 'file' } as never);
      assert.equal(table.dup2(fd, fd), ERRNO_SUCCESS);
    });

    it('should return EBADF when oldFd === newFd and fd is invalid', () => {
      const table = new FDTable();
      assert.equal(table.dup2(99, 99), ERRNO_EBADF);
    });

    it('should return EBADF for invalid source fd', () => {
      const table = new FDTable();
      assert.equal(table.dup2(99, 10), ERRNO_EBADF);
    });

    it('should share cursor position via FileDescription', () => {
      const table = new FDTable();
      const fd = table.open({ type: 'file' } as never);
      table.get(fd)!.cursor = 100n;
      table.dup2(fd, 10);
      assert.equal(table.get(10)!.cursor, 100n);
      // Shared: seeking one moves the other
      table.get(10)!.cursor = 200n;
      assert.equal(table.get(fd)!.cursor, 200n);
    });

    it('should share the same FileDescription object via dup2', () => {
      const table = new FDTable();
      const fd = table.open({ type: 'file' } as never);
      table.dup2(fd, 10);
      assert.equal(table.get(fd)!.fileDescription, table.get(10)!.fileDescription);
      assert.equal(table.get(fd)!.fileDescription.refCount, 2);
    });

    it('should allow redirecting stdio', () => {
      const table = new FDTable();
      const file = { type: 'file', path: '/tmp/out.txt' } as never;
      const fd = table.open(file);

      // Redirect stdout (fd 1) to the file
      table.dup2(fd, 1);
      assert.equal(table.get(1)!.resource, file);
    });
  });

  describe('has', () => {
    it('should return true for open fds', () => {
      const table = new FDTable();
      assert.equal(table.has(0), true);
      assert.equal(table.has(1), true);
      assert.equal(table.has(2), true);
    });

    it('should return false for closed fds', () => {
      const table = new FDTable();
      assert.equal(table.has(99), false);
    });
  });

  describe('FileDescription', () => {
    it('should have correct initial state', () => {
      const desc = new FileDescription(42, FDFLAG_APPEND);
      assert.equal(desc.inode, 42);
      assert.equal(desc.cursor, 0n);
      assert.equal(desc.flags, FDFLAG_APPEND);
      assert.equal(desc.refCount, 1);
    });

    it('open() creates new FileDescription with refCount=1', () => {
      const table = new FDTable();
      const fd = table.open({ type: 'file' } as never);
      const entry = table.get(fd)!;
      assert.ok(entry.fileDescription instanceof FileDescription);
      assert.equal(entry.fileDescription.refCount, 1);
      assert.equal(entry.fileDescription.cursor, 0n);
    });

    it('separate open() calls create separate FileDescriptions', () => {
      const table = new FDTable();
      const fd1 = table.open({ type: 'file' } as never);
      const fd2 = table.open({ type: 'file' } as never);
      assert.notEqual(table.get(fd1)!.fileDescription, table.get(fd2)!.fileDescription);
    });
  });

  describe('cursor tracking', () => {
    it('should allow setting and reading cursor position', () => {
      const table = new FDTable();
      const fd = table.open({ type: 'file' } as never);
      const entry = table.get(fd)!;

      assert.equal(entry.cursor, 0n);
      entry.cursor = 1024n;
      assert.equal(table.get(fd)!.cursor, 1024n);
    });

    it('should track cursor independently per separately-opened fd', () => {
      const table = new FDTable();
      const fd1 = table.open({ type: 'file' } as never);
      const fd2 = table.open({ type: 'file' } as never);

      table.get(fd1)!.cursor = 10n;
      table.get(fd2)!.cursor = 20n;

      assert.equal(table.get(fd1)!.cursor, 10n);
      assert.equal(table.get(fd2)!.cursor, 20n);
    });

    it('dup(fd) then seek on original — duped fd cursor also moved', () => {
      const table = new FDTable();
      const fd = table.open({ type: 'file' } as never);
      const dupFd = table.dup(fd);

      // Seek original
      table.get(fd)!.cursor = 42n;
      // Duped fd sees the same cursor
      assert.equal(table.get(dupFd)!.cursor, 42n);

      // Seek duped fd
      table.get(dupFd)!.cursor = 99n;
      // Original also moved
      assert.equal(table.get(fd)!.cursor, 99n);
    });
  });

  describe('FD reclamation', () => {
    it('should reuse closed FD numbers', () => {
      const table = new FDTable();
      const fd1 = table.open({ type: 'file' } as never); // 3
      const fd2 = table.open({ type: 'file' } as never); // 4
      table.close(fd1); // free 3
      const fd3 = table.open({ type: 'file' } as never); // should reuse 3
      assert.equal(fd3, fd1, 'should reuse freed fd 3');
    });

    it('should reuse FDs after opening/closing 100 FDs', () => {
      const table = new FDTable();
      // Open 100 FDs (3..102)
      const fds: number[] = [];
      for (let i = 0; i < 100; i++) {
        fds.push(table.open({ type: 'file' } as never));
      }
      assert.equal(fds[0], 3);
      assert.equal(fds[99], 102);
      // Close all 100
      for (const fd of fds) {
        table.close(fd);
      }
      // Next open should reuse a low number (from free list)
      const reused = table.open({ type: 'file' } as never);
      assert.ok(reused >= 3 && reused <= 102,
        `should reuse a freed fd, got ${reused}`);
    });

    it('should never reclaim stdio FDs (0, 1, 2)', () => {
      const table = new FDTable();
      // Close stdio
      table.close(0);
      table.close(1);
      table.close(2);
      // Open new FDs — should NOT get 0, 1, or 2
      const fd1 = table.open({ type: 'file' } as never);
      const fd2 = table.open({ type: 'file' } as never);
      const fd3 = table.open({ type: 'file' } as never);
      assert.ok(fd1 >= 3, `fd should be >= 3, got ${fd1}`);
      assert.ok(fd2 >= 3, `fd should be >= 3, got ${fd2}`);
      assert.ok(fd3 >= 3, `fd should be >= 3, got ${fd3}`);
    });

    it('should reuse FDs from dup() after closing', () => {
      const table = new FDTable();
      const fd = table.open({ type: 'file' } as never); // 3
      const dupFd = table.dup(fd); // 4
      table.close(dupFd); // free 4
      const fd2 = table.open({ type: 'file' } as never); // should reuse 4
      assert.equal(fd2, dupFd, 'should reuse freed dup fd');
    });

    it('should allocate new FDs when free list is empty', () => {
      const table = new FDTable();
      const fd1 = table.open({ type: 'file' } as never); // 3
      const fd2 = table.open({ type: 'file' } as never); // 4
      assert.equal(fd1, 3);
      assert.equal(fd2, 4);
      // No closes, so free list is empty — next should be 5
      const fd3 = table.open({ type: 'file' } as never);
      assert.equal(fd3, 5);
    });
  });

  describe('rights tracking', () => {
    it('should track base and inheriting rights', () => {
      const table = new FDTable();
      const fd = table.open({ type: 'file' } as never, {
        rightsBase: RIGHT_FD_READ | RIGHT_FD_WRITE,
        rightsInheriting: RIGHT_FD_READ,
      });
      const entry = table.get(fd)!;
      assert.equal(entry.rightsBase, RIGHT_FD_READ | RIGHT_FD_WRITE);
      assert.equal(entry.rightsInheriting, RIGHT_FD_READ);
    });

    it('should give directories appropriate default rights', () => {
      const table = new FDTable();
      const fd = table.open({ type: 'dir' } as never, { filetype: FILETYPE_DIRECTORY });
      const entry = table.get(fd)!;
      // Directory should have readdir and path_open rights
      assert.notEqual(entry.rightsBase & RIGHT_FD_READDIR, 0n);
      assert.notEqual(entry.rightsBase & RIGHT_PATH_OPEN, 0n);
    });
  });

  describe('renumber', () => {
    it('should move fd from old to new number', () => {
      const table = new FDTable();
      const resource = { type: 'file', name: 'test' } as never;
      const fd = table.open(resource);

      assert.equal(table.renumber(fd, 10), ERRNO_SUCCESS);
      assert.equal(table.get(10)!.resource, resource);
      assert.equal(table.get(fd), null);
    });

    it('should close target fd if open', () => {
      const table = new FDTable();
      const res1 = { type: 'file', name: 'first' } as never;
      const res2 = { type: 'file', name: 'second' } as never;
      const fd1 = table.open(res1);
      const fd2 = table.open(res2);

      table.renumber(fd1, fd2);
      assert.equal(table.get(fd2)!.resource, res1);
      assert.equal(table.get(fd1), null);
    });

    it('should return EBADF for invalid source', () => {
      const table = new FDTable();
      assert.equal(table.renumber(99, 10), ERRNO_EBADF);
    });

    it('should be a no-op when oldFd === newFd', () => {
      const table = new FDTable();
      const fd = table.open({ type: 'file' } as never);
      assert.equal(table.renumber(fd, fd), ERRNO_SUCCESS);
      assert.notEqual(table.get(fd), null);
    });
  });
});
