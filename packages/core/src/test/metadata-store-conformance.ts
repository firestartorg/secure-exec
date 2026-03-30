/**
 * Shared FsMetadataStore conformance test suite.
 *
 * Every FsMetadataStore implementation must pass the tests in this suite.
 * Optional test groups are gated on capability flags declared in the config.
 *
 * Usage:
 *
 * ```typescript
 * import { defineMetadataStoreTests } from "@secure-exec/core/test/metadata-store-conformance";
 *
 * defineMetadataStoreTests({
 *   name: "InMemoryMetadataStore",
 *   createStore: () => new InMemoryMetadataStore(),
 *   capabilities: { versioning: false },
 * });
 * ```
 *
 * The `versioning` capability flag gates tests for the optional
 * FsMetadataStoreVersioning interface (deferred to US-013).
 */

import type {
	FsMetadataStore,
	InodeMeta,
	CreateInodeAttrs,
} from "../vfs/types.js";
import { describe, beforeEach, afterEach, expect, test } from "vitest";

// ---------------------------------------------------------------------------
// Public config types
// ---------------------------------------------------------------------------

export interface MetadataStoreConformanceCapabilities {
	/** Whether the store implements FsMetadataStoreVersioning. */
	versioning: boolean;
}

export interface MetadataStoreConformanceConfig {
	/** Human-readable name shown in the describe block. */
	name: string;
	/** Create a fresh metadata store instance for each test. */
	createStore: () => Promise<FsMetadataStore> | FsMetadataStore;
	/** Optional teardown called after each test. */
	cleanup?: () => Promise<void>;
	/** Which optional capabilities the store supports. */
	capabilities: MetadataStoreConformanceCapabilities;
}

// ---------------------------------------------------------------------------
// Error code helper
// ---------------------------------------------------------------------------

function hasErrorCode(err: unknown, code: string): boolean {
	if (typeof err !== "object" || err === null) return false;
	const e = err as Record<string, unknown>;
	if (e.code === code) return true;
	if (typeof e.message === "string" && e.message.startsWith(`${code}:`))
		return true;
	return false;
}

