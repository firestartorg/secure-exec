import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	allowAllNetwork,
	NodeRuntime,
	createNodeDriver,
	createNodeRuntimeDriverFactory,
} from "../../../src/index.js";
import type { NetworkAdapter } from "../../../src/types.js";
import type { StdioEvent } from "../../../src/shared/api-types.js";

const TMP = `/tmp/se-tls-err-${process.pid}`;

// Generate certs for three TLS error scenarios:
// 1. Expired cert (CA-signed, days=0)
// 2. Hostname mismatch (CA-signed, SAN=wrong.example.com)
// 3. Self-signed cert (no CA trust chain)
function generateTestCerts() {
	fs.mkdirSync(TMP, { recursive: true });

	function genKey(name: string): string {
		const key = execSync(
			"openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 2>/dev/null",
			{ encoding: "utf-8" },
		);
		fs.writeFileSync(`${TMP}/${name}.key`, key);
		return key;
	}

	function genCsr(name: string, subj: string): void {
		execSync(
			`openssl req -new -key ${TMP}/${name}.key -out ${TMP}/${name}.csr -subj "${subj}" 2>/dev/null`,
		);
	}

	function signWithCa(name: string, days: number, san: string): string {
		execSync(
			`openssl x509 -req -in ${TMP}/${name}.csr -CA ${TMP}/ca.crt -CAkey ${TMP}/ca.key -CAcreateserial -out ${TMP}/${name}.crt -days ${days} -extfile <(echo "subjectAltName=${san}") 2>/dev/null`,
			{ shell: "/bin/bash" },
		);
		return fs.readFileSync(`${TMP}/${name}.crt`, "utf-8");
	}

	function selfSign(name: string, days: number, san: string): string {
		execSync(
			`openssl x509 -req -in ${TMP}/${name}.csr -signkey ${TMP}/${name}.key -out ${TMP}/${name}.crt -days ${days} -extfile <(echo "subjectAltName=${san}") 2>/dev/null`,
			{ shell: "/bin/bash" },
		);
		return fs.readFileSync(`${TMP}/${name}.crt`, "utf-8");
	}

	// CA (valid, long-lived)
	genKey("ca");
	execSync(
		`openssl req -new -x509 -key ${TMP}/ca.key -out ${TMP}/ca.crt -days 365 -subj "/CN=Test CA" 2>/dev/null`,
	);
	const caCert = fs.readFileSync(`${TMP}/ca.crt`, "utf-8");

	// Expired cert (CA-signed, days=0 so notAfter=now, valid SANs)
	const expiredKey = genKey("expired");
	genCsr("expired", "/CN=localhost");
	const expiredCert = signWithCa("expired", 0, "DNS:localhost,IP:127.0.0.1");

	// Hostname mismatch cert (CA-signed, SAN for wrong host only)
	const mismatchKey = genKey("mismatch");
	genCsr("mismatch", "/CN=wrong.example.com");
	const mismatchCert = signWithCa(
		"mismatch",
		365,
		"DNS:wrong.example.com",
	);

	// Self-signed cert (valid SANs, no CA trust chain)
	const selfSignedKey = genKey("selfsigned");
	genCsr("selfsigned", "/CN=localhost");
	const selfSignedCert = selfSign(
		"selfsigned",
		365,
		"DNS:localhost,IP:127.0.0.1",
	);

	return {
		caCert,
		expiredCert,
		expiredKey,
		mismatchCert,
		mismatchKey,
		selfSignedCert,
		selfSignedKey,
	};
}

// Network adapter that bypasses SSRF and passes custom TLS options to the host request
function createTestNetworkAdapter(
	tlsOptions?: https.RequestOptions,
): NetworkAdapter {
	return {
		async fetch() {
			throw new Error("fetch not implemented in test adapter");
		},
		async dnsLookup() {
			return { address: "127.0.0.1", family: 4 };
		},
		async httpRequest(url, options) {
			return new Promise((resolve, reject) => {
				const urlObj = new URL(url);
				const isHttps = urlObj.protocol === "https:";
				const transport: typeof https = isHttps ? https : http;
				const reqOptions: https.RequestOptions = {
					hostname: urlObj.hostname,
					port: urlObj.port || (isHttps ? 443 : 80),
					path: urlObj.pathname + urlObj.search,
					method: options?.method || "GET",
					headers: options?.headers || {},
					...(isHttps &&
						options?.rejectUnauthorized !== undefined && {
							rejectUnauthorized: options.rejectUnauthorized,
						}),
					...tlsOptions,
				};

				const req = transport.request(reqOptions, (res) => {
					const chunks: Buffer[] = [];
					res.on("data", (chunk: Buffer) => chunks.push(chunk));
					res.on("end", () => {
						const headers: Record<string, string> = {};
						for (const [k, v] of Object.entries(res.headers)) {
							if (typeof v === "string") headers[k] = v;
							else if (Array.isArray(v)) headers[k] = v.join(", ");
						}
						resolve({
							status: res.statusCode || 200,
							statusText: res.statusMessage || "OK",
							headers,
							body: Buffer.concat(chunks).toString("utf-8"),
							url,
						});
					});
					res.on("error", reject);
				});

				req.on("error", reject);
				if (options?.body) req.write(options.body);
				req.end();
			});
		},
	};
}

