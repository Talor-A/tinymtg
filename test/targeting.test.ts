import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "../agents.ts";
import { defineCard } from "../card-def.ts";
import { CARDS } from "../cards.ts";
import { priorityOptionId } from "../choices.ts";
import {
	type Agent,
	abilityId,
	advanceWithReplay,
	buildPlayerView,
	ChoiceController,
	ChoicePendingError,
	ChoiceReplayMismatchError,
	createEngine,
	createReadContext,
	type EntityRef,
	executeCastAction,
	type GameState,
	getObservableActions,
	getSnapshot,
	IllegalCastError,
	InvalidChoiceAnswerError,
	type LayerSubject,
	newGame,
	type ObjectId,
	type ObjectPredicateDef,
	objectMatchesPredicate,
	perform,
	permanent,
	type SyncAgent,
	settlePriority,
	spawnCard,
	spawnPermanent,
	type TargetBindings,
	type TargetDef,
	turnLocation,
} from "../index.ts";
import { assert, assertDefined } from "./../lib/assert.ts";
import {
	advanceUntil,
	loadCardFixture,
	newInProgressGame,
	passingAgents,
} from "./utils/engine-helpers.ts";

const FIXTURE_CARDS = [
	"m/murder",
	"l/lightning_bolt",
	"s/sorins_thirst",
	"d/doom_blade",
	"p/prodigal_sorcerer",
	"f/flametongue_kavu",
	"m/manic_vandal",
].map(loadCardFixture);

const TEST_CARD_1 = defineCard({
	id: "target-test-replace-cast",
	name: "Target Test Replace Cast",
	types: ["artifact"],
	colors: [],
	manaCost: "zero",
	replacements: [
		{
			label: "target-test-replace-cast",
			text: "If a card would move from a hand to the stack to be cast, it doesn't.",
			layer: "other",
			applies: (event) =>
				event.kind === "change zone" &&
				event.from === "hand" &&
				event.destination.zone === "stack" &&
				event.cause === "cast",
			replace: () => [],
		},
	],
});

function canonicalStateBytes(state: GameState): string {
	return JSON.stringify(state, (_key, value) =>
		value instanceof Map ? [...value.entries()] : value,
	);
}

function announcement(source: ObjectId) {
	return { announcing: "spell" as const, source };
}

const creatureTarget: TargetDef = {
	id: "target-1",
	min: 1,
	max: 1,
	legal: { kind: "permanent", predicate: { kind: "type", type: "creature" } },
};

