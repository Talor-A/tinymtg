import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "../agents.ts";
import { CARDS } from "../cards.ts";
import type {
	Agent,
	ChoiceRequest,
	GameState,
	ObjectId,
	PlayerView,
	SyncAgent,
	TargetDef,
} from "../index.ts";
import {
	abilityId,
	createEngine,
	defineCard,
	IllegalCastError,
	InvalidChoiceAnswerError,
} from "../index.ts";
import {
	ALICE,
	BOB,
	passingAgents,
	setupMain,
} from "./utils/engine-helpers.ts";

const opponentCreatureTarget: TargetDef = {
	id: "target-creature",
	min: 1,
	max: 1,
	legal: {
		kind: "permanent",
		predicate: {
			kind: "and",
			predicates: [
				{ kind: "type", type: "creature" },
				{ kind: "controller", player: "opponent" },
			],
		},
	},
};

const TEST_CARD_1 = defineCard({
	id: "test-sacrifice-creature-spell",
	name: "Test Sacrifice Creature Spell",
	types: ["instant"],
	colors: ["b"],
	manaCost: { b: 1 },
	spell: {
		id: "spell",
		text: "As an additional cost to cast this spell, sacrifice a creature. Destroy target creature an opponent controls.",
		additionalCosts: {
			sacrifice: {
				predicate: { kind: "type", type: "creature" },
				amount: 1,
			},
		},
		targets: [opponentCreatureTarget],
		effects: [
			{
				kind: "destroy",
				subject: { kind: "target", slot: "target-creature" },
			},
		],
	},
});

const TEST_CARD_2 = defineCard({
	id: "test-additional-cost-black-source",
	name: "Test Additional Cost Black Source",
	types: ["land"],
	colors: [],
	manaCost: "none",
	activatedAbilities: [
		{
			kind: "mana",
			id: "intrinsic-mana-b",
			text: "Add {B}.",
			cost: { mana: "zero", tapSelf: true },
			effects: [{ kind: "add-mana", subject: "you", mana: { b: 1 } }],
		},
	],
});

const TEST_CARD_3 = defineCard({
	id: "test-prevent-sacrifice-move",
	name: "Test Prevent Sacrifice Move",
	types: ["artifact"],
	colors: [],
	manaCost: "zero",
	replacements: [
		{
			label: "test-prevent-sacrifice-move",
			text: "If a permanent would move from the battlefield as a sacrifice, it doesn't.",
			layer: "other",
			applies: (event) =>
				event.kind === "change zone" &&
				event.from === "battlefield" &&
				event.cause === "sacrifice",
			replace: () => [],
		},
	],
});

const TEST_CARD_4 = defineCard({
	id: "test-discard-card-spell",
	name: "Test Discard Card Spell",
	types: ["instant"],
	colors: [],
	manaCost: "zero",
	spell: {
		id: "spell",
		text: "As an additional cost to cast this spell, discard a card. You gain 1 life.",
		additionalCosts: { discard: { amount: 1 } },
		targets: [],
		effects: [
			{
				kind: "gain-life",
				subject: { kind: "relative-player", player: "you" },
				amount: 1,
			},
		],
	},
});

const engine = createEngine([
	...CARDS,
	TEST_CARD_1,
	TEST_CARD_2,
	TEST_CARD_3,
	TEST_CARD_4,
]);

function canonicalStateBytes(state: GameState): string {
	return JSON.stringify(state, (_key, value) =>
		value instanceof Map ? [...value.entries()] : value,
	);
}

function addBlackMana(state: GameState, source: ObjectId): void {
	engine.perform(
		state,
		{ kind: "add mana", source, player: ALICE, mana: { b: 1 } },
		passingAgents(),
	);
}

function castAction(card: ObjectId) {
	return { kind: "cast" as const, card };
}

function offered(state: GameState, spell: ObjectId): boolean {
	return engine
		.getObservableActions(state, ALICE)
		.some((action) => action.kind === "cast" && action.card === spell);
}

function setupCast(): {
	state: GameState;
	spell: ObjectId;
	target: ObjectId;
	sacrifice: ObjectId;
} {
	const state = setupMain(engine);
	const spell = engine.spawnCard(
		state,
		"test-sacrifice-creature-spell",
		ALICE,
		"hand",
	);
	const target = engine.spawnPermanent(state, "grizzly-bears", BOB);
	const sacrifice = engine.spawnPermanent(state, "eager-cadet", ALICE);
	addBlackMana(state, spell.id);
	return {
		state,
		spell: spell.id,
		target: target.id,
		sacrifice: sacrifice.id,
	};
}

