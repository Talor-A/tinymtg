import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "../agents.ts";
import { defineCard } from "../card-def.ts";
import { CARDS } from "../cards.ts";
import type {
	ChoiceAnswer,
	ChoiceRequest,
	PlayerId,
	SyncAgent,
} from "../index.ts";
import {
	activePlayer,
	advanceWithReplay,
	createEngine,
	name,
	newGame,
	perform,
	permanent,
	settlePriority,
	spawnCard,
	spawnPermanent,
	turnLocation,
} from "../index.ts";
import {
	beginFirstTurn,
	completePreGame,
	expectScriptConsumed,
	newInProgressGame,
	setupMain,
} from "./utils/engine-helpers.ts";

const ALICE = 0 as PlayerId;
const BOB = 1 as PlayerId;

const TAP_OBSERVER = "test-tap-observer";
const TEST_CARD_1 = defineCard({
	id: TAP_OBSERVER,
	name: "Tap Observer",
	types: ["creature"],
	colors: [],
	manaCost: { n: 1 },
	power: 1,
	toughness: 1,
	triggers: [
		{
			id: "tap-self",
			text: "Whenever Tap Observer becomes tapped, you gain 1 life.",
			condition: { kind: "tap", predicate: { kind: "self" } },
			targets: [],
			effects: [
				{
					kind: "gain-life",
					subject: { kind: "relative-player", player: "you" },
					amount: 1,
				},
			],
		},
		{
			id: "untap-self",
			text: "Whenever Tap Observer becomes untapped, you gain 2 life.",
			condition: { kind: "untap", predicate: { kind: "self" } },
			targets: [],
			effects: [
				{
					kind: "gain-life",
					subject: { kind: "relative-player", player: "you" },
					amount: 2,
				},
			],
		},
	],
});

const BULK_OBSERVER = "test-bulk-tap-observer";
const TEST_CARD_2 = defineCard({
	id: BULK_OBSERVER,
	name: "Bulk Tap Observer",
	types: ["enchantment"],
	colors: [],
	manaCost: { n: 1 },
	triggers: [
		{
			id: "red-tapped",
			text: "Whenever a red permanent becomes tapped, you gain 1 life.",
			condition: {
				kind: "tap",
				predicate: { kind: "color", color: "r" },
			},
			targets: [],
			effects: [
				{
					kind: "gain-life",
					subject: { kind: "relative-player", player: "you" },
					amount: 1,
				},
			],
		},
		{
			id: "green-tapped",
			text: "Whenever a green permanent becomes tapped, you gain 1 life.",
			condition: {
				kind: "tap",
				predicate: { kind: "color", color: "g" },
			},
			targets: [],
			effects: [
				{
					kind: "gain-life",
					subject: { kind: "relative-player", player: "you" },
					amount: 1,
				},
			],
		},
	],
});

const COLORED_PERMANENTS = (
	[
		["test-red-permanent", "Red Permanent", "r"],
		["test-green-permanent", "Green Permanent", "g"],
	] as const
).map(([id, name, color]) =>
	defineCard({
		id,
		name,
		types: ["creature"],
		colors: [color],
		manaCost: { [color]: 1 },
		power: 1,
		toughness: 1,
	}),
);

const BULK_TAP_REPLACEMENTS = (
	[
		["test-bulk-tap-replacement-a", "Bulk Tap Replacement A"],
		["test-bulk-tap-replacement-b", "Bulk Tap Replacement B"],
	] as const
).map(([id, name]) =>
	defineCard({
		id,
		name,
		types: ["enchantment"],
		colors: [],
		manaCost: { n: 1 },
		replacements: [
			{
				label: id,
				text: `${name} replaces bulk tap events.`,
				layer: "other",
				applies: (event) => event.kind === "tap",
				replace: (event) => [event],
			},
		],
	}),
);

const engine = createEngine([
	...CARDS,
	TEST_CARD_1,
	TEST_CARD_2,
	...COLORED_PERMANENTS,
	...BULK_TAP_REPLACEMENTS,
]);

const passingAgents: [ScriptedAgent, ScriptedAgent] = [
	new ScriptedAgent(),
	new ScriptedAgent(),
];

