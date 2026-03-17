/**
 * WASI file descriptor table.
 *
 * Manages file descriptors for the WASI polyfill, tracking open resources,
 * cursor positions, flags, and rights per the WASI spec.
 */

// ---------------------------------------------------------------------------
// WASI file types (filetype enum)
// ---------------------------------------------------------------------------
export const FILETYPE_UNKNOWN = 0 as const;
export const FILETYPE_BLOCK_DEVICE = 1 as const;
export const FILETYPE_CHARACTER_DEVICE = 2 as const;
export const FILETYPE_DIRECTORY = 3 as const;
export const FILETYPE_REGULAR_FILE = 4 as const;
export const FILETYPE_SOCKET_DGRAM = 5 as const;
export const FILETYPE_SOCKET_STREAM = 6 as const;
export const FILETYPE_SYMBOLIC_LINK = 7 as const;

export type WasiFiletype =
  | typeof FILETYPE_UNKNOWN
  | typeof FILETYPE_BLOCK_DEVICE
  | typeof FILETYPE_CHARACTER_DEVICE
  | typeof FILETYPE_DIRECTORY
  | typeof FILETYPE_REGULAR_FILE
  | typeof FILETYPE_SOCKET_DGRAM
  | typeof FILETYPE_SOCKET_STREAM
  | typeof FILETYPE_SYMBOLIC_LINK;

// ---------------------------------------------------------------------------
// WASI fd flags (fdflags bitmask, u16)
// ---------------------------------------------------------------------------
export const FDFLAG_APPEND = 1 << 0;
export const FDFLAG_DSYNC = 1 << 1;
export const FDFLAG_NONBLOCK = 1 << 2;
export const FDFLAG_RSYNC = 1 << 3;
export const FDFLAG_SYNC = 1 << 4;

// ---------------------------------------------------------------------------
// WASI rights (rights bitmask, u64 — we use BigInt)
// ---------------------------------------------------------------------------
export const RIGHT_FD_DATASYNC = 1n << 0n;
export const RIGHT_FD_READ = 1n << 1n;
export const RIGHT_FD_SEEK = 1n << 2n;
export const RIGHT_FD_FDSTAT_SET_FLAGS = 1n << 3n;
export const RIGHT_FD_SYNC = 1n << 4n;
export const RIGHT_FD_TELL = 1n << 5n;
export const RIGHT_FD_WRITE = 1n << 6n;
export const RIGHT_FD_ADVISE = 1n << 7n;
export const RIGHT_FD_ALLOCATE = 1n << 8n;
export const RIGHT_PATH_CREATE_DIRECTORY = 1n << 9n;
export const RIGHT_PATH_CREATE_FILE = 1n << 10n;
export const RIGHT_PATH_LINK_SOURCE = 1n << 11n;
export const RIGHT_PATH_LINK_TARGET = 1n << 12n;
export const RIGHT_PATH_OPEN = 1n << 13n;
export const RIGHT_FD_READDIR = 1n << 14n;
export const RIGHT_PATH_READLINK = 1n << 15n;
export const RIGHT_PATH_RENAME_SOURCE = 1n << 16n;
export const RIGHT_PATH_RENAME_TARGET = 1n << 17n;
export const RIGHT_PATH_FILESTAT_GET = 1n << 18n;
export const RIGHT_PATH_FILESTAT_SET_SIZE = 1n << 19n;
export const RIGHT_PATH_FILESTAT_SET_TIMES = 1n << 20n;
export const RIGHT_FD_FILESTAT_GET = 1n << 21n;
export const RIGHT_FD_FILESTAT_SET_SIZE = 1n << 22n;
export const RIGHT_FD_FILESTAT_SET_TIMES = 1n << 23n;
export const RIGHT_PATH_SYMLINK = 1n << 24n;
export const RIGHT_PATH_REMOVE_DIRECTORY = 1n << 25n;
export const RIGHT_PATH_UNLINK_FILE = 1n << 26n;
export const RIGHT_POLL_FD_READWRITE = 1n << 27n;
export const RIGHT_SOCK_SHUTDOWN = 1n << 28n;
export const RIGHT_SOCK_ACCEPT = 1n << 29n;

// Convenience right sets
const RIGHTS_STDIO: bigint = RIGHT_FD_READ | RIGHT_FD_WRITE | RIGHT_FD_FDSTAT_SET_FLAGS |
  RIGHT_FD_FILESTAT_GET | RIGHT_POLL_FD_READWRITE;

const RIGHTS_FILE_ALL: bigint = RIGHT_FD_DATASYNC | RIGHT_FD_READ | RIGHT_FD_SEEK |
  RIGHT_FD_FDSTAT_SET_FLAGS | RIGHT_FD_SYNC | RIGHT_FD_TELL | RIGHT_FD_WRITE |
  RIGHT_FD_ADVISE | RIGHT_FD_ALLOCATE | RIGHT_FD_FILESTAT_GET |
  RIGHT_FD_FILESTAT_SET_SIZE | RIGHT_FD_FILESTAT_SET_TIMES |
  RIGHT_POLL_FD_READWRITE;

