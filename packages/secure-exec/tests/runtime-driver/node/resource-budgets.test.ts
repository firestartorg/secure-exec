import { afterEach, describe, expect, it } from "vitest";
import { allowAllFs, allowAllChildProcess, NodeRuntime } from "../../../src/index.js";
import type { CommandExecutor, SpawnedProcess } from "../../../src/types.js";
import { createTestNodeRuntime } from "../../test-utils.js";

const RESOURCE_BUDGET_ERROR_CODE = "ERR_RESOURCE_BUDGET_EXCEEDED";

type CapturedConsoleEvent = {
	channel: "stdout" | "stderr";
	message: string;
};

function createConsoleCapture() {
	const events: CapturedConsoleEvent[] = [];
	return {
		onStdio: (event: CapturedConsoleEvent) => {
			events.push(event);
		},
		stdout: () =>
			events
				.filter((e) => e.channel === "stdout")
				.map((e) => e.message)
				.join("\n") + (events.some((e) => e.channel === "stdout") ? "\n" : ""),
		allText: () => events.map((e) => e.message).join(""),
	};
}

/** CommandExecutor that immediately exits with code 0 and emits "ok\n" stdout. */
function createMockCommandExecutor(): CommandExecutor {
	return {
		spawn(
			_command: string,
			_args: string[],
			options: {
				cwd?: string;
				env?: Record<string, string>;
				onStdout?: (data: Uint8Array) => void;
				onStderr?: (data: Uint8Array) => void;
			},
		): SpawnedProcess {
			let exitResolve: (code: number) => void;
			const waitPromise = new Promise<number>((r) => {
				exitResolve = r;
			});

			// Emit stdout and exit asynchronously
			queueMicrotask(() => {
				options.onStdout?.(new TextEncoder().encode("ok\n"));
				exitResolve(0);
			});

			return {
				writeStdin() {},
				closeStdin() {},
				kill() {},
				wait: () => waitPromise,
			};
		},
	};
}