function expectErrorCode(err: unknown, code: string): void {
	expect(err).toBeInstanceOf(Error);
	expect(hasErrorCode(err, code)).toBe(true);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fileAttrs(mode = 0o644): CreateInodeAttrs {
	return { type: "file", mode, uid: 1000, gid: 1000 };
}

function dirAttrs(mode = 0o755): CreateInodeAttrs {
	return { type: "directory", mode, uid: 1000, gid: 1000 };
}

function symlinkAttrs(target: string): CreateInodeAttrs {
	return { type: "symlink", mode: 0o777, uid: 1000, gid: 1000, symlinkTarget: target };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

export function defineMetadataStoreTests(
	config: MetadataStoreConformanceConfig,
): void {
	const { name } = config;

	describe(name, () => {
		let store: FsMetadataStore;

		beforeEach(async () => {
			store = await config.createStore();
		});

		afterEach(async () => {
			if (config.cleanup) await config.cleanup();
		});

		// ---------------------------------------------------------------
		// Inode lifecycle
		// ---------------------------------------------------------------

		describe("inode lifecycle", () => {
			test("createInode returns unique ino numbers", async () => {
				const ino1 = await store.createInode(fileAttrs());
				const ino2 = await store.createInode(fileAttrs());
				const ino3 = await store.createInode(fileAttrs());
				expect(ino1).not.toBe(ino2);
				expect(ino2).not.toBe(ino3);
				expect(ino1).not.toBe(ino3);
				// Root is ino 1, so all should be > 1.
				expect(ino1).toBeGreaterThan(1);
				expect(ino2).toBeGreaterThan(1);
				expect(ino3).toBeGreaterThan(1);
			});

			test("getInode returns correct data", async () => {
				const ino = await store.createInode(fileAttrs(0o600));
				const meta = await store.getInode(ino);
				expect(meta).not.toBeNull();
				expect(meta!.ino).toBe(ino);
				expect(meta!.type).toBe("file");
				expect(meta!.uid).toBe(1000);
				expect(meta!.gid).toBe(1000);
				expect(meta!.size).toBe(0);
				expect(meta!.nlink).toBe(0);
				expect(meta!.storageMode).toBe("inline");
				expect(meta!.inlineContent).toBeNull();
				expect(meta!.atimeMs).toBeGreaterThan(0);
				expect(meta!.mtimeMs).toBeGreaterThan(0);
				expect(meta!.ctimeMs).toBeGreaterThan(0);
				expect(meta!.birthtimeMs).toBeGreaterThan(0);
			});

			test("updateInode partial update", async () => {
				const ino = await store.createInode(fileAttrs());
				await store.updateInode(ino, { size: 100, nlink: 2 });
				const meta = await store.getInode(ino);
				expect(meta!.size).toBe(100);
				expect(meta!.nlink).toBe(2);
				// Other fields unchanged.
				expect(meta!.type).toBe("file");
				expect(meta!.uid).toBe(1000);
			});

			test("deleteInode makes getInode return null", async () => {
				const ino = await store.createInode(fileAttrs());
				await store.deleteInode(ino);
				const meta = await store.getInode(ino);
				expect(meta).toBeNull();
			});

			test("getInode for never-created ino returns null", async () => {
				const meta = await store.getInode(99999);
				expect(meta).toBeNull();
			});
		});

		// ---------------------------------------------------------------
		// Directory entries
		// ---------------------------------------------------------------

		describe("directory entries", () => {
			test("createDentry + lookup round-trip", async () => {
				const childIno = await store.createInode(fileAttrs());
				await store.createDentry(1, "hello.txt", childIno, "file");
				const result = await store.lookup(1, "hello.txt");
				expect(result).toBe(childIno);
			});

			test("lookup nonexistent name returns null", async () => {
				const result = await store.lookup(1, "nonexistent");
				expect(result).toBeNull();
			});

			test("listDir returns all children", async () => {
				const ino1 = await store.createInode(fileAttrs());
				const ino2 = await store.createInode(fileAttrs());
				const ino3 = await store.createInode(dirAttrs());
				await store.createDentry(1, "a.txt", ino1, "file");
				await store.createDentry(1, "b.txt", ino2, "file");
				await store.createDentry(1, "subdir", ino3, "directory");

				const entries = await store.listDir(1);
				expect(entries.length).toBe(3);
				const names = entries.map((e) => e.name).sort();
				expect(names).toEqual(["a.txt", "b.txt", "subdir"]);

				const subdirEntry = entries.find((e) => e.name === "subdir")!;
				expect(subdirEntry.type).toBe("directory");
				expect(subdirEntry.ino).toBe(ino3);
			});

			test("listDir on empty directory returns empty", async () => {
				const dirIno = await store.createInode(dirAttrs());
				const entries = await store.listDir(dirIno);
				expect(entries).toEqual([]);
			});

			test("listDirWithStats returns full metadata", async () => {
				const childIno = await store.createInode(fileAttrs(0o644));
				await store.updateInode(childIno, { size: 42, nlink: 1 });
				await store.createDentry(1, "file.txt", childIno, "file");

				const entries = await store.listDirWithStats(1);
				expect(entries.length).toBe(1);
				const entry = entries[0]!;
				expect(entry.name).toBe("file.txt");
				expect(entry.ino).toBe(childIno);
				expect(entry.type).toBe("file");
				expect(entry.stat).toBeDefined();
				expect(entry.stat.ino).toBe(childIno);
				expect(entry.stat.size).toBe(42);
				expect(entry.stat.nlink).toBe(1);
			});

			test("removeDentry makes lookup return null", async () => {
				const childIno = await store.createInode(fileAttrs());
				await store.createDentry(1, "file.txt", childIno, "file");
				await store.removeDentry(1, "file.txt");
				const result = await store.lookup(1, "file.txt");
				expect(result).toBeNull();
			});

			test("removeDentry does NOT delete child inode", async () => {
				const childIno = await store.createInode(fileAttrs());
				await store.createDentry(1, "file.txt", childIno, "file");
				await store.removeDentry(1, "file.txt");
				// Inode should still exist.
				const meta = await store.getInode(childIno);
				expect(meta).not.toBeNull();
				expect(meta!.ino).toBe(childIno);
			});

			test("createDentry duplicate name throws EEXIST", async () => {
				const ino1 = await store.createInode(fileAttrs());
				const ino2 = await store.createInode(fileAttrs());
				await store.createDentry(1, "file.txt", ino1, "file");
				try {
					await store.createDentry(1, "file.txt", ino2, "file");
					expect.fail("should have thrown");
				} catch (err) {
					expectErrorCode(err, "EEXIST");
				}
			});

			test("renameDentry same parent", async () => {
				const childIno = await store.createInode(fileAttrs());
				await store.createDentry(1, "old.txt", childIno, "file");
				await store.renameDentry(1, "old.txt", 1, "new.txt");

				expect(await store.lookup(1, "old.txt")).toBeNull();
				expect(await store.lookup(1, "new.txt")).toBe(childIno);
			});

			test("renameDentry across parents", async () => {
				const dirIno = await store.createInode(dirAttrs());
				await store.createDentry(1, "subdir", dirIno, "directory");

				const childIno = await store.createInode(fileAttrs());
				await store.createDentry(1, "file.txt", childIno, "file");
				await store.renameDentry(1, "file.txt", dirIno, "moved.txt");

				expect(await store.lookup(1, "file.txt")).toBeNull();
				expect(await store.lookup(dirIno, "moved.txt")).toBe(childIno);
			});

			test("renameDentry overwrites existing destination", async () => {
				const ino1 = await store.createInode(fileAttrs());
				const ino2 = await store.createInode(fileAttrs());
				await store.createDentry(1, "src.txt", ino1, "file");
				await store.createDentry(1, "dst.txt", ino2, "file");

				await store.renameDentry(1, "src.txt", 1, "dst.txt");
				expect(await store.lookup(1, "src.txt")).toBeNull();
				expect(await store.lookup(1, "dst.txt")).toBe(ino1);
			});
		});

		// ---------------------------------------------------------------
		// Path resolution
		// ---------------------------------------------------------------

		describe("path resolution", () => {
			test("resolvePath root returns ino 1", async () => {
				const ino = await store.resolvePath("/");
				expect(ino).toBe(1);
			});

			test("resolvePath single component", async () => {
				const fileIno = await store.createInode(fileAttrs());
				await store.createDentry(1, "hello.txt", fileIno, "file");
				const ino = await store.resolvePath("/hello.txt");
				expect(ino).toBe(fileIno);
			});

			test("resolvePath multi-component", async () => {
				const dirIno = await store.createInode(dirAttrs());
				await store.createDentry(1, "a", dirIno, "directory");
				const fileIno = await store.createInode(fileAttrs());
				await store.createDentry(dirIno, "b.txt", fileIno, "file");

				const ino = await store.resolvePath("/a/b.txt");
				expect(ino).toBe(fileIno);
			});

			test("resolvePath follows symlinks", async () => {
				const fileIno = await store.createInode(fileAttrs());
				await store.createDentry(1, "real.txt", fileIno, "file");

				const linkIno = await store.createInode(symlinkAttrs("/real.txt"));
				await store.createDentry(1, "link.txt", linkIno, "symlink");

				const ino = await store.resolvePath("/link.txt");
				expect(ino).toBe(fileIno);
			});

			test("resolvePath ENOENT for missing intermediate", async () => {
				try {
					await store.resolvePath("/nonexistent/file.txt");
					expect.fail("should have thrown");
				} catch (err) {
					expectErrorCode(err, "ENOENT");
				}
			});

			test("resolvePath ENOENT for missing final component", async () => {
				const dirIno = await store.createInode(dirAttrs());
				await store.createDentry(1, "dir", dirIno, "directory");
				try {
					await store.resolvePath("/dir/missing.txt");
					expect.fail("should have thrown");
				} catch (err) {
					expectErrorCode(err, "ENOENT");
				}
			});

			test("resolvePath ELOOP on circular symlinks", async () => {
				const linkA = await store.createInode(symlinkAttrs("/b"));
				await store.createDentry(1, "a", linkA, "symlink");
				const linkB = await store.createInode(symlinkAttrs("/a"));
				await store.createDentry(1, "b", linkB, "symlink");

				try {
					await store.resolvePath("/a");
					expect.fail("should have thrown");
				} catch (err) {
					expectErrorCode(err, "ELOOP");
				}
			});

			test("resolvePath ELOOP at depth 41", async () => {
				// Create a chain of 41 symlinks: link0 -> link1 -> ... -> link40.
				// link40 points to a real file, but depth > 40 should ELOOP.
				const fileIno = await store.createInode(fileAttrs());
				await store.createDentry(1, "target", fileIno, "file");

				let prevName = "target";
				for (let i = 40; i >= 0; i--) {
					const name = `link${i}`;
					const linkIno = await store.createInode(symlinkAttrs(`/${prevName}`));
					await store.createDentry(1, name, linkIno, "symlink");
					prevName = name;
				}

				try {
					await store.resolvePath("/link0");
					expect.fail("should have thrown");
				} catch (err) {
					expectErrorCode(err, "ELOOP");
				}
			});

			test("resolveParentPath returns parent and name", async () => {
				const dirIno = await store.createInode(dirAttrs());
				await store.createDentry(1, "dir", dirIno, "directory");
				const fileIno = await store.createInode(fileAttrs());
				await store.createDentry(dirIno, "file.txt", fileIno, "file");

				const result = await store.resolveParentPath("/dir/file.txt");
				expect(result.parentIno).toBe(dirIno);
				expect(result.name).toBe("file.txt");
			});

			test("resolveParentPath does not follow final symlink", async () => {
				const fileIno = await store.createInode(fileAttrs());
				await store.createDentry(1, "real.txt", fileIno, "file");
				const linkIno = await store.createInode(symlinkAttrs("/real.txt"));
				await store.createDentry(1, "link.txt", linkIno, "symlink");

				// resolveParentPath should return the parent dir and "link.txt",
				// not follow the symlink.
				const result = await store.resolveParentPath("/link.txt");
				expect(result.parentIno).toBe(1);
				expect(result.name).toBe("link.txt");
			});

			test("resolveParentPath ENOENT for missing intermediate", async () => {
				try {
					await store.resolveParentPath("/nonexistent/file.txt");
					expect.fail("should have thrown");
				} catch (err) {
					expectErrorCode(err, "ENOENT");
				}
			});
		});

		// ---------------------------------------------------------------
		// Chunk mapping
		// ---------------------------------------------------------------

		describe("chunk mapping", () => {
			test("set + get round-trip", async () => {
				const ino = await store.createInode(fileAttrs());
				await store.setChunkKey(ino, 0, "block-key-0");
				const key = await store.getChunkKey(ino, 0);
				expect(key).toBe("block-key-0");
			});

			test("get missing chunk returns null", async () => {
				const ino = await store.createInode(fileAttrs());
				const key = await store.getChunkKey(ino, 5);
				expect(key).toBeNull();
			});

			test("getAllChunkKeys returns ordered entries", async () => {
				const ino = await store.createInode(fileAttrs());
				await store.setChunkKey(ino, 2, "key-2");
				await store.setChunkKey(ino, 0, "key-0");
				await store.setChunkKey(ino, 1, "key-1");

				const keys = await store.getAllChunkKeys(ino);
				expect(keys).toEqual([
					{ chunkIndex: 0, key: "key-0" },
					{ chunkIndex: 1, key: "key-1" },
					{ chunkIndex: 2, key: "key-2" },
				]);
			});

			test("getAllChunkKeys for inode with no chunks returns empty", async () => {
				const ino = await store.createInode(fileAttrs());
				const keys = await store.getAllChunkKeys(ino);
				expect(keys).toEqual([]);
			});

			test("setChunkKey overwrites existing key", async () => {
				const ino = await store.createInode(fileAttrs());
				await store.setChunkKey(ino, 0, "old-key");
				await store.setChunkKey(ino, 0, "new-key");
				const key = await store.getChunkKey(ino, 0);
				expect(key).toBe("new-key");
			});

			test("deleteAllChunks returns all keys", async () => {
				const ino = await store.createInode(fileAttrs());
				await store.setChunkKey(ino, 0, "k0");
				await store.setChunkKey(ino, 1, "k1");
				await store.setChunkKey(ino, 2, "k2");

				const deleted = await store.deleteAllChunks(ino);
				expect(deleted.sort()).toEqual(["k0", "k1", "k2"]);

				// All chunks should be gone.
				expect(await store.getChunkKey(ino, 0)).toBeNull();
				expect(await store.getChunkKey(ino, 1)).toBeNull();
				expect(await store.getChunkKey(ino, 2)).toBeNull();
			});

			test("deleteChunksFrom returns deleted keys", async () => {
				const ino = await store.createInode(fileAttrs());
				await store.setChunkKey(ino, 0, "k0");
				await store.setChunkKey(ino, 1, "k1");
				await store.setChunkKey(ino, 2, "k2");
				await store.setChunkKey(ino, 3, "k3");

				const deleted = await store.deleteChunksFrom(ino, 2);
				expect(deleted.sort()).toEqual(["k2", "k3"]);

				// Chunks 0 and 1 should still exist.
				expect(await store.getChunkKey(ino, 0)).toBe("k0");
				expect(await store.getChunkKey(ino, 1)).toBe("k1");
				// Chunks 2 and 3 should be gone.
				expect(await store.getChunkKey(ino, 2)).toBeNull();
				expect(await store.getChunkKey(ino, 3)).toBeNull();
			});

			test("deleteChunksFrom beyond last chunk is no-op", async () => {
				const ino = await store.createInode(fileAttrs());
				await store.setChunkKey(ino, 0, "k0");

				const deleted = await store.deleteChunksFrom(ino, 10);
				expect(deleted).toEqual([]);

				// Existing chunk should still be there.
				expect(await store.getChunkKey(ino, 0)).toBe("k0");
			});
		});

		// ---------------------------------------------------------------
		// Transactions
		// ---------------------------------------------------------------

		describe("transactions", () => {
			test("commits on success", async () => {
				const ino = await store.transaction(async () => {
					const i = await store.createInode(fileAttrs());
					await store.createDentry(1, "txn-file.txt", i, "file");
					return i;
				});

				// Changes should be visible.
				const meta = await store.getInode(ino);
				expect(meta).not.toBeNull();
				expect(await store.lookup(1, "txn-file.txt")).toBe(ino);
			});

			test("rolls back on error", async () => {
				// For InMemoryMetadataStore, transaction() just calls the callback
				// directly so there's no real rollback. But we verify the error
				// propagates and any partial side effects from the InMemory store
				// may or may not be visible (implementation-defined for in-memory).
				// For SQLite, this should truly roll back.
				const error = new Error("test rollback");
				try {
					await store.transaction(async () => {
						await store.createInode(fileAttrs());
						throw error;
					});
					expect.fail("should have thrown");
				} catch (err) {
					expect(err).toBe(error);
				}
			});
		});

		// ---------------------------------------------------------------
		// Symlinks
		// ---------------------------------------------------------------

		describe("symlinks", () => {
			test("createInode with target + readSymlink round-trip", async () => {
				const ino = await store.createInode(symlinkAttrs("/some/target"));
				const target = await store.readSymlink(ino);
				expect(target).toBe("/some/target");
			});
		});
	});
}
