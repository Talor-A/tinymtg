import { describe, expect, test } from "bun:test";
import { CARDS } from "../cards.ts";
import type {
	CastAction,
	GameState,
	ObjectId,
	PlayLandAction,
} from "../index.ts";
import {
	abilityId,
	activePlayer,
	createEngine,
	defineCard,
	getSnapshot,
	IllegalCastError,
	permanent,
	turnLocation,
} from "../index.ts";
import {
	ALICE,
	advanceUntil,
	BOB,
	beginFirstTurn,
	created,
	passingAgents,
	setupMain,
} from "./utils/engine-helpers.ts";

const TEST_CARD_1 = defineCard({
	id: "test-abbot-free-instant",
	name: "Test Abbot Free Instant",
	types: ["instant"],
	colors: [],
	manaCost: "zero",
	spell: {
		id: "test-abbot-free-instant-spell",
		text: "Do nothing.",
		targets: [],
		effects: [],
	},
});

const engine = createEngine([...CARDS, TEST_CARD_1]);

function castAction(card: ObjectId): CastAction {
	return { kind: "cast", card };
}

function landAction(card: ObjectId): PlayLandAction {
	return { kind: "play land", card };
}

function enterAbbot(state: GameState): ObjectId {
	const card = engine.spawnCard(state, "abbot-of-keral-keep", ALICE, "hand");
	return created(
		engine.perform(
			state,
			{
				kind: "change zone",
				object: card.id,
				from: "hand",
				destination: { zone: "battlefield", controller: ALICE },
				cause: "resolve",
			},
			passingAgents(),
		),
	);
}

function currentPT(state: GameState, id: ObjectId): [number, number] {
	const characteristics = getSnapshot(
		engine.createReadContext(state),
		id,
	).currentCharacteristics;
	if (characteristics.kind !== "creature")
		throw new Error("expected Abbot to be a creature");
	return [characteristics.power, characteristics.toughness];
}

describe("Abbot of Keral Keep", () => {
	test("has its Oracle characteristics and both printed abilities", () => {
		const state = engine.newGame();
		const abbot = engine.spawnPermanent(state, "abbot-of-keral-keep", ALICE);
		const characteristics = getSnapshot(
			engine.createReadContext(state),
			abbot.id,
		).currentCharacteristics;

		expect(characteristics).toMatchObject({
			name: "Abbot of Keral Keep",
			manaCost: { n: 1, r: 1 },
			colors: ["r"],
			supertypes: [],
			types: ["creature"],
			subtypes: ["Human", "Monk"],
			keywords: ["prowess"],
			kind: "creature",
			power: 2,
			toughness: 1,
		});
		expect(characteristics.abilities.triggered).toEqual([
			abilityId("triggered", "abbot-of-keral-keep", 0),
			abilityId("triggered", "abbot-of-keral-keep", 1),
		]);
	});

	test("exiles and permits only the top card, then prowess triggers when it is cast", () => {
		const state = setupMain(engine);
		const unrelated = engine.spawnCard(
			state,
			"test-abbot-free-instant",
			ALICE,
			"exile",
		);
		const belowTop = engine.spawnCard(state, "forest", ALICE, "library");
		const top = engine.spawnCard(
			state,
			"test-abbot-free-instant",
			ALICE,
			"library",
		);
		const abbot = enterAbbot(state);

		expect(state.pendingTriggers).toHaveLength(1);
		expect(state.pendingTriggers[0]).toMatchObject({
			source: abbot,
			triggerId: abilityId("triggered", "abbot-of-keral-keep", 0),
		});
		engine.settlePriority(state, passingAgents());

		expect(state.players[ALICE].library).toContain(belowTop.id);
		expect(state.objects.has(top.id)).toBe(false);
		const exiled = state.players[ALICE].exile.find((id) => id !== unrelated.id);
		if (exiled === undefined) throw new Error("expected the top card in exile");
		expect(engine.name(state, exiled)).toBe("Test Abbot Free Instant");
		expect(engine.getObservableActions(state, ALICE)).toContainEqual(
			castAction(exiled),
		);
		expect(engine.getObservableActions(state, ALICE)).not.toContainEqual(
			castAction(unrelated.id),
		);
		expect(engine.getObservableActions(state, BOB)).not.toContainEqual(
			castAction(exiled),
		);

		expect(state.temporaryEffects).toHaveLength(1);
		expect(state.temporaryEffects[0]).toMatchObject({
			controller: ALICE,
			duration: "until-end-of-turn",
			source: {
				origin: "ability-effect",
				category: "triggered",
				abilityId: abilityId("triggered", "abbot-of-keral-keep", 0),
				effectIndex: 1,
			},
			bindings: { "exiled-card": { type: "card", id: exiled } },
		});

		engine.executeCastAction(state, ALICE, castAction(exiled), passingAgents());
		expect(state.pendingTriggers[0]?.triggerId).toBe(
			abilityId("triggered", "abbot-of-keral-keep", 1),
		);
		engine.settlePriority(state, passingAgents());
		expect(currentPT(state, abbot)).toEqual([3, 2]);
	});

	test("permits the exiled top card to be played when it is a land", () => {
		const state = setupMain(engine);
		const top = engine.spawnCard(state, "forest", ALICE, "library");
		enterAbbot(state);
		engine.settlePriority(state, passingAgents());

		const exiled = state.players[ALICE].exile[0];
		if (exiled === undefined) throw new Error("expected Forest in exile");
		expect(state.objects.has(top.id)).toBe(false);
		expect(engine.getObservableActions(state, ALICE)).toContainEqual(
			landAction(exiled),
		);

		engine.executeLandAction(state, ALICE, landAction(exiled), passingAgents());
		expect(state.players[ALICE].landsPlayed).toBe(1);
		const forest = state.battlefield
			.map((id) => permanent(state, id))
			.find(
				(object) =>
					object.owner === ALICE && engine.name(state, object.id) === "Forest",
			);
		expect(forest?.controller).toBe(ALICE);
	});

	test("does nothing when the library is empty", () => {
		const state = engine.newGame();
		beginFirstTurn(engine, state, passingAgents());
		enterAbbot(state);
		engine.settlePriority(state, passingAgents());

		expect(state.players[ALICE].exile).toEqual([]);
		expect(state.temporaryEffects).toEqual([]);
	});

	test("the permission expires at cleanup and forced execution rejects the card", () => {
		const state = setupMain(engine);
		engine.spawnCard(state, "test-abbot-free-instant", ALICE, "library");
		enterAbbot(state);
		engine.settlePriority(state, passingAgents());
		const exiled = state.players[ALICE].exile[0];
		if (exiled === undefined) throw new Error("expected an exiled card");
		expect(engine.getObservableActions(state, ALICE)).toContainEqual(
			castAction(exiled),
		);

		advanceUntil(
			engine,
			state,
			passingAgents(),
			(next) =>
				activePlayer(next) === BOB && turnLocation(next)?.kind === "mainPhase",
		);
		expect(
			state.temporaryEffects.some(
				(effect) =>
					engine.temporaryEffectDefinition(effect)?.kind === "may-play",
			),
		).toBe(false);
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
