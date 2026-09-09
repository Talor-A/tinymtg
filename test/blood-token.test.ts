/**
 * blood-token.test.ts — the Blood token and its discard activation cost.
 *
 * A Blood token is `cards/tokenscripts/c_a_blood_draw.txt`: an artifact whose
 * only ability is "{1}, {T}, Discard a card, Sacrifice this token: Draw a
 * card." It is the first supported cost that discards, so these tests cover
 * both the token and the cost: the card to discard is chosen while the ability
 * is announced, and an empty hand makes the ability unactivatable.
 */

import { describe, expect, test } from "bun:test";
import "../cards.ts";
import {
	abilityId,
	createReadContext,
	executeAbilityAction,
	type GameState,
	getObservableActions,
	getSnapshot,
	IllegalAbilityActivationError,
	name,
	type ObjectId,
	type PlayerId,
	perform,
	permanent,
	settlePriority,
	spawnCard,
	spawnPermanent,
} from "../index.ts";
import {
	ALICE,
	BOB,
	created,
	passingAgents,
	type SyncAgents,
	setupMain,
} from "./utils/engine-helpers.ts";

/** Blood Servitor hosts its Blood's ability ahead of its own (it has none). */
const BLOOD_DRAW = abilityId("activated", "blood-servitor", 0);

/** Discards the player's whole hand, so a test can then stock it exactly. */
function emptyHand(
	state: GameState,
	player: PlayerId,
	agents: SyncAgents,
): void {
	while (state.players[player].hand.length > 0) {
		perform(state, { kind: "discard", player, cards: { kind: "any" } }, agents);
	}
}

/** Enters Blood Servitor from hand and resolves the Blood it makes. */
function enterServitor(
	state: GameState,
	controller: PlayerId,
	agents: SyncAgents,
): { servitor: ObjectId; blood: ObjectId } {
	const card = spawnCard(state, "blood-servitor", controller, "hand");
	const entry = perform(
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
	settlePriority(state, agents);

	const tokens = state.battlefield.filter(
		(id) => name(state, id) === "Blood Token",
	);
	const blood = tokens[0];
	if (blood === undefined || tokens.length !== 1)
		throw new Error("Blood Servitor made no single Blood");
	return { servitor: created(entry), blood };
}

describe("Blood token", () => {
	test("Blood Servitor's entry makes a Blood whose ability it hosts", () => {
		const state = setupMain();
		const { blood } = enterServitor(state, ALICE, passingAgents());

		expect(permanent(state, blood)).toMatchObject({
			controller: ALICE,
			token: true,
		});
		expect(
			getSnapshot(createReadContext(state), blood).currentCharacteristics,
		).toEqual({
			kind: "non-creature",
			name: "Blood Token",
			manaCost: "none",
			colors: [],
			supertypes: [],
			types: ["artifact"],
			subtypes: ["Blood"],
			keywords: [],
			abilities: {
				static: [],
				activated: [BLOOD_DRAW],
				triggered: [],
				replacement: [],
				prohibition: [],
			},
		});
	});

	test("activating a Blood discards the chosen card and draws a replacement", () => {
		const state = setupMain();
		const agents = passingAgents();
		const { blood } = enterServitor(state, ALICE, agents);
		emptyHand(state, ALICE, agents);
		const pitched = spawnCard(state, "forest", ALICE, "hand");
		const kept = spawnCard(state, "grizzly-bears", ALICE, "hand");
		state.players[ALICE].manaPool.g = 1;
		const libraryBefore = state.players[ALICE].library.length;
		const graveyardBefore = state.players[ALICE].graveyard.length;

		// ScriptedAgent takes the first option offered, and the discard choice
		// offers the hand in order, so the Forest is the card it pitches.
		expect(state.players[ALICE].hand).toEqual([pitched.id, kept.id]);
		executeAbilityAction(
			state,
			ALICE,
			{ kind: "activate ability", source: blood, ability: BLOOD_DRAW },
			agents,
		);
		settlePriority(state, agents);

		expect(state.players[ALICE].manaPool.g, "{1} was paid").toBe(0);
		expect(state.objects.has(blood), "the token sacrificed itself").toBe(false);
		// A card changing zones becomes a new object, so the discarded Forest is
		// gone as the object that was in hand and arrives in the graveyard as
		// another one.
		expect(state.objects.has(pitched.id)).toBe(false);
		expect(state.players[ALICE].graveyard).toHaveLength(graveyardBefore + 1);
		const discarded = state.players[ALICE].graveyard[graveyardBefore];
		if (discarded === undefined) throw new Error("nothing was discarded");
		expect(name(state, discarded)).toBe("Forest");
		expect(
			state.players[ALICE].hand,
			"the kept card stayed, and the draw replaced the discard",
		).toContain(kept.id);
		expect(state.players[ALICE].hand).toHaveLength(2);
		expect(state.players[ALICE].library).toHaveLength(libraryBefore - 1);
	});

	test("a graveyard-to-exile replacement still lets the discard cost be paid", () => {
		const state = setupMain();
		const agents = passingAgents();
		const { blood } = enterServitor(state, ALICE, agents);
		emptyHand(state, ALICE, agents);
		spawnPermanent(state, "baby-leyline-of-the-void", BOB);
		const pitched = spawnCard(state, "forest", ALICE, "hand");
		state.players[ALICE].manaPool.g = 1;
		const libraryBefore = state.players[ALICE].library.length;
		const graveyardBefore = state.players[ALICE].graveyard.length;

		// CR 701.8a: the card is still discarded when a replacement sends it
		// somewhere other than the graveyard, so the cost is paid and the
		// ability resolves. Only the discarded card's destination changes.
		executeAbilityAction(
			state,
			ALICE,
			{ kind: "activate ability", source: blood, ability: BLOOD_DRAW },
			agents,
		);
		settlePriority(state, agents);

		expect(state.objects.has(blood), "the token sacrificed itself").toBe(false);
		expect(state.objects.has(pitched.id)).toBe(false);
		expect(
			state.players[ALICE].graveyard,
			"the discarded card never reached the graveyard",
		).toHaveLength(graveyardBefore);
		expect(state.players[ALICE].exile.map((id) => name(state, id))).toEqual([
			"Forest",
		]);
		expect(
			state.players[ALICE].library,
			"the ability still resolved and drew",
		).toHaveLength(libraryBefore - 1);
		expect(state.players[ALICE].hand).toHaveLength(1);
	});

	test("a Blood cannot be activated with an empty hand", () => {
		const state = setupMain();
		const agents = passingAgents();
		const { blood } = enterServitor(state, ALICE, agents);
		state.players[ALICE].manaPool.g = 1;
		emptyHand(state, ALICE, agents);

		expect(
			getObservableActions(state, ALICE),
			"an unpayable discard cost is not offered",
		).not.toContainEqual({
			kind: "activate ability",
			source: blood,
			ability: BLOOD_DRAW,
		});
		expect(() =>
			executeAbilityAction(
				state,
				ALICE,
				{ kind: "activate ability", source: blood, ability: BLOOD_DRAW },
				agents,
			),
		).toThrow(IllegalAbilityActivationError);
		expect(
			state.objects.has(blood),
			"the rejected activation kept the token",
		).toBe(true);
	});
});
