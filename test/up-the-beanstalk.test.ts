import { describe, expect, test } from "bun:test";
import { CARDS } from "../cards.ts";
import type { GameState, ObjectId, PlayerId } from "../index.ts";
import {
	createEngine,
	executeCastAction,
	perform,
	settlePriority,
	spawnCard,
} from "../index.ts";
import {
	ALICE,
	BOB,
	created,
	passingAgents,
	setupMain,
} from "./utils/engine-helpers.ts";

const engine = createEngine(CARDS);

/**
 * Moves Up the Beanstalk from its owner's hand onto the battlefield.
 *
 * The enchantment's first trigger watches its own arrival, so it has to get
 * there by a real zone change; spawning it onto the battlefield would place
 * the permanent without the event the trigger is looking for.
 */
function resolveBeanstalk(
	state: GameState,
	controller: PlayerId,
): { beanstalk: ObjectId; state: GameState } {
	const card = spawnCard(state, "up-the-beanstalk", controller, "hand");
	const entry = perform(
		engine,
		state,
		{
			kind: "change zone",
			object: card.id,
			from: "hand",
			destination: { zone: "battlefield", controller },
			cause: "resolve",
		},
		passingAgents(),
	);
	return { beanstalk: created(entry), state };
}

/** Enough mana of every type to pay for anything these tests cast. */
function fillManaPool(state: GameState, player: PlayerId): void {
	state.players[player].manaPool = { w: 5, u: 5, b: 5, r: 5, g: 5, c: 5 };
}

describe("Up the Beanstalk", () => {
	test("draws a card when it enters", () => {
		const state = setupMain(engine);
		spawnCard(state, "forest", ALICE, "library");
		const hand = state.players[ALICE].hand.length;
		const library = state.players[ALICE].library.length;

		resolveBeanstalk(state, ALICE);
		expect(state.pendingTriggers).toHaveLength(1);
		settlePriority(engine, state, passingAgents());

		expect(state.players[ALICE].hand).toHaveLength(hand + 1);
		expect(state.players[ALICE].library).toHaveLength(library - 1);
	});

	test("draws a card when you cast a spell with mana value 5", () => {
		const state = setupMain(engine);
		spawnCard(state, "forest", ALICE, "library");
		resolveBeanstalk(state, ALICE);
		settlePriority(engine, state, passingAgents());

		// Thor Odinson costs {3}{R}{W}: mana value exactly 5, the low end of
		// "5 or greater".
		const thor = spawnCard(state, "thor-odinson", ALICE, "hand");
		fillManaPool(state, ALICE);
		const hand = state.players[ALICE].hand.length;
		const library = state.players[ALICE].library.length;

		executeCastAction(
			engine,
			state,
			ALICE,
			{ kind: "cast", card: thor.id },
			passingAgents(),
		);
		expect(state.pendingTriggers).toHaveLength(1);
		settlePriority(engine, state, passingAgents());

		// The spell left the hand and the draw replaced it, so the hand is level
		// while the library is one shorter.
		expect(state.players[ALICE].hand).toHaveLength(hand);
		expect(state.players[ALICE].library).toHaveLength(library - 1);
	});

	test("does not trigger on a spell with mana value 4", () => {
		const state = setupMain(engine);
		spawnCard(state, "forest", ALICE, "library");
		resolveBeanstalk(state, ALICE);
		settlePriority(engine, state, passingAgents());

		// Beast Whisperer costs {2}{G}{G}: one short of the threshold.
		const whisperer = spawnCard(state, "beast-whisperer", ALICE, "hand");
		fillManaPool(state, ALICE);

		executeCastAction(
			engine,
			state,
			ALICE,
			{ kind: "cast", card: whisperer.id },
			passingAgents(),
		);
		expect(state.pendingTriggers).toHaveLength(0);
	});

	test("does not trigger on an opponent's expensive spell", () => {
		const state = setupMain(engine);
		spawnCard(state, "forest", BOB, "library");
		// BOB owns the enchantment; ALICE, the active player, does the casting.
		resolveBeanstalk(state, BOB);
		settlePriority(engine, state, passingAgents());

		const thor = spawnCard(state, "thor-odinson", ALICE, "hand");
		fillManaPool(state, ALICE);

		executeCastAction(
			engine,
			state,
			ALICE,
			{ kind: "cast", card: thor.id },
			passingAgents(),
		);
		expect(state.pendingTriggers).toHaveLength(0);
	});

	test("does not trigger from hand", () => {
		const state = setupMain(engine);
		spawnCard(state, "forest", ALICE, "library");
		spawnCard(state, "up-the-beanstalk", ALICE, "hand");

		const thor = spawnCard(state, "thor-odinson", ALICE, "hand");
		fillManaPool(state, ALICE);

		executeCastAction(
			engine,
			state,
			ALICE,
			{ kind: "cast", card: thor.id },
			passingAgents(),
		);
		expect(state.pendingTriggers).toHaveLength(0);
	});
});
