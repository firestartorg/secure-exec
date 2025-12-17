import { afterEach, describe, expect, it } from "vitest";
import { VirtualMachine } from "./index.js";
import { DATA_MOUNT_PATH } from "../wasix/index.js";

describe("VirtualFileSystem", () => {
	let vm: VirtualMachine;

	afterEach(() => {
		vm?.dispose();
	});

	describe("path normalization", () => {
		it("should read file with direct path (no /data prefix)", async () => {
			vm = new VirtualMachine({ loadNpm: false });
			await vm.init();

			vm.writeFile("/test.txt", "hello world");
			const vfs = vm.createVirtualFileSystem();

			const content = await vfs.readTextFile("/test.txt");
			expect(content).toBe("hello world");
		});

		it("should read file with /data prefix", async () => {
			vm = new VirtualMachine({ loadNpm: false });
			await vm.init();

			vm.writeFile("/test.txt", "hello from data");
			const vfs = vm.createVirtualFileSystem();

			// Access via /data prefix - should strip it
			const content = await vfs.readTextFile(`${DATA_MOUNT_PATH}/test.txt`);
			expect(content).toBe("hello from data");
		});

		it("should write file with direct path", async () => {
			vm = new VirtualMachine({ loadNpm: false });
			await vm.init();

			const vfs = vm.createVirtualFileSystem();
			vfs.writeFile("/written.txt", "direct write");

			// Verify via VirtualMachine
			const content = await vm.readFile("/written.txt");
			expect(content).toBe("direct write");
		});

		it("should write file with /data prefix", async () => {
			vm = new VirtualMachine({ loadNpm: false });
			await vm.init();

			const vfs = vm.createVirtualFileSystem();
			// Write via /data prefix
			vfs.writeFile(`${DATA_MOUNT_PATH}/data-written.txt`, "data write");

			// Verify via VirtualMachine (without /data prefix)
			const content = await vm.readFile("/data-written.txt");
			expect(content).toBe("data write");
		});

		it("should read directory with direct path", async () => {
			vm = new VirtualMachine({ loadNpm: false });
			await vm.init();

			vm.mkdir("/mydir");
			vm.writeFile("/mydir/file1.txt", "a");
			vm.writeFile("/mydir/file2.txt", "b");

			const vfs = vm.createVirtualFileSystem();
			const entries = await vfs.readDir("/mydir");

			expect(entries).toContain("file1.txt");
			expect(entries).toContain("file2.txt");
		});

		it("should read directory with /data prefix", async () => {
			vm = new VirtualMachine({ loadNpm: false });
			await vm.init();

			vm.mkdir("/datadir");
			vm.writeFile("/datadir/a.txt", "a");
			vm.writeFile("/datadir/b.txt", "b");

			const vfs = vm.createVirtualFileSystem();
			// Access via /data prefix
			const entries = await vfs.readDir(`${DATA_MOUNT_PATH}/datadir`);

			expect(entries).toContain("a.txt");
			expect(entries).toContain("b.txt");
		});

		it("should create directory with /data prefix", async () => {
			vm = new VirtualMachine({ loadNpm: false });
			await vm.init();

			const vfs = vm.createVirtualFileSystem();
			// Create via /data prefix
			vfs.createDir(`${DATA_MOUNT_PATH}/newdir`);
			vfs.writeFile(`${DATA_MOUNT_PATH}/newdir/file.txt`, "test");

			// Verify via VirtualMachine
			const entries = await vm.readDir("/newdir");
			expect(entries).toContain("file.txt");
		});

		it("should normalize /data alone to root", async () => {
			vm = new VirtualMachine({ loadNpm: false });
			await vm.init();

			vm.writeFile("/root-file.txt", "at root");

			const vfs = vm.createVirtualFileSystem();
			// Reading /data should list root contents
			const entries = await vfs.readDir(DATA_MOUNT_PATH);

			expect(entries).toContain("root-file.txt");
		});

		it("should read binary files with path normalization", async () => {
			vm = new VirtualMachine({ loadNpm: false });
			await vm.init();

			const binaryData = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
			vm.writeFile("/image.png", binaryData);

			const vfs = vm.createVirtualFileSystem();
			// Read via /data prefix
			const result = await vfs.readFile(`${DATA_MOUNT_PATH}/image.png`);

			expect(result).toEqual(binaryData);
		});

		it("should remove file with /data prefix", async () => {
			vm = new VirtualMachine({ loadNpm: false });
			await vm.init();

			vm.writeFile("/to-remove.txt", "delete me");

			const vfs = vm.createVirtualFileSystem();
			// Remove via /data prefix
			await vfs.removeFile(`${DATA_MOUNT_PATH}/to-remove.txt`);

			// Verify file is gone
			expect(await vm.exists("/to-remove.txt")).toBe(false);
		});

		it("should handle nested paths with /data prefix", async () => {
			vm = new VirtualMachine({ loadNpm: false });
			await vm.init();

			vm.mkdir("/deep");
			vm.mkdir("/deep/nested");
			vm.mkdir("/deep/nested/path");
			vm.writeFile("/deep/nested/path/file.txt", "deep content");

			const vfs = vm.createVirtualFileSystem();
			// Read via /data prefix with full nested path
			const content = await vfs.readTextFile(
				`${DATA_MOUNT_PATH}/deep/nested/path/file.txt`,
			);

			expect(content).toBe("deep content");
		});
	});

	describe("paths without normalization (non-/data)", () => {
		it("should handle absolute paths correctly", async () => {
			vm = new VirtualMachine({ loadNpm: false });
			await vm.init();

			vm.mkdir("/etc");
			vm.writeFile("/etc/config.json", '{"key": "value"}');

			const vfs = vm.createVirtualFileSystem();
			// Direct path access (no /data prefix)
			const content = await vfs.readTextFile("/etc/config.json");
			expect(content).toBe('{"key": "value"}');
		});

		it("should handle paths in node_modules", async () => {
			vm = new VirtualMachine({ loadNpm: false });
			await vm.init();

			vm.mkdir("/node_modules");
			vm.mkdir("/node_modules/my-pkg");
			vm.writeFile(
				"/node_modules/my-pkg/package.json",
				'{"name": "my-pkg", "version": "1.0.0"}',
			);

			const vfs = vm.createVirtualFileSystem();

			// Direct path access
			const content = await vfs.readTextFile(
				"/node_modules/my-pkg/package.json",
			);
			expect(JSON.parse(content)).toEqual({
				name: "my-pkg",
				version: "1.0.0",
			});

			// Same path via /data prefix
			const content2 = await vfs.readTextFile(
				`${DATA_MOUNT_PATH}/node_modules/my-pkg/package.json`,
			);
			expect(JSON.parse(content2)).toEqual({
				name: "my-pkg",
				version: "1.0.0",
			});
		});
	});

	describe("shell fallback for WASM-only paths", () => {
		it("should read /bin directory via shell fallback", async () => {
			// This test verifies that paths not in Directory fall back to shell.
			// /bin exists in WASM (from webc - coreutils) but NOT in Directory.
			vm = new VirtualMachine({ loadNpm: false });
			await vm.init();

			// First verify that direct spawn works - /bin has coreutils
			const spawnResult = await vm.spawn("ls", ["-1", "/bin"]);
			expect(spawnResult.code).toBe(0);
			expect(spawnResult.stdout.length).toBeGreaterThan(0);

			const vfs = vm.createVirtualFileSystem();

			// This should fall back to 'ls' via shell
			const entries = await vfs.readDir("/bin");

			// These should exist in the webc's /bin (coreutils)
			expect(entries.length).toBeGreaterThan(0);
			// Verify we got actual binary names, not empty strings
			expect(entries.some((e) => e.length > 0)).toBe(true);
		});

		it("should NOT use shell fallback for /data paths that don't exist", async () => {
			vm = new VirtualMachine({ loadNpm: false });
			await vm.init();

			const vfs = vm.createVirtualFileSystem();

			// /data paths should NOT fall back to shell - they should throw
			await expect(
				vfs.readTextFile(`${DATA_MOUNT_PATH}/nonexistent.txt`),
			).rejects.toThrow();
		});

		it("should try Directory first, then shell fallback", async () => {
			vm = new VirtualMachine({ loadNpm: false });
			await vm.init();

			// Write file to Directory
			vm.writeFile("/myfile.txt", "from directory");

			const vfs = vm.createVirtualFileSystem();

			// File exists in Directory, should read from there (not shell)
			const content = await vfs.readTextFile("/myfile.txt");
			expect(content).toBe("from directory");
		});
	});
});
