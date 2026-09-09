import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "../agents.ts";
import "../cards.ts";
import { blockAssignmentOptionId, priorityOptionId } from "../choices.ts";
import {
	type Agent,
	abilityId,
	advance,
	advanceWithReplay,
	buildPlayerView,
	type ChoiceAnswer,
	ChoiceController,
	ChoicePendingError,
	ChoiceReplayMismatchError,
	type ChoiceRequest,
	type GameState,
	InvalidChoiceAnswerError,
	isTurnStep,
	newGame,
	type ObjectId,
	type PhaseId,
	type PlayerView,
	perform,
	type StackItemId,
	type StepId,
	type SyncAgent,
	spawnCard,
	spawnPermanent,
	spawnToken,
	startGame,
	type TurnId,
} from "../index.ts";
import { registerCardFixture } from "./utils/engine-helpers.ts";

registerCardFixture("f/flying_men");

function agents(first = new ScriptedAgent()): [SyncAgent, SyncAgent] {
	return [first, new ScriptedAgent()];
}

describe("ScriptedAgent priority actions", () => {
	test("keeps a scripted action queued until its exact option is available", () => {
		const action = { kind: "play land", card: 42 as ObjectId } as const;
		const agent = new ScriptedAgent([], [], [action]);
		const base = {
			version: 1 as const,
			ordinal: 0,
			fingerprint: "test",
			player: 0 as const,
			context: { activePlayer: 0 as const, location: null },
		};

		expect(
			agent.choose(buildPlayerView(newGame(), 0), {
				...base,
				kind: "priorityAction",
				id: "before",
				options: [{ id: "pass", label: "pass" }],
			}),
		).toEqual({ optionId: "pass" });
		expect(agent.priorityActions).toEqual([action]);

		const actionOptionId = priorityOptionId(action);
		expect(
			agent.choose(buildPlayerView(newGame(), 0), {
				...base,
				kind: "priorityAction",
				id: "available",
				options: [
					{ id: "pass", label: "pass" },
					{ id: actionOptionId, label: "wording does not matter" },
				],
			}),
		).toEqual({ optionId: actionOptionId });
		expect(agent.priorityActions).toEqual([]);
	});
});

