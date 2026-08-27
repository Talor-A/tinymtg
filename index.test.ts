import { describe, expect, test } from "bun:test";
import { RandomAgent, ScriptedAgent } from "./agents.ts";
import "./cards.ts"; // side effect: registers the card database
import type { Agent, GameState, ObjectId, PlayerId } from "./index.ts";
import {
	addFloating,
	advance,
	checkStateBasedActions,
	gameOver,
	newGame,
	perform,
	permanent,
	settlePriority,
	spawnCard,
	spawnPermanent,
	view,
	winner,
} from "./index.ts";

const P1 = 0 as PlayerId;
const P2 = 1 as PlayerId;

function dump(state: GameState): void {
	if (!process.env.VERBOSE) return;
	if (state.log.length === 0) return;
	console.log(state.log.map((l) => `    ${l}`).join("\n"));
	state.log.length = 0;
}

function created(result: { created: ObjectId[] }): ObjectId {
	if (result.created.length === 0) throw new Error("nothing created");
	return result.created[0]!;
}

function advanceToNextTurn(state: GameState, agents: [Agent, Agent]): void {
	const currentTurn = state.turn;
	while (state.turn === currentTurn && !gameOver(state)) {
		advance(state, agents);
	}
}

function ballista(prefs: string[]): {
	counters: number;
	state: GameState;
	entered: ObjectId;
} {
	const state = newGame();
	const agents: [Agent, Agent] = [
		new ScriptedAgent(prefs),
		new ScriptedAgent(),
	];
	spawnPermanent(state, "hardened-scales", P1, "battlefield");
	spawnPermanent(state, "doubling-season", P1, "battlefield");
	const ballistaCard = spawnCard(state, "walking-ballista", P1, "hand");
	const result = perform(
		state,
		{
			kind: "zoneChange",
			object: ballistaCard.id,
			from: "hand",
			to: "battlefield",
			cause: "resolve",
			toController: P1,
		},
		agents,
	);
	return {
		counters: permanent(state, created(result)).counters["+1/+1"] ?? 0,
		state,
		entered: created(result),
	};
}

function damageRace(p1Prefs: string[]): GameState {
	const state = newGame();
	const agents: [Agent, Agent] = [
		new ScriptedAgent(),
		new ScriptedAgent(p1Prefs),
	];
	spawnPermanent(state, "furnace-of-rath", P1, "battlefield");
	const pyro = spawnPermanent(state, "eager-cadet", P1, "battlefield");
	addFloating(
		state,
		P2,
		"preventNextDamage",
		{ targetType: "player", targetPlayer: P2, amount: 3 },
		{
			data: { remaining: 3 },
		},
	);
	perform(
		state,
		{
			kind: "damage",
			source: pyro.id,
			sourceController: P1,
			sourceColors: ["r"],
			target: { type: "player", player: P2 },
			amount: 2,
			combat: false,
			deathtouch: false,
			lifelink: false,
			unpreventable: false,
		},
		agents,
	);
	return state;
}

describe("self-replacement first, then the player's ordering choice", () => {
	test("Walking Ballista + Hardened Scales + Doubling Season (CR 616.1a, then 616.1e)", () => {
		const scalesFirst = ballista(["hardened scales"]);
		dump(scalesFirst.state);
		// "enters with 2" is self-replacement and always applies first: 2 -> +1 -> x2
		expect(scalesFirst.counters, "Scales then Season").toBe(6);

		const seasonFirst = ballista(["doubling season"]);
		seasonFirst.state.log.length = 0;
		expect(seasonFirst.counters, "Season then Scales").toBe(5);
		expect(
			view(scalesFirst.state, scalesFirst.entered).power,
			"Ballista power with 6 counters",
		).toBe(6);
	});
});

