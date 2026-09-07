import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ScriptedAgent } from "../agents.ts";
import "../cards.ts"; // side effect: registers the baseline lands (forest) libraries rely on
import { importForgeCard } from "../forge-import.ts";
import type { GameState, ObjectId, PlayerId } from "../index.ts";
import {
	abilityId,
	activePlayer,
	executeAbilityAction,
	isTurnStep,
	newGame,
	perform,
	permanent,
	registerCard,
	settlePriority,
	spawnCard,
	spawnPermanent,
	view,
} from "../index.ts";
import {
	ALICE,
	advanceUntil,
	BOB,
	beginFirstTurn,
	created,
	passingAgents,
	registerCardFixture,
	type SyncAgents,
	setupMain,
} from "./utils/engine-helpers.ts";

const CORPUS_ROOT = join(import.meta.dir, "..", "cards", "cardsfolder");

/**
 * Registers a fixture straight through the bridge under a caller-chosen id,
 * distinct from the hand-authored ids `cards.ts` already owns for some of
 * these same printed cards (e.g. `root-maze`, `faithful-watchdog`). This file
 * proves the *imported* definitions actually run, independent of whichever
 * hand-written stand-ins other suites exercise.
 */
function registerRuntimeFixture(path: string, id: string): void {
	const text = readFileSync(join(CORPUS_ROOT, `${path}.txt`), "utf8");
	const result = importForgeCard(text, { id });
	if (!result.ok) {
		throw new Error(
			`unsupported runtime fixture ${path}: ${result.diagnostics
				.map((d) => `${d.code}: ${d.message}`)
				.join("; ")}`,
		);
	}
	registerCard(result.card);
}

registerRuntimeFixture("g/grizzly_bears", "rt-grizzly-bears");
registerRuntimeFixture("g/glorious_anthem", "rt-glorious-anthem");
registerRuntimeFixture("r/root_maze", "rt-root-maze");
registerRuntimeFixture("f/faithful_watchdog", "rt-faithful-watchdog");
registerRuntimeFixture("a/arashin_cleric", "rt-arashin-cleric");
registerRuntimeFixture("a/ajanis_mantra", "rt-ajanis-mantra");
registerRuntimeFixture("l/llanowar_elves", "rt-llanowar-elves");
registerRuntimeFixture("s/soulmender", "rt-soulmender");
registerRuntimeFixture("c/charcoal_diamond", "rt-charcoal-diamond");
registerCardFixture("d/darksteel_relic");

/**
 * Synthetic: a static that makes every permanent an artifact, purely to
 * exercise the CR 614.12 own-entry guard on Root Maze's imported global
 * enters-tapped replacement (a general "artifacts and lands enter tapped"
 * effect does not apply to its own source's entry, even if some other effect
 * would make that source match). Not a stand-in for any real card's rules.
 */
registerCard({
	id: "rt-test-all-permanents-artifacts",
	name: "Test: All Permanents Are Artifacts",
	types: ["enchantment"],
	colors: [],
	manaCost: "zero",
	statics: [
		{
			layer: "4-type-changing",
			text: "Synthetic: all permanents are artifacts.",
			applies: () => true,
			modify: (v) => {
				if (!v.types.includes("artifact")) v.types = [...v.types, "artifact"];
			},
		},
	],
});

/**
 * Synthetic: an optional upkeep trigger whose effect sequence has two steps
 * (gain life, then draw), to prove the whole sequence is offered and applied
 * as one choice rather than per-effect.
 */
{
	const text = `Name:Test Optional Multi
ManaCost:1 W
Types:Enchantment
T:Mode$ Phase | Phase$ Upkeep | ValidPlayer$ You | TriggerZones$ Battlefield | Execute$ TrigA | OptionalDecider$ You | TriggerDescription$ x
SVar:TrigA:DB$ GainLife | Defined$ You | LifeAmount$ 3 | SubAbility$ TrigB
SVar:TrigB:DB$ Draw | Defined$ You | NumCards$ 1
Oracle:
`;
	const result = importForgeCard(text, { id: "rt-test-optional-multi" });
	if (!result.ok)
		throw new Error("expected synthetic optional-multi fixture to import");
	registerCard(result.card);
}

