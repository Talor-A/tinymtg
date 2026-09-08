import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "../agents.ts";
import "../cards.ts"; // side effect: registers the card database
import type {
	SyncAgent as Agent,
	ChoiceRequest,
	GameEvent,
	GameState,
	ObjectId,
	PlayerId,
} from "../index.ts";
import {
	abilityId,
	activePlayer,
	ChoiceController,
	checkStateBasedActions,
	createReadContext,
	isTurnStep,
	newGame,
	perform,
	permanent,
	readObject,
	registerCard,
	settlePriority,
	spawnCard,
	spawnPermanent,
} from "../index.ts";
import {
	type SyncAgents as Agents,
	ALICE,
	advanceUntil,
	BOB,
	beginFirstTurn,
	created,
	passingAgents,
} from "./utils/engine-helpers.ts";

registerCard({
	id: "test-self-death-pinger",
	name: "Test self-death pinger",
	types: ["creature"],
	colors: ["b"],
	manaCost: { b: 1 },
	power: 1,
	toughness: 1,
	keywords: ["lifelink"],
	triggers: [
		{
			id: "self-death",
			text: "When this creature dies, it deals 2 damage to any target.",
			condition: {
				kind: "change zone",
				from: "battlefield",
				to: "graveyard",
				selector: { kind: "self" },
			},
			targets: [
				{ id: "target-1", min: 1, max: 1, legal: { kind: "any-target" } },
			],
			effects: [{ kind: "damage", recipient: { targetSlot: "target-1" }, amount: 2 }],
		},
	],
});

registerCard({
	id: "test-broad-self-death",
	name: "Test broad self-death",
	types: ["creature"],
	colors: [],
	manaCost: "zero",
	power: 1,
	toughness: 1,
	triggers: [
		{
			id: "broad-self-death",
			text: "Unsupported broad battlefield-origin trigger.",
			condition: {
				kind: "change zone",
				from: "battlefield",
				to: "any",
				selector: { kind: "self" },
			},
			targets: [],
			effects: [],
		},
	],
});

registerCard({
	id: "test-nonself-death",
	name: "Test nonself death",
	types: ["creature"],
	colors: [],
	manaCost: "zero",
	power: 1,
	toughness: 1,
	triggers: [
		{
			id: "nonself-death",
			text: "Unsupported non-self battlefield-origin trigger.",
			condition: {
				kind: "change zone",
				from: "battlefield",
				to: "graveyard",
				selector: { kind: "type", type: "creature" },
			},
			targets: [],
			effects: [],
		},
	],
});

