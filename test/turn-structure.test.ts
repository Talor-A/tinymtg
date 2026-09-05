import { describe, expect, test } from "bun:test";
import "../cards.ts";
import type { GameState, PlayerId } from "../index.ts";
import {
	activePlayer,
	advance,
	gameOver,
	newGame,
	permanent,
	settlePriority,
	spawnCard,
	spawnPermanent,
	turnLocation,
	winner,
} from "../index.ts";
import {
	type SyncAgents as Agents,
	ALICE,
	advanceUntil,
	BOB,
	isAt,
	passingAgents,
	playOneTurn,
} from "./utils/engine-helpers.ts";

describe("turn progress", () => {
	test("notStarted is visible only before the first advance", () => {
		const state = newGame();
		const agents = passingAgents();
		for (let i = 0; i < 3; i++) {
			spawnCard(state, "forest", ALICE, "library");
			spawnCard(state, "forest", BOB, "library");
		}

		expect(state.turnScheduler.progress).toEqual({ kind: "notStarted" });

		// CR 103 runs before the first turn, one step per advance().
		for (const step of [
			"shuffle",
			"opening hand",
			"mulligan",
			"opening hand actions",
		] as const) {
			advance(state, agents);
			expect(state.turnScheduler.progress).toEqual({ kind: "pregame", step });
		}

		// Once a turn is installed the game never leaves inTurn.
		for (let i = 0; i < 30; i++) {
			advance(state, agents);
			expect(state.turnScheduler.progress.kind).toBe("inTurn");
		}
	});

	test("has no active player before the first turn begins", () => {
		const state = newGame();
		const agents = passingAgents();

		expect(activePlayer(state)).toBe(null);
		// Nothing in the rules is defined relative to "the active player" yet,
		// so asking for a priority window here is a bug, not player 0's turn.
		expect(() => settlePriority(state, agents)).toThrow(
			"no player receives priority outside a turn",
		);

		// The pre-game is not a turn, so it does not answer "whose turn is it"
		// either -- the whole of CR 103 passes with no active player.
		for (let i = 0; i < 4; i++) {
			advance(state, agents);
			expect(state.turnScheduler.progress.kind).toBe("pregame");
			expect(activePlayer(state)).toBe(null);
		}

		advance(state, agents);
		expect(activePlayer(state)).toBe(ALICE);
	});

	test("represents a main phase as a phase with its combat role", () => {
		const state = newGame();
		const agents = passingAgents();
		spawnCard(state, "forest", ALICE, "library");
		spawnCard(state, "forest", BOB, "library");

		advanceUntil(state, agents, (next) => isAt(next, "main"));

		expect(turnLocation(state)).toMatchObject({
			kind: "mainPhase",
			role: "precombat",
			phase: { kind: "main" },
		});
	});
});

