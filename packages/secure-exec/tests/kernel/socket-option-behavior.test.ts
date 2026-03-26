import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryFileSystem } from "../../../browser/src/os-filesystem.ts";
import {
	allowAllFs,
	allowAllNetwork,
	createKernel,
	type Kernel,
	KernelError,
	type DriverProcess,
	type VirtualFileSystem,
} from "../../../core/src/index.ts";
import {
	AF_INET,
	AF_UNIX,
	IPPROTO_TCP,
	MSG_DONTWAIT,
	MSG_PEEK,
	type DnsResult,
	type HostListener,
	type HostNetworkAdapter,
	type HostSocket,
	type HostUdpSocket,
	SOCK_DGRAM,
	SOCK_STREAM,
	SOL_SOCKET,
	SO_KEEPALIVE,
	SO_RCVBUF,
	SO_REUSEADDR,
	SO_SNDBUF,
	TCP_NODELAY,
} from "../../../core/src/kernel/index.ts";
import { createNodeHostNetworkAdapter } from "../../../nodejs/src/index.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const TEST_TIMEOUT_MS = 10_000;

type KernelTestInternals = {
	posixDirsReady: Promise<void>;
	processTable: {
		allocatePid(): number;
		register(
			pid: number,
			driver: string,
			command: string,
			args: string[],
			ctx: {
				pid: number;
				ppid: number;
				env: Record<string, string>;
				cwd: string;
				fds: { stdin: number; stdout: number; stderr: number };
			},
			driverProcess: DriverProcess,
		): void;
	};
};

function requireValue<T>(value: T | null, message: string): T {
	if (value === null) {
		throw new Error(message);
	}
	return value;
}

function createMockDriverProcess(): DriverProcess {
	let resolveExit!: (code: number) => void;
	const exitPromise = new Promise<number>((resolve) => {
		resolveExit = resolve;
	});

	return {
		writeStdin() {},
		closeStdin() {},
		kill(signal) {
			resolveExit(128 + signal);
		},
		wait() {
			return exitPromise;
		},
		onStdout: null,
		onStderr: null,
		onExit: null,
	};
}

function registerKernelPid(kernel: Kernel, ppid = 0): number {
	const internal = kernel as Kernel & KernelTestInternals;
	const pid = internal.processTable.allocatePid();
	internal.processTable.register(
		pid,
		"test",
		"test",
		[],
		{
			pid,
			ppid,
			env: {},
			cwd: "/",
			fds: { stdin: 0, stdout: 1, stderr: 2 },
		},
		createMockDriverProcess(),
	);
	return pid;
}

async function createSocketKernel(
	hostNetworkAdapter?: HostNetworkAdapter,
): Promise<{
	kernel: Kernel;
	vfs: VirtualFileSystem;
	dispose: () => Promise<void>;
}> {
	const vfs = new InMemoryFileSystem();
	const kernel = createKernel({
		filesystem: vfs,
		hostNetworkAdapter,
		permissions: { ...allowAllFs, ...allowAllNetwork },
	});
	await (kernel as Kernel & KernelTestInternals).posixDirsReady;

	return {
		kernel,
		vfs,
		dispose: () => kernel.dispose(),
	};
}

function expectKernelError(action: () => unknown, code: string): void {
	expect(action).toThrow(KernelError);
	try {
		action();
	} catch (error) {
		expect((error as KernelError).code).toBe(code);
	}
}

async function waitForSocketData(
	kernel: Kernel,
	socketId: number,
	timeoutMs = TEST_TIMEOUT_MS,
): Promise<Uint8Array> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const chunk = kernel.socketTable.recv(socketId, 4096, MSG_DONTWAIT);
			if (chunk !== null) {
				return chunk;
			}
		} catch (error) {
			if (!(error instanceof KernelError) || error.code !== "EAGAIN") {
				throw error;
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}

	throw new Error(`timed out waiting for stream data on socket ${socketId}`);
}

