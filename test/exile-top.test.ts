/**
 * exile-top.test.ts — exiling cards off the top of a library.
 *
 * This is mill with a different destination, so the tests assert the two are
 * the same operation: the same event shape, the same top-down order, the same
 * behaviour on a short or empty library. Only the destination zone differs.
 */

import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "../agents.ts";
import { CARDS } from "../cards.ts";
import {
	createEngine,
	defineCard,
	type GameState,
	type ObjectId,
} from "../index.ts";
import {
	ALICE,
	BOB,
	passingAgents,
	setupMain,
} from "./utils/engine-helpers.ts";

const TEST_CARD_1 = defineCard({
	id: "test-exile-top-one",
	name: "Test Exile Top One",
	types: ["instant"],
	colors: [],
	manaCost: "zero",
	spell: {
		id: "test-exile-top-one-spell",
		text: "Exile the top card of your library.",
		targets: [],
		effects: [
			{
				kind: "exile-top",
				subject: { kind: "relative-player", player: "you" },
				amount: 1,
			},
		],
	},
});

const TEST_CARD_2 = defineCard({
	id: "test-exile-top-opponent",
	name: "Test Exile Top Opponent",
	types: ["instant"],
	colors: [],
	manaCost: "zero",
	spell: {
		id: "test-exile-top-opponent-spell",
		text: "Exile the top two cards of an opponent's library.",
		targets: [],
		effects: [
			{
				kind: "exile-top",
				subject: { kind: "relative-player", player: "opponent" },
				amount: 2,
			},
		],
	},
});

const TEST_CARD_3 = defineCard({
	id: "test-exile-top-two-and-play",
	name: "Test Exile Top Two And Play",
	types: ["instant"],
	colors: [],
	manaCost: "zero",
	spell: {
		id: "test-exile-top-two-and-play-spell",
		text: "Exile the top two cards of your library. Until end of turn, you may play those cards.",
		targets: [],
		effects: [
			{
				kind: "exile-top",
				subject: { kind: "relative-player", player: "you" },
				amount: 2,
				resultSlot: "exiled-cards",
			},
			{
				kind: "may-play",
				subject: { kind: "effect-result", slot: "exiled-cards" },
				from: "exile",
				duration: "until-end-of-turn",
			},
		],
	},
});

const engine = createEngine([...CARDS, TEST_CARD_1, TEST_CARD_2, TEST_CARD_3]);

/** Bottom to top, so the last id returned is the top card. */
function library(
	state: GameState,
	player: 0 | 1,
): [ObjectId, ObjectId, ObjectId] {
	return [
		engine.spawnCard(state, "forest", player, "library").id,
		engine.spawnCard(state, "grizzly-bears", player, "library").id,
		engine.spawnCard(state, "eager-cadet", player, "library").id,
	];
}

function agents(): [ScriptedAgent, ScriptedAgent] {
	return [new ScriptedAgent(), new ScriptedAgent()];
}