describe("playing a normal turn", () => {
	function addCards(
		state: GameState,
		player: PlayerId,
		zone: "library" | "hand",
		amount: number,
	): void {
		for (let i = 0; i < amount; i++) {
			spawnCard(state, "forest", player, zone);
		}
	}

	function setupNormalTurn(): {
		state: GameState;
		agents: Agents;
		tappedPermanent: ReturnType<typeof spawnPermanent>;
	} {
		const state = newGame();
		const tappedPermanent = spawnPermanent(state, "grizzly-bears", ALICE, {
			tapped: true,
		});
		addCards(state, ALICE, "hand", 8);
		addCards(state, ALICE, "library", 1);
		addCards(state, BOB, "library", 2);
		return { state, agents: passingAgents(), tappedPermanent };
	}

	test("the active player untaps, draws, discards to seven, and finishes the turn", () => {
		const { state, agents, tappedPermanent } = setupNormalTurn();

		playOneTurn(state, agents);

		expect(permanent(state, tappedPermanent.id).tapped).toBe(false);
		expect(state.players[ALICE].library).toHaveLength(0);
		expect(state.players[ALICE].hand).toHaveLength(7);
		expect(state.players[ALICE].graveyard).toHaveLength(2);
		expect(state.completedTurns).toBe(1);
		expect(gameOver(state)).toBe(false);
	});

	test("the declare-attackers action occurs only during its own step", () => {
		const { state, agents } = setupNormalTurn();

		playOneTurn(state, agents);

		// This setup declares no attacker, so combat damage never fires. This
		// checks that the scheduler dispatches the declare-attackers action
		// exactly once regardless.
		const declarations = state.log.filter((line) =>
			line.startsWith("> declareAttackers("),
		);
		expect(declarations).toHaveLength(1);
	});

	test("players take alternating turns and each draws a card", () => {
		const state = newGame();
		const agents = passingAgents();
		addCards(state, ALICE, "library", 2);
		addCards(state, BOB, "library", 2);

		playOneTurn(state, agents);
		playOneTurn(state, agents);

		expect(state.players[ALICE].hand).toHaveLength(1);
		expect(state.players[BOB].hand).toHaveLength(1);
		expect(state.completedTurns).toBe(2);
		expect(gameOver(state)).toBe(false);
	});

	test("hands the active player role to each player in turn", () => {
		const state = newGame();
		const agents = passingAgents();
		addCards(state, ALICE, "library", 2);
		addCards(state, BOB, "library", 2);

		playOneTurn(state, agents);
		expect(activePlayer(state)).toBe(BOB);

		playOneTurn(state, agents);
		expect(activePlayer(state)).toBe(ALICE);
	});
});

describe("draw steps and game endings", () => {
	function setupDrawStep(): {
		state: GameState;
		agents: Agents;
	} {
		const state = newGame();
		return { state, agents: passingAgents() };
	}

	test("Necropotence skips only its controller's normal draw", () => {
		const { state, agents } = setupDrawStep();
		spawnPermanent(state, "necropotence", ALICE);
		for (let i = 0; i < 2; i++) {
			spawnCard(state, "forest", ALICE, "library");
			spawnCard(state, "forest", BOB, "library");
		}

		playOneTurn(state, agents);
		expect(state.players[ALICE].hand).toHaveLength(0);
		expect(state.players[ALICE].library).toHaveLength(2);

		playOneTurn(state, agents);
		expect(state.players[BOB].hand).toHaveLength(1);
		expect(state.players[BOB].library).toHaveLength(1);
	});

	test("a player loses after failing to draw from an empty library", () => {
		const { state, agents } = setupDrawStep();

		advanceUntil(state, agents, gameOver);

		expect(state.players[ALICE].lost).toBe(true);
		expect(winner(state)).toBe(BOB);
		expect(state.completedTurns).toBe(0);
		expect(isAt(state, "draw")).toBe(true);
	});

	test("Laboratory Maniac wins when its controller would draw from an empty library", () => {
		const { state, agents } = setupDrawStep();
		spawnPermanent(state, "laboratory-maniac", ALICE);

		advanceUntil(state, agents, gameOver);

		expect(state.players[ALICE].won).toBe(true);
		expect(state.players[ALICE].lost).toBe(false);
		expect(winner(state)).toBe(ALICE);

		expect(state.completedTurns).toBe(0);
		expect(isAt(state, "draw")).toBe(true);
	});

	test("Platinum Angel lets the game continue after an empty-library draw", () => {
		const { state, agents } = setupDrawStep();
		spawnPermanent(state, "platinum-angel", ALICE);

		advanceUntil(state, agents, (next) => isAt(next, "main"));

		expect(state.players[ALICE].lost).toBe(false);
		expect(state.players[ALICE].won).toBe(false);
		expect(gameOver(state)).toBe(false);
		expect(winner(state)).toBe(null);

		advanceUntil(state, agents, gameOver);
		expect(state.completedTurns).toBe(1);
		expect(isAt(state, "draw")).toBe(true);
	});
});
