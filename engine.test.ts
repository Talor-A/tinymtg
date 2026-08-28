import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "./agents.ts";
import "./cards.ts";
import type { GameState, PlayerId, SyncAgent } from "./index.ts";
import {
	advance,
	gameOver,
	newGame,
	permanent,
	spawnCard,
	spawnPermanent,
	winner,
} from "./index.ts";

const ALICE = 0 as PlayerId;
const BOB = 1 as PlayerId;
type Agents = [SyncAgent, SyncAgent];

function advanceUntil(
	state: GameState,
	agents: Agents,
	done: (state: GameState) => boolean,
	maxAdvances = 100,
): void {
	for (let count = 0; count < maxAdvances; count++) {
		if (done(state)) return;
		advance(state, agents);
	}
	throw new Error(
		`engine did not reach the expected state after ${maxAdvances} advances`,
	);
}

function playOneTurn(state: GameState, agents: Agents): void {
	const completedTurns = state.turn;
	advanceUntil(
		state,
		agents,
		(next) => next.turn > completedTurns || gameOver(next),
	);
}

function passingAgents(): Agents {
	return [new ScriptedAgent(), new ScriptedAgent()];
}

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
		const tappedPermanent = spawnPermanent(
			state,
			"grizzly-bears",
			ALICE,
			"battlefield",
			{ tapped: true },
		);
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
		expect(state.turn).toBe(1);
		expect(gameOver(state)).toBe(false);
	});

	test("the declare-attackers action occurs only during its own step", () => {
		const { state, agents } = setupNormalTurn();

		playOneTurn(state, agents);

		// Attacker selection and combat damage are not implemented yet. This checks
		// that the scheduler dispatches the one turn-based action it does model.
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
		expect(state.turn).toBe(2);
		expect(gameOver(state)).toBe(false);
	});
});

describe("abilities encountered during normal progression", () => {
	function setupMantraTurn(acceptLifeGain: boolean): {
		state: GameState;
		agents: Agents;
	} {
		const state = newGame();
		spawnPermanent(state, "ajanis-mantra", ALICE, "battlefield");
		spawnCard(state, "forest", ALICE, "library");
		spawnCard(state, "forest", BOB, "library");
		return {
			state,
			agents: [new ScriptedAgent([], [acceptLifeGain]), new ScriptedAgent()],
		};
	}

	test("Ajani's Mantra offers its controller one life during upkeep", () => {
		const { state, agents } = setupMantraTurn(true);

		playOneTurn(state, agents);

		expect(state.players[ALICE].life).toBe(21);
		expect(state.pendingTriggers).toHaveLength(0);
		expect(state.stack).toHaveLength(0);
	});

	test("the controller may decline Ajani's Mantra's life gain", () => {
		const { state, agents } = setupMantraTurn(false);

		playOneTurn(state, agents);

		expect(state.players[ALICE].life).toBe(20);
		expect(state.pendingTriggers).toHaveLength(0);
		expect(state.stack).toHaveLength(0);
	});
});

describe("draw steps and game endings", () => {
	function setupDrawStep(cardId?: string): {
		state: GameState;
		agents: Agents;
	} {
		const state = newGame();
		if (cardId) spawnPermanent(state, cardId, ALICE, "battlefield");
		return { state, agents: passingAgents() };
	}

	test("Necropotence skips only its controller's normal draw", () => {
		const { state, agents } = setupDrawStep("necropotence");
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
	});

	test("Laboratory Maniac wins when its controller would draw from an empty library", () => {
		const { state, agents } = setupDrawStep("laboratory-maniac");

		advanceUntil(state, agents, gameOver);

		expect(state.players[ALICE].won).toBe(true);
		expect(state.players[ALICE].lost).toBe(false);
		expect(winner(state)).toBe(ALICE);
	});

	test("Platinum Angel lets the game continue after an empty-library draw", () => {
		const { state, agents } = setupDrawStep("platinum-angel");

		advanceUntil(state, agents, (next) => next.step === "main");

		expect(state.players[ALICE].lost).toBe(false);
		expect(state.players[ALICE].won).toBe(false);
		expect(gameOver(state)).toBe(false);
		expect(winner(state)).toBe(null);
	});
});
