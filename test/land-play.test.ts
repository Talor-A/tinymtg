import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "../agents.ts";
import { defineCard } from "../card-def.ts";
import { CARDS } from "../cards.ts";
import type {
	Agent,
	GameState,
	ObjectId,
	PhaseId,
	PlayerId,
	PlayLandAction,
	PriorityAction,
	StackItemId,
	StepId,
	SyncAgent,
	TurnId,
} from "../index.ts";
import {
	abilityId,
	activePlayer,
	advanceWithReplay,
	createEngine,
	executeCastAction,
	executeLandAction,
	getObservableActions,
	IllegalLandPlayError,
	newGame,
	perform,
	permanent,
	settlePriority,
	spawnCard,
	spawnPermanent,
	turnLocation,
} from "../index.ts";
import {
	type SyncAgents as Agents,
	ALICE,
	advanceUntil,
	BOB,
	newInProgressGame,
	passingAgents,
	seedLibraries,
	setupMain,
} from "./utils/engine-helpers.ts";

const TEST_CARD_1 = defineCard({
	id: "test-etb-land",
	name: "Test ETB Land",
	types: ["land"],
	colors: [],
	manaCost: "none",
	triggers: [
		{
			id: "etb-life",
			text: "When this land enters, you gain 3 life.",
			condition: {
				kind: "change zone",
				from: "any",
				to: "battlefield",
				predicate: { kind: "self" },
			},
			targets: [],
			effects: [
				{
					kind: "gain-life",
					subject: { kind: "relative-player", player: "you" },
					amount: 3,
				},
			],
		},
	],
});

const TEST_CARD_2 = defineCard({
	id: "test-grant-exploration-static",
	name: "Test Grant Exploration Static",
	types: ["enchantment"],
	colors: [],
	manaCost: "zero",
	statics: [
		{
			kind: "characteristic",
			text: "Creatures you control have Exploration's static ability.",
			applies: ({ object, currentCharacteristics }, _state, source) =>
				source.kind === "permanent" &&
				object.kind === "permanent" &&
				object.controller === source.controller &&
				currentCharacteristics.types.includes("creature"),
			effects: [
				{
					layer: "6-ability-changing",
					modify: (characteristics) => {
						characteristics.abilities.static.push(
							abilityId("static", "exploration", 0),
						);
					},
				},
			],
		},
	],
});

// Synthetic: isolates the "may play" wording used by Wrenn's Resolve for one
// already-exiled card. The duration here remains the engine's current
// until-end-of-turn subset.
const TEST_CARD_3 = defineCard({
	id: "test-may-play-land-from-exile",
	name: "Test May Play Land From Exile",
	types: ["instant"],
	colors: [],
	manaCost: "zero",
	spell: {
		id: "test-may-play-land-from-exile-spell",
		text: "Until end of turn, you may play target card from exile.",
		targets: [
			{
				id: "target-1",
				min: 1,
				max: 1,
				legal: { kind: "card", zone: "exile" },
			},
		],
		effects: [
			{
				kind: "may-play",
				subject: { kind: "target", slot: "target-1" },
				from: "exile",
				duration: "until-end-of-turn",
			},
		],
	},
});

const engine = createEngine([...CARDS, TEST_CARD_1, TEST_CARD_2, TEST_CARD_3]);

function landAction(card: ObjectId): PlayLandAction {
	return { kind: "play land", card };
}

function expectAtomicLandRejection(
	state: GameState,
	player: PlayerId,
	action: PriorityAction,
): void {
	if (action.kind !== "play land") throw new Error("expected land action");
	const before = structuredClone(state);
	expect(() =>
		executeLandAction(engine, state, player, action, passingAgents()),
	).toThrow(IllegalLandPlayError);
	expect(state).toEqual(before);
}

