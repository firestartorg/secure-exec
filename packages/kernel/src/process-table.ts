/**
 * Process table.
 *
 * Universal process tracking across all runtimes. Owns PID allocation,
 * parent-child relationships, waitpid, and signal routing. A WasmVM
 * shell can waitpid on a Node child process.
 */

import type { DriverProcess, ProcessContext, ProcessEntry, ProcessInfo } from "./types.js";
import { KernelError } from "./types.js";

const ZOMBIE_TTL_MS = 60_000;

export class ProcessTable {
	private entries: Map<number, ProcessEntry> = new Map();
	private nextPid = 1;
	private waiters: Map<number, Array<(info: { pid: number; status: number }) => void>> = new Map();
	private zombieTimers: Map<number, ReturnType<typeof setTimeout>> = new Map();

	/** Called when a process exits, before waiters are notified. */
	onProcessExit: ((pid: number) => void) | null = null;

	/** Atomically allocate the next PID. */
	allocatePid(): number {
		return this.nextPid++;
	}

	/** Register a process with a pre-allocated PID. */
	register(
		pid: number,
		driver: string,
		command: string,
		args: string[],
		ctx: ProcessContext,
		driverProcess: DriverProcess,
	): ProcessEntry {
		// Inherit pgid/sid from parent, or default to own pid (session leader)
		const parent = ctx.ppid ? this.entries.get(ctx.ppid) : undefined;
		const pgid = parent?.pgid ?? pid;
		const sid = parent?.sid ?? pid;

		const entry: ProcessEntry = {
			pid,
			ppid: ctx.ppid,
			pgid,
			sid,
			driver,
			command,
			args,
			status: "running",
			exitCode: null,
			exitTime: null,
			env: { ...ctx.env },
			cwd: ctx.cwd,
			driverProcess,
		};
		this.entries.set(pid, entry);

		// Wire up exit callback to mark process as exited
		driverProcess.onExit = (code: number) => {
			this.markExited(pid, code);
		};

		return entry;
	}

	get(pid: number): ProcessEntry | undefined {
		return this.entries.get(pid);
	}

	/** Count running (non-exited) processes. */
	runningCount(): number {
		let count = 0;
		for (const entry of this.entries.values()) {
			if (entry.status === "running") count++;
		}
		return count;
	}

	/** Mark a process as exited with the given code. Notifies waiters. */
	markExited(pid: number, exitCode: number): void {
		const entry = this.entries.get(pid);
		if (!entry) return;
		if (entry.status === "exited") return;

		entry.status = "exited";
		entry.exitCode = exitCode;
		entry.exitTime = Date.now();

		// Clean up process resources (FD table, pipe ends)
		this.onProcessExit?.(pid);

		// Notify waiters
		const waiters = this.waiters.get(pid);
		if (waiters) {
			for (const resolve of waiters) {
				resolve({ pid, status: exitCode });
			}
			this.waiters.delete(pid);
		}

		// Schedule zombie cleanup (tracked for cancellation on dispose)
		const timer = setTimeout(() => {
			this.zombieTimers.delete(pid);
			this.reap(pid);
		}, ZOMBIE_TTL_MS);
		this.zombieTimers.set(pid, timer);
	}

	/**
	 * Wait for a process to exit.
	 * If already exited, resolves immediately. Otherwise blocks until exit.
	 */
	waitpid(pid: number): Promise<{ pid: number; status: number }> {
		const entry = this.entries.get(pid);
		if (!entry) {
			return Promise.reject(new Error(`ESRCH: no such process ${pid}`));
		}

		if (entry.status === "exited") {
			return Promise.resolve({ pid, status: entry.exitCode! });
		}

		return new Promise((resolve) => {
			let waiters = this.waiters.get(pid);
			if (!waiters) {
				waiters = [];
				this.waiters.set(pid, waiters);
			}
			waiters.push(resolve);
		});
	}

