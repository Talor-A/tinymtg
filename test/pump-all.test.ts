import { describe, expect, test } from "bun:test";
import { CARDS } from "../cards.ts";
import { loadCardFixture } from "../corpus.ts";
import { createEngine, getSnapshot } from "../index.ts";
import { assert } from "../lib/assert.ts";
import {
	ALICE,
	BOB,
	passingAgents,
	setupMain,
} from "./utils/engine-helpers.ts";

const engine = createEngine([
	...CARDS,
	loadCardFixture("g/glorious_charge"),
	loadCardFixture("l/languish"),
	loadCardFixture("m/make_a_stand"),
]);

function castAndResolve(
	state: ReturnType<typeof setupMain>,
	card: string,
	mana: { w?: number; b?: number },
): void {
	const spell = engine.spawnCard(state, card, ALICE, "hand");
	state.players[ALICE].manaPool = {
		w: mana.w ?? 0,
		u: 0,
		b: mana.b ?? 0,
		r: 0,
		g: 0,
		c: 0,
	};
	engine.executeCastAction(
		state,
		ALICE,
		{ kind: "cast", card: spell.id },
		passingAgents(),
	);
	engine.settlePriority(state, passingAgents());
}

function powerAndToughness(
	state: ReturnType<typeof setupMain>,
	object: ReturnType<typeof engine.spawnPermanent>,
): [number, number] {
	const snapshot = getSnapshot(engine.createReadContext(state), object.id);
	assert(snapshot.kind === "permanent");
	assert(snapshot.currentCharacteristics.kind === "creature");
	return [
		snapshot.currentCharacteristics.power,
		snapshot.currentCharacteristics.toughness,
	];
}

describe("set-based temporary effects", () => {
	test("Glorious Charge captures only controlled creatures present at resolution", () => {
		const state = setupMain(engine);
		const bears = engine.spawnPermanent(state, "grizzly-bears", ALICE);
		const opponent = engine.spawnPermanent(state, "eager-cadet", BOB);

		castAndResolve(state, "glorious-charge", { w: 2 });

		expect(powerAndToughness(state, bears)).toEqual([3, 3]);
		expect(powerAndToughness(state, opponent)).toEqual([1, 1]);
		const later = engine.spawnPermanent(state, "eager-cadet", ALICE);
		expect(powerAndToughness(state, later)).toEqual([1, 1]);
	});

	test("Languish reduces every creature and bypasses indestructible", () => {
		const state = setupMain(engine);
		const relic = engine.spawnPermanent(state, "darksteel-relic", ALICE);
		engine.spawnPermanent(state, "darksteel-myr", ALICE);
		engine.spawnPermanent(state, "grizzly-bears", BOB);

		castAndResolve(state, "languish", { b: 4 });

		expect(state.battlefield).toEqual([relic.id]);
	});

	test("Make a Stand grants indestructible to its captured creatures", () => {
		const state = setupMain(engine);
		const bears = engine.spawnPermanent(state, "grizzly-bears", ALICE);

		castAndResolve(state, "make-a-stand", { w: 3 });
		engine.perform(
			state,
			{ kind: "destroy", object: bears.id, noRegen: false },
			passingAgents(),
		);

		expect(state.battlefield).toContain(bears.id);
		expect(powerAndToughness(state, bears)).toEqual([3, 2]);
	});
});
