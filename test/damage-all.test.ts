import { describe, expect, test } from "bun:test";
import { CARDS, prismaticStrands } from "../cards.ts";
import { loadCardFixture } from "../corpus.ts";
import {
	addTemporaryEffect,
	createEngine,
	executeCastAction,
	permanent,
	settlePriority,
	spawnCard,
	spawnPermanent,
} from "../index.ts";
import {
	ALICE,
	BOB,
	passingAgents,
	setupMain,
} from "./utils/engine-helpers.ts";

const engine = createEngine([
	...CARDS,
	loadCardFixture("f/flame_rift"),
	loadCardFixture("r/rain_of_embers"),
	loadCardFixture("s/sweltering_suns"),
]);

function castAndResolve(
	state: ReturnType<typeof setupMain>,
	card: string,
	mana: { r: number },
): void {
	const spell = spawnCard(state, card, ALICE, "hand");
	state.players[ALICE].manaPool = {
		w: 0,
		u: 0,
		b: 0,
		r: mana.r,
		g: 0,
		c: 0,
	};
	executeCastAction(
		engine,
		state,
		ALICE,
		{ kind: "cast", card: spell.id },
		passingAgents(),
	);
	settlePriority(engine, state, passingAgents());
}

describe("simultaneous set-based damage", () => {
	test("Sweltering Suns damages every creature before state-based actions", () => {
		const state = setupMain(engine);
		const myr = spawnPermanent(engine, state, "darksteel-myr", ALICE);
		const bears = spawnPermanent(engine, state, "grizzly-bears", BOB);
		const relic = spawnPermanent(engine, state, "darksteel-relic", BOB);

		castAndResolve(state, "sweltering-suns", { r: 3 });

		expect(state.battlefield).toContain(myr.id);
		expect(permanent(state, myr.id).damage).toBe(3);
		expect(state.battlefield).not.toContain(bears.id);
		expect(state.battlefield).toContain(relic.id);
	});

	test("one prevention effect applies to every simultaneous recipient", () => {
		const state = setupMain(engine);
		const mine = spawnPermanent(engine, state, "grizzly-bears", ALICE);
		const theirs = spawnPermanent(engine, state, "grizzly-bears", BOB);
		addTemporaryEffect(state, ALICE, prismaticStrands("r"));

		castAndResolve(state, "sweltering-suns", { r: 3 });

		expect(permanent(state, mine.id).damage).toBe(0);
		expect(permanent(state, theirs.id).damage).toBe(0);
	});

	test("Flame Rift damages both players", () => {
		const state = setupMain(engine);

		castAndResolve(state, "flame-rift", { r: 2 });

		expect(state.players[ALICE].life).toBe(16);
		expect(state.players[BOB].life).toBe(16);
	});

	test("Rain of Embers combines creature and player recipient sets", () => {
		const state = setupMain(engine);
		const mine = spawnPermanent(engine, state, "eager-cadet", ALICE);
		const theirs = spawnPermanent(engine, state, "eager-cadet", BOB);

		castAndResolve(state, "rain-of-embers", { r: 2 });

		expect(state.battlefield).not.toContain(mine.id);
		expect(state.battlefield).not.toContain(theirs.id);
		expect(state.players[ALICE].life).toBe(19);
		expect(state.players[BOB].life).toBe(19);
	});
});
