import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { allowAllFs, allowAllNetwork, createKernel } from '../../../core/src/index.ts';
import { InMemoryFileSystem } from '../../../browser/src/os-filesystem.ts';
import { createNodeHostNetworkAdapter, createNodeRuntime } from '../../../nodejs/src/index.ts';

const textDecoder = new TextDecoder();
const TEST_TIMEOUT_MS = 15_000;

type HostAdapterCounts = {
	tcpConnect: number;
	tcpListen: number;
	udpBind: number;
	udpSend: number;
	dnsLookup: number;
};

function createTrackedHostAdapter(): {
	adapter: ReturnType<typeof createNodeHostNetworkAdapter>;
	counts: HostAdapterCounts;
} {
	const base = createNodeHostNetworkAdapter();
	const counts: HostAdapterCounts = {
		tcpConnect: 0,
		tcpListen: 0,
		udpBind: 0,
		udpSend: 0,
		dnsLookup: 0,
	};

	return {
		adapter: {
			async tcpConnect(host, port) {
				counts.tcpConnect += 1;
				return await base.tcpConnect(host, port);
			},
			async tcpListen(host, port) {
				counts.tcpListen += 1;
				return await base.tcpListen(host, port);
			},
			async udpBind(host, port) {
				counts.udpBind += 1;
				return await base.udpBind(host, port);
			},
			async udpSend(socket, data, host, port) {
				counts.udpSend += 1;
				return await base.udpSend(socket, data, host, port);
			},
			async dnsLookup(hostname, rrtype) {
				counts.dnsLookup += 1;
				return await base.dnsLookup(hostname, rrtype);
			},
		},
		counts,
	};
}

async function createNetworkedKernel() {
	const { adapter, counts } = createTrackedHostAdapter();
	const kernel = createKernel({
		filesystem: new InMemoryFileSystem(),
		hostNetworkAdapter: adapter,
		permissions: { ...allowAllFs, ...allowAllNetwork },
	});

	await kernel.mount(
		createNodeRuntime({ permissions: { ...allowAllFs, ...allowAllNetwork } }),
	);

	return {
		kernel,
		counts,
		dispose: () => kernel.dispose(),
	};
}

function spawnNode(kernel: ReturnType<typeof createKernel>, code: string) {
	const stdoutChunks: Uint8Array[] = [];
	const stderrChunks: Uint8Array[] = [];
	const proc = kernel.spawn('node', ['-e', code], {
		onStdout: (chunk) => stdoutChunks.push(chunk),
		onStderr: (chunk) => stderrChunks.push(chunk),
	});

	return {
		proc,
		stdout: () => stdoutChunks.map((chunk) => textDecoder.decode(chunk)).join(''),
		stderr: () => stderrChunks.map((chunk) => textDecoder.decode(chunk)).join(''),
	};
}

async function waitForPort(getStdout: () => string, timeoutMs = 5_000): Promise<number> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const match = getStdout().match(/PORT:(\d+)/);
		if (match) {
			return Number.parseInt(match[1] ?? '0', 10);
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}

	throw new Error(`timed out waiting for sandbox listener port, stdout: ${getStdout()}`);
}

async function readHttpText(port: number): Promise<{ status: number; body: string }> {
	return await new Promise((resolve, reject) => {
		const req = http.get(
			{
				host: '127.0.0.1',
				port,
				path: '/',
			},
			(res) => {
				let body = '';
				res.setEncoding('utf8');
				res.on('data', (chunk) => {
					body += chunk;
				});
				res.on('end', () => {
					resolve({
						status: res.statusCode ?? 0,
						body,
					});
				});
			},
		);

		req.once('error', reject);
	});
}

async function waitForExit(proc: { wait(): Promise<number> }, label: string): Promise<number> {
	return await Promise.race([
		proc.wait(),
		new Promise<number>((_, reject) =>
			setTimeout(() => reject(new Error(`${label} timed out`)), TEST_TIMEOUT_MS),
		),
	]);
}

describe('kernel-backed network verification', () => {
	let ctx:
		| Awaited<ReturnType<typeof createNetworkedKernel>>
		| undefined;

	afterEach(async () => {
		await ctx?.dispose();
		ctx = undefined;
	});

	it(
		'proves host-side HTTP reaches a createNodeRuntime listener through the kernel-mounted path',
		async () => {
			ctx = await createNetworkedKernel();
			const run = spawnNode(
				ctx.kernel,
				`
					const http = require('node:http');
					const server = http.createServer((_req, res) => {
						res.writeHead(200, { 'content-type': 'text/plain' });
						res.end('kernel-server-ok');
						server.close();
					});

					server.on('error', (error) => {
						console.error(error.stack || error.message);
						process.exitCode = 1;
						server.close();
					});

					server.listen(0, '127.0.0.1', () => {
						console.log('PORT:' + server.address().port);
					});
				`,
			);

			const port = await waitForPort(run.stdout);
			const response = await readHttpText(port);
			const exitCode = await waitForExit(run.proc, 'kernel-backed HTTP server');

			expect(response.status).toBe(200);
			expect(response.body).toBe('kernel-server-ok');
			expect(exitCode).toBe(0);
			expect(run.stderr()).toBe('');
			expect(ctx.counts.tcpListen).toBe(1);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		'proves sandbox loopback clients stay on kernel sockets instead of falling back to host tcpConnect',
		async () => {
			ctx = await createNetworkedKernel();
			const run = spawnNode(
				ctx.kernel,
				`
					const http = require('node:http');
					const net = require('node:net');
					const server = http.createServer((_req, res) => {
						res.writeHead(200, { 'content-type': 'text/plain' });
						res.end('kernel-loopback-ok');
					});

					server.on('error', (error) => {
						console.error(error.stack || error.message);
						process.exitCode = 1;
						server.close();
					});

					server.listen(0, '127.0.0.1', () => {
						const { port } = server.address();
						const socket = net.connect(port, '127.0.0.1', () => {
							socket.write([
								'GET / HTTP/1.1',
								'Host: 127.0.0.1',
								'Connection: close',
								'',
								'',
							].join('\\r\\n'));
						});

						let response = '';
						socket.setEncoding('utf8');
						socket.on('data', (chunk) => {
							response += chunk;
						});
						socket.on('end', () => {
							console.log('RESPONSE:' + response);
							server.close();
						});
						socket.on('error', (error) => {
							console.error(error.stack || error.message);
							process.exitCode = 1;
							server.close();
						});
					});
				`,
			);

			const exitCode = await waitForExit(run.proc, 'kernel-backed loopback HTTP client');

			expect(exitCode).toBe(0);
			expect(run.stdout()).toContain('RESPONSE:HTTP/1.1 200 OK');
			expect(run.stdout()).toContain('kernel-loopback-ok');
			expect(run.stderr()).toBe('');
			expect(ctx.counts.tcpListen).toBe(1);
			expect(ctx.counts.tcpConnect).toBe(0);
		},
		TEST_TIMEOUT_MS,
	);
});
