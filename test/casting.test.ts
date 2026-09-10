import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "../agents.ts";
import { CARDS } from "../cards.ts";
import type {
	CastAction,
	Engine,
	GameState,
	ObjectId,
	PlayerId,
	PriorityAction,
} from "../index.ts";
import {
	abilityId,
	activePlayer,
	createEngine,
	defineCard,
	IllegalCastError,
	turnLocation,
} from "../index.ts";
import {
	ALICE,
	advanceUntil,
	BOB,
	expectScriptConsumed,
	passingAgents,
} from "./utils/engine-helpers.ts";

/**
 * Forest is the only basic in the card set, so a white source is defined here
 * rather than registering a Plains as a side effect of writing tests.
 */
const TEST_CARD_1 = defineCard({
	id: "test-white-source",
	name: "Test White Source",
	types: ["land"],
	colors: [],
	manaCost: "none",
	activatedAbilities: [
		{
			kind: "mana",
			id: "intrinsic-mana-w",
			text: "Add {W}.",
			cost: { mana: "zero", tapSelf: true },
			effects: [
				{
					kind: "add-mana",
					player: "you",
					mana: { w: 1, u: 0, b: 0, r: 0, g: 0 },
				},
			],
		},
	],
});

const TEST_CARD_2 = defineCard({
	id: "test-free-instant",
	name: "Test Free Instant",
	types: ["instant"],
	colors: [],
	manaCost: "zero",
	spell: {
		id: "test-free-instant-spell",
		text: "Do nothing.",
		targets: [],
		effects: [],
	},
});

// Synthetic: isolates a temporary permission for one already-exiled card.
// It is not an implementation claim about a printed card.
const TEST_CARD_3 = defineCard({
	id: "test-may-play-from-exile",
	name: "Test May Play From Exile",
	types: ["instant"],
	colors: [],
	manaCost: "zero",
	spell: {
		id: "test-may-play-from-exile-spell",
		text: "Until end of turn, you may play target card from exile.",
		targets: [
			{
				id: "target-1",
				min: 1,
				max: 1,
				legal: { kind: "card", zone: "exile" },
			},
		],
		effects: [
			{
				kind: "may-play",
				object: { binding: "target", slot: "target-1" },
				from: "exile",
				duration: "until-end-of-turn",
			},
		],
	},
});

const TEST_CARD_4 = defineCard({
	id: "test-cast-watcher",
	name: "Test Cast Watcher",
	types: ["enchantment"],
	colors: [],
	manaCost: "zero",
	triggers: [
		{
			id: "instant-or-sorcery",
			text: "Whenever you cast an instant or sorcery spell, you gain 1 life.",
			condition: {
				kind: "cast",
				player: "you",
				predicate: {
					kind: "or",
					predicates: [
						{ kind: "type", type: "instant" },
						{ kind: "type", type: "sorcery" },
					],
				},
			},
			targets: [],
			effects: [{ kind: "gain-life", player: "you", amount: 1 }],
		},
	],
});

const TEST_CARD_5 = defineCard({
	id: "test-free-black-instant",
	name: "Test Free Black Instant",
	types: ["instant"],
	colors: ["b"],
	manaCost: "zero",
	spell: {
		id: "test-free-black-instant-spell",
		text: "Do nothing.",
		targets: [],
		effects: [],
	},
});

const TEST_CARD_6 = defineCard({
	id: "test-swamp",
	name: "Test Swamp",
	supertypes: ["basic"],
	types: ["land"],
	subtypes: ["Swamp"],
	colors: [],
	manaCost: "none",
});

const TEST_CARD_7 = defineCard({
	id: "test-free-creature",
	name: "Test Free Creature",
	types: ["creature"],
	colors: [],
	manaCost: "zero",
	power: 1,
	toughness: 1,
});

const TEST_CARD_8 = defineCard({
	id: "test-free-artifact-creature",
	name: "Test Free Artifact Creature",
	types: ["artifact", "creature"],
	colors: [],
	manaCost: "zero",
	power: 1,
	toughness: 1,
});

