import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "../agents.ts";
import { CARDS } from "../cards.ts";
import {
	abilityId,
	createEngine,
	executeAbilityAction,
	perform,
	settlePriority,
	spawnCard,
	spawnPermanent,
} from "../index.ts";
import {
	ALICE,
	BOB,
	passingAgents,
	type SyncAgents,
	setupMain,
} from "./utils/engine-helpers.ts";

const engine = createEngine(CARDS);

const LOOTER_ABILITY = abilityId("activated", "cephalid-looter", 0);

/** An agent pair whose only scripted decision is ALICE naming BOB as a target. */
function alicePicksBob(): SyncAgents {
	return [
		new ScriptedAgent([], [], [], [], [], [{ type: "player", player: BOB }]),
		new ScriptedAgent(),
	];
}

describe("a targeted player discards", () => {
	test("Ravenous Rats empties a card from the targeted opponent's hand", () => {
		const state = setupMain(engine);
		const agents = alicePicksBob();
		spawnCard(state, "forest", BOB, "hand");
		const aliceHand = state.players[ALICE].hand.length;
		const bobHand = state.players[BOB].hand.length;

		const rats = spawnCard(state, "ravenous-rats", ALICE, "hand");
		perform(
			engine,
			state,
			{
				kind: "change zone",
				object: rats.id,
				from: "hand",
				destination: { zone: "battlefield", controller: ALICE },
				cause: "resolve",
			},
			agents,
		);
		expect(state.pendingTriggers).toHaveLength(1);
		settlePriority(engine, state, agents);

		// The rats left ALICE's hand on their way to the battlefield; only BOB
		// discards.
		expect(state.players[BOB].hand).toHaveLength(bobHand - 1);
		expect(state.players[BOB].graveyard).toHaveLength(1);
		expect(state.players[ALICE].hand).toHaveLength(aliceHand);
		expect(state.players[ALICE].graveyard).toHaveLength(0);
	});

	test("Cephalid Looter draws and discards for one targeted player", () => {
		const state = setupMain(engine);
		const agents = alicePicksBob();
		const looter = spawnPermanent(engine, state, "cephalid-looter", ALICE, {
			summoningSick: false,
		});
		const bobHand = state.players[BOB].hand.length;
		const bobLibrary = state.players[BOB].library.length;

		executeAbilityAction(
			engine,
			state,
			ALICE,
			{ kind: "activate ability", source: looter.id, ability: LOOTER_ABILITY },
			agents,
		);
		settlePriority(engine, state, agents);

		// Both halves read the same target slot: BOB draws one and discards one,
		// so the hand is level and the library is one shorter.
		expect(state.players[BOB].hand).toHaveLength(bobHand);
		expect(state.players[BOB].library).toHaveLength(bobLibrary - 1);
		expect(state.players[BOB].graveyard).toHaveLength(1);
		expect(state.players[ALICE].graveyard).toHaveLength(0);
	});

	test("an untargeted discard still names its own player", () => {
		const state = setupMain(engine);
		spawnCard(state, "forest", ALICE, "hand");
		const rats = spawnCard(state, "ravenous-rats", BOB, "hand");
		perform(
			engine,
			state,
			{
				kind: "change zone",
				object: rats.id,
				from: "hand",
				destination: { zone: "battlefield", controller: BOB },
				cause: "resolve",
			},
			passingAgents(),
		);
		settlePriority(engine, state, passingAgents());

		// BOB controls the rats, so ALICE is the only legal target.
		expect(state.players[ALICE].graveyard).toHaveLength(1);
		expect(state.players[BOB].graveyard).toHaveLength(0);
	});
});