describe("two graveyard replacements, and the choice belongs to the victim", () => {
	function kalitasVsRip(p1Prefs: string[]): GameState {
		const state = newGame();
		const agents: [Agent, Agent] = [
			new ScriptedAgent(),
			new ScriptedAgent(p1Prefs),
		];
		spawnPermanent(state, "kalitas", P1, "battlefield");
		spawnPermanent(state, "rest-in-peace", P2, "battlefield");
		const bears = spawnPermanent(state, "grizzly-bears", P2, "battlefield");
		perform(
			state,
			{ kind: "destroy", object: bears.id, noRegen: false },
			agents,
		);
		return state;
	}
	test("Kalitas vs Rest in Peace — the dying creature's controller chooses (CR 616.1)", () => {
		const ripFirst = kalitasVsRip(["rest in peace"]);
		dump(ripFirst);
		expect(
			ripFirst.battlefield.filter(
				(id) => permanent(ripFirst, id).cardId === "zombie-token",
			).length,
			"P1 picks RiP: no Zombie for P0",
		).toBe(0);
		expect(ripFirst.players[P2].exile.length, "bears exiled").toBe(1);

		const kalitasFirst = kalitasVsRip(["kalitas"]);
		kalitasFirst.log.length = 0;
		expect(
			kalitasFirst.battlefield.filter(
				(id) => permanent(kalitasFirst, id).cardId === "zombie-token",
			).length,
			"P1 picks Kalitas: P0 gets a Zombie",
		).toBe(1);
	});
});

describe("Chains of Mephistopheles", () => {
	test("draw -> discard -> draw, exactly once (CR 614.5)", () => {
		const state = newGame();
		const agents: [Agent, Agent] = [new ScriptedAgent(), new ScriptedAgent()];
		spawnPermanent(state, "chains-of-mephistopheles", P1, "battlefield");
		spawnCard(state, "forest", P1, "library");
		spawnCard(state, "forest", P1, "library");
		spawnCard(state, "grizzly-bears", P1, "hand");
		state.step = "main";

		perform(state, { kind: "draw", player: P1 }, agents);
		dump(state);

		expect(
			state.players[P1].hand.length,
			"hand still 1 (discarded one, drew one)",
		).toBe(1);
		expect(
			state.players[P1].graveyard.length,
			"graveyard has the discarded card",
		).toBe(1);
		expect(state.players[P1].library.length, "library down by one").toBe(1);
	});

	test("with an empty hand: the guarded draw never happens", () => {
		const state = newGame();
		const agents: [Agent, Agent] = [new ScriptedAgent(), new ScriptedAgent()];
		spawnPermanent(state, "chains-of-mephistopheles", P1, "battlefield");
		spawnCard(state, "forest", P1, "library");
		state.step = "main";

		perform(state, { kind: "draw", player: P1 }, agents);
		dump(state);
		expect(state.players[P1].hand.length, "no cards drawn").toBe(0);
		expect(state.players[P1].library.length, "library untouched").toBe(1);
	});
});

describe("damage: prevention vs doubling", () => {
	test("Furnace of Rath vs a prevention shield — the damaged player chooses", () => {
		const preventFirst = damageRace(["prevent"]);
		dump(preventFirst);
		// Preventing 2 of 2 replaces the damage with nothing, so Furnace never applies.
		expect(preventFirst.players[1].life, "shield first: P1 takes 0").toBe(20);

		const furnaceFirst = damageRace(["furnace"]);
		furnaceFirst.log.length = 0;
		// 2 -> 4, shield eats 3, 1 gets through.
		expect(furnaceFirst.players[1].life, "furnace first: P1 takes 1").toBe(19);
	});

	test('"Can\'t be prevented" locks out prevention but not doubling (CR 615.12)', () => {
		const state = newGame();
		const agents: [Agent, Agent] = [
			new ScriptedAgent(),
			new ScriptedAgent(["prevent"]),
		];
		spawnPermanent(state, "furnace-of-rath", P1, "battlefield");
		const pyro = spawnPermanent(state, "eager-cadet", 0, "battlefield");
		addFloating(
			state,
			P2,
			"preventNextDamage",
			{ targetType: "player", targetPlayer: P2, amount: 3 },
			{
				data: { remaining: 3 },
			},
		);
		perform(
			state,
			{
				kind: "damage",
				source: pyro.id,
				sourceController: P1,
				sourceColors: ["r"],
				target: { type: "player", player: P2 },
				amount: 2,
				combat: false,
				deathtouch: false,
				lifelink: false,
				unpreventable: true,
			},
			agents,
		);
		dump(state);
		expect(state.players[1].life, "P1 takes the doubled 4").toBe(16);
	});

	test("Palisade Giant redirects, then Prismatic Strands prevents (chained replacements)", () => {
		const state = newGame();
		const agents: [Agent, Agent] = [new ScriptedAgent(), new ScriptedAgent()];
		const giant = spawnPermanent(state, "palisade-giant", 1, "battlefield");
		const pyro = spawnPermanent(state, "eager-cadet", 0, "battlefield");
		perform(
			state,
			{
				kind: "damage",
				source: pyro.id,
				sourceController: P1,
				sourceColors: ["r"],
				target: { type: "player", player: P2 },
				amount: 3,
				combat: false,
				deathtouch: false,
				lifelink: false,
				unpreventable: false,
			},
			agents,
		);
		expect(permanent(state, giant.id).damage, "damage went to the Giant").toBe(
			3,
		);
		expect(state.players[1].life, "P1 life untouched").toBe(20);

		addFloating(state, 1, "prismaticStrands", { color: "r" });
		perform(
			state,
			{
				kind: "damage",
				source: pyro.id,
				sourceController: P1,
				sourceColors: ["r"],
				target: { type: "player", player: P2 },
				amount: 3,
				combat: false,
				deathtouch: false,
				lifelink: false,
				unpreventable: false,
			},
			agents,
		);
		dump(state);
		expect(
			permanent(state, giant.id).damage,
			"second hit fully prevented",
		).toBe(3);
	});
});

