import type { VirtualFileSystem } from "./types.js";

export interface DirEntry {
	name: string;
	isDirectory: boolean;
}

export interface StatInfo {
	mode: number;
	size: number;
	isDirectory: boolean;
	atimeMs: number;
	mtimeMs: number;
	ctimeMs: number;
	birthtimeMs: number;
}

// Mode constants
const S_IFREG = 32768; // Regular file
const S_IFDIR = 16384; // Directory

/**
 * Check if a path exists in the filesystem
 */
export async function exists(
	fs: VirtualFileSystem,
	path: string,
): Promise<boolean> {
	try {
		await fs.readFile(path);
		return true;
	} catch {
		try {
			await fs.readDir(path);
			return true;
		} catch {
			return false;
		}
	}
}

/**
 * Get file/directory stats
 */
export async function stat(
	fs: VirtualFileSystem,
	path: string,
): Promise<StatInfo> {
	const now = Date.now();

	// Try to read as file first
	try {
		const content = await fs.readFile(path);
		return {
			mode: S_IFREG | 0o644,
			size: content.length,
			isDirectory: false,
			atimeMs: now,
			mtimeMs: now,
			ctimeMs: now,
			birthtimeMs: now,
		};
	} catch {
		// Not a file, try as directory
		try {
			await fs.readDir(path);
			return {
				mode: S_IFDIR | 0o755,
				size: 4096,
				isDirectory: true,
				atimeMs: now,
				mtimeMs: now,
				ctimeMs: now,
				birthtimeMs: now,
			};
		} catch {
			throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
		}
	}
}

/**
 * Rename/move a file
 */
export async function rename(
	fs: VirtualFileSystem,
	oldPath: string,
	newPath: string,
): Promise<void> {
	const content = await fs.readFile(oldPath);
	await fs.writeFile(newPath, content);
	await fs.removeFile(oldPath);
}

/**
 * Read directory with type info
 */
export async function readDirWithTypes(
	fs: VirtualFileSystem,
	path: string,
): Promise<DirEntry[]> {
	const entries = await fs.readDir(path);
	const results: DirEntry[] = [];

	for (const entry of entries) {
		const name =
			typeof entry === "string" ? entry : (entry as { name: string }).name;
		const entryPath = path.endsWith("/") ? `${path}${name}` : `${path}/${name}`;

		let isDir = false;
		try {
			await fs.readDir(entryPath);
			isDir = true;
		} catch {
			// It's a file
		}

		results.push({ name, isDirectory: isDir });
	}

	return results;
}

/**
 * Create a directory (recursively creates parent directories)
 */
export async function mkdir(fs: VirtualFileSystem, path: string): Promise<void> {
	const normalizedPath = path.startsWith("/") ? path : `/${path}`;
	const parts = normalizedPath.split("/").filter(Boolean);

	let currentPath = "";
	for (const part of parts) {
		currentPath += `/${part}`;
		try {
			await fs.createDir(currentPath);
		} catch {
			// Directory might already exist, ignore error
		}
	}
}
