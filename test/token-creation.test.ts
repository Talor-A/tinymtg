import { describe, expect, test } from "bun:test";
import "../cards.ts";
import {
	abilityId,
	type CharacteristicsSnapshot,
	createReadContext,
	newGame,
	perform,
	permanent,
	readObject,
	registerCard,
	spawnPermanent,
} from "../index.ts";
import { ALICE, BOB, created, passingAgents } from "./utils/engine-helpers.ts";

const TEST_ARTIFACT_TOKEN: CharacteristicsSnapshot = {
	kind: "non-creature",
	name: "Test Artifact Token",
	manaCost: "none",
	colors: [],
	supertypes: [],
	types: ["artifact"],
	subtypes: [],
	keywords: [],
	abilities: {
		static: [],
		activated: [],
		triggered: [],
		replacement: [],
		prohibition: [],
	},
};

registerCard({
	id: "test-trigger-token",
	name: "Test Trigger Token",
	types: ["creature"],
	colors: ["w"],
	manaCost: "none",
	power: 1,
	toughness: 1,
	triggers: [
		{
			id: "etb-life",
			text: "When this token enters, you gain 3 life.",
			condition: {
				kind: "change zone",
				from: "any",
				to: "battlefield",
				selector: { kind: "self" },
			},
			targets: [],
			effects: [{ kind: "gain-life", player: "you", amount: 3 }],
		},
	],
});

const TEST_TRIGGER_TOKEN: CharacteristicsSnapshot = {
	kind: "creature",
	name: "Test Trigger Token",
	manaCost: "none",
	colors: ["w"],
	supertypes: [],
	types: ["creature"],
	subtypes: [],
	keywords: [],
	abilities: {
		static: [],
		activated: [],
		triggered: [abilityId("triggered", "test-trigger-token", 0)],
		replacement: [],
		prohibition: [],
	},
	power: 1,
	toughness: 1,
};

const COPY_TOKEN: CharacteristicsSnapshot = {
	kind: "creature",
	name: "Test Forced Copy Token",
	manaCost: "none",
	colors: ["u"],
	supertypes: [],
	types: ["creature"],
	subtypes: ["Shapeshifter"],
	keywords: [],
	abilities: {
		static: [],
		activated: [],
		triggered: [],
		replacement: [abilityId("replacement", "test-forced-copy", 0)],
		prohibition: [],
	},
	power: 0,
	toughness: 0,
};

describe("token creation", () => {
	test("runs enter-the-battlefield replacements before materializing the token", () => {
		const state = newGame();
		spawnPermanent(state, "root-maze", BOB);

		const result = perform(
			state,
			{
				kind: "create token",
				controller: ALICE,
				characteristics: TEST_ARTIFACT_TOKEN,
				amount: 1,
			},
			passingAgents(),
		);

		const tokenId = created(result);
		const token = permanent(state, tokenId);
		expect(token.tapped).toBe(true);
		expect(token.token).toBe(true);
		expect(token.representation.kind).toBe("token");
		expect(
			readObject(createReadContext(state), tokenId).currentCharacteristics.name,
		).toBe("Test Artifact Token");
		expect(() => structuredClone(state)).not.toThrow();
	});

	test("detects the newly created token's own enter-the-battlefield trigger", () => {
		const state = newGame();

		const result = perform(
			state,
			{
				kind: "create token",
				controller: ALICE,
				characteristics: TEST_TRIGGER_TOKEN,
				amount: 1,
			},
			passingAgents(),
		);

		const tokenId = created(result);
		expect(state.pendingTriggers).toHaveLength(1);
		expect(state.pendingTriggers[0]).toMatchObject({
			source: tokenId,
			triggerId: "test-trigger-token:0",
			controller: ALICE,
		});
	});

	test("runs the token's copy-tier replacement with the same reserved identity", () => {
		const state = newGame();
		spawnPermanent(state, "grizzly-bears", BOB);

		const result = perform(
			state,
			{
				kind: "create token",
				controller: ALICE,
				characteristics: COPY_TOKEN,
				amount: 1,
			},
			passingAgents(),
		);

		const tokenId = created(result);
		const token = permanent(state, tokenId);
		expect(token.id).toBe(tokenId);
		expect(token.token).toBe(true);
		expect(token.representation.kind).toBe("token");
		expect(
			readObject(createReadContext(state), tokenId).currentCharacteristics.name,
		).toBe("Grizzly Bears");
	});

	test("applies CreateTokenEvent replacements before each token enters", () => {
		const state = newGame();
		spawnPermanent(state, "doubling-season", ALICE);
		spawnPermanent(state, "root-maze", BOB);

		const result = perform(
			state,
			{
				kind: "create token",
				controller: ALICE,
				characteristics: TEST_ARTIFACT_TOKEN,
				amount: 1,
			},
			passingAgents(),
		);

		expect(result.created).toHaveLength(2);
		for (const tokenId of result.created) {
			expect(permanent(state, tokenId).tapped).toBe(true);
		}
	});
});