describe("regeneration", () => {
	test("Regeneration shield: saves from lethal damage, not from toughness 0 (CR 704.5f/g)", () => {
		const state = newGame();
		const agents: [Agent, Agent] = [new ScriptedAgent(), new ScriptedAgent()];
		const bears = spawnPermanent(state, "grizzly-bears", 0, "battlefield");
		const pyro = spawnPermanent(state, "eager-cadet", 1, "battlefield");
		addFloating(
			state,
			0,
			"regenerationShield",
			{ target: bears.id },
			{ data: { used: 0 } },
		);

		perform(
			state,
			{
				kind: "damage",
				source: pyro.id,
				sourceController: P2,
				sourceColors: ["r"],
				target: { type: "permanent", id: bears.id },
				amount: 2,
				combat: false,
				deathtouch: false,
				lifelink: false,
				unpreventable: false,
			},
			agents,
		);
		checkStateBasedActions(state, agents);
		dump(state);
		expect(state.battlefield.includes(bears.id), "bears survived").toBe(true);
		expect(
			permanent(state, bears.id).tapped,
			"bears tapped by regeneration",
		).toBe(true);
		expect(permanent(state, bears.id).damage, "damage removed").toBe(0);

		// Shrink it to 0 toughness: no destroy event, so no shield to hook.
		perform(
			state,
			{
				kind: "addCounters",
				target: { type: "permanent", id: bears.id },
				counter: "-1/-1",
				amount: 2,
			},
			agents,
		);
		checkStateBasedActions(state, agents);
		dump(state);
		expect(state.battlefield.includes(bears.id), "bears died to SBA").toBe(
			false,
		);
	});
});

describe("CR 614.12 — ETB replacements see the would-be characteristics", () => {
	test("Root Maze + Mycosynth Lattice: a Bear enters tapped because it would be an artifact", () => {
		const state = newGame();
		const agents: [Agent, Agent] = [new ScriptedAgent(), new ScriptedAgent()];
		spawnPermanent(state, "root-maze", 0, "battlefield");
		const bearsCard = spawnCard(state, "grizzly-bears", 0, "hand");
		const r1 = perform(
			state,
			{
				kind: "zoneChange",
				object: bearsCard.id,
				from: "hand",
				to: "battlefield",
				cause: "resolve",
				toController: P1,
			},
			agents,
		);
		expect(
			permanent(state, created(r1)).tapped,
			"no Lattice: bear enters untapped",
		).toBe(false);

		spawnPermanent(state, "mycosynth-lattice", 0, "battlefield");
		const bears2 = spawnCard(state, "grizzly-bears", 0, "hand");
		const r2 = perform(
			state,
			{
				kind: "zoneChange",
				object: bears2.id,
				from: "hand",
				to: "battlefield",
				cause: "resolve",
				toController: P1,
			},
			agents,
		);
		dump(state);
		expect(
			permanent(state, created(r2)).tapped,
			"with Lattice: bear enters tapped",
		).toBe(true);
	});
});

