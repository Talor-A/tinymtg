import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "../agents.ts";
import { CARDS } from "../cards.ts";
import type { PlayerId } from "../index.ts";
import { createEngine, defineCard, getSnapshot, permanent } from "../index.ts";
import {
	ALICE,
	BOB,
	expectScriptConsumed,
	passingAgents,
	setupMain,
} from "./utils/engine-helpers.ts";

const FILTERED_SHUFFLE = defineCard({
	id: "filtered-shuffle",
	name: "Filtered Shuffle",
	types: ["sorcery"],
	colors: [],
	manaCost: "zero",
	spell: {
		id: "spell-1",
		text: "Each player shuffles creature cards from their hand and graveyard into their library.",
		targets: [],
		effects: [
			{
				kind: "shuffle-into-library",
				owners: "each-player",
				from: ["hand", "graveyard"],
				predicate: { kind: "type", type: "creature" },
			},
		],
	},
});

const engine = createEngine([...CARDS, FILTERED_SHUFFLE]);

function castTimetwister(
	state: ReturnType<typeof setupMain>,
	player: PlayerId,
): void {
	const card = engine.spawnCard(state, "timetwister", player, "hand");
	state.players[player].manaPool.u = 3;
	const caster = new ScriptedAgent([], [], [{ kind: "cast", card: card.id }]);
	const agents: [ScriptedAgent, ScriptedAgent] =
		player === ALICE
			? [caster, new ScriptedAgent()]
			: [new ScriptedAgent(), caster];
	engine.settlePriority(state, agents);
	expectScriptConsumed(caster);
}

describe("shuffle cards into a library", () => {
	test("a predicate moves only matching cards from the declared zones", () => {
		const state = setupMain(engine);
		const spell = engine.spawnCard(state, "filtered-shuffle", ALICE, "hand");
		engine.spawnCard(state, "grizzly-bears", ALICE, "hand");
		engine.spawnCard(state, "eager-cadet", ALICE, "graveyard");
		engine.spawnCard(state, "forest", ALICE, "hand");
		engine.spawnCard(state, "darksteel-myr", BOB, "graveyard");
		engine.spawnCard(state, "forest", BOB, "hand");

		const caster = new ScriptedAgent(
			[],
			[],
			[{ kind: "cast", card: spell.id }],
		);
		engine.settlePriority(state, [caster, new ScriptedAgent()]);
		expectScriptConsumed(caster);

		expect(
			state.players[ALICE].library.map((id) => engine.name(state, id)),
		).toEqual(expect.arrayContaining(["Grizzly Bears", "Eager Cadet"]));
		expect(
			state.players[ALICE].hand.map((id) => engine.name(state, id)),
		).toEqual(["Forest", "Forest"]);
		expect(
			state.players[ALICE].graveyard.map((id) => engine.name(state, id)),
		).toEqual(["Filtered Shuffle"]);
		expect(
			state.players[BOB].library.map((id) => engine.name(state, id)),
		).toContain("Darksteel Myr");
		expect(state.players[BOB].hand.map((id) => engine.name(state, id))).toEqual(
			["Forest"],
		);
	});

	test("Timetwister shuffles each hand and graveyard into its owner's library, then draws seven", () => {
		const state = setupMain(engine);
		for (let i = 0; i < 8; i++) {
			engine.spawnCard(state, "forest", ALICE, "library");
			engine.spawnCard(state, "forest", BOB, "library");
		}
		engine.spawnCard(state, "grizzly-bears", ALICE, "hand");
		engine.spawnCard(state, "eager-cadet", ALICE, "graveyard");
		engine.spawnCard(state, "darksteel-myr", BOB, "hand");
		engine.spawnCard(state, "darksteel-relic", BOB, "graveyard");

		castTimetwister(state, ALICE);

		expect(state.players[ALICE].hand).toHaveLength(7);
		expect(state.players[BOB].hand).toHaveLength(7);
		expect(
			state.players[ALICE].graveyard.map((id) => engine.name(state, id)),
		).toEqual(["Timetwister"]);
		expect(state.players[BOB].graveyard).toEqual([]);
		expect(
			[...state.players[ALICE].library, ...state.players[ALICE].hand]
				.map((id) => engine.name(state, id))
				.includes("Eager Cadet"),
		).toBe(true);
		expect(
			[...state.players[BOB].library, ...state.players[BOB].hand]
				.map((id) => engine.name(state, id))
				.includes("Darksteel Relic"),
		).toBe(true);
	});

	test("Worldspine Wurm dies into three trample tokens and its owner's library", () => {
		const state = setupMain(engine);
		const wurm = engine.spawnPermanent(state, "worldspine-wurm", ALICE);
		// Its dies trigger belongs to the controller, while the shuffled card still
		// belongs in its owner ALICE's library.
		permanent(state, wurm.id).controller = BOB;

		engine.perform(
			state,
			{ kind: "destroy", object: wurm.id, noRegen: false },
			passingAgents(),
		);
		engine.settlePriority(state, passingAgents());

		expect(
			state.players[ALICE].graveyard.map((id) => engine.name(state, id)),
		).not.toContain("Worldspine Wurm");
		expect(
			state.players[ALICE].library.map((id) => engine.name(state, id)),
		).toContain("Worldspine Wurm");
		const tokens = state.battlefield.filter(
			(id) => engine.name(state, id) === "Wurm Token",
		);
		expect(tokens).toHaveLength(3);
		for (const id of tokens) {
			expect(permanent(state, id).controller).toBe(BOB);
			expect(
				getSnapshot(engine.createReadContext(state), id).currentCharacteristics
					.keywords,
			).toContain("trample");
		}
	});

	test("Worldspine Wurm also shuffles itself after going from hand to graveyard", () => {
		const state = setupMain(engine);
		const wurm = engine.spawnCard(state, "worldspine-wurm", ALICE, "hand");

		engine.perform(
			state,
			{
				kind: "change zone",
				object: wurm.id,
				from: "hand",
				destination: { zone: "graveyard" },
				cause: "effect",
			},
			passingAgents(),
		);
		engine.settlePriority(state, passingAgents());

		expect(
			state.players[ALICE].graveyard.map((id) => engine.name(state, id)),
		).not.toContain("Worldspine Wurm");
		expect(
			state.players[ALICE].library.map((id) => engine.name(state, id)),
		).toContain("Worldspine Wurm");
	});
});
