import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "../agents.ts";
import { defineCard } from "../card-def.ts";
import { CARDS } from "../cards.ts";
import { loadCardFixture } from "../corpus.ts";
import type { GameState, ObjectId, PlayerId } from "../index.ts";
import {
	abilityId,
	createEngine,
	executeAbilityAction,
	executeCastAction,
	getObservableActions,
	newGame,
	perform,
	settlePriority,
	spawnCard,
	spawnPermanent,
} from "../index.ts";
import {
	ALICE,
	BOB,
	beginFirstTurn,
	passingAgents,
} from "./utils/engine-helpers.ts";

const TEST_CARD_1 = defineCard({
	id: "counter-test-ward",
	name: "Counter Test Ward",
	types: ["enchantment"],
	colors: [],
	manaCost: "zero",
	prohibitions: [
		{
			label: "counter-test-ward",
			text: "Spells can't be countered.",
			applies: (event, context) =>
				context.self?.zone === "battlefield" && event.kind === "counter",
		},
	],
});

const engine = createEngine([
	...CARDS,
	loadCardFixture("e/ertai_wizard_adept"),
	TEST_CARD_1,
]);

const islandMana = abilityId("activated", "island", 0);

function putGrizzlyBearsOnStack() {
	const state = newGame();
	beginFirstTurn(engine, state, passingAgents());
	const bears = spawnCard(state, "grizzly-bears", BOB, "hand");
	const moved = perform(
		engine,
		state,
		{
			kind: "change zone",
			object: bears.id,
			from: "hand",
			destination: { zone: "stack", controller: BOB, targets: [] },
			cause: "cast",
		},
		passingAgents(),
	);
	const spell = moved.created[0];
	if (spell === undefined) throw new Error("expected a spell object");
	return { state, spell };
}

describe("counter event", () => {
	test("moves a spell off the stack without resolving it", () => {
		const { state, spell } = putGrizzlyBearsOnStack();
		const result = perform(
			engine,
			state,
			{ kind: "counter", spell },
			passingAgents(),
		);

		expect(result.executed).toEqual([
			expect.objectContaining({
				kind: "change zone",
				object: spell,
				from: "stack",
				destination: { zone: "graveyard" },
				cause: "counter",
			}),
			{ kind: "counter", spell },
		]);
		expect(state.stack).toEqual([]);
		expect(state.players[BOB].graveyard).toHaveLength(1);
		expect(state.battlefield).toEqual([]);
	});

	test("is stopped by a prohibition like every other event", () => {
		const { state, spell } = putGrizzlyBearsOnStack();
		const ward = spawnPermanent(engine, state, "counter-test-ward", BOB);

		const result = perform(
			engine,
			state,
			{ kind: "counter", spell },
			passingAgents(),
		);

		expect(result.executed).toEqual([]);
		expect(state.stack).toEqual([
			expect.objectContaining({ kind: "spell", objectId: spell }),
		]);
		expect(state.objects.has(ward.id)).toBe(true);
	});
});

/** Two Islands, both tapped for mana: exactly one Counterspell's worth. */
function twoIslandsTappedFor(state: GameState, player: PlayerId): ObjectId[] {
	const islands = [
		spawnPermanent(engine, state, "island", player),
		spawnPermanent(engine, state, "island", player),
	];
	for (const island of islands) {
		executeAbilityAction(
			engine,
			state,
			player,
			{ kind: "activate ability", source: island.id, ability: islandMana },
			passingAgents(),
		);
	}
	return islands.map((island) => island.id);
}

/** Casts a Counterspell from `player`'s hand at `spell`, without using priority. */
function castCounterspellAt(
	state: GameState,
	player: PlayerId,
	spell: ObjectId,
): void {
	const counterspell = spawnCard(state, "counterspell", player, "hand");
	const caster = new ScriptedAgent();
	caster.targetChoices.push({ type: "spell", id: spell });
	const agents: [ScriptedAgent, ScriptedAgent] =
		player === ALICE
			? [caster, new ScriptedAgent()]
			: [new ScriptedAgent(), caster];
	executeCastAction(
		engine,
		state,
		player,
		{ kind: "cast", card: counterspell.id },
		agents,
	);
}

