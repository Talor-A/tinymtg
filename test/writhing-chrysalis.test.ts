import { describe, expect, test } from "bun:test";
import { CARDS } from "../cards.ts";
import { createEngine, getSnapshot } from "../index.ts";
import { ALICE, passingAgents, setupMain } from "./utils/engine-helpers.ts";

const engine = createEngine(CARDS);

describe("Writhing Chrysalis", () => {
	test("its cast trigger creates Spawn and sacrificing one puts a counter on it", () => {
		const state = setupMain(engine);
		const chrysalisCard = engine.spawnCard(
			state,
			"writhing-chrysalis",
			ALICE,
			"hand",
		);
		state.players[ALICE].manaPool.c = 2;
		state.players[ALICE].manaPool.r = 1;
		state.players[ALICE].manaPool.g = 1;
		const agents = passingAgents();

		engine.executeCastAction(
			state,
			ALICE,
			{ kind: "cast", card: chrysalisCard.id },
			agents,
		);
		engine.settlePriority(state, agents);

		const chrysalis = state.battlefield.find(
			(id) => engine.name(state, id) === "Writhing Chrysalis",
		);
		const spawn = state.battlefield.filter(
			(id) => engine.name(state, id) === "Eldrazi Spawn Token",
		);
		expect(chrysalis).toBeDefined();
		expect(spawn).toHaveLength(2);
		if (chrysalis === undefined || spawn[0] === undefined) return;

		const spawnSnapshot = getSnapshot(
			engine.createReadContext(state),
			spawn[0],
		);
		const manaAbility =
			spawnSnapshot.currentCharacteristics.abilities.activated[0];
		expect(manaAbility).toBeDefined();
		if (manaAbility === undefined) return;

		engine.executeAbilityAction(
			state,
			ALICE,
			{
				kind: "activate ability",
				source: spawn[0],
				ability: manaAbility,
			},
			agents,
		);

		expect(state.players[ALICE].manaPool.c).toBe(1);
		expect(state.battlefield).not.toContain(spawn[0]);
		expect(state.pendingTriggers).toHaveLength(1);
		engine.settlePriority(state, agents);

		const chrysalisSnapshot = getSnapshot(
			engine.createReadContext(state),
			chrysalis,
		);
		expect(chrysalisSnapshot.kind).toBe("permanent");
		if (chrysalisSnapshot.kind !== "permanent") return;
		expect(chrysalisSnapshot.counters).toEqual({ "+1/+1": 1 });
	});
});
