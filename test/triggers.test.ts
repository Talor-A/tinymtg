import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "../agents.ts";
import { CARDS } from "../cards.ts";
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
	createEngine,
	defineCard,
	getSnapshot,
	isTurnStep,
	permanent,
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

const TEST_CARD_1 = defineCard({
	id: "test-self-death-pinger",
	name: "Test self-death pinger",
	types: ["creature"],
	colors: ["b"],
	manaCost: { b: 1 },
	power: 1,
	toughness: 1,
	keywords: ["deathtouch", "lifelink"],
	triggers: [
		{
			id: "self-death",
			text: "When this creature dies, it deals 2 damage to any target.",
			condition: {
				kind: "change zone",
				from: "battlefield",
				to: "graveyard",
				predicate: { kind: "self" },
			},
			targets: [
				{ id: "target-1", min: 1, max: 1, legal: { kind: "any-target" } },
			],
			effects: [
				{
					kind: "damage",
					subject: { kind: "target", slot: "target-1" },
					amount: 2,
				},
			],
		},
	],
});

const TEST_CARD_2 = defineCard({
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
				predicate: { kind: "self" },
			},
			targets: [],
			effects: [],
		},
	],
});

const TEST_CARD_3 = defineCard({
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
				predicate: { kind: "type", type: "creature" },
			},
			targets: [],
			effects: [],
		},
	],
});