/**
 * Synthetic: an optional trigger that also targets, to pin down the order of
 * the two decisions — the target is chosen when the ability goes on the stack,
 * the "may" only when it resolves.
 */
{
	const text = `Name:Test Optional Targeted
ManaCost:1 R
Types:Enchantment
T:Mode$ Phase | Phase$ Upkeep | ValidPlayer$ You | TriggerZones$ Battlefield | Execute$ TrigZap | OptionalDecider$ You | TriggerDescription$ x
SVar:TrigZap:DB$ DealDamage | ValidTgts$ Creature | NumDmg$ 2 | SubAbility$ TrigGain
SVar:TrigGain:DB$ GainLife | Defined$ You | LifeAmount$ 2
Oracle:
`;
	const result = importForgeCard(text, { id: "rt-test-optional-targeted" });
	if (!result.ok)
		throw new Error("expected synthetic optional-targeted fixture to import");
	registerCard(result.card);
}

function atUpkeepOf(state: GameState, player: PlayerId): boolean {
	return isTurnStep(state, "upkeep") && activePlayer(state) === player;
}

function stockLibraries(state: GameState): void {
	for (const player of [ALICE, BOB] as const) {
		for (let i = 0; i < 3; i++) spawnCard(state, "forest", player, "library");
	}
}

function enterFromHand(
	state: GameState,
	cardId: string,
	controller: PlayerId,
	agents: SyncAgents,
): ObjectId {
	const card = spawnCard(state, cardId, controller, "hand");
	const result = perform(
		state,
		{
			kind: "change zone",
			object: card.id,
			from: "hand",
			to: "battlefield",
			cause: "resolve",
			toController: controller,
		},
		agents,
	);
	return created(result);
}

describe("forge-import runtime: triggers", () => {
	test("Arashin Cleric's imported ETB trigger queues and gains life on resolution", () => {
		const state = newGame();
		const agents: SyncAgents = [new ScriptedAgent(), new ScriptedAgent()];
		beginFirstTurn(state, agents);

		enterFromHand(state, "rt-arashin-cleric", ALICE, agents);

		expect(state.players[ALICE].life, "trigger has not resolved yet").toBe(20);
		expect(state.pendingTriggers).toHaveLength(1);

		settlePriority(state, agents);
		expect(state.players[ALICE].life).toBe(23);
		expect(state.stack).toHaveLength(0);
	});

	test("Ajani's Mantra's imported upkeep trigger fires only for its controller, and its choice is genuinely optional", () => {
		const accept = newGame();
		const acceptAgents: SyncAgents = [new ScriptedAgent(), new ScriptedAgent()];
		spawnPermanent(accept, "rt-ajanis-mantra", ALICE);
		stockLibraries(accept);
		advanceUntil(accept, acceptAgents, (next) => atUpkeepOf(next, ALICE));
		expect(accept.players[ALICE].life).toBe(21);
		advanceUntil(accept, acceptAgents, (next) => atUpkeepOf(next, BOB));
		expect(
			accept.players[ALICE].life,
			"opponent's upkeep does not trigger it",
		).toBe(21);

		const decline = newGame();
		const declineAgents: SyncAgents = [
			new ScriptedAgent([], [false]),
			new ScriptedAgent(),
		];
		spawnPermanent(decline, "rt-ajanis-mantra", ALICE);
		stockLibraries(decline);
		advanceUntil(decline, declineAgents, (next) => atUpkeepOf(next, ALICE));
		expect(decline.players[ALICE].life, "declined the optional gain").toBe(20);
	});

	test("an optional trigger's whole multi-effect sequence is accepted or declined as one choice", () => {
		const accept = newGame();
		const acceptAgents: SyncAgents = [
			new ScriptedAgent([], [true]),
			new ScriptedAgent(),
		];
		spawnPermanent(accept, "rt-test-optional-multi", ALICE);
		stockLibraries(accept);
		const handBefore = accept.players[ALICE].hand.length;
		advanceUntil(accept, acceptAgents, (next) => atUpkeepOf(next, ALICE));
		expect(accept.players[ALICE].life, "both effects applied together").toBe(
			23,
		);
		expect(accept.players[ALICE].hand.length).toBe(handBefore + 1);

		const decline = newGame();
		const declineAgents: SyncAgents = [
			new ScriptedAgent([], [false]),
			new ScriptedAgent(),
		];
		spawnPermanent(decline, "rt-test-optional-multi", ALICE);
		stockLibraries(decline);
		const declineHandBefore = decline.players[ALICE].hand.length;
		advanceUntil(decline, declineAgents, (next) => atUpkeepOf(next, ALICE));
		expect(decline.players[ALICE].life, "neither effect applied").toBe(20);
		expect(decline.players[ALICE].hand.length).toBe(declineHandBefore);
	});

	test("an optional targeted trigger picks its target before it asks the question", () => {
		for (const accepted of [true, false]) {
			const state = newGame();
			const agents: SyncAgents = [
				new ScriptedAgent([], [accepted]),
				new ScriptedAgent(),
			];
			spawnPermanent(state, "rt-test-optional-targeted", ALICE);
			const bears = spawnPermanent(state, "rt-grizzly-bears", BOB);
			stockLibraries(state);
			advanceUntil(state, agents, (next) => atUpkeepOf(next, ALICE));

			// 2 damage is lethal to a 2/2, so accepting kills it outright.
			expect(state.objects.has(bears.id)).toBe(!accepted);
			expect(state.players[ALICE].life).toBe(accepted ? 22 : 20);
		}
	});

	test("an optional targeted trigger with no legal target is never put on the stack", () => {
		const state = newGame();
		// The agent would say yes; it is never asked, because there is no creature
		// for the trigger to target when it would go on the stack.
		const agents: SyncAgents = [
			new ScriptedAgent([], [true]),
			new ScriptedAgent(),
		];
		spawnPermanent(state, "rt-test-optional-targeted", ALICE);
		stockLibraries(state);
		advanceUntil(state, agents, (next) => atUpkeepOf(next, ALICE));

		expect(state.players[ALICE].life).toBe(20);
		expect(state.stack).toHaveLength(0);
	});
});