async function createHostServer(): Promise<{
	server: net.Server;
	port: number;
	close: () => Promise<void>;
}> {
	const server = net.createServer((socket) => {
		socket.end("from-host");
	});

	await new Promise<void>((resolve, reject) => {
		server.once("listening", () => resolve());
		server.once("error", reject);
		server.listen(0, "127.0.0.1");
	});

	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("expected host TCP AddressInfo");
	}

	return {
		server,
		port: address.port,
		close: async () => {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) reject(error);
					else resolve();
				});
			});
		},
	};
}

function createTrackedHostAdapter(): {
	adapter: HostNetworkAdapter;
	optionCalls: Array<{ level: number; optname: number; optval: number }>;
} {
	const base = createNodeHostNetworkAdapter();
	const optionCalls: Array<{ level: number; optname: number; optval: number }> = [];

	return {
		adapter: {
			async tcpConnect(host: string, port: number): Promise<HostSocket> {
				const socket = await base.tcpConnect(host, port);
				return {
					write(data: Uint8Array) {
						return socket.write(data);
					},
					read() {
						return socket.read();
					},
					close() {
						return socket.close();
					},
					shutdown(how: "read" | "write" | "both") {
						socket.shutdown(how);
					},
					setOption(level: number, optname: number, optval: number) {
						optionCalls.push({ level, optname, optval });
						socket.setOption(level, optname, optval);
					},
				};
			},
			tcpListen(host: string, port: number): Promise<HostListener> {
				return base.tcpListen(host, port);
			},
			udpBind(host: string, port: number): Promise<HostUdpSocket> {
				return base.udpBind(host, port);
			},
			udpSend(
				socket: HostUdpSocket,
				data: Uint8Array,
				host: string,
				port: number,
			): Promise<void> {
				return base.udpSend(socket, data, host, port);
			},
			dnsLookup(hostname: string, rrtype: string): Promise<DnsResult> {
				return base.dnsLookup(hostname, rrtype);
			},
		},
		optionCalls,
	};
}

