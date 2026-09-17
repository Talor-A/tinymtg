import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "../agents.ts";
import { defineCard } from "../card-def.ts";
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
	advanceWithReplay,
	createEngine,
	executeCastAction,
	getObservableActions,
	IllegalCastError,
	InvalidChoiceAnswerError,
	perform,
	spawnCard,
	spawnPermanent,
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
				subjects: { kind: "target", slot: "target-creature" },
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
			manaOptions: [{ b: 1 }],
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
		additionalCosts: { discard: { kind: "chosen-card", amount: 1 } },
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

const TEST_CARD_5 = defineCard({
	id: "test-pay-life-spell",
	name: "Test Pay Life Spell",
	types: ["instant"],
	colors: [],
	manaCost: "zero",
	spell: {
		id: "spell",
		text: "As an additional cost to cast this spell, pay 3 life. You gain 1 life.",
		additionalCosts: { life: { amount: 3 } },
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

const TEST_CARD_6 = defineCard({
	id: "test-cannot-pay-life",
	name: "Test Cannot Pay Life",
	types: ["artifact"],
	colors: [],
	manaCost: "zero",
	prohibitions: [
		{
			label: "test-cannot-pay-life",
			text: "Players can't pay life to cast spells or activate abilities.",
			applies: (event) =>
				event.kind === "lose life" && event.cost !== undefined,
		},
	],
});

const TEST_CARD_7 = defineCard({
	id: "test-life-payment-watcher",
	name: "Test Life Payment Watcher",
	types: ["enchantment"],
	colors: [],
	manaCost: "zero",
	triggers: [
		{
			id: "life-payment-watcher",
			text: "Whenever you lose life, you gain 1 life.",
			condition: { kind: "lose life", player: "you" },
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
	TEST_CARD_1,
	TEST_CARD_2,
	TEST_CARD_3,
	TEST_CARD_4,
	TEST_CARD_5,
	TEST_CARD_6,
	TEST_CARD_7,
]);

function canonicalStateBytes(state: GameState): string {
	return JSON.stringify(state, (_key, value) =>
		value instanceof Map ? [...value.entries()] : value,
	);
}

function addBlackMana(state: GameState, source: ObjectId): void {
	perform(
		engine,
		state,
		{ kind: "add mana", source, player: ALICE, mana: { b: 1 } },
		passingAgents(),
	);
}

function castAction(card: ObjectId) {
	return { kind: "cast" as const, card };
}

function offered(state: GameState, spell: ObjectId): boolean {
	return getObservableActions(engine, state, ALICE).some(
		(action) => action.kind === "cast" && action.card === spell,
	);
}

function setupCast(): {
	state: GameState;
	spell: ObjectId;
	target: ObjectId;
	sacrifice: ObjectId;
} {
	const state = setupMain(engine);
	const spell = spawnCard(
		state,
		"test-sacrifice-creature-spell",
		ALICE,
		"hand",
	);
	const target = spawnPermanent(engine, state, "grizzly-bears", BOB);
	const sacrifice = spawnPermanent(engine, state, "eager-cadet", ALICE);
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
		const spell = spawnCard(
			state,
			"test-sacrifice-creature-spell",
			ALICE,
			"hand",
		);
		const target = spawnPermanent(engine, state, "grizzly-bears", BOB);
		const sacrifice = spawnPermanent(engine, state, "eager-cadet", ALICE);

		expect(offered(state, spell.id)).toBe(false);
		addBlackMana(state, spell.id);
		expect(offered(state, spell.id)).toBe(true);

		perform(
			engine,
			state,
			{ kind: "sacrifice", object: sacrifice.id },
			passingAgents(),
		);
		expect(offered(state, spell.id)).toBe(false);

		spawnPermanent(engine, state, "eager-cadet", ALICE);
		perform(
			engine,
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

		executeCastAction(engine, state, ALICE, castAction(spell), [
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
		spawnPermanent(engine, state, "test-prevent-sacrifice-move", BOB);
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
			executeCastAction(engine, state, ALICE, castAction(spell), [
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
			executeCastAction(engine, state, ALICE, castAction(spell), [
				alice,
				new ScriptedAgent(),
			]),
		).toThrow(InvalidChoiceAnswerError);
		expect(canonicalStateBytes(state)).toBe(before);
	});

	test("a graveyard destination replacement still pays the sacrifice", () => {
		const { state, spell, target, sacrifice } = setupCast();
		spawnPermanent(engine, state, "samurai-of-the-pale-curtain", BOB);
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
			executeCastAction(engine, state, ALICE, castAction(spell), [
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
		const spell = spawnCard(
			checkpoint,
			"test-sacrifice-creature-spell",
			ALICE,
			"hand",
		).id;
		const target = spawnPermanent(engine, checkpoint, "grizzly-bears", BOB).id;
		const sacrifice = spawnPermanent(
			engine,
			checkpoint,
			"eager-cadet",
			ALICE,
		).id;
		const blackSource = spawnPermanent(
			engine,
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
			const result = await advanceWithReplay(engine, state, [
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
			perform(
				engine,
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
		const spell = spawnCard(state, "test-discard-card-spell", ALICE, "hand");
		expect(offered(state, spell.id)).toBe(false);

		const fodder = spawnCard(state, "forest", ALICE, "hand");
		expect(offered(state, spell.id)).toBe(true);
		const alice = new ScriptedAgent([], [], [], [], [], [], [], [fodder.id]);
		executeCastAction(engine, state, ALICE, castAction(spell.id), [
			alice,
			new ScriptedAgent(),
		]);

		expect(state.players[ALICE].hand).toHaveLength(0);
		expect(state.players[ALICE].graveyard).toHaveLength(1);
		expect(state.stack).toHaveLength(1);
	});
});

describe("spell additional life cost", () => {
	test("requires enough life and permits paying the player's last life", () => {
		const state = setupMain(engine);
		spawnPermanent(engine, state, "test-life-payment-watcher", ALICE);
		const spell = spawnCard(state, "test-pay-life-spell", ALICE, "hand");

		state.players[ALICE].life = 2;
		expect(offered(state, spell.id)).toBe(false);
		state.players[ALICE].life = 3;
		expect(offered(state, spell.id)).toBe(true);

		executeCastAction(
			engine,
			state,
			ALICE,
			castAction(spell.id),
			passingAgents(),
		);
		expect(state.players[ALICE].life).toBe(0);
		expect(state.stack).toHaveLength(1);
		expect(state.pendingTriggers).toHaveLength(1);
		expect(state.pendingTriggers[0]?.text).toBe(
			"Whenever you lose life, you gain 1 life.",
		);
	});

	test("a prohibition rejects only cost payment and rewinds the cast", () => {
		const state = setupMain(engine);
		spawnPermanent(engine, state, "test-cannot-pay-life", BOB);
		perform(
			engine,
			state,
			{ kind: "lose life", player: ALICE, amount: 1 },
			passingAgents(),
		);
		expect(state.players[ALICE].life).toBe(19);
		const spell = spawnCard(state, "test-pay-life-spell", ALICE, "hand");
		const before = canonicalStateBytes(state);

		expect(() =>
			executeCastAction(
				engine,
				state,
				ALICE,
				castAction(spell.id),
				passingAgents(),
			),
		).toThrow(IllegalCastError);
		expect(canonicalStateBytes(state)).toBe(before);
	});
});
