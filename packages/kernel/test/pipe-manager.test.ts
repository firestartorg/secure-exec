import { describe, it, expect } from "vitest";
import { PipeManager } from "../src/pipe-manager.js";

describe("PipeManager", () => {
	it("creates a pipe with read and write ends", () => {
		const manager = new PipeManager();
		const { read, write } = manager.createPipe();

		expect(read.description.id).not.toBe(write.description.id);
		expect(manager.isPipe(read.description.id)).toBe(true);
		expect(manager.isPipe(write.description.id)).toBe(true);
	});

	it("write then read delivers data", async () => {
		const manager = new PipeManager();
		const { read, write } = manager.createPipe();

		const data = new TextEncoder().encode("hello");
		manager.write(write.description.id, data);

		const result = await manager.read(read.description.id, 1024);
		expect(new TextDecoder().decode(result!)).toBe("hello");
	});

	it("read blocks until write", async () => {
		const manager = new PipeManager();
		const { read, write } = manager.createPipe();

		// Start read (will block)
		const readPromise = manager.read(read.description.id, 1024);

		// Write after a delay
		setTimeout(() => {
			manager.write(write.description.id, new TextEncoder().encode("delayed"));
		}, 10);

		const result = await readPromise;
		expect(new TextDecoder().decode(result!)).toBe("delayed");
	});

	it("read returns null (EOF) when write end is closed", async () => {
		const manager = new PipeManager();
		const { read, write } = manager.createPipe();

		manager.close(write.description.id);

		const result = await manager.read(read.description.id, 1024);
		expect(result).toBeNull();
	});

	it("close write end delivers EOF to waiting readers", async () => {
		const manager = new PipeManager();
		const { read, write } = manager.createPipe();

		const readPromise = manager.read(read.description.id, 1024);

		setTimeout(() => {
			manager.close(write.description.id);
		}, 10);

		const result = await readPromise;
		expect(result).toBeNull();
	});

	it("isPipe returns false for non-pipe descriptors", () => {
		const manager = new PipeManager();
		expect(manager.isPipe(999)).toBe(false);
	});

	it("multiple writes accumulate in buffer", async () => {
		const manager = new PipeManager();
		const { read, write } = manager.createPipe();

		manager.write(write.description.id, new TextEncoder().encode("hello "));
		manager.write(write.description.id, new TextEncoder().encode("world"));

		// Read drains all buffered chunks up to requested length
		const result = await manager.read(read.description.id, 1024);
		expect(new TextDecoder().decode(result!)).toBe("hello world");
	});
});
