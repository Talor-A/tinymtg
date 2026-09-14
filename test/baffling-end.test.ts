import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "../agents.ts";
import { CARDS } from "../cards.ts";
import type {
	ChoiceAnswer,
	ChoiceRequest,
	GameState,
	PlayerView,
} from "../index.ts";
import { createEngine, getSnapshot, permanent } from "../index.ts";
import {
	ALICE,
	BOB,
	passingAgents,
	type SyncAgents,
	setupMain,
} from "./utils/engine-helpers.ts";

const engine = createEngine(CARDS);

/** Records how many targets each target choice was offered. */
class TargetWatcher extends ScriptedAgent {
	offered: number[] = [];

	override choose(view: PlayerView, request: ChoiceRequest): ChoiceAnswer {
		if (request.kind === "target") this.offered.push(request.options.length);
		return super.choose(view, request);
	}
}

/** An agent pair whose only scripted decision is ALICE naming BOB as a target. */
function alicePicksBob(): SyncAgents {
	return [
		new ScriptedAgent([], [], [], [], [], [{ type: "player", player: BOB }]),
		new ScriptedAgent(),
	];
}

function putOntoBattlefield(
	state: GameState,
	cardId: string,
	agents: SyncAgents,
) {
	const card = engine.spawnCard(state, cardId, ALICE, "hand");
	engine.perform(
		state,
		{
			kind: "change zone",
			object: card.id,
			from: "hand",
			destination: { zone: "battlefield", controller: ALICE },
			cause: "resolve",
		},
		agents,
	);
}

describe("Baffling End", () => {
	test("exiles only an opponent's creature with mana value 3 or less", () => {
		const state = setupMain(engine);
		const bears = engine.spawnPermanent(state, "grizzly-bears", BOB);
		const whisperer = engine.spawnPermanent(state, "beast-whisperer", BOB);

		// Grizzly Bears costs {1}{G} and Beast Whisperer {2}{G}{G}, so only the
		// bears are inside "mana value 3 or less".
		const watcher = new TargetWatcher();
		const agents: SyncAgents = [watcher, new ScriptedAgent()];
		putOntoBattlefield(state, "baffling-end", agents);
		expect(state.pendingTriggers).toHaveLength(1);

		engine.settlePriority(state, agents);
		expect(watcher.offered).toEqual([1]);
		expect(state.objects.has(bears.id)).toBe(false);
		expect(state.objects.has(whisperer.id)).toBe(true);
		expect(state.players[BOB].graveyard).toHaveLength(0);
		expect(state.players[BOB].exile).toHaveLength(1);
	});

	test("hands the targeted opponent a Dinosaur when it leaves the battlefield", () => {
		const state = setupMain(engine);
		const agents = alicePicksBob();
		const baffling = engine.spawnPermanent(state, "baffling-end", ALICE);

		engine.perform(
			state,
			{
				kind: "change zone",
				object: baffling.id,
				from: "battlefield",
				destination: { zone: "graveyard" },
				cause: "destroy",
			},
			agents,
		);
		expect(state.pendingTriggers).toHaveLength(1);
		engine.settlePriority(state, agents);

		const tokens = state.battlefield.filter(
			(id) => permanent(state, id).representation.kind === "token",
		);
		expect(tokens).toHaveLength(1);
		const dinosaur = tokens[0];
		if (dinosaur === undefined) throw new Error("no token was created");
		expect(permanent(state, dinosaur).controller).toBe(BOB);
		expect(
			getSnapshot(engine.createReadContext(state), dinosaur)
				.currentCharacteristics,
		).toMatchObject({
			name: "Dinosaur Token",
			colors: ["g"],
			subtypes: ["Dinosaur"],
			keywords: ["trample"],
			power: 3,
			toughness: 3,
		});
	});

	test("a departure trigger also fires on a destination other than the graveyard", () => {
		const state = setupMain(engine);
		const agents = alicePicksBob();
		const baffling = engine.spawnPermanent(state, "baffling-end", ALICE);

		engine.perform(
			state,
			{
				kind: "change zone",
				object: baffling.id,
				from: "battlefield",
				destination: { zone: "exile" },
				cause: "resolve",
			},
			agents,
		);
		expect(state.pendingTriggers).toHaveLength(1);
		engine.settlePriority(state, agents);

		const tokens = state.battlefield.filter(
			(id) => permanent(state, id).representation.kind === "token",
		);
		expect(tokens).toHaveLength(1);
	});
});

describe("Thragtusk", () => {
	test("leaves for exile and still creates its Beast", () => {
		const state = setupMain(engine);
		const thragtusk = engine.spawnPermanent(state, "thragtusk", ALICE);

		engine.perform(
			state,
			{
				kind: "change zone",
				object: thragtusk.id,
				from: "battlefield",
				destination: { zone: "exile" },
				cause: "resolve",
			},
			passingAgents(),
		);
		expect(state.pendingTriggers).toHaveLength(1);
		engine.settlePriority(state, passingAgents());

		const tokens = state.battlefield.filter(
			(id) => permanent(state, id).representation.kind === "token",
		);
		expect(tokens).toHaveLength(1);
		const beast = tokens[0];
		if (beast === undefined) throw new Error("no token was created");
		// "Create a 3/3 green Beast creature token" with no target: the
		// departing permanent's controller keeps it.
		expect(permanent(state, beast).controller).toBe(ALICE);
	});
});
