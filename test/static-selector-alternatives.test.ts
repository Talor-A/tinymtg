/**
 * static-selector-alternatives.test.ts — a static ability's selector reaches
 * every alternative its Forge script lists.
 *
 * An imported static's selector becomes a closure over an
 * `ObjectPredicateDef`, behind `applies()`. That makes it the one part of a
 * lowered card that no definition snapshot can show: `forge/lowered-cards`
 * serializes a static and sees its layers and its text, never which objects it
 * affects. A comma-separated `Affected$` list is exactly where a lowering bug
 * would hide, because dropping an alternative leaves a card that still
 * imports, still reads correctly in the snapshot, and quietly buffs the wrong
 * set of creatures.
 *
 * So these tests ask the engine instead. Each puts one creature per
 * alternative onto the battlefield, plus a creature that matches none of them,
 * and reads the power and toughness the layer system arrives at.
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
	// The cards under test.
	loadCardFixture("d/death_baron"),
	loadCardFixture("l/lovisa_coldeyes"),
	// Vanilla probes, one per subtype the selectors name plus an unrelated
	// one. Vanilla matters: a probe with an ability of its own could move the
	// numbers these tests read.
	loadCardFixture("g/gutter_skulk"), // 2/2 Zombie
	loadCardFixture("s/skeletal_snake"), // 2/1 Skeleton
	loadCardFixture("c/canyon_minotaur"), // 3/3 Minotaur Warrior
	loadCardFixture("b/balduvian_barbarians"), // 3/2 Human Barbarian
	// Grizzly Bears -- a 2/2 Bear, matching neither card -- is already in
	// `CARDS`, and loading it again would be a duplicate id.
]);

/** The power and toughness the layer system currently gives `object`. */
function stats(state: GameState, object: ObjectId): [number, number] {
	const snapshot = getSnapshot(createReadContext(engine, state), object);
	assert(snapshot.kind === "permanent", "a probe is a permanent");
	assert(
		snapshot.currentCharacteristics.kind === "creature",
		"a probe is a creature",
	);
	return [
		snapshot.currentCharacteristics.power,
		snapshot.currentCharacteristics.toughness,
	];
}

function spawn(state: GameState, card: string, controller: PlayerId): ObjectId {
	return spawnPermanent(engine, state, card, controller).id;
}

describe("a static selector's comma-separated alternatives all apply", () => {
	test("Death Baron buffs other Zombies and Skeletons you control", () => {
		// `Affected$ Creature.Zombie+Other+YouCtrl,Creature.Skeleton+YouCtrl`:
		// two alternatives, and the Zombie one excludes the Baron itself, which
		// is a Zombie Wizard. Skeletons carry no `Other`, but the Baron is not
		// one, so both readings agree on the source.
		const game = setupMain(engine);
		const baron = spawn(game, "death-baron", ALICE);
		const ownZombie = spawn(game, "gutter-skulk", ALICE);
		const ownSkeleton = spawn(game, "skeletal-snake", ALICE);
		const theirZombie = spawn(game, "gutter-skulk", BOB);
		const ownBear = spawn(game, "grizzly-bears", ALICE);

		// The first alternative: another Zombie you control.
		expect(stats(game, ownZombie)).toEqual([3, 3]);
		// The second: a Skeleton you control. Dropping it leaves 2/1.
		expect(stats(game, ownSkeleton)).toEqual([3, 2]);
		// `Other` excludes the source, so the Baron does not buff itself.
		expect(stats(game, baron)).toEqual([2, 2]);
		// `YouCtrl` excludes an opponent's Zombie.
		expect(stats(game, theirZombie)).toEqual([2, 2]);
		// A creature matching neither alternative is untouched.
		expect(stats(game, ownBear)).toEqual([2, 2]);
	});

	test("Lovisa Coldeyes buffs Warriors, Berserkers, and Barbarians", () => {
		// `Affected$ Creature.Warrior,Creature.Berserker,Creature.Barbarian`:
		// three alternatives, none restricted by controller, so an opponent's
		// Warrior is buffed too. The Barbarian probe covers the LAST
		// alternative, so dropping any one of the three fails this test; no
		// vanilla Berserker imports yet to cover the middle one directly.
		const game = setupMain(engine);
		const lovisa = spawn(game, "lovisa-coldeyes", ALICE);
		const ownWarrior = spawn(game, "canyon-minotaur", ALICE);
		const theirWarrior = spawn(game, "canyon-minotaur", BOB);
		const ownBarbarian = spawn(game, "balduvian-barbarians", ALICE);
		const ownBear = spawn(game, "grizzly-bears", ALICE);

		expect(stats(game, ownWarrior)).toEqual([5, 5]);
		expect(stats(game, ownBarbarian)).toEqual([5, 4]);
		// No `YouCtrl` anywhere in the list: "each creature that's a Barbarian,
		// a Warrior, or a Berserker" reaches both players' creatures.
		expect(stats(game, theirWarrior)).toEqual([5, 5]);
		// Lovisa is a Human, not a Warrior, so she buffs neither herself nor
		// an unrelated creature.
		expect(stats(game, lovisa)).toEqual([3, 3]);
		expect(stats(game, ownBear)).toEqual([2, 2]);
	});
});