describe("Counterspell", () => {
	test("targets and counters a spell through the priority stack", () => {
		const { state, spell } = putGrizzlyBearsOnStack();
		const counterspell = spawnCard(state, "counterspell", ALICE, "hand");
		const first = spawnPermanent(engine, state, "island", ALICE);
		const second = spawnPermanent(engine, state, "island", ALICE);
		for (const island of [first, second]) {
			executeAbilityAction(
				engine,
				state,
				ALICE,
				{ kind: "activate ability", source: island.id, ability: islandMana },
				passingAgents(),
			);
		}

		expect(getObservableActions(engine, state, ALICE)).toContainEqual({
			kind: "cast",
			card: counterspell.id,
		});
		const alice = new ScriptedAgent();
		alice.targetChoices.push({ type: "spell", id: spell });
		executeCastAction(
			engine,
			state,
			ALICE,
			{ kind: "cast", card: counterspell.id },
			[alice, new ScriptedAgent()],
		);

		expect(state.stack).toHaveLength(2);
		expect(state.stack[1]).toMatchObject({
			kind: "spell",
			targets: [{ slot: "target-1", target: { type: "spell", id: spell } }],
		});

		settlePriority(engine, state, passingAgents());

		expect(state.stack).toEqual([]);
		expect(state.battlefield).toEqual([first.id, second.id]);
		expect(state.players[BOB].graveyard).toHaveLength(1);
		expect(state.players[ALICE].graveyard).toHaveLength(1);
		expect(state.log).toContainEqual(expect.stringContaining("> counter("));
	});

	test("counters a Counterspell, letting the first spell resolve", () => {
		const { state, spell } = putGrizzlyBearsOnStack();
		const aliceIslands = twoIslandsTappedFor(state, ALICE);
		const bobIslands = twoIslandsTappedFor(state, BOB);

		castCounterspellAt(state, ALICE, spell);
		const first = state.stack[1];
		if (first?.kind !== "spell") throw new Error("expected Alice's spell");
		castCounterspellAt(state, BOB, first.objectId);

		settlePriority(engine, state, passingAgents());

		// Bob's Counterspell resolved first and countered Alice's, so nothing was
		// left to stop the bears.
		expect(state.stack).toEqual([]);
		expect(state.battlefield).toHaveLength(
			aliceIslands.length + bobIslands.length + 1,
		);
		expect(state.players[ALICE].graveyard).toHaveLength(1);
		expect(state.players[BOB].graveyard).toHaveLength(1);
	});

	test("does not resolve when its target was already countered", () => {
		const { state, spell } = putGrizzlyBearsOnStack();
		const islands = [
			...twoIslandsTappedFor(state, ALICE),
			...twoIslandsTappedFor(state, ALICE),
		];

		castCounterspellAt(state, ALICE, spell);
		castCounterspellAt(state, ALICE, spell);

		settlePriority(engine, state, passingAgents());

		// CR 608.2b: the second Counterspell to resolve countered the bears, so the
		// first one is left with an illegal target and does nothing.
		expect(state.stack).toEqual([]);
		expect(state.battlefield).toEqual(islands);
		expect(state.players[ALICE].graveyard).toHaveLength(2);
		expect(state.players[BOB].graveyard).toHaveLength(1);
		expect(state.log).toContainEqual(
			expect.stringContaining("[illegal target] spell does not resolve"),
		);
	});
});

describe("Negate", () => {
	test("is unavailable when the only spell is a creature", () => {
		const { state } = putGrizzlyBearsOnStack();
		const negate = spawnCard(state, "negate", ALICE, "hand");
		twoIslandsTappedFor(state, ALICE);

		expect(getObservableActions(engine, state, ALICE)).not.toContainEqual({
			kind: "cast",
			card: negate.id,
		});
	});

	test("rejects a creature spell and counters a noncreature spell", () => {
		const { state, spell: creatureSpell } = putGrizzlyBearsOnStack();
		const counterspell = spawnCard(state, "counterspell", BOB, "hand");
		const moved = perform(
			engine,
			state,
			{
				kind: "change zone",
				object: counterspell.id,
				from: "hand",
				destination: { zone: "stack", controller: BOB, targets: [] },
				cause: "cast",
			},
			passingAgents(),
		);
		const noncreatureSpell = moved.created[0];
		if (noncreatureSpell === undefined)
			throw new Error("expected a noncreature spell object");

		const negate = spawnCard(state, "negate", ALICE, "hand");
		twoIslandsTappedFor(state, ALICE);
		expect(getObservableActions(engine, state, ALICE)).toContainEqual({
			kind: "cast",
			card: negate.id,
		});

		const illegal = new ScriptedAgent();
		illegal.targetChoices.push({ type: "spell", id: creatureSpell });
		expect(() =>
			executeCastAction(
				engine,
				state,
				ALICE,
				{ kind: "cast", card: negate.id },
				[illegal, new ScriptedAgent()],
			),
		).toThrow("legal options");
		expect(state.players[ALICE].hand).toContain(negate.id);
		expect(state.players[ALICE].manaPool.u).toBe(2);

		const legal = new ScriptedAgent();
		legal.targetChoices.push({ type: "spell", id: noncreatureSpell });
		executeCastAction(engine, state, ALICE, { kind: "cast", card: negate.id }, [
			legal,
			new ScriptedAgent(),
		]);
		settlePriority(engine, state, passingAgents());

		expect(state.stack).toEqual([]);
		expect(state.players[BOB].graveyard).toHaveLength(1);
		expect(state.players[ALICE].graveyard).toHaveLength(1);
		// The two Islands remain and the original creature spell resolves.
		expect(state.battlefield).toHaveLength(3);
	});
});

describe("Ertai, Wizard Adept", () => {
	test("counters a spell from an activated ability", () => {
		const { state, spell } = putGrizzlyBearsOnStack();
		const ertai = spawnPermanent(engine, state, "ertai-wizard-adept", ALICE, {
			summoningSick: false,
		});
		const islands = [
			...twoIslandsTappedFor(state, ALICE),
			...twoIslandsTappedFor(state, ALICE),
		];
		const ertaiCounter = abilityId("activated", "ertai-wizard-adept", 0);

		const alice = new ScriptedAgent();
		alice.targetChoices.push({ type: "spell", id: spell });
		executeAbilityAction(
			engine,
			state,
			ALICE,
			{ kind: "activate ability", source: ertai.id, ability: ertaiCounter },
			[alice, new ScriptedAgent()],
		);

		settlePriority(engine, state, passingAgents());

		expect(state.stack).toEqual([]);
		expect(state.battlefield).toEqual([ertai.id, ...islands]);
		expect(state.players[BOB].graveyard).toHaveLength(1);
	});
});