describe("target predicates", () => {
	test("each predicate kind reads the object's current characteristics", () => {
		const state = newGame();
		const bears = spawnPermanent(engine, state, "grizzly-bears", 0);
		const swamp = spawnPermanent(engine, state, "swamp", 1);
		const blocker = spawnPermanent(engine, state, "grizzly-bears", 1);
		const ownedCard = spawnCard(state, "grizzly-bears", 0, "graveyard");
		permanent(state, bears.id).attacking = true;
		permanent(state, blocker.id).blocking = true;
		const mine = { controller: 0 as const, source: bears.id };

		const matches = (predicate: ObjectPredicateDef, id: ObjectId) => {
			const snapshot = getSnapshot(createReadContext(engine, state), id);
			return objectMatchesPredicate(predicate, snapshot, mine);
		};

		expect(matches({ kind: "self" }, bears.id)).toBe(true);
		expect(matches({ kind: "self" }, swamp.id)).toBe(false);
		expect(matches({ kind: "attacking" }, bears.id)).toBe(true);
		expect(matches({ kind: "attacking" }, swamp.id)).toBe(false);
		expect(matches({ kind: "blocking" }, blocker.id)).toBe(true);
		expect(matches({ kind: "blocking" }, bears.id)).toBe(false);
		expect(matches({ kind: "type", type: "creature" }, bears.id)).toBe(true);
		expect(matches({ kind: "type", type: "creature" }, swamp.id)).toBe(false);
		expect(matches({ kind: "subtype", subtype: "Bear" }, bears.id)).toBe(true);
		expect(matches({ kind: "subtype", subtype: "Bear" }, swamp.id)).toBe(false);
		expect(matches({ kind: "supertype", supertype: "basic" }, swamp.id)).toBe(
			true,
		);
		expect(matches({ kind: "supertype", supertype: "basic" }, bears.id)).toBe(
			false,
		);
		expect(matches({ kind: "color", color: "g" }, bears.id)).toBe(true);
		expect(matches({ kind: "color", color: "g" }, swamp.id)).toBe(false);
		expect(matches({ kind: "controller", player: "you" }, bears.id)).toBe(true);
		expect(matches({ kind: "controller", player: "you" }, swamp.id)).toBe(
			false,
		);
		expect(matches({ kind: "controller", player: "opponent" }, swamp.id)).toBe(
			true,
		);
		expect(matches({ kind: "owner", player: "you" }, ownedCard.id)).toBe(true);
		expect(matches({ kind: "owner", player: "opponent" }, ownedCard.id)).toBe(
			false,
		);
		expect(matches({ kind: "controller", player: "you" }, ownedCard.id)).toBe(
			false,
		);
		expect(
			matches(
				{ kind: "not", predicate: { kind: "color", color: "b" } },
				bears.id,
			),
		).toBe(true);
		expect(
			matches(
				{
					kind: "and",
					predicates: [
						{ kind: "type", type: "creature" },
						{ kind: "controller", player: "you" },
					],
				},
				bears.id,
			),
		).toBe(true);
		expect(
			matches(
				{
					kind: "and",
					predicates: [
						{ kind: "type", type: "creature" },
						{ kind: "controller", player: "opponent" },
					],
				},
				bears.id,
			),
		).toBe(false);
		expect(
			matches(
				{
					kind: "or",
					predicates: [
						{ kind: "type", type: "land" },
						{ kind: "type", type: "creature" },
					],
				},
				swamp.id,
			),
		).toBe(true);

		// Grizzly Bears is a 2/2, so each comparator has a side to fall on.
		expect(
			matches({ kind: "power", comparison: "exactly", value: 2 }, bears.id),
		).toBe(true);
		expect(
			matches({ kind: "power", comparison: "at least", value: 3 }, bears.id),
		).toBe(false);
		expect(
			matches({ kind: "power", comparison: "at most", value: 2 }, bears.id),
		).toBe(true);
		expect(
			matches(
				{ kind: "toughness", comparison: "at least", value: 2 },
				bears.id,
			),
		).toBe(true);
		expect(
			matches(
				{ kind: "toughness", comparison: "greater than", value: 2 },
				bears.id,
			),
		).toBe(false);

		// The swamp enters untapped. Tapping it goes through the engine rather
		// than assigning the field: a derived view is cached per state
		// revision, so a direct mutation would leave `matches` reading a stale
		// snapshot and the assertion would prove nothing.
		expect(matches({ kind: "tapped" }, swamp.id)).toBe(false);
		perform(
			engine,
			state,
			{ kind: "tap", objects: [swamp.id] },
			passingAgents(),
		);
		expect(matches({ kind: "tapped" }, swamp.id)).toBe(true);

		// Color counts (CR 105.2a-c). Grizzly Bears is mono-green; a Swamp has
		// no mana cost and so no colors at all.
		expect(matches({ kind: "color", color: "monocolor" }, bears.id)).toBe(true);
		expect(matches({ kind: "color", color: "multicolor" }, bears.id)).toBe(
			false,
		);
		expect(matches({ kind: "color", color: "colorless" }, bears.id)).toBe(
			false,
		);
		expect(matches({ kind: "color", color: "colorless" }, swamp.id)).toBe(true);
		expect(matches({ kind: "color", color: "monocolor" }, swamp.id)).toBe(
			false,
		);
	});

	test("a noncreature has no power or toughness to compare", () => {
		// CR 208.3: a noncreature permanent has no power or toughness, so no
		// comparison against one holds -- not even "other than", which would
		// otherwise be true of every number.
		//
		// This is reached by ordinary cards, not only by a malformed selector.
		// Exorcise targets "artifact, enchantment, or creature with power 4 or
		// greater", which lowers to an `or`; testing an artifact against it
		// asks this question of a noncreature every time.
		const state = newGame();
		const artifact = spawnPermanent(
			engine,
			state,
			"target-test-replace-cast",
			0,
		);
		const bears = spawnPermanent(engine, state, "grizzly-bears", 0);
		const matches = (predicate: ObjectPredicateDef, id: ObjectId) =>
			objectMatchesPredicate(
				predicate,
				getSnapshot(createReadContext(engine, state), id),
				{ controller: 0 as const, source: bears.id },
			);

		for (const comparison of [
			"at least",
			"greater than",
			"at most",
			"less than",
			"exactly",
			"other than",
		] as const) {
			expect(
				matches({ kind: "power", comparison, value: 0 }, artifact.id),
			).toBe(false);
			expect(
				matches({ kind: "toughness", comparison, value: 0 }, artifact.id),
			).toBe(false);
		}

		// Exorcise's whole selector: the artifact is legal on its own branch,
		// and reaching the power branch does not disturb that.
		const exorcise: ObjectPredicateDef = {
			kind: "or",
			predicates: [
				{ kind: "type", type: "artifact" },
				{ kind: "type", type: "enchantment" },
				{
					kind: "and",
					predicates: [
						{ kind: "type", type: "creature" },
						{ kind: "power", comparison: "at least", value: 4 },
					],
				},
			],
		};
		expect(matches(exorcise, artifact.id)).toBe(true);
		expect(matches(exorcise, bears.id)).toBe(false);
	});

	test("the token predicate reads each object kind's representation", () => {
		const state = newGame();
		const cardPermanent = spawnPermanent(engine, state, "grizzly-bears", 0);
		const tokenPermanent = spawnPermanent(engine, state, "grizzly-bears", 0, {
			token: true,
		});
		const leavingToken = spawnPermanent(engine, state, "grizzly-bears", 0, {
			token: true,
		});
		const graveyardCard = spawnCard(state, "grizzly-bears", 0, "graveyard");
		const spellCard = spawnCard(state, "murder", 0, "hand");

		// A token keeps being a token off the battlefield, until the state-based
		// action that removes it (CR 704.5d) gets a chance to run.
		perform(
			engine,
			state,
			{
				kind: "change zone",
				object: leavingToken.id,
				from: "battlefield",
				destination: { zone: "graveyard" },
				cause: "destroy",
			},
			passingAgents(),
		);
		const graveyardToken = state.players[0].graveyard.at(-1);
		assertDefined(graveyardToken);

		perform(
			engine,
			state,
			{
				kind: "change zone",
				object: spellCard.id,
				from: "hand",
				destination: {
					zone: "stack",
					controller: 0,
					targets: [
						{
							slot: "target-1",
							target: { type: "permanent", id: cardPermanent.id },
						},
					],
				},
				cause: "cast",
			},
			passingAgents(),
		);
		const spell = state.stack.at(-1);
		assert(spell?.kind === "spell", "expected a spell on the stack");

		const isToken = (id: ObjectId) =>
			objectMatchesPredicate(
				{ kind: "token" },
				getSnapshot(createReadContext(engine, state), id),
				{ controller: 0, source: null },
			);

		expect(isToken(tokenPermanent.id)).toBe(true);
		expect(isToken(graveyardToken)).toBe(true);
		expect(isToken(cardPermanent.id)).toBe(false);
		expect(isToken(graveyardCard.id)).toBe(false);
		expect(isToken(spell.objectId)).toBe(false);
	});

	test("the layer walk hands a static ability the canonical object", () => {
		const state = newGame();
		spawnPermanent(engine, state, "target-test-subject-observer", 0);
		const attacker = spawnPermanent(engine, state, "grizzly-bears", 0, {
			token: true,
		});
		const blocker = spawnPermanent(engine, state, "grizzly-bears", 1);
		permanent(state, attacker.id).attacking = true;
		permanent(state, blocker.id).blocking = true;

		OBSERVED_LAYER_SUBJECTS.clear();
		const read = createReadContext(engine, state);
		for (const id of [attacker.id, blocker.id]) {
			// The read context evaluates characteristics lazily, so the observer only
			// runs once this object's snapshot is demanded.
			getSnapshot(read, id);
			const subject = OBSERVED_LAYER_SUBJECTS.get(id);
			assertDefined(subject, "the layer walk never offered this object");
			const canonical = state.objects.get(id);
			assertDefined(canonical, "the object left canonical state");
			// The subject is the object out of canonical state, not a projection of
			// it, so a static ability can narrow on `kind` and read exact fields.
			expect(subject.object).toBe(canonical);
		}

		const attackerObject = OBSERVED_LAYER_SUBJECTS.get(attacker.id)?.object;
		const blockerObject = OBSERVED_LAYER_SUBJECTS.get(blocker.id)?.object;
		assert(attackerObject?.kind === "permanent");
		assert(blockerObject?.kind === "permanent");
		expect(attackerObject.attacking).toBe(true);
		expect(blockerObject.blocking).toBe(true);
		expect(attackerObject.representation.kind).toBe("token");
		expect(blockerObject.representation.kind).toBe("card");
	});
});

