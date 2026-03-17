/**
 * PTY manager.
 *
 * Allocates pseudo-terminal master/slave pairs with bidirectional data flow.
 * Writing to master → readable from slave (input direction).
 * Writing to slave → readable from master (output direction).
 * Follows the same FileDescription/refCount pattern as PipeManager.
 */

import type { FileDescription } from "./types.js";
import { FILETYPE_CHARACTER_DEVICE, O_RDWR, KernelError } from "./types.js";
import type { ProcessFDTable } from "./fd-table.js";

export interface PtyEnd {
	description: FileDescription;
	filetype: typeof FILETYPE_CHARACTER_DEVICE;
}

interface PtyState {
	id: number;
	path: string; // /dev/pts/N
	masterDescription: FileDescription;
	slaveDescription: FileDescription;
	/** Data written to master, readable from slave (input direction) */
	inputBuffer: Uint8Array[];
	/** Data written to slave, readable from master (output direction) */
	outputBuffer: Uint8Array[];
	closed: { master: boolean; slave: boolean };
	/** Resolves waiting for input data (slave reads) */
	inputWaiters: Array<(data: Uint8Array | null) => void>;
	/** Resolves waiting for output data (master reads) */
	outputWaiters: Array<(data: Uint8Array | null) => void>;
}

let nextPtyId = 0;
let nextPtyDescId = 200_000; // High range to avoid FD/pipe ID collisions

export class PtyManager {
	private ptys: Map<number, PtyState> = new Map();
	/** Map description ID → pty ID and which end */
	private descToPty: Map<number, { ptyId: number; end: "master" | "slave" }> = new Map();

	/**
	 * Allocate a PTY pair. Returns two FileDescriptions:
	 * one for the master and one for the slave.
	 */
	createPty(): { master: PtyEnd; slave: PtyEnd; path: string } {
		const id = nextPtyId++;
		const path = `/dev/pts/${id}`;

		const masterDesc: FileDescription = {
			id: nextPtyDescId++,
			path: `pty:${id}:master`,
			cursor: 0n,
			flags: O_RDWR,
			refCount: 0, // openWith() will bump
		};

		const slaveDesc: FileDescription = {
			id: nextPtyDescId++,
			path: path,
			cursor: 0n,
			flags: O_RDWR,
			refCount: 0, // openWith() will bump
		};

		const state: PtyState = {
			id,
			path,
			masterDescription: masterDesc,
			slaveDescription: slaveDesc,
			inputBuffer: [],
			outputBuffer: [],
			closed: { master: false, slave: false },
			inputWaiters: [],
			outputWaiters: [],
		};

		this.ptys.set(id, state);
		this.descToPty.set(masterDesc.id, { ptyId: id, end: "master" });
		this.descToPty.set(slaveDesc.id, { ptyId: id, end: "slave" });

		return {
			master: { description: masterDesc, filetype: FILETYPE_CHARACTER_DEVICE },
			slave: { description: slaveDesc, filetype: FILETYPE_CHARACTER_DEVICE },
			path,
		};
	}

	/**
	 * Write data to a PTY end.
	 * Master write → slave can read (input direction).
	 * Slave write → master can read (output direction).
	 */
	write(descriptionId: number, data: Uint8Array): number {
		const ref = this.descToPty.get(descriptionId);
		if (!ref) throw new KernelError("EBADF", "not a PTY end");

		const state = this.ptys.get(ref.ptyId);
		if (!state) throw new KernelError("EBADF", "PTY not found");

		if (ref.end === "master") {
			// Master write → input buffer (slave reads)
			if (state.closed.master) throw new KernelError("EIO", "master closed");
			if (state.closed.slave) throw new KernelError("EIO", "slave closed");

			if (state.inputWaiters.length > 0) {
				const waiter = state.inputWaiters.shift()!;
				waiter(data);
			} else {
				state.inputBuffer.push(new Uint8Array(data));
			}
		} else {
			// Slave write → output buffer (master reads)
			if (state.closed.slave) throw new KernelError("EIO", "slave closed");
			if (state.closed.master) throw new KernelError("EIO", "master closed");

			if (state.outputWaiters.length > 0) {
				const waiter = state.outputWaiters.shift()!;
				waiter(data);
			} else {
				state.outputBuffer.push(new Uint8Array(data));
			}
		}

		return data.length;
	}