const engine = createEngine([...CARDS, TEST_CARD_1, TEST_CARD_2, TEST_CARD_3]);

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
			triggeringZoneChangeResult: null,
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
		const state = engine.newGame();
		const agents: Agents = [new ScriptedAgent(), new ScriptedAgent()];
		// APNAP is meaningless without an active player, so run a real turn.
		beginFirstTurn(engine, state, agents);
		expect(activePlayer(state)).toBe(ALICE);

		const activeSource = engine.spawnPermanent(state, "grizzly-bears", ALICE);
		const nonactiveSource = engine.spawnPermanent(state, "grizzly-bears", BOB);

		// Deliberately enqueue in the opposite order from APNAP placement.
		queueTestTrigger(state, nonactiveSource.id, BOB, "nonactive trigger");
		queueTestTrigger(state, activeSource.id, ALICE, "active trigger");
		engine.settlePriority(state, agents);

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
		const checkpoint = engine.newGame();
		beginFirstTurn(engine, checkpoint, passingAgents());
		const first = engine.spawnPermanent(checkpoint, "grizzly-bears", ALICE);
		const second = engine.spawnPermanent(checkpoint, "eager-cadet", ALICE);
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
		const recorder = ChoiceController.record(engine, [
			orderingAgent,
			new ScriptedAgent(),
		]);
		engine.settlePriority(recordedState, recorder);

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
		const replay = ChoiceController.replay(engine, transcript);
		engine.settlePriority(replayedState, replay);
		replay.assertComplete();
		expect(replayedState).toEqual(recordedState);
	});

	test("the forced-copy fixture queues and resolves a copied ETB trigger from its characteristics", () => {
		const state = engine.newGame();
		const agents: Agents = [new ScriptedAgent(), new ScriptedAgent()];
		beginFirstTurn(engine, state, agents);
		engine.spawnPermanent(state, "arashin-cleric", ALICE);
		const clone = engine.spawnCard(state, "test-forced-copy", ALICE, "hand");

		const result = engine.perform(
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
			getSnapshot(engine.createReadContext(state), entered)
				.currentCharacteristics.name,
		).toBe("Arashin Cleric");
		expect(state.pendingTriggers).toHaveLength(1);
		expect(state.pendingTriggers[0]).toMatchObject({
			source: entered,
			triggerId: "arashin-cleric:0",
		});
		expect(() => structuredClone(state)).not.toThrow();

		engine.settlePriority(state, agents);
		expect(state.players[ALICE].life).toBe(23);
	});

	test("Arashin Cleric queues its ETB trigger and gains life on resolution", () => {
		const state = engine.newGame();
		const agents: Agents = [new ScriptedAgent(), new ScriptedAgent()];
		beginFirstTurn(engine, state, agents);
		const cleric = engine.spawnCard(state, "arashin-cleric", ALICE, "hand");

		const triggeringEvent = {
			kind: "change zone",
			object: cleric.id,
			from: "hand",
			destination: { zone: "battlefield", controller: ALICE },
			cause: "resolve",
		} satisfies GameEvent;
		engine.perform(state, triggeringEvent, agents);

		expect(state.players[ALICE].life, "trigger has not resolved yet").toBe(20);
		expect(state.pendingTriggers).toHaveLength(1);
		expect(state.pendingTriggers[0]?.source).not.toBe(cleric.id);
		expect(state.pendingTriggers[0]?.triggeringEvent).toBe(triggeringEvent);

		engine.settlePriority(state, agents);
		expect(state.players[ALICE].life).toBe(23);
		expect(state.pendingTriggers).toHaveLength(0);
		expect(state.stack).toHaveLength(0);
	});

	/** Enough library for both players to survive the turns a test advances. */
	function stockLibraries(state: GameState): void {
		for (const player of [ALICE, BOB]) {
			for (let i = 0; i < 3; i++)
				engine.spawnCard(state, "forest", player, "library");
		}
	}

	function atUpkeepOf(state: GameState, player: PlayerId): boolean {
		return isTurnStep(state, "upkeep") && activePlayer(state) === player;
	}

	test("Ajani's Mantra triggers only on its controller's upkeep", () => {
		const state = engine.newGame();
		const agents: Agents = [new ScriptedAgent(), new ScriptedAgent()];
		engine.spawnPermanent(state, "ajanis-mantra", ALICE);
		stockLibraries(state);

		// The scheduler emits the upkeep itself: no hand-built begin-step event.
		advanceUntil(engine, state, agents, (next) => atUpkeepOf(next, ALICE));
		expect(state.players[ALICE].life, "gains life on its own upkeep").toBe(21);

		advanceUntil(engine, state, agents, (next) => atUpkeepOf(next, BOB));
		expect(state.players[ALICE].life, "opponent's upkeep does nothing").toBe(
			21,
		);
		expect(state.pendingTriggers).toHaveLength(0);
	});

	test("Ajani's Mantra's controller may decline", () => {
		const state = engine.newGame();
		const agents: Agents = [
			new ScriptedAgent([], [false]),
			new ScriptedAgent(),
		];
		engine.spawnPermanent(state, "ajanis-mantra", ALICE);
		stockLibraries(state);

		advanceUntil(engine, state, agents, (next) => atUpkeepOf(next, ALICE));

		expect(state.players[ALICE].life).toBe(20);
	});

	test("a self-death trigger snapshots its old source and resolves targeted damage", () => {
		const state = engine.newGame();
		const alice = new ScriptedAgent();
		const bob = new ScriptedAgent();
		bob.targetChoices.push({ type: "player", player: ALICE });
		const agents: Agents = [alice, bob];
		beginFirstTurn(engine, state, agents);
		const source = engine.spawnPermanent(
			state,
			"test-self-death-pinger",
			ALICE,
		);
		permanent(state, source.id).controller = BOB;
		state.revision++;

		const triggeringEvent = {
			kind: "change zone",
			object: source.id,
			from: "battlefield",
			destination: { zone: "graveyard" },
			cause: "sacrifice",
		} satisfies GameEvent;
		const result = engine.perform(state, triggeringEvent, agents);

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
				deathtouch: true,
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
		expect(() => engine.settlePriority(state, [stoppingAlice, bob])).toThrow(
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
				deathtouch: true,
				lifelink: true,
			},
		});
		expect(() => structuredClone(state)).not.toThrow();

		engine.settlePriority(state, agents);
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

	test("departed sources retain deathtouch for noncombat damage", () => {
		const state = engine.newGame();
		const alice = new ScriptedAgent();
		const bob = new ScriptedAgent();
		const agents: Agents = [alice, bob];
		beginFirstTurn(engine, state, agents);
		const source = engine.spawnPermanent(
			state,
			"test-self-death-pinger",
			ALICE,
		);
		const target = engine.spawnPermanent(state, "grizzly-bears", BOB, {
			counters: { "+1/+1": 1 },
		});
		alice.targetChoices.push({ type: "permanent", id: target.id });

		engine.perform(
			state,
			{
				kind: "change zone",
				object: source.id,
				from: "battlefield",
				destination: { zone: "graveyard" },
				cause: "sacrifice",
			},
			agents,
		);
		engine.settlePriority(state, agents);

		expect(
			state.objects.has(target.id),
			"two damage from a departed deathtouch source destroys a 3/3",
		).toBe(false);
		expect(
			state.players[ALICE].life,
			"lifelink also uses last known info",
		).toBe(22);
	});

	test.each(["destroy", "state-based action"] as const)(
		"queues the self-death trigger through %s movement",
		(mechanism) => {
			const state = engine.newGame();
			const source = engine.spawnPermanent(
				state,
				"test-self-death-pinger",
				ALICE,
				mechanism === "state-based action"
					? { counters: { "-1/-1": 1 } }
					: undefined,
			);

			if (mechanism === "destroy") {
				engine.perform(
					state,
					{ kind: "destroy", object: source.id, noRegen: true },
					passingAgents(),
				);
			} else {
				engine.checkStateBasedActions(state, passingAgents());
			}

			expect(state.objects.has(source.id)).toBe(false);
			expect(state.pendingTriggers).toHaveLength(1);
			expect(state.pendingTriggers[0]?.source).toBe(source.id);
		},
	);

	test("a graveyard redirect does not queue the self-death trigger", () => {
		const state = engine.newGame();
		const agents: Agents = [new ScriptedAgent(), new ScriptedAgent()];
		engine.spawnPermanent(state, "samurai-of-the-pale-curtain", ALICE);
		const source = engine.spawnPermanent(
			state,
			"test-self-death-pinger",
			ALICE,
		);

		const result = engine.perform(
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

	test("keeps non-dies battlefield departures explicitly unsupported", () => {
		const state = engine.newGame();
		const source = engine.spawnPermanent(state, "test-broad-self-death", ALICE);

		expect(() =>
			engine.perform(
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
	});

	test("matches a dies predicate against another permanent's last-known characteristics", () => {
		const state = engine.newGame();
		const watcher = engine.spawnPermanent(state, "test-nonself-death", ALICE);
		const victim = engine.spawnPermanent(state, "grizzly-bears", BOB);

		engine.perform(
			state,
			{
				kind: "change zone",
				object: victim.id,
				from: "battlefield",
				destination: { zone: "graveyard" },
				cause: "destroy",
			},
			passingAgents(),
		);

		expect(state.pendingTriggers).toHaveLength(1);
		expect(state.pendingTriggers[0]).toMatchObject({
			source: watcher.id,
			triggerId: "test-nonself-death:0",
			controller: ALICE,
		});
	});

	test("a watcher dying in an SBA pass observes itself and every simultaneous death", () => {
		const state = engine.newGame();
		const watcher = engine.spawnPermanent(state, "test-nonself-death", ALICE);
		const victim = engine.spawnPermanent(state, "grizzly-bears", BOB);
		permanent(state, watcher.id).damage = 1;
		permanent(state, victim.id).damage = 2;

		engine.checkStateBasedActions(state, passingAgents());

		expect(state.objects.has(watcher.id)).toBe(false);
		expect(state.objects.has(victim.id)).toBe(false);
		expect(state.pendingTriggers).toHaveLength(2);
		expect(
			state.pendingTriggers.map((trigger) => ({
				source: trigger.source,
				triggerId: String(trigger.triggerId),
			})),
		).toEqual([
			{ source: watcher.id, triggerId: "test-nonself-death:0" },
			{ source: watcher.id, triggerId: "test-nonself-death:0" },
		]);
	});

	test("a trigger resolves after its source leaves", () => {
		const state = engine.newGame();
		const agents: Agents = [new ScriptedAgent(), new ScriptedAgent()];
		beginFirstTurn(engine, state, agents);
		const cleric = engine.spawnCard(state, "arashin-cleric", ALICE, "hand");
		const result = engine.perform(
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
		engine.perform(
			state,
			{ kind: "destroy", object: created(result), noRegen: true },
			agents,
		);
		engine.settlePriority(state, agents);
		expect(state.players[ALICE].life).toBe(23);
	});
});
