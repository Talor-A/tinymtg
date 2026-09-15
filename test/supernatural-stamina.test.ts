import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "../agents.ts";
import { CARDS } from "../cards.ts";
import type { GameState, ObjectId } from "../index.ts";
import {
	createEngine,
	createReadContext,
	executeCastAction,
	getSnapshot,
	name,
	perform,
	permanent,
	settlePriority,
	spawnCard,
	spawnPermanent,
} from "../index.ts";
import {
	ALICE,
	BOB,
	passingAgents,
	setupMain,
} from "./utils/engine-helpers.ts";

const engine = createEngine(CARDS);

function castSupernaturalStamina(state: GameState, target: ObjectId): void {
	const spell = spawnCard(state, "supernatural-stamina", ALICE, "hand");
	state.players[ALICE].manaPool.b = 1;
	const alice = new ScriptedAgent();
	alice.targetChoices.push({ type: "permanent", id: target });
	executeCastAction(engine, state, ALICE, { kind: "cast", card: spell.id }, [
		alice,
		new ScriptedAgent(),
	]);
	settlePriority(engine, state, passingAgents());
}

describe("Supernatural Stamina", () => {
	test("is registered from its Forge definition", () => {
		const card = CARDS.find(
			(candidate) => candidate.id === "supernatural-stamina",
		);
		expect(card).toMatchObject({
			name: "Supernatural Stamina",
			manaCost: { b: 1 },
			types: ["instant"],
			colors: ["b"],
		});
		expect(card?.printedAbilities.triggered).toEqual([]);
		expect(card?.abilityDefinitions.triggered).toHaveLength(1);
	});

	test("gives +2/+0 and returns the creature as a new tapped object", () => {
		const state = setupMain(engine);
		const target = spawnPermanent(engine, state, "grizzly-bears", ALICE);
		const originalId = target.id;

		castSupernaturalStamina(state, target.id);

		const snapshot = getSnapshot(createReadContext(engine, state), target.id);
		expect(snapshot.currentCharacteristics).toMatchObject({
			power: 4,
			toughness: 2,
		});
		perform(
			engine,
			state,
			{ kind: "destroy", object: target.id, noRegen: false },
			passingAgents(),
		);
		settlePriority(engine, state, passingAgents());

		expect(state.objects.has(originalId)).toBe(false);
		const returned = state.battlefield.find(
			(id) => name(engine, state, id) === "Grizzly Bears",
		);
		if (returned === undefined)
			throw new Error("Supernatural Stamina returned no creature");
		expect(returned).not.toBe(originalId);
		expect(permanent(state, returned)).toMatchObject({
			owner: ALICE,
			controller: ALICE,
			tapped: true,
		});
		expect(
			getSnapshot(createReadContext(engine, state), returned)
				.currentCharacteristics,
		).toMatchObject({ power: 2, toughness: 2 });
	});

	test("does not trigger when Samurai of the Pale Curtain replaces the graveyard move", () => {
		const state = setupMain(engine);
		spawnPermanent(engine, state, "samurai-of-the-pale-curtain", ALICE);
		const target = spawnPermanent(engine, state, "grizzly-bears", BOB);

		castSupernaturalStamina(state, target.id);
		perform(
			engine,
			state,
			{ kind: "destroy", object: target.id, noRegen: false },
			passingAgents(),
		);
		settlePriority(engine, state, passingAgents());

		expect(state.players[BOB].graveyard).toEqual([]);
		expect(
			state.players[BOB].exile.some(
				(id) => name(engine, state, id) === "Grizzly Bears",
			),
		).toBe(true);
		expect(
			state.battlefield.some(
				(id) => name(engine, state, id) === "Grizzly Bears",
			),
		).toBe(false);
		expect(state.pendingTriggers).toEqual([]);
		expect(state.stack).toEqual([]);
	});
});
