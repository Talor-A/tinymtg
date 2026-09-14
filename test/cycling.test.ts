import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "../agents.ts";
import { CARDS } from "../cards.ts";
import {
	abilityId,
	createEngine,
	IllegalAbilityActivationError,
} from "../index.ts";
import { ALICE, passingAgents, setupMain } from "./utils/engine-helpers.ts";

const engine = createEngine(CARDS);
const boonCycling = abilityId("activated", "boon-of-the-wish-giver", 0);
const moorCycling = abilityId("activated", "barren-moor", 0);

describe("cycling", () => {
	test("discards the source card, uses the stack, and draws on resolution", () => {
		const state = setupMain(engine);
		const boon = engine.spawnCard(
			state,
			"boon-of-the-wish-giver",
			ALICE,
			"hand",
		);
		const other = engine.spawnCard(state, "grizzly-bears", ALICE, "hand");
		engine.spawnCard(state, "eager-cadet", ALICE, "library");
		state.players[ALICE].manaPool.c = 1;
		const handBefore = state.players[ALICE].hand.length;
		const libraryBefore = state.players[ALICE].library.length;

		engine.executeAbilityAction(
			state,
			ALICE,
			{ kind: "activate ability", source: boon.id, ability: boonCycling },
			passingAgents(),
		);

		expect(state.stack).toHaveLength(1);
		expect(state.objects.has(boon.id)).toBe(false);
		expect(state.players[ALICE].hand).toContain(other.id);
		expect(
			state.players[ALICE].graveyard.map((id) => engine.name(state, id)),
		).toContain("Boon of the Wish-Giver");
		expect(state.log.some((line) => line.includes("> cycle(P0"))).toBe(true);

		engine.settlePriority(state, passingAgents());
		expect(state.players[ALICE].hand).toHaveLength(handBefore);
		expect(state.players[ALICE].library).toHaveLength(libraryBefore - 1);
	});

	test("works on a land with another activated ability", () => {
		const state = setupMain(engine);
		const moor = engine.spawnCard(state, "barren-moor", ALICE, "hand");
		state.players[ALICE].manaPool.b = 1;

		engine.executeAbilityAction(
			state,
			ALICE,
			{ kind: "activate ability", source: moor.id, ability: moorCycling },
			passingAgents(),
		);
		engine.settlePriority(state, passingAgents());

		expect(
			state.players[ALICE].graveyard.map((id) => engine.name(state, id)),
		).toContain("Barren Moor");
	});

	test("cannot be activated after the card leaves its owner's hand", () => {
		const state = setupMain(engine);
		const boon = engine.spawnCard(
			state,
			"boon-of-the-wish-giver",
			ALICE,
			"graveyard",
		);
		state.players[ALICE].manaPool.c = 1;

		expect(() =>
			engine.executeAbilityAction(
				state,
				ALICE,
				{ kind: "activate ability", source: boon.id, ability: boonCycling },
				[new ScriptedAgent(), new ScriptedAgent()],
			),
		).toThrow(IllegalAbilityActivationError);
	});
});
