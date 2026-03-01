import { afterEach, describe, expect, it } from "vitest";
import {
	allowAllFs,
	allowAllNetwork,
	NodeProcess,
	createInMemoryFileSystem,
} from "../src/index.js";
import type { NetworkAdapter } from "../src/types.js";

const DEFAULT_BRIDGE_BASE64_TRANSFER_BYTES = 16 * 1024 * 1024;
const DEFAULT_ISOLATE_JSON_PAYLOAD_BYTES = 4 * 1024 * 1024;
const MAX_CONFIGURED_PAYLOAD_BYTES = 64 * 1024 * 1024;
const PAYLOAD_LIMIT_ERROR_CODE = "ERR_SANDBOX_PAYLOAD_TOO_LARGE";

type CapturedConsoleEvent = {
	channel: "stdout" | "stderr";
	message: string;
};

function formatConsoleChannel(
	events: CapturedConsoleEvent[],
	channel: CapturedConsoleEvent["channel"],
): string {
	const lines = events
		.filter((event) => event.channel === channel)
		.map((event) => event.message);
	return lines.join("\n") + (lines.length > 0 ? "\n" : "");
}

function createConsoleCapture() {
	const events: CapturedConsoleEvent[] = [];
	return {
		onConsoleLog: (event: CapturedConsoleEvent) => {
			events.push(event);
		},
		stdout: () => formatConsoleChannel(events, "stdout"),
	};
}

function bytesOverBase64Limit(limitBytes: number): number {
	return Math.floor(limitBytes / 4) * 3 + 1;
}

function createEchoNetworkAdapter(): NetworkAdapter {
	return {
		async fetch(url, options) {
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				headers: {},
				body: options.body ?? "",
				url,
				redirected: false,
			};
		},
		async dnsLookup() {
			return { address: "127.0.0.1", family: 4 };
		},
		async httpRequest(url, options) {
			return {
				status: 200,
				statusText: "OK",
				headers: {},
				body: options.body ?? "",
				url,
			};
		},
	};
}