function occupyStack(state: GameState): void {
	const source = spawnPermanent(engine, state, "ajanis-mantra", ALICE);
	state.stack.push({
		id: state.nextStackItemId++ as StackItemId,
		kind: "triggered ability",
		source: source.id,
		triggerId: abilityId("triggered", "ajanis-mantra", 0),
		controller: ALICE,
		triggeringZoneChangeResult: null,
		triggeringEvent: {
			kind: "begin step",
			turnId: 0 as TurnId,
			phaseId: 0 as PhaseId,
			stepId: 0 as StepId,
			player: ALICE,
			step: "upkeep",
		},
		targetDefinitions: [],
		targets: [],
		sourceLastKnown: null,
		text: "At the beginning of your upkeep, you may gain 1 life.",
		effects: [
			{
				kind: "gain-life",
				subject: { kind: "relative-player", player: "you" },
				amount: 1,
			},
		],
	});
}

describe("land action observability", () => {
	test("identifies each land in the active player's hand during either main phase", () => {
		for (const role of ["precombat", "postcombat"] as const) {
			const state = setupMain(engine, role);
			const alreadyDrawn = state.players[ALICE].hand[0];
			if (alreadyDrawn === undefined)
				throw new Error("expected the normal draw");
			const first = spawnCard(state, "forest", ALICE, "hand");
			const second = spawnCard(state, "test-etb-land", ALICE, "hand");
			spawnCard(state, "grizzly-bears", ALICE, "hand");

			expect(getObservableActions(engine, state, ALICE)).toEqual([
				{ kind: "pass" },
				landAction(alreadyDrawn),
				landAction(first.id),
				landAction(second.id),
			]);
			expect(getObservableActions(engine, state, BOB)).toEqual([
				{ kind: "pass" },
			]);
		}
	});

	test("is hidden after the ordinary limit is used or while the stack is nonempty", () => {
		const state = setupMain(engine);
		spawnCard(state, "forest", ALICE, "hand");
		state.players[ALICE].stats.lands.played = 1;
		expect(getObservableActions(engine, state, ALICE)).toEqual([
			{ kind: "pass" },
		]);
		state.players[ALICE].stats.lands.played = 0;
		occupyStack(state);
		expect(getObservableActions(engine, state, ALICE)).toEqual([
			{ kind: "pass" },
		]);
	});

	test("uses finite additive land-play effects from the current controller", () => {
		const state = setupMain(engine);
		const land = spawnCard(state, "forest", ALICE, "hand");
		spawnPermanent(engine, state, "exploration", ALICE);

		state.players[ALICE].stats.lands.played = 1;
		expect(getObservableActions(engine, state, ALICE)).toContainEqual(
			landAction(land.id),
		);

		state.players[ALICE].stats.lands.played = 2;
		expect(getObservableActions(engine, state, ALICE)).not.toContainEqual(
			landAction(land.id),
		);
	});

	test("adds multiple finite adjustments and ignores sources not functioning for that player", () => {
		const state = setupMain(engine);
		const land = spawnCard(state, "forest", ALICE, "hand");
		spawnPermanent(engine, state, "exploration", ALICE);
		spawnPermanent(engine, state, "azusa-lost-but-seeking", ALICE);
		spawnCard(state, "exploration", ALICE, "graveyard");
		const opponentExploration = spawnPermanent(
			engine,
			state,
			"exploration",
			ALICE,
		);
		permanent(state, opponentExploration.id).controller = BOB;
		state.revision++;

		state.players[ALICE].stats.lands.played = 3;
		expect(getObservableActions(engine, state, ALICE)).toContainEqual(
			landAction(land.id),
		);

		state.players[ALICE].stats.lands.played = 4;
		expect(getObservableActions(engine, state, ALICE)).not.toContainEqual(
			landAction(land.id),
		);
	});

	test("uses rule abilities granted through the derived layer-6 view", () => {
		const state = setupMain(engine);
		const land = spawnCard(state, "forest", ALICE, "hand");
		spawnPermanent(engine, state, "test-grant-exploration-static", ALICE);
		spawnPermanent(engine, state, "grizzly-bears", ALICE);
		state.players[ALICE].stats.lands.played = 1;

		expect(getObservableActions(engine, state, ALICE)).toContainEqual(
			landAction(land.id),
		);
	});

	test("loses the additional allowance as soon as Exploration leaves", () => {
		const state = setupMain(engine);
		const exploration = spawnPermanent(engine, state, "exploration", ALICE);
		const land = spawnCard(state, "forest", ALICE, "hand");
		state.players[ALICE].stats.lands.played = 1;
		expect(getObservableActions(engine, state, ALICE)).toContainEqual(
			landAction(land.id),
		);

		perform(
			engine,
			state,
			{
				kind: "change zone",
				object: exploration.id,
				from: "battlefield",
				destination: { zone: "graveyard" },
				cause: "effect",
			},
			passingAgents(),
		);

		expect(getObservableActions(engine, state, ALICE)).not.toContainEqual(
			landAction(land.id),
		);
	});
});

