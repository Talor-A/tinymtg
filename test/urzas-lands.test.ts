import { describe, expect, test } from "bun:test";
import { CARDS, URZAS_MINE, URZAS_POWER_PLANT, URZAS_TOWER } from "../cards.ts";
import type { ObjectId, PlayerId } from "../index.ts";
import { abilityId, createEngine, getSnapshot } from "../index.ts";
import {
	ALICE,
	BOB,
	passingAgents,
	setupMain,
} from "./utils/engine-helpers.ts";

const engine = createEngine(CARDS);

const MINE_BASE = abilityId("activated", URZAS_MINE.id, 0);
const MINE_TRON = abilityId("activated", URZAS_MINE.id, 1);
const POWER_PLANT_BASE = abilityId("activated", URZAS_POWER_PLANT.id, 0);
const POWER_PLANT_TRON = abilityId("activated", URZAS_POWER_PLANT.id, 1);
const TOWER_BASE = abilityId("activated", URZAS_TOWER.id, 0);
const TOWER_TRON = abilityId("activated", URZAS_TOWER.id, 1);

function activatedAbilities(state: ReturnType<typeof setupMain>, id: ObjectId) {
	return getSnapshot(engine.createReadContext(state), id).currentCharacteristics
		.abilities.activated;
}

function activate(
	state: ReturnType<typeof setupMain>,
	player: PlayerId,
	source: ObjectId,
	ability: typeof MINE_BASE,
): void {
	engine.executeAbilityAction(
		state,
		player,
		{ kind: "activate ability", source, ability },
		passingAgents(),
	);
}

describe("Urza's lands", () => {
	test("match the corpus definitions and print only the conditional static", () => {
		expect(URZAS_MINE).toMatchObject({
			name: "Urza's Mine",
			types: ["land"],
			subtypes: ["Urza's", "Mine"],
			manaCost: "none",
		});
		expect(URZAS_POWER_PLANT).toMatchObject({
			name: "Urza's Power Plant",
			types: ["land"],
			subtypes: ["Urza's", "Power-Plant"],
			manaCost: "none",
		});
		expect(URZAS_TOWER).toMatchObject({
			name: "Urza's Tower",
			types: ["land"],
			subtypes: ["Urza's", "Tower"],
			manaCost: "none",
		});

		for (const card of [URZAS_MINE, URZAS_POWER_PLANT, URZAS_TOWER]) {
			expect(card.abilityDefinitions.static).toHaveLength(1);
			expect(card.abilityDefinitions.activated).toHaveLength(2);
			expect(card.printedAbilities.static).toEqual([
				abilityId("static", card.id, 0),
			]);
			expect(card.printedAbilities.activated).toEqual([]);
		}
	});

	test("each land grants its one-colorless ability without Tron", () => {
		for (const [card, ability] of [
			[URZAS_MINE, MINE_BASE],
			[URZAS_POWER_PLANT, POWER_PLANT_BASE],
			[URZAS_TOWER, TOWER_BASE],
		] as const) {
			const state = setupMain(engine);
			const land = engine.spawnPermanent(state, card.id, ALICE);
			expect(activatedAbilities(state, land.id)).toEqual([ability]);

			activate(state, ALICE, land.id, ability);
			expect(state.players[ALICE].manaPool.c).toBe(1);
			expect(state.objects.get(land.id)).toMatchObject({ tapped: true });
		}
	});

	test("grants only the enhanced abilities while its controller has Tron", () => {
		const state = setupMain(engine);
		const mine = engine.spawnPermanent(state, URZAS_MINE.id, ALICE);
		const plant = engine.spawnPermanent(state, URZAS_POWER_PLANT.id, ALICE);
		const tower = engine.spawnPermanent(state, URZAS_TOWER.id, ALICE);

		expect(activatedAbilities(state, mine.id)).toEqual([MINE_TRON]);
		expect(activatedAbilities(state, plant.id)).toEqual([POWER_PLANT_TRON]);
		expect(activatedAbilities(state, tower.id)).toEqual([TOWER_TRON]);

		activate(state, ALICE, mine.id, MINE_TRON);
		activate(state, ALICE, plant.id, POWER_PLANT_TRON);
		activate(state, ALICE, tower.id, TOWER_TRON);
		expect(state.players[ALICE].manaPool.c).toBe(7);
	});

	test("opposing lands do not complete Tron, and losing one swaps back immediately", () => {
		const state = setupMain(engine);
		const mine = engine.spawnPermanent(state, URZAS_MINE.id, ALICE);
		engine.spawnPermanent(state, URZAS_POWER_PLANT.id, ALICE);
		const opposingTower = engine.spawnPermanent(state, URZAS_TOWER.id, BOB);

		expect(activatedAbilities(state, mine.id)).toEqual([MINE_BASE]);

		const ownTower = engine.spawnPermanent(state, URZAS_TOWER.id, ALICE);
		expect(activatedAbilities(state, mine.id)).toEqual([MINE_TRON]);

		engine.perform(
			state,
			{
				kind: "change zone",
				object: ownTower.id,
				from: "battlefield",
				destination: { zone: "graveyard" },
				cause: "effect",
			},
			passingAgents(),
		);
		expect(activatedAbilities(state, mine.id)).toEqual([MINE_BASE]);
		expect(activatedAbilities(state, opposingTower.id)).toEqual([TOWER_BASE]);
	});

	test("a copy uses its copied name and static ability to recognize Tron", () => {
		const state = setupMain(engine);
		const original = engine.spawnPermanent(state, URZAS_MINE.id, ALICE);
		const copiedValues = structuredClone(
			getSnapshot(engine.createReadContext(state), original.id).copiableValues,
		);
		const copy = engine.spawnToken(state, ALICE, copiedValues);
		engine.spawnPermanent(state, URZAS_POWER_PLANT.id, ALICE);
		engine.spawnPermanent(state, URZAS_TOWER.id, ALICE);

		expect(activatedAbilities(state, copy.id)).toEqual([MINE_TRON]);
		activate(state, ALICE, copy.id, MINE_TRON);
		expect(state.players[ALICE].manaPool.c).toBe(2);
	});
});
