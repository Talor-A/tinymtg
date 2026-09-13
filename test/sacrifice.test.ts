import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "../agents.ts";
import { CARDS } from "../cards.ts";
import { abilityId, createEngine, defineCard } from "../index.ts";
import { ALICE, BOB, setupMain } from "./utils/engine-helpers.ts";

const TEST_CARD_1 = defineCard({
	id: "test-sacrifice-outlet",
	name: "Test Sacrifice Outlet",
	types: ["creature"],
	colors: ["b"],
	manaCost: { b: 1 },
	power: 1,
	toughness: 1,
	activatedAbilities: [
		{
			kind: "activated",
			id: "sacrifice-creature-scry",
			text: "Sacrifice a creature: Scry 1.",
			cost: {
				mana: "zero",
				tapSelf: false,
				sacrifice: {
					predicate: { kind: "type", type: "creature" },
					amount: 1,
				},
			},
			targets: [],
			effects: [
				{
					kind: "scry",
					subject: { kind: "relative-player", player: "you" },
					amount: 1,
				},
			],
		},
	],
});

const TEST_CARD_2 = defineCard({
	id: "test-ashnods-altar",
	name: "Test Ashnod's Altar",
	types: ["artifact"],
	colors: [],
	manaCost: { n: 3 },
	activatedAbilities: [
		{
			kind: "mana",
			id: "sacrifice-creature-for-mana",
			text: "Sacrifice a creature: Add {C}{C}.",
			cost: {
				mana: "zero",
				tapSelf: false,
				sacrifice: {
					predicate: { kind: "type", type: "creature" },
					amount: 1,
				},
			},
			effects: [{ kind: "add-mana", subject: "you", mana: { c: 2 } }],
		},
	],
});

