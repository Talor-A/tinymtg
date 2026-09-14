import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "../agents.ts";
import { CARDS } from "../cards.ts";
import { loadCardFixture } from "../corpus.ts";
import {
	abilityId,
	ChoiceController,
	type ChoiceRequest,
	createEngine,
	defineCard,
	type ObjectId,
	type PlayerView,
} from "../index.ts";
import { ALICE, BOB, setupMain } from "./utils/engine-helpers.ts";

const SEARCH_OPPONENT = defineCard({
	id: "test-search-opponent",
	name: "Test Search Opponent",
	types: ["sorcery"],
	colors: [],
	manaCost: "zero",
	spell: {
		id: "spell",
		text: "Search an opponent's library for a creature card and put it into its owner's hand. Then that player shuffles.",
		targets: [],
		effects: [
			{
				kind: "search-library",
				searcher: { kind: "relative-player", player: "you" },
				owner: { kind: "relative-player", player: "opponent" },
				predicate: { kind: "type", type: "creature" },
				resultSlot: "card",
			},
			{
				kind: "change-zone",
				subject: { kind: "effect-result", slot: "card" },
				from: "library",
				destination: { zone: "hand" },
			},
			{
				kind: "shuffle-library",
				subject: { kind: "relative-player", player: "opponent" },
			},
		],
	},
});

const engine = createEngine([
	...CARDS,
	loadCardFixture("w/wooded_foothills"),
	SEARCH_OPPONENT,
]);

class SearchAgent extends ScriptedAgent {
	readonly searches: Extract<ChoiceRequest, { kind: "searchLibrary" }>[] = [];

	constructor(private readonly card: ObjectId | null) {
		super();
	}

	override choose(view: PlayerView, request: ChoiceRequest) {
		if (request.kind !== "searchLibrary") return super.choose(view, request);
		this.searches.push(request);
		return { optionId: this.card === null ? "decline" : String(this.card) };
	}
}

describe("library search choices", () => {
	test("the searcher sees only eligible cards from the separately named owner", () => {
		const state = engine.newGame();
		const source = engine.spawnCard(state, "demonic-tutor", ALICE, "hand");
		const ineligible = engine.spawnCard(state, "forest", BOB, "library");
		const eligible = engine.spawnCard(state, "grizzly-bears", BOB, "library");
		const alice = new SearchAgent(eligible.id);
		const choices = ChoiceController.record(engine, [
			alice,
			new ScriptedAgent(),
		]);
		const input = {
			owner: BOB,
			source: source.id,
			predicate: {
				definition: { kind: "type", type: "creature" } as const,
				context: { controller: ALICE, source: source.id },
			},
		};

		expect(choices.searchLibrary(state, ALICE, input)).toBe(eligible.id);
		expect(alice.searches).toHaveLength(1);
		expect(alice.searches[0]).toMatchObject({
			player: ALICE,
			context: { owner: BOB, optional: true },
		});
		expect(alice.searches[0]?.context.cards).toHaveLength(1);
		expect(alice.searches[0]?.context.cards[0]).toMatchObject({
			objectId: eligible.id,
			owner: BOB,
			zone: "library",
			currentCharacteristics: { name: "Grizzly Bears" },
		});
		expect(alice.searches[0]?.options).toEqual([
			{ id: String(eligible.id), label: `Grizzly Bears#${eligible.id}` },
			{ id: "decline", label: "Find no card" },
		]);
		expect(alice.searches[0]?.options).not.toContainEqual(
			expect.objectContaining({ id: String(ineligible.id) }),
		);

		const replay = ChoiceController.replay(
			engine,
			structuredClone(choices.transcript()),
		);
		expect(replay.searchLibrary(state, ALICE, input)).toBe(eligible.id);
		replay.assertComplete();
	});
});