const RIGHTS_DIR_ALL: bigint = RIGHT_FD_FDSTAT_SET_FLAGS | RIGHT_FD_SYNC |
  RIGHT_FD_READDIR | RIGHT_PATH_CREATE_DIRECTORY | RIGHT_PATH_CREATE_FILE |
  RIGHT_PATH_LINK_SOURCE | RIGHT_PATH_LINK_TARGET | RIGHT_PATH_OPEN |
  RIGHT_PATH_READLINK | RIGHT_PATH_RENAME_SOURCE | RIGHT_PATH_RENAME_TARGET |
  RIGHT_PATH_FILESTAT_GET | RIGHT_PATH_FILESTAT_SET_SIZE |
  RIGHT_PATH_FILESTAT_SET_TIMES | RIGHT_PATH_SYMLINK |
  RIGHT_PATH_REMOVE_DIRECTORY | RIGHT_PATH_UNLINK_FILE |
  RIGHT_FD_FILESTAT_GET | RIGHT_FD_FILESTAT_SET_TIMES;

// ---------------------------------------------------------------------------
// WASI errno codes
// ---------------------------------------------------------------------------
export const ERRNO_SUCCESS = 0;
export const ERRNO_EBADF = 8;
export const ERRNO_EINVAL = 28;

// ---------------------------------------------------------------------------
// Resource types (discriminated union)
// ---------------------------------------------------------------------------

export interface StdioResource {
  type: 'stdio';
  name: 'stdin' | 'stdout' | 'stderr';
}

export interface VfsFileResource {
  type: 'vfsFile';
  ino: number;
  path: string;
}

export interface PreopenResource {
  type: 'preopen';
  path: string;
}

export interface PipeBuffer {
  buffer: Uint8Array;
  readOffset: number;
  writeOffset: number;
  _readerId?: number;  // FD of exclusive reader — assertion fires if two readers consume same pipe
}

export interface PipeResource {
  type: 'pipe';
  pipe: PipeBuffer;
  end: 'read' | 'write';
}

export type FDResource = StdioResource | VfsFileResource | PreopenResource | PipeResource;

// ---------------------------------------------------------------------------
// FileDescription — shared open-file state (cursor, flags, refcount)
// ---------------------------------------------------------------------------

/**
 * Represents an open file description (distinct from a file descriptor).
 * Multiple FDs can share the same FileDescription via dup()/dup2(),
 * causing them to share the cursor position — per POSIX semantics.
 */
export class FileDescription {
  inode: number;
  cursor: bigint;
  flags: number;
  refCount: number;

  constructor(inode: number, flags: number) {
    this.inode = inode;
    this.cursor = 0n;
    this.flags = flags;
    this.refCount = 1;
  }
}

// ---------------------------------------------------------------------------
// FDEntry
// ---------------------------------------------------------------------------

export interface FDOpenOptions {
  filetype?: WasiFiletype;
  rightsBase?: bigint;
  rightsInheriting?: bigint;
  fdflags?: number;
  path?: string;
}

/**
 * An entry in the file descriptor table.
 */
export class FDEntry {
  resource: FDResource;
  filetype: WasiFiletype;
  rightsBase: bigint;
  rightsInheriting: bigint;
  fdflags: number;
  fileDescription: FileDescription;
  path: string | null;

  /** Convenience accessor — reads/writes the shared FileDescription cursor. */
  get cursor(): bigint {
    return this.fileDescription.cursor;
  }
  set cursor(value: bigint) {
    this.fileDescription.cursor = value;
  }

  constructor(
    resource: FDResource,
    filetype: WasiFiletype,
    rightsBase: bigint,
    rightsInheriting: bigint,
    fdflags: number,
    path?: string,
    fileDescription?: FileDescription,
  ) {
    this.resource = resource;
    this.filetype = filetype;
    this.rightsBase = rightsBase;
    this.rightsInheriting = rightsInheriting;
    this.fdflags = fdflags;
    this.fileDescription = fileDescription ?? new FileDescription(0, fdflags);
    this.path = path ?? null;
  }
}

// ---------------------------------------------------------------------------
// FDTable
// ---------------------------------------------------------------------------

/**
 * WASI file descriptor table.
 *
 * Manages open file descriptors, pre-allocating FDs 0/1/2 for stdin/stdout/stderr.
 */
export class FDTable {
  private _fds: Map<number, FDEntry>;
  private _nextFd: number;
  private _freeFds: number[];

  constructor() {
    this._fds = new Map();
    this._nextFd = 3; // 0, 1, 2 are reserved
    this._freeFds = [];

    // Pre-allocate stdio fds
    this._fds.set(0, new FDEntry(
      { type: 'stdio', name: 'stdin' },
      FILETYPE_CHARACTER_DEVICE,
      RIGHTS_STDIO,
      0n,
      0
    ));
    this._fds.set(1, new FDEntry(
      { type: 'stdio', name: 'stdout' },
      FILETYPE_CHARACTER_DEVICE,
      RIGHTS_STDIO,
      0n,
      FDFLAG_APPEND
    ));
    this._fds.set(2, new FDEntry(
      { type: 'stdio', name: 'stderr' },
      FILETYPE_CHARACTER_DEVICE,
      RIGHTS_STDIO,
      0n,
      FDFLAG_APPEND
    ));
  }

