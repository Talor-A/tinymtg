import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "./agents.ts";
import "./cards.ts";
import {
	type Agent,
	advance,
	advanceWithReplay,
	type ChoiceAnswer,
	ChoiceController,
	ChoicePendingError,
	ChoiceReplayMismatchError,
	type ChoiceRequest,
	newGame,
	type ObjectId,
	perform,
	spawnPermanent,
} from "./index.ts";

function agents(first = new ScriptedAgent()): [Agent, Agent] {
	return [first, new ScriptedAgent()];
}

describe("choice transcripts", () => {
	test("agents receive one unified serializable request", () => {
		const seen: { request?: ChoiceRequest } = {};
		const agent: Agent = {
			choose(_state, request) {
				seen.request = request;
				const option = request.options[0];
				if (!option) throw new Error("expected an option");
				return { optionId: option.id };
			},
		};
		const state = newGame();
		spawnPermanent(state, "hardened-scales", 0, "battlefield");
		spawnPermanent(state, "doubling-season", 0, "battlefield");
		const creature = spawnPermanent(state, "grizzly-bears", 0, "battlefield");

		perform(
			state,
			{
				kind: "addCounters",
				target: { type: "permanent", id: creature.id },
				counter: "+1/+1",
				amount: 1,
			},
			[agent, agent],
		);

		expect(seen.request?.kind).toBe("replacement");
		expect(() => JSON.stringify(seen.request)).not.toThrow();
	});

	test("suspends synchronously when an agent returns a promise", async () => {
		let resolveAnswer: ((answer: ChoiceAnswer) => void) | undefined;
		const pending = new Promise<ChoiceAnswer>((resolve) => {
			resolveAnswer = resolve;
		});
		const agent: Agent = { choose: () => pending };
		const state = newGame();
		spawnPermanent(state, "hardened-scales", 0, "battlefield");
		spawnPermanent(state, "doubling-season", 0, "battlefield");
		const creature = spawnPermanent(state, "grizzly-bears", 0, "battlefield");
		const choices = ChoiceController.record([agent, agent]);

		let suspension: ChoicePendingError | undefined;
		try {
			perform(
				state,
				{
					kind: "addCounters",
					target: { type: "permanent", id: creature.id },
					counter: "+1/+1",
					amount: 1,
				},
				choices,
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
		const snapshot = structuredClone(checkpoint);

		const result = await advanceWithReplay(checkpoint, agents());

		expect(result.attempts).toBe(1);
		expect(result.state.turnScheduler.command.kind).toBe("advancePhase");
		expect(result.transcript.choices).toHaveLength(0);
		expect(checkpoint).toEqual(snapshot);
	});

	test("advanceWithReplay rewinds one transition around an async choice", async () => {
		const checkpoint = newGame();
		spawnPermanent(checkpoint, "ajanis-mantra", 0, "battlefield");
		const setupAgents = agents();
		for (let i = 0; i < 4; i++) advance(checkpoint, setupAgents);
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
			"priorityAction",
			"priorityAction",
			"optional",
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
		spawnPermanent(checkpoint, "ajanis-mantra", 0, "battlefield");
		const setupAgents = agents();
		for (let i = 0; i < 4; i++) advance(checkpoint, setupAgents);
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

		await expect(
			advanceWithReplay(checkpoint, [rejecting, rejecting]),
		).rejects.toBe(failure);
		expect(checkpoint).toEqual(snapshot);
	});

	test("records synchronous choices and replays without agents", () => {
		const checkpoint = newGame();
		spawnPermanent(checkpoint, "hardened-scales", 0, "battlefield");
		spawnPermanent(checkpoint, "doubling-season", 0, "battlefield");
		const creature = spawnPermanent(
			checkpoint,
			"grizzly-bears",
			0,
			"battlefield",
		);
		const event = {
			kind: "addCounters" as const,
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
				id: 99 as ObjectId,
				kind: "ability",
				source: 1 as ObjectId,
				sourceCardId: "ajanis-mantra",
				controller: 0,
				triggerId: "upkeep-life",
				text: "gain 1 life",
				optional: true,
				effects: [{ kind: "gainLife", player: "controller", amount: 1 }],
			}),
		).toThrow(ChoiceReplayMismatchError);
	});

	test("rejects a transcript when the request changes", () => {
		const checkpoint = newGame();
		spawnPermanent(checkpoint, "hardened-scales", 0, "battlefield");
		spawnPermanent(checkpoint, "doubling-season", 0, "battlefield");
		const creature = spawnPermanent(
			checkpoint,
			"grizzly-bears",
			0,
			"battlefield",
		);
		const recorder = ChoiceController.record(agents());
		perform(
			structuredClone(checkpoint),
			{
				kind: "addCounters",
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
					kind: "addCounters",
					target: { type: "permanent", id: creature.id },
					counter: "+1/+1",
					amount: 2,
				},
				replay,
			),
		).toThrow(ChoiceReplayMismatchError);
	});
});