describe("tap and untap occurrences", () => {
	test("a plural effect selects its permanents after responses resolve", () => {
		const state = setupMain(engine);
		const metalFatigue = spawnCard(state, "metal-fatigue", ALICE, "hand");
		const sentinel = spawnCard(state, "darksteel-sentinel", BOB, "hand");
		const bears = spawnPermanent(engine, state, "grizzly-bears", BOB);
		state.players[ALICE].manaPool.w = 1;
		state.players[ALICE].manaPool.c = 2;
		state.players[BOB].manaPool.c = 6;

		const alice = new ScriptedAgent(
			[],
			[],
			[{ kind: "cast", card: metalFatigue.id }],
		);
		const bob = new ScriptedAgent(
			[],
			[],
			[{ kind: "cast", card: sentinel.id }],
		);
		settlePriority(engine, state, [alice, bob]);

		expectScriptConsumed(alice);
		expectScriptConsumed(bob);
		const flashed = state.battlefield.find(
			(id) => name(engine, state, id) === "Darksteel Sentinel",
		);
		if (flashed === undefined) throw new Error("sentinel did not resolve");
		expect(permanent(state, flashed).tapped).toBe(true);
		expect(permanent(state, bears.id).tapped).toBe(false);
	});

	test("single-object events occur and trigger only for actual transitions", () => {
		const state = newGame();
		// The trigger reaches the stack through a priority window, which only
		// exists inside a turn.
		beginFirstTurn(engine, state, passingAgents);
		const observer = spawnPermanent(engine, state, TAP_OBSERVER, ALICE);

		const tap = perform(
			engine,
			state,
			{ kind: "tap", objects: [observer.id] },
			passingAgents,
		);
		expect(tap.executed).toHaveLength(1);
		expect(permanent(state, observer.id).tapped).toBe(true);
		expect(
			state.pendingTriggers.map((trigger) => String(trigger.triggerId)),
		).toEqual([`${TAP_OBSERVER}:0`]);
		settlePriority(engine, state, passingAgents);
		expect(state.players[ALICE].life).toBe(21);

		const untap = perform(
			engine,
			state,
			{ kind: "untap", objects: [observer.id] },
			passingAgents,
		);
		expect(untap.executed).toHaveLength(1);
		expect(permanent(state, observer.id).tapped).toBe(false);
		expect(
			state.pendingTriggers.map((trigger) => String(trigger.triggerId)),
		).toEqual([`${TAP_OBSERVER}:1`]);
	});

	test("single-object events already in the requested state do not occur", () => {
		const state = newGame();
		const tapped = spawnPermanent(engine, state, TAP_OBSERVER, ALICE, {
			tapped: true,
		});
		const untapped = spawnPermanent(engine, state, TAP_OBSERVER, ALICE);
		const revision = state.revision;

		expect(
			perform(
				engine,
				state,
				{ kind: "tap", objects: [tapped.id] },
				passingAgents,
			).executed,
		).toEqual([]);
		expect(
			perform(
				engine,
				state,
				{ kind: "untap", objects: [untapped.id] },
				passingAgents,
			).executed,
		).toEqual([]);
		expect(state.revision).toBe(revision);
		expect(state.pendingTriggers).toEqual([]);
	});

	test("bulk events expose exactly the permanents whose state changed to triggers", () => {
		const state = newGame();
		spawnPermanent(engine, state, BULK_OBSERVER, ALICE);
		const red = spawnPermanent(engine, state, "test-red-permanent", ALICE, {
			tapped: true,
		});
		const green = spawnPermanent(engine, state, "test-green-permanent", ALICE);

		const result = perform(
			engine,
			state,
			{ kind: "tap", objects: [...state.battlefield] },
			passingAgents,
		);

		expect(result.executed).toHaveLength(1);
		expect(permanent(state, red.id).tapped).toBe(true);
		expect(permanent(state, green.id).tapped).toBe(true);
		expect(
			state.pendingTriggers.map((trigger) => String(trigger.triggerId)),
		).toEqual([`${BULK_OBSERVER}:1`]);
	});

	test("a bulk event with no state transitions does not occur", () => {
		const state = newGame();
		spawnPermanent(engine, state, TAP_OBSERVER, ALICE, { tapped: true });
		spawnPermanent(engine, state, "test-red-permanent", ALICE, {
			tapped: true,
		});
		const revision = state.revision;

		const result = perform(
			engine,
			state,
			{ kind: "tap", objects: [...state.battlefield] },
			passingAgents,
		);

		expect(result.executed).toEqual([]);
		expect(state.revision).toBe(revision);
		expect(state.pendingTriggers).toEqual([]);
	});

	test("the nonactive affected player orders replacements for their bulk event", () => {
		const state = newGame();
		beginFirstTurn(engine, state, passingAgents);
		spawnPermanent(engine, state, "test-bulk-tap-replacement-a", ALICE);
		spawnPermanent(engine, state, "test-bulk-tap-replacement-b", ALICE);
		const bears = spawnPermanent(engine, state, "grizzly-bears", BOB);
		const requests: ChoiceRequest[] = [];
		const unexpected: SyncAgent = {
			choose: () => {
				throw new Error("the active player must not order this replacement");
			},
		};
		const affected: SyncAgent = {
			choose(_state, request): ChoiceAnswer {
				requests.push(request);
				const option = request.options[0];
				if (!option) throw new Error("expected a replacement option");
				return { optionId: option.id };
			},
		};

		perform(engine, state, { kind: "tap", objects: [bears.id] }, [
			unexpected,
			affected,
		]);

		expect(activePlayer(state)).toBe(ALICE);
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({ kind: "replacement", player: BOB });
	});

	test("untap-step triggers stay pending until the upkeep priority window", async () => {
		const checkpoint = newInProgressGame(engine);
		const observer = spawnPermanent(engine, checkpoint, TAP_OBSERVER, ALICE, {
			tapped: true,
		});

		completePreGame(engine, checkpoint, passingAgents);

		const untap = await advanceWithReplay(engine, checkpoint, passingAgents);
		expect(turnLocation(untap.state)).toMatchObject({
			kind: "step",
			step: { kind: "untap" },
		});
		expect(permanent(untap.state, observer.id).tapped).toBe(false);
		expect(untap.state.pendingTriggers).toHaveLength(1);
		expect(untap.state.stack).toEqual([]);
		expect(untap.state.players[ALICE].life).toBe(20);
		expect(() => structuredClone(untap.state)).not.toThrow();

		const upkeep = await advanceWithReplay(engine, untap.state, passingAgents);
		expect(turnLocation(upkeep.state)).toMatchObject({
			kind: "step",
			step: { kind: "upkeep" },
		});
		expect(upkeep.state.pendingTriggers).toEqual([]);
		expect(upkeep.state.stack).toEqual([]);
		expect(upkeep.state.players[ALICE].life).toBe(22);
	});
});