const TEST_CARD_9 = defineCard({
	id: "test-cast-type-watcher",
	name: "Test Cast Type Watcher",
	types: ["enchantment"],
	colors: [],
	manaCost: "zero",
	triggers: [
		{
			id: "artifact-creature",
			text: "Whenever you cast an artifact creature spell, gain 1 life.",
			condition: {
				kind: "cast",
				player: "you",
				predicate: {
					kind: "and",
					predicates: [
						{ kind: "type", type: "artifact" },
						{ kind: "type", type: "creature" },
					],
				},
			},
			targets: [],
			effects: [{ kind: "gain-life", player: "you", amount: 1 }],
		},
		{
			id: "noncreature",
			text: "Whenever you cast a noncreature spell, gain 1 life.",
			condition: {
				kind: "cast",
				player: "you",
				predicate: {
					kind: "not",
					predicate: { kind: "type", type: "creature" },
				},
			},
			targets: [],
			effects: [{ kind: "gain-life", player: "you", amount: 1 }],
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
	TEST_CARD_8,
	TEST_CARD_9,
]);

const forestMana = abilityId("activated", "forest", 0);
const whiteMana = abilityId("activated", "test-white-source", 0);

function castAction(card: ObjectId): CastAction {
	return { kind: "cast", card };
}

function seedLibraries(engine: Engine, state: GameState): void {
	for (let i = 0; i < 3; i++) {
		engine.spawnCard(state, "forest", ALICE, "library");
		engine.spawnCard(state, "forest", BOB, "library");
	}
}

/** A game advanced through the real scheduler to its first precombat main. */
function setupMain(engine: Engine): GameState {
	const state = engine.newGame();
	seedLibraries(engine, state);
	advanceUntil(engine, state, passingAgents(), (next) => {
		const location = turnLocation(next);
		return location?.kind === "mainPhase" && location.role === "precombat";
	});
	return state;
}

/**
 * Taps each source for mana through the ordinary activation entry point, the
 * same one the priority loop calls. Nothing writes to `manaPool` directly:
 * a pool a real player could not have produced would not test pool-only
 * affordability at all.
 */
function tapForMana(
	state: GameState,
	player: PlayerId,
	sources: { id: ObjectId; ability: typeof forestMana }[],
): void {
	for (const { id, ability } of sources) {
		engine.executeAbilityAction(
			state,
			player,
			{ kind: "activate ability", source: id, ability },
			passingAgents(),
		);
	}
}

function castActionsFor(state: GameState, player: PlayerId): CastAction[] {
	return engine
		.getObservableActions(state, player)
		.flatMap((action) => (action.kind === "cast" ? [action] : []));
}

describe("cast actions offered at priority", () => {
	test("a spell is offered only once the pool can pay for it", () => {
		const state = setupMain(engine);
		const bears = engine.spawnCard(state, "grizzly-bears", ALICE, "hand");
		const first = engine.spawnPermanent(state, "forest", ALICE);
		const second = engine.spawnPermanent(state, "forest", ALICE);

		expect(castActionsFor(state, ALICE)).toEqual([]);

		// {1}{G} needs two mana; one Forest is not enough.
		tapForMana(state, ALICE, [{ id: first.id, ability: forestMana }]);
		expect(castActionsFor(state, ALICE)).toEqual([]);

		tapForMana(state, ALICE, [{ id: second.id, ability: forestMana }]);
		expect(castActionsFor(state, ALICE)).toEqual([castAction(bears.id)]);
	});

	test("colored requirements are not payable by the wrong color", () => {
		const state = setupMain(engine);
		engine.spawnCard(state, "faithful-watchdog", ALICE, "hand");
		const first = engine.spawnPermanent(state, "forest", ALICE);
		const second = engine.spawnPermanent(state, "forest", ALICE);

		// {G}{W} against two green: enough mana, wrong colors.
		tapForMana(state, ALICE, [
			{ id: first.id, ability: forestMana },
			{ id: second.id, ability: forestMana },
		]);
		expect(state.players[ALICE].manaPool.g).toBe(2);
		expect(castActionsFor(state, ALICE)).toEqual([]);
	});

	test("a zero-cost spell is offered with an empty pool", () => {
		const state = setupMain(engine);
		const relic = engine.spawnCard(state, "darksteel-relic", ALICE, "hand");

		expect(state.players[ALICE].manaPool).toMatchObject({ g: 0, c: 0 });
		expect(castActionsFor(state, ALICE)).toEqual([castAction(relic.id)]);
	});

	test("a land is played, never cast, even though it is in hand", () => {
		const state = setupMain(engine);
		const forest = engine.spawnCard(state, "forest", ALICE, "hand");

		expect(castActionsFor(state, ALICE)).toEqual([]);
		expect(engine.getObservableActions(state, ALICE)).toContainEqual({
			kind: "play land",
			card: forest.id,
		});
	});

	test("a card in the opponent's hand is never offered to the caster", () => {
		const state = setupMain(engine);
		const bobsRelic = engine.spawnCard(state, "darksteel-relic", BOB, "hand");
		const alicesRelic = engine.spawnCard(
			state,
			"darksteel-relic",
			ALICE,
			"hand",
		);

		// Alice is the active player, so only she is at sorcery speed here; the
		// point is that Bob's card is absent from her menu, not that Bob has one.
		expect(castActionsFor(state, ALICE)).toEqual([castAction(alicesRelic.id)]);
		expect(castActionsFor(state, ALICE)).not.toContainEqual(
			castAction(bobsRelic.id),
		);
		// Bob is not the active player, so sorcery timing offers him nothing.
		expect(castActionsFor(state, BOB)).toEqual([]);
	});

	test("sorcery timing is enforced outside a main phase", () => {
		const state = setupMain(engine);
		const relic = engine.spawnCard(state, "darksteel-relic", ALICE, "hand");
		expect(castActionsFor(state, ALICE)).toEqual([castAction(relic.id)]);

		// Leaving the main phase closes the sorcery-speed window (CR 307.1).
		advanceUntil(engine, state, passingAgents(), (next) => {
			const location = turnLocation(next);
			return location?.kind === "step" && location.step.kind === "begin combat";
		});
		expect(castActionsFor(state, ALICE)).toEqual([]);
	});

	test("two copies of a card produce two distinguishable actions", () => {
		const state = setupMain(engine);
		const first = engine.spawnCard(state, "darksteel-relic", ALICE, "hand");
		const second = engine.spawnCard(state, "darksteel-relic", ALICE, "hand");

		const actions = castActionsFor(state, ALICE);
		expect(actions).toEqual([castAction(first.id), castAction(second.id)]);
		expect(first.id).not.toBe(second.id);
	});
});

describe("temporary permission to play one card from exile", () => {
	test("the effect controller is offered and can cast the bound card", () => {
		const state = setupMain(engine);
		const exiled = engine.spawnCard(state, "test-free-instant", BOB, "exile");
		const permission = engine.spawnCard(
			state,
			"test-may-play-from-exile",
			ALICE,
			"hand",
		);
		const agents = passingAgents();
		agents[ALICE].targetChoices.push({ type: "card", id: exiled.id });

		engine.executeCastAction(state, ALICE, castAction(permission.id), agents);
		engine.settlePriority(state, agents);

		expect(castActionsFor(state, ALICE)).toContainEqual(castAction(exiled.id));
		expect(castActionsFor(state, BOB)).not.toContainEqual(
			castAction(exiled.id),
		);
		const beforeIllegalCast = structuredClone(state);
		expect(() =>
			engine.executeCastAction(
				state,
				BOB,
				castAction(exiled.id),
				passingAgents(),
			),
		).toThrow(IllegalCastError);
		expect(state).toEqual(beforeIllegalCast);

		engine.executeCastAction(
			state,
			ALICE,
			castAction(exiled.id),
			passingAgents(),
		);
		expect(state.objects.has(exiled.id)).toBe(false);
		const entry = state.stack.at(-1);
		expect(entry).toMatchObject({ kind: "spell" });
		if (entry?.kind !== "spell") throw new Error("expected spell");
		expect(entry.objectId).not.toBe(exiled.id);
		expect(state.objects.get(entry.objectId)).toMatchObject({
			kind: "spell",
			controller: ALICE,
		});
	});

	test("the permission does not follow a card through a zone change", () => {
		const state = setupMain(engine);
		const exiled = engine.spawnCard(state, "test-free-instant", ALICE, "exile");
		const permission = engine.spawnCard(
			state,
			"test-may-play-from-exile",
			ALICE,
			"hand",
		);
		const agents = passingAgents();
		agents[ALICE].targetChoices.push({ type: "card", id: exiled.id });
		engine.executeCastAction(state, ALICE, castAction(permission.id), agents);
		engine.settlePriority(state, agents);

		const graveyard = engine.perform(
			state,
			{
				kind: "change zone",
				object: exiled.id,
				from: "exile",
				destination: { zone: "graveyard" },
				cause: "effect",
			},
			passingAgents(),
		);
		const graveyardId = graveyard.created[0];
		if (graveyardId === undefined) throw new Error("expected graveyard card");
		const returned = engine.perform(
			state,
			{
				kind: "change zone",
				object: graveyardId,
				from: "graveyard",
				destination: { zone: "exile" },
				cause: "effect",
			},
			passingAgents(),
		);
		const returnedId = returned.created[0];
		if (returnedId === undefined) throw new Error("expected exiled card");
		expect(returnedId).not.toBe(exiled.id);
		expect(castActionsFor(state, ALICE)).not.toContainEqual(
			castAction(returnedId),
		);
		expect(() =>
			engine.executeCastAction(
				state,
				ALICE,
				castAction(returnedId),
				passingAgents(),
			),
		).toThrow(IllegalCastError);
	});

	test("the permission expires during cleanup", () => {
		const state = setupMain(engine);
		const exiled = engine.spawnCard(state, "test-free-instant", ALICE, "exile");
		const permission = engine.spawnCard(
			state,
			"test-may-play-from-exile",
			ALICE,
			"hand",
		);
		const agents = passingAgents();
		agents[ALICE].targetChoices.push({ type: "card", id: exiled.id });
		engine.executeCastAction(state, ALICE, castAction(permission.id), agents);
		engine.settlePriority(state, agents);
		expect(castActionsFor(state, ALICE)).toContainEqual(castAction(exiled.id));

		advanceUntil(
			engine,
			state,
			passingAgents(),
			(next) =>
				activePlayer(next) === BOB && turnLocation(next)?.kind === "mainPhase",
		);
		expect(castActionsFor(state, ALICE)).not.toContainEqual(
			castAction(exiled.id),
		);
	});
});

describe("authoritative cast rejection", () => {
	/** Every rejection must leave canonical state byte-identical. */
	function expectAtomicRejection(
		state: GameState,
		player: PlayerId,
		action: CastAction,
	): void {
		const before = structuredClone(state);
		expect(() =>
			engine.executeCastAction(state, player, action, passingAgents()),
		).toThrow(IllegalCastError);
		expect(state).toEqual(before);
	}

	test("an unaffordable spell leaves the pool and hand untouched", () => {
		const state = setupMain(engine);
		const bears = engine.spawnCard(state, "grizzly-bears", ALICE, "hand");
		const forest = engine.spawnPermanent(state, "forest", ALICE);
		tapForMana(state, ALICE, [{ id: forest.id, ability: forestMana }]);

		expectAtomicRejection(state, ALICE, castAction(bears.id));
		// The single green mana is still floating: nothing was partially paid.
		expect(state.players[ALICE].manaPool.g).toBe(1);
		expect(state.players[ALICE].hand).toContain(bears.id);
	});

	test("rejects lands, no-cost cards, and cards outside the caster's hand", () => {
		const land = setupMain(engine);
		const forest = engine.spawnCard(land, "forest", ALICE, "hand");
		expectAtomicRejection(land, ALICE, castAction(forest.id));

		const opposing = setupMain(engine);
		const bobsRelic = engine.spawnCard(
			opposing,
			"darksteel-relic",
			BOB,
			"hand",
		);
		expectAtomicRejection(opposing, ALICE, castAction(bobsRelic.id));

		const absent = setupMain(engine);
		expectAtomicRejection(absent, ALICE, castAction(999 as ObjectId));

		const onBattlefield = setupMain(engine);
		const relic = engine.spawnPermanent(
			onBattlefield,
			"darksteel-relic",
			ALICE,
		);
		expectAtomicRejection(onBattlefield, ALICE, castAction(relic.id));
	});

	test("rejects a sorcery-speed cast outside a turn", () => {
		const state = engine.newGame();
		const relic = engine.spawnCard(state, "darksteel-relic", ALICE, "hand");
		expectAtomicRejection(state, ALICE, castAction(relic.id));
	});
});

describe("casting onto the stack", () => {
	test("emits a cast event with the caster and new spell object", () => {
		const state = setupMain(engine);
		const watcher = engine.spawnPermanent(state, "test-cast-watcher", ALICE);
		const opposingInstant = engine.spawnCard(
			state,
			"test-free-instant",
			BOB,
			"hand",
		);
		const artifact = engine.spawnCard(state, "darksteel-relic", ALICE, "hand");
		const instant = engine.spawnCard(state, "test-free-instant", ALICE, "hand");

		engine.executeCastAction(
			state,
			ALICE,
			castAction(artifact.id),
			passingAgents(),
		);
		expect(state.pendingTriggers).toHaveLength(0);

		engine.executeCastAction(
			state,
			BOB,
			castAction(opposingInstant.id),
			passingAgents(),
		);
		expect(state.pendingTriggers).toHaveLength(0);

		engine.executeCastAction(
			state,
			ALICE,
			castAction(instant.id),
			passingAgents(),
		);
		expect(state.pendingTriggers).toHaveLength(1);
		const spellEntry = state.stack.at(-1);
		expect(spellEntry?.kind).toBe("spell");
		if (spellEntry?.kind !== "spell") throw new Error("expected spell");
		expect(state.pendingTriggers[0]).toMatchObject({
			source: watcher.id,
			triggeringEvent: {
				kind: "cast",
				player: ALICE,
				spell: spellEntry.objectId,
			},
		});
	});

	test("distinguishes all-type and excluded-type cast triggers", () => {
		for (const [cardId, triggerIndex] of [
			["darksteel-relic", 1],
			["test-free-artifact-creature", 0],
		] as const) {
			const state = setupMain(engine);
			engine.spawnPermanent(state, "test-cast-type-watcher", ALICE);
			const spell = engine.spawnCard(state, cardId, ALICE, "hand");

			engine.executeCastAction(
				state,
				ALICE,
				castAction(spell.id),
				passingAgents(),
			);

			expect(state.pendingTriggers).toHaveLength(1);
			expect(state.pendingTriggers[0]?.triggerId).toBe(
				abilityId("triggered", "test-cast-type-watcher", triggerIndex),
			);
		}

		const state = setupMain(engine);
		engine.spawnPermanent(state, "test-cast-type-watcher", ALICE);
		const creature = engine.spawnCard(
			state,
			"test-free-creature",
			ALICE,
			"hand",
		);
		engine.executeCastAction(
			state,
			ALICE,
			castAction(creature.id),
			passingAgents(),
		);
		expect(state.pendingTriggers).toHaveLength(0);
	});

	test("Staff of the Death Magus matches a black spell and a controlled Swamp", () => {
		const castState = setupMain(engine);
		engine.spawnPermanent(castState, "staff-of-the-death-magus", ALICE);
		const blackSpell = engine.spawnCard(
			castState,
			"test-free-black-instant",
			ALICE,
			"hand",
		);
		engine.executeCastAction(
			castState,
			ALICE,
			castAction(blackSpell.id),
			passingAgents(),
		);
		expect(castState.pendingTriggers).toHaveLength(1);
		expect(castState.pendingTriggers[0]?.triggerId).toBe(
			abilityId("triggered", "staff-of-the-death-magus", 0),
		);

		const landState = setupMain(engine);
		engine.spawnPermanent(landState, "staff-of-the-death-magus", ALICE);
		const swamp = engine.spawnCard(landState, "test-swamp", ALICE, "hand");
		engine.executeLandAction(
			landState,
			ALICE,
			{ kind: "play land", card: swamp.id },
			passingAgents(),
		);
		expect(landState.pendingTriggers).toHaveLength(1);
		expect(landState.pendingTriggers[0]?.triggerId).toBe(
			abilityId("triggered", "staff-of-the-death-magus", 1),
		);
	});

	test("Student of Ojutai triggers only for a noncreature spell", () => {
		const noncreatureState = setupMain(engine);
		engine.spawnPermanent(noncreatureState, "student-of-ojutai", ALICE);
		const instant = engine.spawnCard(
			noncreatureState,
			"test-free-instant",
			ALICE,
			"hand",
		);
		engine.executeCastAction(
			noncreatureState,
			ALICE,
			castAction(instant.id),
			passingAgents(),
		);
		expect(noncreatureState.pendingTriggers).toHaveLength(1);
		expect(noncreatureState.pendingTriggers[0]?.triggerId).toBe(
			abilityId("triggered", "student-of-ojutai", 0),
		);

		const creatureState = setupMain(engine);
		engine.spawnPermanent(creatureState, "student-of-ojutai", ALICE);
		const creature = engine.spawnCard(
			creatureState,
			"test-free-creature",
			ALICE,
			"hand",
		);
		engine.executeCastAction(
			creatureState,
			ALICE,
			castAction(creature.id),
			passingAgents(),
		);
		expect(creatureState.pendingTriggers).toHaveLength(0);
	});

	test("Third Path Iconoclast creates its Forge-defined token", () => {
		const state = setupMain(engine);
		engine.spawnPermanent(state, "third-path-iconoclast", ALICE);
		const instant = engine.spawnCard(state, "test-free-instant", ALICE, "hand");

		engine.executeCastAction(
			state,
			ALICE,
			castAction(instant.id),
			passingAgents(),
		);
		engine.settlePriority(state, passingAgents());

		const token = state.battlefield
			.map((id) => state.objects.get(id))
			.find(
				(object) =>
					object?.kind === "permanent" &&
					object.representation.kind === "token",
			);
		expect(token).toMatchObject({
			kind: "permanent",
			representation: {
				kind: "token",
				createdValues: {
					name: "Soldier Token",
					types: ["artifact", "creature"],
					subtypes: ["Soldier"],
					power: 1,
					toughness: 1,
				},
			},
		});
	});

	test("a Forge-imported Beast Whisperer trigger resolves before its creature spell", () => {
		const state = setupMain(engine);
		engine.spawnPermanent(state, "beast-whisperer", ALICE);
		const creature = engine.spawnCard(
			state,
			"test-free-creature",
			ALICE,
			"hand",
		);
		const librarySize = state.players[ALICE].library.length;

		engine.executeCastAction(
			state,
			ALICE,
			castAction(creature.id),
			passingAgents(),
		);
		expect(state.pendingTriggers[0]?.triggerId).toBe(
			abilityId("triggered", "beast-whisperer", 0),
		);

		engine.settlePriority(state, passingAgents());
		expect(state.players[ALICE].library).toHaveLength(librarySize - 1);
		expect(state.battlefield).toHaveLength(2);
	});

	test("pays from the pool, moves to the stack, and keeps the card off the battlefield", () => {
		const state = setupMain(engine);
		const bears = engine.spawnCard(state, "grizzly-bears", ALICE, "hand");
		const first = engine.spawnPermanent(state, "forest", ALICE);
		const second = engine.spawnPermanent(state, "forest", ALICE);
		tapForMana(state, ALICE, [
			{ id: first.id, ability: forestMana },
			{ id: second.id, ability: forestMana },
		]);

		engine.executeCastAction(
			state,
			ALICE,
			castAction(bears.id),
			passingAgents(),
		);

		expect(state.players[ALICE].manaPool.g).toBe(0);
		expect(state.players[ALICE].hand).not.toContain(bears.id);
		expect(state.stack).toHaveLength(1);

		// CR 400.7: the spell on the stack is a new object.
		const entry = state.stack[0];
		expect(entry?.kind).toBe("spell");
		if (entry?.kind !== "spell") throw new Error("expected a spell entry");
		expect(entry.objectId).not.toBe(bears.id);
		expect(state.objects.get(entry.objectId)).toMatchObject({
			kind: "spell",
			controller: ALICE,
		});
	});

	test("a permanent spell resolves onto the battlefield", () => {
		const state = setupMain(engine);
		const relic = engine.spawnCard(state, "darksteel-relic", ALICE, "hand");
		const caster = new ScriptedAgent([], [], [castAction(relic.id)]);

		engine.settlePriority(state, [caster, new ScriptedAgent()]);

		expectScriptConsumed(caster);
		expect(state.stack).toHaveLength(0);
		const permanents = state.battlefield.map((id) => state.objects.get(id));
		expect(permanents).toHaveLength(1);
		expect(permanents[0]).toMatchObject({
			kind: "permanent",
			controller: ALICE,
		});
	});

	test("entry replacements apply through resolution", () => {
		const state = setupMain(engine);
		const watchdog = engine.spawnCard(
			state,
			"faithful-watchdog",
			ALICE,
			"hand",
		);
		const forest = engine.spawnPermanent(state, "forest", ALICE);
		const white = engine.spawnPermanent(state, "test-white-source", ALICE);
		tapForMana(state, ALICE, [
			{ id: forest.id, ability: forestMana },
			{ id: white.id, ability: whiteMana },
		]);

		const caster = new ScriptedAgent([], [], [castAction(watchdog.id)]);
		engine.settlePriority(state, [caster, new ScriptedAgent()]);
		expectScriptConsumed(caster);

		// Faithful Watchdog is a 0/0; without its three +1/+1 counters the
		// toughness SBA would have put it straight into the graveyard. Finding it
		// alive proves the entry replacement ran on the resolution path.
		const dog = state.battlefield
			.map((id) => state.objects.get(id))
			.find(
				(object) =>
					object?.kind === "permanent" &&
					object.representation.kind === "card" &&
					object.representation.cardId === "faithful-watchdog",
			);
		expect(dog).toMatchObject({
			counters: { "+1/+1": 3 },
			summoningSick: true,
		});
		expect(state.players[ALICE].graveyard).toHaveLength(0);
	});

	test("the whole sequence runs through one priority window", () => {
		const state = setupMain(engine);
		const bears = engine.spawnCard(state, "grizzly-bears", ALICE, "hand");
		const first = engine.spawnPermanent(state, "forest", ALICE);
		const second = engine.spawnPermanent(state, "forest", ALICE);

		// Tapping and casting are all ordinary priority actions, so a single
		// scripted sequence drives the real loop end to end.
		const actions: PriorityAction[] = [
			{ kind: "activate ability", source: first.id, ability: forestMana },
			{ kind: "activate ability", source: second.id, ability: forestMana },
			castAction(bears.id),
		];
		const caster = new ScriptedAgent([], [], actions);

		engine.settlePriority(state, [caster, new ScriptedAgent()]);

		expectScriptConsumed(caster);
		expect(state.players[ALICE].manaPool.g).toBe(0);
		expect(state.stack).toHaveLength(0);
		expect(state.objects.get(first.id)).toMatchObject({ tapped: true });
		expect(state.objects.get(second.id)).toMatchObject({ tapped: true });

		const bearsOnBattlefield = state.battlefield
			.map((id) => state.objects.get(id))
			.filter(
				(object) =>
					object?.kind === "permanent" &&
					object.representation.kind === "card" &&
					object.representation.cardId === "grizzly-bears",
			);
		expect(bearsOnBattlefield).toHaveLength(1);
	});

	test("mana left floating after casting empties as the phase ends", () => {
		const state = setupMain(engine);
		const relic = engine.spawnCard(state, "darksteel-relic", ALICE, "hand");
		const forest = engine.spawnPermanent(state, "forest", ALICE);
		tapForMana(state, ALICE, [{ id: forest.id, ability: forestMana }]);

		// A zero-cost spell spends nothing, so the green mana survives the cast
		// and is emptied by the ordinary phase boundary instead (CR 500.4).
		engine.executeCastAction(
			state,
			ALICE,
			castAction(relic.id),
			passingAgents(),
		);
		expect(state.players[ALICE].manaPool.g).toBe(1);

		engine.advance(state, passingAgents());
		expect(state.players[ALICE].manaPool.g).toBe(0);
	});
});

describe("instant and sorcery resolution", () => {
	test("effects happen and the card is put into its owner's graveyard", () => {
		const state = setupMain(engine);
		const revitalize = engine.spawnCard(state, "revitalize", ALICE, "hand");
		const forest = engine.spawnPermanent(state, "forest", ALICE);
		const white = engine.spawnPermanent(state, "test-white-source", ALICE);
		tapForMana(state, ALICE, [
			{ id: forest.id, ability: forestMana },
			{ id: white.id, ability: whiteMana },
		]);
		const startingLife = state.players[ALICE].life;
		const startingHand = state.players[ALICE].hand.length;
		const startingLibrary = state.players[ALICE].library.length;

		const caster = new ScriptedAgent([], [], [castAction(revitalize.id)]);
		engine.settlePriority(state, [caster, new ScriptedAgent()]);
		expectScriptConsumed(caster);

		// Revitalize: "You gain 3 life. Draw a card."
		expect(state.players[ALICE].life).toBe(startingLife + 3);
		expect(state.players[ALICE].library).toHaveLength(startingLibrary - 1);
		// The spell left hand and the draw replaced it, so the count is unchanged.
		expect(state.players[ALICE].hand).toHaveLength(startingHand);

		// CR 608.2m: the card goes to its owner's graveyard, not the battlefield.
		expect(state.stack).toHaveLength(0);
		expect(state.battlefield.map((id) => state.objects.get(id))).toHaveLength(
			2,
		);
		const graveyard = state.players[ALICE].graveyard.map((id) =>
			state.objects.get(id),
		);
		expect(graveyard).toHaveLength(1);
		expect(graveyard[0]).toMatchObject({
			kind: "card",
			zone: "graveyard",
			owner: ALICE,
		});
	});

	test("the spell is still on the stack while its own effects resolve", () => {
		const state = setupMain(engine);
		engine.spawnPermanent(state, "chains-of-mephistopheles", ALICE);
		const revitalize = engine.spawnCard(state, "revitalize", ALICE, "hand");
		const forest = engine.spawnPermanent(state, "forest", ALICE);
		const white = engine.spawnPermanent(state, "test-white-source", ALICE);
		tapForMana(state, ALICE, [
			{ id: forest.id, ability: forestMana },
			{ id: white.id, ability: whiteMana },
		]);

		/**
		 * Chains of Mephistopheles replaces Revitalize's draw with a discard,
		 * which asks the caster to pick a card. That question is asked partway
		 * through Revitalize's own effects, so the view handed to the agent is a
		 * direct observation of the game mid-resolution.
		 */
		const stackDuringOwnEffects: number[] = [];
		class ObservingAgent extends ScriptedAgent {
			override choose(
				view: Parameters<ScriptedAgent["choose"]>[0],
				request: Parameters<ScriptedAgent["choose"]>[1],
			) {
				if (
					request.kind === "object" &&
					request.context.reason.kind === "discard"
				)
					stackDuringOwnEffects.push(view.stack.length);
				return super.choose(view, request);
			}
		}
		const caster = new ObservingAgent([], [], [castAction(revitalize.id)]);
		engine.settlePriority(state, [caster, new ScriptedAgent()]);
		expectScriptConsumed(caster);

		// CR 608.2m: the card is put into the graveyard only as the last step of
		// resolution, so it is still on the stack while its instructions run.
		expect(stackDuringOwnEffects).toEqual([1]);
		expect(state.stack).toHaveLength(0);
		expect(state.players[ALICE].graveyard).not.toHaveLength(0);
	});

	test("an instant resolves during the opponent's turn", () => {
		const state = engine.newGame();
		seedLibraries(engine, state);
		advanceUntil(engine, state, passingAgents(), (next) => {
			const location = turnLocation(next);
			return location?.kind === "mainPhase" && location.role === "precombat";
		});
		// Alice is active on turn one, so Bob casting here proves an instant is
		// not bound by sorcery timing (CR 601.3).
		const revitalize = engine.spawnCard(state, "revitalize", BOB, "hand");
		const forest = engine.spawnPermanent(state, "forest", BOB);
		const white = engine.spawnPermanent(state, "test-white-source", BOB);
		tapForMana(state, BOB, [
			{ id: forest.id, ability: forestMana },
			{ id: white.id, ability: whiteMana },
		]);
		const startingLife = state.players[BOB].life;

		const caster = new ScriptedAgent([], [], [castAction(revitalize.id)]);
		engine.settlePriority(state, [new ScriptedAgent(), caster]);
		expectScriptConsumed(caster);

		expect(state.players[BOB].life).toBe(startingLife + 3);
		expect(state.players[BOB].graveyard).toHaveLength(1);
	});
});
