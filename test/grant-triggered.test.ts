import { describe, expect, test } from "bun:test";
import { CARDS } from "../cards.ts";
import {
	abilityId,
	advance,
	createEngine,
	createReadContext,
	defineCard,
	executeCastAction,
	getSnapshot,
	perform,
	settlePriority,
	spawnCard,
	spawnPermanent,
	spawnToken,
} from "../index.ts";
import {
	ALICE,
	advanceUntil,
	isAt,
	passingAgents,
	setupMain,
} from "./utils/engine-helpers.ts";

const GRANT = "test-temporary-trigger-grant";
const GRANTED_TRIGGER = abilityId("triggered", GRANT, 0);
const RETURN_GRANT = "test-temporary-return-trigger-grant";
const GRANTED_RETURN_TRIGGER = abilityId("triggered", RETURN_GRANT, 0);

const TEST_CARD_1 = defineCard({
	id: GRANT,
	name: "Momentary Inspiration",
	types: ["instant"],
	colors: [],
	manaCost: "zero",
	spell: {
		id: "grant-trigger",
		text: 'Until end of turn, target creature gains "Whenever this creature becomes tapped, you gain 1 life."',
		targets: [
			{
				id: "target-1",
				min: 1,
				max: 1,
				legal: {
					kind: "permanent",
					predicate: { kind: "type", type: "creature" },
				},
			},
		],
		effects: [
			{
				kind: "grant-triggered",
				subject: { kind: "target", slot: "target-1" },
				ability: GRANTED_TRIGGER,
				duration: "until-end-of-turn",
			},
		],
	},
	triggers: [
		{
			id: "gain-life-when-tapped",
			text: "Whenever this creature becomes tapped, you gain 1 life.",
			condition: { kind: "tap", predicate: { kind: "self" } },
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
	// The instant owns the implementation but does not possess the ability.
	printed: { triggered: [] },
});

const TEST_CARD_2 = defineCard({
	id: RETURN_GRANT,
	name: "Brief Reprieve",
	types: ["instant"],
	colors: [],
	manaCost: "zero",
	spell: {
		id: "grant-return-trigger",
		text: 'Until end of turn, target creature gains "When this creature dies, return it to its owner\'s hand."',
		targets: [
			{
				id: "target-1",
				min: 1,
				max: 1,
				legal: {
					kind: "permanent",
					predicate: { kind: "type", type: "creature" },
				},
			},
		],
		effects: [
			{
				kind: "grant-triggered",
				subject: { kind: "target", slot: "target-1" },
				ability: GRANTED_RETURN_TRIGGER,
				duration: "until-end-of-turn",
			},
		],
	},
	triggers: [
		{
			id: "return-to-hand-when-dies",
			text: "When this creature dies, return it to its owner's hand.",
			condition: {
				kind: "change zone",
				from: "battlefield",
				to: "graveyard",
				predicate: { kind: "self" },
			},
			targets: [],
			effects: [
				{
					kind: "change-zone",
					subject: { kind: "triggering-zone-change-result" },
					from: "graveyard",
					destination: { zone: "hand" },
				},
			],
		},
	],
	printed: { triggered: [] },
});

const engine = createEngine([...CARDS, TEST_CARD_1, TEST_CARD_2]);

function castGrant() {
	const state = setupMain(engine);
	const creature = spawnPermanent(engine, state, "grizzly-bears", ALICE);
	const spell = spawnCard(state, GRANT, ALICE, "hand");
	executeCastAction(
		engine,
		state,
		ALICE,
		{ kind: "cast", card: spell.id },
		passingAgents(),
	);
	settlePriority(engine, state, passingAgents());
	return { state, creature };
}

function castReturnGrant() {
	const state = setupMain(engine);
	const creature = spawnPermanent(engine, state, "grizzly-bears", ALICE);
	const cast = () => {
		const spell = spawnCard(state, RETURN_GRANT, ALICE, "hand");
		executeCastAction(
			engine,
			state,
			ALICE,
			{ kind: "cast", card: spell.id },
			passingAgents(),
		);
		settlePriority(engine, state, passingAgents());
	};
	cast();
	return { state, creature, cast };
}

describe("temporary triggered-ability grants", () => {
	test("the target gains a noncopiable trigger that fires", () => {
		const { state, creature } = castGrant();
		const snapshot = getSnapshot(createReadContext(engine, state), creature.id);
		expect(snapshot.copiableValues.abilities.triggered).toEqual([]);
		expect(snapshot.currentCharacteristics.abilities.triggered).toEqual([
			GRANTED_TRIGGER,
		]);

		perform(
			engine,
			state,
			{ kind: "tap", objects: [creature.id] },
			passingAgents(),
		);
		expect(state.pendingTriggers.map((trigger) => trigger.triggerId)).toEqual([
			GRANTED_TRIGGER,
		]);
		settlePriority(engine, state, passingAgents());
		expect(state.players[ALICE].life).toBe(21);
	});

	test("the grant expires during cleanup", () => {
		const { state, creature } = castGrant();
		advanceUntil(engine, state, passingAgents(), (next) =>
			isAt(next, "cleanup"),
		);
		advance(engine, state, passingAgents());

		const snapshot = getSnapshot(createReadContext(engine, state), creature.id);
		expect(snapshot.currentCharacteristics.abilities.triggered).toEqual([]);
	});

	test("the grant does not follow the physical card through a zone change", () => {
		const { state, creature } = castGrant();
		const moved = perform(
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
		);
		const card = moved.created[0];
		expect(card).toBeDefined();
		if (card === undefined) return;
		const returned = perform(
			engine,
			state,
			{
				kind: "change zone",
				object: card,
				from: "exile",
				destination: { zone: "battlefield", controller: ALICE },
				cause: "effect",
			},
			passingAgents(),
		).created[0];
		expect(returned).toBeDefined();
		if (returned === undefined) return;
		expect(
			getSnapshot(createReadContext(engine, state), returned)
				.currentCharacteristics.abilities.triggered,
		).toEqual([]);
	});
});

describe("triggering zone-change results", () => {
	test("a dies trigger moves the new graveyard card rather than its old source", () => {
		const { state, creature } = castReturnGrant();
		const handBefore = state.players[ALICE].hand.length;
		const graveyardBefore = state.players[ALICE].graveyard.length;
		perform(
			engine,
			state,
			{ kind: "sacrifice", object: creature.id },
			passingAgents(),
		);
		const graveyardCard = state.players[ALICE].graveyard.at(-1);
		expect(graveyardCard).toBeDefined();
		expect(state.pendingTriggers).toHaveLength(1);
		expect(state.pendingTriggers[0]?.triggeringZoneChangeResult).toBe(
			graveyardCard,
		);

		settlePriority(engine, state, passingAgents());
		expect(state.players[ALICE].graveyard).toHaveLength(graveyardBefore);
		expect(state.players[ALICE].hand).toHaveLength(handBefore + 1);
	});

	test("the trigger does nothing if its destination object moved again", () => {
		const { state, creature } = castReturnGrant();
		const handBefore = state.players[ALICE].hand.length;
		perform(
			engine,
			state,
			{ kind: "sacrifice", object: creature.id },
			passingAgents(),
		);
		const graveyardCard = state.players[ALICE].graveyard.at(-1);
		expect(graveyardCard).toBeDefined();
		if (graveyardCard === undefined) return;
		perform(
			engine,
			state,
			{
				kind: "change zone",
				object: graveyardCard,
				from: "graveyard",
				destination: { zone: "exile" },
				cause: "effect",
			},
			passingAgents(),
		);

		settlePriority(engine, state, passingAgents());
		expect(state.players[ALICE].hand).toHaveLength(handBefore);
		expect(state.players[ALICE].exile).toHaveLength(1);
	});

	test("a graveyard-to-exile replacement prevents the dies trigger", () => {
		const { state, creature } = castReturnGrant();
		const graveyardBefore = state.players[ALICE].graveyard.length;
		spawnPermanent(engine, state, "samurai-of-the-pale-curtain", ALICE);
		perform(
			engine,
			state,
			{ kind: "sacrifice", object: creature.id },
			passingAgents(),
		);

		expect(state.pendingTriggers).toEqual([]);
		expect(state.players[ALICE].graveyard).toHaveLength(graveyardBefore);
		expect(state.players[ALICE].exile).toHaveLength(1);
	});

	test("two grants trigger twice but only one can move the graveyard card", () => {
		const { state, creature, cast } = castReturnGrant();
		cast();
		const handBefore = state.players[ALICE].hand.length;
		const graveyardBefore = state.players[ALICE].graveyard.length;
		perform(
			engine,
			state,
			{ kind: "sacrifice", object: creature.id },
			passingAgents(),
		);
		expect(state.pendingTriggers).toHaveLength(2);

		settlePriority(engine, state, passingAgents());
		expect(state.players[ALICE].graveyard).toHaveLength(graveyardBefore);
		expect(state.players[ALICE].hand).toHaveLength(handBefore + 1);
	});

	test("a token ceases to exist before its return trigger resolves", () => {
		const state = setupMain(engine);
		const token = spawnToken(state, ALICE, {
			kind: "creature",
			name: "Bear Token",
			manaCost: "zero",
			colors: ["g"],
			supertypes: [],
			types: ["creature"],
			subtypes: ["Bear"],
			keywords: [],
			abilities: {
				static: [],
				activated: [],
				triggered: [],
				replacement: [],
				prohibition: [],
			},
			power: 2,
			toughness: 2,
		});
		const spell = spawnCard(state, RETURN_GRANT, ALICE, "hand");
		executeCastAction(
			engine,
			state,
			ALICE,
			{ kind: "cast", card: spell.id },
			passingAgents(),
		);
		settlePriority(engine, state, passingAgents());
		perform(
			engine,
			state,
			{ kind: "sacrifice", object: token.id },
			passingAgents(),
		);
		expect(state.pendingTriggers).toHaveLength(1);

		settlePriority(engine, state, passingAgents());
		expect(
			state.battlefield.some(
				(id) =>
					getSnapshot(createReadContext(engine, state), id)
						.currentCharacteristics.name === "Bear Token",
			),
		).toBe(false);
	});
});
