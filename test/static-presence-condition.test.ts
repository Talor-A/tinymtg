/**
 * static-presence-condition.test.ts — "as long as you control ..." statics.
 *
 * An imported static's condition becomes a closure behind `applies()`, so no
 * definition snapshot can show it: `forge/lowered-cards` serializes such a
 * static and sees its layers and its text, never which board makes it apply.
 * A condition that was dropped, inverted, or counted wrong would still import
 * and still read correctly there, so these tests ask the engine instead —
 * build the board, then read the characteristics the layer walk arrives at.
 *
 * The condition is answered against the walk's partly-evaluated
 * characteristics, which is sound only because the importer proves the
 * condition reads a strictly lower layer than the effect it gates. These
 * cards are the two shapes that rule admits: a bare `IsPresent$` meaning "at
 * least one", and a `PresentCompare$` bound.
 */

import { describe, expect, test } from "bun:test";
import { CARDS } from "../cards.ts";
import { loadCardFixture } from "../corpus.ts";
import {
	createEngine,
	createReadContext,
	type GameState,
	getSnapshot,
	type ObjectId,
	type PlayerId,
	spawnPermanent,
} from "../index.ts";
import { assert } from "../lib/assert.ts";
import { ALICE, BOB, setupMain } from "./utils/engine-helpers.ts";

const engine = createEngine([
	...CARDS,
	// "As long as you control seven or more lands, this creature gets +2/+2."
	loadCardFixture("g/gigantoad"),
	// "... has lifelink as long as you control a white or black permanent."
	loadCardFixture("a/abzan_kin_guard"),
	// A white permanent, for Kin-Guard's first alternative. The negative case
	// uses a Swamp, because lands are colourless -- every land, not a quirk of
	// that one.
	loadCardFixture("s/savannah_lions"),
]);

function spawn(state: GameState, card: string, controller: PlayerId): ObjectId {
	return spawnPermanent(engine, state, card, controller).id;
}

/** The characteristics the layer walk currently gives `object`. */
function creature(state: GameState, object: ObjectId) {
	const snapshot = getSnapshot(createReadContext(engine, state), object);
	assert(snapshot.kind === "permanent", "expected a permanent");
	const characteristics = snapshot.currentCharacteristics;
	assert(characteristics.kind === "creature", "expected a creature");
	return characteristics;
}

describe("a static's presence condition is answered against the board", () => {
	test("Gigantoad counts lands and applies only at seven", () => {
		const state = setupMain(engine);
		const toad = spawn(state, "gigantoad", ALICE);

		// Printed 4/4 with six lands: one short, so the static does not apply.
		for (let count = 0; count < 6; count++) spawn(state, "forest", ALICE);
		expect([
			creature(state, toad).power,
			creature(state, toad).toughness,
		]).toEqual([4, 4]);

		// The seventh land satisfies `PresentCompare$ GE7`.
		spawn(state, "forest", ALICE);
		expect([
			creature(state, toad).power,
			creature(state, toad).toughness,
		]).toEqual([6, 6]);
	});

	test("Gigantoad counts only its controller's lands", () => {
		// `Land.YouCtrl`: seven lands split across players is not seven of
		// yours. Dropping the controller restriction would pass this at 4/4
		// only by accident, so the opponent gets the larger share.
		const state = setupMain(engine);
		const toad = spawn(state, "gigantoad", ALICE);
		for (let count = 0; count < 3; count++) spawn(state, "forest", ALICE);
		for (let count = 0; count < 4; count++) spawn(state, "forest", BOB);
		expect([
			creature(state, toad).power,
			creature(state, toad).toughness,
		]).toEqual([4, 4]);
	});

	test("Abzan Kin-Guard reads both alternatives of its condition", () => {
		// `IsPresent$ Permanent.White+YouCtrl,Permanent.Black+YouCtrl` is an
		// `or`: either colour satisfies it. A Swamp satisfies neither -- lands
		// are colourless -- so it proves the condition is being read at all
		// rather than just answering true once any permanent is present.
		const state = setupMain(engine);
		const guard = spawn(state, "abzan-kin-guard", ALICE);
		expect(creature(state, guard).keywords).not.toContain("lifelink");

		spawn(state, "swamp", ALICE);
		expect(creature(state, guard).keywords).not.toContain("lifelink");

		// Savannah Lions is white: the first alternative.
		spawn(state, "savannah-lions", ALICE);
		expect(creature(state, guard).keywords).toContain("lifelink");
	});

	test("Abzan Kin-Guard ignores a permanent an opponent controls", () => {
		const state = setupMain(engine);
		const guard = spawn(state, "abzan-kin-guard", ALICE);
		spawn(state, "savannah-lions", BOB);
		expect(creature(state, guard).keywords).not.toContain("lifelink");
	});
});
