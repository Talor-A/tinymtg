import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "../agents.ts";
import { CARDS } from "../cards.ts";
import type { Engine, GameState, ObjectId } from "../index.ts";
import {
	createEngine,
	gameOver,
	getSnapshot,
	IllegalAttackDeclarationError,
	IllegalBlockDeclarationError,
	isTurnStep,
	permanent,
	winner,
} from "../index.ts";
import {
	type SyncAgents as Agents,
	ALICE,
	advanceUntil,
	BOB,
	isAt,
	loadCardFixture,
	playOneTurn,
} from "./utils/engine-helpers.ts";

const engine = createEngine([
	...CARDS,
	...[
		"h/herald_of_faith",
		"f/flying_men",
		"g/giant_spider",
		"r/raging_goblin",
		"s/stealer_of_secrets",
		"w/wall_of_omens",
		"m/mire_triton",
	].map(loadCardFixture),
]);

/** One attacker-eligible creature plus enough library to survive a full turn. */
function setupAttackTurn(cardId: string): {
	state: GameState;
	attacker: ReturnType<Engine["spawnPermanent"]>;
} {
	const state = engine.newGame();
	const attacker = engine.spawnPermanent(state, cardId, ALICE);
	engine.spawnCard(state, "forest", ALICE, "library");
	engine.spawnCard(state, "forest", BOB, "library");
	return { state, attacker };
}

/** Scripts ALICE to declare exactly `ids` as attackers; BOB always passes. */
function attackWith(ids: ObjectId[]): Agents {
	return [new ScriptedAgent([], [], [], [ids]), new ScriptedAgent()];
}

function attackAndBlock(attacker: ObjectId, blockers: ObjectId[]): Agents {
	return [
		new ScriptedAgent([], [], [], [[attacker]]),
		new ScriptedAgent(
			[],
			[],
			[],
			[],
			[blockers.map((blocker) => ({ blocker, attacker }))],
		),
	];
}