describe('"Skip your draw step" is a replacement that returns nothing', () => {
	test("Necropotence skips the draw step", () => {
		const state = newGame();
		const agents: [Agent, Agent] = [new ScriptedAgent(), new ScriptedAgent()];
		spawnPermanent(state, "necropotence", 0, "battlefield");
		for (let i = 0; i < 5; i++) spawnCard(state, "forest", 0, "library");
		for (let i = 0; i < 5; i++) spawnCard(state, "forest", 1, "library");

		advanceToNextTurn(state, agents); // P0's turn
		dump(state);
		expect(state.players[0].hand.length, "P0 drew nothing").toBe(0);
		expect(state.players[0].library.length, "P0 library intact").toBe(5);

		advanceToNextTurn(state, agents); // P1's turn
		state.log.length = 0;
		expect(state.players[1].hand.length, "P1 still draws normally").toBe(1);
	});
});

describe("tier ordering", () => {
	test("Gather Specimens (control tier) applies before Root Maze (other tier)", () => {
		const state = newGame();
		const agents: [Agent, Agent] = [new ScriptedAgent(), new ScriptedAgent()];
		spawnPermanent(state, "root-maze", 0, "battlefield");
		spawnPermanent(state, "mycosynth-lattice", 0, "battlefield");
		addFloating(state, 0, "gatherSpecimens", { you: 0 });
		const bears = spawnCard(state, "grizzly-bears", 1, "hand");

		const r = perform(
			state,
			{
				kind: "zoneChange",
				object: bears.id,
				from: "hand",
				to: "battlefield",
				cause: "resolve",
				toController: P2,
			},
			agents,
		);
		dump(state);
		const entered = permanent(state, created(r));
		expect(entered.controller, "P0 stole it").toBe(0);
		expect(entered.tapped, "and it still entered tapped").toBe(true);
		expect(entered.owner, "P1 still owns it").toBe(1);
	});

	test("Clone (copy tier) resolves before other ETB modifiers", () => {
		const state = newGame();
		const agents: [Agent, Agent] = [new ScriptedAgent(), new ScriptedAgent()];
		spawnPermanent(state, "walking-ballista", 1, "battlefield", {
			counters: { "+1/+1": 2 },
		});
		const clone = spawnCard(state, "clone", 0, "hand");
		const r = perform(
			state,
			{
				kind: "zoneChange",
				object: clone.id,
				from: "hand",
				to: "battlefield",
				cause: "resolve",
				toController: P1,
			},
			agents,
		);
		dump(state);
		const entered = created(r);
		expect(
			permanent(state, entered).cardId,
			"entered as a copy of Ballista",
		).toBe("walking-ballista");
		// The copy picks up the copied card's printed ETB self-replacement, which is
		// the generally correct behavior. KNOWN DIVERGENCE: real Walking Ballista
		// enters with X counters and a copy has X=0, so real Magic gives 0 here. The
		// fix is modeling X as a value chosen on resolution and stored on the event,
		// not baked into the card definition — see notes.
		expect(
			permanent(state, entered).counters["+1/+1"] ?? 0,
			"copy inherits the copied card's printed ETB modifier",
		).toBe(2);
	});
});

describe("can't lose / alternate win", () => {
	test("Laboratory Maniac wins when drawing from an empty library", () => {
		const state = newGame();
		const agents: [Agent, Agent] = [new ScriptedAgent(), new ScriptedAgent()];
		spawnPermanent(state, "laboratory-maniac", P1, "battlefield");

		perform(state, { kind: "draw", player: P1 }, agents);
		checkStateBasedActions(state, agents);
		dump(state);

		expect(state.players[P1].won, "P1 wins via Laboratory Maniac").toBe(true);
		expect(state.players[P1].lost, "P1 did not also lose").toBe(false);
		expect(gameOver(state), "game is over").toBe(true);
		expect(winner(state), "P1 is the winner").toBe(P1);
	});

	test("Platinum Angel prevents losing from drawing an empty library", () => {
		const state = newGame();
		const agents: [Agent, Agent] = [new ScriptedAgent(), new ScriptedAgent()];
		spawnPermanent(state, "platinum-angel", P1, "battlefield");

		perform(state, { kind: "draw", player: P1 }, agents);
		checkStateBasedActions(state, agents);
		dump(state);

		expect(state.players[P1].lost, "P1 did not lose").toBe(false);
		expect(state.players[P1].won, "P1 did not win").toBe(false);
		expect(gameOver(state), "game continues").toBe(false);
		expect(winner(state), "no winner yet").toBe(null);
	});

	test("without Platinum Angel, drawing an empty library loses the game", () => {
		const state = newGame();
		const agents: [Agent, Agent] = [new ScriptedAgent(), new ScriptedAgent()];

		perform(state, { kind: "draw", player: P1 }, agents);
		checkStateBasedActions(state, agents);
		dump(state);

		expect(state.players[P1].lost, "P1 loses").toBe(true);
		expect(state.players[P1].won, "P1 did not win").toBe(false);
		expect(gameOver(state), "game is over").toBe(true);
		expect(winner(state), "P2 wins by default").toBe(P2);
	});
});