describe("playing a land through priority", () => {
	test("plays one land in each main phase and retains priority", () => {
		for (const role of ["precombat", "postcombat"] as const) {
			const state = newInProgressGame(engine);
			seedLibraries(engine, state);
			const land = spawnCard(state, "forest", ALICE, "hand");
			const priorityPlayers: PlayerId[] = [];
			let played = false;
			const active: SyncAgent = {
				choose(_state, request) {
					const first = request.options[0];
					if (!first) throw new Error("expected an option");
					if (request.kind !== "priorityAction") return { optionId: first.id };
					const location = request.context.location;
					const wanted = request.options.find((option) =>
						option.label.endsWith(`#${land.id}`),
					);
					if (
						!played &&
						location?.kind === "mainPhase" &&
						location.role === role &&
						wanted
					) {
						played = true;
						priorityPlayers.push(request.player);
						return { optionId: wanted.id };
					}
					if (played) priorityPlayers.push(request.player);
					return { optionId: first.id };
				},
			};
			const agents: Agents = [active, new ScriptedAgent()];

			advanceUntil(engine, state, agents, (next) => !next.objects.has(land.id));

			expect(state.players[ALICE].hand).not.toContain(land.id);
			expect(state.players[ALICE].stats.lands.played).toBe(1);
			expect(state.battlefield).toHaveLength(1);
			expect(state.battlefield[0]).not.toBe(land.id);
			expect(priorityPlayers.slice(0, 2)).toEqual([ALICE, ALICE]);
		}
	});

	test("runs ETB replacements and triggers through the existing event pipeline", () => {
		const state = newInProgressGame(engine);
		seedLibraries(engine, state);
		spawnPermanent(engine, state, "root-maze", BOB);
		const land = spawnCard(state, "test-etb-land", ALICE, "hand");
		const agents: Agents = [
			new ScriptedAgent([], [], [landAction(land.id)]),
			new ScriptedAgent(),
		];

		advanceUntil(engine, state, agents, (next) => !next.objects.has(land.id));

		const battlefieldLand = state.battlefield
			.map((id) => permanent(state, id))
			.find((object) => object.owner === ALICE);
		expect(battlefieldLand?.tapped).toBe(true);
		expect(state.players[ALICE].life).toBe(23);
		expect(state.pendingTriggers).toHaveLength(0);
		expect(state.stack).toHaveLength(0);
	});

	test("replays an async card-specific priority choice without mutating its checkpoint", async () => {
		let checkpoint = newInProgressGame(engine);
		seedLibraries(engine, checkpoint);
		const land = spawnCard(checkpoint, "forest", ALICE, "hand");
		const snapshot = structuredClone(checkpoint);
		let suspended = false;
		const active: Agent = {
			choose(_state, request) {
				const option = request.options.find((candidate) =>
					candidate.label.endsWith(`#${land.id}`),
				);
				const selected = option ?? request.options[0];
				if (!selected) throw new Error("expected a priority option");
				const answer = { optionId: selected.id };
				if (option && !suspended) {
					suspended = true;
					return Promise.resolve(answer);
				}
				return answer;
			},
		};
		const passive = new ScriptedAgent();
		let attempts = 1;
		for (
			let count = 0;
			count < 20 && checkpoint.objects.has(land.id);
			count++
		) {
			const before = structuredClone(checkpoint);
			const result = await advanceWithReplay(engine, checkpoint, [
				active,
				passive,
			]);
			expect(checkpoint).toEqual(before);
			checkpoint = result.state;
			attempts = Math.max(attempts, result.attempts);
		}

		expect(attempts).toBe(2);
		expect(checkpoint.objects.has(land.id)).toBe(false);
		expect(snapshot.objects.has(land.id)).toBe(true);
		expect(snapshot.players[ALICE].stats.lands.played).toBe(0);
	});
});

