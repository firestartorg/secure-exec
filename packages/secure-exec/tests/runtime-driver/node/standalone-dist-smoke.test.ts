import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = resolve(__dirname, "../../../../..");
const DIST_INDEX_URL = pathToFileURL(
	resolve(WORKSPACE_ROOT, "packages/secure-exec/dist/index.js"),
).href;

async function runStandaloneScript(source: string): Promise<string> {
	const { stdout, stderr } = await execFileAsync(
		"node",
		["--input-type=module", "-e", source],
		{
			cwd: WORKSPACE_ROOT,
			timeout: 30_000,
		},
	);

	expect(stderr).toBe("");
	return stdout.trim();
}

describe("standalone dist bootstrap", () => {
	it("supports runtime.exec and kernel.spawn outside vitest transforms", async () => {
		const stdout = await runStandaloneScript(`
			import {
				NodeRuntime,
				createInMemoryFileSystem,
				createKernel,
				createNodeDriver,
				createNodeRuntime,
				createNodeRuntimeDriverFactory,
			} from ${JSON.stringify(DIST_INDEX_URL)};

			const stdio = [];
			const runtime = new NodeRuntime({
				onStdio: (event) => {
					if (event.channel === "stdout") {
						stdio.push(event.message);
					}
				},
				systemDriver: createNodeDriver(),
				runtimeDriverFactory: createNodeRuntimeDriverFactory(),
			});

			const execResult = await runtime.exec(
				'console.log("hello"); const fs = require("node:fs"); console.log(typeof fs.readFileSync);',
			);

			const kernel = createKernel({ filesystem: createInMemoryFileSystem() });
			await kernel.mount(createNodeRuntime());

			const kernelStdout = [];
			const proc = kernel.spawn("node", ["-e", 'console.log(1)'], {
				onStdout: (chunk) => kernelStdout.push(new TextDecoder().decode(chunk)),
			});
			const kernelCode = await proc.wait();

			await runtime.terminate();
			await kernel.dispose();

			const result = JSON.stringify({
				execCode: execResult.code,
				execErrorMessage: execResult.errorMessage,
				stdio,
				kernelCode,
				kernelStdout: kernelStdout.join(""),
			});

			await new Promise((resolve, reject) => {
				process.stdout.write(result, (error) => {
					if (error) {
						reject(error);
						return;
					}
					resolve();
				});
			});
			process.exit(0);
		`);

		const result = JSON.parse(stdout) as {
			execCode: number;
			execErrorMessage?: string;
			stdio: string[];
			kernelCode: number;
			kernelStdout: string;
		};

		expect(result.execCode).toBe(0);
		expect(result.execErrorMessage).toBeUndefined();
		expect(result.stdio.join("")).toContain("hello");
		expect(result.stdio.join("")).toContain("function");
		expect(result.kernelCode).toBe(0);
		expect(result.kernelStdout).toContain("1");
	}, 30_000);

	it("supports runtime.run exports outside vitest transforms", async () => {
		const stdout = await runStandaloneScript(`
			import {
				NodeRuntime,
				createNodeDriver,
				createNodeRuntimeDriverFactory,
			} from ${JSON.stringify(DIST_INDEX_URL)};

			const runtime = new NodeRuntime({
				systemDriver: createNodeDriver(),
				runtimeDriverFactory: createNodeRuntimeDriverFactory(),
			});

			const cjsObject = await runtime.run('module.exports = { message: "hello" };');
			const cjsScalar = await runtime.run("module.exports = 42;");
			const cjsNested = await runtime.run("module.exports = { a: 1, b: [2, 3] };");
			const esm = await runtime.run("export const answer = 42;", "/entry.mjs");

			const result = JSON.stringify({
				cjsObject,
				cjsScalar,
				cjsNested,
				esm,
			});

			await runtime.terminate();
			await new Promise((resolve, reject) => {
				process.stdout.write(result, (error) => {
					if (error) {
						reject(error);
						return;
					}
					resolve();
				});
			});
			process.exit(0);
		`);

		const result = JSON.parse(stdout) as {
			cjsObject: { code: number; exports: { message: string } };
			cjsScalar: { code: number; exports: number };
			cjsNested: { code: number; exports: { a: number; b: number[] } };
			esm: { code: number; exports: { answer: number } };
		};

		expect(result.cjsObject).toEqual({
			code: 0,
			exports: { message: "hello" },
		});
		expect(result.cjsScalar).toEqual({
			code: 0,
			exports: 42,
		});
		expect(result.cjsNested).toEqual({
			code: 0,
			exports: { a: 1, b: [2, 3] },
		});
		expect(result.esm).toEqual({
			code: 0,
			exports: { answer: 42 },
		});
	}, 30_000);

	it("imports require-transformed ESM modules that declare __filename from import.meta.url", async () => {
		const fixtureDir = await mkdtemp(
			resolve(tmpdir(), "secure-exec-import-meta-url-"),
		);
		const fixturePath = resolve(fixtureDir, "entry.mjs");
		await writeFile(
			fixturePath,
			[
				'import { dirname } from "node:path";',
				'import { fileURLToPath } from "node:url";',
				'const __filename = fileURLToPath(import.meta.url);',
				"const __dirname = dirname(__filename);",
				"export const filePath = __filename;",
				"export const dirPath = __dirname;",
			].join("\n"),
		);

		try {
			const stdout = await runStandaloneScript(`
			import {
				NodeRuntime,
				allowAll,
				createNodeDriver,
				createNodeRuntimeDriverFactory,
			} from ${JSON.stringify(DIST_INDEX_URL)};

			const stdio = [];
			const runtime = new NodeRuntime({
				onStdio: (event) => {
					if (event.channel === "stderr") {
						stdio.push(event.message);
					}
				},
				systemDriver: createNodeDriver({
					moduleAccess: { cwd: ${JSON.stringify(WORKSPACE_ROOT)} },
					permissions: allowAll,
				}),
				runtimeDriverFactory: createNodeRuntimeDriverFactory(),
			});

			const result = await runtime.exec(
				\`(() => {
					try {
						const mod = require(${JSON.stringify(fixturePath)});
						if (mod.filePath !== ${JSON.stringify(fixturePath)}) {
							throw new Error("unexpected filePath export: " + mod.filePath);
						}
						console.log(JSON.stringify({
							ok: true,
							filePath: mod.filePath,
							dirPath: mod.dirPath,
						}));
					} catch (error) {
						console.error(String(error));
						console.error(error && error.stack ? error.stack : "");
						process.exitCode = 1;
					}
				})();\`,
				{ cwd: ${JSON.stringify(WORKSPACE_ROOT)} },
			);

			await runtime.terminate();
			await new Promise((resolve, reject) => {
				process.stdout.write(JSON.stringify({
					code: result.code,
					stderr: stdio.join(""),
				}), (error) => {
					if (error) {
						reject(error);
						return;
					}
					resolve();
				});
			});
			process.exit(0);
		`);

			const result = JSON.parse(stdout) as {
				code: number;
				stderr: string;
			};

			expect(result.code).toBe(0);
			expect(result.stderr).not.toContain("Identifier '__filename' has already been declared");
			expect(result.stderr).toBe("");
		} finally {
			await rm(fixtureDir, { recursive: true, force: true });
		}
	}, 30_000);
});