describe("forge-import runtime: statics and replacements", () => {
	test("Glorious Anthem's imported static only pumps creatures its controller controls", () => {
		const state = newGame();
		spawnPermanent(state, "rt-glorious-anthem", ALICE);
		const mine = spawnPermanent(state, "rt-grizzly-bears", ALICE);
		const theirs = spawnPermanent(state, "rt-grizzly-bears", BOB);

		expect(view(state, mine.id)).toMatchObject({ power: 3, toughness: 3 });
		expect(view(state, theirs.id)).toMatchObject({ power: 2, toughness: 2 });
	});

	test("Root Maze's imported replacement taps entering artifacts and lands but not creatures", () => {
		const state = newGame();
		const agents: SyncAgents = [new ScriptedAgent(), new ScriptedAgent()];
		beginFirstTurn(state, agents);
		spawnPermanent(state, "rt-root-maze", ALICE);

		const relic = enterFromHand(state, "darksteel-relic", ALICE, agents);
		expect(permanent(state, relic).tapped, "artifact enters tapped").toBe(true);

		const forest = enterFromHand(state, "forest", ALICE, agents);
		expect(permanent(state, forest).tapped, "land enters tapped").toBe(true);

		const bear = enterFromHand(state, "rt-grizzly-bears", ALICE, agents);
		expect(permanent(state, bear).tapped, "creature is unaffected").toBe(false);
	});

	test("Root Maze's imported replacement matches an incoming object's derived type, not just its printed one", () => {
		const state = newGame();
		const agents: SyncAgents = [new ScriptedAgent(), new ScriptedAgent()];
		beginFirstTurn(state, agents);
		spawnPermanent(state, "rt-root-maze", ALICE);
		spawnPermanent(state, "rt-test-all-permanents-artifacts", ALICE);

		// Grizzly Bears is a creature by its printed characteristics, but the
		// synthetic static above adds "artifact" to every permanent's derived
		// type. Root Maze's replacement previews the *incoming* object through
		// that same static (etbPreview), so it must see "artifact" here too.
		const bear = enterFromHand(state, "rt-grizzly-bears", ALICE, agents);
		expect(
			permanent(state, bear).tapped,
			"Root Maze sees the previewed, derived type of the entering object",
		).toBe(true);
	});

	test("Faithful Watchdog's imported entersWith replacement grants its printed counters", () => {
		const state = newGame();
		const agents: SyncAgents = [new ScriptedAgent(), new ScriptedAgent()];
		beginFirstTurn(state, agents);

		const dog = enterFromHand(state, "rt-faithful-watchdog", ALICE, agents);
		expect(permanent(state, dog).counters).toEqual({ "+1/+1": 3 });
		expect(view(state, dog)).toMatchObject({
			power: 3,
			toughness: 3,
			keywords: ["vigilance"],
		});
	});

	test("Charcoal Diamond's imported canonical self-entry form enters tapped", () => {
		const state = newGame();
		const agents: SyncAgents = [new ScriptedAgent(), new ScriptedAgent()];
		beginFirstTurn(state, agents);

		const diamond = enterFromHand(state, "rt-charcoal-diamond", ALICE, agents);
		expect(permanent(state, diamond).tapped).toBe(true);
	});

	test("Root Maze's imported global replacement does not tap its own entry, even if another effect would make it match (CR 614.12)", () => {
		const state = newGame();
		const agents: SyncAgents = [new ScriptedAgent(), new ScriptedAgent()];
		beginFirstTurn(state, agents);
		spawnPermanent(state, "rt-test-all-permanents-artifacts", ALICE);

		const rootMaze = enterFromHand(state, "rt-root-maze", ALICE, agents);
		expect(
			permanent(state, rootMaze).tapped,
			"a general effect matching its own source's entry does not apply to that entry",
		).toBe(false);

		// Sanity check: the same effect *does* still tap an unrelated artifact
		// entering afterward, proving Root Maze itself is still working.
		const relic = enterFromHand(state, "darksteel-relic", ALICE, agents);
		expect(permanent(state, relic).tapped).toBe(true);
	});
});