describe("temporary permission to play one land from exile", () => {
	test("offers and plays the bound land for the effect controller", () => {
		const state = setupMain(engine);
		const exiled = spawnCard(state, "forest", BOB, "exile");
		const permission = spawnCard(
			state,
			"test-may-play-land-from-exile",
			ALICE,
			"hand",
		);
		const agents = passingAgents();
		agents[ALICE].targetChoices.push({ type: "card", id: exiled.id });

		executeCastAction(
			engine,
			state,
			ALICE,
			{ kind: "cast", card: permission.id },
			agents,
		);
		settlePriority(engine, state, agents);

		expect(getObservableActions(engine, state, ALICE)).toContainEqual(
			landAction(exiled.id),
		);
		executeLandAction(
			engine,
			state,
			ALICE,
			landAction(exiled.id),
			passingAgents(),
		);

		expect(state.objects.has(exiled.id)).toBe(false);
		expect(state.players[BOB].exile).not.toContain(exiled.id);
		expect(state.players[ALICE].stats.lands.played).toBe(1);
		const battlefieldLand = state.battlefield
			.map((id) => permanent(state, id))
			.find((object) => object.owner === BOB);
		expect(battlefieldLand?.controller).toBe(ALICE);
	});

	test("applies only to the bound exile object", () => {
		const state = setupMain(engine);
		const bound = spawnCard(state, "forest", ALICE, "exile");
		const unbound = spawnCard(state, "forest", ALICE, "exile");
		const permission = spawnCard(
			state,
			"test-may-play-land-from-exile",
			ALICE,
			"hand",
		);
		const agents = passingAgents();
		agents[ALICE].targetChoices.push({ type: "card", id: bound.id });
		executeCastAction(
			engine,
			state,
			ALICE,
			{ kind: "cast", card: permission.id },
			agents,
		);
		settlePriority(engine, state, agents);

		expect(getObservableActions(engine, state, ALICE)).toContainEqual(
			landAction(bound.id),
		);
		expect(getObservableActions(engine, state, ALICE)).not.toContainEqual(
			landAction(unbound.id),
		);
		expectAtomicLandRejection(state, ALICE, landAction(unbound.id));

		const graveyard = perform(
			engine,
			state,
			{
				kind: "change zone",
				object: bound.id,
				from: "exile",
				destination: { zone: "graveyard" },
				cause: "effect",
			},
			passingAgents(),
		);
		const graveyardId = graveyard.created[0];
		if (graveyardId === undefined) throw new Error("expected graveyard card");
		const returned = perform(
			engine,
			state,
			{
				kind: "change zone",
				object: graveyardId,
				from: "graveyard",
				destination: { zone: "exile" },
				cause: "effect",
			},
			passingAgents(),
		);
		const returnedId = returned.created[0];
		if (returnedId === undefined) throw new Error("expected exiled card");
		expect(returnedId).not.toBe(bound.id);
		expect(getObservableActions(engine, state, ALICE)).not.toContainEqual(
			landAction(returnedId),
		);
		expectAtomicLandRejection(state, ALICE, landAction(returnedId));
	});

	test("does not bypass the land-per-turn allowance", () => {
		const state = setupMain(engine);
		const exiled = spawnCard(state, "forest", ALICE, "exile");
		const permission = spawnCard(
			state,
			"test-may-play-land-from-exile",
			ALICE,
			"hand",
		);
		const agents = passingAgents();
		agents[ALICE].targetChoices.push({ type: "card", id: exiled.id });
		executeCastAction(
			engine,
			state,
			ALICE,
			{ kind: "cast", card: permission.id },
			agents,
		);
		settlePriority(engine, state, agents);
		state.players[ALICE].stats.lands.played = 1;

		expect(getObservableActions(engine, state, ALICE)).not.toContainEqual(
			landAction(exiled.id),
		);
		expectAtomicLandRejection(state, ALICE, landAction(exiled.id));
	});

	test("expires during cleanup before the controller's next turn", () => {
		const state = setupMain(engine);
		const exiled = spawnCard(state, "forest", ALICE, "exile");
		const permission = spawnCard(
			state,
			"test-may-play-land-from-exile",
			ALICE,
			"hand",
		);
		const agents = passingAgents();
		agents[ALICE].targetChoices.push({ type: "card", id: exiled.id });
		executeCastAction(
			engine,
			state,
			ALICE,
			{ kind: "cast", card: permission.id },
			agents,
		);
		settlePriority(engine, state, agents);
		expect(getObservableActions(engine, state, ALICE)).toContainEqual(
			landAction(exiled.id),
		);

		const completedTurns = state.completedTurns;
		advanceUntil(
			engine,
			state,
			passingAgents(),
			(next) =>
				next.completedTurns >= completedTurns + 2 &&
				activePlayer(next) === ALICE &&
				turnLocation(next)?.kind === "mainPhase",
		);
		expect(getObservableActions(engine, state, ALICE)).not.toContainEqual(
			landAction(exiled.id),
		);
		expectAtomicLandRejection(state, ALICE, landAction(exiled.id));
	});
});

