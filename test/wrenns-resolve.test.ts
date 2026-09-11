import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CARDS } from "../cards.ts";
import { importForgeCard } from "../forge/import.ts";
import type { CastAction, GameState, ObjectId } from "../index.ts";
import {
	activePlayer,
	characteristicsFromCardDef,
	createEngine,
	IllegalCastError,
	turnLocation,
} from "../index.ts";
import {
	ALICE,
	advanceUntil,
	BOB,
	passingAgents,
	setupMain,
} from "./utils/engine-helpers.ts";

const engine = createEngine(CARDS);

const importedWrennsResolve = importForgeCard(
	readFileSync(
		join(
			import.meta.dir,
			"..",
			"cards",
			"cardsfolder",
			"w",
			"wrenns_resolve.txt",
		),
		"utf8",
	),
	{ id: "wrenns-resolve" },
);
if (!importedWrennsResolve.ok)
	throw new Error("expected Wrenn's Resolve Forge fixture to import");
const WRENNS_RESOLVE = importedWrennsResolve.card;

function castAction(card: ObjectId): CastAction {
	return { kind: "cast", card };
}

function resolveWrennsResolve(state: GameState): void {
	const card = engine.spawnCard(state, "wrenns-resolve", ALICE, "hand");
	state.players[ALICE].manaPool.c = 1;
	state.players[ALICE].manaPool.r = 1;
	engine.executeCastAction(state, ALICE, castAction(card.id), passingAgents());
	engine.settlePriority(state, passingAgents());
}

describe("Wrenn's Resolve", () => {
	test("has its Oracle characteristics and spell instructions", () => {
		expect(characteristicsFromCardDef(WRENNS_RESOLVE)).toMatchObject({
			name: "Wrenn's Resolve",
			manaCost: { n: 1, r: 1 },
			colors: ["r"],
			supertypes: [],
			types: ["sorcery"],
			subtypes: [],
			keywords: [],
			kind: "non-creature",
		});
		expect(WRENNS_RESOLVE.spell).toEqual({
			id: "spell-1",
			text: "Exile the top two cards of your library. Until the end of your next turn, you may play those cards.",
			targets: [],
			effects: [
				{
					kind: "exile-top",
					subject: "you",
					amount: 2,
					resultSlot: "remembered-exile-cards",
				},
				{
					kind: "may-play",
					object: {
						binding: "effect-result",
						slot: "remembered-exile-cards",
					},
					from: "exile",
					duration: "until-end-of-your-next-turn",
				},
			],
		});
	});

	test("exiles the top two cards and permits only its controller to play both", () => {
		const state = setupMain(engine);
		const unrelated = engine.spawnCard(
			state,
			"darksteel-relic",
			ALICE,
			"exile",
		);
		const second = engine.spawnCard(state, "forest", ALICE, "library");
		const first = engine.spawnCard(state, "darksteel-relic", ALICE, "library");

		resolveWrennsResolve(state);

		expect(state.objects.has(first.id)).toBe(false);
		expect(state.objects.has(second.id)).toBe(false);
		const [unrelatedId, firstExiled, secondExiled] = state.players[ALICE].exile;
		expect(unrelatedId).toBe(unrelated.id);
		if (firstExiled === undefined || secondExiled === undefined)
			throw new Error("expected two cards exiled by Wrenn's Resolve");
		expect([
			engine.name(state, firstExiled),
			engine.name(state, secondExiled),
		]).toEqual(["Darksteel Relic", "Forest"]);
		expect(engine.getObservableActions(state, ALICE)).toEqual(
			expect.arrayContaining([
				castAction(firstExiled),
				{ kind: "play land", card: secondExiled },
			]),
		);
		expect(engine.getObservableActions(state, ALICE)).not.toContainEqual(
			castAction(unrelated.id),
		);
		expect(engine.getObservableActions(state, BOB)).not.toContainEqual(
			castAction(firstExiled),
		);

		expect(state.temporaryEffects).toHaveLength(2);
		const permitted = state.temporaryEffects.map((effect) => {
			expect(effect).toMatchObject({
				controller: ALICE,
				duration: "until-end-of-your-next-turn",
				expiresAtEndOfTurn: null,
			});
			const subject = effect.bindings["remembered-exile-cards"];
			if (subject?.type !== "card")
				throw new Error("expected an exiled-card permission binding");
			return subject.id;
		});
		expect(permitted).toEqual([firstExiled, secondExiled]);
	});

	test("creates permission only for the one card available in a short library", () => {
		const state = setupMain(engine);
		engine.perform(
			state,
			{ kind: "mill", player: ALICE, amount: 100 },
			passingAgents(),
		);
		engine.spawnCard(state, "darksteel-relic", ALICE, "library");

		resolveWrennsResolve(state);

		expect(state.players[ALICE].library).toEqual([]);
		expect(state.players[ALICE].exile).toHaveLength(1);
		expect(state.temporaryEffects).toHaveLength(1);
		const exiled = state.players[ALICE].exile[0];
		if (exiled === undefined)
			throw new Error("expected the available top card");
		expect(engine.getObservableActions(state, ALICE)).toContainEqual(
			castAction(exiled),
		);
	});

	test("creates no permission for an empty library", () => {
		const state = setupMain(engine);
		engine.perform(
			state,
			{ kind: "mill", player: ALICE, amount: 100 },
			passingAgents(),
		);

		resolveWrennsResolve(state);

		expect(state.players[ALICE].library).toEqual([]);
		expect(state.players[ALICE].exile).toEqual([]);
		expect(state.temporaryEffects).toEqual([]);
	});

	test("expires after the controller's next turn and rejects later casting", () => {
		const state = setupMain(engine);
		engine.spawnCard(state, "forest", ALICE, "library");
		engine.spawnCard(state, "darksteel-relic", ALICE, "library");
		resolveWrennsResolve(state);
		const exiled = state.players[ALICE].exile[0];
		if (exiled === undefined) throw new Error("expected an exiled spell");

		advanceUntil(
			engine,
			state,
			passingAgents(),
			(next) =>
				activePlayer(next) === BOB && turnLocation(next)?.kind === "mainPhase",
		);
		expect(state.temporaryEffects).toHaveLength(2);

		advanceUntil(
			engine,
			state,
			passingAgents(),
			(next) =>
				activePlayer(next) === ALICE &&
				turnLocation(next)?.kind === "mainPhase",
		);
		expect(engine.getObservableActions(state, ALICE)).toContainEqual(
			castAction(exiled),
		);

		advanceUntil(engine, state, passingAgents(), (next) => {
			const location = turnLocation(next);
			return (
				activePlayer(next) === ALICE &&
				location?.kind === "step" &&
				location.step.kind === "end"
			);
		});
		expect(state.temporaryEffects).toHaveLength(2);
		engine.advance(state, passingAgents());
		expect(state.temporaryEffects).toEqual([]);

		advanceUntil(
			engine,
			state,
			passingAgents(),
			(next) =>
				activePlayer(next) === BOB && turnLocation(next)?.kind === "mainPhase",
		);
		advanceUntil(
			engine,
			state,
			passingAgents(),
			(next) =>
				activePlayer(next) === ALICE &&
				turnLocation(next)?.kind === "mainPhase",
		);
		expect(engine.getObservableActions(state, ALICE)).not.toContainEqual(
			castAction(exiled),
		);
		const before = structuredClone(state);
		expect(() =>
			engine.executeCastAction(
				state,
				ALICE,
				castAction(exiled),
				passingAgents(),
			),
		).toThrow(IllegalCastError);
		expect(state).toEqual(before);
	});
});