describe("target bindings and choices", () => {
	test("zone movement installs detached bindings visible to both players", () => {
		const state = newGame();
		const spell = spawnCard(state, "murder", 0, "hand");
		const creature = spawnPermanent(engine, state, "grizzly-bears", 1);
		const targets: TargetBindings = [
			{ slot: "target-1", target: { type: "permanent", id: creature.id } },
		];
		perform(
			engine,
			state,
			{
				kind: "change zone",
				object: spell.id,
				from: "hand",
				destination: { zone: "stack", controller: 0, targets: targets },
				cause: "cast",
			},
			passingAgents(),
		);
		const entry = state.stack[0];
		if (entry?.kind !== "spell") throw new Error("expected spell");
		expect(entry.objectId).not.toBe(spell.id);
		expect(entry.targets).toEqual(targets);
		expect(entry.targets).not.toBe(targets);
		for (const player of [0, 1] as const) {
			const view = buildPlayerView(engine, state, player);
			expect(view.stack[0]).toMatchObject({ targets });
			expect(JSON.parse(JSON.stringify(view)).stack[0].targets).toEqual(
				targets,
			);
		}
		const cloned = structuredClone(state);
		expect(buildPlayerView(engine, cloned, 1).stack[0]).toMatchObject({
			targets,
		});
	});

	test("target choices replay and reject a changed candidate list", () => {
		const state = newGame();
		const spell = spawnCard(state, "murder", 0, "hand");
		const creature = spawnPermanent(engine, state, "grizzly-bears", 1);
		const target: EntityRef = { type: "permanent", id: creature.id };
		const controller = ChoiceController.record(engine, passingAgents());
		expect(
			controller.chooseTarget(
				state,
				0,
				announcement(spell.id),
				creatureTarget,
				[target],
			),
		).toEqual(target);
		const transcript = JSON.parse(JSON.stringify(controller.transcript()));
		const replay = ChoiceController.replay(engine, transcript);
		expect(
			replay.chooseTarget(state, 0, announcement(spell.id), creatureTarget, [
				target,
			]),
		).toEqual(target);
		replay.assertComplete();
		expect(() =>
			ChoiceController.replay(engine, transcript).chooseTarget(
				state,
				0,
				announcement(spell.id),
				creatureTarget,
				[{ type: "player", player: 1 }],
			),
		).toThrow(ChoiceReplayMismatchError);
	});
});