describe("declaring attackers", () => {
	function declareAttackersSetup(): {
		state: GameState;
		agents: Agents;
	} {
		const state = engine.newGame();
		const agents: Agents = [new ScriptedAgent(), new ScriptedAgent()];
		// Enough library cards that the normal draw step along the way doesn't
		// lose either player the game before combat is reached.
		engine.spawnCard(state, "forest", ALICE, "library");
		engine.spawnCard(state, "forest", BOB, "library");
		// Establish a real declare-attackers scheduler boundary via engine.advance(): the
		// battlefield is still empty here, so the step's own turn-based action
		// declares no attackers, and engine.advance() returns at that occurrence.
		while (!isTurnStep(state, "declare attackers")) {
			engine.advance(state, agents);
		}
		return { state, agents };
	}

	test("an empty declaration is legal and changes nothing", () => {
		const { state, agents } = declareAttackersSetup();
		const bears = engine.spawnPermanent(state, "grizzly-bears", ALICE);

		const result = engine.perform(
			state,
			{ kind: "declare attackers", player: ALICE, attackers: [] },
			agents,
		);

		expect(result.executed).toHaveLength(1);
		expect(permanent(state, bears.id).attacking).toBe(false);
		expect(permanent(state, bears.id).tapped).toBe(false);
	});

	test("a partial subset of eligible creatures taps and marks only those selected", () => {
		const { state, agents } = declareAttackersSetup();
		const attacker = engine.spawnPermanent(state, "grizzly-bears", ALICE, {
			summoningSick: false,
		});
		const stayHome = engine.spawnPermanent(state, "eager-cadet", ALICE, {
			summoningSick: false,
		});

		engine.perform(
			state,
			{ kind: "declare attackers", player: ALICE, attackers: [attacker.id] },
			agents,
		);

		expect(permanent(state, attacker.id).attacking, "declared: attacking").toBe(
			true,
		);
		expect(permanent(state, attacker.id).tapped, "declared: tapped").toBe(true);
		expect(
			permanent(state, stayHome.id).attacking,
			"not declared: untouched",
		).toBe(false);
		expect(
			permanent(state, stayHome.id).tapped,
			"not declared: untouched",
		).toBe(false);
	});

	test("a creature with defender is neither offered nor accepted as an attacker", () => {
		const { state, agents } = declareAttackersSetup();
		const defender = engine.spawnPermanent(state, "wall-of-omens", ALICE, {
			summoningSick: false,
		});

		expect(engine.eligibleAttackers(state, ALICE)).not.toContain(defender.id);
		expect(() =>
			engine.perform(
				state,
				{
					kind: "declare attackers",
					player: ALICE,
					attackers: [defender.id],
				},
				agents,
			),
		).toThrow(IllegalAttackDeclarationError);
		expect(permanent(state, defender.id).attacking).toBe(false);
		expect(permanent(state, defender.id).tapped).toBe(false);
	});

	test("rejects a tapped creature", () => {
		const { state, agents } = declareAttackersSetup();
		const tapped = engine.spawnPermanent(state, "grizzly-bears", ALICE, {
			tapped: true,
		});

		expect(() =>
			engine.perform(
				state,
				{ kind: "declare attackers", player: ALICE, attackers: [tapped.id] },
				agents,
			),
		).toThrow(IllegalAttackDeclarationError);
		expect(permanent(state, tapped.id).attacking).toBe(false);
	});

	test("rejects a creature controlled by the opponent", () => {
		const { state, agents } = declareAttackersSetup();
		const opposing = engine.spawnPermanent(state, "grizzly-bears", BOB);

		expect(() =>
			engine.perform(
				state,
				{ kind: "declare attackers", player: ALICE, attackers: [opposing.id] },
				agents,
			),
		).toThrow(IllegalAttackDeclarationError);
		expect(permanent(state, opposing.id).attacking).toBe(false);
	});

	test("rejects a noncreature permanent", () => {
		const { state, agents } = declareAttackersSetup();
		const mantra = engine.spawnPermanent(state, "ajanis-mantra", ALICE);

		expect(() =>
			engine.perform(
				state,
				{ kind: "declare attackers", player: ALICE, attackers: [mantra.id] },
				agents,
			),
		).toThrow(IllegalAttackDeclarationError);
	});

	test("rejects duplicate IDs atomically, even with only one eligible creature", () => {
		const { state, agents } = declareAttackersSetup();
		const bears = engine.spawnPermanent(state, "grizzly-bears", ALICE);

		expect(() =>
			engine.perform(
				state,
				{
					kind: "declare attackers",
					player: ALICE,
					attackers: [bears.id, bears.id],
				},
				agents,
			),
		).toThrow(IllegalAttackDeclarationError);
		expect(permanent(state, bears.id).attacking, "no partial commit").toBe(
			false,
		);
		expect(permanent(state, bears.id).tapped, "no partial commit").toBe(false);
	});

	test("rejects the whole declaration atomically when a valid ID precedes an ineligible one", () => {
		const { state, agents } = declareAttackersSetup();
		const eligible = engine.spawnPermanent(state, "grizzly-bears", ALICE);
		const tapped = engine.spawnPermanent(state, "eager-cadet", ALICE, {
			tapped: true,
		});

		expect(() =>
			engine.perform(
				state,
				{
					kind: "declare attackers",
					player: ALICE,
					attackers: [eligible.id, tapped.id],
				},
				agents,
			),
		).toThrow(IllegalAttackDeclarationError);
		expect(
			permanent(state, eligible.id).attacking,
			"the eligible creature ahead of the bad ID stayed unaffected",
		).toBe(false);
		expect(permanent(state, eligible.id).tapped).toBe(false);
	});

	test("rejects declaring attackers outside the declare attackers step", () => {
		const state = engine.newGame();
		const agents: Agents = [new ScriptedAgent(), new ScriptedAgent()];
		const bears = engine.spawnPermanent(state, "grizzly-bears", ALICE);

		expect(() =>
			engine.perform(
				state,
				{ kind: "declare attackers", player: ALICE, attackers: [bears.id] },
				agents,
			),
		).toThrow(IllegalAttackDeclarationError);
	});

	test("rejects a declaration from a player who isn't the active player", () => {
		const { state, agents } = declareAttackersSetup();
		const bears = engine.spawnPermanent(state, "grizzly-bears", BOB);
		// default activePlayer is ALICE; BOB tries to declare attackers.
		expect(() =>
			engine.perform(
				state,
				{ kind: "declare attackers", player: BOB, attackers: [bears.id] },
				agents,
			),
		).toThrow(IllegalAttackDeclarationError);
	});

	test("regeneration still clears attacking (and blocking), not just damage and tapped state", () => {
		const { state, agents } = declareAttackersSetup();
		const bears = engine.spawnPermanent(state, "grizzly-bears", ALICE, {
			summoningSick: false,
		});
		engine.perform(
			state,
			{ kind: "declare attackers", player: ALICE, attackers: [bears.id] },
			agents,
		);
		expect(permanent(state, bears.id).attacking).toBe(true);

		engine.perform(state, { kind: "regenerate", object: bears.id }, agents);

		expect(
			permanent(state, bears.id).attacking,
			"regeneration clears attacking too",
		).toBe(false);
		expect(
			permanent(state, bears.id).tapped,
			"regeneration re-taps as part of its effect, not a cost",
		).toBe(true);
	});
});

