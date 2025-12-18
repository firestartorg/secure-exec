import { Directory } from "@wasmer/sdk/node";
import { NodeProcess } from "sandboxed-node";
import { after, before, describe, it } from "node:test";
import assert from "node:assert";
import { DATA_MOUNT_PATH, WasixInstance, ensureWasmerInitialized } from "../src/wasix/index.js";

// Keep event loop alive - required for wasmer-js workers in Node.js
// The wasmer SDK's web-worker based threading doesn't properly keep the event loop alive
const keepAlive = setInterval(() => {}, 1000);

describe("WasixInstance", () => {
	before(async () => {
		await ensureWasmerInitialized();
	});

	after(() => {
		clearInterval(keepAlive);
	});

	// Note: wasmer-js has a scheduler issue where running multiple WASM commands
	// in the same test block causes hangs. Each test should run only ONE command.
	describe("Step 6: Basic WASM shell", () => {
		it("should execute echo command", async () => {
			const wasix = new WasixInstance();
			const result = await wasix.run("echo", ["hello"]);
			assert.strictEqual(result.stdout.trim(), "hello");
			assert.strictEqual(result.code, 0);
		});

		it("should execute ls with directory", async () => {
			const dir = new Directory();
			dir.writeFile("/test.txt", "content");
			const wasix = new WasixInstance({ directory: dir });
			const result = await wasix.run("ls", [DATA_MOUNT_PATH]);
			assert.ok(result.stdout.includes("test.txt"));
			assert.strictEqual(result.code, 0);
		});

		// Note: Tests beyond 2 WASM commands may hang due to wasmer-js scheduler issues
		// in Node.js. Skipping tests 3+ for now until wasmer-js fixes the scheduler.
		it.skip("should execute cat with directory", async () => {
			const dir = new Directory();
			dir.writeFile("/hello.txt", "Hello World");
			const wasix = new WasixInstance({ directory: dir });
			const result = await wasix.run("cat", [`${DATA_MOUNT_PATH}/hello.txt`]);
			assert.strictEqual(result.stdout, "Hello World");
			assert.strictEqual(result.code, 0);
		});

		it.skip("should execute shell command via bash/sh", async () => {
			const wasix = new WasixInstance();
			const result = await wasix.exec("echo hello");
			assert.ok(result.stdout.includes("hello"));
		});

		it("should expose getDirectory", async () => {
			const dir = new Directory();
			const wasix = new WasixInstance({ directory: dir });
			assert.strictEqual(wasix.getDirectory(), dir);
		});

		it.skip("should execute script from mounted directory", async () => {
			const dir = new Directory();
			dir.writeFile("/myscript.sh", "#!/bin/bash\necho 'script ran'");
			const wasix = new WasixInstance({ directory: dir });
			const result = await wasix.exec(`bash ${DATA_MOUNT_PATH}/myscript.sh`);
			assert.ok(result.stdout.includes("script ran"));
		});

		it.skip("should test mount at subpath", async () => {
			const dir = new Directory();
			await dir.writeFile("/test.txt", "file at root of mount");
			const wasix = new WasixInstance({ directory: dir });
			const result = await wasix.run("ls", [DATA_MOUNT_PATH]);
			assert.ok(result.stdout.includes("test.txt"));
		});
	});

	// These tests use raw Wasmer SDK and are skipped due to the multi-command
	// scheduler issue - they run multiple commands per test
	describe.skip("Step 6b: Advanced shell tests (skipped - multi-command issue)", () => {
		it("should test subpath mount with nested dirs via runCommand", async () => {
			const dir = new Directory();
			await dir.createDir("/mydir");
			await dir.writeFile("/mydir/nested.txt", "nested content");

			const { Wasmer } = await import("@wasmer/sdk/node");
			const nodePath = await import("node:path");
			const nodeUrl = await import("node:url");
			const nodeFs = await import("node:fs/promises");
			const __dirname = nodePath.dirname(
				nodeUrl.fileURLToPath(import.meta.url),
			);
			const runtimePath = nodePath.join(__dirname, "../dist/runtime.webc");

			const webcBytes = await nodeFs.readFile(runtimePath);
			const pkg = await Wasmer.fromFile(webcBytes);

			const catCmd = pkg.commands["cat"];
			const catResult = await (
				await catCmd.run({
					args: ["/mnt/mydir/nested.txt"],
					mount: { "/mnt": dir },
				})
			).wait();

			assert.ok(catResult.stdout.includes("nested content"));
		});

		it("should run bash script from subpath mount", async () => {
			const dir = new Directory();
			await dir.createDir("/scripts");
			await dir.writeFile(
				"/scripts/hello.sh",
				"#!/bin/bash\necho 'Hello from subpath mount!'",
			);

			const { Wasmer } = await import("@wasmer/sdk/node");
			const nodePath = await import("node:path");
			const nodeUrl = await import("node:url");
			const nodeFs = await import("node:fs/promises");
			const __dirname = nodePath.dirname(
				nodeUrl.fileURLToPath(import.meta.url),
			);
			const runtimePath = nodePath.join(__dirname, "../dist/runtime.webc");

			const webcBytes = await nodeFs.readFile(runtimePath);
			const pkg = await Wasmer.fromFile(webcBytes);

			const bashCmd = pkg.commands["bash"];
			const result = await (
				await bashCmd.run({
					args: ["-c", "bash /mnt/scripts/hello.sh"],
					mount: { "/mnt": dir },
				})
			).wait();

			assert.ok(result.stdout.includes("Hello from subpath mount!"));
		});
	});

	// Note: Skipped due to wasmer-js scheduler issues (same as Step 6)
	describe.skip("Step 7: IPC polling for node shim", () => {
		it("should run node command via IPC with real node", async () => {
			const wasix = new WasixInstance();
			const result = await wasix.runWithIpc("node", ["-e", "console.log(2+2)"]);
			assert.ok(result.stdout.includes("4"));
		});

		it("should run node command via IPC with NodeProcess", async () => {
			const nodeProcess = new NodeProcess();
			try {
				const wasix = new WasixInstance({ nodeProcess });
				const result = await wasix.runWithIpc("node", [
					"-e",
					"console.log('Hello from NodeProcess')",
				]);
				assert.ok(result.stdout.includes("Hello from NodeProcess"));
			} finally {
				nodeProcess.dispose();
			}
		});

		it("should run bash script that calls node via IPC", async () => {
			const nodeProcess = new NodeProcess();
			try {
				const wasix = new WasixInstance({ nodeProcess });
				const result = await wasix.runWithIpc("bash", [
					"-c",
					"echo 'Before node' && node -e \"console.log('From node')\" && echo 'After node'",
				]);
				assert.ok(result.stdout.includes("Before node"));
				assert.ok(result.stdout.includes("From node"));
				assert.ok(result.stdout.includes("After node"));
			} finally {
				nodeProcess.dispose();
			}
		});
	});
});