// Synthetic: reproduces Giant Growth's shape (a targeted temporary P/T spell
// effect) to check the engine's own pre-payment defense in
// requiredTargetDefinition. The importer rejects Giant Growth's real definition
// outright (see test/forge-import.test.ts); this is not a claim that Giant
// Growth is supported.
const TEST_CARD_2 = defineCard({
	id: "target-test-deferred-pt",
	name: "Test Deferred P/T",
	types: ["instant"],
	colors: ["g"],
	manaCost: { g: 1 },
	spell: {
		id: "spell",
		text: "Target creature gets +3/+3 until end of turn.",
		targets: [creatureTarget],
		effects: [
			{
				kind: "modify-pt",
				subject: { kind: "target", slot: "target-1" },
				power: 3,
				toughness: 3,
				duration: "until-end-of-turn",
			},
		],
	},
});
// Synthetic fixture isolates a layer-4 change without adding another card mechanic.
const TEST_CARD_3 = defineCard({
	id: "target-test-remove-creature-type",
	name: "Test creature type removal",
	types: ["enchantment"],
	colors: [],
	manaCost: "zero",
	statics: [
		{
			kind: "characteristic",
			text: "Creatures are noncreature artifacts.",
			applies: (v) => v.currentCharacteristics.types.includes("creature"),
			effects: [
				{
					layer: "4-type-changing",
					modify: (v) => {
						v.types = ["artifact"];
					},
				},
			],
		},
	],
});

// Synthetic fixture isolates a layer-5 change, for Doom Blade's colour restriction.
const TEST_CARD_4 = defineCard({
	id: "target-test-black-creatures",
	name: "Test creature colour change",
	types: ["enchantment"],
	colors: [],
	manaCost: "zero",
	statics: [
		{
			kind: "characteristic",
			text: "Creatures are black.",
			applies: (v) => v.currentCharacteristics.types.includes("creature"),
			effects: [
				{
					layer: "5-color-changing",
					modify: (v) => {
						v.colors = ["b"];
					},
				},
			],
		},
	],
});

// Only the type matters: this fixture deliberately has no planeswalker mechanics.
const TEST_CARD_5 = defineCard({
	id: "target-test-planeswalker-type",
	name: "Test planeswalker type change",
	types: ["enchantment"],
	colors: [],
	manaCost: "zero",
	statics: [
		{
			kind: "characteristic",
			text: "Creatures are planeswalkers.",
			applies: (v) => v.currentCharacteristics.types.includes("creature"),
			effects: [
				{
					layer: "4-type-changing",
					modify: (v) => {
						v.types = ["planeswalker"];
					},
				},
			],
		},
	],
});

// Records the subject the layer walk offers for every battlefield object, so a
// test can check what a static ability is actually handed.
const OBSERVED_LAYER_SUBJECTS = new Map<ObjectId, LayerSubject>();
const TEST_CARD_6 = defineCard({
	id: "target-test-subject-observer",
	name: "Test subject observer",
	types: ["enchantment"],
	colors: [],
	manaCost: "zero",
	statics: [
		{
			kind: "characteristic",
			text: "Observes each subject offered to it and changes nothing.",
			applies: (subject) => {
				OBSERVED_LAYER_SUBJECTS.set(subject.object.id, subject);
				return false;
			},
			effects: [
				{
					layer: "6-ability-changing",
					modify: () => {},
				},
			],
		},
	],
});

