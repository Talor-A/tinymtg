import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ScriptedAgent } from "./agents.ts";
import "./cards.ts";
import {
	buildPlayerView,
	ChoiceController,
	ChoiceReplayMismatchError,
	type EntityRef,
	newGame,
	perform,
	registerCard,
	type SpellTargets,
	spawnCard,
	spawnPermanent,
	type TargetDef,
} from "./index.ts";
import { parseCard } from "./parser.ts";

for (const file of ["m/murder", "l/lightning_bolt"]) {
	const definition = parseCard(
		readFileSync(`cards/cardsfolder/${file}.txt`, "utf8"),
	);
	if (!definition) throw new Error(`unsupported fixture ${file}`);
	registerCard(definition);
}

const creatureTarget: TargetDef = {
	id: "target-1",
	min: 1,
	max: 1,
	legal: { kind: "permanent", selector: { kind: "type", type: "creature" } },
};

function passingAgents(): [ScriptedAgent, ScriptedAgent] {
	return [new ScriptedAgent(), new ScriptedAgent()];
}

describe("target bindings and choices", () => {
	test("zone movement installs detached bindings visible to both players", () => {
		const state = newGame();
		const spell = spawnCard(state, "murder", 0, "hand");
		const creature = spawnPermanent(state, "grizzly-bears", 1);
		const targets: SpellTargets = [
			{ slot: "target-1", target: { type: "permanent", id: creature.id } },
		];
		perform(
			state,
			{
				kind: "change zone",
				object: spell.id,
				from: "hand",
				to: "stack",
				cause: "cast",
				toController: 0,
				spellTargets: targets,
			},
			passingAgents(),
		);
		const entry = state.stack[0];
		if (entry?.kind !== "spell") throw new Error("expected spell");
		expect(entry.objectId).not.toBe(spell.id);
		expect(entry.targets).toEqual(targets);
		expect(entry.targets).not.toBe(targets);
		for (const player of [0, 1] as const) {
			const view = buildPlayerView(state, player);
			expect(view.stack[0]).toMatchObject({ targets });
			expect(JSON.parse(JSON.stringify(view)).stack[0].targets).toEqual(
				targets,
			);
		}
		const cloned = structuredClone(state);
		expect(buildPlayerView(cloned, 1).stack[0]).toMatchObject({ targets });
	});

	test("target choices replay and reject a changed candidate list", () => {
		const state = newGame();
		const spell = spawnCard(state, "murder", 0, "hand");
		const creature = spawnPermanent(state, "grizzly-bears", 1);
		const target: EntityRef = { type: "permanent", id: creature.id };
		const controller = ChoiceController.record(passingAgents());
		expect(
			controller.chooseTarget(state, 0, spell.id, creatureTarget, [target]),
		).toEqual(target);
		const transcript = JSON.parse(JSON.stringify(controller.transcript()));
		const replay = ChoiceController.replay(transcript);
		expect(
			replay.chooseTarget(state, 0, spell.id, creatureTarget, [target]),
		).toEqual(target);
		replay.assertComplete();
		expect(() =>
			ChoiceController.replay(transcript).chooseTarget(
				state,
				0,
				spell.id,
				creatureTarget,
				[{ type: "player", player: 1 }],
			),
		).toThrow(ChoiceReplayMismatchError);
	});
});
