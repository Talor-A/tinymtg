import { describe, expect, test } from "bun:test";
import { FORGE_TOKEN_SCRIPTS, forgeTokenScript } from "./token-corpus.ts";

// Forge checkout source: forge-gui/res/tokenscripts.
describe("vendored Forge token scripts", () => {
	test("loads the complete token-script corpus", () => {
		expect(FORGE_TOKEN_SCRIPTS.size).toBe(838);
		expect(forgeTokenScript("c_1_1_a_soldier")).toContain(
			"Types:Artifact Creature Soldier",
		);
	});

	test("asserts when a referenced token script is absent", () => {
		expect(() => forgeTokenScript("missing_token_script")).toThrow(
			"missing Forge token script missing_token_script",
		);
	});
});
