import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "../agents.ts";
import { CARDS } from "../cards.ts";
import {
	createEngine,
	createReadContext,
	getSnapshot,
	perform,
	permanent,
	settlePriority,
	spawnCard,
	spawnPermanent,
} from "../index.ts";
import {
	ALICE,
	BOB,
	passingAgents,
	type SyncAgents,
	setupMain,
} from "./utils/engine-helpers.ts";

const engine = createEngine(CARDS);

/** An agent pair whose only scripted decision is ALICE naming BOB as a target. */
function alicePicksBob(): SyncAgents {
	return [
		new ScriptedAgent([], [], [], [], [], [{ type: "player", player: BOB }]),
		new ScriptedAgent(),
	];
}

describe("a targeted player creates the token", () => {
	test("Hunted Lammasu hands its Horror to the targeted opponent", () => {
		const state = setupMain(engine);
		const agents = alicePicksBob();
		const lammasu = spawnCard(state, "hunted-lammasu", ALICE, "hand");
		perform(
			engine,
			state,
			{
				kind: "change zone",
				object: lammasu.id,
				from: "hand",
				destination: { zone: "battlefield", controller: ALICE },
				cause: "resolve",
			},
			agents,
		);
		expect(state.pendingTriggers).toHaveLength(1);
		settlePriority(engine, state, agents);

		const tokens = state.battlefield.filter(
			(id) => permanent(state, id).representation.kind === "token",
		);
		expect(tokens).toHaveLength(1);
		const token = tokens[0];
		if (token === undefined) throw new Error("no token was created");

		// "Target opponent creates a 4/4 black Horror creature token." The
		// controller is the targeted player, not the ability's controller.
		expect(permanent(state, token).controller).toBe(BOB);
		expect(
			getSnapshot(createReadContext(engine, state), token)
				.currentCharacteristics,
		).toMatchObject({
			name: "Horror Token",
			colors: ["b"],
			types: ["creature"],
			subtypes: ["Horror"],
			power: 4,
			toughness: 4,
		});
	});

	test("Wanted Scoundrels gives the targeted opponent both Treasures", () => {
		const state = setupMain(engine);
		const agents = alicePicksBob();
		const scoundrels = spawnPermanent(
			engine,
			state,
			"wanted-scoundrels",
			ALICE,
		);
		perform(
			engine,
			state,
			{
				kind: "change zone",
				object: scoundrels.id,
				from: "battlefield",
				destination: { zone: "graveyard" },
				cause: "resolve",
			},
			agents,
		);
		expect(state.pendingTriggers).toHaveLength(1);
		settlePriority(engine, state, agents);

		const treasures = state.battlefield.filter(
			(id) => permanent(state, id).representation.kind === "token",
		);
		expect(treasures).toHaveLength(2);
		for (const treasure of treasures) {
			expect(permanent(state, treasure).controller).toBe(BOB);
		}
	});

	test("the ability's controller keeps nothing when the opponent is targeted", () => {
		const state = setupMain(engine);
		const lammasu = spawnCard(state, "hunted-lammasu", ALICE, "hand");
		perform(
			engine,
			state,
			{
				kind: "change zone",
				object: lammasu.id,
				from: "hand",
				destination: { zone: "battlefield", controller: ALICE },
				cause: "resolve",
			},
			passingAgents(),
		);
		settlePriority(engine, state, passingAgents());

		// BOB is ALICE's only opponent, so the fallback choice lands there too.
		const aliceTokens = state.battlefield.filter((id) => {
			const object = permanent(state, id);
			return (
				object.representation.kind === "token" && object.controller === ALICE
			);
		});
		expect(aliceTokens).toHaveLength(0);
	});
});
