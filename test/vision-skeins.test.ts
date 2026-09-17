import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "../agents.ts";
import { defineCard } from "../card-def.ts";
import { CARDS } from "../cards.ts";
import type { ObjectId, PlayerId } from "../index.ts";
import {
	abilityId,
	createEngine,
	executeAbilityAction,
	settlePriority,
	spawnCard,
	spawnPermanent,
} from "../index.ts";
import {
	ALICE,
	BOB,
	expectScriptConsumed,
	passingAgents,
	setupMain,
} from "./utils/engine-helpers.ts";

/**
 * No basic land produces blue, so a blue source is defined here rather than
 * registering an Island as a side effect of writing this test.
 */
const TEST_CARD_1 = defineCard({
	id: "test-blue-source",
	name: "Test Blue Source",
	types: ["land"],
	colors: [],
	manaCost: "none",
	activatedAbilities: [
		{
			kind: "mana",
			id: "intrinsic-mana-u",
			text: "Add {U}.",
			cost: { mana: "zero", tapSelf: true },
			manaOptions: [{ w: 0, u: 1, b: 0, r: 0, g: 0 }],
		},
	],
});

const engine = createEngine([...CARDS, TEST_CARD_1]);

const blueMana = abilityId("activated", "test-blue-source", 0);
const forestMana = abilityId("activated", "forest", 0);

function castAction(card: ObjectId) {
	return { kind: "cast" as const, card };
}

function tapForMana(
	state: Parameters<typeof executeAbilityAction>[1],
	player: PlayerId,
	sources: { id: ObjectId; ability: typeof blueMana }[],
): void {
	for (const { id, ability } of sources) {
		executeAbilityAction(
			engine,
			state,
			player,
			{ kind: "activate ability", source: id, ability },
			passingAgents(),
		);
	}
}

describe("Vision Skeins", () => {
	test("each player draws two cards", () => {
		const state = setupMain(engine);
		const skeins = spawnCard(state, "vision-skeins", ALICE, "hand");
		const island = spawnPermanent(engine, state, "test-blue-source", ALICE);
		const forest = spawnPermanent(engine, state, "forest", ALICE);
		tapForMana(state, ALICE, [
			{ id: island.id, ability: blueMana },
			{ id: forest.id, ability: forestMana },
		]);

		const aliceHand = state.players[ALICE].hand.length;
		const bobHand = state.players[BOB].hand.length;
		const aliceLibrary = state.players[ALICE].library.length;
		const bobLibrary = state.players[BOB].library.length;

		const caster = new ScriptedAgent([], [], [castAction(skeins.id)]);
		settlePriority(engine, state, [caster, new ScriptedAgent()]);
		expectScriptConsumed(caster);

		// "Each player draws two cards." ALICE's hand nets +1: two draws in,
		// the spell itself out. BOB never held the spell, so their hand nets +2.
		expect(state.players[ALICE].hand).toHaveLength(aliceHand + 1);
		expect(state.players[BOB].hand).toHaveLength(bobHand + 2);
		expect(state.players[ALICE].library).toHaveLength(aliceLibrary - 2);
		expect(state.players[BOB].library).toHaveLength(bobLibrary - 2);

		// CR 608.2m: the spell itself goes to its owner's graveyard.
		expect(state.players[ALICE].graveyard).toHaveLength(1);
	});

	test("the active player draws first when the nonactive player casts it", () => {
		const state = setupMain(engine);
		const skeins = spawnCard(state, "vision-skeins", BOB, "hand");
		const island = spawnPermanent(engine, state, "test-blue-source", BOB);
		const forest = spawnPermanent(engine, state, "forest", BOB);
		tapForMana(state, BOB, [
			{ id: island.id, ability: blueMana },
			{ id: forest.id, ability: forestMana },
		]);

		state.log.length = 0;
		const caster = new ScriptedAgent([], [], [castAction(skeins.id)]);
		settlePriority(engine, state, [new ScriptedAgent(), caster]);
		expectScriptConsumed(caster);

		// CR 121.2c: for an instruction that makes multiple players draw,
		// the active player performs all of their draws before the next player.
		expect(state.log.filter((line) => line.includes("> draw cards"))).toEqual([
			"> draw cards(P0, 2)",
			"> draw cards(P1, 2)",
		]);
	});
});
