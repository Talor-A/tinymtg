import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "./agents.ts";
import "./cards.ts";
import {
	type Agent,
	ChoiceController,
	ChoiceReplayMismatchError,
	newGame,
	type ObjectId,
	perform,
	spawnPermanent,
} from "./index.ts";

function agents(first = new ScriptedAgent()): [Agent, Agent] {
	return [first, new ScriptedAgent()];
}

describe("choice transcripts", () => {
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