describe("spell additional sacrifice cost", () => {
	test("offering requires mana, a legal target, and a legal sacrifice", () => {
		const state = setupMain(engine);
		const spell = engine.spawnCard(
			state,
			"test-sacrifice-creature-spell",
			ALICE,
			"hand",
		);
		const target = engine.spawnPermanent(state, "grizzly-bears", BOB);
		const sacrifice = engine.spawnPermanent(state, "eager-cadet", ALICE);

		expect(offered(state, spell.id)).toBe(false);
		addBlackMana(state, spell.id);
		expect(offered(state, spell.id)).toBe(true);

		engine.perform(
			state,
			{ kind: "sacrifice", object: sacrifice.id },
			passingAgents(),
		);
		expect(offered(state, spell.id)).toBe(false);

		engine.spawnPermanent(state, "eager-cadet", ALICE);
		engine.perform(
			state,
			{
				kind: "change zone",
				object: target.id,
				from: "battlefield",
				destination: { zone: "graveyard" },
				cause: "effect",
			},
			passingAgents(),
		);
		expect(offered(state, spell.id)).toBe(false);
	});

	test("chooses the target before sacrifice and binds both payments", () => {
		const { state, spell, target, sacrifice } = setupCast();
		const requests: ChoiceRequest["kind"][] = [];
		const alice: SyncAgent = {
			choose(view, request) {
				requests.push(request.kind);
				if (request.kind === "target") {
					return { optionId: `permanent:${target}` };
				}
				if (
					request.kind === "object" &&
					request.context.reason.kind === "sacrifice"
				) {
					expect(view.stack[0]).toMatchObject({
						kind: "spell",
						targets: [
							{
								slot: "target-creature",
								target: { type: "permanent", id: target },
							},
						],
					});
					return { optionId: String(sacrifice) };
				}
				throw new Error(`unexpected ${request.kind} choice`);
			},
		};

		engine.executeCastAction(state, ALICE, castAction(spell), [
			alice,
			new ScriptedAgent(),
		]);

		expect(requests).toEqual(["target", "object"]);
		expect(state.players[ALICE].manaPool.b).toBe(0);
		expect(state.battlefield).not.toContain(sacrifice);
		expect(state.players[ALICE].graveyard).toHaveLength(1);
		expect(state.stack[0]).toMatchObject({
			kind: "spell",
			targets: [
				{
					slot: "target-creature",
					target: { type: "permanent", id: target },
				},
			],
		});
	});

	test("a sacrifice that cannot execute rejects the cast atomically", () => {
		const { state, spell, target, sacrifice } = setupCast();
		engine.spawnPermanent(state, "test-prevent-sacrifice-move", BOB);
		const before = canonicalStateBytes(state);
		const alice = new ScriptedAgent(
			[],
			[],
			[],
			[],
			[],
			[{ type: "permanent", id: target }],
			[],
			[sacrifice],
		);

		expect(() =>
			engine.executeCastAction(state, ALICE, castAction(spell), [
				alice,
				new ScriptedAgent(),
			]),
		).toThrow(IllegalCastError);
		expect(canonicalStateBytes(state)).toBe(before);
	});

	test("an invalid sacrifice choice rejects the cast atomically", () => {
		const { state, spell, target } = setupCast();
		const before = canonicalStateBytes(state);
		const alice: SyncAgent = {
			choose(_view, request) {
				if (request.kind === "target")
					return { optionId: `permanent:${target}` };
				if (
					request.kind === "object" &&
					request.context.reason.kind === "sacrifice"
				)
					return { optionId: "999999" };
				throw new Error(`unexpected ${request.kind} choice`);
			},
		};

		expect(() =>
			engine.executeCastAction(state, ALICE, castAction(spell), [
				alice,
				new ScriptedAgent(),
			]),
		).toThrow(InvalidChoiceAnswerError);
		expect(canonicalStateBytes(state)).toBe(before);
	});

	test("a graveyard destination replacement still pays the sacrifice", () => {
		const { state, spell, target, sacrifice } = setupCast();
		engine.spawnPermanent(state, "samurai-of-the-pale-curtain", BOB);
		const alice = new ScriptedAgent(
			[],
			[],
			[],
			[],
			[],
			[{ type: "permanent", id: target }],
			[],
			[sacrifice],
		);

		expect(() =>
			engine.executeCastAction(state, ALICE, castAction(spell), [
				alice,
				new ScriptedAgent(),
			]),
		).not.toThrow();
		expect(state.players[ALICE].graveyard).toHaveLength(0);
		expect(state.players[ALICE].exile).toHaveLength(1);
		expect(state.stack).toHaveLength(1);
	});

	test("advanceWithReplay replays an async sacrifice from an untouched checkpoint", async () => {
		const checkpoint = setupMain(engine);
		const spell = engine.spawnCard(
			checkpoint,
			"test-sacrifice-creature-spell",
			ALICE,
			"hand",
		).id;
		const target = engine.spawnPermanent(checkpoint, "grizzly-bears", BOB).id;
		const sacrifice = engine.spawnPermanent(
			checkpoint,
			"eager-cadet",
			ALICE,
		).id;
		const blackSource = engine.spawnPermanent(
			checkpoint,
			"test-additional-cost-black-source",
			ALICE,
		);
		const before = canonicalStateBytes(checkpoint);
		let sacrificeChoices = 0;
		const scripted = new ScriptedAgent(
			[],
			[],
			[
				{
					kind: "activate ability",
					source: blackSource.id,
					ability: abilityId(
						"activated",
						"test-additional-cost-black-source",
						0,
					),
				},
				castAction(spell),
			],
			[],
			[],
			[{ type: "permanent", id: target }],
		);
		const alice: Agent = {
			choose(view: PlayerView, request: ChoiceRequest) {
				if (
					request.kind === "object" &&
					request.context.reason.kind === "sacrifice"
				) {
					sacrificeChoices++;
					return Promise.resolve({ optionId: String(sacrifice) });
				}
				return scripted.choose(view, request);
			},
		};

		let state = checkpoint;
		let asyncAttempts = 0;
		let asyncTranscriptKinds: ChoiceRequest["kind"][] = [];
		for (
			let advances = 0;
			advances < 30 && state.objects.has(target);
			advances++
		) {
			const inputBytes = canonicalStateBytes(state);
			const result = await engine.advanceWithReplay(state, [
				alice,
				new ScriptedAgent(),
			]);
			expect(canonicalStateBytes(state)).toBe(inputBytes);
			state = result.state;
			if (result.attempts > 1) {
				asyncAttempts = result.attempts;
				asyncTranscriptKinds = result.transcript.choices.map(
					({ request }) => request.kind,
				);
			}
		}

		expect(canonicalStateBytes(checkpoint)).toBe(before);
		expect(asyncAttempts).toBe(2);
		expect(sacrificeChoices).toBe(1);
		expect(asyncTranscriptKinds.slice(0, 4)).toEqual([
			"priorityAction",
			"priorityAction",
			"target",
			"object",
		]);
		expect(state.players[ALICE].manaPool.b).toBe(0);
		expect(state.battlefield).not.toContain(sacrifice);
		expect(state.objects.has(target)).toBe(false);
		expect(state.stack).toHaveLength(0);
	});
});

describe("spell additional discard cost", () => {
	test("does not count the spell itself as a card it can discard", () => {
		const state = setupMain(engine);
		for (const card of [...state.players[ALICE].hand]) {
			engine.perform(
				state,
				{
					kind: "change zone",
					object: card,
					from: "hand",
					destination: { zone: "exile" },
					cause: "effect",
				},
				passingAgents(),
			);
		}
		const spell = engine.spawnCard(
			state,
			"test-discard-card-spell",
			ALICE,
			"hand",
		);
		expect(offered(state, spell.id)).toBe(false);

		const fodder = engine.spawnCard(state, "forest", ALICE, "hand");
		expect(offered(state, spell.id)).toBe(true);
		const alice = new ScriptedAgent([], [], [], [], [], [], [], [fodder.id]);
		engine.executeCastAction(state, ALICE, castAction(spell.id), [
			alice,
			new ScriptedAgent(),
		]);

		expect(state.players[ALICE].hand).toHaveLength(0);
		expect(state.players[ALICE].graveyard).toHaveLength(1);
		expect(state.stack).toHaveLength(1);
	});
});
