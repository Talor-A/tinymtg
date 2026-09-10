import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	forgeAbilityDiscriminator,
	getForgeParam,
	lookupForgeSVar,
	parseForgeCardScript,
	parseForgeParams,
	printForgeCardScript,
} from "./ast.ts";

const CORPUS_ROOT = join(import.meta.dir, "..", "cards", "cardsfolder");

function corpusFiles(): string[] {
	const files: string[] = [];
	const walk = (directory: string): void => {
		for (const entry of readdirSync(directory).sort()) {
			const path = join(directory, entry);
			if (statSync(path).isDirectory()) walk(path);
			else if (path.endsWith(".txt")) files.push(path);
		}
	};
	walk(CORPUS_ROOT);
	return files;
}

describe("Forge syntax", () => {
	test("preserves meaningful lines and canonical round trips", () => {
		const source =
			"# comment\r\nName: Bear\r\nA:SP$ Draw | NumCards$ 1\r\nunknown\r\n";
		const first = parseForgeCardScript(source);
		expect(first.document.nodes).toHaveLength(3);
		expect(first.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			"MALFORMED_LINE",
		]);
		const printed = printForgeCardScript(first.document);
		expect(printForgeCardScript(parseForgeCardScript(printed).document)).toBe(
			printed,
		);
	});

	test("parses parameters at the first dollar and keeps duplicates", () => {
		const params = parseForgeParams(
			"SP$ Draw | NumCards$ 2 | numcards$ 3 | Count$ Card$Types",
		);
		expect(params.entries.map((entry) => entry.key)).toEqual([
			"SP",
			"NumCards",
			"numcards",
			"Count",
		]);
		expect(getForgeParam(params, "NUMCARDS")).toBe("3");
		expect(getForgeParam(params, "Count")).toBe("Card$Types");
	});

	test("normalizes exactly one ability discriminator", () => {
		expect(forgeAbilityDiscriminator(parseForgeParams("SP$ Draw"))).toEqual({
			token: "SP",
			api: "draw",
		});
		expect(
			forgeAbilityDiscriminator(parseForgeParams("SP$ Draw | DB$ Draw")),
		).toBeNull();
	});
});

describe("adversarial open-vocabulary names", () => {
	for (const name of ["constructor", "prototype", "__proto__", "toString"]) {
		test(`treats ${name} as an ordinary parameter and SVar name`, () => {
			const params = parseForgeParams(`${name}$ value`);
			expect(getForgeParam(params, name)).toBe("value");
			expect(getForgeParam(params, "absent")).toBeUndefined();
			const result = parseForgeCardScript(`SVar:${name}:1\n`);
			const face = result.card.faces[0];
			if (face === undefined) throw new Error("missing original face");
			expect(lookupForgeSVar(face, name)?.value).toBe("1");
		});
	}
});

test("the complete card corpus parses without throwing or losing lines", () => {
	for (const path of corpusFiles()) {
		const source = readFileSync(path, "utf8");
		const parsed = parseForgeCardScript(source);
		const meaningful = source
			.split(/\r\n|\n|\r/)
			.map((line) => line.trim())
			.filter((line) => line !== "" && !line.startsWith("#"));
		expect(parsed.document.nodes.length).toBe(meaningful.length);
		const reparsed = parseForgeCardScript(
			printForgeCardScript(parsed.document),
		);
		expect(reparsed.document.nodes.length).toBe(parsed.document.nodes.length);
	}
}, 120_000);