describe("HTTPS TLS error parity between host and sandbox", () => {
	let certs: ReturnType<typeof generateTestCerts>;
	let expiredServer: https.Server;
	let expiredPort: number;
	let mismatchServer: https.Server;
	let mismatchPort: number;
	let selfSignedServer: https.Server;
	let selfSignedPort: number;
	const runtimes = new Set<NodeRuntime>();

	beforeAll(async () => {
		certs = generateTestCerts();

		// Ensure expired cert is past its notAfter (days=0 means notAfter=now)
		await new Promise((r) => setTimeout(r, 2000));

		async function startServer(
			key: string,
			cert: string,
		): Promise<[https.Server, number]> {
			const srv = https.createServer({ key, cert }, (_req, res) => {
				res.writeHead(200).end("ok");
			});
			await new Promise<void>((r) =>
				srv.listen(0, "127.0.0.1", () => r()),
			);
			return [srv, (srv.address() as { port: number }).port];
		}

		[expiredServer, expiredPort] = await startServer(
			certs.expiredKey,
			certs.expiredCert,
		);
		[mismatchServer, mismatchPort] = await startServer(
			certs.mismatchKey,
			certs.mismatchCert,
		);
		[selfSignedServer, selfSignedPort] = await startServer(
			certs.selfSignedKey,
			certs.selfSignedCert,
		);
	});

	afterAll(async () => {
		const close = (s?: https.Server) =>
			s
				? new Promise<void>((r) => s.close(() => r()))
				: Promise.resolve();
		await Promise.all([
			close(expiredServer),
			close(mismatchServer),
			close(selfSignedServer),
		]);
		fs.rmSync(TMP, { recursive: true, force: true });
	});

	afterEach(async () => {
		for (const rt of runtimes) {
			try {
				await rt.terminate();
			} catch {
				rt.dispose();
			}
		}
		runtimes.clear();
	});

	// Direct host HTTPS request — capture error message
	async function hostTlsError(
		port: number,
		ca?: string,
	): Promise<string> {
		return new Promise((resolve) => {
			const req = https.request(
				{
					hostname: "127.0.0.1",
					port,
					path: "/",
					method: "GET",
					...(ca ? { ca } : {}),
				},
				() => resolve("NO_ERROR"),
			);
			req.on("error", (err) => resolve(err.message));
			req.end();
		});
	}

	// Sandbox HTTPS request via bridge — capture error message from stdout
	async function sandboxTlsError(
		port: number,
		ca?: string,
	): Promise<string> {
		const events: StdioEvent[] = [];
		const adapter = createTestNetworkAdapter(ca ? { ca } : {});
		const runtime = new NodeRuntime({
			onStdio: (e) => events.push(e),
			systemDriver: createNodeDriver({
				networkAdapter: adapter,
				permissions: allowAllNetwork,
			}),
			runtimeDriverFactory: createNodeRuntimeDriverFactory(),
		});
		runtimes.add(runtime);

		await runtime.exec(`
			(async () => {
				const https = require('https');
				try {
					await new Promise((resolve, reject) => {
						const req = https.request({
							hostname: '127.0.0.1',
							port: ${port},
							path: '/',
							method: 'GET',
						}, resolve);
						req.on('error', reject);
						req.end();
					});
					console.log('TLS_ERR:none');
				} catch (err) {
					console.log('TLS_ERR:' + err.message);
				}
			})();
		`);

		const stdout = events
			.filter((e) => e.channel === "stdout")
			.map((e) => e.message)
			.join("");
		const m = stdout.match(/TLS_ERR:(.*)/);
		return m ? m[1] : "CAPTURE_FAILED";
	}

	it("expired cert: sandbox error matches host error", async () => {
		const host = await hostTlsError(expiredPort, certs.caCert);
		expect(host).not.toBe("NO_ERROR");

		const sandbox = await sandboxTlsError(expiredPort, certs.caCert);
		expect(sandbox).toBe(host);
	}, 30_000);

	it("hostname mismatch: sandbox error matches host error", async () => {
		const host = await hostTlsError(mismatchPort, certs.caCert);
		expect(host).not.toBe("NO_ERROR");

		const sandbox = await sandboxTlsError(mismatchPort, certs.caCert);
		expect(sandbox).toBe(host);
	}, 30_000);

	it("self-signed cert with rejectUnauthorized:true: sandbox error matches host error", async () => {
		const host = await hostTlsError(selfSignedPort);
		expect(host).not.toBe("NO_ERROR");

		const sandbox = await sandboxTlsError(selfSignedPort);
		expect(sandbox).toBe(host);
	}, 30_000);
});
