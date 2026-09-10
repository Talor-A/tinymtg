import { describe, expect, test } from "bun:test";
import "../cards.ts"; // side effect: registers the card database
import type { CastAction, ObjectId } from "../index.ts";
import {
	executeCastAction,
	registerCard,
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

registerCard({
	id: "test-fruition-free-instant",
	name: "Test Fruition Free Instant",
	types: ["instant"],
	colors: [],
	manaCost: "zero",
	spell: {
		id: "test-fruition-free-instant-spell",
		text: "Do nothing.",
		targets: [],
		effects: [],
	},
});

function castAction(card: ObjectId): CastAction {
	return { kind: "cast", card };
}

describe("Forced Fruition", () => {
	test("an opponent casting a spell draws seven", () => {
		const state = setupMain();
		spawnPermanent(state, "forced-fruition", ALICE);
		const instant = spawnCard(state, "test-fruition-free-instant", BOB, "hand");
		// The seeded library holds three cards; seven more keep the draw from
		// emptying it and losing BOB the game mid-test.
		for (let i = 0; i < 7; i++) spawnCard(state, "forest", BOB, "library");

		const bobHand = state.players[BOB].hand.length;
		const aliceHand = state.players[ALICE].hand.length;
		const bobLibrary = state.players[BOB].library.length;

		executeCastAction(state, BOB, castAction(instant.id), passingAgents());
		expect(state.pendingTriggers).toHaveLength(1);

		settlePriority(state, passingAgents());

		// "Whenever an opponent casts a spell, that player draws seven cards."
		// BOB's hand nets +6: seven drawn, the cast spell itself gone.
		expect(state.players[BOB].hand).toHaveLength(bobHand + 6);
		expect(state.players[BOB].library).toHaveLength(bobLibrary - 7);
		expect(state.players[ALICE].hand).toHaveLength(aliceHand);
	});
});
