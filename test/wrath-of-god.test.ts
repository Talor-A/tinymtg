import { describe, expect, test } from "bun:test";
import { CARDS, regenerationShield } from "../cards.ts";
import { loadCardFixture } from "../corpus.ts";
import {
	addTemporaryEffect,
	createEngine,
	defineCard,
	permanent,
} from "../index.ts";
import { assert } from "../lib/assert.ts";
import {
	ALICE,
	BOB,
	passingAgents,
	setupMain,
} from "./utils/engine-helpers.ts";

const INDESTRUCTIBLE_CAPTAIN = defineCard({
	id: "test-indestructible-captain",
	name: "Indestructible Captain",
	types: ["creature"],
	colors: ["w"],
	manaCost: { w: 2 },
	power: 2,
	toughness: 2,
	statics: [
		{
			layer: "6-ability-changing",
			text: "Other creatures you control have indestructible.",
			applies: (view, _state, source) =>
				source.kind === "permanent" &&
				source.zone === "battlefield" &&
				view.objectId !== source.id &&
				view.controller === source.controller &&
				view.currentCharacteristics.types.includes("creature"),
			modify: (view) => {
				assert(!view.keywords.includes("indestructible"));
				view.keywords.push("indestructible");
			},
		},
	],
});

const DEATH_WATCHER = defineCard({
	id: "test-wrath-death-watcher",
	name: "Death Watcher",
	types: ["creature"],
	colors: [],
	manaCost: "zero",
	power: 1,
	toughness: 1,
	triggers: [
		{
			id: "watch-deaths",
			text: "Whenever a creature dies, you gain 1 life.",
			condition: {
				kind: "change zone",
				from: "battlefield",
				to: "graveyard",
				predicate: { kind: "type", type: "creature" },
			},
			targets: [],
			effects: [
				{
					kind: "gain-life",
					subject: { kind: "relative-player", player: "you" },
					amount: 1,
				},
			],
		},
	],
});

const engine = createEngine([
	...CARDS,
	loadCardFixture("d/day_of_judgment"),
	INDESTRUCTIBLE_CAPTAIN,
	DEATH_WATCHER,
]);

function castAndResolve(
	state: ReturnType<typeof setupMain>,
	card: string,
): void {
	const spell = engine.spawnCard(state, card, ALICE, "hand");
	state.players[ALICE].manaPool = { w: 4, u: 0, b: 0, r: 0, g: 0, c: 0 };
	engine.executeCastAction(
		state,
		ALICE,
		{ kind: "cast", card: spell.id },
		passingAgents(),
	);
	engine.settlePriority(state, passingAgents());
}

function graveyardNames(
	state: ReturnType<typeof setupMain>,
	player: typeof ALICE | typeof BOB,
): string[] {
	return state.players[player].graveyard.map((id) => engine.name(state, id));
}

describe("Wrath of God", () => {
	test("destroys every creature and leaves noncreatures", () => {
		const state = setupMain(engine);
		engine.spawnPermanent(state, "grizzly-bears", ALICE);
		engine.spawnPermanent(state, "eager-cadet", BOB);
		const relic = engine.spawnPermanent(state, "darksteel-relic", BOB);

		castAndResolve(state, "wrath-of-god");

		expect(graveyardNames(state, ALICE)).toContain("Grizzly Bears");
		expect(graveyardNames(state, BOB)).toContain("Eager Cadet");
		expect(state.battlefield).toContain(relic.id);
	});

	test("uses one pre-destruction view for a departing indestructible grant", () => {
		const state = setupMain(engine);
		const captain = engine.spawnPermanent(
			state,
			"test-indestructible-captain",
			ALICE,
		);
		const bears = engine.spawnPermanent(state, "grizzly-bears", ALICE);

		castAndResolve(state, "wrath-of-god");

		expect(state.battlefield).not.toContain(captain.id);
		expect(state.battlefield).toContain(bears.id);
	});

	test("prevents regeneration while Day of Judgment permits it", () => {
		for (const [card, survives] of [
			["wrath-of-god", false],
			["day-of-judgment", true],
		] as const) {
			const state = setupMain(engine);
			const bears = engine.spawnPermanent(state, "grizzly-bears", ALICE);
			permanent(state, bears.id).damage = 1;
			addTemporaryEffect(state, ALICE, regenerationShield(bears.id));

			castAndResolve(state, card);

			expect(state.battlefield.includes(bears.id), card).toBe(survives);
			if (survives) {
				expect(permanent(state, bears.id)).toMatchObject({
					tapped: true,
					damage: 0,
				});
			}
		}
	});

	test("a departing replacement source replaces every simultaneous death", () => {
		const state = setupMain(engine);
		engine.spawnPermanent(state, "samurai-of-the-pale-curtain", ALICE);
		engine.spawnPermanent(state, "grizzly-bears", BOB);

		castAndResolve(state, "wrath-of-god");

		expect(graveyardNames(state, ALICE)).not.toContain(
			"Samurai of the Pale Curtain",
		);
		expect(graveyardNames(state, BOB)).not.toContain("Grizzly Bears");
		expect(state.players[ALICE].exile).toHaveLength(1);
		expect(state.players[BOB].exile).toHaveLength(1);
	});

	test("a departing trigger source observes every simultaneous death", () => {
		const state = setupMain(engine);
		const watcher = engine.spawnPermanent(
			state,
			"test-wrath-death-watcher",
			ALICE,
		);
		engine.spawnPermanent(state, "grizzly-bears", BOB);

		castAndResolve(state, "wrath-of-god");

		expect(state.objects.has(watcher.id)).toBe(false);
		expect(state.players[ALICE].life).toBe(22);
	});
});

describe("simultaneous state-based actions", () => {
	test("freeze replacement sources until every lethal destruction is prepared", () => {
		const state = setupMain(engine);
		const samurai = engine.spawnPermanent(
			state,
			"samurai-of-the-pale-curtain",
			ALICE,
		);
		const bears = engine.spawnPermanent(state, "grizzly-bears", BOB);
		permanent(state, samurai.id).damage = 2;
		permanent(state, bears.id).damage = 2;

		engine.checkStateBasedActions(state, passingAgents());

		expect(state.players[ALICE].exile).toHaveLength(1);
		expect(state.players[BOB].exile).toHaveLength(1);
		expect(graveyardNames(state, ALICE)).not.toContain(
			"Samurai of the Pale Curtain",
		);
		expect(graveyardNames(state, BOB)).not.toContain("Grizzly Bears");
	});
});
