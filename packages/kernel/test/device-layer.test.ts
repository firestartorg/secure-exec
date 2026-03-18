import { describe, it, expect } from "vitest";
import { createDeviceLayer } from "../src/device-layer.js";
import { TestFileSystem } from "./helpers.js";

function createTestVfs() {
	return createDeviceLayer(new TestFileSystem());
}

describe("DeviceLayer", () => {
	it("/dev/null reads as empty", async () => {
		const vfs = createTestVfs();
		const data = await vfs.readFile("/dev/null");
		expect(data.length).toBe(0);
	});

	it("/dev/null write is discarded", async () => {
		const vfs = createTestVfs();
		await vfs.writeFile("/dev/null", "data");
		const readBack = await vfs.readFile("/dev/null");
		expect(readBack.length).toBe(0);
	});

	it("/dev/zero reads as zeros", async () => {
		const vfs = createTestVfs();
		const data = await vfs.readFile("/dev/zero");
		expect(data.length).toBe(4096);
		expect(data.every((b) => b === 0)).toBe(true);
	});

	it("/dev/urandom reads random bytes", async () => {
		const vfs = createTestVfs();
		const data = await vfs.readFile("/dev/urandom");
		expect(data.length).toBe(4096);
		// Very unlikely all zeros
		expect(data.some((b) => b !== 0)).toBe(true);
	});

	it("device paths exist", async () => {
		const vfs = createTestVfs();
		expect(await vfs.exists("/dev/null")).toBe(true);
		expect(await vfs.exists("/dev/zero")).toBe(true);
		expect(await vfs.exists("/dev/stdin")).toBe(true);
		expect(await vfs.exists("/dev/stdout")).toBe(true);
		expect(await vfs.exists("/dev/stderr")).toBe(true);
		expect(await vfs.exists("/dev/urandom")).toBe(true);
		expect(await vfs.exists("/dev")).toBe(true);
	});

	it("stat on device returns correct type", async () => {
		const vfs = createTestVfs();
		const stat = await vfs.stat("/dev/null");
		expect(stat.isDirectory).toBe(false);
		expect(stat.mode).toBe(0o666);
	});

	it("/dev is a directory", async () => {
		const vfs = createTestVfs();
		const stat = await vfs.stat("/dev");
		expect(stat.isDirectory).toBe(true);
	});

	it("readdir /dev lists devices", async () => {
		const vfs = createTestVfs();
		const entries = await vfs.readDir("/dev");
		expect(entries).toContain("null");
		expect(entries).toContain("zero");
		expect(entries).toContain("stdin");
	});

	it("cannot remove device nodes", async () => {
		const vfs = createTestVfs();
		await expect(vfs.removeFile("/dev/null")).rejects.toThrow("EPERM");
	});

	it("non-device paths pass through to backing VFS", async () => {
		const vfs = createTestVfs();
		await vfs.writeFile("/tmp/test.txt", "hello");
		const data = await vfs.readTextFile("/tmp/test.txt");
		expect(data).toBe("hello");
	});
});