describe("search effects", () => {
	test("the effect keeps the searcher distinct from the library owner", () => {
		const state = setupMain(engine);
		const chosen = engine.spawnCard(state, "grizzly-bears", BOB, "library");
		const spell = engine.spawnCard(
			state,
			"test-search-opponent",
			ALICE,
			"hand",
		);
		const alice = new SearchAgent(chosen.id);
		const agents: [SearchAgent, ScriptedAgent] = [alice, new ScriptedAgent()];

		engine.executeCastAction(
			state,
			ALICE,
			{ kind: "cast", card: spell.id },
			agents,
		);
		engine.settlePriority(state, agents);

		expect(alice.searches[0]).toMatchObject({
			player: ALICE,
			context: { owner: BOB },
		});
		expect(
			state.players[BOB].hand.map((id) => engine.name(state, id)),
		).toContain("Grizzly Bears");
		expect(
			state.players[ALICE].hand.map((id) => engine.name(state, id)),
		).not.toContain("Grizzly Bears");
		expect(state.log).toContain("  P1 shuffles their library");
	});

	test("Demonic Tutor moves the selected card into hand, then shuffles", () => {
		const state = setupMain(engine);
		const chosen = engine.spawnCard(state, "grizzly-bears", ALICE, "library");
		const tutor = engine.spawnCard(state, "demonic-tutor", ALICE, "hand");
		state.players[ALICE].manaPool.b = 1;
		state.players[ALICE].manaPool.c = 1;
		const alice = new SearchAgent(chosen.id);
		const agents: [SearchAgent, ScriptedAgent] = [alice, new ScriptedAgent()];

		engine.executeCastAction(
			state,
			ALICE,
			{ kind: "cast", card: tutor.id },
			agents,
		);
		engine.settlePriority(state, agents);

		expect(state.objects.has(chosen.id)).toBe(false);
		expect(
			state.players[ALICE].hand.map((id) => engine.name(state, id)),
		).toContain("Grizzly Bears");
		expect(alice.searches[0]?.context).toMatchObject({
			owner: ALICE,
			optional: false,
		});
		expect(alice.searches[0]?.options).not.toContainEqual(
			expect.objectContaining({ id: "decline" }),
		);
		expect(state.log).toContain("  P0 shuffles their library");
	});

	test("Evolving Wilds filters for a basic land and puts it onto the battlefield tapped", () => {
		const state = setupMain(engine);
		const ineligible = engine.spawnCard(
			state,
			"darksteel-relic",
			ALICE,
			"library",
		);
		const chosen = engine.spawnCard(state, "forest", ALICE, "library");
		const wilds = engine.spawnPermanent(state, "evolving-wilds", ALICE);
		const alice = new SearchAgent(chosen.id);
		const agents: [SearchAgent, ScriptedAgent] = [alice, new ScriptedAgent()];

		engine.executeAbilityAction(
			state,
			ALICE,
			{
				kind: "activate ability",
				source: wilds.id,
				ability: abilityId("activated", "evolving-wilds", 0),
			},
			agents,
		);
		engine.settlePriority(state, agents);

		expect(
			alice.searches[0]?.context.cards.map(
				(card) => card.currentCharacteristics.name,
			),
		).toEqual(expect.arrayContaining(["Forest"]));
		expect(alice.searches[0]?.context.cards).not.toContainEqual(
			expect.objectContaining({ objectId: ineligible.id }),
		);
		const forest = state.battlefield
			.map((id) => engine.buildGameView(state).objects.get(id))
			.find((object) => object?.currentCharacteristics.name === "Forest");
		expect(forest).toMatchObject({
			kind: "permanent",
			controller: ALICE,
			tapped: true,
		});
		expect(
			state.players[ALICE].graveyard.map((id) => engine.name(state, id)),
		).toContain("Evolving Wilds");
	});

	test("Wooded Foothills pays life and finds a land by subtype", () => {
		const state = setupMain(engine);
		const chosen = engine.spawnCard(state, "forest", ALICE, "library");
		const foothills = engine.spawnPermanent(state, "wooded-foothills", ALICE);
		const alice = new SearchAgent(chosen.id);
		const agents: [SearchAgent, ScriptedAgent] = [alice, new ScriptedAgent()];

		engine.executeAbilityAction(
			state,
			ALICE,
			{
				kind: "activate ability",
				source: foothills.id,
				ability: abilityId("activated", "wooded-foothills", 0),
			},
			agents,
		);
		expect(state.players[ALICE].life).toBe(19);
		expect(
			state.players[ALICE].graveyard.map((id) => engine.name(state, id)),
		).toContain("Wooded Foothills");

		engine.settlePriority(state, agents);
		expect(
			alice.searches[0]?.context.cards.map(
				(card) => card.currentCharacteristics.name,
			),
		).toContain("Forest");
		const forest = state.battlefield
			.map((id) => engine.buildGameView(state).objects.get(id))
			.find((object) => object?.currentCharacteristics.name === "Forest");
		expect(forest).toMatchObject({
			kind: "permanent",
			controller: ALICE,
			tapped: false,
		});
		expect(state.log).toContain("  P0 shuffles their library");
	});

	test("a qualified search may fail to find and still shuffles", () => {
		const state = setupMain(engine);
		const before = [...state.players[ALICE].library];
		const wilds = engine.spawnPermanent(state, "evolving-wilds", ALICE);
		const alice = new SearchAgent(null);
		const agents: [SearchAgent, ScriptedAgent] = [alice, new ScriptedAgent()];

		engine.executeAbilityAction(
			state,
			ALICE,
			{
				kind: "activate ability",
				source: wilds.id,
				ability: abilityId("activated", "evolving-wilds", 0),
			},
			agents,
		);
		engine.settlePriority(state, agents);

		expect(state.players[ALICE].library).toHaveLength(before.length);
		expect(state.battlefield).toHaveLength(0);
		expect(state.log).toContain("  P0 shuffles their library");
	});
});

describe("search result flow", () => {
	test("a library movement cannot consume a result no search produced", () => {
		expect(() =>
			defineCard({
				id: "bad-library-result",
				name: "Bad Library Result",
				types: ["sorcery"],
				colors: [],
				manaCost: "zero",
				spell: {
					id: "spell",
					text: "Invalid.",
					targets: [],
					effects: [
						{
							kind: "change-zone",
							subject: { kind: "effect-result", slot: "missing" },
							from: "library",
							destination: { zone: "hand" },
						},
					],
				},
			}),
		).toThrow("unavailable library effect result missing");
	});
});