describe("choice transcripts", () => {
	test("object choices filter a mixed object set with a selector", () => {
		const state = newGame();
		const land = spawnCard(state, "forest", 0, "hand");
		const card = spawnCard(state, "flying-men", 0, "hand");
		const permanent = spawnPermanent(state, "grizzly-bears", 0);
		const choosing: SyncAgent = {
			choose(_view, request) {
				if (request.kind !== "object")
					throw new Error(`unexpected ${request.kind} choice`);
				return { optionId: String(permanent.id) };
			},
		};
		const recorder = ChoiceController.record([choosing, new ScriptedAgent()]);

		expect(
			recorder.chooseObject(state, 0, {
				reason: { kind: "select", prompt: "Choose a creature" },
				objects: [land.id, card.id, permanent.id],
				selector: {
					definition: { kind: "type", type: "creature" },
					context: { controller: 0, source: null },
				},
			}),
		).toBe(permanent.id);
		expect(recorder.transcript().choices[0]?.request.options).toEqual([
			{ id: String(card.id), label: `Flying Men#${card.id}` },
			{ id: String(permanent.id), label: `Grizzly Bears#${permanent.id}` },
		]);
	});

	test("token display names label replay choices without becoming card IDs", () => {
		let seen: ChoiceRequest | undefined;
		const agent: SyncAgent = {
			choose(_state, request) {
				seen = request;
				return { optionIds: [request.options[0]?.id ?? ""] };
			},
		};
		const state = newGame();
		const token = spawnToken(state, 0, {
			kind: "creature",
			name: "Unregistered Replay Bear",
			manaCost: "zero",
			colors: [],
			supertypes: [],
			types: ["creature"],
			subtypes: ["Bear"],
			keywords: [],
			abilities: {
				static: [],
				activated: [],
				triggered: [],
				replacement: [],
				prohibition: [],
			},
			power: 2,
			toughness: 2,
		});
		const recorder = ChoiceController.record([agent, agent]);

		expect(recorder.chooseAttackers(state, 0, [token.id])).toEqual([token.id]);
		expect(seen?.options[0]?.label).toBe(
			`Unregistered Replay Bear#${token.id}`,
		);
		const transcript = structuredClone(recorder.transcript());
		const replay = ChoiceController.replay(transcript);
		expect(replay.chooseAttackers(state, 0, [token.id])).toEqual([token.id]);
		replay.assertComplete();
	});

	test("agents receive one player view and one serializable request", () => {
		const seen: { view?: PlayerView; request?: ChoiceRequest } = {};
		const agent: SyncAgent = {
			choose(view, request) {
				seen.view = view;
				seen.request = request;
				const option = request.options[0];
				if (!option) throw new Error("expected an option");
				return { optionId: option.id };
			},
		};
		const state = newGame();
		spawnPermanent(state, "hardened-scales", 0);
		spawnPermanent(state, "doubling-season", 0);
		const creature = spawnPermanent(state, "grizzly-bears", 0);

		perform(
			state,
			{
				kind: "add counters",
				target: { type: "permanent", id: creature.id },
				counter: "+1/+1",
				amount: 1,
			},
			[agent, agent],
		);

		expect(seen.request?.kind).toBe("replacement");
		expect(seen.view?.viewer).toBe(0);
		expect(seen.view?.battlefield).toHaveLength(3);
		expect(() => JSON.stringify(seen.view)).not.toThrow();
		expect(() => JSON.stringify(seen.request)).not.toThrow();
	});

	test("suspends synchronously when an agent returns a promise", async () => {
		let resolveAnswer: ((answer: ChoiceAnswer) => void) | undefined;
		const pending = new Promise<ChoiceAnswer>((resolve) => {
			resolveAnswer = resolve;
		});
		const agent: Agent = { choose: () => pending };
		const state = newGame();
		spawnPermanent(state, "hardened-scales", 0);
		spawnPermanent(state, "doubling-season", 0);
		const creature = spawnPermanent(state, "grizzly-bears", 0);
		const choices = ChoiceController.suspending([agent, agent]);

		let suspension: ChoicePendingError | undefined;
		try {
			choices.chooseReplacement(
				state,
				0,
				{
					kind: "add counters",
					target: { type: "permanent", id: creature.id },
					counter: "+1/+1",
					amount: 1,
				},
				[
					{
						id: "test:one" as never,
						def: {
							label: "one",
							text: "one",
							layer: "other",
							applies: () => true,
							replace: (event) => [event],
						},
						source: null,
						controller: 0,
						data: {},
						label: "one",
					},
				],
			);
		} catch (error) {
			if (!(error instanceof ChoicePendingError)) throw error;
			suspension = error;
		}

		expect(suspension?.request.kind).toBe("replacement");
		expect(choices.transcript().choices).toHaveLength(0);
		const option = suspension?.request.options[0];
		if (!option || !resolveAnswer || !suspension) {
			throw new Error("expected a pending choice");
		}
		resolveAnswer({ optionId: option.id });
		const answer = await suspension.answer;
		choices.recordAnswer(suspension.request, answer);
		expect(choices.transcript().choices).toHaveLength(1);
	});

	test("advanceWithReplay completes synchronous agents in one attempt", async () => {
		const checkpoint = newGame();
		spawnPermanent(checkpoint, "ajanis-mantra", 0);
		startGame(checkpoint, agents());
		const snapshot = structuredClone(checkpoint);

		const result = await advanceWithReplay(checkpoint, agents());

		expect(result.attempts).toBe(1);
		expect(result.transcript.choices.length).toBeGreaterThan(0);
		expect(
			result.transcript.choices.some(
				(choice) => choice.request.kind === "optional",
			),
		).toBe(true);
		expect(result.state.players[0].life).toBe(21);
		expect(checkpoint).toEqual(snapshot);
	});

	test("advanceWithReplay rewinds one transition around an async choice", async () => {
		const checkpoint = newGame();
		spawnPermanent(checkpoint, "ajanis-mantra", 0);
		const setupAgents = agents();
		startGame(checkpoint, setupAgents);
		const snapshot = structuredClone(checkpoint);

		let priorityCalls = 0;
		let optionalCalls = 0;
		const hybrid: Agent = {
			choose(_state, request) {
				const option = request.options[0];
				if (!option) throw new Error("expected an option");
				if (request.kind === "optional") {
					optionalCalls++;
					return Promise.resolve({ optionId: "yes" });
				}
				if (request.kind === "priorityAction") priorityCalls++;
				return { optionId: option.id };
			},
		};

		const result = await advanceWithReplay(checkpoint, [hybrid, hybrid]);

		expect(result.attempts).toBe(2);
		expect(optionalCalls).toBe(1);
		expect(priorityCalls).toBe(
			result.transcript.choices.filter(
				(choice) => choice.request.kind === "priorityAction",
			).length,
		);
		expect(
			result.transcript.choices.map((choice) => choice.request.kind),
		).toEqual([
			// Both players pass, the trigger resolves (asking the optional), and
			// CR 117.3b re-opens the round: the active player gets priority again.
			"priorityAction",
			"priorityAction",
			"optional",
			"priorityAction",
			"priorityAction",
		]);
		expect(result.state.players[0].life).toBe(21);
		expect(checkpoint).toEqual(snapshot);

		const expected = structuredClone(checkpoint);
		advance(expected, agents());
		expect(result.state).toEqual(expected);
	});

	test("advanceWithReplay propagates async rejection without mutating checkpoint", async () => {
		const checkpoint = newGame();
		spawnPermanent(checkpoint, "ajanis-mantra", 0);
		const setupAgents = agents();
		startGame(checkpoint, setupAgents);
		const snapshot = structuredClone(checkpoint);
		const failure = new Error("agent unavailable");
		const rejecting: Agent = {
			choose(_state, request) {
				const option = request.options[0];
				if (!option) throw new Error("expected an option");
				return request.kind === "optional"
					? Promise.reject(failure)
					: { optionId: option.id };
			},
		};

		expect(advanceWithReplay(checkpoint, [rejecting, rejecting])).rejects.toBe(
			failure,
		);
		expect(checkpoint).toEqual(snapshot);
	});

	test("replays multiple pending cleanup choices", async () => {
		const checkpoint = newGame();
		for (let i = 0; i < 10; i++) {
			spawnCard(checkpoint, "forest", 0, "hand");
			spawnCard(checkpoint, "forest", 0, "library");
			spawnCard(checkpoint, "forest", 1, "library");
		}
		while (!isTurnStep(checkpoint, "end")) {
			advance(checkpoint, agents());
		}
		const snapshot = structuredClone(checkpoint);
		let calls = 0;
		const asyncLast: Agent = {
			choose(_state, request) {
				const option = request.options.at(-1);
				if (!option) throw new Error("expected an option");
				const discarding =
					request.kind === "object" &&
					request.context.reason.kind === "discard";
				if (discarding) calls++;
				return discarding
					? Promise.resolve({ optionId: option.id })
					: { optionId: request.options[0]?.id ?? "" };
			},
		};

		const result = await advanceWithReplay(checkpoint, [asyncLast, asyncLast]);

		expect(result.attempts).toBe(5);
		expect(calls).toBe(4);
		expect(
			result.transcript.choices.filter(
				(choice) =>
					choice.request.kind === "object" &&
					choice.request.context.reason.kind === "discard",
			),
		).toHaveLength(4);
		expect(result.state.players[0].hand).toHaveLength(7);
		expect(result.state.players[0].graveyard).toHaveLength(4);
		expect(checkpoint).toEqual(snapshot);
	});

	test("rejects an invalid fulfilled answer without mutating the checkpoint", async () => {
		const checkpoint = newGame();
		spawnPermanent(checkpoint, "ajanis-mantra", 0);
		startGame(checkpoint, agents());
		const snapshot = structuredClone(checkpoint);
		const invalid: Agent = {
			choose: () => Promise.resolve({ optionId: "not-an-option" }),
		};

		expect(
			advanceWithReplay(checkpoint, [invalid, invalid]),
		).rejects.toBeInstanceOf(InvalidChoiceAnswerError);
		expect(checkpoint).toEqual(snapshot);
	});

	test("rejects answers that do not match the pending request", async () => {
		const agent: Agent = {
			choose: () => Promise.resolve({ optionId: "yes" }),
		};
		const choices = ChoiceController.suspending([agent, agent]);
		const state = newGame();
		let pending: ChoicePendingError | undefined;
		try {
			choices.chooseOptional(state, {
				id: 1 as StackItemId,
				kind: "triggered ability",
				source: 1 as ObjectId,
				triggerId: abilityId("triggered", "ajanis-mantra", 0),
				controller: 0,
				triggeringEvent: {
					kind: "begin step",
					turnId: 0 as TurnId,
					phaseId: 0 as PhaseId,
					stepId: 0 as StepId,
					player: 0,
					step: "upkeep",
				},
				targetDefinitions: [],
				targets: [],
				sourceLastKnown: null,
				text: "gain 1 life",
				effects: [
					{
						kind: "may",
						decider: "you",
						effects: [{ kind: "gain-life", player: "you", amount: 1 }],
					},
				],
			});
		} catch (error) {
			if (!(error instanceof ChoicePendingError)) throw error;
			pending = error;
		}
		if (!pending) throw new Error("expected pending choice");
		const forged = { ...pending.request, id: `forged:${pending.request.id}` };

		expect(() => choices.recordAnswer(forged, { optionId: "yes" })).toThrow(
			ChoiceReplayMismatchError,
		);
	});

	test("records synchronous choices and replays without agents", () => {
		const checkpoint = newGame();
		spawnPermanent(checkpoint, "hardened-scales", 0);
		spawnPermanent(checkpoint, "doubling-season", 0);
		const creature = spawnPermanent(checkpoint, "grizzly-bears", 0);
		const event = {
			kind: "add counters" as const,
			target: { type: "permanent" as const, id: creature.id },
			counter: "+1/+1" as const,
			amount: 1,
		};

		const recordedState = structuredClone(checkpoint);
		const recorder = ChoiceController.record(
			agents(new ScriptedAgent(["doubling season"])),
		);
		perform(recordedState, event, recorder);
		const transcript = recorder.transcript();

		expect(transcript.choices.length).toBeGreaterThan(0);
		expect(transcript.choices[0]?.request.kind).toBe("replacement");

		const replayedState = structuredClone(checkpoint);
		const replay = ChoiceController.replay(transcript);
		perform(replayedState, event, replay);
		replay.assertComplete();

		expect(replayedState).toEqual(recordedState);
	});

	test("fails when replay needs a choice the transcript does not contain", () => {
		const state = newGame();
		const choices = ChoiceController.replay({ version: 1, choices: [] });

		expect(() =>
			choices.chooseOptional(state, {
				id: 99 as StackItemId,
				kind: "triggered ability",
				source: 1 as ObjectId,
				triggerId: abilityId("triggered", "ajanis-mantra", 0),
				controller: 0,
				triggeringEvent: {
					kind: "begin step",
					turnId: 0 as TurnId,
					phaseId: 0 as PhaseId,
					stepId: 0 as StepId,
					player: 0,
					step: "upkeep",
				},
				targetDefinitions: [],
				targets: [],
				sourceLastKnown: null,
				text: "gain 1 life",
				effects: [
					{
						kind: "may",
						decider: "you",
						effects: [{ kind: "gain-life", player: "you", amount: 1 }],
					},
				],
			}),
		).toThrow(ChoiceReplayMismatchError);
	});

	test("rejects a transcript when the request changes", () => {
		const checkpoint = newGame();
		spawnPermanent(checkpoint, "hardened-scales", 0);
		spawnPermanent(checkpoint, "doubling-season", 0);
		const creature = spawnPermanent(checkpoint, "grizzly-bears", 0);
		const recorder = ChoiceController.record(agents());
		perform(
			structuredClone(checkpoint),
			{
				kind: "add counters",
				target: { type: "permanent", id: creature.id },
				counter: "+1/+1",
				amount: 1,
			},
			recorder,
		);

		const replay = ChoiceController.replay(recorder.transcript());
		expect(() =>
			perform(
				structuredClone(checkpoint),
				{
					kind: "add counters",
					target: { type: "permanent", id: creature.id },
					counter: "+1/+1",
					amount: 2,
				},
				replay,
			),
		).toThrow(ChoiceReplayMismatchError);
	});
});