describe("forge-import runtime: activated abilities", () => {
	test("Llanowar Elves' imported mana ability taps and adds green mana immediately", () => {
		const state = setupMain();
		const elves = spawnPermanent(state, "rt-llanowar-elves", ALICE);
		const ability = abilityId("activated", "rt-llanowar-elves", 0);

		executeAbilityAction(
			state,
			ALICE,
			{ kind: "activate ability", source: elves.id, ability },
			passingAgents(),
		);

		expect(permanent(state, elves.id).tapped).toBe(true);
		expect(state.players[ALICE].manaPool.g).toBe(1);
		expect(state.stack).toHaveLength(0);
	});

	test("Soulmender's imported targetless activated ability resolves through the stack", () => {
		const state = setupMain();
		const soulmender = spawnPermanent(state, "rt-soulmender", ALICE);
		const ability = abilityId("activated", "rt-soulmender", 0);

		executeAbilityAction(
			state,
			ALICE,
			{ kind: "activate ability", source: soulmender.id, ability },
			passingAgents(),
		);
		expect(permanent(state, soulmender.id).tapped).toBe(true);
		expect(
			state.players[ALICE].life,
			"effect is on the stack, not resolved",
		).toBe(20);

		settlePriority(state, passingAgents());
		expect(state.players[ALICE].life).toBe(21);
		expect(state.stack).toHaveLength(0);
	});
});

describe("forge-import runtime: registry and clone integrity", () => {
	test("an imported card with a static and a replacement survives structuredClone and rebuilds identical views", () => {
		const state = newGame();
		const agents: SyncAgents = [new ScriptedAgent(), new ScriptedAgent()];
		beginFirstTurn(state, agents);
		spawnPermanent(state, "rt-glorious-anthem", ALICE);
		spawnPermanent(state, "rt-root-maze", ALICE);
		const bear = spawnPermanent(state, "rt-grizzly-bears", ALICE);

		const before = view(state, bear.id);
		const cloned = structuredClone(state);
		const after = view(cloned, bear.id);

		expect(after).toEqual(before);
		expect(after).toMatchObject({ power: 3, toughness: 3 });
	});
});