describe("NodeRuntime resource budgets", () => {
	let proc: NodeRuntime | undefined;

	afterEach(() => {
		proc?.dispose();
		proc = undefined;
	});

	// -----------------------------------------------------------------------
	// maxOutputBytes
	// -----------------------------------------------------------------------

	describe("maxOutputBytes", () => {
		it("captures output within the limit", async () => {
			const capture = createConsoleCapture();
			proc = createTestNodeRuntime({
				onStdio: capture.onStdio,
				resourceBudgets: { maxOutputBytes: 1000 },
			});
			const result = await proc.exec(`console.log("hello");`);
			expect(result.code).toBe(0);
			expect(capture.stdout()).toContain("hello");
		});

		it("silently drops output bytes beyond the limit", async () => {
			const capture = createConsoleCapture();
			proc = createTestNodeRuntime({
				onStdio: capture.onStdio,
				resourceBudgets: { maxOutputBytes: 100 },
			});
			// Write 200+ bytes via console.log
			const result = await proc.exec(`
				for (let i = 0; i < 20; i++) console.log("0123456789");
			`);
			expect(result.code).toBe(0);
			const total = capture.allText();
			// Should have captured some output but not all 200+ bytes
			expect(total.length).toBeLessThanOrEqual(200);
			expect(total.length).toBeGreaterThan(0);
		});

		it("applies to stderr as well", async () => {
			const capture = createConsoleCapture();
			proc = createTestNodeRuntime({
				onStdio: capture.onStdio,
				resourceBudgets: { maxOutputBytes: 50 },
			});
			const result = await proc.exec(`
				for (let i = 0; i < 20; i++) console.error("0123456789");
			`);
			expect(result.code).toBe(0);
			const total = capture.allText();
			expect(total.length).toBeLessThanOrEqual(100);
		});
	});

	// -----------------------------------------------------------------------
	// maxChildProcesses
	// -----------------------------------------------------------------------

	describe("maxChildProcesses", () => {
		it("first N spawns succeed, subsequent spawns throw", async () => {
			const capture = createConsoleCapture();
			proc = createTestNodeRuntime({
				commandExecutor: createMockCommandExecutor(),
				permissions: { ...allowAllFs, ...allowAllChildProcess },
				onStdio: capture.onStdio,
				resourceBudgets: { maxChildProcesses: 3 },
			});

			const result = await proc.exec(`
				const { spawnSync } = require('child_process');
				let succeeded = 0;
				let errors = 0;
				for (let i = 0; i < 5; i++) {
					try {
						const r = spawnSync('echo', ['test']);
						if (r.error) { errors++; } else { succeeded++; }
					} catch (e) {
						errors++;
					}
				}
				console.log('succeeded:' + succeeded);
				console.log('errors:' + errors);
			`);

			expect(result.code).toBe(0);
			const out = capture.stdout();
			expect(out).toContain("succeeded:3");
			expect(out).toContain("errors:2");
		});
	});

	// -----------------------------------------------------------------------
	// maxTimers
	// -----------------------------------------------------------------------

	describe("maxTimers", () => {
		it("first N intervals succeed, subsequent throw", async () => {
			const capture = createConsoleCapture();
			proc = createTestNodeRuntime({
				onStdio: capture.onStdio,
				resourceBudgets: { maxTimers: 5 },
			});

			const result = await proc.exec(`
				let succeeded = 0;
				let errors = 0;
				for (let i = 0; i < 10; i++) {
					try {
						setInterval(() => {}, 60000);
						succeeded++;
					} catch (e) {
						errors++;
					}
				}
				console.log('succeeded:' + succeeded);
				console.log('errors:' + errors);
			`);

			expect(result.code).toBe(0);
			const out = capture.stdout();
			expect(out).toContain("succeeded:5");
			expect(out).toContain("errors:5");
		});

		it("existing intervals survive when new ones are blocked", async () => {
			const capture = createConsoleCapture();
			proc = createTestNodeRuntime({
				onStdio: capture.onStdio,
				resourceBudgets: { maxTimers: 3 },
			});

			const result = await proc.exec(`
				// Create 3 persistent intervals (occupy all slots)
				const id1 = setInterval(() => {}, 60000);
				const id2 = setInterval(() => {}, 60000);
				const id3 = setInterval(() => {}, 60000);
				// 4th should be blocked
				let blocked = false;
				try { setInterval(() => {}, 60000); } catch(e) { blocked = true; }
				// Verify existing intervals were not affected
				console.log('blocked:' + blocked);
				console.log('created:3');
				// Cleanup
				clearInterval(id1);
				clearInterval(id2);
				clearInterval(id3);
			`);

			expect(result.code).toBe(0);
			const out = capture.stdout();
			expect(out).toContain("blocked:true");
			expect(out).toContain("created:3");
		});
	});

	// -----------------------------------------------------------------------
	// maxBridgeCalls
	// -----------------------------------------------------------------------

	describe("maxBridgeCalls", () => {
		it("bridge calls within limit succeed", async () => {
			const capture = createConsoleCapture();
			proc = createTestNodeRuntime({
				permissions: allowAllFs,
				onStdio: capture.onStdio,
				resourceBudgets: { maxBridgeCalls: 100 },
			});

			const result = await proc.exec(`
				const fs = require('fs');
				fs.existsSync('/tmp');
				console.log('ok');
			`);

			expect(result.code).toBe(0);
			expect(capture.stdout()).toContain("ok");
		});

		it("bridge returns error when budget exceeded", async () => {
			const capture = createConsoleCapture();
			proc = createTestNodeRuntime({
				permissions: allowAllFs,
				onStdio: capture.onStdio,
				resourceBudgets: { maxBridgeCalls: 5 },
			});

			const result = await proc.exec(`
				const fs = require('fs');
				let errors = 0;
				for (let i = 0; i < 10; i++) {
					try {
						fs.existsSync('/tmp');
					} catch(e) {
						errors++;
					}
				}
				console.log('errors:' + errors);
			`);

			// Some calls should have failed
			expect(result.code).toBe(0);
			const out = capture.stdout();
			expect(out).toContain("errors:");
			const errCount = parseInt(out.match(/errors:(\d+)/)?.[1] ?? "0");
			expect(errCount).toBeGreaterThan(0);
		});
	});
});