  /**
   * Allocate the next available file descriptor number.
   * Reuses previously freed FDs (>= 3) before incrementing _nextFd.
   */
  private _allocateFd(): number {
    if (this._freeFds.length > 0) {
      return this._freeFds.pop()!;
    }
    return this._nextFd++;
  }

  /**
   * Open a new file descriptor for a resource.
   */
  open(resource: FDResource, options: FDOpenOptions = {}): number {
    const {
      filetype = FILETYPE_REGULAR_FILE,
      rightsBase = (filetype === FILETYPE_DIRECTORY ? RIGHTS_DIR_ALL : RIGHTS_FILE_ALL),
      rightsInheriting = (filetype === FILETYPE_DIRECTORY ? RIGHTS_FILE_ALL : 0n),
      fdflags = 0,
      path,
    } = options;

    const inode = (resource as { ino?: number }).ino ?? 0;
    const fileDesc = new FileDescription(inode, fdflags);
    const fd = this._allocateFd();
    this._fds.set(fd, new FDEntry(resource, filetype, rightsBase, rightsInheriting, fdflags, path, fileDesc));
    return fd;
  }

  /**
   * Close a file descriptor.
   *
   * Returns WASI errno (0 = success, 8 = EBADF).
   */
  close(fd: number): number {
    const entry = this._fds.get(fd);
    if (!entry) {
      return ERRNO_EBADF;
    }
    entry.fileDescription.refCount--;
    this._fds.delete(fd);
    // Reclaim non-stdio FDs for reuse
    if (fd >= 3) {
      this._freeFds.push(fd);
    }
    return ERRNO_SUCCESS;
  }

  /**
   * Get the entry for a file descriptor.
   */
  get(fd: number): FDEntry | null {
    return this._fds.get(fd) ?? null;
  }

  /**
   * Duplicate a file descriptor, returning a new fd pointing to the same resource.
   *
   * Returns the new fd number, or -1 if the source fd is invalid.
   */
  dup(fd: number): number {
    const entry = this._fds.get(fd);
    if (!entry) {
      return -1;
    }
    entry.fileDescription.refCount++;
    const newFd = this._allocateFd();
    this._fds.set(newFd, new FDEntry(
      entry.resource,
      entry.filetype,
      entry.rightsBase,
      entry.rightsInheriting,
      entry.fdflags,
      entry.path ?? undefined,
      entry.fileDescription,
    ));
    return newFd;
  }

  /**
   * Duplicate a file descriptor to a specific fd number.
   * If newFd is already open, it is closed first.
   *
   * Returns WASI errno (0 = success, 8 = EBADF if oldFd invalid, 28 = EINVAL if same fd).
   */
  dup2(oldFd: number, newFd: number): number {
    if (oldFd === newFd) {
      // If they're the same and oldFd is valid, it's a no-op
      if (this._fds.has(oldFd)) {
        return ERRNO_SUCCESS;
      }
      return ERRNO_EBADF;
    }

    const entry = this._fds.get(oldFd);
    if (!entry) {
      return ERRNO_EBADF;
    }

    // Close newFd if it's open (decrement its FileDescription refCount)
    const existing = this._fds.get(newFd);
    if (existing) {
      existing.fileDescription.refCount--;
    }
    this._fds.delete(newFd);

    entry.fileDescription.refCount++;
    this._fds.set(newFd, new FDEntry(
      entry.resource,
      entry.filetype,
      entry.rightsBase,
      entry.rightsInheriting,
      entry.fdflags,
      entry.path ?? undefined,
      entry.fileDescription,
    ));

    // Keep _nextFd above all allocated fds
    if (newFd >= this._nextFd) {
      this._nextFd = newFd + 1;
    }

    return ERRNO_SUCCESS;
  }

  /**
   * Check if a file descriptor is open.
   */
  has(fd: number): boolean {
    return this._fds.has(fd);
  }

  /**
   * Get the number of open file descriptors.
   */
  get size(): number {
    return this._fds.size;
  }

  /**
   * Renumber a file descriptor (move oldFd to newFd, closing newFd if open).
   *
   * Returns WASI errno.
   */
  renumber(oldFd: number, newFd: number): number {
    if (oldFd === newFd) {
      return this._fds.has(oldFd) ? ERRNO_SUCCESS : ERRNO_EBADF;
    }
    const entry = this._fds.get(oldFd);
    if (!entry) {
      return ERRNO_EBADF;
    }
    // Close newFd if open
    this._fds.delete(newFd);
    // Move oldFd to newFd
    this._fds.set(newFd, entry);
    this._fds.delete(oldFd);

    if (newFd >= this._nextFd) {
      this._nextFd = newFd + 1;
    }
    return ERRNO_SUCCESS;
  }
}
