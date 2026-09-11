import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "../agents.ts";
import { CARDS } from "../cards.ts";
import type {
	ChoiceAnswer,
	ChoiceRequest,
	PlayerId,
	SyncAgent,
} from "../index.ts";
import {
	activePlayer,
	createEngine,
	defineCard,
	permanent,
	turnLocation,
} from "../index.ts";
import { beginFirstTurn, completePreGame } from "./utils/engine-helpers.ts";

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
			effects: [{ kind: "gain-life", subject: "you", amount: 1 }],
		},
		{
			id: "untap-self",
			text: "Whenever Tap Observer becomes untapped, you gain 2 life.",
			condition: { kind: "untap", predicate: { kind: "self" } },
			targets: [],
			effects: [{ kind: "gain-life", subject: "you", amount: 2 }],
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
			effects: [{ kind: "gain-life", subject: "you", amount: 1 }],
		},
		{
			id: "green-tapped",
			text: "Whenever a green permanent becomes tapped, you gain 1 life.",
			condition: {
				kind: "tap",
				predicate: { kind: "color", color: "g" },
			},
			targets: [],
			effects: [{ kind: "gain-life", subject: "you", amount: 1 }],
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
				applies: (event) => event.kind === "tap" && event.ref.kind === "all",
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
	test("single-object events occur and trigger only for actual transitions", () => {
		const state = engine.newGame();
		// The trigger reaches the stack through a priority window, which only
		// exists inside a turn.
		beginFirstTurn(engine, state, passingAgents);
		const observer = engine.spawnPermanent(state, TAP_OBSERVER, ALICE);

		const tap = engine.perform(
			state,
			{ kind: "tap", ref: { kind: "object", object: observer.id } },
			passingAgents,
		);
		expect(tap.executed).toHaveLength(1);
		expect(permanent(state, observer.id).tapped).toBe(true);
		expect(
			state.pendingTriggers.map((trigger) => String(trigger.triggerId)),
		).toEqual([`${TAP_OBSERVER}:0`]);
		engine.settlePriority(state, passingAgents);
		expect(state.players[ALICE].life).toBe(21);

		const untap = engine.perform(
			state,
			{ kind: "untap", ref: { kind: "object", object: observer.id } },
			passingAgents,
		);
		expect(untap.executed).toHaveLength(1);
		expect(permanent(state, observer.id).tapped).toBe(false);
		expect(
			state.pendingTriggers.map((trigger) => String(trigger.triggerId)),
		).toEqual([`${TAP_OBSERVER}:1`]);
	});

	test("single-object events already in the requested state do not occur", () => {
		const state = engine.newGame();
		const tapped = engine.spawnPermanent(state, TAP_OBSERVER, ALICE, {
			tapped: true,
		});
		const untapped = engine.spawnPermanent(state, TAP_OBSERVER, ALICE);
		const revision = state.revision;

		expect(
			engine.perform(
				state,
				{ kind: "tap", ref: { kind: "object", object: tapped.id } },
				passingAgents,
			).executed,
		).toEqual([]);
		expect(
			engine.perform(
				state,
				{ kind: "untap", ref: { kind: "object", object: untapped.id } },
				passingAgents,
			).executed,
		).toEqual([]);
		expect(state.revision).toBe(revision);
		expect(state.pendingTriggers).toEqual([]);
	});

	test("bulk events expose exactly the permanents whose state changed to triggers", () => {
		const state = engine.newGame();
		engine.spawnPermanent(state, BULK_OBSERVER, ALICE);
		const red = engine.spawnPermanent(state, "test-red-permanent", ALICE, {
			tapped: true,
		});
		const green = engine.spawnPermanent(state, "test-green-permanent", ALICE);

		const result = engine.perform(
			state,
			{ kind: "tap", ref: { kind: "all", player: ALICE } },
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
		const state = engine.newGame();
		engine.spawnPermanent(state, TAP_OBSERVER, ALICE, { tapped: true });
		engine.spawnPermanent(state, "test-red-permanent", ALICE, {
			tapped: true,
		});
		const revision = state.revision;

		const result = engine.perform(
			state,
			{ kind: "tap", ref: { kind: "all", player: ALICE } },
			passingAgents,
		);

		expect(result.executed).toEqual([]);
		expect(state.revision).toBe(revision);
		expect(state.pendingTriggers).toEqual([]);
	});

	test("the nonactive affected player orders replacements for their bulk event", () => {
		const state = engine.newGame();
		beginFirstTurn(engine, state, passingAgents);
		engine.spawnPermanent(state, "test-bulk-tap-replacement-a", ALICE);
		engine.spawnPermanent(state, "test-bulk-tap-replacement-b", ALICE);
		engine.spawnPermanent(state, "grizzly-bears", BOB);
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

		engine.perform(state, { kind: "tap", ref: { kind: "all", player: BOB } }, [
			unexpected,
			affected,
		]);

		expect(activePlayer(state)).toBe(ALICE);
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({ kind: "replacement", player: BOB });
	});

	test("untap-step triggers stay pending until the upkeep priority window", async () => {
		const checkpoint = engine.newGame();
		const observer = engine.spawnPermanent(checkpoint, TAP_OBSERVER, ALICE, {
			tapped: true,
		});

		completePreGame(engine, checkpoint, passingAgents);

		const untap = await engine.advanceWithReplay(checkpoint, passingAgents);
		expect(turnLocation(untap.state)).toMatchObject({
			kind: "step",
			step: { kind: "untap" },
		});
		expect(permanent(untap.state, observer.id).tapped).toBe(false);
		expect(untap.state.pendingTriggers).toHaveLength(1);
		expect(untap.state.stack).toEqual([]);
		expect(untap.state.players[ALICE].life).toBe(20);
		expect(() => structuredClone(untap.state)).not.toThrow();

		const upkeep = await engine.advanceWithReplay(untap.state, passingAgents);
		expect(turnLocation(upkeep.state)).toMatchObject({
			kind: "step",
			step: { kind: "upkeep" },
		});
		expect(upkeep.state.pendingTriggers).toEqual([]);
		expect(upkeep.state.stack).toEqual([]);
		expect(upkeep.state.players[ALICE].life).toBe(22);
	});
});
