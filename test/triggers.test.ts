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
	createReadContext,
	isTurnStep,
	newGame,
	perform,
	readObject,
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

	test("Clone queues and resolves a copied ETB trigger from its characteristics", () => {
		const state = newGame();
		const agents: Agents = [new ScriptedAgent(), new ScriptedAgent()];
		beginFirstTurn(state, agents);
		spawnPermanent(state, "arashin-cleric", ALICE);
		const clone = spawnCard(state, "clone", ALICE, "hand");

		const result = perform(
			state,
			{
				kind: "change zone",
				object: clone.id,
				from: "hand",
				to: "battlefield",
				cause: "resolve",
				toController: ALICE,
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
			to: "battlefield",
			cause: "resolve",
			toController: ALICE,
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
				to: "battlefield",
				cause: "resolve",
				toController: ALICE,
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
