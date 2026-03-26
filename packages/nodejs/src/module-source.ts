import { transform, transformSync } from "esbuild";
import { init, initSync, parse } from "es-module-lexer";

const REQUIRE_TRANSFORM_MARKER = "/*__secure_exec_require_esm__*/";
const IMPORT_META_URL_HELPER = "__secureExecImportMetaUrl__";

function isJavaScriptLikePath(filePath: string | undefined): boolean {
	return filePath === undefined || /\.[cm]?[jt]sx?$/.test(filePath);
}

function parseSourceSyntax(source: string, filePath?: string) {
	const [imports, , , hasModuleSyntax] = parse(source, filePath);
	const hasDynamicImport = imports.some((specifier) => specifier.d >= 0);
	const hasImportMeta = imports.some((specifier) => specifier.d === -2);
	return { hasModuleSyntax, hasDynamicImport, hasImportMeta };
}

function getRequireTransformOptions(
	filePath: string,
	syntax: ReturnType<typeof parseSourceSyntax>,
) {
	const requiresEsmWrapper =
		syntax.hasModuleSyntax || syntax.hasImportMeta;
	const bannerLines = requiresEsmWrapper ? [REQUIRE_TRANSFORM_MARKER] : [];
	if (syntax.hasImportMeta) {
		bannerLines.push(
			`const ${IMPORT_META_URL_HELPER} = require("node:url").pathToFileURL(__secureExecFilename).href;`,
		);
	}

	return {
		banner: bannerLines.length > 0 ? bannerLines.join("\n") : undefined,
		define: syntax.hasImportMeta
			? {
					"import.meta.url": IMPORT_META_URL_HELPER,
				}
			: undefined,
		format: "cjs" as const,
		loader: "js" as const,
		platform: "node" as const,
		sourcefile: filePath,
		supported: {
			"dynamic-import": false,
		},
		target: "node22",
	};
}

export async function sourceHasModuleSyntax(
	source: string,
	filePath?: string,
): Promise<boolean> {
	if (filePath?.endsWith(".mjs")) {
		return true;
	}
	if (filePath?.endsWith(".cjs")) {
		return false;
	}

	await init;
	return parseSourceSyntax(source, filePath).hasModuleSyntax;
}

export function transformSourceForRequireSync(
	source: string,
	filePath: string,
): string {
	if (!isJavaScriptLikePath(filePath)) {
		return source;
	}

	initSync();
	const syntax = parseSourceSyntax(source, filePath);
	if (!(syntax.hasModuleSyntax || syntax.hasDynamicImport || syntax.hasImportMeta)) {
		return source;
	}

	try {
		return transformSync(source, getRequireTransformOptions(filePath, syntax)).code;
	} catch {
		return source;
	}
}

export async function transformSourceForRequire(
	source: string,
	filePath: string,
): Promise<string> {
	if (!isJavaScriptLikePath(filePath)) {
		return source;
	}

	await init;
	const syntax = parseSourceSyntax(source, filePath);
	if (!(syntax.hasModuleSyntax || syntax.hasDynamicImport || syntax.hasImportMeta)) {
		return source;
	}

	try {
		return (
			await transform(source, getRequireTransformOptions(filePath, syntax))
		).code;
	} catch {
		return source;
	}
}
