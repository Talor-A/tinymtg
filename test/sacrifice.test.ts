import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "../agents.ts";
import "../cards.ts";
import {
	abilityId,
	executeAbilityAction,
	newGame,
	perform,
	registerCard,
	settlePriority,
	spawnCard,
	spawnPermanent,
} from "../index.ts";
import { ALICE, BOB, setupMain } from "./utils/engine-helpers.ts";

registerCard({
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
					selector: { kind: "type", type: "creature" },
					amount: 1,
				},
			},
			targets: [],
			effects: [{ kind: "scry", player: "you", amount: 1 }],
		},
	],
});

registerCard({
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
					selector: { kind: "type", type: "creature" },
					amount: 1,
				},
			},
			effects: [{ kind: "add-mana", player: "you", mana: { c: 2 } }],
		},
	],
});

registerCard({
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
				sacrifice: { selector: { kind: "self" }, amount: 1 },
			},
			targets: [],
			effects: [{ kind: "gain-life", player: "you", amount: 1 }],
		},
	],
});

registerCard({
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
					player: { targetSlot: "player" },
					selector: { kind: "type", type: "creature" },
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
					player: "you",
					selector: { kind: "type", type: "creature" },
					amount: 1,
				},
			],
		},
	],
});

registerCard({
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
				selector: { kind: "type", type: "creature" },
			},
			targets: [],
			effects: [{ kind: "gain-life", player: "you", amount: 1 }],
		},
	],
});

const agents = (): [ScriptedAgent, ScriptedAgent] => [
	new ScriptedAgent(),
	new ScriptedAgent(),
];

describe("sacrifice action", () => {
	test("moves a battlefield permanent to its owner's graveyard", () => {
		const state = newGame();
		const creature = spawnPermanent(state, "grizzly-bears", ALICE);

		const result = perform(
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
		const state = newGame();
		spawnPermanent(state, "samurai-of-the-pale-curtain", BOB);
		spawnPermanent(state, "test-death-watcher", ALICE);
		const creature = spawnPermanent(state, "grizzly-bears", ALICE);

		const result = perform(
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
		const state = setupMain();
		const source = spawnPermanent(state, "test-sacrifice-effect", ALICE);
		const first = spawnPermanent(state, "grizzly-bears", BOB);
		const chosen = spawnPermanent(state, "eager-cadet", BOB);
		const alice = new ScriptedAgent(
			[],
			[],
			[],
			[],
			[],
			[{ type: "player", player: BOB }],
		);
		const bob = new ScriptedAgent([], [], [], [], [], [], [], [chosen.id]);

		executeAbilityAction(
			state,
			ALICE,
			{
				kind: "activate ability",
				source: source.id,
				ability: abilityId("activated", "test-sacrifice-effect", 0),
			},
			[alice, bob],
		);
		settlePriority(state, [alice, bob]);

		expect(state.battlefield).toContain(first.id);
		expect(state.battlefield).not.toContain(chosen.id);
		expect(state.players[BOB].graveyard).toHaveLength(1);
	});

	test("can instruct a relative player to sacrifice without a player target", () => {
		const state = setupMain();
		const source = spawnPermanent(state, "test-sacrifice-effect", ALICE);
		const chosen = spawnPermanent(state, "grizzly-bears", ALICE);
		const alice = new ScriptedAgent([], [], [], [], [], [], [], [chosen.id]);
		const bob = new ScriptedAgent();

		executeAbilityAction(
			state,
			ALICE,
			{
				kind: "activate ability",
				source: source.id,
				ability: abilityId("activated", "test-sacrifice-effect", 1),
			},
			[alice, bob],
		);
		settlePriority(state, [alice, bob]);

		expect(state.battlefield).not.toContain(chosen.id);
		expect(state.players[ALICE].graveyard).toHaveLength(1);
	});
});

describe("sacrifice as an activated ability cost", () => {
	test("pays mana, then taps and sacrifices the source atomically", () => {
		const state = setupMain();
		const source = spawnPermanent(
			state,
			"test-combined-activation-cost",
			ALICE,
			{ summoningSick: false },
		);
		state.players[ALICE].manaPool.b = 1;
		const alice = new ScriptedAgent([], [], [], [], [], [], [], [source.id]);
		const bob = new ScriptedAgent();

		executeAbilityAction(
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
		settlePriority(state, [alice, bob]);
		expect(state.players[ALICE].life).toBe(21);
	});

	test("can sacrifice the ability's source and the ability still resolves", () => {
		const state = setupMain();
		const top = spawnCard(state, "forest", ALICE, "library");
		const outlet = spawnPermanent(state, "test-sacrifice-outlet", ALICE);
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

		executeAbilityAction(
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
		settlePriority(state, [alice, bob]);
		expect(state.players[ALICE].library[0]).toBe(top.id);
	});

	test("a mana ability pays the sacrifice and produces mana immediately", () => {
		const state = setupMain();
		const altar = spawnPermanent(state, "test-ashnods-altar", ALICE);
		const creature = spawnPermanent(state, "grizzly-bears", ALICE);
		const alice = new ScriptedAgent([], [], [], [], [], [], [], [creature.id]);

		executeAbilityAction(
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
		const state = setupMain();
		spawnPermanent(state, "samurai-of-the-pale-curtain", BOB);
		spawnCard(state, "forest", ALICE, "library");
		const outlet = spawnPermanent(state, "test-sacrifice-outlet", ALICE);
		const alice = new ScriptedAgent([], [], [], [], [], [], [], [outlet.id]);

		expect(() =>
			executeAbilityAction(
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
