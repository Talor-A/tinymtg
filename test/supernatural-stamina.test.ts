import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "../agents.ts";
import { CARDS } from "../cards.ts";
import type { GameState, ObjectId } from "../index.ts";
import { createEngine, getSnapshot, permanent } from "../index.ts";
import {
	ALICE,
	BOB,
	passingAgents,
	setupMain,
} from "./utils/engine-helpers.ts";

const engine = createEngine(CARDS);

function castSupernaturalStamina(state: GameState, target: ObjectId): void {
	const spell = engine.spawnCard(state, "supernatural-stamina", ALICE, "hand");
	state.players[ALICE].manaPool.b = 1;
	const alice = new ScriptedAgent();
	alice.targetChoices.push({ type: "permanent", id: target });
	engine.executeCastAction(state, ALICE, { kind: "cast", card: spell.id }, [
		alice,
		new ScriptedAgent(),
	]);
	engine.settlePriority(state, passingAgents());
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
		const target = engine.spawnPermanent(state, "grizzly-bears", ALICE);
		const originalId = target.id;

		castSupernaturalStamina(state, target.id);

		const snapshot = getSnapshot(engine.createReadContext(state), target.id);
		expect(snapshot.currentCharacteristics).toMatchObject({
			power: 4,
			toughness: 2,
		});
		engine.perform(
			state,
			{ kind: "destroy", object: target.id, noRegen: false },
			passingAgents(),
		);
		engine.settlePriority(state, passingAgents());

		expect(state.objects.has(originalId)).toBe(false);
		const returned = state.battlefield.find(
			(id) => engine.name(state, id) === "Grizzly Bears",
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
			getSnapshot(engine.createReadContext(state), returned)
				.currentCharacteristics,
		).toMatchObject({ power: 2, toughness: 2 });
	});

	test("does not trigger when Samurai of the Pale Curtain replaces the graveyard move", () => {
		const state = setupMain(engine);
		engine.spawnPermanent(state, "samurai-of-the-pale-curtain", ALICE);
		const target = engine.spawnPermanent(state, "grizzly-bears", BOB);

		castSupernaturalStamina(state, target.id);
		engine.perform(
			state,
			{ kind: "destroy", object: target.id, noRegen: false },
			passingAgents(),
		);
		engine.settlePriority(state, passingAgents());

		expect(state.players[BOB].graveyard).toEqual([]);
		expect(
			state.players[BOB].exile.some(
				(id) => engine.name(state, id) === "Grizzly Bears",
			),
		).toBe(true);
		expect(
			state.battlefield.some(
				(id) => engine.name(state, id) === "Grizzly Bears",
			),
		).toBe(false);
		expect(state.pendingTriggers).toEqual([]);
		expect(state.stack).toEqual([]);
	});
});