const TEST_CARD_3 = defineCard({
	id: "test-combined-activation-cost",
	name: "Test Combined Activation Cost",
	types: ["creature"],
	colors: ["b"],
	manaCost: { b: 1 },
	power: 1,
	toughness: 1,
	activatedAbilities: [
		{
			kind: "activated",
			id: "mana-tap-sacrifice",
			text: "{B}, {T}, Sacrifice this creature: You gain 1 life.",
			cost: {
				mana: { b: 1 },
				tapSelf: true,
				sacrifice: { predicate: { kind: "self" }, amount: 1 },
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

const TEST_CARD_4 = defineCard({
	id: "test-sacrifice-effect",
	name: "Test Sacrifice Effect",
	types: ["artifact"],
	colors: [],
	manaCost: "zero",
	activatedAbilities: [
		{
			kind: "activated",
			id: "edict",
			text: "{T}: Target player sacrifices a creature.",
			cost: { mana: "zero", tapSelf: true },
			targets: [
				{
					id: "player",
					min: 1,
					max: 1,
					legal: { kind: "player", player: "either" },
				},
			],
			effects: [
				{
					kind: "sacrifice",
					subject: { kind: "target-player", slot: "player" },
					predicate: { kind: "type", type: "creature" },
					amount: 1,
				},
			],
		},
		{
			kind: "activated",
			id: "controller-sacrifices",
			text: "{T}: You sacrifice a creature.",
			cost: { mana: "zero", tapSelf: true },
			targets: [],
			effects: [
				{
					kind: "sacrifice",
					subject: { kind: "relative-player", player: "you" },
					predicate: { kind: "type", type: "creature" },
					amount: 1,
				},
			],
		},
	],
});

const TEST_CARD_5 = defineCard({
	id: "test-death-watcher",
	name: "Test Death Watcher",
	types: ["creature"],
	colors: ["b"],
	manaCost: { b: 1 },
	power: 1,
	toughness: 1,
	triggers: [
		{
			id: "creature-dies",
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
	TEST_CARD_1,
	TEST_CARD_2,
	TEST_CARD_3,
	TEST_CARD_4,
	TEST_CARD_5,
]);

const agents = (): [ScriptedAgent, ScriptedAgent] => [
	new ScriptedAgent(),
	new ScriptedAgent(),
];

describe("sacrifice action", () => {
	test("moves a battlefield permanent to its owner's graveyard", () => {
		const state = engine.newGame();
		const creature = engine.spawnPermanent(state, "grizzly-bears", ALICE);

		const result = engine.perform(
			state,
			{ kind: "sacrifice", object: creature.id },
			agents(),
		);

		expect(result.executed).toHaveLength(2);
		expect(result.executed[0]).toMatchObject({
			kind: "change zone",
			object: creature.id,
			from: "battlefield",
			destination: { zone: "graveyard" },
			cause: "sacrifice",
		});
		expect(result.executed[1]).toEqual({
			kind: "sacrifice",
			object: creature.id,
		});
	});

	test("is successful through Samurai of the Pale Curtain, but does not produce a dies trigger", () => {
		const state = engine.newGame();
		engine.spawnPermanent(state, "samurai-of-the-pale-curtain", BOB);
		engine.spawnPermanent(state, "test-death-watcher", ALICE);
		const creature = engine.spawnPermanent(state, "grizzly-bears", ALICE);

		const result = engine.perform(
			state,
			{ kind: "sacrifice", object: creature.id },
			agents(),
		);

		expect(result.executed).toHaveLength(2);
		expect(result.executed[0]).toMatchObject({
			kind: "change zone",
			from: "battlefield",
			destination: { zone: "exile" },
			cause: "sacrifice",
		});
		expect(result.executed[1]).toMatchObject({ kind: "sacrifice" });
		expect(state.players[ALICE].graveyard).toHaveLength(0);
		expect(state.players[ALICE].exile).toEqual(result.created);
		expect(state.pendingTriggers).toHaveLength(0);
	});
});

describe("sacrifice as an effect", () => {
	test("the affected player chooses a matching permanent without targeting it", () => {
		const state = setupMain(engine);
		const source = engine.spawnPermanent(state, "test-sacrifice-effect", ALICE);
		const first = engine.spawnPermanent(state, "grizzly-bears", BOB);
		const chosen = engine.spawnPermanent(state, "eager-cadet", BOB);
		const alice = new ScriptedAgent(
			[],
			[],
			[],
			[],
			[],
			[{ type: "player", player: BOB }],
		);
		const bob = new ScriptedAgent([], [], [], [], [], [], [], [chosen.id]);

		engine.executeAbilityAction(
			state,
			ALICE,
			{
				kind: "activate ability",
				source: source.id,
				ability: abilityId("activated", "test-sacrifice-effect", 0),
			},
			[alice, bob],
		);
		engine.settlePriority(state, [alice, bob]);

		expect(state.battlefield).toContain(first.id);
		expect(state.battlefield).not.toContain(chosen.id);
		expect(state.players[BOB].graveyard).toHaveLength(1);
	});

	test("can instruct a relative player to sacrifice without a player target", () => {
		const state = setupMain(engine);
		const source = engine.spawnPermanent(state, "test-sacrifice-effect", ALICE);
		const chosen = engine.spawnPermanent(state, "grizzly-bears", ALICE);
		const alice = new ScriptedAgent([], [], [], [], [], [], [], [chosen.id]);
		const bob = new ScriptedAgent();

		engine.executeAbilityAction(
			state,
			ALICE,
			{
				kind: "activate ability",
				source: source.id,
				ability: abilityId("activated", "test-sacrifice-effect", 1),
			},
			[alice, bob],
		);
		engine.settlePriority(state, [alice, bob]);

		expect(state.battlefield).not.toContain(chosen.id);
		expect(state.players[ALICE].graveyard).toHaveLength(1);
	});
});

describe("sacrifice as an activated ability cost", () => {
	test("pays mana, then taps and sacrifices the source atomically", () => {
		const state = setupMain(engine);
		const source = engine.spawnPermanent(
			state,
			"test-combined-activation-cost",
			ALICE,
			{ summoningSick: false },
		);
		state.players[ALICE].manaPool.b = 1;
		const alice = new ScriptedAgent([], [], [], [], [], [], [], [source.id]);
		const bob = new ScriptedAgent();

		engine.executeAbilityAction(
			state,
			ALICE,
			{
				kind: "activate ability",
				source: source.id,
				ability: abilityId("activated", "test-combined-activation-cost", 0),
			},
			[alice, bob],
		);

		expect(state.players[ALICE].manaPool.b).toBe(0);
		expect(state.battlefield).not.toContain(source.id);
		expect(state.stack).toHaveLength(1);
		engine.settlePriority(state, [alice, bob]);
		expect(state.players[ALICE].life).toBe(21);
	});

	test("can sacrifice the ability's source and the ability still resolves", () => {
		const state = setupMain(engine);
		const top = engine.spawnCard(state, "forest", ALICE, "library");
		const outlet = engine.spawnPermanent(state, "test-sacrifice-outlet", ALICE);
		const alice = new ScriptedAgent(
			[],
			[],
			[],
			[],
			[],
			[],
			[{ top: [], bottom: [top.id] }],
			[outlet.id],
		);
		const bob = new ScriptedAgent();

		engine.executeAbilityAction(
			state,
			ALICE,
			{
				kind: "activate ability",
				source: outlet.id,
				ability: abilityId("activated", "test-sacrifice-outlet", 0),
			},
			[alice, bob],
		);

		expect(state.battlefield).not.toContain(outlet.id);
		expect(state.stack).toHaveLength(1);
		engine.settlePriority(state, [alice, bob]);
		expect(state.players[ALICE].library[0]).toBe(top.id);
	});

	test("a mana ability pays the sacrifice and produces mana immediately", () => {
		const state = setupMain(engine);
		const altar = engine.spawnPermanent(state, "test-ashnods-altar", ALICE);
		const creature = engine.spawnPermanent(state, "grizzly-bears", ALICE);
		const alice = new ScriptedAgent([], [], [], [], [], [], [], [creature.id]);

		engine.executeAbilityAction(
			state,
			ALICE,
			{
				kind: "activate ability",
				source: altar.id,
				ability: abilityId("activated", "test-ashnods-altar", 0),
			},
			[alice, new ScriptedAgent()],
		);

		expect(state.players[ALICE].manaPool.c).toBe(2);
		expect(state.stack).toHaveLength(0);
		expect(state.battlefield).not.toContain(creature.id);
	});

	test("Samurai of the Pale Curtain changes the destination without making the cost unpaid", () => {
		const state = setupMain(engine);
		engine.spawnPermanent(state, "samurai-of-the-pale-curtain", BOB);
		engine.spawnCard(state, "forest", ALICE, "library");
		const outlet = engine.spawnPermanent(state, "test-sacrifice-outlet", ALICE);
		const alice = new ScriptedAgent([], [], [], [], [], [], [], [outlet.id]);

		expect(() =>
			engine.executeAbilityAction(
				state,
				ALICE,
				{
					kind: "activate ability",
					source: outlet.id,
					ability: abilityId("activated", "test-sacrifice-outlet", 0),
				},
				[alice, new ScriptedAgent()],
			),
		).not.toThrow();
		expect(state.players[ALICE].graveyard).toHaveLength(0);
		expect(state.players[ALICE].exile).toHaveLength(1);
		expect(state.stack).toHaveLength(1);
	});
});
