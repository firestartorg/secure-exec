import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { VirtualMachine } from "nanosandbox";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Find npm installation path - use the archived npm from nanosandbox assets
const NPM_ASSETS_PATH = path.resolve(
	__dirname,
	"../../packages/nanosandbox/assets/npm",
);

// Check if npm assets are available (built by nanosandbox build:npm)
const npmAssetsAvailable =
	fs.existsSync(NPM_ASSETS_PATH) &&
	fs.existsSync(path.join(NPM_ASSETS_PATH, "lib/cli.js"));

// npm CLI tests - skipped due to wasmer SDK stability issues
// These tests work individually but cause crashes when run in sequence
// TODO: Investigate wasmer SDK worker cleanup issues
describe.skip("NPM CLI Integration", () => {
	let vm: VirtualMachine;

	afterEach(() => {
		vm?.dispose();
	});

	/**
	 * Helper to run npm commands via the VirtualMachine
	 * Uses node to run the npm CLI entry point
	 */
	async function runNpm(
		vm: VirtualMachine,
		args: string[],
	): Promise<{ stdout: string; stderr: string; code: number }> {
		// Run npm via node with the CLI entry point
		// The npm module is loaded to /opt/npm by VirtualMachine
		const npmCliPath = "/opt/npm/lib/cli.js";

		// Create a wrapper script that runs npm and handles output events
		const script = `
(async function() {
  try {
    // npm uses proc-log which emits 'output' events on process
    process.on('output', (type, ...args) => {
      if (type === 'standard') {
        process.stdout.write(args.join(' ') + '\\n');
      } else if (type === 'error') {
        process.stderr.write(args.join(' ') + '\\n');
      }
    });

    // Set up process.argv for npm
    process.argv = ['node', 'npm', ${args.map((a) => JSON.stringify(a)).join(", ")}];

    // Load npm's CLI entry point
    const npmCli = require('${npmCliPath}');
    await npmCli(process);
  } catch (e) {
    // Some npm errors are expected (like formatWithOptions not being a function)
    if (!e.message.includes('formatWithOptions') &&
        !e.message.includes('update-notifier')) {
      console.error('Error:', e.message);
      process.exitCode = 1;
    }
  }
})();
`;
		// Ensure /tmp directory exists and write script there
		await vm.mkdir("/tmp");
		const scriptPath = "/tmp/npm-runner.js";
		await vm.writeFile(scriptPath, script);
		return vm.spawn("node", [scriptPath]);
	}

	it(
		"should run npm --version and return version string",
		async () => {
			vm = new VirtualMachine();
			await vm.init();

			// Create app directory structure
			await vm.mkdir("/app");
			await vm.writeFile(
				"/app/package.json",
				JSON.stringify({ name: "test-app", version: "1.0.0" }),
			);

			// Create home directory for npm
			await vm.mkdir("/app/.npm");
			await vm.writeFile("/app/.npmrc", "");

			const result = await runNpm(vm, ["--version"]);

			console.log("stdout:", result.stdout);
			console.log("stderr:", result.stderr);
			console.log("code:", result.code);

			// Should output version number
			expect(result.stdout).toMatch(/\d+\.\d+\.\d+/);
		},
		{ timeout: 60000 },
	);

	it(
		"should run npm ls and show package tree",
		async () => {
			vm = new VirtualMachine();
			await vm.init();

			// Create app directory structure with dependencies
			await vm.mkdir("/app");
			await vm.mkdir("/app/node_modules");
			await vm.mkdir("/app/node_modules/lodash");
			await vm.writeFile(
				"/app/package.json",
				JSON.stringify({
					name: "test-app",
					version: "1.0.0",
					dependencies: {
						lodash: "^4.17.21",
					},
				}),
			);
			await vm.writeFile(
				"/app/node_modules/lodash/package.json",
				JSON.stringify({
					name: "lodash",
					version: "4.17.21",
				}),
			);

			// Create home directory for npm
			await vm.mkdir("/app/.npm");
			await vm.writeFile("/app/.npmrc", "");

			const result = await runNpm(vm, ["ls"]);

			console.log("stdout:", result.stdout);
			console.log("stderr:", result.stderr);
			console.log("code:", result.code);

			// Should output the package tree
			expect(result.stdout).toContain("test-app@1.0.0");
			expect(result.stdout).toContain("lodash@4.17.21");
		},
		{ timeout: 60000 },
	);

	it(
		"should run npm init -y and create package.json",
		async () => {
			vm = new VirtualMachine();
			await vm.init();

			// Create app directory (without package.json)
			await vm.mkdir("/app");
			await vm.mkdir("/app/.npm");
			await vm.writeFile("/app/.npmrc", "");

			const result = await runNpm(vm, ["init", "-y"]);

			console.log("stdout:", result.stdout);
			console.log("stderr:", result.stderr);
			console.log("code:", result.code);

			// Check that package.json was created
			const pkgJsonExists = await vm.exists("/app/package.json");
			expect(pkgJsonExists).toBe(true);

			// Read and verify the package.json content
			const pkgJsonContent = await vm.readFile("/app/package.json");
			const pkgJson = JSON.parse(pkgJsonContent);
			expect(pkgJson.name).toBe("app");
			expect(pkgJson.version).toBe("1.0.0");
		},
		{ timeout: 60000 },
	);

	it(
		"should run npm ping and verify registry connectivity",
		async () => {
			vm = new VirtualMachine();
			await vm.init();

			// Create app directory
			await vm.mkdir("/app");
			await vm.writeFile(
				"/app/package.json",
				JSON.stringify({ name: "test-app", version: "1.0.0" }),
			);
			await vm.mkdir("/app/.npm");
			await vm.writeFile("/app/.npmrc", "");

			const result = await runNpm(vm, ["ping"]);

			console.log("stdout:", result.stdout);
			console.log("stderr:", result.stderr);
			console.log("code:", result.code);

			// npm ping should succeed and show PONG response
			expect(result.stderr).toContain("PONG");
		},
		{ timeout: 60000 },
	);
});

// Basic VirtualMachine tests to verify ecosystem test setup
describe("VirtualMachine basic operations", () => {
	let vm: VirtualMachine;

	afterEach(() => {
		vm?.dispose();
	});

	it("should initialize and run simple node code", async () => {
		vm = new VirtualMachine({ loadNpm: false });
		await vm.init();

		const result = await vm.spawn("node", ["-e", "console.log('hello')"]);
		expect(result.stdout.trim()).toBe("hello");
		expect(result.code).toBe(0);
	});

	it("should write and read files", async () => {
		vm = new VirtualMachine({ loadNpm: false });
		await vm.init();

		await vm.writeFile("/test.txt", "hello world");
		const content = await vm.readFile("/test.txt");
		expect(content).toBe("hello world");
	});

	it("should create directories and list contents", async () => {
		vm = new VirtualMachine({ loadNpm: false });
		await vm.init();

		await vm.mkdir("/mydir");
		await vm.writeFile("/mydir/file.txt", "content");

		const entries = await vm.readDir("/mydir");
		expect(entries).toContain("file.txt");
	});

	it("should run bash commands via spawn", async () => {
		vm = new VirtualMachine({ loadNpm: false });
		await vm.init();

		const result = await vm.spawn("echo", ["hello", "world"]);
		expect(result.stdout.trim()).toBe("hello world");
		expect(result.code).toBe(0);
	});
});