describe("triggered abilities", () => {
	function queueTestTrigger(
		state: GameState,
		source: ObjectId,
		controller: PlayerId,
		text: string,
	): void {
		state.pendingTriggers.push({
			source,
			triggerId: abilityId("triggered", "test-trigger", 0),
			controller,
			text,
			triggeringEvent: {
				kind: "gain life",
				player: controller,
				amount: 1,
			},
			targetDefinitions: [],
			effects: [],
			sourceLastKnown: null,
		});
	}

	test("puts active-player triggers below nonactive-player triggers", () => {
		const state = newGame();
		const agents: Agents = [new ScriptedAgent(), new ScriptedAgent()];
		// APNAP is meaningless without an active player, so run a real turn.
		beginFirstTurn(state, agents);
		expect(activePlayer(state)).toBe(ALICE);

		const activeSource = spawnPermanent(state, "grizzly-bears", ALICE);
		const nonactiveSource = spawnPermanent(state, "grizzly-bears", BOB);

		// Deliberately enqueue in the opposite order from APNAP placement.
		queueTestTrigger(state, nonactiveSource.id, BOB, "nonactive trigger");
		queueTestTrigger(state, activeSource.id, ALICE, "active trigger");
		settlePriority(state, agents);

		expect(state.log.filter((line) => line.includes("[stack]"))).toEqual([
			"  [stack] active trigger",
			"  [stack] nonactive trigger",
		]);
		expect(state.log.filter((line) => line.includes("[resolve]"))).toEqual([
			"  [resolve] nonactive trigger",
			"  [resolve] active trigger",
		]);
	});

	test("records and replays a controller's chosen trigger order", () => {
		const checkpoint = newGame();
		beginFirstTurn(checkpoint, passingAgents());
		const first = spawnPermanent(checkpoint, "grizzly-bears", ALICE);
		const second = spawnPermanent(checkpoint, "eager-cadet", ALICE);
		queueTestTrigger(checkpoint, first.id, ALICE, "first trigger");
		queueTestTrigger(checkpoint, second.id, ALICE, "second trigger");

		let orderRequest:
			| Extract<ChoiceRequest, { kind: "triggerOrder" }>
			| undefined;
		const orderingAgent: Agent = {
			choose(_state, request) {
				if (request.kind === "triggerOrder") {
					orderRequest = request;
					return {
						optionIds: request.options.map((option) => option.id).reverse(),
					};
				}
				const firstOption = request.options[0];
				if (!firstOption) throw new Error("expected a choice option");
				return { optionId: firstOption.id };
			},
		};
		const recordedState = structuredClone(checkpoint);
		const recorder = ChoiceController.record([
			orderingAgent,
			new ScriptedAgent(),
		]);
		settlePriority(recordedState, recorder);

		const transcript = JSON.parse(
			JSON.stringify(recorder.transcript()),
		) as ReturnType<ChoiceController["transcript"]>;
		expect(orderRequest?.player).toBe(ALICE);
		expect(
			orderRequest?.context.triggers.map((trigger) => trigger.text),
		).toEqual(["first trigger", "second trigger"]);
		expect(transcript.choices[0]?.request.kind).toBe("triggerOrder");
		expect(
			recordedState.log.filter((line) => line.includes("[stack]")),
		).toEqual(["  [stack] second trigger", "  [stack] first trigger"]);

		const replayedState = structuredClone(checkpoint);
		const replay = ChoiceController.replay(transcript);
		settlePriority(replayedState, replay);
		replay.assertComplete();
		expect(replayedState).toEqual(recordedState);
	});

	test("the forced-copy fixture queues and resolves a copied ETB trigger from its characteristics", () => {
		const state = newGame();
		const agents: Agents = [new ScriptedAgent(), new ScriptedAgent()];
		beginFirstTurn(state, agents);
		spawnPermanent(state, "arashin-cleric", ALICE);
		const clone = spawnCard(state, "test-forced-copy", ALICE, "hand");

		const result = perform(
			state,
			{
				kind: "change zone",
				object: clone.id,
				from: "hand",
				destination: { zone: "battlefield", controller: ALICE },
				cause: "resolve",
			},
			agents,
		);

		const entered = created(result);
		expect(
			readObject(createReadContext(state), entered).currentCharacteristics.name,
		).toBe("Arashin Cleric");
		expect(state.pendingTriggers).toHaveLength(1);
		expect(state.pendingTriggers[0]).toMatchObject({
			source: entered,
			triggerId: "arashin-cleric:0",
		});
		expect(() => structuredClone(state)).not.toThrow();

		settlePriority(state, agents);
		expect(state.players[ALICE].life).toBe(23);
	});

	test("Arashin Cleric queues its ETB trigger and gains life on resolution", () => {
		const state = newGame();
		const agents: Agents = [new ScriptedAgent(), new ScriptedAgent()];
		beginFirstTurn(state, agents);
		const cleric = spawnCard(state, "arashin-cleric", ALICE, "hand");

		const triggeringEvent = {
			kind: "change zone",
			object: cleric.id,
			from: "hand",
			destination: { zone: "battlefield", controller: ALICE },
			cause: "resolve",
		} satisfies GameEvent;
		perform(state, triggeringEvent, agents);

		expect(state.players[ALICE].life, "trigger has not resolved yet").toBe(20);
		expect(state.pendingTriggers).toHaveLength(1);
		expect(state.pendingTriggers[0]?.source).not.toBe(cleric.id);
		expect(state.pendingTriggers[0]?.triggeringEvent).toBe(triggeringEvent);

		settlePriority(state, agents);
		expect(state.players[ALICE].life).toBe(23);
		expect(state.pendingTriggers).toHaveLength(0);
		expect(state.stack).toHaveLength(0);
	});

	/** Enough library for both players to survive the turns a test advances. */
	function stockLibraries(state: GameState): void {
		for (const player of [ALICE, BOB]) {
			for (let i = 0; i < 3; i++) spawnCard(state, "forest", player, "library");
		}
	}

	function atUpkeepOf(state: GameState, player: PlayerId): boolean {
		return isTurnStep(state, "upkeep") && activePlayer(state) === player;
	}

	test("Ajani's Mantra triggers only on its controller's upkeep", () => {
		const state = newGame();
		const agents: Agents = [new ScriptedAgent(), new ScriptedAgent()];
		spawnPermanent(state, "ajanis-mantra", ALICE);
		stockLibraries(state);

		// The scheduler emits the upkeep itself: no hand-built begin-step event.
		advanceUntil(state, agents, (next) => atUpkeepOf(next, ALICE));
		expect(state.players[ALICE].life, "gains life on its own upkeep").toBe(21);

		advanceUntil(state, agents, (next) => atUpkeepOf(next, BOB));
		expect(state.players[ALICE].life, "opponent's upkeep does nothing").toBe(
			21,
		);
		expect(state.pendingTriggers).toHaveLength(0);
	});

	test("Ajani's Mantra's controller may decline", () => {
		const state = newGame();
		const agents: Agents = [
			new ScriptedAgent([], [false]),
			new ScriptedAgent(),
		];
		spawnPermanent(state, "ajanis-mantra", ALICE);
		stockLibraries(state);

		advanceUntil(state, agents, (next) => atUpkeepOf(next, ALICE));

		expect(state.players[ALICE].life).toBe(20);
	});

	test("a self-death trigger snapshots its old source and resolves targeted damage", () => {
		const state = newGame();
		const alice = new ScriptedAgent();
		const bob = new ScriptedAgent();
		bob.targetChoices.push({ type: "player", player: ALICE });
		const agents: Agents = [alice, bob];
		beginFirstTurn(state, agents);
		const source = spawnPermanent(state, "test-self-death-pinger", ALICE);
		permanent(state, source.id).controller = BOB;
		state.revision++;

		const triggeringEvent = {
			kind: "change zone",
			object: source.id,
			from: "battlefield",
			destination: { zone: "graveyard" },
			cause: "sacrifice",
		} satisfies GameEvent;
		const result = perform(state, triggeringEvent, agents);

		expect(state.objects.has(source.id), "the old object is gone").toBe(false);
		expect(created(result), "the graveyard object has a new ID").not.toBe(
			source.id,
		);
		expect(state.pendingTriggers).toHaveLength(1);
		expect(state.pendingTriggers[0]).toMatchObject({
			source: source.id,
			controller: BOB,
			triggerId: "test-self-death-pinger:0",
			sourceLastKnown: {
				controller: BOB,
				colors: ["b"],
				lifelink: true,
			},
		});
		expect(state.pendingTriggers[0]?.triggeringEvent).toBe(triggeringEvent);
		expect(() => structuredClone(state)).not.toThrow();

		const stopAfterStacking = new Error("stop after stacking");
		const stoppingAlice: Agent = {
			choose(view, request) {
				if (request.kind === "priorityAction") throw stopAfterStacking;
				return alice.choose(view, request);
			},
		};
		expect(() => settlePriority(state, [stoppingAlice, bob])).toThrow(
			stopAfterStacking,
		);
		expect(state.stack).toHaveLength(1);
		expect(state.stack[0]).toMatchObject({
			kind: "triggered ability",
			source: source.id,
			controller: BOB,
			sourceLastKnown: {
				controller: BOB,
				colors: ["b"],
				lifelink: true,
			},
		});
		expect(() => structuredClone(state)).not.toThrow();

		settlePriority(state, agents);
		expect(state.players[ALICE].life, "the departed source dealt damage").toBe(
			18,
		);
		expect(
			state.players[BOB].life,
			"lifelink uses the source controller immediately before departure",
		).toBe(22);
		expect(state.pendingTriggers).toHaveLength(0);
		expect(state.stack).toHaveLength(0);
	});

	test.each(["destroy", "state-based action"] as const)(
		"queues the self-death trigger through %s movement",
		(mechanism) => {
			const state = newGame();
			const source = spawnPermanent(
				state,
				"test-self-death-pinger",
				ALICE,
				mechanism === "state-based action"
					? { counters: { "-1/-1": 1 } }
					: undefined,
			);

			if (mechanism === "destroy") {
				perform(
					state,
					{ kind: "destroy", object: source.id, noRegen: true },
					passingAgents(),
				);
			} else {
				checkStateBasedActions(state, passingAgents());
			}

			expect(state.objects.has(source.id)).toBe(false);
			expect(state.pendingTriggers).toHaveLength(1);
			expect(state.pendingTriggers[0]?.source).toBe(source.id);
		},
	);

	test("a graveyard redirect does not queue the self-death trigger", () => {
		const state = newGame();
		const agents: Agents = [new ScriptedAgent(), new ScriptedAgent()];
		spawnPermanent(state, "baby-rest-in-peace", ALICE);
		const source = spawnPermanent(state, "test-self-death-pinger", ALICE);

		const result = perform(
			state,
			{
				kind: "change zone",
				object: source.id,
				from: "battlefield",
				destination: { zone: "graveyard" },
				cause: "destroy",
			},
			agents,
		);

		expect(result.executed).toHaveLength(1);
		expect(result.executed[0]).toMatchObject({
			kind: "change zone",
			from: "battlefield",
			destination: { zone: "exile" },
		});
		expect(state.pendingTriggers).toHaveLength(0);
	});

	test.each(["test-broad-self-death", "test-nonself-death"])(
		"keeps %s as an explicit unsupported leaves trigger",
		(cardId) => {
			const state = newGame();
			const source = spawnPermanent(state, cardId, ALICE);

			expect(() =>
				perform(
					state,
					{
						kind: "change zone",
						object: source.id,
						from: "battlefield",
						destination: { zone: "graveyard" },
						cause: "destroy",
					},
					passingAgents(),
				),
			).toThrow("leaves the battlefield triggers are not supported");
		},
	);

	test("a trigger resolves after its source leaves", () => {
		const state = newGame();
		const agents: Agents = [new ScriptedAgent(), new ScriptedAgent()];
		beginFirstTurn(state, agents);
		const cleric = spawnCard(state, "arashin-cleric", ALICE, "hand");
		const result = perform(
			state,
			{
				kind: "change zone",
				object: cleric.id,
				from: "hand",
				destination: { zone: "battlefield", controller: ALICE },
				cause: "resolve",
			},
			agents,
		);
		perform(
			state,
			{ kind: "destroy", object: created(result), noRegen: true },
			agents,
		);
		settlePriority(state, agents);
		expect(state.players[ALICE].life).toBe(23);
	});
});