const engine = createEngine([
	...CARDS,
	...FIXTURE_CARDS,
	TEST_CARD_1,
	TEST_CARD_2,
	TEST_CARD_3,
	TEST_CARD_4,
	TEST_CARD_5,
	TEST_CARD_6,
]);

function setupCast(cardId = "murder") {
	const state = newInProgressGame(engine);
	for (const player of [0, 1] as const) {
		for (let i = 0; i < 5; i++) spawnCard(state, "forest", player, "library");
	}
	advanceUntil(
		engine,
		state,
		passingAgents(),
		(next) => turnLocation(next)?.kind === "mainPhase",
	);
	const spell = spawnCard(state, cardId, 0, "hand");
	// Focus these tests on targeting; mana activation has its own integration tests.
	perform(
		engine,
		state,
		{
			kind: "add mana",
			source: spell.id,
			player: 0,
			mana: { b: 3, r: 1, g: 1 },
		},
		passingAgents(),
	);
	return { state, spell };
}

function castAt(state: GameState, card: ObjectId, target: EntityRef) {
	const agents = passingAgents();
	agents[0].targetChoices.push(target);
	executeCastAction(engine, state, 0, { kind: "cast", card }, agents);
	expect(agents[0].targetChoices).toHaveLength(0);
}

describe("single-target spell casting", () => {
	test("target choice observes and binds the newly announced spell", () => {
		const { state, spell: cardInHand } = setupCast();
		const creature = spawnPermanent(engine, state, "grizzly-bears", 1);
		let announcedSpell: ObjectId | null = null;
		const observer: SyncAgent = {
			choose(view, request) {
				if (request.kind !== "target")
					throw new Error("expected only a target choice");
				expect(view.stack).toHaveLength(1);
				const stackSpell = view.stack[0];
				expect(stackSpell?.kind).toBe("spell");
				if (stackSpell?.kind !== "spell")
					throw new Error("expected an announced spell");
				expect(stackSpell.objectId).not.toBe(cardInHand.id);
				expect(request.context.source).toBe(stackSpell.objectId);
				announcedSpell = stackSpell.objectId;
				return { optionId: `permanent:${creature.id}` };
			},
		};

		executeCastAction(engine, state, 0, { kind: "cast", card: cardInHand.id }, [
			observer,
			new ScriptedAgent(),
		]);

		expect(announcedSpell).not.toBeNull();
		if (announcedSpell === null) throw new Error("spell was not announced");
		const spellId: ObjectId = announcedSpell;
		expect(state.stack).toEqual([
			{
				kind: "spell",
				objectId: spellId,
				targets: [
					{ slot: "target-1", target: { type: "permanent", id: creature.id } },
				],
			},
		]);
		expect(state.objects.get(spellId)).toMatchObject({
			kind: "spell",
			id: spellId,
			zone: "stack",
		});
	});

	test("Murder is unavailable with no creature; direct execution changes nothing", () => {
		const { state, spell } = setupCast();
		spawnPermanent(engine, state, "forest", 1);
		expect(getObservableActions(engine, state, 0)).not.toContainEqual({
			kind: "cast",
			card: spell.id,
		});
		const before = structuredClone(state);
		expect(() =>
			executeCastAction(
				engine,
				state,
				0,
				{ kind: "cast", card: spell.id },
				passingAgents(),
			),
		).toThrow(IllegalCastError);
		expect(state).toEqual(before);
	});

	test("invalid and multiple-choice target answers spend no mana or move the card", () => {
		for (const answer of [
			{ optionId: "permanent:999999" },
			{ optionIds: ["player:0", "player:1"] },
		]) {
			const { state, spell } = setupCast();
			spawnPermanent(engine, state, "grizzly-bears", 1);
			const before = canonicalStateBytes(state);
			expect(() =>
				executeCastAction(engine, state, 0, { kind: "cast", card: spell.id }, [
					{ choose: () => answer },
					new ScriptedAgent(),
				]),
			).toThrow(InvalidChoiceAnswerError);
			expect(canonicalStateBytes(state)).toBe(before);
		}
	});

	test("suspended target selection restores canonical state byte-for-byte", () => {
		const { state, spell } = setupCast();
		const creature = spawnPermanent(engine, state, "grizzly-bears", 1);
		const before = canonicalStateBytes(state);
		const choices = ChoiceController.suspending(engine, [
			{
				choose(view, request) {
					expect(request.kind).toBe("target");
					expect(view.stack).toHaveLength(1);
					return Promise.resolve({
						optionId: `permanent:${creature.id}`,
					});
				},
			},
			new ScriptedAgent(),
		]);

		expect(() =>
			executeCastAction(
				engine,
				state,
				0,
				{ kind: "cast", card: spell.id },
				choices as unknown as ChoiceController<false>,
			),
		).toThrow(ChoicePendingError);
		expect(canonicalStateBytes(state)).toBe(before);
	});

	test("a replacement-interfered announcement restores canonical state byte-for-byte", () => {
		const { state, spell } = setupCast();
		spawnPermanent(engine, state, "grizzly-bears", 1);
		spawnPermanent(engine, state, "target-test-replace-cast", 1);
		const before = canonicalStateBytes(state);

		expect(() =>
			executeCastAction(
				engine,
				state,
				0,
				{ kind: "cast", card: spell.id },
				passingAgents(),
			),
		).toThrow(IllegalCastError);
		expect(canonicalStateBytes(state)).toBe(before);
	});

	test("Doom Blade's colour restriction decides its candidates", () => {
		const { state, spell } = setupCast("doom-blade");
		const bears = spawnPermanent(engine, state, "grizzly-bears", 1);
		const blackened = spawnPermanent(
			engine,
			state,
			"target-test-black-creatures",
			1,
		);
		expect(getObservableActions(engine, state, 0)).not.toContainEqual({
			kind: "cast",
			card: spell.id,
		});

		perform(
			engine,
			state,
			{
				kind: "change zone",
				object: blackened.id,
				from: "battlefield",
				destination: { zone: "graveyard" },
				cause: "effect",
			},
			passingAgents(),
		);
		castAt(state, spell.id, { type: "permanent", id: bears.id });
		settlePriority(engine, state, passingAgents());
		expect(state.objects.has(bears.id)).toBe(false);
	});

	test("a target that turns black before Doom Blade resolves is illegal", () => {
		const { state, spell } = setupCast("doom-blade");
		const bears = spawnPermanent(engine, state, "grizzly-bears", 1);
		castAt(state, spell.id, { type: "permanent", id: bears.id });
		spawnPermanent(engine, state, "target-test-black-creatures", 1);
		settlePriority(engine, state, passingAgents());
		expect(state.battlefield).toContain(bears.id);
		expect(state.log.some((line) => line.includes("[illegal target]"))).toBe(
			true,
		);
	});

	test("hexproof rejects opponents' sources while shroud rejects every source", () => {
		const { state, spell } = setupCast();
		const ordinary = spawnPermanent(engine, state, "grizzly-bears", 1);
		const friendlyHexproof = spawnPermanent(
			engine,
			state,
			"gladecover-scout",
			0,
		);
		spawnPermanent(engine, state, "gladecover-scout", 1);
		spawnPermanent(engine, state, "kalonian-behemoth", 0);
		spawnPermanent(engine, state, "kalonian-behemoth", 1);
		const choices = ChoiceController.record(engine, passingAgents());

		executeCastAction(
			engine,
			state,
			0,
			{ kind: "cast", card: spell.id },
			choices,
		);

		const request = choices.transcript().choices[0]?.request;
		expect(request?.kind).toBe("target");
		expect(request?.options.map((option) => option.id)).toEqual([
			`permanent:${ordinary.id}`,
			`permanent:${friendlyHexproof.id}`,
		]);
	});

	test("a controller can target and destroy their own hexproof creature", () => {
		const { state, spell } = setupCast();
		const scout = spawnPermanent(engine, state, "gladecover-scout", 0);

		castAt(state, spell.id, { type: "permanent", id: scout.id });
		settlePriority(engine, state, passingAgents());

		expect(state.battlefield).not.toContain(scout.id);
	});

	test("gaining hexproof makes an opponent's existing target illegal", () => {
		const { state, spell } = setupCast();
		const creature = spawnPermanent(engine, state, "grizzly-bears", 1);
		castAt(state, spell.id, { type: "permanent", id: creature.id });
		const guile = spawnCard(state, "rangers-guile", 1, "hand");
		perform(
			engine,
			state,
			{ kind: "add mana", source: guile.id, player: 1, mana: { g: 1 } },
			passingAgents(),
		);
		const agents = passingAgents();
		agents[1].priorityActions.push({ kind: "cast", card: guile.id });
		agents[1].targetChoices.push({ type: "permanent", id: creature.id });

		settlePriority(engine, state, agents);

		expect(agents[1].priorityActions).toHaveLength(0);
		expect(state.battlefield).toContain(creature.id);
		expect(
			getSnapshot(createReadContext(engine, state), creature.id)
				.currentCharacteristics.keywords,
		).toContain("hexproof");
		expect(state.log.some((line) => line.includes("[illegal target]"))).toBe(
			true,
		);
	});

	test("Unsummon returns the targeted creature to its owner's hand", () => {
		const { state, spell } = setupCast("unsummon");
		perform(
			engine,
			state,
			{ kind: "add mana", source: spell.id, player: 0, mana: { u: 1 } },
			passingAgents(),
		);
		// Owned by P1, so it must return to P1's hand rather than the caster's.
		const bears = spawnPermanent(engine, state, "grizzly-bears", 1);
		const handBefore = state.players[1].hand.length;

		castAt(state, spell.id, { type: "permanent", id: bears.id });
		settlePriority(engine, state, passingAgents());

		expect(state.battlefield).not.toContain(bears.id);
		expect(state.players[1].hand).toHaveLength(handBefore + 1);
		const returned = state.players[1].hand.at(-1);
		if (returned === undefined) throw new Error("nothing returned to hand");
		expect(state.objects.get(returned)).toMatchObject({
			kind: "card",
			cardId: "grizzly-bears",
			zone: "hand",
			owner: 1,
		});
	});

	test("a temporary P/T effect resolves into the layer system", () => {
		const { state, spell } = setupCast("target-test-deferred-pt");
		const bears = spawnPermanent(engine, state, "grizzly-bears", 1);
		castAt(state, spell.id, { type: "permanent", id: bears.id });
		settlePriority(engine, state, passingAgents());

		const snapshot = getSnapshot(createReadContext(engine, state), bears.id);
		expect(snapshot.currentCharacteristics).toMatchObject({
			kind: "creature",
			power: 5,
			toughness: 5,
		});
		expect(state.temporaryEffects).toHaveLength(1);
		// The record references the effect that created it; the +3/+3 lives in
		// that definition, not denormalized into game state.
		expect(state.temporaryEffects[0]).toMatchObject({
			source: {
				origin: "spell-effect",
				cardId: "target-test-deferred-pt",
				effectIndex: 0,
			},
			bindings: { "target-1": { type: "permanent", id: bears.id } },
			duration: "until-end-of-turn",
		});
	});

	test("Murder resolves through the destroy pipeline, including indestructible", () => {
		for (const cardId of ["grizzly-bears", "darksteel-myr"]) {
			const { state, spell } = setupCast();
			const creature = spawnPermanent(engine, state, cardId, 1);
			castAt(state, spell.id, { type: "permanent", id: creature.id });
			expect(state.players[0].manaPool.b).toBe(0);
			expect(state.stack[0]).toMatchObject({
				targets: [
					{ slot: "target-1", target: { type: "permanent", id: creature.id } },
				],
			});
			settlePriority(engine, state, passingAgents());
			expect(state.objects.has(creature.id)).toBe(cardId === "darksteel-myr");
			expect(state.stack).toHaveLength(0);
			expect(state.players[0].graveyard).toHaveLength(1);
		}
	});

	test("Bolt offers players and creatures, excludes ordinary lands, and honors damage replacement", () => {
		const { state, spell } = setupCast("lightning-bolt");
		const creature = spawnPermanent(engine, state, "grizzly-bears", 1);
		spawnPermanent(engine, state, "forest", 1);
		spawnPermanent(engine, state, "furnace-of-rath", 1);
		const choices = ChoiceController.record(engine, passingAgents());
		executeCastAction(
			engine,
			state,
			0,
			{ kind: "cast", card: spell.id },
			choices,
		);
		const request = choices.transcript().choices[0]?.request;
		expect(request?.kind).toBe("target");
		expect(request?.options.map((option) => option.id)).toEqual([
			"player:0",
			"player:1",
			`permanent:${creature.id}`,
		]);
		settlePriority(engine, state, passingAgents());
		expect(state.players[0].life).toBe(14);
	});

	test("Bolt kills a creature through state-based actions", () => {
		const { state, spell } = setupCast("lightning-bolt");
		const creature = spawnPermanent(engine, state, "grizzly-bears", 1);
		castAt(state, spell.id, { type: "permanent", id: creature.id });
		settlePriority(engine, state, passingAgents());
		expect(state.objects.has(creature.id)).toBe(false);
		expect(state.players[1].graveyard).toHaveLength(1);
	});

	test("a response removes Murder's target before it resolves", () => {
		const { state, spell } = setupCast();
		const creature = spawnPermanent(engine, state, "grizzly-bears", 1);
		castAt(state, spell.id, { type: "permanent", id: creature.id });
		const response = spawnCard(state, "lightning-bolt", 1, "hand");
		perform(
			engine,
			state,
			{ kind: "add mana", source: response.id, player: 1, mana: { r: 1 } },
			passingAgents(),
		);
		const agents = passingAgents();
		agents[1].priorityActions.push({ kind: "cast", card: response.id });
		agents[1].targetChoices.push({ type: "permanent", id: creature.id });
		settlePriority(engine, state, agents);
		expect(agents[1].priorityActions).toHaveLength(0);
		expect(state.stack).toHaveLength(0);
		expect(state.objects.has(creature.id)).toBe(false);
		expect(state.log.some((line) => line.includes("[illegal target]"))).toBe(
			true,
		);
	});

	test("leaving and returning creates a new object that Murder cannot destroy", () => {
		const { state, spell } = setupCast();
		const creature = spawnPermanent(engine, state, "grizzly-bears", 1);
		castAt(state, spell.id, { type: "permanent", id: creature.id });
		const [away] = perform(
			engine,
			state,
			{
				kind: "change zone",
				object: creature.id,
				from: "battlefield",
				destination: { zone: "exile" },
				cause: "effect",
			},
			passingAgents(),
		).created;
		if (away === undefined) throw new Error("missing exiled card");
		const [returned] = perform(
			engine,
			state,
			{
				kind: "change zone",
				object: away,
				from: "exile",
				destination: { zone: "battlefield", controller: 1 },
				cause: "effect",
			},
			passingAgents(),
		).created;
		settlePriority(engine, state, passingAgents());
		if (returned === undefined) throw new Error("missing returned permanent");
		expect(returned).not.toBe(creature.id);
		expect(state.battlefield).toContain(returned);
	});

	test("current type is rechecked before resolving Murder", () => {
		const { state, spell } = setupCast();
		const creature = spawnPermanent(engine, state, "grizzly-bears", 1);
		castAt(state, spell.id, { type: "permanent", id: creature.id });
		spawnPermanent(engine, state, "target-test-remove-creature-type", 1);
		settlePriority(engine, state, passingAgents());
		expect(state.battlefield).toContain(creature.id);
		expect(state.log.some((line) => line.includes("[illegal target]"))).toBe(
			true,
		);
	});

	test("damage asserts on current planeswalker characteristics", () => {
		const { state, spell } = setupCast("lightning-bolt");
		const creature = spawnPermanent(engine, state, "grizzly-bears", 1);
		castAt(state, spell.id, { type: "permanent", id: creature.id });
		spawnPermanent(engine, state, "target-test-planeswalker-type", 1);
		expect(() => settlePriority(engine, state, passingAgents())).toThrow(
			"planeswalker damage is not implemented",
		);
		expect(creature.damage).toBe(0);
	});

	test("an illegal target stops even Sorin's Thirst's untargeted life gain", () => {
		const { state, spell } = setupCast("sorins-thirst");
		const creature = spawnPermanent(engine, state, "grizzly-bears", 1);
		castAt(state, spell.id, { type: "permanent", id: creature.id });
		perform(
			engine,
			state,
			{ kind: "destroy", object: creature.id, noRegen: false },
			passingAgents(),
		);
		settlePriority(engine, state, passingAgents());
		expect(state.players[0].life).toBe(20);
		expect(state.stack).toHaveLength(0);
	});

	test("async target selection replays the cast without repeating the priority choice", async () => {
		const { state, spell } = setupCast();
		const creature = spawnPermanent(engine, state, "grizzly-bears", 1);
		const swamps = [0, 1, 2].map(() =>
			spawnPermanent(engine, state, "swamp", 0),
		);
		const scripted = new ScriptedAgent(
			[],
			[],
			[
				...swamps.map((source) => ({
					kind: "activate ability" as const,
					source: source.id,
					ability: abilityId("activated", "swamp", 0),
				})),
				{ kind: "cast", card: spell.id },
			],
		);
		const before = structuredClone(state);
		let castChoices = 0;
		let targetChoices = 0;
		const agent: Agent = {
			choose(_view, request) {
				if (request.kind === "target") {
					targetChoices++;
					return Promise.resolve({ optionId: `permanent:${creature.id}` });
				}
				const answer = scripted.choose(_view, request);
				if (
					"optionId" in answer &&
					answer.optionId === priorityOptionId({ kind: "cast", card: spell.id })
				)
					castChoices++;
				return answer;
			},
		};
		let checkpoint = state;
		let attempts = 0;
		for (let i = 0; i < 10 && checkpoint.objects.has(spell.id); i++) {
			const result = await advanceWithReplay(engine, checkpoint, [
				agent,
				new ScriptedAgent(),
			]);
			checkpoint = result.state;
			attempts = Math.max(attempts, result.attempts);
		}
		expect(state).toEqual(before);
		expect(castChoices).toBe(1);
		expect(targetChoices).toBe(1);
		expect(attempts).toBe(2);
		expect(checkpoint.objects.has(spell.id)).toBe(false);
		expect(checkpoint.players[0].manaPool.b).toBe(0);
	});
});
