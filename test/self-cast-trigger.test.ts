import { describe, expect, test } from "bun:test";
import { CARDS } from "../cards.ts";
import {
	createEngine,
	executeCastAction,
	name,
	settlePriority,
	spawnCard,
} from "../index.ts";
import { ALICE, passingAgents, setupMain } from "./utils/engine-helpers.ts";

const engine = createEngine(CARDS);

describe("self-cast triggers", () => {
	test("trigger from the spell on the stack before that spell resolves", () => {
		const state = setupMain(engine);
		const twin = spawnCard(state, "desolation-twin", ALICE, "hand");
		state.players[ALICE].manaPool.c = 10;

		executeCastAction(
			engine,
			state,
			ALICE,
			{ kind: "cast", card: twin.id },
			passingAgents(),
		);

		expect(state.pendingTriggers).toHaveLength(1);
		expect(state.stack).toHaveLength(1);
		settlePriority(engine, state, passingAgents());

		expect(
			state.battlefield.map((id) => name(engine, state, id)).sort(),
		).toEqual(["Desolation Twin", "Eldrazi Token"]);
	});
});
