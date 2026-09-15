import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "../agents.ts";
import { CARDS } from "../cards.ts";
import type { PlayerId } from "../index.ts";
import {
	activePlayer,
	createEngine,
	createReadContext,
	defineCard,
	getSnapshot,
	name,
	perform,
	permanent,
	settlePriority,
	spawnCard,
	spawnPermanent,
	turnLocation,
} from "../index.ts";
import {
	ALICE,
	advanceUntil,
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
	const card = spawnCard(state, "timetwister", player, "hand");
	state.players[player].manaPool.u = 3;
	const caster = new ScriptedAgent([], [], [{ kind: "cast", card: card.id }]);
	const agents: [ScriptedAgent, ScriptedAgent] =
		player === ALICE
			? [caster, new ScriptedAgent()]
			: [new ScriptedAgent(), caster];
	settlePriority(engine, state, agents);
	expectScriptConsumed(caster);
}

describe("shuffle cards into a library", () => {
	test("a predicate moves only matching cards from the declared zones", () => {
		const state = setupMain(engine);
		const spell = spawnCard(state, "filtered-shuffle", ALICE, "hand");
		spawnCard(state, "grizzly-bears", ALICE, "hand");
		spawnCard(state, "eager-cadet", ALICE, "graveyard");
		spawnCard(state, "forest", ALICE, "hand");
		spawnCard(state, "darksteel-myr", BOB, "graveyard");
		spawnCard(state, "forest", BOB, "hand");

		const caster = new ScriptedAgent(
			[],
			[],
			[{ kind: "cast", card: spell.id }],
		);
		settlePriority(engine, state, [caster, new ScriptedAgent()]);
		expectScriptConsumed(caster);

		expect(
			state.players[ALICE].library.map((id) => name(engine, state, id)),
		).toEqual(expect.arrayContaining(["Grizzly Bears", "Eager Cadet"]));
		expect(
			state.players[ALICE].hand.map((id) => name(engine, state, id)),
		).toEqual(["Forest", "Forest"]);
		expect(
			state.players[ALICE].graveyard.map((id) => name(engine, state, id)),
		).toEqual(["Filtered Shuffle"]);
		expect(
			state.players[BOB].library.map((id) => name(engine, state, id)),
		).toContain("Darksteel Myr");
		expect(
			state.players[BOB].hand.map((id) => name(engine, state, id)),
		).toEqual(["Forest"]);
	});

	test("Timetwister shuffles each hand and graveyard into its owner's library, then draws seven", () => {
		const state = setupMain(engine);
		for (let i = 0; i < 8; i++) {
			spawnCard(state, "forest", ALICE, "library");
			spawnCard(state, "forest", BOB, "library");
		}
		spawnCard(state, "grizzly-bears", ALICE, "hand");
		spawnCard(state, "eager-cadet", ALICE, "graveyard");
		spawnCard(state, "darksteel-myr", BOB, "hand");
		spawnCard(state, "darksteel-relic", BOB, "graveyard");

		castTimetwister(state, ALICE);

		expect(state.players[ALICE].hand).toHaveLength(7);
		expect(state.players[BOB].hand).toHaveLength(7);
		expect(
			state.players[ALICE].graveyard.map((id) => name(engine, state, id)),
		).toEqual(["Timetwister"]);
		expect(state.players[BOB].graveyard).toEqual([]);
		expect(
			[...state.players[ALICE].library, ...state.players[ALICE].hand]
				.map((id) => name(engine, state, id))
				.includes("Eager Cadet"),
		).toBe(true);
		expect(
			[...state.players[BOB].library, ...state.players[BOB].hand]
				.map((id) => name(engine, state, id))
				.includes("Darksteel Relic"),
		).toBe(true);
	});

	test("an each-player shuffle processes the active player first", () => {
		const state = setupMain(engine);
		advanceUntil(
			engine,
			state,
			passingAgents(),
			(next) =>
				activePlayer(next) === BOB && turnLocation(next)?.kind === "mainPhase",
		);
		for (let i = 0; i < 8; i++) {
			spawnCard(state, "forest", ALICE, "library");
			spawnCard(state, "forest", BOB, "library");
		}

		castTimetwister(state, BOB);

		expect(
			state.log
				.filter((entry) => entry.includes("shuffles their library"))
				.slice(-2),
		).toEqual(["  P1 shuffles their library", "  P0 shuffles their library"]);
	});

	test("Worldspine Wurm dies into three trample tokens and its owner's library", () => {
		const state = setupMain(engine);
		const wurm = spawnPermanent(engine, state, "worldspine-wurm", ALICE);
		// Its dies trigger belongs to the controller, while the shuffled card still
		// belongs in its owner ALICE's library.
		permanent(state, wurm.id).controller = BOB;

		perform(
			engine,
			state,
			{ kind: "destroy", object: wurm.id, noRegen: false },
			passingAgents(),
		);
		settlePriority(engine, state, passingAgents());

		expect(
			state.players[ALICE].graveyard.map((id) => name(engine, state, id)),
		).not.toContain("Worldspine Wurm");
		expect(
			state.players[ALICE].library.map((id) => name(engine, state, id)),
		).toContain("Worldspine Wurm");
		const tokens = state.battlefield.filter(
			(id) => name(engine, state, id) === "Wurm Token",
		);
		expect(tokens).toHaveLength(3);
		for (const id of tokens) {
			expect(permanent(state, id).controller).toBe(BOB);
			expect(
				getSnapshot(createReadContext(engine, state), id).currentCharacteristics
					.keywords,
			).toContain("trample");
		}
	});

	test("Worldspine Wurm also shuffles itself after going from hand to graveyard", () => {
		const state = setupMain(engine);
		const wurm = spawnCard(state, "worldspine-wurm", ALICE, "hand");

		perform(
			engine,
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
		settlePriority(engine, state, passingAgents());

		expect(
			state.players[ALICE].graveyard.map((id) => name(engine, state, id)),
		).not.toContain("Worldspine Wurm");
		expect(
			state.players[ALICE].library.map((id) => name(engine, state, id)),
		).toContain("Worldspine Wurm");
	});
});