describe("NodeProcess payload limits", () => {
	let proc: NodeProcess | undefined;

	afterEach(() => {
		proc?.dispose();
		proc = undefined;
	});

	it("preserves in-limit binary read/write behavior", async () => {
		const fs = createInMemoryFileSystem();
		const payload = new Uint8Array([0, 1, 2, 3, 255]);
		await fs.mkdir("/data");
		await fs.writeFile("/data/source.bin", payload);

		const capture = createConsoleCapture();
		proc = new NodeProcess({
			filesystem: fs,
			permissions: allowAllFs,
			onConsoleLog: capture.onConsoleLog,
		});
		const result = await proc.exec(`
      const fs = require('fs');
      const input = fs.readFileSync('/data/source.bin');
      fs.writeFileSync('/data/copy.bin', input);
      console.log(input.length);
    `);

		expect(result.code).toBe(0);
		expect(result.stdout).toBe("");
		expect(capture.stdout()).toBe("5\n");

		const copied = await fs.readFile("/data/copy.bin");
		expect(Array.from(copied)).toEqual(Array.from(payload));
	});

	it("rejects oversized binary reads before returning base64 payloads", async () => {
		const fs = createInMemoryFileSystem();
		const oversizedRawBytes = bytesOverBase64Limit(
			DEFAULT_BRIDGE_BASE64_TRANSFER_BYTES,
		);
		await fs.mkdir("/data");
		await fs.writeFile("/data/too-large-read.bin", new Uint8Array(oversizedRawBytes));

		proc = new NodeProcess({ filesystem: fs, permissions: allowAllFs });
		const result = await proc.exec(`
      const fs = require('fs');
      fs.readFileSync('/data/too-large-read.bin');
    `);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(PAYLOAD_LIMIT_ERROR_CODE);
		expect(result.stderr).toContain("fs.readFileBinary");
	});

	it("rejects oversized binary writes before base64 decode", async () => {
		const fs = createInMemoryFileSystem();
		const oversizedRawBytes = bytesOverBase64Limit(
			DEFAULT_BRIDGE_BASE64_TRANSFER_BYTES,
		);
		await fs.mkdir("/data");

		proc = new NodeProcess({ filesystem: fs, permissions: allowAllFs });
		const result = await proc.exec(`
      const fs = require('fs');
      fs.writeFileSync('/data/too-large-write.bin', Buffer.alloc(${oversizedRawBytes}));
    `);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(PAYLOAD_LIMIT_ERROR_CODE);
		expect(result.stderr).toContain("fs.writeFileBinary");
		expect(await fs.exists("/data/too-large-write.bin")).toBe(false);
	});

	it("preserves in-limit JSON bridge payload parsing behavior", async () => {
		const capture = createConsoleCapture();
		proc = new NodeProcess({
			networkAdapter: createEchoNetworkAdapter(),
			permissions: allowAllNetwork,
			onConsoleLog: capture.onConsoleLog,
		});
		const result = await proc.exec(`
      (async () => {
        const response = await fetch('https://example.test/in-limit', {
          method: 'POST',
          body: 'ok',
        });
        console.log(await response.text());
      })();
    `);

		expect(result.code).toBe(0);
		expect(result.stdout).toBe("");
		expect(capture.stdout()).toBe("ok\n");
	});

	it("rejects oversized JSON payloads before host JSON.parse", async () => {
		proc = new NodeProcess({
			networkAdapter: createEchoNetworkAdapter(),
			permissions: allowAllNetwork,
		});
		const result = await proc.exec(`
      (async () => {
        const body = 'x'.repeat(${DEFAULT_ISOLATE_JSON_PAYLOAD_BYTES + 1024});
        await fetch('https://example.test/too-large', {
          method: 'POST',
          body,
        });
      })();
    `);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(PAYLOAD_LIMIT_ERROR_CODE);
		expect(result.stderr).toContain("network.fetch options");
	});

	it("allows larger base64 payloads with in-range configured limits", async () => {
		const fs = createInMemoryFileSystem();
		const oversizedRawBytes = bytesOverBase64Limit(
			DEFAULT_BRIDGE_BASE64_TRANSFER_BYTES,
		);
		await fs.mkdir("/data");

		const capture = createConsoleCapture();
		proc = new NodeProcess({
			filesystem: fs,
			permissions: allowAllFs,
			onConsoleLog: capture.onConsoleLog,
			payloadLimits: {
				base64TransferBytes: DEFAULT_BRIDGE_BASE64_TRANSFER_BYTES + 4096,
			},
		});
		const result = await proc.exec(`
      const fs = require('fs');
      fs.writeFileSync('/data/large-configured.bin', Buffer.alloc(${oversizedRawBytes}));
      console.log('ok');
    `);

		expect(result.code).toBe(0);
		expect(result.stdout).toBe("");
		expect(capture.stdout()).toBe("ok\n");
		const stored = await fs.readFile("/data/large-configured.bin");
		expect(stored.byteLength).toBe(oversizedRawBytes);
	});

	it("allows larger JSON payloads with in-range configured limits", async () => {
		const capture = createConsoleCapture();
		proc = new NodeProcess({
			networkAdapter: createEchoNetworkAdapter(),
			permissions: allowAllNetwork,
			onConsoleLog: capture.onConsoleLog,
			payloadLimits: {
				jsonPayloadBytes: DEFAULT_ISOLATE_JSON_PAYLOAD_BYTES + 4096,
			},
		});
		const result = await proc.exec(`
      (async () => {
        const body = 'x'.repeat(${DEFAULT_ISOLATE_JSON_PAYLOAD_BYTES + 1024});
        await fetch('https://example.test/configured', { method: 'POST', body });
        console.log('ok');
      })();
    `);

		expect(result.code).toBe(0);
		expect(result.stdout).toBe("");
		expect(capture.stdout()).toBe("ok\n");
	});

	it("rejects out-of-range payload limit configuration", () => {
		expect(
			() => new NodeProcess({ payloadLimits: { jsonPayloadBytes: 0 } }),
		).toThrow(RangeError);
		expect(
			() =>
				new NodeProcess({
					payloadLimits: {
						base64TransferBytes: MAX_CONFIGURED_PAYLOAD_BYTES + 1,
					},
				}),
		).toThrow(RangeError);
	});
});
