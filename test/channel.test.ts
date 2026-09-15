import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "../agents.ts";
import { CARDS } from "../cards.ts";
import {
	abilityId,
	createEngine,
	createReadContext,
	executeAbilityAction,
	getSnapshot,
	name,
	settlePriority,
	spawnCard,
	spawnPermanent,
} from "../index.ts";
import { ALICE, BOB, setupMain } from "./utils/engine-helpers.ts";

const engine = createEngine(CARDS);
const ironhoofChannel = abilityId("activated", "ironhoof-boar", 0);

describe("channel", () => {
	test("is a hand activation and does not emit a cycling event", () => {
		const state = setupMain(engine);
		spawnPermanent(engine, state, "drannith-healer", ALICE);
		spawnPermanent(engine, state, "drannith-stinger", ALICE);
		const target = spawnPermanent(engine, state, "grizzly-bears", ALICE);
		const ironhoof = spawnCard(state, "ironhoof-boar", ALICE, "hand");
		state.players[ALICE].manaPool.c = 1;
		state.players[ALICE].manaPool.r = 1;
		const alice = new ScriptedAgent();
		alice.targetChoices.push({ type: "permanent", id: target.id });

		executeAbilityAction(
			engine,
			state,
			ALICE,
			{
				kind: "activate ability",
				source: ironhoof.id,
				ability: ironhoofChannel,
			},
			[alice, new ScriptedAgent()],
		);

		expect(state.stack).toHaveLength(1);
		expect(state.log.some((line) => line.includes("> cycle("))).toBe(false);
		settlePriority(engine, state, [alice, new ScriptedAgent()]);

		const characteristics = getSnapshot(
			createReadContext(engine, state),
			target.id,
		).currentCharacteristics;
		expect(characteristics).toMatchObject({
			power: 5,
			toughness: 3,
		});
		expect(characteristics.keywords).toContain("trample");
		expect(state.players[ALICE].life).toBe(20);
		expect(state.players[BOB].life).toBe(20);
		expect(
			state.players[ALICE].graveyard.map((id) => name(engine, state, id)),
		).toContain("Ironhoof Boar");
	});
});