describe("declaring blockers", () => {
	function declareBlockersSetup(attackerCard = "grizzly-bears"): {
		state: GameState;
		agents: Agents;
		attacker: ReturnType<Engine["spawnPermanent"]>;
	} {
		const state = engine.newGame();
		const attackerAgent = new ScriptedAgent();
		const agents: Agents = [attackerAgent, new ScriptedAgent()];
		engine.spawnCard(state, "forest", ALICE, "library");
		engine.spawnCard(state, "forest", BOB, "library");
		const attacker = engine.spawnPermanent(state, attackerCard, ALICE);
		attackerAgent.attackerChoices.push([attacker.id]);
		while (!isTurnStep(state, "declare blockers")) {
			engine.advance(state, agents);
		}
		return { state, agents, attacker };
	}

	test("an empty declaration is legal and changes nothing", () => {
		const { state, agents, attacker } = declareBlockersSetup();
		const blocker = engine.spawnPermanent(state, "grizzly-bears", BOB);

		const result = engine.perform(
			state,
			{ kind: "declare blockers", player: BOB, blockers: [] },
			agents,
		);

		expect(result.executed).toHaveLength(1);
		expect(permanent(state, blocker.id).blocking).toBe(false);
		expect(permanent(state, blocker.id).tapped).toBe(false);
		expect(permanent(state, attacker.id).attacking).toBe(true);
	});

	test("Aesthir Glider is neither offered nor accepted as a blocker", () => {
		const { state, agents, attacker } = declareBlockersSetup();
		const glider = engine.spawnPermanent(state, "aesthir-glider", BOB);
		const bear = engine.spawnPermanent(state, "grizzly-bears", BOB);

		expect(engine.eligibleBlockers(state, BOB)).toEqual([bear.id]);
		const before = structuredClone(state);
		expect(() =>
			engine.perform(
				state,
				{
					kind: "declare blockers",
					player: BOB,
					blockers: [{ blocker: glider.id, attacker: attacker.id }],
				},
				agents,
			),
		).toThrow(IllegalBlockDeclarationError);
		// engine.perform() logs the attempted event before validation; gameplay state is
		// otherwise unchanged by the rejected declaration.
		expect({ ...state, log: before.log }).toEqual(before);
	});

	test("a creature without flying or reach cannot block a flying attacker", () => {
		const { state, agents, attacker } = declareBlockersSetup("herald-of-faith");
		const bear = engine.spawnPermanent(state, "grizzly-bears", BOB);

		expect(engine.eligibleBlockers(state, BOB)).toEqual([bear.id]);
		expect(engine.eligibleBlockers(state, BOB, attacker.id)).toEqual([]);
		const before = structuredClone(state);
		expect(() =>
			engine.perform(
				state,
				{
					kind: "declare blockers",
					player: BOB,
					blockers: [{ blocker: bear.id, attacker: attacker.id }],
				},
				agents,
			),
		).toThrow(IllegalBlockDeclarationError);
		expect({ ...state, log: before.log }).toEqual(before);
	});

	test("a creature with flying can block a flying attacker", () => {
		const { state, agents, attacker } = declareBlockersSetup("herald-of-faith");
		const blocker = engine.spawnPermanent(state, "flying-men", BOB);

		expect(engine.eligibleBlockers(state, BOB, attacker.id)).toEqual([
			blocker.id,
		]);
		engine.perform(
			state,
			{
				kind: "declare blockers",
				player: BOB,
				blockers: [{ blocker: blocker.id, attacker: attacker.id }],
			},
			agents,
		);
		expect(permanent(state, blocker.id).blocking).toBe(true);
	});

	test("a creature with reach can block a flying attacker", () => {
		const { state, agents, attacker } = declareBlockersSetup("herald-of-faith");
		const blocker = engine.spawnPermanent(state, "giant-spider", BOB);

		expect(engine.eligibleBlockers(state, BOB, attacker.id)).toEqual([
			blocker.id,
		]);
		engine.perform(
			state,
			{
				kind: "declare blockers",
				player: BOB,
				blockers: [{ blocker: blocker.id, attacker: attacker.id }],
			},
			agents,
		);
		expect(permanent(state, blocker.id).blocking).toBe(true);
	});

	test("a creature with flying can block a creature without flying", () => {
		const { state, agents, attacker } = declareBlockersSetup();
		const blocker = engine.spawnPermanent(state, "flying-men", BOB);

		expect(engine.eligibleBlockers(state, BOB, attacker.id)).toEqual([
			blocker.id,
		]);
		engine.perform(
			state,
			{
				kind: "declare blockers",
				player: BOB,
				blockers: [{ blocker: blocker.id, attacker: attacker.id }],
			},
			agents,
		);
		expect(permanent(state, blocker.id).blocking).toBe(true);
	});

	test("a blocker assignment marks the blocker but does not tap it", () => {
		const { state, agents, attacker } = declareBlockersSetup();
		const blocker = engine.spawnPermanent(state, "grizzly-bears", BOB);

		engine.perform(
			state,
			{
				kind: "declare blockers",
				player: BOB,
				blockers: [{ blocker: blocker.id, attacker: attacker.id }],
			},
			agents,
		);

		expect(permanent(state, blocker.id).blocking, "declared: blocking").toBe(
			true,
		);
		expect(permanent(state, blocker.id).tapped, "blocking does not tap").toBe(
			false,
		);
		expect(permanent(state, attacker.id).attacking).toBe(true);
	});

	test("multiple blockers can block the same attacker", () => {
		const { state, agents, attacker } = declareBlockersSetup();
		const alpha = engine.spawnPermanent(state, "grizzly-bears", BOB);
		const beta = engine.spawnPermanent(state, "eager-cadet", BOB);

		engine.perform(
			state,
			{
				kind: "declare blockers",
				player: BOB,
				blockers: [
					{ blocker: alpha.id, attacker: attacker.id },
					{ blocker: beta.id, attacker: attacker.id },
				],
			},
			agents,
		);

		expect(permanent(state, alpha.id).blocking).toBe(true);
		expect(permanent(state, beta.id).blocking).toBe(true);
	});

	test("rejects a tapped creature as a blocker", () => {
		const { state, agents, attacker } = declareBlockersSetup();
		const tapped = engine.spawnPermanent(state, "grizzly-bears", BOB, {
			tapped: true,
		});

		expect(() =>
			engine.perform(
				state,
				{
					kind: "declare blockers",
					player: BOB,
					blockers: [{ blocker: tapped.id, attacker: attacker.id }],
				},
				agents,
			),
		).toThrow(IllegalBlockDeclarationError);
		expect(permanent(state, tapped.id).blocking).toBe(false);
	});

	test("rejects a creature controlled by the active player as a blocker", () => {
		const { state, agents, attacker } = declareBlockersSetup();
		const activeBlocker = engine.spawnPermanent(state, "grizzly-bears", ALICE);

		expect(() =>
			engine.perform(
				state,
				{
					kind: "declare blockers",
					player: BOB,
					blockers: [{ blocker: activeBlocker.id, attacker: attacker.id }],
				},
				agents,
			),
		).toThrow(IllegalBlockDeclarationError);
		expect(permanent(state, activeBlocker.id).blocking).toBe(false);
	});

	test("rejects a noncreature permanent as a blocker", () => {
		const { state, agents, attacker } = declareBlockersSetup();
		const mantra = engine.spawnPermanent(state, "ajanis-mantra", BOB);

		expect(() =>
			engine.perform(
				state,
				{
					kind: "declare blockers",
					player: BOB,
					blockers: [{ blocker: mantra.id, attacker: attacker.id }],
				},
				agents,
			),
		).toThrow(IllegalBlockDeclarationError);
	});

	test("rejects a blocker assigned to multiple attackers atomically", () => {
		const { state, agents } = declareBlockersSetup();
		const alpha = engine.spawnPermanent(state, "grizzly-bears", ALICE);
		const beta = engine.spawnPermanent(state, "eager-cadet", ALICE);
		alpha.attacking = true;
		beta.attacking = true;
		const blocker = engine.spawnPermanent(state, "grizzly-bears", BOB);

		expect(() =>
			engine.perform(
				state,
				{
					kind: "declare blockers",
					player: BOB,
					blockers: [
						{ blocker: blocker.id, attacker: alpha.id },
						{ blocker: blocker.id, attacker: beta.id },
					],
				},
				agents,
			),
		).toThrow(IllegalBlockDeclarationError);
		expect(permanent(state, blocker.id).blocking, "no partial commit").toBe(
			false,
		);
	});

	test("rejects a blocker assigned to a creature that is not attacking", () => {
		const { state, agents } = declareBlockersSetup();
		const nonAttacker = engine.spawnPermanent(state, "eager-cadet", ALICE);
		const blocker = engine.spawnPermanent(state, "grizzly-bears", BOB);

		expect(() =>
			engine.perform(
				state,
				{
					kind: "declare blockers",
					player: BOB,
					blockers: [{ blocker: blocker.id, attacker: nonAttacker.id }],
				},
				agents,
			),
		).toThrow(IllegalBlockDeclarationError);
	});

	test("rejects declaring blockers outside the declare blockers step", () => {
		const state = engine.newGame();
		const agents: Agents = [new ScriptedAgent(), new ScriptedAgent()];
		const attacker = engine.spawnPermanent(state, "grizzly-bears", ALICE);
		const blocker = engine.spawnPermanent(state, "grizzly-bears", BOB);

		expect(() =>
			engine.perform(
				state,
				{
					kind: "declare blockers",
					player: BOB,
					blockers: [{ blocker: blocker.id, attacker: attacker.id }],
				},
				agents,
			),
		).toThrow(IllegalBlockDeclarationError);
	});

	test("rejects a declaration from a player who isn't the defending player", () => {
		const { state, agents, attacker } = declareBlockersSetup();
		const blocker = engine.spawnPermanent(state, "grizzly-bears", BOB);

		expect(() =>
			engine.perform(
				state,
				{
					kind: "declare blockers",
					player: ALICE,
					blockers: [{ blocker: blocker.id, attacker: attacker.id }],
				},
				agents,
			),
		).toThrow(IllegalBlockDeclarationError);
	});

	test("blocking clears at end combat", () => {
		const { state, agents, attacker } = declareBlockersSetup();
		const blocker = engine.spawnPermanent(state, "grizzly-bears", BOB, {
			counters: { "+1/+1": 1 },
		});
		engine.perform(
			state,
			{
				kind: "declare blockers",
				player: BOB,
				blockers: [{ blocker: blocker.id, attacker: attacker.id }],
			},
			agents,
		);
		expect(permanent(state, blocker.id).blocking).toBe(true);

		while (!isTurnStep(state, "end combat")) {
			engine.advance(state, agents);
		}

		expect(
			permanent(state, blocker.id).blocking,
			"end combat clears blocking",
		).toBe(false);
		expect(permanent(state, blocker.id).tapped, "blocking never tapped").toBe(
			false,
		);
		expect(
			state.blockAssignments,
			"end combat clears block assignments",
		).toEqual([]);
	});
});

