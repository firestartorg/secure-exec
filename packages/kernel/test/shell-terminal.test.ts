/**
 * Shell terminal tests using MockRuntimeDriver.
 *
 * All output assertions use exact-match on screenshotTrimmed().
 * No toContain(), no substring checks — the full screen state is asserted.
 * This ensures cursor positioning, echo, and output placement are correct.
 */

import { describe, it, expect, afterEach } from "vitest";
import { TerminalHarness } from "./terminal-harness.js";
import { createTestKernel } from "./helpers.js";
import type {
	RuntimeDriver,
	DriverProcess,
	ProcessContext,
	KernelInterface,
} from "../src/types.js";
import { SIGINT, SIGWINCH } from "../src/types.js";

// ---------------------------------------------------------------------------
// Mock shell driver — reads lines from PTY slave via kernel FDs, interprets
// simple commands (echo), writes output + prompt back through PTY.
// ---------------------------------------------------------------------------

class MockShellDriver implements RuntimeDriver {
	name = "mock-shell";
	commands = ["sh"];
	private ki: KernelInterface | null = null;

	async init(ki: KernelInterface): Promise<void> {
		this.ki = ki;
	}

	spawn(_command: string, _args: string[], ctx: ProcessContext): DriverProcess {
		const ki = this.ki!;
		const { pid } = ctx;
		const stdinFd = ctx.fds.stdin;
		const stdoutFd = ctx.fds.stdout;

		let exitResolve: (code: number) => void;
		const exitPromise = new Promise<number>((r) => {
			exitResolve = r;
		});

		const enc = new TextEncoder();
		const dec = new TextDecoder();

		const proc: DriverProcess = {
			writeStdin() {},
			closeStdin() {},
			kill(signal) {
				if (signal === SIGINT) {
					// SIGINT: show ^C, emit new prompt, keep running
					ki.fdWrite(pid, stdoutFd, enc.encode("^C\r\n$ "));
				} else if (signal === SIGWINCH) {
					// SIGWINCH: ignore, shell stays alive
				} else {
					exitResolve!(128 + signal);
					proc.onExit?.(128 + signal);
				}
			},
			wait() {
				return exitPromise;
			},
			onStdout: null,
			onStderr: null,
			onExit: null,
		};

		// Shell read-eval-print loop
		(async () => {
			// Write initial prompt
			ki.fdWrite(pid, stdoutFd, enc.encode("$ "));

			while (true) {
				const data = await ki.fdRead(pid, stdinFd, 4096);
				if (data.length === 0) {
					// EOF (^D on empty line)
					exitResolve!(0);
					proc.onExit?.(0);
					break;
				}

				const line = dec.decode(data).replace(/\n$/, "");

				// Simple command dispatch
				if (line.startsWith("echo ")) {
					ki.fdWrite(pid, stdoutFd, enc.encode(line.slice(5) + "\r\n"));
				} else if (line === "noecho") {
					// Disable PTY echo (password input scenario)
					ki.ptySetDiscipline(pid, stdinFd, { echo: false });
				} else if (line.length > 0) {
					// Unknown command — just emit a newline
					ki.fdWrite(pid, stdoutFd, enc.encode("\r\n"));
				}

				// Next prompt
				ki.fdWrite(pid, stdoutFd, enc.encode("$ "));
			}
		})().catch(() => {
			exitResolve!(1);
			proc.onExit?.(1);
		});

		return proc;
	}

