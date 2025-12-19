import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Directory, Wasmer, Runtime } from "@wasmer/sdk/node";
import { NodeProcess } from "sandboxed-node";

export interface VirtualMachineOptions {
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	memoryLimit?: number;
	/** Input to pass to the command's stdin */
	stdin?: string;
}

interface TerminalOptions {
	term: string;
	cols: number;
	rows: number;
}

interface HostExecContext {
	command: string;
	args: string[];
	env: Record<string, string>;
	cwd: string;
	stdin: ReadableStream<Uint8Array> | null;
	stdout: WritableStream<Uint8Array> | null;
	stderr: WritableStream<Uint8Array> | null;
	// Streaming callbacks for output
	onStdout?: (data: Uint8Array) => void;
	onStderr?: (data: Uint8Array) => void;
	// Stdin write callbacks - set by handler, called by scheduler
	setStdinWriter?: (writer: (data: Uint8Array) => void, closer: () => void) => void;
	// Kill/signal function callback - set by handler, called by scheduler
	setKillFunction?: (killFn: (signal: number) => void) => void;
	// Terminal options (if set, apply TERM/COLUMNS/LINES to env)
	terminal?: TerminalOptions;
}

const DATA_MOUNT_PATH = "/data";

let runtimePackage: Awaited<ReturnType<typeof Wasmer.fromFile>> | null = null;
let wasmerRuntime: Runtime | null = null;

/**
 * Handle host_exec syscalls from WASM.
 *
 * For "node" commands, uses sandboxed-node's NodeProcess (V8 isolate) instead
 * of spawning a real process. This is faster and more secure.
 *
 * Streams stdout/stderr via the onStdout/onStderr callbacks.
 */

// Counter for generating unique PIDs for sandboxed processes
let nextPid = 1000;

/**
 * Parse node command line arguments to extract code/file and options.
 */
function parseNodeArgs(args: string[]): {
	code: string | null;
	file: string | null;
	evalCode: boolean;
	printResult: boolean;
	nodeArgs: string[];
} {
	let code: string | null = null;
	let file: string | null = null;
	let evalCode = false;
	let printResult = false;
	const nodeArgs: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];

		if (arg === "-e" || arg === "--eval") {
			evalCode = true;
			code = args[++i] || "";
		} else if (arg === "-p" || arg === "--print") {
			evalCode = true;
			printResult = true;
			code = args[++i] || "";
		} else if (arg === "-c" || arg === "--check") {
			// Syntax check only - we'll just parse it
			code = args[++i] || "";
		} else if (arg === "-r" || arg === "--require") {
			// Skip require for now
			i++;
		} else if (arg === "--input-type" || arg === "--experimental-loader") {
			// Skip these flags
			i++;
		} else if (arg.startsWith("-")) {
			// Skip other flags
		} else if (!file && !evalCode) {
			// First non-flag argument is the script file
			file = arg;
			// Remaining args are passed to the script
			nodeArgs.push(...args.slice(i + 1));
			break;
		}
	}

	return { code, file, evalCode, printResult, nodeArgs };
}

async function hostExecHandler(ctx: HostExecContext): Promise<number> {
	console.error(`[host_exec] command=${ctx.command} args=${JSON.stringify(ctx.args)}`);

	// Check if this is a node command - use sandboxed-node for V8 acceleration
	const isNodeCommand = ctx.command === "node" || ctx.command.endsWith("/node");

	if (isNodeCommand) {
		return handleNodeCommand(ctx);
	}

	// For non-node commands, return error (not supported in sandbox)
	console.error(`[host_exec] unsupported command: ${ctx.command}`);
	const errorMsg = `Error: Command '${ctx.command}' is not supported in sandbox. Only 'node' is available.\n`;
	if (ctx.onStderr) {
		ctx.onStderr(new TextEncoder().encode(errorMsg));
	}
	return 1;
}

/**
 * Handle node commands using sandboxed-node's NodeProcess (V8 isolate).
 */