describe("authoritative land-play rejection", () => {
	test("rejects a second land, a nonland, and a stale or alternate-zone object", () => {
		const secondState = setupMain(engine);
		const second = spawnCard(secondState, "forest", ALICE, "hand");
		secondState.players[ALICE].stats.lands.played = 1;
		expectAtomicLandRejection(secondState, ALICE, landAction(second.id));

		const nonlandState = setupMain(engine);
		const nonland = spawnCard(nonlandState, "grizzly-bears", ALICE, "hand");
		expectAtomicLandRejection(nonlandState, ALICE, landAction(nonland.id));

		for (const zone of ["library", "graveyard", "exile"] as const) {
			const state = setupMain(engine);
			const land = spawnCard(state, "forest", ALICE, zone);
			expectAtomicLandRejection(state, ALICE, landAction(land.id));
		}
		const staleState = setupMain(engine);
		expectAtomicLandRejection(staleState, ALICE, landAction(999 as ObjectId));
	});

	test("accepts the additional land but atomically rejects one beyond the derived allowance", () => {
		const state = setupMain(engine);
		spawnPermanent(engine, state, "exploration", ALICE);
		state.players[ALICE].stats.lands.played = 1;
		const second = spawnCard(state, "forest", ALICE, "hand");
		executeLandAction(
			engine,
			state,
			ALICE,
			landAction(second.id),
			passingAgents(),
		);
		expect(state.players[ALICE].stats.lands.played).toBe(2);

		const third = spawnCard(state, "forest", ALICE, "hand");
		expectAtomicLandRejection(state, ALICE, landAction(third.id));
	});

	test("rejects the opponent's hand, the nonactive player, non-main timing, and a nonempty stack", () => {
		const opponentHand = setupMain(engine);
		const theirs = spawnCard(opponentHand, "forest", BOB, "hand");
		expectAtomicLandRejection(opponentHand, ALICE, landAction(theirs.id));

		const nonactive = setupMain(engine);
		const own = spawnCard(nonactive, "forest", BOB, "hand");
		expectAtomicLandRejection(nonactive, BOB, landAction(own.id));

		const outsideMain = newGame();
		const early = spawnCard(outsideMain, "forest", ALICE, "hand");
		expectAtomicLandRejection(outsideMain, ALICE, landAction(early.id));

		const stacked = setupMain(engine);
		const blocked = spawnCard(stacked, "forest", ALICE, "hand");
		occupyStack(stacked);
		expectAtomicLandRejection(stacked, ALICE, landAction(blocked.id));
	});
});
