import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "../agents.ts";
import "../cards.ts";
import type {
	Agent,
	GameState,
	ObjectId,
	PlayerId,
	PriorityAction,
	StackItemId,
	SyncAgent,
} from "../index.ts";
import {
	abilityId,
	advanceWithReplay,
	executeLandAction,
	getObservableActions,
	IllegalLandPlayError,
	newGame,
	permanent,
	registerCard,
	spawnCard,
	spawnPermanent,
	turnLocation,
} from "../index.ts";
import {
	type SyncAgents as Agents,
	ALICE,
	advanceUntil,
	atMain,
	BOB,
	passingAgents,
	seedLibraries,
	setupMain,
} from "./utils/engine-helpers.ts";

registerCard({
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
				selector: "self",
			},
			effects: [{ kind: "gain-life", player: "you", amount: 3 }],
		},
	],
});

function landAction(card: ObjectId): PriorityAction {
	return { kind: "play land", card };
}

function occupyStack(state: GameState): void {
	const source = spawnPermanent(state, "ajanis-mantra", ALICE);
	state.stack.push({
		id: state.nextStackItemId++ as StackItemId,
		kind: "triggered ability",
		source: source.id,
		triggerId: abilityId("triggered", "ajanis-mantra", 0),
		controller: ALICE,
		text: "At the beginning of your upkeep, you may gain 1 life.",
		effects: [{ kind: "gain-life", player: "you", amount: 1 }],
	});
}

describe("land action observability", () => {
	test("identifies each land in the active player's hand during either main phase", () => {
		for (const role of ["precombat", "postcombat"] as const) {
			const state = setupMain(role);
			const alreadyDrawn = state.players[ALICE].hand[0];
			if (alreadyDrawn === undefined)
				throw new Error("expected the normal draw");
			const first = spawnCard(state, "forest", ALICE, "hand");
			const second = spawnCard(state, "test-etb-land", ALICE, "hand");
			spawnCard(state, "grizzly-bears", ALICE, "hand");

			expect(getObservableActions(state, ALICE)).toEqual([
				{ kind: "pass" },
				landAction(alreadyDrawn),
				landAction(first.id),
				landAction(second.id),
			]);
			expect(getObservableActions(state, BOB)).toEqual([{ kind: "pass" }]);
		}
	});

	test("is hidden after the ordinary limit is used or while the stack is nonempty", () => {
		const state = setupMain();
		spawnCard(state, "forest", ALICE, "hand");
		state.players[ALICE].landsPlayed = 1;
		expect(getObservableActions(state, ALICE)).toEqual([{ kind: "pass" }]);
		state.players[ALICE].landsPlayed = 0;
		occupyStack(state);
		expect(getObservableActions(state, ALICE)).toEqual([{ kind: "pass" }]);
	});
});

describe("playing a land through priority", () => {
	test("plays one land in each main phase and retains priority", () => {
		for (const role of ["precombat", "postcombat"] as const) {
			const state = newGame();
			seedLibraries(state);
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

			advanceUntil(state, agents, (next) => !next.objects.has(land.id));

			expect(state.players[ALICE].hand).not.toContain(land.id);
			expect(state.players[ALICE].landsPlayed).toBe(1);
			expect(state.battlefield).toHaveLength(1);
			expect(state.battlefield[0]).not.toBe(land.id);
			expect(priorityPlayers.slice(0, 2)).toEqual([ALICE, ALICE]);
		}
	});

	test("runs ETB replacements and triggers through the existing event pipeline", () => {
		const state = newGame();
		seedLibraries(state);
		spawnPermanent(state, "root-maze", BOB);
		const land = spawnCard(state, "test-etb-land", ALICE, "hand");
		const agents: Agents = [
			new ScriptedAgent([], [], [landAction(land.id)]),
			new ScriptedAgent(),
		];

		advanceUntil(state, agents, (next) => !next.objects.has(land.id));

		const battlefieldLand = state.battlefield
			.map((id) => permanent(state, id))
			.find((object) => object.owner === ALICE);
		expect(battlefieldLand?.tapped).toBe(true);
		expect(state.players[ALICE].life).toBe(23);
		expect(state.pendingTriggers).toHaveLength(0);
		expect(state.stack).toHaveLength(0);
	});

	test("replays an async card-specific priority choice without mutating its checkpoint", async () => {
		let checkpoint = newGame();
		seedLibraries(checkpoint);
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
			const result = await advanceWithReplay(checkpoint, [active, passive]);
			expect(checkpoint).toEqual(before);
			checkpoint = result.state;
			attempts = Math.max(attempts, result.attempts);
		}

		expect(attempts).toBe(2);
		expect(checkpoint.objects.has(land.id)).toBe(false);
		expect(snapshot.objects.has(land.id)).toBe(true);
		expect(snapshot.players[ALICE].landsPlayed).toBe(0);
	});
});

describe("authoritative land-play rejection", () => {
	function expectAtomicRejection(
		state: GameState,
		player: PlayerId,
		action: PriorityAction,
	): void {
		if (action.kind !== "play land") throw new Error("expected land action");
		const before = structuredClone(state);
		expect(() =>
			executeLandAction(state, player, action, passingAgents()),
		).toThrow(IllegalLandPlayError);
		expect(state).toEqual(before);
	}

	test("rejects a second land, a nonland, and a stale or alternate-zone object", () => {
		const secondState = setupMain();
		const second = spawnCard(secondState, "forest", ALICE, "hand");
		secondState.players[ALICE].landsPlayed = 1;
		expectAtomicRejection(secondState, ALICE, landAction(second.id));

		const nonlandState = setupMain();
		const nonland = spawnCard(nonlandState, "grizzly-bears", ALICE, "hand");
		expectAtomicRejection(nonlandState, ALICE, landAction(nonland.id));

		for (const zone of ["library", "graveyard", "exile"] as const) {
			const state = setupMain();
			const land = spawnCard(state, "forest", ALICE, zone);
			expectAtomicRejection(state, ALICE, landAction(land.id));
		}
		const staleState = setupMain();
		expectAtomicRejection(staleState, ALICE, landAction(999 as ObjectId));
	});

	test("rejects the opponent's hand, the nonactive player, non-main timing, and a nonempty stack", () => {
		const opponentHand = setupMain();
		const theirs = spawnCard(opponentHand, "forest", BOB, "hand");
		expectAtomicRejection(opponentHand, ALICE, landAction(theirs.id));

		const nonactive = setupMain();
		const own = spawnCard(nonactive, "forest", BOB, "hand");
		expectAtomicRejection(nonactive, BOB, landAction(own.id));

		const outsideMain = newGame();
		const early = spawnCard(outsideMain, "forest", ALICE, "hand");
		expectAtomicRejection(outsideMain, ALICE, landAction(early.id));

		const stacked = setupMain();
		const blocked = spawnCard(stacked, "forest", ALICE, "hand");
		occupyStack(stacked);
		expectAtomicRejection(stacked, ALICE, landAction(blocked.id));
	});
});