describe("chooseAttackers", () => {
	function eligibleCreatures(state: GameState): [ObjectId, ObjectId, ObjectId] {
		const a = spawnPermanent(state, "grizzly-bears", 0).id;
		const b = spawnPermanent(state, "grizzly-bears", 0).id;
		const c = spawnPermanent(state, "grizzly-bears", 0).id;
		return [a, b, c];
	}

	test("empty eligible list returns [] with no request", () => {
		const state = newGame();
		const recorder = ChoiceController.record(agents());
		const result = recorder.chooseAttackers(state, 0, []);
		expect(result).toEqual([]);
		expect(recorder.transcript().choices).toHaveLength(0);
	});

	test("selecting no attackers", () => {
		const state = newGame();
		const [a, b, c] = eligibleCreatures(state);
		const agent: Agent = { choose: () => ({ optionIds: [] }) };
		const recorder = ChoiceController.record([
			agent as SyncAgent,
			agent as SyncAgent,
		]);
		const result = recorder.chooseAttackers(state, 0, [a, b, c]);
		expect(result).toEqual([]);
		expect(recorder.transcript().choices).toHaveLength(1);
		expect(recorder.transcript().choices[0]?.request.kind).toBe(
			"declareAttackers",
		);
	});

	test("selecting multiple attackers", () => {
		const state = newGame();
		const [a, b, c] = eligibleCreatures(state);
		const agent: Agent = {
			choose: (_state, request) => ({
				optionIds: [String(a), String(c)].filter((id) =>
					request.options.some((option) => option.id === id),
				),
			}),
		};
		const recorder = ChoiceController.record([
			agent as SyncAgent,
			agent as SyncAgent,
		]);
		const result = recorder.chooseAttackers(state, 0, [a, b, c]);
		expect(result).toEqual([a, c]);
	});

	test("reverse-order answer normalizes result and transcript to request order", () => {
		const state = newGame();
		const [a, b, c] = eligibleCreatures(state);
		const agent: Agent = {
			choose: () => ({ optionIds: [String(c), String(a)] }),
		};
		const recorder = ChoiceController.record([
			agent as SyncAgent,
			agent as SyncAgent,
		]);
		const result = recorder.chooseAttackers(state, 0, [a, b, c]);
		expect(result).toEqual([a, c]);
		const recordedAnswer = recorder.transcript().choices[0]?.answer;
		expect(recordedAnswer).toEqual({ optionIds: [String(a), String(c)] });
	});

	test("duplicate, unknown, and wrong-shape answers throw InvalidChoiceAnswerError", () => {
		const state = newGame();
		const [a, b, c] = eligibleCreatures(state);

		const duplicate: Agent = {
			choose: () => ({ optionIds: [String(a), String(a)] }),
		};
		expect(() =>
			ChoiceController.record([
				duplicate as SyncAgent,
				duplicate as SyncAgent,
			]).chooseAttackers(state, 0, [a, b, c]),
		).toThrow(InvalidChoiceAnswerError);

		const unknown: Agent = {
			choose: () => ({ optionIds: ["999999"] }),
		};
		expect(() =>
			ChoiceController.record([
				unknown as SyncAgent,
				unknown as SyncAgent,
			]).chooseAttackers(state, 0, [a, b, c]),
		).toThrow(InvalidChoiceAnswerError);

		const wrongShape: Agent = {
			choose: () => ({ optionId: String(a) }) as unknown as ChoiceAnswer,
		};
		expect(() =>
			ChoiceController.record([
				wrongShape as SyncAgent,
				wrongShape as SyncAgent,
			]).chooseAttackers(state, 0, [a, b, c]),
		).toThrow(InvalidChoiceAnswerError);
	});

	test("JSON round trip and replay reproduce IDs", () => {
		const state = newGame();
		const [a, b, c] = eligibleCreatures(state);
		const agent: Agent = {
			choose: () => ({ optionIds: [String(b)] }),
		};
		const recorder = ChoiceController.record([
			agent as SyncAgent,
			agent as SyncAgent,
		]);
		const result = recorder.chooseAttackers(state, 0, [a, b, c]);
		expect(result).toEqual([b]);

		const transcript = JSON.parse(JSON.stringify(recorder.transcript()));
		const replay = ChoiceController.replay(transcript);
		const replayedResult = replay.chooseAttackers(state, 0, [a, b, c]);
		replay.assertComplete();
		expect(replayedResult).toEqual([b]);
	});

	test("promise answer throws ChoicePendingError; recordAnswer normalizes and replay consumes exactly once", async () => {
		const state = newGame();
		const [a, b, c] = eligibleCreatures(state);
		let resolveAnswer: ((answer: ChoiceAnswer) => void) | undefined;
		const pending = new Promise<ChoiceAnswer>((resolve) => {
			resolveAnswer = resolve;
		});
		const agent: Agent = { choose: () => pending };
		const choices = ChoiceController.suspending([agent, agent]);

		let suspension: ChoicePendingError | undefined;
		try {
			choices.chooseAttackers(state, 0, [a, b, c]);
		} catch (error) {
			if (!(error instanceof ChoicePendingError)) throw error;
			suspension = error;
		}
		if (!suspension || !resolveAnswer) {
			throw new Error("expected a pending choice");
		}
		expect(suspension.request.kind).toBe("declareAttackers");
		expect(choices.transcript().choices).toHaveLength(0);

		resolveAnswer({ optionIds: [String(c), String(a)] });
		const answer = await suspension.answer;
		choices.recordAnswer(suspension.request, answer);
		expect(choices.transcript().choices).toHaveLength(1);
		expect(choices.transcript().choices[0]?.answer).toEqual({
			optionIds: [String(a), String(c)],
		});

		choices.rewind();
		const result = choices.chooseAttackers(state, 0, [a, b, c]);
		expect(result).toEqual([a, c]);
		choices.assertComplete();
	});
});