describe("declaring attackers during normal progression", () => {
	test("summoning sickness clears as its controller's turn begins", () => {
		const state = engine.newGame();
		const attacker = engine.spawnPermanent(state, "grizzly-bears", ALICE);
		const agents: Agents = [new ScriptedAgent(), new ScriptedAgent()];
		engine.spawnCard(state, "forest", ALICE, "library");
		engine.spawnCard(state, "forest", BOB, "library");

		expect(permanent(state, attacker.id).summoningSick).toBe(true);
		advanceUntil(engine, state, agents, (next) => isAt(next, "main"));
		expect(permanent(state, attacker.id).summoningSick).toBe(false);
		expect(engine.eligibleAttackers(state, ALICE)).toContain(attacker.id);
	});

	test("a creature cannot attack on the turn it enters", () => {
		const state = engine.newGame();
		const agents: Agents = [new ScriptedAgent(), new ScriptedAgent()];
		engine.spawnCard(state, "forest", ALICE, "library");
		engine.spawnCard(state, "forest", BOB, "library");

		advanceUntil(engine, state, agents, (next) => isAt(next, "main"));
		const attacker = engine.spawnPermanent(state, "grizzly-bears", ALICE);

		expect(engine.eligibleAttackers(state, ALICE)).not.toContain(attacker.id);
		advanceUntil(engine, state, agents, (next) =>
			isAt(next, "declare attackers"),
		);
		expect(permanent(state, attacker.id).attacking).toBe(false);
		expect(permanent(state, attacker.id).tapped).toBe(false);
	});

	test("haste allows a creature to attack on the turn it enters", () => {
		const state = engine.newGame();
		const attackerAgent = new ScriptedAgent();
		const agents: Agents = [attackerAgent, new ScriptedAgent()];
		engine.spawnCard(state, "forest", ALICE, "library");
		engine.spawnCard(state, "forest", BOB, "library");

		advanceUntil(engine, state, agents, (next) => isAt(next, "main"));
		const attacker = engine.spawnPermanent(state, "raging-goblin", ALICE);
		expect(engine.eligibleAttackers(state, ALICE)).toContain(attacker.id);
		attackerAgent.attackerChoices.push([attacker.id]);

		advanceUntil(engine, state, agents, (next) =>
			isAt(next, "declare attackers"),
		);
		expect(permanent(state, attacker.id).attacking).toBe(true);
		expect(permanent(state, attacker.id).tapped).toBe(true);
	});

	test("attacking clears at end combat but tapped persists until the next untap", () => {
		const { state, attacker } = setupAttackTurn("grizzly-bears");
		const agents: Agents = [
			new ScriptedAgent([], [], [], [[attacker.id]]),
			new ScriptedAgent(),
		];

		advanceUntil(engine, state, agents, (next) => isAt(next, "end combat"));
		expect(
			permanent(state, attacker.id).attacking,
			"end combat clears attacking",
		).toBe(false);
		expect(
			permanent(state, attacker.id).tapped,
			"tapped is untouched by end combat",
		).toBe(true);
	});

	test("a self-pumping attack trigger applies before combat damage", () => {
		const { state, attacker: veteran } = setupAttackTurn("benalish-veteran");
		const agents: Agents = [
			new ScriptedAgent([], [], [], [[veteran.id]]),
			new ScriptedAgent(),
		];

		playOneTurn(engine, state, agents);

		// A 2/2 that pumps itself to 3/3 on attack deals 3.
		expect(state.players[BOB].life).toBe(17);
		// The bonus is gone once the turn ends, and the printed 2/2 is back.
		expect(
			getSnapshot(engine.createReadContext(state), veteran.id)
				.currentCharacteristics,
		).toMatchObject({ power: 2, toughness: 2 });
		expect(state.temporaryEffects).toHaveLength(0);
		expect(state.pendingTriggers).toHaveLength(0);
		expect(state.stack).toHaveLength(0);
	});

	test("a creature not selected to attack stays untapped and unattacking", () => {
		const { state, attacker } = setupAttackTurn("grizzly-bears");
		const agents: Agents = [
			new ScriptedAgent([], [], [], [[]]),
			new ScriptedAgent(),
		];

		playOneTurn(engine, state, agents);

		expect(permanent(state, attacker.id).attacking).toBe(false);
		expect(permanent(state, attacker.id).tapped).toBe(false);
	});

	test("the attacker-selection request happens only during the declare-attackers step", () => {
		const { state, attacker } = setupAttackTurn("grizzly-bears");
		const agents: Agents = [
			new ScriptedAgent([], [], [], [[attacker.id]]),
			new ScriptedAgent(),
		];

		playOneTurn(engine, state, agents);

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

		playOneTurn(engine, state, agents);

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

	test("Pegasus Courser grants flying only to another attacking creature", () => {
		const state = engine.newGame();
		const courser = engine.spawnPermanent(state, "pegasus-courser", ALICE);
		const wingmate = engine.spawnPermanent(state, "grizzly-bears", ALICE);
		const stayedHome = engine.spawnPermanent(state, "grizzly-bears", ALICE);
		const groundBlocker = engine.spawnPermanent(state, "grizzly-bears", BOB);
		engine.spawnCard(state, "forest", ALICE, "library");
		engine.spawnCard(state, "forest", BOB, "library");

		const alice = new ScriptedAgent(
			[],
			[],
			[],
			[[courser.id, wingmate.id]],
			[],
			[{ type: "permanent", id: wingmate.id }],
		);
		const agents: Agents = [alice, new ScriptedAgent()];
		advanceUntil(engine, state, agents, (next) => isAt(next, "declare blockers"));

		expect(alice.targetChoices).toHaveLength(0);
		expect(
			getSnapshot(engine.createReadContext(state), wingmate.id)
				.currentCharacteristics.keywords,
		).toContain("flying");
		expect(
			getSnapshot(engine.createReadContext(state), stayedHome.id)
				.currentCharacteristics.keywords,
		).not.toContain("flying");
		expect(engine.eligibleBlockers(state, BOB, wingmate.id)).not.toContain(
			groundBlocker.id,
		);

		playOneTurn(engine, state, agents);
		expect(
			getSnapshot(engine.createReadContext(state), wingmate.id)
				.currentCharacteristics.keywords,
		).not.toContain("flying");
		expect(state.temporaryEffects).toHaveLength(0);
	});
	});

describe("dealing combat damage", () => {
	test("a blocked attacker damages its blocker instead of the defending player", () => {
		const { state, attacker } = setupAttackTurn("grizzly-bears");
		const blocker = engine.spawnPermanent(state, "grizzly-bears", BOB);
		const agents = attackAndBlock(attacker.id, [blocker.id]);

		advanceUntil(engine, state, agents, (next) =>
			isAt(next, "declare blockers"),
		);
		expect(state.blockAssignments).toEqual([
			{ blocker: blocker.id, attacker: attacker.id },
		]);

		advanceUntil(engine, state, agents, (next) => isAt(next, "combat damage"));
		expect(state.players[BOB].life, "blocked attacker did not hit BOB").toBe(
			20,
		);
		expect(state.objects.has(attacker.id), "blocker dealt lethal damage").toBe(
			false,
		);
		expect(state.objects.has(blocker.id), "attacker dealt lethal damage").toBe(
			false,
		);
	});

	test("multiple blockers all deal damage and receive a legal ordered assignment", () => {
		const state = engine.newGame();
		const attacker = engine.spawnPermanent(state, "grizzly-bears", ALICE, {
			counters: { "+1/+1": 1 },
		});
		const first = engine.spawnPermanent(state, "grizzly-bears", BOB);
		const second = engine.spawnPermanent(state, "eager-cadet", BOB);
		engine.spawnCard(state, "forest", ALICE, "library");
		engine.spawnCard(state, "forest", BOB, "library");
		const agents = attackAndBlock(attacker.id, [first.id, second.id]);

		advanceUntil(engine, state, agents, (next) => isAt(next, "combat damage"));

		expect(state.players[BOB].life).toBe(20);
		expect(state.objects.has(attacker.id), "blockers dealt 2 + 1").toBe(false);
		expect(state.objects.has(first.id), "first blocker received lethal 2").toBe(
			false,
		);
		expect(
			state.objects.has(second.id),
			"second blocker received remaining 1",
		).toBe(false);
	});

	test("Mire Triton assigns one lethal deathtouch damage to each blocker", () => {
		const { state, attacker } = setupAttackTurn("mire-triton");
		const first = engine.spawnPermanent(state, "grizzly-bears", BOB, {
			counters: { "+1/+1": 1 },
		});
		const second = engine.spawnPermanent(state, "grizzly-bears", BOB, {
			counters: { "+1/+1": 1 },
		});
		const agents = attackAndBlock(attacker.id, [first.id, second.id]);

		advanceUntil(engine, state, agents, (next) => isAt(next, "combat damage"));

		expect(state.players[BOB].life).toBe(20);
		expect(state.objects.has(attacker.id), "both blockers damaged Triton").toBe(
			false,
		);
		expect(
			state.objects.has(first.id),
			"one deathtouch damage destroyed the first 3/3",
		).toBe(false);
		expect(
			state.objects.has(second.id),
			"one deathtouch damage destroyed the second 3/3",
		).toBe(false);
	});

	test("an attacker remains blocked if its blocker regenerates before damage", () => {
		const { state, attacker } = setupAttackTurn("grizzly-bears");
		const blocker = engine.spawnPermanent(state, "grizzly-bears", BOB);
		const agents = attackAndBlock(attacker.id, [blocker.id]);

		advanceUntil(engine, state, agents, (next) =>
			isAt(next, "declare blockers"),
		);
		engine.perform(state, { kind: "regenerate", object: blocker.id }, agents);
		expect(permanent(state, blocker.id).blocking).toBe(false);

		advanceUntil(engine, state, agents, (next) => isAt(next, "combat damage"));
		expect(
			state.players[BOB].life,
			"blocked attacker did not become unblocked",
		).toBe(20);
		expect(permanent(state, attacker.id).damage).toBe(0);
	});

	test("a Grizzly Bears deals its power to the opponent at combat damage, not at declaration", () => {
		const { state, attacker } = setupAttackTurn("grizzly-bears");
		const agents = attackWith([attacker.id]);

		advanceUntil(engine, state, agents, (next) =>
			isAt(next, "declare attackers"),
		);
		expect(state.players[BOB].life, "no damage dealt merely by declaring").toBe(
			20,
		);

		advanceUntil(engine, state, agents, (next) => isAt(next, "combat damage"));
		expect(
			state.players[BOB].life,
			"Grizzly Bears' 2 power hit the opponent",
		).toBe(18);
	});

	test("multiple selected attackers deal the sum of their current powers while an unselected creature deals none", () => {
		const state = engine.newGame();
		const bears = engine.spawnPermanent(state, "grizzly-bears", ALICE);
		const attackingCadet = engine.spawnPermanent(state, "eager-cadet", ALICE);
		const benchedCadet = engine.spawnPermanent(state, "eager-cadet", ALICE);
		engine.spawnCard(state, "forest", ALICE, "library");
		engine.spawnCard(state, "forest", BOB, "library");
		const agents = attackWith([bears.id, attackingCadet.id]);

		playOneTurn(engine, state, agents);

		// 2 (Bears) + 1 (attacking Cadet) = 3; the benched Cadet contributes 0.
		expect(state.players[BOB].life).toBe(17);
		expect(permanent(state, benchedCadet.id).attacking).toBe(false);
	});

	test("current modified power is used: a +1/+1 counter makes Bears deal 3", () => {
		const state = engine.newGame();
		const bears = engine.spawnPermanent(state, "grizzly-bears", ALICE, {
			counters: { "+1/+1": 1 },
		});
		engine.spawnCard(state, "forest", ALICE, "library");
		engine.spawnCard(state, "forest", BOB, "library");
		const agents = attackWith([bears.id]);

		playOneTurn(engine, state, agents);

		expect(state.players[BOB].life, "3/3 Bears dealt 3").toBe(17);
	});

	test("Stealer of Secrets draws after it deals combat damage to a player", () => {
		const { state, attacker } = setupAttackTurn("stealer-of-secrets");
		// One card is consumed by the turn's normal draw; this one remains for the
		// combat-damage trigger.
		engine.spawnCard(state, "forest", ALICE, "library");
		const agents = attackWith([attacker.id]);

		playOneTurn(engine, state, agents);

		expect(state.players[BOB].life).toBe(18);
		expect(state.players[ALICE].hand).toHaveLength(2);
		expect(state.pendingTriggers).toHaveLength(0);
		expect(state.stack).toHaveLength(0);
	});

	test("Stealer of Secrets triggers only from combat damage to a player", () => {
		const state = engine.newGame();
		const source = engine.spawnPermanent(state, "stealer-of-secrets", ALICE);
		const creature = engine.spawnPermanent(state, "grizzly-bears", BOB);
		const agents: Agents = [new ScriptedAgent(), new ScriptedAgent()];
		const damage = {
			kind: "damage" as const,
			source: source.id,
			sourceController: ALICE,
			sourceColors: ["u"] as ["u"],
			amount: 2,
			deathtouch: false,
			lifelink: false,
			unpreventable: false,
		};

		engine.perform(
			state,
			{
				...damage,
				recipient: { type: "player", player: BOB },
				combat: false,
			},
			agents,
		);
		engine.perform(
			state,
			{
				...damage,
				recipient: { type: "permanent", id: creature.id },
				combat: true,
			},
			agents,
		);

		expect(state.players[BOB].life).toBe(18);
		expect(permanent(state, creature.id).damage).toBe(2);
		expect(state.pendingTriggers).toHaveLength(0);
	});

	test("Rhox War Monk's lifelink makes its controller gain life while the opponent loses it", () => {
		const { state, attacker } = setupAttackTurn("rhox-war-monk");
		const agents = attackWith([attacker.id]);

		playOneTurn(engine, state, agents);

		expect(state.players[ALICE].life, "gained 3 life via lifelink").toBe(23);
		expect(state.players[BOB].life, "lost 3 life to the same hit").toBe(17);
	});

	test("Furnace of Rath doubles combat damage through the normal replacement pipeline", () => {
		const { state, attacker } = setupAttackTurn("grizzly-bears");
		engine.spawnPermanent(state, "furnace-of-rath", ALICE);
		const agents = attackWith([attacker.id]);

		playOneTurn(engine, state, agents);

		expect(
			state.players[BOB].life,
			"2 power doubled to 4 by Furnace of Rath",
		).toBe(16);
	});

	test("destroying an attacker after declaration but before combat damage means it deals none", () => {
		const { state, attacker } = setupAttackTurn("grizzly-bears");
		const agents = attackWith([attacker.id]);

		advanceUntil(engine, state, agents, (next) =>
			isAt(next, "declare attackers"),
		);
		expect(permanent(state, attacker.id).attacking).toBe(true);
		engine.perform(
			state,
			{ kind: "destroy", object: attacker.id, noRegen: true },
			agents,
		);

		advanceUntil(engine, state, agents, (next) => isAt(next, "combat damage"));
		expect(state.players[BOB].life, "the destroyed attacker dealt none").toBe(
			20,
		);
	});

	test("regenerating an attacker after declaration but before combat damage means it deals none", () => {
		const { state, attacker } = setupAttackTurn("grizzly-bears");
		const agents = attackWith([attacker.id]);

		advanceUntil(engine, state, agents, (next) =>
			isAt(next, "declare attackers"),
		);
		engine.perform(state, { kind: "regenerate", object: attacker.id }, agents);
		expect(
			permanent(state, attacker.id).attacking,
			"regeneration clears attacking",
		).toBe(false);

		advanceUntil(engine, state, agents, (next) => isAt(next, "combat damage"));
		expect(state.players[BOB].life, "the regenerated creature dealt none").toBe(
			20,
		);
	});

	test("combat damage can cause the defending player to lose via normal state-based actions", () => {
		const { state, attacker } = setupAttackTurn("grizzly-bears");
		state.players[BOB].life = 1;
		const agents = attackWith([attacker.id]);

		advanceUntil(engine, state, agents, gameOver);

		expect(state.players[BOB].lost, "BOB died to combat damage").toBe(true);
		expect(winner(state)).toBe(ALICE);
		expect(state.players[BOB].life).toBe(-1);
	});

	test("attacking remains true through the damage step and clears only at end combat", () => {
		const { state, attacker } = setupAttackTurn("grizzly-bears");
		const agents = attackWith([attacker.id]);

		advanceUntil(engine, state, agents, (next) => isAt(next, "combat damage"));
		expect(
			permanent(state, attacker.id).attacking,
			"still attacking during the damage step",
		).toBe(true);

		advanceUntil(engine, state, agents, (next) => isAt(next, "end combat"));
		expect(
			permanent(state, attacker.id).attacking,
			"end combat clears attacking",
		).toBe(false);
	});
});
