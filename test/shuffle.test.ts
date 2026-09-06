import { describe, expect, test } from "bun:test";
import "../cards.ts";
import { type GameState, newGame, type PlayerId, spawnCard } from "../index.ts";
import {
	ALICE,
	advanceUntil,
	BOB,
	passingAgents,
} from "./utils/engine-helpers.ts";

/** A library of distinguishable cards, so a reordering is actually visible. */
const DECK = [
	"forest",
	"grizzly-bears",
	"eager-cadet",
	"walking-ballista",
	"darksteel-relic",
	"revitalize",
	"rest-in-peace",
	"root-maze",
	"necropotence",
	"clone",
] as const;

function seededGame(seed: number): GameState {
	const state = newGame(seed);
	for (const player of [ALICE, BOB]) {
		for (const cardId of DECK) spawnCard(state, cardId, player, "library");
	}
	return state;
}

/** The library as printed card ids, bottom to top. */
function libraryCardIds(state: GameState, player: PlayerId): string[] {
	return state.players[player].library.map((id) => {
		const object = state.objects.get(id);
		if (object?.kind !== "card") throw new Error("library holds a non-card");
		return object.cardId;
	});
}

/** Runs the pre-game, which is where CR 103.2's shuffle happens. */
function shuffled(seed: number): GameState {
	const state = seededGame(seed);
	advanceUntil(
		state,
		passingAgents(),
		(next) => next.turnScheduler.progress.kind === "inTurn",
	);
	return state;
}

describe("CR 103.2 shuffling", () => {
	test("the same seed produces the same library", () => {
		expect(libraryCardIds(shuffled(7), ALICE)).toEqual(
			libraryCardIds(shuffled(7), ALICE),
		);
	});

	test("different seeds produce different libraries", () => {
		// Two orderings of ten distinct cards collide with probability 1/10!,
		// so a failure here is a broken generator, not bad luck.
		expect(libraryCardIds(shuffled(7), ALICE)).not.toEqual(
			libraryCardIds(shuffled(8), ALICE),
		);
	});

	test("the two players are shuffled independently", () => {
		const state = shuffled(7);
		expect(libraryCardIds(state, ALICE)).not.toEqual(
			libraryCardIds(state, BOB),
		);
	});

	test("shuffling permutes the library without changing it", () => {
		const before = libraryCardIds(seededGame(7), ALICE);
		const after = libraryCardIds(shuffled(7), ALICE);

		expect(after).toHaveLength(before.length);
		expect([...after].sort()).toEqual([...before].sort());
		// The setup order is the sorted-in order; a shuffle that returned it
		// unchanged would pass the multiset check above on its own.
		expect(after).not.toEqual(before);
	});

	test("a seed of 0 is a live state, not a degenerate one", () => {
		// sfc32's counter word advances regardless of the seed, so unlike the
		// xorshift family there is no all-zero state to avoid.
		const zero = libraryCardIds(shuffled(0), ALICE);
		expect([...zero].sort()).toEqual([...DECK].sort());
		expect(zero).not.toEqual([...DECK]);
	});

	test("an empty or single-card library survives shuffling", () => {
		const state = newGame(7);
		spawnCard(state, "forest", ALICE, "library");
		advanceUntil(
			state,
			passingAgents(),
			(next) => next.turnScheduler.progress.kind === "inTurn",
		);

		expect(libraryCardIds(state, ALICE)).toEqual(["forest"]);
		expect(libraryCardIds(state, BOB)).toEqual([]);
	});
});
