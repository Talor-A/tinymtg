import { describe, expect, test } from "bun:test";
import "../cards.ts"; // side effect: registers the card database
import {
	createReadContext,
	getSnapshot,
	perform,
	permanent,
	settlePriority,
	spawnCard,
} from "../index.ts";
import {
	ALICE,
	advanceUntil,
	atMain,
	BOB,
	passingAgents,
	playOneTurn,
	type SyncAgents,
	setupMain,
} from "./utils/engine-helpers.ts";

/**
 * A game at ALICE's precombat main with the snacker in ALICE's graveyard.
 * ALICE has already drawn their draw-step card — it is the turn's first draw,
 * which these tests count along with every `perform`ed one.
 */
function snackerInGraveyard(): ReturnType<typeof setupMain> {
	const state = setupMain();
	spawnCard(state, "sneaky-snacker", ALICE, "graveyard");
	// Enough library cards that no test accidentally draws out.
	for (let i = 0; i < 6; i++) spawnCard(state, "forest", ALICE, "library");
	return state;
}

describe("Sneaky Snacker", () => {
	test("returns tapped on the third draw of the turn, and only that one", () => {
		const state = snackerInGraveyard();
		const agents = passingAgents();
		const _snacker = state.players[ALICE].graveyard[0];

		// The draw step already drew the turn's first card.
		perform(state, { kind: "draw", player: ALICE }, agents);
		expect(
			state.pendingTriggers,
			"the second draw of the turn does not trigger",
		).toHaveLength(0);

		perform(state, { kind: "draw", player: ALICE }, agents);
		expect(
			state.pendingTriggers,
			"the third draw of the turn triggers from the graveyard",
		).toHaveLength(1);

		settlePriority(state, agents);
		// CR 400.7: the card that entered is a new permanent object, not the
		// graveyard card that triggered, so find it by name on the battlefield.
		const returned = state.battlefield.find((id) => {
			const object = permanent(state, id);
			return (
				object.representation.kind === "card" &&
				object.representation.cardId === "sneaky-snacker"
			);
		});
		if (returned === undefined)
			throw new Error("Sneaky Snacker did not return");
		const object = permanent(state, returned);
		expect(object.controller).toBe(ALICE);
		expect(object.tapped, "returns to the battlefield tapped").toBe(true);
		expect(
			getSnapshot(createReadContext(state), returned).currentCharacteristics,
		).toMatchObject({
			kind: "creature",
			name: "Sneaky Snacker",
			keywords: ["flying"],
			power: 2,
			toughness: 1,
		});
	});

	test("an opponent's draws do not count", () => {
		const state = snackerInGraveyard();
		const agents: SyncAgents = passingAgents();
		// BOB's turn: the draw step already drew them one card this turn.
		playOneTurn(state, agents);
		advanceUntil(state, agents, (next) => atMain(next, "precombat"));

		perform(state, { kind: "draw", player: BOB }, agents);
		perform(state, { kind: "draw", player: BOB }, agents);
		expect(
			state.pendingTriggers,
			"BOB's third draw this turn does not trigger ALICE's snacker",
		).toHaveLength(0);
		const inGraveyard = state.players[ALICE].graveyard[0];
		expect(
			inGraveyard !== undefined &&
				state.objects.get(inGraveyard)?.zone === "graveyard",
			"the snacker is still in the graveyard",
		).toBe(true);
	});

	test("the draw count resets at each turn boundary", () => {
		const state = snackerInGraveyard();
		const agents = passingAgents();
		// One more draw this turn: the second, so nothing returns yet.
		perform(state, { kind: "draw", player: ALICE }, agents);
		expect(state.pendingTriggers).toHaveLength(0);

		// A full round to ALICE's next turn: its draw step is the turn's
		// first draw again, and the snacker is still in the graveyard.
		playOneTurn(state, agents);
		playOneTurn(state, agents);
		advanceUntil(state, agents, (next) => atMain(next, "precombat"));
		expect(
			state.pendingTriggers,
			"the carried-over count did not fire on the draw step",
		).toHaveLength(0);
		const inGraveyard = state.players[ALICE].graveyard[0];
		expect(
			inGraveyard !== undefined &&
				state.objects.get(inGraveyard)?.zone === "graveyard",
			"the snacker is still in the graveyard",
		).toBe(true);

		perform(state, { kind: "draw", player: ALICE }, agents);
		expect(
			state.pendingTriggers,
			"the second draw of the new turn does not trigger",
		).toHaveLength(0);

		perform(state, { kind: "draw", player: ALICE }, agents);
		expect(
			state.pendingTriggers,
			"the third draw of the new turn triggers",
		).toHaveLength(1);
		settlePriority(state, agents);
		expect(state.players[ALICE].graveyard).toHaveLength(0);
	});

	test("the trigger functions only from the graveyard", () => {
		const state = setupMain();
		spawnCard(state, "sneaky-snacker", ALICE, "exile");
		const agents = passingAgents();

		for (let i = 0; i < 2; i++)
			perform(state, { kind: "draw", player: ALICE }, agents);
		expect(
			state.pendingTriggers,
			"a snacker in exile does not trigger",
		).toHaveLength(0);
		expect(state.players[ALICE].graveyard).toHaveLength(0);
	});
});
