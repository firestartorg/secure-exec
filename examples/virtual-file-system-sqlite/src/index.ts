import {
	NodeRuntime,
	allowAllFs,
	createNodeDriver,
	createNodeRuntimeDriverFactory,
} from "secure-exec";
import { SQLiteFileSystem } from "./sqlite-filesystem.js";

const filesystem = await SQLiteFileSystem.create();

const runtime = new NodeRuntime({
	systemDriver: createNodeDriver({
		filesystem,
		permissions: { ...allowAllFs },
	}),
	runtimeDriverFactory: createNodeRuntimeDriverFactory(),
});

const failures: string[] = [];

function assert(condition: boolean, message: string) {
	if (!condition) {
		failures.push(message);
		console.error(`FAIL: ${message}`);
	}
}

async function exec(
	code: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
	let stdout = "";
	let stderr = "";
	const result = await runtime.exec(code, {
		onStdio: (event) => {
			if (event.channel === "stdout") stdout += event.message;
			else stderr += event.message;
		},
	});
	return { code: result.code, stdout, stderr };
}

try {
	// --- writeFile + readFile + readDir ---
	{
		const r = await exec(`
			const fs = require("node:fs");
			fs.mkdirSync("/workspace/src", { recursive: true });
			fs.writeFileSync("/workspace/src/index.js", "console.log('hello')");
			fs.writeFileSync("/workspace/package.json", JSON.stringify({ name: "test" }));
			const entries = fs.readdirSync("/workspace").sort();
			const code = fs.readFileSync("/workspace/src/index.js", "utf8");
			console.log(JSON.stringify({ entries, code }));
		`);
		assert(r.code === 0, `writeFile+readFile exec failed: ${r.stderr}`);
		const parsed = JSON.parse(r.stdout.trim());
		assert(
			parsed.code === "console.log('hello')",
			"readFile content mismatch",
		);
		assert(parsed.entries.includes("src"), "readDir missing 'src'");
		assert(
			parsed.entries.includes("package.json"),
			"readDir missing 'package.json'",
		);
		const hostContent = await filesystem.readTextFile(
			"/workspace/src/index.js",
		);
		assert(
			hostContent === "console.log('hello')",
			"host readTextFile mismatch",
		);
	}

	// --- stat ---
	{
		const r = await exec(`
			const fs = require("node:fs");
			const fileStat = fs.statSync("/workspace/src/index.js");
			const dirStat = fs.statSync("/workspace/src");
			console.log(JSON.stringify({
				fileIsDir: fileStat.isDirectory(),
				fileSize: fileStat.size,
				dirIsDir: dirStat.isDirectory(),
			}));
		`);
		assert(r.code === 0, `stat exec failed: ${r.stderr}`);
		const parsed = JSON.parse(r.stdout.trim());
		assert(!parsed.fileIsDir, "stat: file should not be directory");
		assert(parsed.fileSize > 0, "stat: file size should be > 0");
		assert(parsed.dirIsDir, "stat: dir should be directory");
	}

	// --- exists ---
	{
		const r = await exec(`
			const fs = require("node:fs");
			console.log(JSON.stringify({
				yes: fs.existsSync("/workspace/src/index.js"),
				no: fs.existsSync("/nonexistent"),
			}));
		`);
		assert(r.code === 0, `exists exec failed: ${r.stderr}`);
		const parsed = JSON.parse(r.stdout.trim());
		assert(parsed.yes === true, "existsSync true for existing file");
		assert(parsed.no === false, "existsSync false for missing file");
	}

	// --- rename file ---
	{
		const r = await exec(`
			const fs = require("node:fs");
			fs.writeFileSync("/workspace/old.txt", "rename-me");
			fs.renameSync("/workspace/old.txt", "/workspace/new.txt");
			const content = fs.readFileSync("/workspace/new.txt", "utf8");
			const oldExists = fs.existsSync("/workspace/old.txt");
			console.log(JSON.stringify({ content, oldExists }));
		`);
		assert(r.code === 0, `rename exec failed: ${r.stderr}`);
		const parsed = JSON.parse(r.stdout.trim());
		assert(parsed.content === "rename-me", "rename: content mismatch");
		assert(!parsed.oldExists, "rename: old path should not exist");
	}

	// --- rename directory with children ---
	{
		const r = await exec(`
			const fs = require("node:fs");
			fs.mkdirSync("/workspace/dirA/sub", { recursive: true });
			fs.writeFileSync("/workspace/dirA/sub/file.txt", "child-content");
			fs.renameSync("/workspace/dirA", "/workspace/dirB");
			const content = fs.readFileSync("/workspace/dirB/sub/file.txt", "utf8");
			const oldExists = fs.existsSync("/workspace/dirA");
			console.log(JSON.stringify({ content, oldExists }));
		`);
		assert(r.code === 0, `rename dir exec failed: ${r.stderr}`);
		const parsed = JSON.parse(r.stdout.trim());
		assert(
			parsed.content === "child-content",
			"rename dir: child content lost",
		);
		assert(!parsed.oldExists, "rename dir: old path should not exist");
	}

	// --- removeFile ---
	{
		const r = await exec(`
			const fs = require("node:fs");
			fs.writeFileSync("/workspace/delete-me.txt", "gone");
			fs.unlinkSync("/workspace/delete-me.txt");
			console.log(JSON.stringify({ exists: fs.existsSync("/workspace/delete-me.txt") }));
		`);
		assert(r.code === 0, `removeFile exec failed: ${r.stderr}`);
		assert(
			JSON.parse(r.stdout.trim()).exists === false,
			"removeFile: file should be gone",
		);
	}

	// --- removeDir ---
	{
		const r = await exec(`
			const fs = require("node:fs");
			fs.mkdirSync("/workspace/empty-dir");
			fs.rmdirSync("/workspace/empty-dir");
			console.log(JSON.stringify({ exists: fs.existsSync("/workspace/empty-dir") }));
		`);
		assert(r.code === 0, `removeDir exec failed: ${r.stderr}`);
		assert(
			JSON.parse(r.stdout.trim()).exists === false,
			"removeDir: dir should be gone",
		);
	}

	// --- chmod ---
	{
		const r = await exec(`
			const fs = require("node:fs");
			fs.writeFileSync("/workspace/chmod.txt", "data");
			fs.chmodSync("/workspace/chmod.txt", 0o755);
			const stat = fs.statSync("/workspace/chmod.txt");
			console.log(JSON.stringify({ mode: stat.mode & 0o7777 }));
		`);
		assert(r.code === 0, `chmod exec failed: ${r.stderr}`);
		assert(
			JSON.parse(r.stdout.trim()).mode === 0o755,
			"chmod: mode mismatch",
		);
	}

	// --- truncate ---
	{
		const r = await exec(`
			const fs = require("node:fs");
			fs.writeFileSync("/workspace/trunc.txt", "hello world");
			fs.truncateSync("/workspace/trunc.txt", 5);
			const content = fs.readFileSync("/workspace/trunc.txt", "utf8");
			console.log(JSON.stringify({ content }));
		`);
		assert(r.code === 0, `truncate exec failed: ${r.stderr}`);
		assert(
			JSON.parse(r.stdout.trim()).content === "hello",
			"truncate: should be 'hello'",
		);
	}

	// --- symlink + readlink + lstat ---
	{
		const r = await exec(`
			const fs = require("node:fs");
			fs.writeFileSync("/workspace/sym-target.txt", "symlinked");
			fs.symlinkSync("/workspace/sym-target.txt", "/workspace/my-link");
			const target = fs.readlinkSync("/workspace/my-link");
			const lstat = fs.lstatSync("/workspace/my-link");
			const content = fs.readFileSync("/workspace/my-link", "utf8");
			console.log(JSON.stringify({
				target,
				isSymlink: lstat.isSymbolicLink(),
				content,
			}));
		`);
		assert(r.code === 0, `symlink exec failed: ${r.stderr}`);
		const parsed = JSON.parse(r.stdout.trim());
		assert(
			parsed.target === "/workspace/sym-target.txt",
			"readlink mismatch",
		);
		assert(parsed.isSymlink === true, "lstat: should be symlink");
		assert(
			parsed.content === "symlinked",
			"reading through symlink should work",
		);
	}

	// --- hard link ---
	{
		const r = await exec(`
			const fs = require("node:fs");
			fs.writeFileSync("/workspace/link-src.txt", "shared");
			fs.linkSync("/workspace/link-src.txt", "/workspace/link-dst.txt");
			const content = fs.readFileSync("/workspace/link-dst.txt", "utf8");
			console.log(JSON.stringify({ content }));
		`);
		assert(r.code === 0, `link exec failed: ${r.stderr}`);
		assert(
			JSON.parse(r.stdout.trim()).content === "shared",
			"hard link content mismatch",
		);
	}

	// --- error: read nonexistent ---
	{
		const r = await exec(`
			const fs = require("node:fs");
			try { fs.readFileSync("/nonexistent"); console.log("NO_ERROR"); }
			catch (e) { console.log(e.message.includes("ENOENT") ? "ENOENT" : e.message); }
		`);
		assert(r.code === 0, `error read exec failed: ${r.stderr}`);
		assert(
			r.stdout.trim() === "ENOENT",
			"read missing file should throw ENOENT",
		);
	}

	// --- error: rmdir non-empty ---
	{
		const r = await exec(`
			const fs = require("node:fs");
			try { fs.rmdirSync("/workspace"); console.log("NO_ERROR"); }
			catch (e) { console.log(e.message.includes("ENOTEMPTY") || e.message.includes("not empty") ? "ENOTEMPTY" : e.message); }
		`);
		assert(r.code === 0, `error rmdir exec failed: ${r.stderr}`);
		assert(
			r.stdout.trim() === "ENOTEMPTY",
			"rmdir non-empty should throw ENOTEMPTY",
		);
	}

	// --- snapshot/restore ---
	{
		const snapshot = filesystem.export();
		assert(snapshot.byteLength > 0, "snapshot should be non-empty");
		const restored = await SQLiteFileSystem.create(snapshot);
		const content = await restored.readTextFile("/workspace/src/index.js");
		assert(
			content === "console.log('hello')",
			"restored snapshot content mismatch",
		);
		restored.close();
	}

	// --- result ---
	const ok = failures.length === 0;
	console.log(
		JSON.stringify({
			ok,
			passed: 15 - failures.length,
			total: 15,
			failures,
			summary: ok
				? "SQLite VFS: 15/15 tests passed (write, read, stat, exists, rename, rename-dir, remove, rmdir, chmod, truncate, symlink, link, err-read, err-rmdir, snapshot)"
				: `${failures.length} of 15 tests failed`,
		}),
	);

	if (!ok) process.exit(1);
} finally {
	runtime.dispose();
	filesystem.close();
}