describe("exile top events", () => {
	test("moves the top card of the library to its owner's exile", () => {
		const state = engine.newGame();
		const [forest, bears, cadet] = library(state, 0);

		const result = engine.perform(
			state,
			{ kind: "exile top", player: 0, amount: 1 },
			agents(),
		);

		expect(state.players[0].library).toEqual([forest, bears]);
		expect(state.players[0].exile.map((id) => engine.name(state, id))).toEqual([
			"Eager Cadet",
		]);
		// The zone change creates a new object, so the library id is retired.
		expect(state.objects.has(cadet)).toBe(false);
		expect(result.created).toEqual(state.players[0].exile);
		expect(result.executed.at(-1)).toEqual({
			kind: "exile top",
			player: 0,
			amount: 1,
		});
	});

	test("exiles from the top down", () => {
		const state = engine.newGame();
		const [forest] = library(state, 0);

		engine.perform(
			state,
			{ kind: "exile top", player: 0, amount: 2 },
			agents(),
		);

		expect(state.players[0].library).toEqual([forest]);
		expect(state.players[0].exile.map((id) => engine.name(state, id))).toEqual([
			"Eager Cadet",
			"Grizzly Bears",
		]);
	});

	test("exiles the whole library when asked for more than it holds", () => {
		const state = engine.newGame();
		library(state, 0);

		const result = engine.perform(
			state,
			{ kind: "exile top", player: 0, amount: 5 },
			agents(),
		);

		expect(state.players[0].library).toEqual([]);
		expect(state.players[0].exile.length).toBe(3);
		expect(result.created.length).toBe(3);
		expect(result.executed.at(-1)?.kind).toBe("exile top");
	});

	test("an empty library exiles nothing and the event does not happen", () => {
		const state = engine.newGame();

		const result = engine.perform(
			state,
			{ kind: "exile top", player: 0, amount: 2 },
			agents(),
		);

		expect(state.players[0].exile).toEqual([]);
		expect(result.created).toEqual([]);
		expect(result.executed).toEqual([]);
	});

	test("a nonpositive amount exiles nothing and the event does not happen", () => {
		const state = engine.newGame();
		const cards = library(state, 0);

		const result = engine.perform(
			state,
			{ kind: "exile top", player: 0, amount: 0 },
			agents(),
		);

		expect(state.players[0].library).toEqual(cards);
		expect(result.executed).toEqual([]);
	});
});

describe("exile top is mill with another destination", () => {
	test("moves the same cards mill would, into exile instead", () => {
		const milled = engine.newGame();
		library(milled, 0);
		engine.perform(milled, { kind: "mill", player: 0, amount: 2 }, agents());

		const exiled = engine.newGame();
		library(exiled, 0);
		engine.perform(
			exiled,
			{ kind: "exile top", player: 0, amount: 2 },
			agents(),
		);

		expect(
			milled.players[0].graveyard.map((id) => engine.name(milled, id)),
		).toEqual(exiled.players[0].exile.map((id) => engine.name(exiled, id)));
		expect(
			milled.players[0].library.map((id) => engine.name(milled, id)),
		).toEqual(exiled.players[0].library.map((id) => engine.name(exiled, id)));
		expect(milled.players[0].exile).toEqual([]);
		expect(exiled.players[0].graveyard).toEqual([]);
	});
});

describe("exile top as a spell effect", () => {
	test("exiles the caster's top card", () => {
		const state = setupMain(engine);
		// `setupMain` has already seeded and drawn, so the three cards below sit
		// on top of whatever the opening draw left behind.
		const seeded = [...state.players[ALICE].library];
		const [forest, bears] = library(state, ALICE);
		const spell = engine.spawnCard(state, "test-exile-top-one", ALICE, "hand");

		engine.executeCastAction(
			state,
			ALICE,
			{ kind: "cast", card: spell.id },
			passingAgents(),
		);
		engine.settlePriority(state, passingAgents());

		expect(state.players[ALICE].library).toEqual([...seeded, forest, bears]);
		expect(
			state.players[ALICE].exile.map((id) => engine.name(state, id)),
		).toEqual(["Eager Cadet"]);
	});

	test("exiles the opponent's top cards, not the caster's", () => {
		const state = setupMain(engine);
		library(state, ALICE);
		library(state, BOB);
		const alice = [...state.players[ALICE].library];
		const spell = engine.spawnCard(
			state,
			"test-exile-top-opponent",
			ALICE,
			"hand",
		);

		engine.executeCastAction(
			state,
			ALICE,
			{ kind: "cast", card: spell.id },
			passingAgents(),
		);
		engine.settlePriority(state, passingAgents());

		expect(state.players[ALICE].library).toEqual(alice);
		expect(state.players[ALICE].exile).toEqual([]);
		expect(
			state.players[BOB].exile.map((id) => engine.name(state, id)),
		).toEqual(["Eager Cadet", "Grizzly Bears"]);
	});

	test("passes every created exile card to a following play permission", () => {
		const state = setupMain(engine);
		engine.spawnCard(state, "forest", ALICE, "library");
		engine.spawnCard(state, "darksteel-relic", ALICE, "library");
		const spell = engine.spawnCard(
			state,
			"test-exile-top-two-and-play",
			ALICE,
			"hand",
		);

		engine.executeCastAction(
			state,
			ALICE,
			{ kind: "cast", card: spell.id },
			passingAgents(),
		);
		engine.settlePriority(state, passingAgents());

		const [relic, forest] = state.players[ALICE].exile;
		if (relic === undefined || forest === undefined)
			throw new Error("expected two exiled cards");
		expect(engine.name(state, relic)).toBe("Darksteel Relic");
		expect(engine.name(state, forest)).toBe("Forest");
		expect(engine.getObservableActions(state, ALICE)).toEqual(
			expect.arrayContaining([
				{ kind: "cast", card: relic },
				{ kind: "play land", card: forest },
			]),
		);
		expect(state.temporaryEffects).toHaveLength(2);
	});
});

