import { describe, expect, test } from "bun:test";
import "../cards.ts";
import {
	abilityId,
	createReadContext,
	executeAbilityAction,
	getAbilityDefinition,
	perform,
	readObject,
	settlePriority,
} from "../index.ts";
import { CLUE_TOKEN } from "../tokens.ts";
import {
	ALICE,
	created,
	passingAgents,
	setupMain,
} from "./utils/engine-helpers.ts";

const CLUE_ABILITY = abilityId("activated", "clue-token", 0);

describe("named artifact tokens", () => {
	test("Clue has its canonical characteristics and ability", () => {
		expect(CLUE_TOKEN).toEqual({
			kind: "non-creature",
			name: "Clue Token",
			manaCost: "none",
			colors: [],
			supertypes: [],
			types: ["artifact"],
			subtypes: ["Clue"],
			keywords: [],
			abilities: {
				static: [],
				activated: [CLUE_ABILITY],
				triggered: [],
				replacement: [],
				prohibition: [],
			},
		});
		expect(getAbilityDefinition("activated", CLUE_ABILITY)).toEqual({
			kind: "activated",
			id: "draw-card",
			text: "{2}, Sacrifice this token: Draw a card.",
			cost: {
				mana: { n: 2 },
				tapSelf: false,
				sacrifice: { selector: { kind: "self" }, amount: 1 },
			},
			targets: [],
			effects: [{ kind: "draw", player: "you", amount: 1 }],
		});
	});

	test("Clue pays two mana and sacrifices itself before drawing", () => {
		const state = setupMain();
		const handSize = state.players[ALICE].hand.length;
		const librarySize = state.players[ALICE].library.length;
		const result = perform(
			state,
			{
				kind: "create token",
				controller: ALICE,
				characteristics: CLUE_TOKEN,
				amount: 1,
			},
			passingAgents(),
		);
		const clue = created(result);
		const snapshot = readObject(createReadContext(state), clue);
		expect(snapshot.currentCharacteristics).toEqual(CLUE_TOKEN);

		state.players[ALICE].manaPool.c = 2;
		const agents = passingAgents();
		executeAbilityAction(
			state,
			ALICE,
			{
				kind: "activate ability",
				source: clue,
				ability: CLUE_ABILITY,
			},
			agents,
		);

		expect(state.players[ALICE].manaPool.c).toBe(0);
		expect(state.battlefield).not.toContain(clue);
		expect(state.stack).toHaveLength(1);
		expect(state.players[ALICE].hand).toHaveLength(handSize);
		expect(state.players[ALICE].library).toHaveLength(librarySize);

		settlePriority(state, agents);

		expect(state.players[ALICE].hand).toHaveLength(handSize + 1);
		expect(state.players[ALICE].library).toHaveLength(librarySize - 1);
		expect(state.stack).toHaveLength(0);
	});
});
