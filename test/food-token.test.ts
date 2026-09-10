/**
 * food-token.test.ts — the Food token, and the cards that make one.
 *
 * A Food token is `cards/tokenscripts/c_a_food_sac.txt`: an artifact whose
 * only ability is "{2}, {T}, Sacrifice this token: You gain 3 life." Like
 * Treasure's mana ability, that ability's definition lives on the card that
 * created the token, and the token's characteristics reference it there.
 */

import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "../agents.ts";
import { CARDS } from "../cards.ts";
import {
	abilityId,
	createEngine,
	type GameState,
	getSnapshot,
	type ObjectId,
	type PlayerId,
	permanent,
} from "../index.ts";
import {
	ALICE,
	BOB,
	created,
	passingAgents,
	type SyncAgents,
	setupMain,
} from "./utils/engine-helpers.ts";

const engine = createEngine(CARDS);

/**
 * A creating card hosts each Food ability it makes, in the order the abilities
 * are lowered, ahead of the card's own printed abilities.
 */
const GOOSE_FOOD_SAC = abilityId("activated", "gilded-goose", 0);
const WITCH_FOOD_SAC = abilityId("activated", "sweettooth-witch", 0);
const WITCH_DRAIN = abilityId("activated", "sweettooth-witch", 1);

/**
 * Enters `cardId` from hand and resolves its entry trigger, returning both the
 * permanent and the one Food token that trigger created.
 */
function enterAndSettle(
	state: GameState,
	cardId: string,
	controller: PlayerId,
	agents: SyncAgents,
): { source: ObjectId; food: ObjectId } {
	const card = engine.spawnCard(state, cardId, controller, "hand");
	const entry = engine.perform(
		state,
		{
			kind: "change zone",
			object: card.id,
			from: "hand",
			destination: { zone: "battlefield", controller },
			cause: "resolve",
		},
		agents,
	);
	expect(state.pendingTriggers).toHaveLength(1);
	engine.settlePriority(state, agents);

	const food = state.battlefield.filter(
		(id) => engine.name(state, id) === "Food Token",
	);
	expect(food).toHaveLength(1);
	const only = food[0];
	if (only === undefined) throw new Error(`${cardId} created no Food`);
	return { source: created(entry), food: only };
}

describe("Food token", () => {
	test("Gilded Goose's entry makes a Food whose ability its creator hosts", () => {
		const state = setupMain(engine);
		const { food } = enterAndSettle(
			state,
			"gilded-goose",
			ALICE,
			passingAgents(),
		);

		expect(permanent(state, food)).toMatchObject({
			controller: ALICE,
			token: true,
		});
		expect(
			getSnapshot(engine.createReadContext(state), food).currentCharacteristics,
		).toEqual({
			kind: "non-creature",
			name: "Food Token",
			manaCost: "none",
			colors: [],
			supertypes: [],
			types: ["artifact"],
			subtypes: ["Food"],
			keywords: [],
			abilities: {
				static: [],
				activated: [GOOSE_FOOD_SAC],
				triggered: [],
				replacement: [],
				prohibition: [],
			},
		});
	});

	test("a Food's own ability costs {2}, its tap and itself, and gains 3 life", () => {
		const state = setupMain(engine);
		const agents = passingAgents();
		const { food } = enterAndSettle(state, "sweettooth-witch", ALICE, agents);
		expect(
			getSnapshot(engine.createReadContext(state), food).currentCharacteristics
				.abilities.activated,
		).toEqual([WITCH_FOOD_SAC]);
		state.players[ALICE].manaPool.g = 2;

		engine.executeAbilityAction(
			state,
			ALICE,
			{ kind: "activate ability", source: food, ability: WITCH_FOOD_SAC },
			agents,
		);
		engine.settlePriority(state, agents);

		expect(state.players[ALICE].manaPool.g, "{2} was paid").toBe(0);
		expect(state.objects.has(food), "the token sacrificed itself").toBe(false);
		expect(state.players[ALICE].life).toBe(23);
	});

	test("Sweettooth Witch's own ability sacrifices the Food it created", () => {
		const state = setupMain(engine);
		const alice = new ScriptedAgent();
		const bob = new ScriptedAgent();
		const { source: witch, food } = enterAndSettle(
			state,
			"sweettooth-witch",
			ALICE,
			[alice, bob],
		);
		state.players[ALICE].manaPool.b = 2;

		// {2}, Sacrifice a Food: the Witch's only Food is the one it just made,
		// and its ability needs no tap, so a freshly entered Witch can use it.
		alice.sacrificeChoices = [food];
		alice.targetChoices = [{ type: "player", player: BOB }];
		engine.executeAbilityAction(
			state,
			ALICE,
			{
				kind: "activate ability",
				source: witch,
				ability: WITCH_DRAIN,
			},
			[alice, bob],
		);
		engine.settlePriority(state, [alice, bob]);

		expect(state.objects.has(food), "the Food paid the cost").toBe(false);
		expect(state.players[BOB].life).toBe(18);
		expect(state.players[ALICE].life, "the Witch's ability gains no life").toBe(
			20,
		);
	});
});
