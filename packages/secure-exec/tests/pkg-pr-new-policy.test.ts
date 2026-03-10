import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TESTS_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(TESTS_ROOT, "..");
const WORKSPACE_ROOT = path.resolve(PACKAGE_ROOT, "..", "..");
const WORKFLOW_PATH = path.join(
	WORKSPACE_ROOT,
	".github",
	"workflows",
	"pkg-pr-new.yml",
);
const PACKAGE_MANIFEST_PATH = path.join(PACKAGE_ROOT, "package.json");

describe("pkg.pr.new publish policy", () => {
	it("publishes only the secure-exec package preview", async () => {
		const workflowSource = await readFile(WORKFLOW_PATH, "utf8");

		expect(workflowSource).toContain("name: Publish to pkg.pr.new");
		expect(workflowSource).toContain(
			'pnpm dlx pkg-pr-new publish "./packages/secure-exec" --packageManager pnpm',
		);
		expect(workflowSource).not.toContain("'packages/*'");
		expect(workflowSource).not.toContain("'./packages/**/*'");
		expect(workflowSource).not.toContain("--template");
	});

	it("packages only built artifacts for preview publishing", async () => {
		const packageManifest = JSON.parse(
			await readFile(PACKAGE_MANIFEST_PATH, "utf8"),
		) as {
			files?: string[];
			repository?: {
				type?: string;
				url?: string;
				directory?: string;
			};
		};

		expect(packageManifest.files).toEqual(["dist"]);
		expect(packageManifest.repository).toEqual({
			type: "git",
			url: "https://github.com/rivet-dev/secure-exec.git",
			directory: "packages/secure-exec",
		});
	});
});