describe("kernel socket option behavior", () => {
	let ctx: Awaited<ReturnType<typeof createSocketKernel>> | undefined;
	let hostServer:
		| Awaited<ReturnType<typeof createHostServer>>
		| undefined;

	afterEach(async () => {
		await ctx?.dispose();
		ctx = undefined;
		await hostServer?.close();
		hostServer = undefined;
	});

	it("supports TCP socket options and recv flags through the real kernel", async () => {
		ctx = await createSocketKernel();
		const serverPid = registerKernelPid(ctx.kernel);
		const clientPid = registerKernelPid(ctx.kernel);

		const listenId = ctx.kernel.socketTable.create(
			AF_INET,
			SOCK_STREAM,
			0,
			serverPid,
		);
		await ctx.kernel.socketTable.bind(listenId, {
			host: "127.0.0.1",
			port: 0,
		});
		await ctx.kernel.socketTable.listen(listenId);
		const listenAddr = ctx.kernel.socketTable.getLocalAddr(listenId);
		if (!("host" in listenAddr)) {
			throw new Error("expected inet listener address");
		}

		const clientId = ctx.kernel.socketTable.create(
			AF_INET,
			SOCK_STREAM,
			0,
			clientPid,
		);
		ctx.kernel.socketTable.setsockopt(clientId, IPPROTO_TCP, TCP_NODELAY, 1);
		ctx.kernel.socketTable.setsockopt(clientId, SOL_SOCKET, SO_KEEPALIVE, 1);
		await ctx.kernel.socketTable.connect(clientId, {
			host: "127.0.0.1",
			port: listenAddr.port,
		});
		const serverId = requireValue(
			ctx.kernel.socketTable.accept(listenId),
			"expected accepted TCP socket",
		);

		expect(
			ctx.kernel.socketTable.getsockopt(clientId, IPPROTO_TCP, TCP_NODELAY),
		).toBe(1);
		expect(
			ctx.kernel.socketTable.getsockopt(clientId, SOL_SOCKET, SO_KEEPALIVE),
		).toBe(1);

		ctx.kernel.socketTable.send(clientId, textEncoder.encode("peek"));
		const peeked = requireValue(
			ctx.kernel.socketTable.recv(serverId, 1024, MSG_PEEK),
			"expected MSG_PEEK data",
		);
		expect(textDecoder.decode(peeked)).toBe("peek");

		const consumed = requireValue(
			ctx.kernel.socketTable.recv(serverId, 1024),
			"expected consumed TCP data",
		);
		expect(textDecoder.decode(consumed)).toBe("peek");
		expectKernelError(
			() => ctx!.kernel.socketTable.recv(serverId, 1024, MSG_DONTWAIT),
			"EAGAIN",
		);

		ctx.kernel.socketTable.setsockopt(serverId, SOL_SOCKET, SO_RCVBUF, 4);
		ctx.kernel.socketTable.send(clientId, textEncoder.encode("1234"));
		expectKernelError(
			() => ctx!.kernel.socketTable.send(clientId, textEncoder.encode("5")),
			"EAGAIN",
		);
	});

	it("supports AF_UNIX stream socket options and recv flags through the real kernel", async () => {
		ctx = await createSocketKernel();
		const serverPid = registerKernelPid(ctx.kernel);
		const clientPid = registerKernelPid(ctx.kernel);

		const listenId = ctx.kernel.socketTable.create(
			AF_UNIX,
			SOCK_STREAM,
			0,
			serverPid,
		);
		await ctx.kernel.socketTable.bind(listenId, {
			path: "/tmp/socket-options.sock",
		});
		await ctx.kernel.socketTable.listen(listenId);

		const clientId = ctx.kernel.socketTable.create(
			AF_UNIX,
			SOCK_STREAM,
			0,
			clientPid,
		);
		ctx.kernel.socketTable.setsockopt(clientId, SOL_SOCKET, SO_SNDBUF, 2048);
		await ctx.kernel.socketTable.connect(clientId, {
			path: "/tmp/socket-options.sock",
		});
		const serverId = requireValue(
			ctx.kernel.socketTable.accept(listenId),
			"expected accepted AF_UNIX socket",
		);

		ctx.kernel.socketTable.setsockopt(serverId, SOL_SOCKET, SO_KEEPALIVE, 1);
		expect(
			ctx.kernel.socketTable.getsockopt(clientId, SOL_SOCKET, SO_SNDBUF),
		).toBe(2048);
		expect(
			ctx.kernel.socketTable.getsockopt(serverId, SOL_SOCKET, SO_KEEPALIVE),
		).toBe(1);

		ctx.kernel.socketTable.send(clientId, textEncoder.encode("unix"));
		const peeked = requireValue(
			ctx.kernel.socketTable.recv(serverId, 1024, MSG_PEEK),
			"expected AF_UNIX MSG_PEEK data",
		);
		expect(textDecoder.decode(peeked)).toBe("unix");

		const consumed = requireValue(
			ctx.kernel.socketTable.recv(serverId, 1024),
			"expected AF_UNIX data",
		);
		expect(textDecoder.decode(consumed)).toBe("unix");
		expectKernelError(
			() => ctx!.kernel.socketTable.recv(serverId, 1024, MSG_DONTWAIT),
			"EAGAIN",
		);
	});

	it("supports UDP SO_REUSEADDR and recvFrom flags through the real kernel", async () => {
		ctx = await createSocketKernel();
		const firstPid = registerKernelPid(ctx.kernel);
		const secondPid = registerKernelPid(ctx.kernel);
		const senderPid = registerKernelPid(ctx.kernel);

		const firstReceiverId = ctx.kernel.socketTable.create(
			AF_INET,
			SOCK_DGRAM,
			0,
			firstPid,
		);
		await ctx.kernel.socketTable.bind(firstReceiverId, {
			host: "127.0.0.1",
			port: 0,
		});
		const firstAddr = ctx.kernel.socketTable.getLocalAddr(firstReceiverId);
		if (!("host" in firstAddr)) {
			throw new Error("expected inet UDP receiver address");
		}

		const secondReceiverId = ctx.kernel.socketTable.create(
			AF_INET,
			SOCK_DGRAM,
			0,
			secondPid,
		);
		ctx.kernel.socketTable.setsockopt(
			secondReceiverId,
			SOL_SOCKET,
			SO_REUSEADDR,
			1,
		);
		await ctx.kernel.socketTable.bind(secondReceiverId, {
			host: "127.0.0.1",
			port: firstAddr.port,
		});
		expect(
			ctx.kernel.socketTable.getsockopt(
				secondReceiverId,
				SOL_SOCKET,
				SO_REUSEADDR,
			),
		).toBe(1);

		const senderId = ctx.kernel.socketTable.create(
			AF_INET,
			SOCK_DGRAM,
			0,
			senderPid,
		);
		ctx.kernel.socketTable.setsockopt(senderId, SOL_SOCKET, SO_SNDBUF, 8192);
		expect(
			ctx.kernel.socketTable.getsockopt(senderId, SOL_SOCKET, SO_SNDBUF),
		).toBe(8192);
		await ctx.kernel.socketTable.bind(senderId, {
			host: "127.0.0.1",
			port: 0,
		});

		ctx.kernel.socketTable.sendTo(
			senderId,
			textEncoder.encode("datagram"),
			0,
			{
				host: "127.0.0.1",
				port: firstAddr.port,
			},
		);
		const peeked = requireValue(
			ctx.kernel.socketTable.recvFrom(secondReceiverId, 1024, MSG_PEEK),
			"expected UDP MSG_PEEK datagram",
		);
		expect(textDecoder.decode(peeked.data)).toBe("datagram");

		const consumed = requireValue(
			ctx.kernel.socketTable.recvFrom(secondReceiverId, 1024),
			"expected UDP datagram",
		);
		expect(textDecoder.decode(consumed.data)).toBe("datagram");
		expectKernelError(
			() => ctx!.kernel.socketTable.recvFrom(secondReceiverId, 1024, MSG_DONTWAIT),
			"EAGAIN",
		);
	});

	it(
		"replays TCP_NODELAY and SO_KEEPALIVE onto real host-backed TCP sockets",
		async () => {
			hostServer = await createHostServer();
			const tracked = createTrackedHostAdapter();
			ctx = await createSocketKernel(tracked.adapter);
			const pid = registerKernelPid(ctx.kernel);

			const socketId = ctx.kernel.socketTable.create(
				AF_INET,
				SOCK_STREAM,
				0,
				pid,
			);
			ctx.kernel.socketTable.setsockopt(
				socketId,
				IPPROTO_TCP,
				TCP_NODELAY,
				1,
			);
			ctx.kernel.socketTable.setsockopt(
				socketId,
				SOL_SOCKET,
				SO_KEEPALIVE,
				1,
			);
			await ctx.kernel.socketTable.connect(socketId, {
				host: "127.0.0.1",
				port: hostServer.port,
			});

			expect(tracked.optionCalls).toContainEqual({
				level: IPPROTO_TCP,
				optname: TCP_NODELAY,
				optval: 1,
			});
			expect(tracked.optionCalls).toContainEqual({
				level: SOL_SOCKET,
				optname: SO_KEEPALIVE,
				optval: 1,
			});

			const chunk = await waitForSocketData(ctx.kernel, socketId);
			expect(textDecoder.decode(chunk)).toBe("from-host");
		},
		TEST_TIMEOUT_MS,
	);
});