	/**
	 * Send a signal to a process or process group.
	 * If pid > 0, signal a single process.
	 * If pid < 0, signal all processes in process group abs(pid).
	 */
	kill(pid: number, signal: number): void {
		if (pid < 0) {
			// Process group kill
			const pgid = -pid;
			let found = false;
			for (const entry of this.entries.values()) {
				if (entry.pgid === pgid && entry.status === "running") {
					found = true;
					entry.driverProcess.kill(signal);
				}
			}
			if (!found) throw new KernelError("ESRCH", `no such process group ${pgid}`);
			return;
		}
		const entry = this.entries.get(pid);
		if (!entry) throw new KernelError("ESRCH", `no such process ${pid}`);
		if (entry.status === "exited") return;
		entry.driverProcess.kill(signal);
	}

	/** Set process group ID. Process can join existing group or create new one. */
	setpgid(pid: number, pgid: number): void {
		const entry = this.entries.get(pid);
		if (!entry) throw new KernelError("ESRCH", `no such process ${pid}`);

		// pgid 0 means "use own PID as pgid"
		const targetPgid = pgid === 0 ? pid : pgid;

		// Can only join an existing group or create own group
		if (targetPgid !== pid) {
			let groupExists = false;
			for (const e of this.entries.values()) {
				if (e.pgid === targetPgid && e.status !== "exited") {
					groupExists = true;
					break;
				}
			}
			if (!groupExists) throw new KernelError("EPERM", `no such process group ${targetPgid}`);
		}

		entry.pgid = targetPgid;
	}

	/** Get process group ID. */
	getpgid(pid: number): number {
		const entry = this.entries.get(pid);
		if (!entry) throw new KernelError("ESRCH", `no such process ${pid}`);
		return entry.pgid;
	}

	/** Create a new session. Process becomes session leader and process group leader. */
	setsid(pid: number): number {
		const entry = this.entries.get(pid);
		if (!entry) throw new KernelError("ESRCH", `no such process ${pid}`);

		// Process must not already be a process group leader
		if (entry.pgid === pid) {
			throw new KernelError("EPERM", `process ${pid} is already a process group leader`);
		}

		entry.sid = pid;
		entry.pgid = pid;
		return pid;
	}

	/** Get session ID. */
	getsid(pid: number): number {
		const entry = this.entries.get(pid);
		if (!entry) throw new KernelError("ESRCH", `no such process ${pid}`);
		return entry.sid;
	}

	/** Get the parent PID for a process. */
	getppid(pid: number): number {
		const entry = this.entries.get(pid);
		if (!entry) throw new KernelError("ESRCH", `no such process ${pid}`);
		return entry.ppid;
	}

	/** Get a read-only view of process info for all processes. */
	listProcesses(): Map<number, ProcessInfo> {
		const result = new Map<number, ProcessInfo>();
		for (const [pid, entry] of this.entries) {
			result.set(pid, {
				pid: entry.pid,
				ppid: entry.ppid,
				pgid: entry.pgid,
				sid: entry.sid,
				driver: entry.driver,
				command: entry.command,
				status: entry.status,
				exitCode: entry.exitCode,
			});
		}
		return result;
	}

	/** Remove a zombie process. */
	private reap(pid: number): void {
		const entry = this.entries.get(pid);
		if (entry?.status === "exited") {
			this.entries.delete(pid);
		}
	}

	/** Terminate all running processes and clear pending timers. */
	async terminateAll(): Promise<void> {
		// Clear all zombie cleanup timers to prevent post-dispose firings
		for (const timer of this.zombieTimers.values()) {
			clearTimeout(timer);
		}
		this.zombieTimers.clear();

		const running = [...this.entries.values()].filter(
			(e) => e.status === "running",
		);
		for (const entry of running) {
			try {
				entry.driverProcess.kill(15); // SIGTERM
			} catch {
				// Best effort
			}
		}
		// Wait briefly for exits
		await Promise.allSettled(
			running.map((e) =>
				Promise.race([
					e.driverProcess.wait(),
					new Promise((r) => setTimeout(r, 1000)),
				]),
			),
		);
	}
}
