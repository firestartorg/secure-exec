import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { VFS, VfsError } from '../src/vfs.ts';

describe('VFS', () => {
  describe('initial layout', () => {
    it('should have root directory', () => {
      const vfs = new VFS();
      assert.equal(vfs.exists('/'), true);
    });

    it('should pre-populate /bin', () => {
      const vfs = new VFS();
      assert.equal(vfs.exists('/bin'), true);
      const s = vfs.stat('/bin');
      assert.equal(s.type, 'dir');
    });

    it('should pre-populate /tmp', () => {
      const vfs = new VFS();
      assert.equal(vfs.exists('/tmp'), true);
    });

    it('should pre-populate /home/user', () => {
      const vfs = new VFS();
      assert.equal(vfs.exists('/home/user'), true);
      assert.equal(vfs.exists('/home'), true);
    });

    it('should pre-populate /dev with device nodes', () => {
      const vfs = new VFS();
      assert.equal(vfs.exists('/dev/null'), true);
      assert.equal(vfs.exists('/dev/stdin'), true);
      assert.equal(vfs.exists('/dev/stdout'), true);
      assert.equal(vfs.exists('/dev/stderr'), true);
    });
  });

  describe('mkdir', () => {
    it('should create a directory', () => {
      const vfs = new VFS();
      vfs.mkdir('/tmp/testdir');
      assert.equal(vfs.exists('/tmp/testdir'), true);
      const s = vfs.stat('/tmp/testdir');
      assert.equal(s.type, 'dir');
    });

    it('should throw ENOENT if parent does not exist', () => {
      const vfs = new VFS();
      assert.throws(() => vfs.mkdir('/nonexistent/dir'), /ENOENT/);
    });

    it('should throw EEXIST if path already exists', () => {
      const vfs = new VFS();
      vfs.mkdir('/tmp/dup');
      assert.throws(() => vfs.mkdir('/tmp/dup'), /EEXIST/);
    });

    it('should update parent mtime', () => {
      const vfs = new VFS();
      const before = vfs.stat('/tmp').mtime;
      // Ensure time passes
      vfs.mkdir('/tmp/timedir');
      const after = vfs.stat('/tmp').mtime;
      assert.ok(after >= before);
    });
  });

  describe('mkdirp', () => {
    it('should create nested directories', () => {
      const vfs = new VFS();
      vfs.mkdirp('/a/b/c/d');
      assert.equal(vfs.exists('/a'), true);
      assert.equal(vfs.exists('/a/b'), true);
      assert.equal(vfs.exists('/a/b/c'), true);
      assert.equal(vfs.exists('/a/b/c/d'), true);
    });

    it('should not fail if directories already exist', () => {
      const vfs = new VFS();
      vfs.mkdirp('/tmp/existing');
      assert.doesNotThrow(() => vfs.mkdirp('/tmp/existing'));
    });
  });

  describe('writeFile / readFile', () => {
    it('should write and read a string file', () => {
      const vfs = new VFS();
      vfs.writeFile('/tmp/hello.txt', 'hello world');
      const data = vfs.readFile('/tmp/hello.txt');
      assert.equal(new TextDecoder().decode(data), 'hello world');
    });

    it('should write and read a Uint8Array file', () => {
      const vfs = new VFS();
      const bytes = new Uint8Array([1, 2, 3, 4, 5]);
      vfs.writeFile('/tmp/binary', bytes);
      const data = vfs.readFile('/tmp/binary');
      assert.deepEqual(data, bytes);
    });

    it('should overwrite an existing file', () => {
      const vfs = new VFS();
      vfs.writeFile('/tmp/overwrite.txt', 'first');
      vfs.writeFile('/tmp/overwrite.txt', 'second');
      const data = vfs.readFile('/tmp/overwrite.txt');
      assert.equal(new TextDecoder().decode(data), 'second');
    });

    it('should throw ENOENT if parent does not exist', () => {
      const vfs = new VFS();
      assert.throws(() => vfs.writeFile('/nonexistent/file.txt', 'data'), /ENOENT/);
    });

    it('should throw EISDIR when reading a directory', () => {
      const vfs = new VFS();
      assert.throws(() => vfs.readFile('/tmp'), /EISDIR/);
    });

    it('should throw ENOENT when reading nonexistent file', () => {
      const vfs = new VFS();
      assert.throws(() => vfs.readFile('/tmp/nope.txt'), /ENOENT/);
    });

    it('should throw EISDIR when writing to a directory', () => {
      const vfs = new VFS();
      assert.throws(() => vfs.writeFile('/tmp', 'data'), /EISDIR/);
    });

    it('should update mtime on overwrite', () => {
      const vfs = new VFS();
      vfs.writeFile('/tmp/ts.txt', 'v1');
      const mtime1 = vfs.stat('/tmp/ts.txt').mtime;
      vfs.writeFile('/tmp/ts.txt', 'v2');
      const mtime2 = vfs.stat('/tmp/ts.txt').mtime;
      assert.ok(mtime2 >= mtime1);
    });
  });

  describe('/dev/null', () => {
    it('should read as empty', () => {
      const vfs = new VFS();
      const data = vfs.readFile('/dev/null');
      assert.equal(data.length, 0);
    });

    it('should discard writes', () => {
      const vfs = new VFS();
      vfs.writeFile('/dev/null', 'this should be discarded');
      const data = vfs.readFile('/dev/null');
      assert.equal(data.length, 0);
    });
  });

  describe('readdir', () => {
    it('should list directory entries', () => {
      const vfs = new VFS();
      vfs.writeFile('/tmp/a.txt', 'a');
      vfs.writeFile('/tmp/b.txt', 'b');
      const entries = vfs.readdir('/tmp');
      assert.ok(entries.includes('a.txt'));
      assert.ok(entries.includes('b.txt'));
    });

    it('should throw ENOENT for nonexistent directory', () => {
      const vfs = new VFS();
      assert.throws(() => vfs.readdir('/nonexistent'), /ENOENT/);
    });

    it('should throw ENOTDIR for a file', () => {
      const vfs = new VFS();
      vfs.writeFile('/tmp/file.txt', 'data');
      assert.throws(() => vfs.readdir('/tmp/file.txt'), /ENOTDIR/);
    });

    it('should list root directory entries', () => {
      const vfs = new VFS();
      const entries = vfs.readdir('/');
      assert.ok(entries.includes('bin'));
      assert.ok(entries.includes('tmp'));
      assert.ok(entries.includes('home'));
      assert.ok(entries.includes('dev'));
    });
  });

  describe('stat', () => {
    it('should return stat for a file', () => {
      const vfs = new VFS();
      vfs.writeFile('/tmp/stat.txt', 'hello');
      const s = vfs.stat('/tmp/stat.txt');
      assert.equal(s.type, 'file');
      assert.equal(s.size, 5);
      assert.equal(s.mode, 0o644);
      assert.equal(s.uid, 1000);
      assert.equal(s.gid, 1000);
      assert.equal(s.nlink, 1);
      assert.ok(s.atime > 0);
      assert.ok(s.mtime > 0);
      assert.ok(s.ctime > 0);
    });

    it('should return stat for a directory', () => {
      const vfs = new VFS();
      const s = vfs.stat('/tmp');
      assert.equal(s.type, 'dir');
      assert.equal(s.mode, 0o755);
    });

    it('should throw ENOENT for nonexistent path', () => {
      const vfs = new VFS();
      assert.throws(() => vfs.stat('/nonexistent'), /ENOENT/);
    });

    it('should follow symlinks', () => {
      const vfs = new VFS();
      vfs.writeFile('/tmp/target.txt', 'target content');
      vfs.symlink('/tmp/target.txt', '/tmp/link.txt');
      const s = vfs.stat('/tmp/link.txt');
      assert.equal(s.type, 'file');
      assert.equal(s.size, 14);
    });
  });

  describe('lstat', () => {
    it('should not follow symlinks', () => {
      const vfs = new VFS();
      vfs.writeFile('/tmp/target.txt', 'data');
      vfs.symlink('/tmp/target.txt', '/tmp/link.txt');
      const s = vfs.lstat('/tmp/link.txt');
      assert.equal(s.type, 'symlink');
    });

    it('should return stat for regular files', () => {
      const vfs = new VFS();
      vfs.writeFile('/tmp/regular.txt', 'data');
      const s = vfs.lstat('/tmp/regular.txt');
      assert.equal(s.type, 'file');
    });
  });

  describe('unlink', () => {
    it('should remove a file', () => {
      const vfs = new VFS();
      vfs.writeFile('/tmp/removeme.txt', 'data');
      assert.equal(vfs.exists('/tmp/removeme.txt'), true);
      vfs.unlink('/tmp/removeme.txt');
      assert.equal(vfs.exists('/tmp/removeme.txt'), false);
    });

    it('should throw ENOENT for nonexistent file', () => {
      const vfs = new VFS();
      assert.throws(() => vfs.unlink('/tmp/nope.txt'), /ENOENT/);
    });

    it('should throw EISDIR when trying to unlink a directory', () => {
      const vfs = new VFS();
      vfs.mkdir('/tmp/noremove');
      assert.throws(() => vfs.unlink('/tmp/noremove'), /EISDIR/);
    });

    it('should remove a symlink without affecting the target', () => {
      const vfs = new VFS();
      vfs.writeFile('/tmp/target.txt', 'data');
      vfs.symlink('/tmp/target.txt', '/tmp/link.txt');
      vfs.unlink('/tmp/link.txt');
      assert.equal(vfs.exists('/tmp/link.txt'), false);
      assert.equal(vfs.exists('/tmp/target.txt'), true);
    });
  });

  describe('rmdir', () => {
    it('should remove an empty directory', () => {
      const vfs = new VFS();
      vfs.mkdir('/tmp/emptydir');
      vfs.rmdir('/tmp/emptydir');
      assert.equal(vfs.exists('/tmp/emptydir'), false);
    });

    it('should throw ENOTEMPTY for non-empty directory', () => {
      const vfs = new VFS();
      vfs.mkdir('/tmp/notempty');
      vfs.writeFile('/tmp/notempty/file.txt', 'data');
      assert.throws(() => vfs.rmdir('/tmp/notempty'), /ENOTEMPTY/);
    });

    it('should throw ENOTDIR for a file', () => {
      const vfs = new VFS();
      vfs.writeFile('/tmp/notdir.txt', 'data');
      assert.throws(() => vfs.rmdir('/tmp/notdir.txt'), /ENOTDIR/);
    });

    it('should throw EPERM when trying to remove root', () => {
      const vfs = new VFS();
      assert.throws(() => vfs.rmdir('/'), /EPERM/);
    });
  });

  describe('rename', () => {
    it('should rename a file', () => {
      const vfs = new VFS();
      vfs.writeFile('/tmp/old.txt', 'data');
      vfs.rename('/tmp/old.txt', '/tmp/new.txt');
      assert.equal(vfs.exists('/tmp/old.txt'), false);
      assert.equal(vfs.exists('/tmp/new.txt'), true);
      assert.equal(new TextDecoder().decode(vfs.readFile('/tmp/new.txt')), 'data');
    });

    it('should rename a directory', () => {
      const vfs = new VFS();
      vfs.mkdir('/tmp/olddir');
      vfs.writeFile('/tmp/olddir/file.txt', 'content');
      vfs.rename('/tmp/olddir', '/tmp/newdir');
      assert.equal(vfs.exists('/tmp/olddir'), false);
      assert.equal(vfs.exists('/tmp/newdir'), true);
      assert.equal(new TextDecoder().decode(vfs.readFile('/tmp/newdir/file.txt')), 'content');
    });

    it('should overwrite destination file', () => {
      const vfs = new VFS();
      vfs.writeFile('/tmp/src.txt', 'new');
      vfs.writeFile('/tmp/dst.txt', 'old');
      vfs.rename('/tmp/src.txt', '/tmp/dst.txt');
      assert.equal(vfs.exists('/tmp/src.txt'), false);
      assert.equal(new TextDecoder().decode(vfs.readFile('/tmp/dst.txt')), 'new');
    });

    it('should move file across directories', () => {
      const vfs = new VFS();
      vfs.mkdir('/tmp/srcdir');
      vfs.mkdir('/tmp/dstdir');
      vfs.writeFile('/tmp/srcdir/file.txt', 'moved');
      vfs.rename('/tmp/srcdir/file.txt', '/tmp/dstdir/file.txt');
      assert.equal(vfs.exists('/tmp/srcdir/file.txt'), false);
      assert.equal(new TextDecoder().decode(vfs.readFile('/tmp/dstdir/file.txt')), 'moved');
    });

    it('should throw ENOENT for nonexistent source', () => {
      const vfs = new VFS();
      assert.throws(() => vfs.rename('/tmp/nope', '/tmp/nope2'), /ENOENT/);
    });
  });

  describe('symlink / readlink', () => {
    it('should create and read a symlink', () => {
      const vfs = new VFS();
      vfs.writeFile('/tmp/target.txt', 'target');
      vfs.symlink('/tmp/target.txt', '/tmp/link.txt');
      assert.equal(vfs.readlink('/tmp/link.txt'), '/tmp/target.txt');
    });

    it('should follow symlinks for readFile', () => {
      const vfs = new VFS();
      vfs.writeFile('/tmp/real.txt', 'real content');
      vfs.symlink('/tmp/real.txt', '/tmp/sym.txt');
      const data = vfs.readFile('/tmp/sym.txt');
      assert.equal(new TextDecoder().decode(data), 'real content');
    });

    it('should throw EEXIST if link path already exists', () => {
      const vfs = new VFS();
      vfs.writeFile('/tmp/existing.txt', 'data');
      assert.throws(() => vfs.symlink('/tmp/target', '/tmp/existing.txt'), /EEXIST/);
    });

    it('should throw EINVAL when readlink on non-symlink', () => {
      const vfs = new VFS();
      vfs.writeFile('/tmp/regular.txt', 'data');
      assert.throws(() => vfs.readlink('/tmp/regular.txt'), /EINVAL/);
    });

    it('should follow symlinks to directories', () => {
      const vfs = new VFS();
      vfs.mkdir('/tmp/realdir');
      vfs.writeFile('/tmp/realdir/file.txt', 'found');
      vfs.symlink('/tmp/realdir', '/tmp/symdir');
      const data = vfs.readFile('/tmp/symdir/file.txt');
      assert.equal(new TextDecoder().decode(data), 'found');
    });

    it('should handle relative symlinks', () => {
      const vfs = new VFS();
      vfs.writeFile('/tmp/actual.txt', 'relative target');
      vfs.symlink('actual.txt', '/tmp/rellink.txt');
      const data = vfs.readFile('/tmp/rellink.txt');
      assert.equal(new TextDecoder().decode(data), 'relative target');
    });
  });

  describe('chmod', () => {
    it('should change file permissions', () => {
      const vfs = new VFS();
      vfs.writeFile('/tmp/chmod.txt', 'data');
      vfs.chmod('/tmp/chmod.txt', 0o000);
      assert.equal(vfs.stat('/tmp/chmod.txt').mode, 0o000);
    });

    it('should change directory permissions', () => {
      const vfs = new VFS();
      vfs.mkdir('/tmp/chmoddir');
      vfs.chmod('/tmp/chmoddir', 0o700);
      assert.equal(vfs.stat('/tmp/chmoddir').mode, 0o700);
    });

    it('should throw ENOENT for nonexistent path', () => {
      const vfs = new VFS();
      assert.throws(() => vfs.chmod('/nonexistent', 0o644), /ENOENT/);
    });

    it('should update ctime', () => {
      const vfs = new VFS();
      vfs.writeFile('/tmp/ctime.txt', 'data');
      const before = vfs.stat('/tmp/ctime.txt').ctime;
      vfs.chmod('/tmp/ctime.txt', 0o755);
      const after = vfs.stat('/tmp/ctime.txt').ctime;
      assert.ok(after >= before);
    });
  });

  describe('path resolution', () => {
    it('should handle absolute paths', () => {
      const vfs = new VFS();
      vfs.writeFile('/tmp/abs.txt', 'absolute');
      assert.equal(vfs.exists('/tmp/abs.txt'), true);
    });

    it('should resolve . in paths', () => {
      const vfs = new VFS();
      vfs.writeFile('/tmp/dot.txt', 'dot');
      assert.equal(vfs.exists('/tmp/./dot.txt'), true);
    });

    it('should resolve .. in paths', () => {
      const vfs = new VFS();
      vfs.writeFile('/tmp/dotdot.txt', 'dotdot');
      // Lexical normalization: /tmp/sub/../dotdot.txt -> /tmp/dotdot.txt
      vfs.mkdir('/tmp/sub');
      assert.equal(vfs.exists('/tmp/sub/../dotdot.txt'), true);
      // /a/b/../c normalizes to /a/c regardless of b's existence
      assert.equal(vfs.exists('/tmp/nonexistent/../dotdot.txt'), true);
    });

    it('should collapse multiple slashes', () => {
      const vfs = new VFS();
      vfs.writeFile('/tmp/slashes.txt', 'data');
      assert.equal(vfs.exists('/tmp///slashes.txt'), true);
    });

    it('should normalize trailing slashes', () => {
      const vfs = new VFS();
      assert.equal(vfs.exists('/tmp/'), true);
    });

    it('should handle .. at root level', () => {
      const vfs = new VFS();
      assert.equal(vfs.exists('/..'), true); // .. at root is root
    });
  });

  describe('exists', () => {
    it('should return true for existing files', () => {
      const vfs = new VFS();
      vfs.writeFile('/tmp/exist.txt', 'yes');
      assert.equal(vfs.exists('/tmp/exist.txt'), true);
    });

    it('should return false for nonexistent files', () => {
      const vfs = new VFS();
      assert.equal(vfs.exists('/tmp/nope.txt'), false);
    });

    it('should return true for directories', () => {
      const vfs = new VFS();
      assert.equal(vfs.exists('/tmp'), true);
    });

    it('should return true for symlinks pointing to existing targets', () => {
      const vfs = new VFS();
      vfs.writeFile('/tmp/t.txt', 'data');
      vfs.symlink('/tmp/t.txt', '/tmp/l.txt');
      assert.equal(vfs.exists('/tmp/l.txt'), true);
    });

    it('should return false for broken symlinks', () => {
      const vfs = new VFS();
      vfs.symlink('/tmp/doesnotexist', '/tmp/broken.txt');
      assert.equal(vfs.exists('/tmp/broken.txt'), false);
    });
  });

  describe('getIno / getInodeByIno', () => {
    it('should return inode number for a path', () => {
      const vfs = new VFS();
      vfs.writeFile('/tmp/ino.txt', 'data');
      const ino = vfs.getIno('/tmp/ino.txt');
      assert.ok(ino !== null);
      assert.ok(typeof ino === 'number');
    });

    it('should return null for nonexistent path', () => {
      const vfs = new VFS();
      assert.equal(vfs.getIno('/nonexistent'), null);
    });

    it('should return the raw inode by number', () => {
      const vfs = new VFS();
      vfs.writeFile('/tmp/raw.txt', 'raw data');
      const ino = vfs.getIno('/tmp/raw.txt')!;
      const inode = vfs.getInodeByIno(ino)!;
      assert.ok(inode !== null);
      assert.equal(inode.type, 'file');
      assert.equal(new TextDecoder().decode(inode.data as Uint8Array), 'raw data');
    });
  });

  describe('VfsError', () => {
    it('should be an instance of Error', () => {
      const err = new VfsError('ENOENT', 'no such file');
      assert.ok(err instanceof Error);
      assert.ok(err instanceof VfsError);
    });

    it('should carry the correct code', () => {
      const err = new VfsError('EEXIST', 'already exists');
      assert.equal(err.code, 'EEXIST');
      assert.equal(err.name, 'VfsError');
    });

    it('should include code in message', () => {
      const err = new VfsError('ENOTDIR', 'not a directory');
      assert.ok(err.message.includes('ENOTDIR'));
      assert.ok(err.message.includes('not a directory'));
    });

    it('mkdir throws VfsError with ENOENT code', () => {
      const vfs = new VFS();
      try {
        vfs.mkdir('/nonexistent/dir');
        assert.fail('should have thrown');
      } catch (e) {
        assert.ok(e instanceof VfsError);
        assert.equal((e as VfsError).code, 'ENOENT');
      }
    });

    it('mkdir throws VfsError with EEXIST code', () => {
      const vfs = new VFS();
      vfs.mkdir('/tmp/dup');
      try {
        vfs.mkdir('/tmp/dup');
        assert.fail('should have thrown');
      } catch (e) {
        assert.ok(e instanceof VfsError);
        assert.equal((e as VfsError).code, 'EEXIST');
      }
    });

    it('readFile throws VfsError with EISDIR code', () => {
      const vfs = new VFS();
      try {
        vfs.readFile('/tmp');
        assert.fail('should have thrown');
      } catch (e) {
        assert.ok(e instanceof VfsError);
        assert.equal((e as VfsError).code, 'EISDIR');
      }
    });

    it('rmdir throws VfsError with ENOTEMPTY code', () => {
      const vfs = new VFS();
      vfs.mkdir('/tmp/notempty2');
      vfs.writeFile('/tmp/notempty2/file.txt', 'data');
      try {
        vfs.rmdir('/tmp/notempty2');
        assert.fail('should have thrown');
      } catch (e) {
        assert.ok(e instanceof VfsError);
        assert.equal((e as VfsError).code, 'ENOTEMPTY');
      }
    });

    it('rmdir throws VfsError with EPERM for root', () => {
      const vfs = new VFS();
      try {
        vfs.rmdir('/');
        assert.fail('should have thrown');
      } catch (e) {
        assert.ok(e instanceof VfsError);
        assert.equal((e as VfsError).code, 'EPERM');
      }
    });

    it('readlink throws VfsError with EINVAL code', () => {
      const vfs = new VFS();
      vfs.writeFile('/tmp/notlink.txt', 'data');
      try {
        vfs.readlink('/tmp/notlink.txt');
        assert.fail('should have thrown');
      } catch (e) {
        assert.ok(e instanceof VfsError);
        assert.equal((e as VfsError).code, 'EINVAL');
      }
    });

    it('readdir throws VfsError with ENOTDIR code', () => {
      const vfs = new VFS();
      vfs.writeFile('/tmp/afile.txt', 'data');
      try {
        vfs.readdir('/tmp/afile.txt');
        assert.fail('should have thrown');
      } catch (e) {
        assert.ok(e instanceof VfsError);
        assert.equal((e as VfsError).code, 'ENOTDIR');
      }
    });
  });
});
