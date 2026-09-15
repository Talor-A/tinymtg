import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "../agents.ts";
import { CARDS } from "../cards.ts";
import {
	abilityId,
	createEngine,
	createReadContext,
	executeAbilityAction,
	getSnapshot,
	perform,
	permanent,
	settlePriority,
	spawnCard,
	spawnPermanent,
} from "../index.ts";
import {
	ALICE,
	advanceUntil,
	BOB,
	created,
	isAt,
	passingAgents,
	type SyncAgents,
	setupMain,
} from "./utils/engine-helpers.ts";

const engine = createEngine(CARDS);

const TREASURE_MANA = abilityId("activated", "jewel-thief", 0);

describe("Jewel Thief", () => {
	test("enters with its full printed characteristics and creates an activatable Treasure", () => {
		const state = setupMain(engine);
		const jewelCard = spawnCard(state, "jewel-thief", ALICE, "hand");
		const agents = passingAgents();
		const entry = perform(
			engine,
			state,
			{
				kind: "change zone",
				object: jewelCard.id,
				from: "hand",
				destination: { zone: "battlefield", controller: ALICE },
				cause: "resolve",
			},
			agents,
		);
		const jewel = created(entry);

		expect(
			getSnapshot(createReadContext(engine, state), jewel)
				.currentCharacteristics,
		).toMatchObject({
			kind: "creature",
			name: "Jewel Thief",
			manaCost: { n: 2, g: 1 },
			colors: ["g"],
			types: ["creature"],
			subtypes: ["Cat", "Rogue"],
			keywords: ["vigilance", "trample"],
			power: 3,
			toughness: 3,
		});
		expect(state.pendingTriggers).toHaveLength(1);

		settlePriority(engine, state, agents);
		const treasure = state.battlefield.find(
			(id) => permanent(state, id).representation.kind === "token",
		);
		if (treasure === undefined) throw new Error("Jewel Thief created no token");
		expect(
			getSnapshot(createReadContext(engine, state), treasure)
				.currentCharacteristics,
		).toEqual({
			kind: "non-creature",
			name: "Treasure Token",
			manaCost: "none",
			colors: [],
			supertypes: [],
			types: ["artifact"],
			subtypes: ["Treasure"],
			keywords: [],
			abilities: {
				static: [],
				activated: [TREASURE_MANA],
				triggered: [],
				replacement: [],
				prohibition: [],
			},
		});

		executeAbilityAction(
			engine,
			state,
			ALICE,
			{
				kind: "activate ability",
				source: treasure,
				ability: TREASURE_MANA,
			},
			agents,
		);
		expect(
			state.objects.has(treasure),
			"Treasure was sacrificed as a cost",
		).toBe(false);
		expect(
			state.players[ALICE].manaPool.w,
			"the chosen color was produced",
		).toBe(1);
	});

	test("attacks without tapping and tramples over a blocker", () => {
		const state = setupMain(engine);
		const jewel = spawnPermanent(engine, state, "jewel-thief", ALICE, {
			summoningSick: false,
		});
		const blocker = spawnPermanent(engine, state, "eager-cadet", BOB);
		const agents: SyncAgents = [
			new ScriptedAgent([], [], [], [[jewel.id]]),
			new ScriptedAgent(
				[],
				[],
				[],
				[],
				[[{ blocker: blocker.id, attacker: jewel.id }]],
			),
		];

		advanceUntil(engine, state, agents, (next) => isAt(next, "combat damage"));

		expect(
			permanent(state, jewel.id).tapped,
			"vigilance kept it untapped",
		).toBe(false);
		expect(state.objects.has(blocker.id), "one damage was lethal").toBe(false);
		expect(state.players[BOB].life, "two excess damage trampled over").toBe(18);
		expect(
			permanent(state, jewel.id).damage,
			"the blocker still dealt damage",
		).toBe(1);
	});
});