describe("triggered abilities", () => {
	test("Arashin Cleric queues its ETB trigger and gains life on resolution", () => {
		const state = newGame();
		const agents: [Agent, Agent] = [new ScriptedAgent(), new ScriptedAgent()];
		const cleric = spawnCard(state, "arashin-cleric", P1, "hand");

		perform(
			state,
			{
				kind: "zoneChange",
				object: cleric.id,
				from: "hand",
				to: "battlefield",
				cause: "resolve",
				toController: P1,
			},
			agents,
		);

		expect(state.players[P1].life, "trigger has not resolved yet").toBe(20);
		expect(state.pendingTriggers).toHaveLength(1);
		expect(state.pendingTriggers[0]?.source).not.toBe(cleric.id);

		settlePriority(state, agents);
		dump(state);
		expect(state.players[P1].life).toBe(23);
		expect(state.pendingTriggers).toHaveLength(0);
		expect(state.stack).toHaveLength(0);
	});

	test("Ajani's Mantra triggers only on its controller's upkeep", () => {
		const state = newGame();
		const agents: [Agent, Agent] = [new ScriptedAgent(), new ScriptedAgent()];
		spawnPermanent(state, "ajanis-mantra", P1, "battlefield");

		perform(state, { kind: "beginStep", player: P2, step: "upkeep" }, agents);
		expect(state.pendingTriggers).toHaveLength(0);

		perform(state, { kind: "beginStep", player: P1, step: "upkeep" }, agents);
		expect(state.pendingTriggers).toHaveLength(1);
		settlePriority(state, agents);
		expect(state.players[P1].life).toBe(21);
	});

	test("Ajani's Mantra's controller may decline", () => {
		const state = newGame();
		const agents: [Agent, Agent] = [
			new ScriptedAgent([], [false]),
			new ScriptedAgent(),
		];
		spawnPermanent(state, "ajanis-mantra", P1, "battlefield");
		perform(state, { kind: "beginStep", player: P1, step: "upkeep" }, agents);
		settlePriority(state, agents);
		expect(state.players[P1].life).toBe(20);
	});

	test("a trigger resolves after its source leaves", () => {
		const state = newGame();
		const agents: [Agent, Agent] = [new ScriptedAgent(), new ScriptedAgent()];
		const cleric = spawnCard(state, "arashin-cleric", P1, "hand");
		const result = perform(
			state,
			{
				kind: "zoneChange",
				object: cleric.id,
				from: "hand",
				to: "battlefield",
				cause: "resolve",
				toController: P1,
			},
			agents,
		);
		perform(
			state,
			{ kind: "destroy", object: created(result), noRegen: true },
			agents,
		);
		settlePriority(state, agents);
		expect(state.players[P1].life).toBe(23);
	});
});

describe("advance", () => {
	test("executes one scheduler transition", () => {
		const state = newGame();
		const agents: [Agent, Agent] = [new ScriptedAgent(), new ScriptedAgent()];

		advance(state, agents);

		expect(state.turn).toBe(0);
		expect(state.turnScheduler.currentTurn?.player).toBe(P1);
		expect(state.turnScheduler.currentPhase).toBe(null);
		expect(state.turnScheduler.command.kind).toBe("advancePhase");
	});

	test("eventually terminates", () => {
		function run() {
			const state = newGame();

			const agents: [Agent, Agent] = [new RandomAgent(), new RandomAgent()];

			for (let i = 0; i < 10_000; i++) {
				advance(state, agents);
				if (state.players.some((p) => p.lost)) {
					dump(state);
					return;
				}
			}

			throw new Error("max advancement count reached");
		}

		expect(run).not.toThrowError();
	});
});