describe("chooseBlockers", () => {
	function combatants(state: GameState): {
		attacker: ObjectId;
		blockerA: ObjectId;
		blockerB: ObjectId;
	} {
		const attacker = spawnPermanent(state, "grizzly-bears", 0).id;
		const blockerA = spawnPermanent(state, "grizzly-bears", 1).id;
		const blockerB = spawnPermanent(state, "eager-cadet", 1).id;
		return { attacker, blockerA, blockerB };
	}

	test("empty attacker list returns [] with no request", () => {
		const state = newGame();
		const blocker = spawnPermanent(state, "grizzly-bears", 1).id;
		const recorder = ChoiceController.record(agents());
		const result = recorder.chooseBlockers(state, 1, [], [blocker]);
		expect(result).toEqual([]);
		expect(recorder.transcript().choices).toHaveLength(0);
	});

	test("empty eligible blocker list returns [] with no request", () => {
		const state = newGame();
		const attacker = spawnPermanent(state, "grizzly-bears", 0).id;
		const recorder = ChoiceController.record(agents());
		const result = recorder.chooseBlockers(state, 1, [attacker], []);
		expect(result).toEqual([]);
		expect(recorder.transcript().choices).toHaveLength(0);
	});

	test("does not offer a ground creature as a blocker for a flying attacker", () => {
		const state = newGame();
		const attacker = spawnPermanent(state, "flying-men", 0).id;
		const ground = spawnPermanent(state, "grizzly-bears", 1).id;
		const flying = spawnPermanent(state, "flying-men", 1).id;
		const agent: Agent = {
			choose(_state, request) {
				expect(request.options.map((option) => option.id)).toEqual([
					blockAssignmentOptionId(flying, attacker),
				]);
				return { optionIds: [] };
			},
		};
		const recorder = ChoiceController.record([
			agent as SyncAgent,
			agent as SyncAgent,
		]);

		expect(
			recorder.chooseBlockers(state, 1, [attacker], [ground, flying]),
		).toEqual([]);
		const request = recorder.transcript().choices[0]?.request;
		expect(request?.kind).toBe("declareBlockers");
		if (request?.kind !== "declareBlockers") return;
		expect(request.context.eligibleBlockers).toEqual([flying]);
	});

	test("does not request a choice when no creature can block a flying attacker", () => {
		const state = newGame();
		const attacker = spawnPermanent(state, "flying-men", 0).id;
		const ground = spawnPermanent(state, "grizzly-bears", 1).id;
		const recorder = ChoiceController.record(agents());

		expect(recorder.chooseBlockers(state, 1, [attacker], [ground])).toEqual([]);
		expect(recorder.transcript().choices).toHaveLength(0);
	});

	test("selecting no blockers", () => {
		const state = newGame();
		const { attacker, blockerA, blockerB } = combatants(state);
		const agent: Agent = { choose: () => ({ optionIds: [] }) };
		const recorder = ChoiceController.record([
			agent as SyncAgent,
			agent as SyncAgent,
		]);
		const result = recorder.chooseBlockers(
			state,
			1,
			[attacker],
			[blockerA, blockerB],
		);
		expect(result).toEqual([]);
		expect(recorder.transcript().choices).toHaveLength(1);
		expect(recorder.transcript().choices[0]?.request.kind).toBe(
			"declareBlockers",
		);
	});

	test("selecting multiple blocker assignments, including multi-blockers", () => {
		const state = newGame();
		const { attacker, blockerA, blockerB } = combatants(state);
		const agent: Agent = {
			choose(_state, request) {
				const ids = [blockerA, blockerB]
					.map(
						(blocker) =>
							request.options.find(
								(option) =>
									option.id === blockAssignmentOptionId(blocker, attacker),
							)?.id,
					)
					.filter((id): id is string => id !== undefined);
				return { optionIds: ids };
			},
		};
		const recorder = ChoiceController.record([
			agent as SyncAgent,
			agent as SyncAgent,
		]);
		const result = recorder.chooseBlockers(
			state,
			1,
			[attacker],
			[blockerA, blockerB],
		);
		expect(result).toEqual([
			{ blocker: blockerA, attacker },
			{ blocker: blockerB, attacker },
		]);
	});

	test("reverse-order answer normalizes result and transcript to request order", () => {
		const state = newGame();
		const { attacker, blockerA, blockerB } = combatants(state);
		const agent: Agent = {
			choose: () => ({
				optionIds: [
					blockAssignmentOptionId(blockerB, attacker),
					blockAssignmentOptionId(blockerA, attacker),
				],
			}),
		};
		const recorder = ChoiceController.record([
			agent as SyncAgent,
			agent as SyncAgent,
		]);
		const result = recorder.chooseBlockers(
			state,
			1,
			[attacker],
			[blockerA, blockerB],
		);
		expect(result).toEqual([
			{ blocker: blockerA, attacker },
			{ blocker: blockerB, attacker },
		]);
		const recordedAnswer = recorder.transcript().choices[0]?.answer;
		expect(recordedAnswer).toEqual({
			optionIds: [
				blockAssignmentOptionId(blockerA, attacker),
				blockAssignmentOptionId(blockerB, attacker),
			],
		});
	});

	test("duplicate option IDs and wrong-shape answers throw InvalidChoiceAnswerError", () => {
		const state = newGame();
		const { attacker, blockerA } = combatants(state);

		const duplicate: Agent = {
			choose: () => ({
				optionIds: [
					blockAssignmentOptionId(blockerA, attacker),
					blockAssignmentOptionId(blockerA, attacker),
				],
			}),
		};
		expect(() =>
			ChoiceController.record([
				duplicate as SyncAgent,
				duplicate as SyncAgent,
			]).chooseBlockers(state, 1, [attacker], [blockerA]),
		).toThrow(InvalidChoiceAnswerError);

		const wrongShape: Agent = {
			choose: () => ({ optionId: String(blockerA) }) as unknown as ChoiceAnswer,
		};
		expect(() =>
			ChoiceController.record([
				wrongShape as SyncAgent,
				wrongShape as SyncAgent,
			]).chooseBlockers(state, 1, [attacker], [blockerA]),
		).toThrow(InvalidChoiceAnswerError);
	});

	test("JSON round trip and replay reproduce assignments", () => {
		const state = newGame();
		const { attacker, blockerA, blockerB } = combatants(state);
		const agent: Agent = {
			choose: () => ({
				optionIds: [blockAssignmentOptionId(blockerB, attacker)],
			}),
		};
		const recorder = ChoiceController.record([
			agent as SyncAgent,
			agent as SyncAgent,
		]);
		const result = recorder.chooseBlockers(
			state,
			1,
			[attacker],
			[blockerA, blockerB],
		);
		expect(result).toEqual([{ blocker: blockerB, attacker }]);

		const transcript = JSON.parse(JSON.stringify(recorder.transcript()));
		const replay = ChoiceController.replay(transcript);
		const replayedResult = replay.chooseBlockers(
			state,
			1,
			[attacker],
			[blockerA, blockerB],
		);
		replay.assertComplete();
		expect(replayedResult).toEqual([{ blocker: blockerB, attacker }]);
	});

	test("promise answer throws ChoicePendingError; recordAnswer normalizes and replay consumes exactly once", async () => {
		const state = newGame();
		const { attacker, blockerA, blockerB } = combatants(state);
		let resolveAnswer: ((answer: ChoiceAnswer) => void) | undefined;
		const pending = new Promise<ChoiceAnswer>((resolve) => {
			resolveAnswer = resolve;
		});
		const agent: Agent = { choose: () => pending };
		const choices = ChoiceController.suspending([agent, agent]);

		let suspension: ChoicePendingError | undefined;
		try {
			choices.chooseBlockers(state, 1, [attacker], [blockerA, blockerB]);
		} catch (error) {
			if (!(error instanceof ChoicePendingError)) throw error;
			suspension = error;
		}
		if (!suspension || !resolveAnswer) {
			throw new Error("expected a pending choice");
		}
		expect(suspension.request.kind).toBe("declareBlockers");
		expect(choices.transcript().choices).toHaveLength(0);

		resolveAnswer({
			optionIds: [
				blockAssignmentOptionId(blockerB, attacker),
				blockAssignmentOptionId(blockerA, attacker),
			],
		});
		const answer = await suspension.answer;
		choices.recordAnswer(suspension.request, answer);
		expect(choices.transcript().choices).toHaveLength(1);
		expect(choices.transcript().choices[0]?.answer).toEqual({
			optionIds: [
				blockAssignmentOptionId(blockerA, attacker),
				blockAssignmentOptionId(blockerB, attacker),
			],
		});

		choices.rewind();
		const result = choices.chooseBlockers(
			state,
			1,
			[attacker],
			[blockerA, blockerB],
		);
		expect(result).toEqual([
			{ blocker: blockerA, attacker },
			{ blocker: blockerB, attacker },
		]);
		choices.assertComplete();
	});
});
