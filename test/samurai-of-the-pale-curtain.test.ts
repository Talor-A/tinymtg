import {
	createReadContext,
	perform,
	settlePriority,
	spawnCard,
	spawnPermanent,
} from "../index.ts";
/**
 * samurai-of-the-pale-curtain.test.ts — bushido and the graveyard-to-exile
 * replacement, on the imported card that prints both.
 *
 * Bushido 1 (CR 702.45a) is a keyword the engine compiles into an ordinary
 * trigger, the way it already does prowess, and it is the only trigger keyed
 * on blockers being declared. The card's other half replaces a permanent's
 * trip to a graveyard with exile, its own included.
 */

import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "../agents.ts";
import { CARDS } from "../cards.ts";
import {
	abilityId,
	createEngine,
	type GameState,
	getSnapshot,
	type ObjectId,
} from "../index.ts";
import {
	ALICE,
	advanceUntil,
	BOB,
	isAt,
	newInProgressGame,
	passingAgents,
	type SyncAgents,
	setupMain,
} from "./utils/engine-helpers.ts";

const engine = createEngine(CARDS);

const SAMURAI = "samurai-of-the-pale-curtain";
const BUSHIDO = abilityId("triggered", SAMURAI, 0);

/** Scripts ALICE to attack with `attacker` and BOB to block it with `blockers`. */
function attackAndBlock(attacker: ObjectId, blockers: ObjectId[]): SyncAgents {
	return [
		new ScriptedAgent([], [], [], [[attacker]]),
		new ScriptedAgent(
			[],
			[],
			[],
			[],
			[blockers.map((blocker) => ({ blocker, attacker }))],
		),
	];
}

/** A game with libraries stocked, so the draw step never decks anyone. */
function combatGame(): GameState {
	const state = newInProgressGame(engine);
	for (let i = 0; i < 3; i++) {
		spawnCard(state, "forest", ALICE, "library");
		spawnCard(state, "forest", BOB, "library");
	}
	return state;
}

function powerToughness(
	state: GameState,
	id: ObjectId,
): { power: number; toughness: number } {
	const characteristics = getSnapshot(
		createReadContext(engine, state),
		id,
	).currentCharacteristics;
	if (characteristics.kind !== "creature")
		throw new Error(`${characteristics.name} is not a creature`);
	return {
		power: characteristics.power,
		toughness: characteristics.toughness,
	};
}

describe("Samurai of the Pale Curtain: bushido", () => {
	test("the printed keyword compiles to one blocks-or-becomes-blocked trigger", () => {
		const state = setupMain(engine);
		const samurai = spawnPermanent(engine, state, SAMURAI, ALICE);
		const characteristics = getSnapshot(
			createReadContext(engine, state),
			samurai.id,
		).currentCharacteristics;

		expect(characteristics.keywords).toEqual(["bushido 1"]);
		expect(characteristics.abilities.triggered).toEqual([BUSHIDO]);
	});

	test("an attacking Samurai that becomes blocked gets +1/+1", () => {
		const state = combatGame();
		const samurai = spawnPermanent(engine, state, SAMURAI, ALICE);
		const blocker = spawnPermanent(engine, state, "eager-cadet", BOB);
		const agents = attackAndBlock(samurai.id, [blocker.id]);

		advanceUntil(engine, state, agents, (next) =>
			isAt(next, "declare blockers"),
		);
		settlePriority(engine, state, agents);

		expect(powerToughness(state, samurai.id)).toEqual({
			power: 3,
			toughness: 3,
		});
		// The 1/1 blocker takes 3 and the 3/3 Samurai survives its 1 back.
		advanceUntil(engine, state, agents, (next) => isAt(next, "end combat"));
		expect(state.objects.has(blocker.id)).toBe(false);
		expect(state.objects.has(samurai.id)).toBe(true);
	});

	test("a blocking Samurai gets +1/+1 too", () => {
		const state = combatGame();
		const attacker = spawnPermanent(engine, state, "grizzly-bears", ALICE);
		const samurai = spawnPermanent(engine, state, SAMURAI, BOB);
		const agents = attackAndBlock(attacker.id, [samurai.id]);

		advanceUntil(engine, state, agents, (next) =>
			isAt(next, "declare blockers"),
		);
		settlePriority(engine, state, agents);

		expect(powerToughness(state, samurai.id)).toEqual({
			power: 3,
			toughness: 3,
		});
		// A 3/3 blocker kills the 2/2 attacker and outlives its 2 damage.
		advanceUntil(engine, state, agents, (next) => isAt(next, "end combat"));
		expect(state.objects.has(attacker.id)).toBe(false);
		expect(state.objects.has(samurai.id)).toBe(true);
	});

	test("an unblocked Samurai stays 2/2", () => {
		const state = combatGame();
		const samurai = spawnPermanent(engine, state, SAMURAI, ALICE);
		const agents: SyncAgents = [
			new ScriptedAgent([], [], [], [[samurai.id]]),
			new ScriptedAgent(),
		];

		advanceUntil(engine, state, agents, (next) =>
			isAt(next, "declare blockers"),
		);
		settlePriority(engine, state, agents);

		expect(state.pendingTriggers).toHaveLength(0);
		expect(powerToughness(state, samurai.id)).toEqual({
			power: 2,
			toughness: 2,
		});
		advanceUntil(engine, state, agents, (next) => isAt(next, "end combat"));
		expect(state.players[BOB].life).toBe(18);
	});
});

describe("Samurai of the Pale Curtain: graveyard replacement", () => {
	test("a permanent that would die is exiled instead", () => {
		const state = setupMain(engine);
		const agents = passingAgents();
		spawnPermanent(engine, state, SAMURAI, ALICE);
		const bears = spawnPermanent(engine, state, "grizzly-bears", BOB);

		perform(engine, state, { kind: "sacrifice", object: bears.id }, agents);

		expect(state.players[BOB].graveyard).toEqual([]);
		expect(state.players[BOB].exile).toHaveLength(1);
	});

	test("the Samurai exiles itself, since it is a permanent too", () => {
		const state = setupMain(engine);
		const agents = passingAgents();
		const samurai = spawnPermanent(engine, state, SAMURAI, ALICE);

		perform(engine, state, { kind: "sacrifice", object: samurai.id }, agents);

		expect(state.players[ALICE].graveyard).toEqual([]);
		expect(state.players[ALICE].exile).toHaveLength(1);
	});

	test("a card put into a graveyard from hand is untouched", () => {
		const state = setupMain(engine);
		const agents = passingAgents();
		spawnPermanent(engine, state, SAMURAI, ALICE);
		const graveyardBefore = state.players[ALICE].graveyard.length;
		spawnCard(state, "forest", ALICE, "hand");

		perform(
			engine,
			state,
			{ kind: "discard", player: ALICE, cards: { kind: "any" } },
			agents,
		);

		// Origin$ Battlefield: only a permanent leaving play is redirected.
		expect(state.players[ALICE].graveyard).toHaveLength(graveyardBefore + 1);
		expect(state.players[ALICE].exile).toEqual([]);
	});
});