describe("effect-result definition validation", () => {
	const card = (
		effects: NonNullable<Parameters<typeof defineCard>[0]["spell"]>["effects"],
	) => ({
		id: "test-effect-result-validation",
		name: "Test Effect Result Validation",
		types: ["sorcery" as const],
		colors: [],
		manaCost: "zero" as const,
		spell: {
			id: "spell",
			text: "Test effect-result validation.",
			targets: [],
			effects,
		},
	});

	test("rejects an effect-result consumer with no preceding producer", () => {
		expect(() =>
			defineCard(
				card([
					{
						kind: "may-play",
						subject: { kind: "effect-result", slot: "missing" },
						from: "exile",
						duration: "until-end-of-turn",
					},
				]),
			),
		).toThrow("unavailable effect result missing");
	});

	test("rejects duplicate result slots", () => {
		expect(() =>
			defineCard(
				card([
					{
						kind: "exile-top",
						subject: { kind: "relative-player", player: "you" },
						amount: 1,
						resultSlot: "cards",
					},
					{
						kind: "exile-top",
						subject: { kind: "relative-player", player: "you" },
						amount: 1,
						resultSlot: "cards",
					},
				]),
			),
		).toThrow("duplicate effect result slot cards");
	});

	test("rejects a consumer whose origin disagrees with the produced zone", () => {
		expect(() =>
			defineCard(
				card([
					{
						kind: "exile-top",
						subject: { kind: "relative-player", player: "you" },
						amount: 1,
						resultSlot: "cards",
					},
					{
						kind: "change-zone",
						subject: { kind: "effect-result", slot: "cards" },
						from: "graveyard",
						destination: { zone: "hand" },
					},
				]),
			),
		).toThrow("unavailable graveyard effect result cards");
	});

	test("does not expose a result from an optional branch to later effects", () => {
		expect(() =>
			defineCard(
				card([
					{
						kind: "may",
						decider: "you",
						effects: [
							{
								kind: "exile-top",
								subject: { kind: "relative-player", player: "you" },
								amount: 1,
								resultSlot: "optional-cards",
							},
						],
					},
					{
						kind: "may-play",
						subject: { kind: "effect-result", slot: "optional-cards" },
						from: "exile",
						duration: "until-end-of-turn",
					},
				]),
			),
		).toThrow("unavailable effect result optional-cards");
	});
});

test("targeted exile-top requires a player selector", () => {
	expect(() =>
		defineCard({
			id: "test-targeted-exile-top-selector",
			name: "Test Targeted Exile Top Selector",
			types: ["sorcery"],
			colors: [],
			manaCost: "zero",
			spell: {
				id: "spell",
				text: "Exile the top card of target player's library.",
				targets: [
					{
						id: "player",
						min: 1,
						max: 1,
						legal: { kind: "permanent" },
					},
				],
				effects: [
					{
						kind: "exile-top",
						subject: { kind: "target-player", slot: "player" },
						amount: 1,
					},
				],
			},
		}),
	).toThrow("a targeted player effect requires a player target");
});
