import { describe, expect, test } from "bun:test";
import { CARDS } from "../cards.ts";
import { importForgeCard } from "../forge/import.ts";
import {
	activePlayer,
	createEngine,
	type GameState,
	isTurnStep,
	type PlayerId,
} from "../index.ts";
import {
	ALICE,
	advanceUntil,
	atMain,
	BOB,
	passingAgents,
	playOneTurn,
	seedLibraries,
} from "./utils/engine-helpers.ts";

/**
 * Synthetic: an enchantment with Xyris's trigger shape — every opponent draw
 * except the first card of their own draw step draws you a card. Not a
 * stand-in for any real card's full rules; Xyris's damage trigger is not
 * importable yet, so this fixture exercises the qualifier on its own.
 */
const DRAW_STEP_WATCHER = (() => {
	const text = `Name:Test Draw Step Watcher
ManaCost:1 U
Types:Enchantment
T:Mode$ Drawn | ValidCard$ Card.OppOwn | FirstCardInDrawStep$ False | TriggerZones$ Battlefield | Execute$ TrigDraw | TriggerDescription$ Whenever an opponent draws a card except the first one they draw in each of their draw steps, draw a card.
SVar:TrigDraw:DB$ Draw | Defined$ You | NumCards$ 1
Oracle:
`;
	const result = importForgeCard(text, { id: "test-draw-step-watcher" });
	if (!result.ok)
		throw new Error("expected synthetic draw-step watcher to import");
	return result.card;
})();

const engine = createEngine([...CARDS, DRAW_STEP_WATCHER]);

const WATCHER = "test-draw-step-watcher";

/** A fresh game with the watcher on ALICE's battlefield and deep libraries. */
function watcherGame(): GameState {
	const state = engine.newGame();
	seedLibraries(engine, state, 6);
	engine.spawnPermanent(state, WATCHER, ALICE);
	return state;
}

/**
 * Advances to BOB's draw step. The turn-based draw happens while the step is
 * installed, so the returned game has already drawn BOB's first draw-step
 * card — exactly the draw the qualifier must not fire on.
 */
function atBobsDrawStep(state: GameState): void {
	advanceUntil(
		engine,
		state,
		passingAgents(),
		(next) => isTurnStep(next, "draw") && activePlayer(next) === BOB,
	);
}

describe("the except-first-in-draw-step qualifier", () => {
	test("the first draw-step card does not trigger, the second one does", () => {
		const state = watcherGame();
		const agents = passingAgents();
		atBobsDrawStep(state);

		expect(
			state.pendingTriggers,
			"BOB's first draw-step card does not trigger",
		).toHaveLength(0);

		engine.perform(state, { kind: "draw", player: BOB }, agents);
		expect(
			state.pendingTriggers,
			"BOB's second draw-step card triggers",
		).toHaveLength(1);
	});

	test("a draw outside the drawer's own draw step triggers despite the stale count", () => {
		const state = watcherGame();
		const agents = passingAgents();
		atBobsDrawStep(state);
		// BOB's draw step left drawnInDrawStep at 1. An extra draw on ALICE's
		// turn must not be compared against that stale count.
		playOneTurn(engine, state, agents);
		advanceUntil(engine, state, agents, (next) => atMain(next, "precombat"));

		expect(activePlayer(state)).toBe(ALICE as PlayerId);
		engine.perform(state, { kind: "draw", player: BOB }, agents);
		expect(
			state.pendingTriggers,
			"BOB drawing on ALICE's turn triggers",
		).toHaveLength(1);
	});

	test("the watcher's own controller's draws never trigger", () => {
		const state = watcherGame();
		const agents = passingAgents();
		// ALICE's own turn: the draw step card, then an extra draw.
		advanceUntil(
			engine,
			state,
			agents,
			(next) => isTurnStep(next, "draw") && activePlayer(next) === ALICE,
		);
		engine.perform(state, { kind: "draw", player: ALICE }, agents);

		expect(state.pendingTriggers).toHaveLength(0);
	});
});
