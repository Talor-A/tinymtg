/**
 * prowess.test.ts — CR 702.108, the first triggered ability keyword.
 *
 * Prowess is authored as `keywords: ["prowess"]` and compiled into an ordinary
 * cast trigger owned by the card, so these tests assert both halves: the
 * keyword is on the object's characteristics, and the trigger it stands for is
 * a real possessed ability that fires and pumps.
 */

import { describe, expect, test } from "bun:test";
import "../cards.ts"; // side effect: registers the card database
import type { CastAction, GameState, ObjectId } from "../index.ts";
import {
	abilityId,
	createReadContext,
	executeCastAction,
	getAbilityDefinition,
	getSnapshot,
	registerCard,
	settlePriority,
	spawnCard,
	spawnPermanent,
} from "../index.ts";
import {
	ALICE,
	BOB,
	passingAgents,
	playOneTurn,
	setupMain,
} from "./utils/engine-helpers.ts";

registerCard({
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

registerCard({
	id: "test-prowess-free-creature",
	name: "Test Prowess Free Creature",
	types: ["creature"],
	colors: [],
	manaCost: "zero",
	power: 1,
	toughness: 1,
});

function castAction(card: ObjectId): CastAction {
	return { kind: "cast", card };
}

/** Power and toughness as the layer walk currently derives them. */
function currentPT(state: GameState, id: ObjectId): [number, number] {
	const snapshot = getSnapshot(createReadContext(state), id);
	const current = snapshot.currentCharacteristics;
	if (current.kind !== "creature")
		throw new Error("expected a creature snapshot");
	return [current.power, current.toughness];
}

describe("prowess", () => {
	test("Monastery Swiftspear prints the keyword and the ability it stands for", () => {
		const state = setupMain();
		const swiftspear = spawnPermanent(state, "monastery-swiftspear", ALICE);
		const snapshot = getSnapshot(createReadContext(state), swiftspear.id);

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
			getAbilityDefinition(
				"triggered",
				abilityId("triggered", "monastery-swiftspear", 0),
			).condition,
		).toEqual({
			kind: "cast",
			player: "you",
			selector: { kind: "not", selector: { kind: "type", type: "creature" } },
		});
	});

	test("a noncreature spell pumps the creature until end of turn", () => {
		const state = setupMain();
		const swiftspear = spawnPermanent(state, "monastery-swiftspear", ALICE);
		expect(currentPT(state, swiftspear.id)).toEqual([1, 2]);

		const instant = spawnCard(
			state,
			"test-prowess-free-instant",
			ALICE,
			"hand",
		);
		executeCastAction(state, ALICE, castAction(instant.id), passingAgents());
		expect(state.pendingTriggers).toHaveLength(1);
		expect(state.pendingTriggers[0]?.triggerId).toBe(
			abilityId("triggered", "monastery-swiftspear", 0),
		);

		settlePriority(state, passingAgents());
		expect(currentPT(state, swiftspear.id)).toEqual([2, 3]);
	});

	test("a creature spell does not trigger it", () => {
		const state = setupMain();
		const swiftspear = spawnPermanent(state, "monastery-swiftspear", ALICE);
		const creature = spawnCard(
			state,
			"test-prowess-free-creature",
			ALICE,
			"hand",
		);

		executeCastAction(state, ALICE, castAction(creature.id), passingAgents());
		expect(state.pendingTriggers).toHaveLength(0);

		settlePriority(state, passingAgents());
		expect(currentPT(state, swiftspear.id)).toEqual([1, 2]);
	});

	test("an opponent's noncreature spell does not trigger it", () => {
		const state = setupMain();
		const swiftspear = spawnPermanent(state, "monastery-swiftspear", ALICE);
		const instant = spawnCard(state, "test-prowess-free-instant", BOB, "hand");

		executeCastAction(state, BOB, castAction(instant.id), passingAgents());
		expect(state.pendingTriggers).toHaveLength(0);

		settlePriority(state, passingAgents());
		expect(currentPT(state, swiftspear.id)).toEqual([1, 2]);
	});

	test("each instance triggers separately (CR 702.108b)", () => {
		const state = setupMain();
		// Thor Odinson prints `K:Prowess` twice, so it has prowess twice.
		const thor = spawnPermanent(state, "thor-odinson", ALICE);
		expect(currentPT(state, thor.id)).toEqual([4, 4]);

		const instant = spawnCard(
			state,
			"test-prowess-free-instant",
			ALICE,
			"hand",
		);
		executeCastAction(state, ALICE, castAction(instant.id), passingAgents());
		expect(state.pendingTriggers.map((pending) => pending.triggerId)).toEqual([
			abilityId("triggered", "thor-odinson", 0),
			abilityId("triggered", "thor-odinson", 1),
		]);

		settlePriority(state, passingAgents());
		expect(currentPT(state, thor.id)).toEqual([6, 6]);
	});

	test("two noncreature spells stack their bonuses", () => {
		const state = setupMain();
		const swiftspear = spawnPermanent(state, "monastery-swiftspear", ALICE);

		for (let cast = 0; cast < 2; cast++) {
			const instant = spawnCard(
				state,
				"test-prowess-free-instant",
				ALICE,
				"hand",
			);
			executeCastAction(state, ALICE, castAction(instant.id), passingAgents());
			settlePriority(state, passingAgents());
		}

		expect(currentPT(state, swiftspear.id)).toEqual([3, 4]);
	});

	test("the bonus wears off at end of turn", () => {
		const state = setupMain();
		const swiftspear = spawnPermanent(state, "monastery-swiftspear", ALICE);
		const instant = spawnCard(
			state,
			"test-prowess-free-instant",
			ALICE,
			"hand",
		);

		executeCastAction(state, ALICE, castAction(instant.id), passingAgents());
		settlePriority(state, passingAgents());
		expect(currentPT(state, swiftspear.id)).toEqual([2, 3]);

		playOneTurn(state, passingAgents());
		expect(currentPT(state, swiftspear.id)).toEqual([1, 2]);
	});
});
