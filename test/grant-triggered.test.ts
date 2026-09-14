import { describe, expect, test } from "bun:test";
import { CARDS } from "../cards.ts";
import {
	abilityId,
	createEngine,
	defineCard,
	getSnapshot,
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

const engine = createEngine([...CARDS, TEST_CARD_1]);

function castGrant() {
	const state = setupMain(engine);
	const creature = engine.spawnPermanent(state, "grizzly-bears", ALICE);
	const spell = engine.spawnCard(state, GRANT, ALICE, "hand");
	engine.executeCastAction(
		state,
		ALICE,
		{ kind: "cast", card: spell.id },
		passingAgents(),
	);
	engine.settlePriority(state, passingAgents());
	return { state, creature };
}

describe("temporary triggered-ability grants", () => {
	test("the target gains a noncopiable trigger that fires", () => {
		const { state, creature } = castGrant();
		const snapshot = getSnapshot(engine.createReadContext(state), creature.id);
		expect(snapshot.copiableValues.abilities.triggered).toEqual([]);
		expect(snapshot.currentCharacteristics.abilities.triggered).toEqual([
			GRANTED_TRIGGER,
		]);

		engine.perform(
			state,
			{ kind: "tap", ref: { kind: "object", object: creature.id } },
			passingAgents(),
		);
		expect(state.pendingTriggers.map((trigger) => trigger.triggerId)).toEqual([
			GRANTED_TRIGGER,
		]);
		engine.settlePriority(state, passingAgents());
		expect(state.players[ALICE].life).toBe(21);
	});

	test("the grant expires during cleanup", () => {
		const { state, creature } = castGrant();
		advanceUntil(engine, state, passingAgents(), (next) => isAt(next, "cleanup"));
		engine.advance(state, passingAgents());

		const snapshot = getSnapshot(engine.createReadContext(state), creature.id);
		expect(snapshot.currentCharacteristics.abilities.triggered).toEqual([]);
	});

	test("the grant does not follow the physical card through a zone change", () => {
		const { state, creature } = castGrant();
		const moved = engine.perform(
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
		const returned = engine.perform(
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
			getSnapshot(engine.createReadContext(state), returned)
				.currentCharacteristics.abilities.triggered,
		).toEqual([]);
	});
});
