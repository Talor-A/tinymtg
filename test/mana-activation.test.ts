import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "../agents.ts";
import "../cards.ts";
import type {
	ActivateAbilityAction,
	Agent,
	GameState,
	ObjectId,
	PlayerId,
} from "../index.ts";
import {
	abilityId,
	advance,
	advanceWithReplay,
	executeAbilityAction,
	getObservableActions,
	IllegalAbilityActivationError,
	newGame,
	registerCard,
	settlePriority,
	spawnPermanent,
} from "../index.ts";
import {
	ALICE,
	BOB,
	beginFirstTurn,
	passingAgents,
	seedLibraries,
	setupMain,
} from "./utils/engine-helpers.ts";

registerCard({
	id: "test-nonmana-ability",
	name: "Test Nonmana Ability",
	types: ["artifact"],
	colors: [],
	manaCost: "zero",
	activatedAbilities: [
		{
			kind: "activated",
			id: "draw",
			text: "{T}: Draw a card.",
			costs: [{ kind: "tap-self" }],
			targets: [],
			effects: [{ kind: "draw", player: "you", amount: 1 }],
		},
	],
});

const forestMana = abilityId("activated", "forest", 0);

function manaAction(source: ObjectId): ActivateAbilityAction {
	return { kind: "activate ability", source, ability: forestMana };
}

describe("priority-time mana abilities", () => {
	test("offers a controlled untapped mana ability to either priority player", () => {
		const state = setupMain();
		const aliceForest = spawnPermanent(state, "forest", ALICE);
		const bobForest = spawnPermanent(state, "forest", BOB);

		expect(getObservableActions(state, ALICE)).toContainEqual(
			manaAction(aliceForest.id),
		);
		expect(getObservableActions(state, BOB)).toContainEqual(
			manaAction(bobForest.id),
		);
		expect(getObservableActions(state, ALICE)).not.toContainEqual(
			manaAction(bobForest.id),
		);
	});

	test("taps, adds mana immediately, never uses the stack, and retains priority", () => {
		const state = setupMain();
		const firstForest = spawnPermanent(state, "forest", ALICE);
		const secondForest = spawnPermanent(state, "forest", ALICE);
		const priorityPlayers: PlayerId[] = [];
		const active = new ScriptedAgent(
			[],
			[],
			[manaAction(firstForest.id), manaAction(secondForest.id)],
		);
		const recordingAgent = {
			choose(
				view: Parameters<typeof active.choose>[0],
				request: Parameters<typeof active.choose>[1],
			) {
				if (request.kind === "priorityAction")
					priorityPlayers.push(request.player);
				return active.choose(view, request);
			},
		};

		settlePriority(state, [recordingAgent, new ScriptedAgent()]);

		expect(state.objects.get(firstForest.id)).toMatchObject({ tapped: true });
		expect(state.objects.get(secondForest.id)).toMatchObject({ tapped: true });
		expect(state.players[ALICE].manaPool.g).toBe(2);
		expect(state.stack).toHaveLength(0);
		expect(priorityPlayers.slice(0, 3)).toEqual([ALICE, ALICE, ALICE]);
		expect(getObservableActions(state, ALICE)).not.toContainEqual(
			manaAction(firstForest.id),
		);
	});

	test("replays an async activation without mutating its checkpoint", async () => {
		let checkpoint = newGame();
		seedLibraries(checkpoint);
		const forest = spawnPermanent(checkpoint, "forest", ALICE);
		let suspended = false;
		const active: Agent = {
			choose(_view, request) {
				const option = request.options.find((candidate) =>
					candidate.label.includes(`Forest#${forest.id}`),
				);
				const selected = option ?? request.options[0];
				if (!selected) throw new Error("expected a choice option");
				const answer = { optionId: selected.id };
				if (option && !suspended) {
					suspended = true;
					return Promise.resolve(answer);
				}
				return answer;
			},
		};
		let attempts = 1;
		for (let count = 0; count < 4; count++) {
			const before = structuredClone(checkpoint);
			const result = await advanceWithReplay(checkpoint, [
				active,
				new ScriptedAgent(),
			]);
			expect(checkpoint).toEqual(before);
			checkpoint = result.state;
			attempts = Math.max(attempts, result.attempts);
			if (checkpoint.players[ALICE].manaPool.g === 1) break;
		}

		expect(attempts).toBe(2);
		expect(checkpoint.objects.get(forest.id)).toMatchObject({ tapped: true });
		expect(checkpoint.players[ALICE].manaPool.g).toBe(1);
		expect(checkpoint.stack).toHaveLength(0);
	});
});

describe("authoritative mana-ability rejection", () => {
	function expectAtomicRejection(
		state: GameState,
		player: PlayerId,
		action: ActivateAbilityAction,
	): void {
		const before = structuredClone(state);
		expect(() =>
			executeAbilityAction(state, player, action, passingAgents()),
		).toThrow(IllegalAbilityActivationError);
		expect(state).toEqual(before);
	}

	test("rejects tapped, opposing, stale, absent, and nonmana abilities", () => {
		const tapped = setupMain();
		const tappedForest = spawnPermanent(tapped, "forest", ALICE, {
			tapped: true,
		});
		expectAtomicRejection(tapped, ALICE, manaAction(tappedForest.id));

		const opposing = setupMain();
		const opposingForest = spawnPermanent(opposing, "forest", BOB);
		expectAtomicRejection(opposing, ALICE, manaAction(opposingForest.id));

		const stale = setupMain();
		expectAtomicRejection(stale, ALICE, manaAction(999 as ObjectId));

		const absent = setupMain();
		const artifact = spawnPermanent(absent, "test-nonmana-ability", ALICE);
		expectAtomicRejection(absent, ALICE, manaAction(artifact.id));
		expectAtomicRejection(absent, ALICE, {
			kind: "activate ability",
			source: artifact.id,
			ability: abilityId("activated", "test-nonmana-ability", 0),
		});
	});

	test("rejects activation outside a turn", () => {
		const state = newGame();
		const forest = spawnPermanent(state, "forest", ALICE);
		expectAtomicRejection(state, ALICE, manaAction(forest.id));
	});
});

describe("mana pool boundaries", () => {
	test("empties mana as a step ends", () => {
		const state = newGame();
		seedLibraries(state);
		beginFirstTurn(state, passingAgents());
		state.players[ALICE].manaPool.g = 2;
		state.players[BOB].manaPool.c = 1;

		advance(state, passingAgents());

		expect(state.players[ALICE].manaPool.g).toBe(0);
		expect(state.players[BOB].manaPool.c).toBe(0);
	});

	test("empties mana as a main phase ends", () => {
		const state = setupMain();
		state.players[ALICE].manaPool.g = 2;
		state.players[BOB].manaPool.c = 1;

		advance(state, passingAgents());

		expect(state.players[ALICE].manaPool.g).toBe(0);
		expect(state.players[BOB].manaPool.c).toBe(0);
	});
});
