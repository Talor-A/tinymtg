import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "../agents.ts";
import "../cards.ts";
import type {
	ActivateAbilityAction,
	Agent,
	GameState,
	ObjectId,
	PlayerId,
	SyncAgent,
} from "../index.ts";
import {
	abilityId,
	advance,
	advanceWithReplay,
	executeAbilityAction,
	getObservableActions,
	IllegalAbilityActivationError,
	newGame,
	perform,
	registerCard,
	settlePriority,
	spawnCard,
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
	id: "merfolk-looter",
	name: "Merfolk Looter",
	types: ["creature"],
	subtypes: ["Merfolk", "Rogue"],
	colors: ["u"],
	manaCost: { c: 1, u: 1 },
	power: 1,
	toughness: 1,
	activatedAbilities: [
		{
			kind: "activated",
			id: "loot",
			text: "{T}: Draw a card, then discard a card.",
			costs: [{ kind: "tap-self" }],
			targets: [],
			effects: [
				{ kind: "draw", player: "you", amount: 1 },
				{
					kind: "discard",
					selector: "any",
					amount: 1,
					player: "you",
				},
			],
		},
	],
});

registerCard({
	id: "test-unsupported-activated-ability",
	name: "Test Unsupported Activated Ability",
	types: ["artifact"],
	colors: [],
	manaCost: "zero",
	activatedAbilities: [
		{
			kind: "activated",
			id: "discard-two",
			text: "{T}: Discard two cards.",
			costs: [{ kind: "tap-self" }],
			targets: [],
			effects: [
				{
					kind: "discard",
					selector: "any",
					amount: 2,
					player: "you",
				},
			],
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

describe("authoritative ability rejection", () => {
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

	test("rejects tapped, opposing, stale, and absent abilities", () => {
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
		const artifact = spawnPermanent(absent, "merfolk-looter", ALICE);
		expectAtomicRejection(absent, ALICE, manaAction(artifact.id));
	});

	test("validates the supported effect subset before paying the tap cost", () => {
		const state = setupMain();
		const source = spawnPermanent(
			state,
			"test-unsupported-activated-ability",
			ALICE,
		);
		const before = structuredClone(state);

		expect(() =>
			executeAbilityAction(
				state,
				ALICE,
				{
					kind: "activate ability",
					source: source.id,
					ability: abilityId(
						"activated",
						"test-unsupported-activated-ability",
						0,
					),
				},
				passingAgents(),
			),
		).toThrow("discarding multiple cards is not implemented");
		expect(state).toEqual(before);
	});

	test("rejects activation outside a turn", () => {
		const state = newGame();
		const forest = spawnPermanent(state, "forest", ALICE);
		expectAtomicRejection(state, ALICE, manaAction(forest.id));
	});
});

describe("targetless activated abilities", () => {
	const looterAbility = abilityId("activated", "merfolk-looter", 0);

	function looterAction(source: ObjectId): ActivateAbilityAction {
		return { kind: "activate ability", source, ability: looterAbility };
	}

	test("taps and captures instructions, then resolves after its source leaves", () => {
		const state = setupMain();
		const looter = spawnPermanent(state, "merfolk-looter", ALICE);
		const oldHandCard = spawnCard(state, "forest", ALICE, "hand");
		const handBefore = [...state.players[ALICE].hand];

		expect(getObservableActions(state, ALICE)).toContainEqual(
			looterAction(looter.id),
		);
		executeAbilityAction(
			state,
			ALICE,
			looterAction(looter.id),
			passingAgents(),
		);

		expect(state.objects.get(looter.id)).toMatchObject({ tapped: true });
		expect(state.players[ALICE].hand).toEqual(handBefore);
		expect(state.stack).toMatchObject([
			{
				kind: "activated ability",
				source: looter.id,
				abilityId: looterAbility,
				controller: ALICE,
				effects: [
					{ kind: "draw", amount: 1 },
					{ kind: "discard", amount: 1 },
				],
			},
		]);

		perform(
			state,
			{
				kind: "change zone",
				object: looter.id,
				from: "battlefield",
				to: "graveyard",
				cause: "destroy",
				toController: ALICE,
			},
			passingAgents(),
		);
		const graveyardSizeBeforeResolution = state.players[ALICE].graveyard.length;

		let discardOptions = 0;
		const choosingAgent: SyncAgent = {
			choose(_view, request) {
				const first = request.options[0];
				if (!first) throw new Error("expected a choice option");
				if (request.kind === "ownHand") {
					discardOptions = request.options.length;
					const oldCard = request.options.find(
						(option) => option.id === String(oldHandCard.id),
					);
					if (!oldCard) throw new Error("old hand card was not offered");
					return { optionId: oldCard.id };
				}
				return { optionId: first.id };
			},
		};
		settlePriority(state, [choosingAgent, new ScriptedAgent()]);

		expect(discardOptions).toBe(handBefore.length + 1);
		expect(state.stack).toHaveLength(0);
		expect(state.players[ALICE].hand).toHaveLength(handBefore.length);
		expect(state.players[ALICE].graveyard).toHaveLength(
			graveyardSizeBeforeResolution + 1,
		);
		expect(state.objects.has(oldHandCard.id)).toBe(false);
		expect(state.objects.has(looter.id)).toBe(false);
	});

	test("replays an async discard choice from the post-draw hand", async () => {
		const checkpoint = setupMain();
		const looter = spawnPermanent(checkpoint, "merfolk-looter", ALICE);
		spawnCard(checkpoint, "forest", ALICE, "hand");
		executeAbilityAction(
			checkpoint,
			ALICE,
			looterAction(looter.id),
			passingAgents(),
		);
		const handSizeBeforeResolution = checkpoint.players[ALICE].hand.length;
		const before = structuredClone(checkpoint);
		let suspended = false;
		const asyncDiscard: Agent = {
			choose(_view, request) {
				const first = request.options[0];
				if (!first) throw new Error("expected a choice option");
				const answer = { optionId: first.id };
				if (request.kind === "ownHand" && !suspended) {
					suspended = true;
					return Promise.resolve(answer);
				}
				return answer;
			},
		};

		const result = await advanceWithReplay(checkpoint, [
			asyncDiscard,
			new ScriptedAgent(),
		]);

		expect(checkpoint).toEqual(before);
		expect(result.attempts).toBe(2);
		expect(result.state.stack).toHaveLength(0);
		expect(result.state.players[ALICE].hand).toHaveLength(
			handSizeBeforeResolution,
		);
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