async function handleNodeCommand(ctx: HostExecContext): Promise<number> {
	const { code, file, evalCode, printResult, nodeArgs } = parseNodeArgs(ctx.args);

	// Generate a unique PID for this sandboxed process
	const pid = nextPid++;

	// Build argv for the sandboxed process
	const argv = ["node"];
	if (file) {
		argv.push(file, ...nodeArgs);
	} else if (evalCode) {
		argv.push("-e", code || "");
	}

	// Create NodeProcess with context from host_exec
	const nodeProcess = new NodeProcess({
		memoryLimit: 128,
		processConfig: {
			pid,
			ppid: 1, // WASM shell is parent
			cwd: ctx.cwd || "/",
			env: ctx.env || {},
			argv,
			platform: "linux",
			arch: "x64",
		},
		// TODO: Add filesystem when VFS is passed through HostExecContext
	});

	// Register kill function - disposes the isolate
	if (ctx.setKillFunction) {
		ctx.setKillFunction((_signal: number) => {
			console.error(`[host_exec] killing NodeProcess pid=${pid}`);
			nodeProcess.dispose();
		});
	}

	// TODO: stdin support - NodeProcess doesn't support streaming stdin yet
	// For now, just close stdin immediately
	if (ctx.setStdinWriter) {
		ctx.setStdinWriter(
			(_data: Uint8Array) => {
				// Stdin not supported yet
			},
			() => {
				// Close - no-op
			}
		);
	}

	try {
		let result: { stdout: string; stderr: string; code: number };

		if (evalCode && code) {
			// Execute inline code with -e flag
			let codeToRun = code;
			if (printResult) {
				// -p flag: wrap code to print the result
				codeToRun = `console.log(${code})`;
			}
			result = await nodeProcess.exec(codeToRun);
		} else if (file) {
			// TODO: Execute script file - needs VFS access
			// For now, return error
			const errorMsg = `Error: File execution not yet supported. Use 'node -e "code"' instead.\n`;
			if (ctx.onStderr) {
				ctx.onStderr(new TextEncoder().encode(errorMsg));
			}
			nodeProcess.dispose();
			return 1;
		} else {
			// No code or file specified
			const errorMsg = "Error: No script or code provided to node\n";
			if (ctx.onStderr) {
				ctx.onStderr(new TextEncoder().encode(errorMsg));
			}
			nodeProcess.dispose();
			return 1;
		}

		// Stream stdout/stderr back to WASM
		if (result.stdout && ctx.onStdout) {
			ctx.onStdout(new TextEncoder().encode(result.stdout));
		}
		if (result.stderr && ctx.onStderr) {
			ctx.onStderr(new TextEncoder().encode(result.stderr));
		}

		console.error(`[host_exec] NodeProcess pid=${pid} exited with code=${result.code}`);

		nodeProcess.dispose();
		return result.code;
	} catch (err) {
		const errorMsg = `Error: ${err instanceof Error ? err.message : String(err)}\n`;
		if (ctx.onStderr) {
			ctx.onStderr(new TextEncoder().encode(errorMsg));
		}
		nodeProcess.dispose();
		return 1;
	}
}

async function loadRuntimePackage(): Promise<Awaited<ReturnType<typeof Wasmer.fromFile>>> {
	if (!runtimePackage) {
		// Create runtime and set host_exec handler
		wasmerRuntime = new Runtime();
		wasmerRuntime.setHostExecHandler(hostExecHandler);

		const currentDir = path.dirname(fileURLToPath(import.meta.url));
		const webcPath = path.resolve(currentDir, "../../assets/runtime.webc");
		const webcBytes = await fs.readFile(webcPath);
		runtimePackage = await Wasmer.fromFile(webcBytes, wasmerRuntime);
	}
	return runtimePackage;
}

/**
 * VirtualMachine represents the result of running a command.
 */
export class VirtualMachine {
	public stdout = "";
	public stderr = "";
	public code = 0;

	private command: string;
	private options: VirtualMachineOptions;

	constructor(command: string, options: VirtualMachineOptions = {}) {
		this.command = command;
		this.options = options;
	}

	/**
	 * Execute the command. Called by Runtime.run().
	 */
	async setup(): Promise<void> {
		const pkg = await loadRuntimePackage();

		const cmd = pkg.commands[this.command];
		if (!cmd) {
			throw new Error(`Command not found: ${this.command}`);
		}

		const { args = [], env, cwd, stdin } = this.options;

		const directory = new Directory();

		const instance = await cmd.run({
			args,
			env,
			cwd,
			stdin,
			mount: {
				[DATA_MOUNT_PATH]: directory,
			},
		});

		const result = await instance.wait();

		this.stdout = result.stdout;
		this.stderr = result.stderr;
		this.code = result.code ?? 0;
	}
}
