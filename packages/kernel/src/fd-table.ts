/**
 * Per-PID file descriptor table.
 *
 * Each process gets its own FD number space. Multiple FDs can share the
 * same FileDescription (via dup/dup2), which shares the cursor position.
 * Standard FDs 0-2 are pre-allocated per process.
 */

import type { FDEntry, FDStat, FileDescription } from "./types.js";
import {
	FILETYPE_REGULAR_FILE,
	FILETYPE_DIRECTORY,
	FILETYPE_CHARACTER_DEVICE,
	FILETYPE_PIPE,
	O_RDONLY,
	O_WRONLY,
	O_RDWR,
	O_APPEND,
} from "./types.js";

let nextDescriptionId = 1;

function createFileDescription(
	path: string,
	flags: number,
): FileDescription {
	return {
		id: nextDescriptionId++,
		path,
		cursor: 0n,
		flags,
		refCount: 1,
	};
}

/**
 * FD table for a single process.
 *
 * Manages FD allocation, dup/dup2, and shared cursor via FileDescription.
 */
export class ProcessFDTable {
	private entries: Map<number, FDEntry> = new Map();
	private nextFd = 3; // 0, 1, 2 reserved

	/** Pre-allocate stdin, stdout, stderr */
	initStdio(
		stdinDesc: FileDescription,
		stdoutDesc: FileDescription,
		stderrDesc: FileDescription,
	): void {
		this.entries.set(0, {
			fd: 0,
			description: stdinDesc,
			rights: 0n,
			filetype: FILETYPE_CHARACTER_DEVICE,
		});
		this.entries.set(1, {
			fd: 1,
			description: stdoutDesc,
			rights: 0n,
			filetype: FILETYPE_CHARACTER_DEVICE,
		});
		this.entries.set(2, {
			fd: 2,
			description: stderrDesc,
			rights: 0n,
			filetype: FILETYPE_CHARACTER_DEVICE,
		});
	}

	/** Open a new FD for the given path and flags */
	open(path: string, flags: number, filetype?: number): number {
		const fd = this.allocateFd();
		const description = createFileDescription(path, flags);
		this.entries.set(fd, {
			fd,
			description,
			rights: 0n,
			filetype: filetype ?? FILETYPE_REGULAR_FILE,
		});
		return fd;
	}

	/** Open a new FD pointing to an existing FileDescription (for pipes, inherited FDs) */
	openWith(
		description: FileDescription,
		filetype: number,
		targetFd?: number,
	): number {
		const fd = targetFd ?? this.allocateFd();
		description.refCount++;
		this.entries.set(fd, {
			fd,
			description,
			rights: 0n,
			filetype,
		});
		return fd;
	}

	get(fd: number): FDEntry | undefined {
		return this.entries.get(fd);
	}

	/** Close an FD. Decrements the refcount on the shared FileDescription. */
	close(fd: number): boolean {
		const entry = this.entries.get(fd);
		if (!entry) return false;
		entry.description.refCount--;
		this.entries.delete(fd);
		return true;
	}

	/** Duplicate an FD — new FD shares the same FileDescription (cursor). */
	dup(fd: number): number {
		const entry = this.entries.get(fd);
		if (!entry) throw new Error(`EBADF: bad file descriptor ${fd}`);
		const newFd = this.allocateFd();
		entry.description.refCount++;
		this.entries.set(newFd, {
			fd: newFd,
			description: entry.description,
			rights: entry.rights,
			filetype: entry.filetype,
		});
		return newFd;
	}

	/** Duplicate oldFd to newFd. Closes newFd first if open. */
	dup2(oldFd: number, newFd: number): void {
		const entry = this.entries.get(oldFd);
		if (!entry) throw new Error(`EBADF: bad file descriptor ${oldFd}`);
		if (oldFd === newFd) return;

		// Close newFd if already open
		if (this.entries.has(newFd)) {
			this.close(newFd);
		}

		entry.description.refCount++;
		this.entries.set(newFd, {
			fd: newFd,
			description: entry.description,
			rights: entry.rights,
			filetype: entry.filetype,
		});
	}

	stat(fd: number): FDStat {
		const entry = this.entries.get(fd);
		if (!entry) throw new Error(`EBADF: bad file descriptor ${fd}`);
		return {
			filetype: entry.filetype,
			flags: entry.description.flags,
			rights: entry.rights,
		};
	}

	/** Create a copy of this table for a child process (FD inheritance). */
	fork(): ProcessFDTable {
		const child = new ProcessFDTable();
		child.nextFd = this.nextFd;
		for (const [fd, entry] of this.entries) {
			entry.description.refCount++;
			child.entries.set(fd, {
				fd,
				description: entry.description,
				rights: entry.rights,
				filetype: entry.filetype,
			});
		}
		return child;
	}

	/** Close all FDs, decrementing all refcounts. */
	closeAll(): void {
		for (const [fd] of this.entries) {
			this.close(fd);
		}
	}

	private allocateFd(): number {
		// Find lowest available FD >= nextFd hint
		while (this.entries.has(this.nextFd)) {
			this.nextFd++;
		}
		return this.nextFd++;
	}
}

/**
 * Kernel-level FD table manager.
 * Owns per-PID FD tables and coordinates shared FileDescriptions.
 */
export class FDTableManager {
	private tables: Map<number, ProcessFDTable> = new Map();

	/** Create a new FD table for a process with standard FDs. */
	create(pid: number): ProcessFDTable {
		const table = new ProcessFDTable();
		table.initStdio(
			createFileDescription("/dev/stdin", O_RDONLY),
			createFileDescription("/dev/stdout", O_WRONLY),
			createFileDescription("/dev/stderr", O_WRONLY),
		);
		this.tables.set(pid, table);
		return table;
	}

	/** Create a child FD table by forking the parent's. */
	fork(parentPid: number, childPid: number): ProcessFDTable {
		const parentTable = this.tables.get(parentPid);
		if (!parentTable) {
			return this.create(childPid);
		}
		const childTable = parentTable.fork();
		this.tables.set(childPid, childTable);
		return childTable;
	}

	get(pid: number): ProcessFDTable | undefined {
		return this.tables.get(pid);
	}

	/** Remove and close all FDs for a process. */
	remove(pid: number): void {
		const table = this.tables.get(pid);
		if (table) {
			table.closeAll();
			this.tables.delete(pid);
		}
	}
}
