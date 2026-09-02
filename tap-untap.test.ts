import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "./agents.ts";
import "./cards.ts";
import type {
	ChoiceAnswer,
	ChoiceRequest,
	PlayerId,
	SyncAgent,
} from "./index.ts";
import {
	activePlayer,
	advanceWithReplay,
	newGame,
	perform,
	permanent,
	registerCard,
	settlePriority,
	spawnPermanent,
	turnLocation,
} from "./index.ts";

const ALICE = 0 as PlayerId;
const BOB = 1 as PlayerId;

const TAP_OBSERVER = "test-tap-observer";
registerCard({
	id: TAP_OBSERVER,
	name: "Tap Observer",
	types: ["creature"],
	colors: [],
	manaCost: { c: 1 },
	power: 1,
	toughness: 1,
	triggers: [
		{
			id: "tap-self",
			text: "Whenever Tap Observer becomes tapped, you gain 1 life.",
			condition: { kind: "tap", selector: "self" },
			effects: [{ kind: "gain-life", player: "you", amount: 1 }],
		},
		{
			id: "untap-self",
			text: "Whenever Tap Observer becomes untapped, you gain 2 life.",
			condition: { kind: "untap", selector: "self" },
			effects: [{ kind: "gain-life", player: "you", amount: 2 }],
		},
	],
});

const BULK_OBSERVER = "test-bulk-tap-observer";
registerCard({
	id: BULK_OBSERVER,
	name: "Bulk Tap Observer",
	types: ["enchantment"],
	colors: [],
	manaCost: { c: 1 },
	triggers: [
		{
			id: "red-tapped",
			text: "Whenever a red permanent becomes tapped, you gain 1 life.",
			condition: { kind: "tap", selector: { color: "r" } },
			effects: [{ kind: "gain-life", player: "you", amount: 1 }],
		},
		{
			id: "green-tapped",
			text: "Whenever a green permanent becomes tapped, you gain 1 life.",
			condition: { kind: "tap", selector: { color: "g" } },
			effects: [{ kind: "gain-life", player: "you", amount: 1 }],
		},
	],
});

for (const [id, name, color] of [
	["test-red-permanent", "Red Permanent", "r"],
	["test-green-permanent", "Green Permanent", "g"],
] as const) {
	registerCard({
		id,
		name,
		types: ["creature"],
		colors: [color],
		manaCost: { [color]: 1 },
		power: 1,
		toughness: 1,
	});
}

for (const [id, name] of [
	["test-bulk-tap-replacement-a", "Bulk Tap Replacement A"],
	["test-bulk-tap-replacement-b", "Bulk Tap Replacement B"],
] as const) {
	registerCard({
		id,
		name,
		types: ["enchantment"],
		colors: [],
		manaCost: { c: 1 },
		replacements: [
			{
				label: id,
				text: `${name} replaces bulk tap events.`,
				layer: "other",
				applies: (event) => event.kind === "tap" && event.ref.kind === "all",
				replace: (event) => [event],
			},
		],
	});
}

const passingAgents: [ScriptedAgent, ScriptedAgent] = [
	new ScriptedAgent(),
	new ScriptedAgent(),
];

describe("tap and untap occurrences", () => {
	test("single-object events occur and trigger only for actual transitions", () => {
		const state = newGame();
		const observer = spawnPermanent(state, TAP_OBSERVER, ALICE, "battlefield");

		const tap = perform(
			state,
			{ kind: "tap", ref: { kind: "object", object: observer.id } },
			passingAgents,
		);
		expect(tap.executed).toHaveLength(1);
		expect(permanent(state, observer.id).tapped).toBe(true);
		expect(
			state.pendingTriggers.map((trigger) => String(trigger.triggerId)),
		).toEqual([`${TAP_OBSERVER}:0`]);
		settlePriority(state, passingAgents);
		expect(state.players[ALICE].life).toBe(21);

		const untap = perform(
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
		const state = newGame();
		const tapped = spawnPermanent(state, TAP_OBSERVER, ALICE, "battlefield", {
			tapped: true,
		});
		const untapped = spawnPermanent(state, TAP_OBSERVER, ALICE, "battlefield");
		const revision = state.revision;

		expect(
			perform(
				state,
				{ kind: "tap", ref: { kind: "object", object: tapped.id } },
				passingAgents,
			).executed,
		).toEqual([]);
		expect(
			perform(
				state,
				{ kind: "untap", ref: { kind: "object", object: untapped.id } },
				passingAgents,
			).executed,
		).toEqual([]);
		expect(state.revision).toBe(revision);
		expect(state.pendingTriggers).toEqual([]);
	});

	test("bulk events expose exactly the permanents whose state changed to triggers", () => {
		const state = newGame();
		spawnPermanent(state, BULK_OBSERVER, ALICE, "battlefield");
		const red = spawnPermanent(
			state,
			"test-red-permanent",
			ALICE,
			"battlefield",
			{
				tapped: true,
			},
		);
		const green = spawnPermanent(
			state,
			"test-green-permanent",
			ALICE,
			"battlefield",
		);

		const result = perform(
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
		const state = newGame();
		spawnPermanent(state, TAP_OBSERVER, ALICE, "battlefield", { tapped: true });
		spawnPermanent(state, "test-red-permanent", ALICE, "battlefield", {
			tapped: true,
		});
		const revision = state.revision;

		const result = perform(
			state,
			{ kind: "tap", ref: { kind: "all", player: ALICE } },
			passingAgents,
		);

		expect(result.executed).toEqual([]);
		expect(state.revision).toBe(revision);
		expect(state.pendingTriggers).toEqual([]);
	});

	test("the nonactive affected player orders replacements for their bulk event", () => {
		const state = newGame();
		spawnPermanent(state, "test-bulk-tap-replacement-a", ALICE, "battlefield");
		spawnPermanent(state, "test-bulk-tap-replacement-b", ALICE, "battlefield");
		spawnPermanent(state, "grizzly-bears", BOB, "battlefield");
		const requests: ChoiceRequest[] = [];
		const unexpected: SyncAgent = {
			choose: () => {
				throw new Error("only the affected player may order this replacement");
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

		perform(state, { kind: "tap", ref: { kind: "all", player: BOB } }, [
			unexpected,
			affected,
		]);

		// No turn has begun, so there is no active player here; ALICE is simply
		// not the player the bulk event affects.
		expect(activePlayer(state)).toBe(null);
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({ kind: "replacement", player: BOB });
	});

	test("untap-step triggers stay pending until the upkeep priority window", async () => {
		const checkpoint = newGame();
		const observer = spawnPermanent(
			checkpoint,
			TAP_OBSERVER,
			ALICE,
			"battlefield",
			{ tapped: true },
		);

		const untap = await advanceWithReplay(checkpoint, passingAgents);
		expect(turnLocation(untap.state)).toMatchObject({
			kind: "step",
			step: { kind: "untap" },
		});
		expect(permanent(untap.state, observer.id).tapped).toBe(false);
		expect(untap.state.pendingTriggers).toHaveLength(1);
		expect(untap.state.stack).toEqual([]);
		expect(untap.state.players[ALICE].life).toBe(20);
		expect(() => structuredClone(untap.state)).not.toThrow();

		const upkeep = await advanceWithReplay(untap.state, passingAgents);
		expect(turnLocation(upkeep.state)).toMatchObject({
			kind: "step",
			step: { kind: "upkeep" },
		});
		expect(upkeep.state.pendingTriggers).toEqual([]);
		expect(upkeep.state.stack).toEqual([]);
		expect(upkeep.state.players[ALICE].life).toBe(22);
	});
});
