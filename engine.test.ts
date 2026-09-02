import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ScriptedAgent } from "./agents.ts";
import "./cards.ts";
import type { GameState, ObjectId, PlayerId, StepKind } from "./index.ts";
import {
	advance,
	gameOver,
	newGame,
	perform,
	permanent,
	registerCard,
	spawnCard,
	spawnPermanent,
	turnLocation,
	winner,
} from "./index.ts";
import { parseCard } from "./parser.ts";
import {
	advanceUntil,
	ALICE,
	BOB,
	passingAgents,
	type SyncAgents as Agents,
} from "./test/engine-helpers.ts";

// TODO: this adds a dependency on card parser,
// remove it
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

function isAt(state: GameState, expected: StepKind | "main"): boolean {
	const location = turnLocation(state);
	return expected === "main"
		? location?.kind === "mainPhase"
		: location?.kind === "step" && location.step.kind === expected;
}

function playOneTurn(state: GameState, agents: Agents): void {
	const completedTurns = state.turn;
	advanceUntil(
		state,
		agents,
		(next) => next.turn > completedTurns || gameOver(next),
	);
}

/** One attacker-eligible creature plus enough library to survive a full turn. */
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

/** Scripts ALICE to declare exactly `ids` as attackers; BOB always passes. */
function attackWith(ids: ObjectId[]): Agents {
	return [new ScriptedAgent([], [], [], [ids]), new ScriptedAgent()];
}

describe("turn progress", () => {
	test("notStarted is visible only before the first advance", () => {
		const state = newGame();
		const agents = passingAgents();
		for (let i = 0; i < 3; i++) {
			spawnCard(state, "forest", ALICE, "library");
			spawnCard(state, "forest", BOB, "library");
		}

		expect(state.turnScheduler.progress).toEqual({ kind: "notStarted" });

		for (let i = 0; i < 30; i++) {
			advance(state, agents);
			expect(state.turnScheduler.progress.kind).toBe("inTurn");
		}
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
		expect(state.turn).toBe(2);
		expect(gameOver(state)).toBe(false);
	});
});