	/**
	 * Read data from a PTY end.
	 * Master read → data written by slave (output direction).
	 * Slave read → data written by master (input direction).
	 * Returns null on hangup (other end closed).
	 */
	read(descriptionId: number, length: number): Promise<Uint8Array | null> {
		const ref = this.descToPty.get(descriptionId);
		if (!ref) throw new KernelError("EBADF", "not a PTY end");

		const state = this.ptys.get(ref.ptyId);
		if (!state) throw new KernelError("EBADF", "PTY not found");

		if (ref.end === "master") {
			// Master reads from output buffer (data written by slave)
			if (state.closed.master) throw new KernelError("EIO", "master closed");

			if (state.outputBuffer.length > 0) {
				return Promise.resolve(this.drainBuffer(state.outputBuffer, length));
			}
			// Slave closed → EIO (terminal hangup)
			if (state.closed.slave) {
				return Promise.resolve(null);
			}
			return new Promise((resolve) => {
				state.outputWaiters.push(resolve);
			});
		} else {
			// Slave reads from input buffer (data written by master)
			if (state.closed.slave) throw new KernelError("EIO", "slave closed");

			if (state.inputBuffer.length > 0) {
				return Promise.resolve(this.drainBuffer(state.inputBuffer, length));
			}
			// Master closed → EIO (terminal hangup)
			if (state.closed.master) {
				return Promise.resolve(null);
			}
			return new Promise((resolve) => {
				state.inputWaiters.push(resolve);
			});
		}
	}

	/** Close one end of a PTY. */
	close(descriptionId: number): void {
		const ref = this.descToPty.get(descriptionId);
		if (!ref) return;

		const state = this.ptys.get(ref.ptyId);
		if (!state) return;

		if (ref.end === "master") {
			state.closed.master = true;
			// Notify blocked slave readers with null (EIO / hangup)
			for (const waiter of state.inputWaiters) {
				waiter(null);
			}
			state.inputWaiters.length = 0;
		} else {
			state.closed.slave = true;
			// Notify blocked master readers with null (EIO / hangup)
			for (const waiter of state.outputWaiters) {
				waiter(null);
			}
			state.outputWaiters.length = 0;
		}

		this.descToPty.delete(descriptionId);

		// Clean up when both ends closed
		if (state.closed.master && state.closed.slave) {
			this.ptys.delete(ref.ptyId);
		}
	}

	/** Check if a description ID belongs to a PTY. */
	isPty(descriptionId: number): boolean {
		return this.descToPty.has(descriptionId);
	}

	/** Check if a description ID is a PTY slave (terminal). */
	isSlave(descriptionId: number): boolean {
		const ref = this.descToPty.get(descriptionId);
		return ref?.end === "slave";
	}

	/**
	 * Allocate PTY FDs in the given FD table.
	 * Returns master/slave FD numbers and the /dev/pts/N path.
	 */
	createPtyFDs(fdTable: ProcessFDTable): { masterFd: number; slaveFd: number; path: string } {
		const { master, slave, path } = this.createPty();
		const masterFd = fdTable.openWith(master.description, master.filetype);
		const slaveFd = fdTable.openWith(slave.description, slave.filetype);
		return { masterFd, slaveFd, path };
	}

	private drainBuffer(buffer: Uint8Array[], length: number): Uint8Array {
		const chunks: Uint8Array[] = [];
		let remaining = length;

		while (remaining > 0 && buffer.length > 0) {
			const chunk = buffer[0];
			if (chunk.length <= remaining) {
				chunks.push(chunk);
				remaining -= chunk.length;
				buffer.shift();
			} else {
				chunks.push(chunk.subarray(0, remaining));
				buffer[0] = chunk.subarray(remaining);
				remaining = 0;
			}
		}

		if (chunks.length === 1) return chunks[0];

		const total = chunks.reduce((sum, c) => sum + c.length, 0);
		const result = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			result.set(chunk, offset);
			offset += chunk.length;
		}
		return result;
	}
}
