/**
 * prowess.test.ts — CR 702.108, the first triggered ability keyword.
 *
 * Prowess is authored as `keywords: ["prowess"]` and compiled into an ordinary
 * cast trigger owned by the card, so these tests assert both halves: the
 * keyword is on the object's characteristics, and the trigger it stands for is
 * a real possessed ability that fires and pumps.
 */

import { describe, expect, test } from "bun:test";
import { CARDS } from "../cards.ts";
import type { CastAction, GameState, ObjectId } from "../index.ts";
import { abilityId, createEngine, defineCard, getSnapshot } from "../index.ts";
import {
	ALICE,
	BOB,
	passingAgents,
	playOneTurn,
	setupMain,
} from "./utils/engine-helpers.ts";

const TEST_CARD_1 = defineCard({
	id: "test-prowess-free-instant",
	name: "Test Prowess Free Instant",
	types: ["instant"],
	colors: [],
	manaCost: "zero",
	spell: {
		id: "test-prowess-free-instant-spell",
		text: "Do nothing.",
		targets: [],
		effects: [],
	},
});

const TEST_CARD_2 = defineCard({
	id: "test-prowess-free-creature",
	name: "Test Prowess Free Creature",
	types: ["creature"],
	colors: [],
	manaCost: "zero",
	power: 1,
	toughness: 1,
});

const engine = createEngine([...CARDS, TEST_CARD_1, TEST_CARD_2]);

function castAction(card: ObjectId): CastAction {
	return { kind: "cast", card };
}

/** Power and toughness as the layer walk currently derives them. */
function currentPT(state: GameState, id: ObjectId): [number, number] {
	const snapshot = getSnapshot(engine.createReadContext(state), id);
	const current = snapshot.currentCharacteristics;
	if (current.kind !== "creature")
		throw new Error("expected a creature snapshot");
	return [current.power, current.toughness];
}

describe("prowess", () => {
	test("Monastery Swiftspear prints the keyword and the ability it stands for", () => {
		const state = setupMain(engine);
		const swiftspear = engine.spawnPermanent(
			state,
			"monastery-swiftspear",
			ALICE,
		);
		const snapshot = getSnapshot(
			engine.createReadContext(state),
			swiftspear.id,
		);

		expect(snapshot.currentCharacteristics.keywords).toEqual([
			"haste",
			"prowess",
		]);
		// The keyword's trigger is appended after the card's own definitions, of
		// which Monastery Swiftspear has none.
		expect(snapshot.currentCharacteristics.abilities.triggered).toEqual([
			abilityId("triggered", "monastery-swiftspear", 0),
		]);
		expect(
			engine.getAbilityDefinition(
				"triggered",
				abilityId("triggered", "monastery-swiftspear", 0),
			).condition,
		).toEqual({
			kind: "cast",
			player: "you",
			predicate: { kind: "not", predicate: { kind: "type", type: "creature" } },
		});
	});

	test("a noncreature spell pumps the creature until end of turn", () => {
		const state = setupMain(engine);
		const swiftspear = engine.spawnPermanent(
			state,
			"monastery-swiftspear",
			ALICE,
		);
		expect(currentPT(state, swiftspear.id)).toEqual([1, 2]);

		const instant = engine.spawnCard(
			state,
			"test-prowess-free-instant",
			ALICE,
			"hand",
		);
		engine.executeCastAction(
			state,
			ALICE,
			castAction(instant.id),
			passingAgents(),
		);
		expect(state.pendingTriggers).toHaveLength(1);
		expect(state.pendingTriggers[0]?.triggerId).toBe(
			abilityId("triggered", "monastery-swiftspear", 0),
		);

		engine.settlePriority(state, passingAgents());
		expect(currentPT(state, swiftspear.id)).toEqual([2, 3]);
	});

	test("a creature spell does not trigger it", () => {
		const state = setupMain(engine);
		const swiftspear = engine.spawnPermanent(
			state,
			"monastery-swiftspear",
			ALICE,
		);
		const creature = engine.spawnCard(
			state,
			"test-prowess-free-creature",
			ALICE,
			"hand",
		);

		engine.executeCastAction(
			state,
			ALICE,
			castAction(creature.id),
			passingAgents(),
		);
		expect(state.pendingTriggers).toHaveLength(0);

		engine.settlePriority(state, passingAgents());
		expect(currentPT(state, swiftspear.id)).toEqual([1, 2]);
	});

	test("an opponent's noncreature spell does not trigger it", () => {
		const state = setupMain(engine);
		const swiftspear = engine.spawnPermanent(
			state,
			"monastery-swiftspear",
			ALICE,
		);
		const instant = engine.spawnCard(
			state,
			"test-prowess-free-instant",
			BOB,
			"hand",
		);

		engine.executeCastAction(
			state,
			BOB,
			castAction(instant.id),
			passingAgents(),
		);
		expect(state.pendingTriggers).toHaveLength(0);

		engine.settlePriority(state, passingAgents());
		expect(currentPT(state, swiftspear.id)).toEqual([1, 2]);
	});

	test("each instance triggers separately (CR 702.108b)", () => {
		const state = setupMain(engine);
		// Thor Odinson prints `K:Prowess` twice, so it has prowess twice.
		const thor = engine.spawnPermanent(state, "thor-odinson", ALICE);
		expect(currentPT(state, thor.id)).toEqual([4, 4]);

		const instant = engine.spawnCard(
			state,
			"test-prowess-free-instant",
			ALICE,
			"hand",
		);
		engine.executeCastAction(
			state,
			ALICE,
			castAction(instant.id),
			passingAgents(),
		);
		expect(state.pendingTriggers.map((pending) => pending.triggerId)).toEqual([
			abilityId("triggered", "thor-odinson", 0),
			abilityId("triggered", "thor-odinson", 1),
		]);

		engine.settlePriority(state, passingAgents());
		expect(currentPT(state, thor.id)).toEqual([6, 6]);
	});

	test("two noncreature spells stack their bonuses", () => {
		const state = setupMain(engine);
		const swiftspear = engine.spawnPermanent(
			state,
			"monastery-swiftspear",
			ALICE,
		);

		for (let cast = 0; cast < 2; cast++) {
			const instant = engine.spawnCard(
				state,
				"test-prowess-free-instant",
				ALICE,
				"hand",
			);
			engine.executeCastAction(
				state,
				ALICE,
				castAction(instant.id),
				passingAgents(),
			);
			engine.settlePriority(state, passingAgents());
		}

		expect(currentPT(state, swiftspear.id)).toEqual([3, 4]);
	});

	test("the bonus wears off at end of turn", () => {
		const state = setupMain(engine);
		const swiftspear = engine.spawnPermanent(
			state,
			"monastery-swiftspear",
			ALICE,
		);
		const instant = engine.spawnCard(
			state,
			"test-prowess-free-instant",
			ALICE,
			"hand",
		);

		engine.executeCastAction(
			state,
			ALICE,
			castAction(instant.id),
			passingAgents(),
		);
		engine.settlePriority(state, passingAgents());
		expect(currentPT(state, swiftspear.id)).toEqual([2, 3]);

		playOneTurn(engine, state, passingAgents());
		expect(currentPT(state, swiftspear.id)).toEqual([1, 2]);
	});
});
