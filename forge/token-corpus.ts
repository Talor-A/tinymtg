import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";

const TOKEN_SCRIPT_ROOT = join(import.meta.dir, "..", "cards", "tokenscripts");

/** The vendored Forge token-script database, keyed case-insensitively by script id. */
export const FORGE_TOKEN_SCRIPTS: ReadonlyMap<string, string> = (() => {
	const scripts = new Map<string, string>();
	for (const filename of readdirSync(TOKEN_SCRIPT_ROOT).sort()) {
		if (extname(filename) !== ".txt") continue;
		const id = filename.slice(0, -4).toLowerCase();
		assert(!scripts.has(id), `duplicate Forge token script ${id}`);
		scripts.set(id, readFileSync(join(TOKEN_SCRIPT_ROOT, filename), "utf8"));
	}
	return scripts;
})();

/**
 * Resolve Forge's TokenScript$ foreign key. A missing script means the vendored
 * card and token corpora disagree, which is an invariant failure rather than an
 * unsupported card feature.
 */
export function forgeTokenScript(id: string): string {
	const source = FORGE_TOKEN_SCRIPTS.get(id.trim().toLowerCase());
	assert(source !== undefined, `missing Forge token script ${id}`);
	return source;
}
