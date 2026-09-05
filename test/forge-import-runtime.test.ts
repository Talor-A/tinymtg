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
	setupMain,
	type SyncAgents,
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
registerCardFixture("d/darksteel_relic");

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

		const bear = enterFromHand(state, "rt-grizzly-bears", ALICE, agents);
		expect(permanent(state, bear).tapped, "creature is unaffected").toBe(false);
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
		expect(state.players[ALICE].life, "effect is on the stack, not resolved").toBe(20);

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