	async dispose(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("shell-terminal", () => {
	let harness: TerminalHarness;

	afterEach(async () => {
		await harness?.dispose();
	});

	it("clean initial state — shell opens, screen shows prompt", async () => {
		const driver = new MockShellDriver();
		const { kernel } = await createTestKernel({ drivers: [driver] });
		harness = new TerminalHarness(kernel);

		await harness.waitFor("$");

		expect(harness.screenshotTrimmed()).toBe("$ ");
	});

	it("echo on input — typed text appears on screen via PTY echo", async () => {
		const driver = new MockShellDriver();
		const { kernel } = await createTestKernel({ drivers: [driver] });
		harness = new TerminalHarness(kernel);

		await harness.waitFor("$");
		await harness.type("hello");

		expect(harness.screenshotTrimmed()).toBe("$ hello");
	});

	it("command output on correct line — output appears below input", async () => {
		const driver = new MockShellDriver();
		const { kernel } = await createTestKernel({ drivers: [driver] });
		harness = new TerminalHarness(kernel);

		await harness.waitFor("$");
		await harness.type("echo hello\n");

		expect(harness.screenshotTrimmed()).toBe(
			["$ echo hello", "hello", "$ "].join("\n"),
		);
	});

	it("output preservation — multiple commands, all previous output visible", async () => {
		const driver = new MockShellDriver();
		const { kernel } = await createTestKernel({ drivers: [driver] });
		harness = new TerminalHarness(kernel);

		await harness.waitFor("$");
		await harness.type("echo AAA\n");
		await harness.type("echo BBB\n");

		expect(harness.screenshotTrimmed()).toBe(
			["$ echo AAA", "AAA", "$ echo BBB", "BBB", "$ "].join("\n"),
		);
	});

	it("^C sends SIGINT — screen shows ^C, shell stays alive, can type more", async () => {
		const driver = new MockShellDriver();
		const { kernel } = await createTestKernel({ drivers: [driver] });
		harness = new TerminalHarness(kernel);

		await harness.waitFor("$");

		// Type partial input then ^C
		await harness.type("hel\x03");

		// PTY echo shows "hel", ^C triggers SIGINT (no echo from PTY),
		// mock shell writes "^C\r\n$ " in kill handler
		expect(harness.screenshotTrimmed()).toBe(
			["$ hel^C", "$ "].join("\n"),
		);

		// Shell stays alive — type another command
		await harness.type("echo hi\n");

		expect(harness.screenshotTrimmed()).toBe(
			["$ hel^C", "$ echo hi", "hi", "$ "].join("\n"),
		);
	});

	it("^D exits cleanly — shell exits with code 0, no extra output", async () => {
		const driver = new MockShellDriver();
		const { kernel } = await createTestKernel({ drivers: [driver] });
		harness = new TerminalHarness(kernel);

		await harness.waitFor("$");

		const exitCode = await harness.exit();

		expect(exitCode).toBe(0);
		expect(harness.screenshotTrimmed()).toBe("$ ");
	});

	it("backspace erases character — 'helo' + BS + 'lo' produces 'hello'", async () => {
		const driver = new MockShellDriver();
		const { kernel } = await createTestKernel({ drivers: [driver] });
		harness = new TerminalHarness(kernel);

		await harness.waitFor("$");

		// Type "echo helo", backspace erases 'o', then "lo\n" → shell receives "echo hello"
		await harness.type("echo helo\x7flo\n");

		expect(harness.screenshotTrimmed()).toBe(
			["$ echo hello", "hello", "$ "].join("\n"),
		);
	});

	it("long line wrapping — input exceeding cols wraps to next row", async () => {
		const driver = new MockShellDriver();
		const { kernel } = await createTestKernel({ drivers: [driver] });
		harness = new TerminalHarness(kernel, { cols: 20, rows: 24 });

		await harness.waitFor("$");

		// "$ " = 2 chars, leaves 18 chars on first row. 25 A's forces wrap.
		const input = "A".repeat(25);
		await harness.type(input);

		expect(harness.screenshotTrimmed()).toBe(
			"$ " + "A".repeat(18) + "\n" + "A".repeat(7),
		);
	});

	it("resize triggers SIGWINCH — shell stays alive, prompt returns", async () => {
		const driver = new MockShellDriver();
		const { kernel } = await createTestKernel({ drivers: [driver] });
		harness = new TerminalHarness(kernel);

		await harness.waitFor("$");

		// Resize terminal — delivers SIGWINCH to foreground process group
		harness.term.resize(40, 12);
		harness.shell.resize(40, 12);

		// Shell survives SIGWINCH — verify by typing a command
		await harness.type("echo alive\n");

		expect(harness.screenshotTrimmed()).toBe(
			["$ echo alive", "alive", "$ "].join("\n"),
		);
	});

	it("echo disabled — typed text does NOT appear on screen", async () => {
		const driver = new MockShellDriver();
		const { kernel } = await createTestKernel({ drivers: [driver] });
		harness = new TerminalHarness(kernel);

		await harness.waitFor("$");

		// "noecho" command disables PTY echo via ptySetDiscipline
		await harness.type("noecho\n");

		const screenAfterNoecho = harness.screenshotTrimmed();
		expect(screenAfterNoecho).toBe(["$ noecho", "$ "].join("\n"));

		// Type "secret" with echo off — should NOT appear on screen
		await harness.type("secret");

		expect(harness.screenshotTrimmed()).toBe(screenAfterNoecho);
	});
});
