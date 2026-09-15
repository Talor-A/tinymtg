import { describe, expect, test } from "bun:test";
import { CARDS } from "../cards.ts";
import {
	createEngine,
	createReadContext,
	executeAbilityAction,
	executeCastAction,
	getSnapshot,
	name,
	settlePriority,
	spawnCard,
} from "../index.ts";
import { ALICE, passingAgents, setupMain } from "./utils/engine-helpers.ts";

const engine = createEngine(CARDS);

describe("Writhing Chrysalis", () => {
	test("its cast trigger creates Spawn and sacrificing one puts a counter on it", () => {
		const state = setupMain(engine);
		const chrysalisCard = spawnCard(state, "writhing-chrysalis", ALICE, "hand");
		state.players[ALICE].manaPool.c = 2;
		state.players[ALICE].manaPool.r = 1;
		state.players[ALICE].manaPool.g = 1;
		const agents = passingAgents();

		executeCastAction(
			engine,
			state,
			ALICE,
			{ kind: "cast", card: chrysalisCard.id },
			agents,
		);
		settlePriority(engine, state, agents);

		const chrysalis = state.battlefield.find(
			(id) => name(engine, state, id) === "Writhing Chrysalis",
		);
		const spawn = state.battlefield.filter(
			(id) => name(engine, state, id) === "Eldrazi Spawn Token",
		);
		expect(chrysalis).toBeDefined();
		expect(spawn).toHaveLength(2);
		if (chrysalis === undefined || spawn[0] === undefined) return;

		const spawnSnapshot = getSnapshot(
			createReadContext(engine, state),
			spawn[0],
		);
		const manaAbility =
			spawnSnapshot.currentCharacteristics.abilities.activated[0];
		expect(manaAbility).toBeDefined();
		if (manaAbility === undefined) return;

		executeAbilityAction(
			engine,
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
		settlePriority(engine, state, agents);

		const chrysalisSnapshot = getSnapshot(
			createReadContext(engine, state),
			chrysalis,
		);
		expect(chrysalisSnapshot.kind).toBe("permanent");
		if (chrysalisSnapshot.kind !== "permanent") return;
		expect(chrysalisSnapshot.counters).toEqual({ "+1/+1": 1 });
	});
});
