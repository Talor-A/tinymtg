import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "../agents.ts";
import { CARDS } from "../cards.ts";
import {
	abilityId,
	createEngine,
	executeAbilityAction,
	IllegalAbilityActivationError,
	name,
	settlePriority,
	spawnCard,
	spawnPermanent,
} from "../index.ts";
import {
	ALICE,
	BOB,
	passingAgents,
	setupMain,
} from "./utils/engine-helpers.ts";

const engine = createEngine(CARDS);
const boonCycling = abilityId("activated", "boon-of-the-wish-giver", 0);
const moorCycling = abilityId("activated", "barren-moor", 0);
const faithCycling = abilityId("activated", "renewed-faith", 0);
const ashBarrensCycling = abilityId("activated", "ash-barrens", 0);
const oliphauntCycling = abilityId("activated", "oliphaunt", 0);

describe("cycling", () => {
	test("Ash Barrens finds, reveals, and moves a basic land before shuffling", () => {
		const state = setupMain(engine);
		const ashBarrens = spawnCard(state, "ash-barrens", ALICE, "hand");
		const forest = spawnCard(state, "forest", ALICE, "library");
		const nonland = spawnCard(state, "grizzly-bears", ALICE, "library");
		state.players[ALICE].manaPool.c = 1;
		const alice = new ScriptedAgent();
		alice.searchChoices.push(forest.id);

		executeAbilityAction(
			engine,
			state,
			ALICE,
			{
				kind: "activate ability",
				source: ashBarrens.id,
				ability: ashBarrensCycling,
			},
			[alice, new ScriptedAgent()],
		);
		settlePriority(engine, state, [alice, new ScriptedAgent()]);

		expect(
			state.players[ALICE].hand.map((id) => name(engine, state, id)),
		).toContain("Forest");
		expect(state.players[ALICE].library).toContain(nonland.id);
		expect(state.log).toContain("  [reveal] Forest");
		expect(
			state.players[ALICE].graveyard.map((id) => name(engine, state, id)),
		).toContain("Ash Barrens");
	});

	test("Oliphaunt mountaincycles without drawing a card", () => {
		const state = setupMain(engine);
		const oliphaunt = spawnCard(state, "oliphaunt", ALICE, "hand");
		const mountain = spawnCard(state, "mountain", ALICE, "library");
		const forest = spawnCard(state, "forest", ALICE, "library");
		state.players[ALICE].manaPool.c = 1;
		const handBefore = state.players[ALICE].hand.length;
		const alice = new ScriptedAgent();
		alice.searchChoices.push(mountain.id);

		executeAbilityAction(
			engine,
			state,
			ALICE,
			{
				kind: "activate ability",
				source: oliphaunt.id,
				ability: oliphauntCycling,
			},
			[alice, new ScriptedAgent()],
		);
		settlePriority(engine, state, [alice, new ScriptedAgent()]);

		expect(state.players[ALICE].hand).toHaveLength(handBefore);
		expect(
			state.players[ALICE].hand.map((id) => name(engine, state, id)),
		).toContain("Mountain");
		expect(state.players[ALICE].library).toContain(forest.id);
		expect(state.log).toContain("  [reveal] Mountain");
		expect(
			state.players[ALICE].graveyard.map((id) => name(engine, state, id)),
		).toContain("Oliphaunt");
	});

	test("discards the source card, uses the stack, and draws on resolution", () => {
		const state = setupMain(engine);
		const boon = spawnCard(state, "boon-of-the-wish-giver", ALICE, "hand");
		const other = spawnCard(state, "grizzly-bears", ALICE, "hand");
		spawnCard(state, "eager-cadet", ALICE, "library");
		state.players[ALICE].manaPool.c = 1;
		const handBefore = state.players[ALICE].hand.length;
		const libraryBefore = state.players[ALICE].library.length;

		executeAbilityAction(
			engine,
			state,
			ALICE,
			{ kind: "activate ability", source: boon.id, ability: boonCycling },
			passingAgents(),
		);

		expect(state.stack).toHaveLength(1);
		expect(state.objects.has(boon.id)).toBe(false);
		expect(state.players[ALICE].hand).toContain(other.id);
		expect(
			state.players[ALICE].graveyard.map((id) => name(engine, state, id)),
		).toContain("Boon of the Wish-Giver");
		expect(state.log.some((line) => line.includes("> cycle(P0"))).toBe(true);

		settlePriority(engine, state, passingAgents());
		expect(state.players[ALICE].hand).toHaveLength(handBefore);
		expect(state.players[ALICE].library).toHaveLength(libraryBefore - 1);
	});

	test("works on a land with another activated ability", () => {
		const state = setupMain(engine);
		const moor = spawnCard(state, "barren-moor", ALICE, "hand");
		state.players[ALICE].manaPool.b = 1;

		executeAbilityAction(
			engine,
			state,
			ALICE,
			{ kind: "activate ability", source: moor.id, ability: moorCycling },
			passingAgents(),
		);
		settlePriority(engine, state, passingAgents());

		expect(
			state.players[ALICE].graveyard.map((id) => name(engine, state, id)),
		).toContain("Barren Moor");
	});

	test("cannot be activated after the card leaves its owner's hand", () => {
		const state = setupMain(engine);
		const boon = spawnCard(state, "boon-of-the-wish-giver", ALICE, "graveyard");
		state.players[ALICE].manaPool.c = 1;

		expect(() =>
			executeAbilityAction(
				engine,
				state,
				ALICE,
				{ kind: "activate ability", source: boon.id, ability: boonCycling },
				[new ScriptedAgent(), new ScriptedAgent()],
			),
		).toThrow(IllegalAbilityActivationError);
	});

	test("battlefield permanents trigger when their controller cycles another card", () => {
		const state = setupMain(engine);
		spawnPermanent(engine, state, "drannith-healer", ALICE);
		spawnPermanent(engine, state, "drannith-stinger", ALICE);
		const boon = spawnCard(state, "boon-of-the-wish-giver", ALICE, "hand");
		state.players[ALICE].manaPool.c = 1;

		executeAbilityAction(
			engine,
			state,
			ALICE,
			{ kind: "activate ability", source: boon.id, ability: boonCycling },
			passingAgents(),
		);
		settlePriority(engine, state, passingAgents());

		expect(state.players[ALICE].life).toBe(21);
		expect(state.players[BOB].life).toBe(19);
	});

	test("a cycled card can trigger from its new graveyard object", () => {
		const state = setupMain(engine);
		const faith = spawnCard(state, "renewed-faith", ALICE, "hand");
		state.players[ALICE].manaPool.c = 1;
		state.players[ALICE].manaPool.w = 1;

		executeAbilityAction(
			engine,
			state,
			ALICE,
			{ kind: "activate ability", source: faith.id, ability: faithCycling },
			passingAgents(),
		);
		settlePriority(engine, state, passingAgents());

		expect(state.players[ALICE].life).toBe(22);
	});
});