describe("declaring attackers during normal progression", () => {
	test("a creature can attack on the same turn it enters (all creatures are treated as having haste)", () => {
		// Spawning the creature before combat begins (rather than before the turn
		// starts, as setupAttackTurn does) is what actually proves the title: the
		// creature only exists once the game has naturally reached precombat main.
		const state = newGame();
		const attackerAgent = new ScriptedAgent();
		const agents: Agents = [attackerAgent, new ScriptedAgent()];
		spawnCard(state, "forest", ALICE, "library");
		spawnCard(state, "forest", BOB, "library");

		advanceUntil(state, agents, (next) => isAt(next, "main"));

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
		// call that begins the declare-attackers step, so by the time the scheduler
		// records it, the declaration has already happened.
		advanceUntil(state, agents, (next) => isAt(next, "declare attackers"));
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

		advanceUntil(state, agents, (next) => isAt(next, "end combat"));
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
		expect(
			state.players[BOB].life,
			"took 4 combat damage from the 4/3 Herald",
		).toBe(16);
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

describe("dealing combat damage", () => {
	test("a Grizzly Bears deals its power to the opponent at combat damage, not at declaration", () => {
		const { state, attacker } = setupAttackTurn("grizzly-bears");
		const agents = attackWith([attacker.id]);

		advanceUntil(state, agents, (next) => isAt(next, "declare attackers"));
		expect(state.players[BOB].life, "no damage dealt merely by declaring").toBe(
			20,
		);

		advanceUntil(state, agents, (next) => isAt(next, "combat damage"));
		expect(
			state.players[BOB].life,
			"Grizzly Bears' 2 power hit the opponent",
		).toBe(18);
	});

	test("multiple selected attackers deal the sum of their current powers while an unselected creature deals none", () => {
		const state = newGame();
		const bears = spawnPermanent(state, "grizzly-bears", ALICE, "battlefield");
		const attackingCadet = spawnPermanent(
			state,
			"eager-cadet",
			ALICE,
			"battlefield",
		);
		const benchedCadet = spawnPermanent(
			state,
			"eager-cadet",
			ALICE,
			"battlefield",
		);
		spawnCard(state, "forest", ALICE, "library");
		spawnCard(state, "forest", BOB, "library");
		const agents = attackWith([bears.id, attackingCadet.id]);

		playOneTurn(state, agents);

		// 2 (Bears) + 1 (attacking Cadet) = 3; the benched Cadet contributes 0.
		expect(state.players[BOB].life).toBe(17);
		expect(permanent(state, benchedCadet.id).attacking).toBe(false);
	});

	test("current modified power is used: a +1/+1 counter makes Bears deal 3", () => {
		const state = newGame();
		const bears = spawnPermanent(state, "grizzly-bears", ALICE, "battlefield", {
			counters: { "+1/+1": 1 },
		});
		spawnCard(state, "forest", ALICE, "library");
		spawnCard(state, "forest", BOB, "library");
		const agents = attackWith([bears.id]);

		playOneTurn(state, agents);

		expect(state.players[BOB].life, "3/3 Bears dealt 3").toBe(17);
	});

	test("Rhox War Monk's lifelink makes its controller gain life while the opponent loses it", () => {
		const { state, attacker } = setupAttackTurn("rhox-war-monk");
		const agents = attackWith([attacker.id]);

		playOneTurn(state, agents);

		expect(state.players[ALICE].life, "gained 3 life via lifelink").toBe(23);
		expect(state.players[BOB].life, "lost 3 life to the same hit").toBe(17);
	});

	test("Furnace of Rath doubles combat damage through the normal replacement pipeline", () => {
		const { state, attacker } = setupAttackTurn("grizzly-bears");
		spawnPermanent(state, "furnace-of-rath", ALICE, "battlefield");
		const agents = attackWith([attacker.id]);

		playOneTurn(state, agents);

		expect(
			state.players[BOB].life,
			"2 power doubled to 4 by Furnace of Rath",
		).toBe(16);
	});

	test("destroying an attacker after declaration but before combat damage means it deals none", () => {
		const { state, attacker } = setupAttackTurn("grizzly-bears");
		const agents = attackWith([attacker.id]);

		advanceUntil(state, agents, (next) => isAt(next, "declare attackers"));
		expect(permanent(state, attacker.id).attacking).toBe(true);
		perform(
			state,
			{ kind: "destroy", object: attacker.id, noRegen: true },
			agents,
		);

		advanceUntil(state, agents, (next) => isAt(next, "combat damage"));
		expect(state.players[BOB].life, "the destroyed attacker dealt none").toBe(
			20,
		);
	});

	test("regenerating an attacker after declaration but before combat damage means it deals none", () => {
		const { state, attacker } = setupAttackTurn("grizzly-bears");
		const agents = attackWith([attacker.id]);

		advanceUntil(state, agents, (next) => isAt(next, "declare attackers"));
		perform(state, { kind: "regenerate", object: attacker.id }, agents);
		expect(
			permanent(state, attacker.id).attacking,
			"regeneration clears attacking",
		).toBe(false);

		advanceUntil(state, agents, (next) => isAt(next, "combat damage"));
		expect(state.players[BOB].life, "the regenerated creature dealt none").toBe(
			20,
		);
	});

	test("combat damage can cause the defending player to lose via normal state-based actions", () => {
		const { state, attacker } = setupAttackTurn("grizzly-bears");
		state.players[BOB].life = 1;
		const agents = attackWith([attacker.id]);

		advanceUntil(state, agents, gameOver);

		expect(state.players[BOB].lost, "BOB died to combat damage").toBe(true);
		expect(winner(state)).toBe(ALICE);
		expect(state.players[BOB].life).toBe(-1);
	});

	test("attacking remains true through the damage step and clears only at end combat", () => {
		const { state, attacker } = setupAttackTurn("grizzly-bears");
		const agents = attackWith([attacker.id]);

		advanceUntil(state, agents, (next) => isAt(next, "combat damage"));
		expect(
			permanent(state, attacker.id).attacking,
			"still attacking during the damage step",
		).toBe(true);

		advanceUntil(state, agents, (next) => isAt(next, "end combat"));
		expect(
			permanent(state, attacker.id).attacking,
			"end combat clears attacking",
		).toBe(false);
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
		expect(isAt(state, "draw")).toBe(true);
	});

	test("Laboratory Maniac wins when its controller would draw from an empty library", () => {
		const { state, agents } = setupDrawStep();
		spawnPermanent(state, "laboratory-maniac", ALICE, "battlefield");

		advanceUntil(state, agents, gameOver);

		expect(state.players[ALICE].won).toBe(true);
		expect(state.players[ALICE].lost).toBe(false);
		expect(winner(state)).toBe(ALICE);

		expect(state.turn).toBe(0);
		expect(isAt(state, "draw")).toBe(true);
	});

	test("Platinum Angel lets the game continue after an empty-library draw", () => {
		const { state, agents } = setupDrawStep();
		spawnPermanent(state, "platinum-angel", ALICE, "battlefield");

		advanceUntil(state, agents, (next) => isAt(next, "main"));

		expect(state.players[ALICE].lost).toBe(false);
		expect(state.players[ALICE].won).toBe(false);
		expect(gameOver(state)).toBe(false);
		expect(winner(state)).toBe(null);

		advanceUntil(state, agents, gameOver);
		expect(state.turn).toBe(1);
		expect(isAt(state, "draw")).toBe(true);
	});
});
