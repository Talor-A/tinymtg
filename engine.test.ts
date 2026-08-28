import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ScriptedAgent } from "./agents.ts";
import "./cards.ts";
import type { GameState, PlayerId, SyncAgent } from "./index.ts";
import {
	advance,
	gameOver,
	newGame,
	permanent,
	registerCard,
	spawnCard,
	spawnPermanent,
	winner,
} from "./index.ts";
import { parseCard } from "./parser.ts";

// Registered here (not in cards.ts) so normal runtime card registration never
// depends on reading the untracked/gitignored Forge cardsfolder fixtures. This
// test alone consumes the real parsed CardDef, exercising the parser's
// "Attacks" self-trigger support end-to-end rather than a hand-written stand-in.
function loadHeraldOfFaith() {
	const text = readFileSync(
		"./cards/cardsfolder/h/herald_of_faith.txt",
		"utf-8",
	);
	const card = parseCard(text);
	if (!card) {
		throw new Error("Failed to parse herald_of_faith.txt fixture");
	}
	return card;
}
registerCard(loadHeraldOfFaith());

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

describe("declaring attackers during normal progression", () => {
	function setupAttackTurn(cardId: string): {
		state: GameState;
		attacker: ReturnType<typeof spawnPermanent>;
	} {
		const state = newGame();
		const attacker = spawnPermanent(state, cardId, ALICE, "battlefield");
		spawnCard(state, "forest", ALICE, "library");
		spawnCard(state, "forest", BOB, "library");
		return { state, attacker };
	}

	test("a creature can attack on the same turn it enters (all creatures are treated as having haste)", () => {
		// Spawning the creature before combat begins (rather than before the turn
		// starts, as setupAttackTurn does) is what actually proves the title: the
		// creature only exists once the game has naturally reached precombat main.
		const state = newGame();
		const attackerAgent = new ScriptedAgent();
		const agents: Agents = [attackerAgent, new ScriptedAgent()];
		spawnCard(state, "forest", ALICE, "library");
		spawnCard(state, "forest", BOB, "library");

		advanceUntil(state, agents, (next) => next.step === "main");

		const attacker = spawnPermanent(
			state,
			"grizzly-bears",
			ALICE,
			"battlefield",
		);
		// The attacker choice can only be scripted once the creature's id is known,
		// which is only after it has been spawned into the already-reached main phase.
		attackerAgent.attackerChoices.push([attacker.id]);

		// The attacker choice is requested and committed inside the single advance()
		// call that begins the declare-attackers step, so by the time state.step
		// reflects it, the declaration has already happened.
		advanceUntil(state, agents, (next) => next.step === "declare attackers");
		expect(
			permanent(state, attacker.id).attacking,
			"declared as an attacker",
		).toBe(true);
		expect(permanent(state, attacker.id).tapped, "tapped by attacking").toBe(
			true,
		);

		playOneTurn(state, agents);
		expect(gameOver(state)).toBe(false);
	});

	test("attacking clears at end combat but tapped persists until the next untap", () => {
		const { state, attacker } = setupAttackTurn("grizzly-bears");
		const agents: Agents = [
			new ScriptedAgent([], [], [], [[attacker.id]]),
			new ScriptedAgent(),
		];

		advanceUntil(state, agents, (next) => next.step === "end combat");
		expect(
			permanent(state, attacker.id).attacking,
			"end combat clears attacking",
		).toBe(false);
		expect(
			permanent(state, attacker.id).tapped,
			"tapped is untouched by end combat",
		).toBe(true);
	});

	test("a creature not selected to attack stays untapped and unattacking", () => {
		const { state, attacker } = setupAttackTurn("grizzly-bears");
		const agents: Agents = [
			new ScriptedAgent([], [], [], [[]]),
			new ScriptedAgent(),
		];

		playOneTurn(state, agents);

		expect(permanent(state, attacker.id).attacking).toBe(false);
		expect(permanent(state, attacker.id).tapped).toBe(false);
	});

	test("the attacker-selection request happens only during the declare-attackers step", () => {
		const { state, attacker } = setupAttackTurn("grizzly-bears");
		const agents: Agents = [
			new ScriptedAgent([], [], [], [[attacker.id]]),
			new ScriptedAgent(),
		];

		playOneTurn(state, agents);

		const declarations = state.log.filter((line) =>
			line.startsWith("> declareAttackers("),
		);
		expect(declarations).toHaveLength(1);
		expect(declarations[0]).toContain("Grizzly Bears");
	});

	test("a parsed Herald of Faith attacks, taps, and its trigger gains exactly 2 life via priority", () => {
		const { state, attacker: herald } = setupAttackTurn("herald-of-faith");
		const agents: Agents = [
			new ScriptedAgent([], [], [], [[herald.id]]),
			new ScriptedAgent(),
		];

		playOneTurn(state, agents);

		expect(state.players[ALICE].life, "gained exactly 2 life").toBe(22);
		expect(permanent(state, herald.id).tapped, "attacked, so tapped").toBe(
			true,
		);
		expect(
			permanent(state, herald.id).attacking,
			"attacking cleared by end combat",
		).toBe(false);
		expect(state.pendingTriggers).toHaveLength(0);
		expect(state.stack).toHaveLength(0);
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
	function setupDrawStep(): {
		state: GameState;
		agents: Agents;
	} {
		const state = newGame();
		return { state, agents: passingAgents() };
	}

	test("Necropotence skips only its controller's normal draw", () => {
		const { state, agents } = setupDrawStep();
		spawnPermanent(state, "necropotence", ALICE, "battlefield");
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
		expect(state.turn).toBe(0);
		expect(state.step).toBe("draw");
	});

	test("Laboratory Maniac wins when its controller would draw from an empty library", () => {
		const { state, agents } = setupDrawStep();
		spawnPermanent(state, "laboratory-maniac", ALICE, "battlefield");

		advanceUntil(state, agents, gameOver);

		expect(state.players[ALICE].won).toBe(true);
		expect(state.players[ALICE].lost).toBe(false);
		expect(winner(state)).toBe(ALICE);

		expect(state.turn).toBe(0);
		expect(state.step).toBe("draw");
	});

	test("Platinum Angel lets the game continue after an empty-library draw", () => {
		const { state, agents } = setupDrawStep();
		spawnPermanent(state, "platinum-angel", ALICE, "battlefield");

		advanceUntil(state, agents, (next) => next.step === "main");

		expect(state.players[ALICE].lost).toBe(false);
		expect(state.players[ALICE].won).toBe(false);
		expect(gameOver(state)).toBe(false);
		expect(winner(state)).toBe(null);

		advanceUntil(state, agents, gameOver);
		expect(state.turn).toBe(1);
		expect(state.step).toBe("draw");
	});
});
