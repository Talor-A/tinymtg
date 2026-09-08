import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "../agents.ts";
import "../cards.ts";
import { priorityOptionId } from "../choices.ts";
import type {
	ActivateAbilityAction,
	Agent,
	ChoiceAnswer,
	ChoiceRequest,
	ChoiceTranscript,
	GameState,
	ManaAmount,
	ObjectId,
	PlayerId,
	SyncAgent,
} from "../index.ts";
import {
	abilityId,
	advance,
	advanceWithReplay,
	ChoiceController,
	executeAbilityAction,
	getObservableActions,
	IllegalAbilityActivationError,
	InvalidChoiceAnswerError,
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
	completePreGame,
	passingAgents,
	registerCardFixture,
	seedLibraries,
	setupMain,
} from "./utils/engine-helpers.ts";

registerCardFixture("m/merfolk_looter");

registerCard({
	id: "test-five-color-mana-ability",
	name: "Test Five Color Mana Ability",
	types: ["artifact"],
	colors: [],
	manaCost: "zero",
	activatedAbilities: [
		{
			kind: "mana",
			id: "choose-color",
			text: "{T}: Add one mana of any color.",
			cost: { mana: "zero", tapSelf: true },
			manaOptions: [{ w: 1 }, { u: 1 }, { b: 1 }, { r: 1 }, { g: 1 }],
		},
	],
});

registerCard({
	id: "test-two-color-mana-ability",
	name: "Test Two Color Mana Ability",
	types: ["land"],
	colors: [],
	manaCost: "none",
	activatedAbilities: [
		{
			kind: "mana",
			id: "choose-white-or-blue",
			text: "{T}: Add {W} or {U}.",
			cost: { mana: "zero", tapSelf: true },
			manaOptions: [{ w: 1 }, { u: 1 }],
		},
	],
});

registerCard({
	id: "test-paid-activated-abilities",
	name: "Test Paid Activated Abilities",
	types: ["artifact"],
	colors: [],
	manaCost: "zero",
	activatedAbilities: [
		{
			kind: "activated",
			id: "paid-target",
			text: "{1}{G}: This deals 1 damage to any target.",
			cost: { mana: { g: 1, n: 1 }, tapSelf: false },
			targets: [
				{ id: "target-1", min: 1, max: 1, legal: { kind: "any-target" } },
			],
			effects: [{ kind: "damage", targetSlot: "target-1", amount: 1 }],
		},
		{
			kind: "activated",
			id: "paid-tap",
			text: "{G}, {T}: You gain 1 life.",
			cost: { mana: { g: 1 }, tapSelf: true },
			targets: [],
			effects: [{ kind: "gain-life", player: "you", amount: 1 }],
		},
		{
			kind: "mana",
			id: "paid-mana",
			text: "{R}: Add {G}.",
			cost: { mana: { r: 1 }, tapSelf: false },
			effects: [{ kind: "add-mana", player: "you", mana: { g: 1 } }],
		},
	],
});

registerCard({
	id: "test-paid-tap-fizzle",
	name: "Test Paid Tap Fizzle",
	types: ["enchantment"],
	colors: [],
	manaCost: "zero",
	replacements: [
		{
			label: "paid-tap-fizzle",
			text: "If a permanent would become tapped, its controller loses 1 life instead.",
			layer: "other",
			functionsFrom: "any",
			applies: (event) => event.kind === "tap" && event.ref.kind === "object",
			replace: (_event, context) => [
				{ kind: "lose life", player: context.controller, amount: 1 },
			],
		},
	],
});

registerCard({
	id: "test-paid-tap-pass-through",
	name: "Test Paid Tap Pass Through",
	types: ["enchantment"],
	colors: [],
	manaCost: "zero",
	replacements: [
		{
			label: "paid-tap-pass-through",
			text: "If the test artifact would become tapped, it becomes tapped instead.",
			layer: "other",
			functionsFrom: "any",
			applies: (event, context) => {
				if (event.kind !== "tap" || event.ref.kind !== "object") return false;
				const object = context.state.objects.get(event.ref.object);
				return (
					object?.kind === "permanent" &&
					object.representation.kind === "card" &&
					object.representation.cardId === "test-paid-activated-abilities"
				);
			},
			replace: (event) => [event],
		},
	],
});

registerCard({
	id: "test-paid-tap-pass-through-second",
	name: "Test Paid Tap Pass Through Second",
	types: ["enchantment"],
	colors: [],
	manaCost: "zero",
	replacements: [
		{
			label: "paid-tap-pass-through-second",
			text: "If the test artifact would become tapped, it becomes tapped instead.",
			layer: "other",
			functionsFrom: "any",
			applies: (event, context) => {
				if (event.kind !== "tap" || event.ref.kind !== "object") return false;
				const object = context.state.objects.get(event.ref.object);
				return (
					object?.kind === "permanent" &&
					object.representation.kind === "card" &&
					object.representation.cardId === "test-paid-activated-abilities"
				);
			},
			replace: (event) => [event],
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
			cost: { mana: "zero", tapSelf: true },
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
const fiveColorMana = abilityId("activated", "test-five-color-mana-ability", 0);
const twoColorMana = abilityId("activated", "test-two-color-mana-ability", 0);
const paidTarget = abilityId("activated", "test-paid-activated-abilities", 0);
const paidTap = abilityId("activated", "test-paid-activated-abilities", 1);
const paidMana = abilityId("activated", "test-paid-activated-abilities", 2);

function manaAction(source: ObjectId): ActivateAbilityAction {
	return { kind: "activate ability", source, ability: forestMana };
}

function choosingMana(
	choose: (request: Extract<ChoiceRequest, { kind: "mana" }>) => ChoiceAnswer,
): SyncAgent {
	return {
		choose(_view, request) {
			if (request.kind !== "mana") {
				const first = request.options[0];
				if (!first) throw new Error("expected a choice option");
				return { optionId: first.id };
			}
			return choose(request);
		},
	};
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

	test("offers five exclusive colors as one ability and produces only the chosen color", () => {
		const outcomes: [keyof ManaAmount, ManaAmount][] = [
			["w", { w: 1 }],
			["u", { u: 1 }],
			["b", { b: 1 }],
			["r", { r: 1 }],
			["g", { g: 1 }],
		];

		for (let selected = 0; selected < outcomes.length; selected++) {
			const state = setupMain();
			const source = spawnPermanent(
				state,
				"test-five-color-mana-ability",
				ALICE,
			);
			const action: ActivateAbilityAction = {
				kind: "activate ability",
				source: source.id,
				ability: fiveColorMana,
			};
			const offered = getObservableActions(state, ALICE).filter(
				(candidate) =>
					candidate.kind === "activate ability" &&
					candidate.source === source.id,
			);
			expect(offered).toEqual([action]);

			let seen: Extract<ChoiceRequest, { kind: "mana" }> | undefined;
			const agent = choosingMana((request) => {
				seen = request;
				return { optionId: String(selected) };
			});
			executeAbilityAction(state, ALICE, action, [agent, new ScriptedAgent()]);

			expect(seen?.context.amounts).toEqual(outcomes.map((entry) => entry[1]));
			expect(seen?.options).toHaveLength(5);
			expect(state.objects.get(source.id)).toMatchObject({ tapped: true });
			for (const [type] of outcomes) {
				expect(state.players[ALICE].manaPool[type]).toBe(
					type === outcomes[selected]?.[0] ? 1 : 0,
				);
			}
			expect(state.players[ALICE].manaPool.c).toBe(0);
		}
	});

	test("chooses between two colors without creating two abilities", () => {
		const state = setupMain();
		const source = spawnPermanent(state, "test-two-color-mana-ability", ALICE);
		const action: ActivateAbilityAction = {
			kind: "activate ability",
			source: source.id,
			ability: twoColorMana,
		};
		const agent = choosingMana(() => ({ optionId: "1" }));

		executeAbilityAction(state, ALICE, action, [agent, new ScriptedAgent()]);

		expect(state.players[ALICE].manaPool).toEqual({
			w: 0,
			u: 1,
			b: 0,
			r: 0,
			g: 0,
			c: 0,
		});
	});

	test("records, serializes, and replays a modal mana choice", () => {
		const checkpoint = setupMain();
		const source = spawnPermanent(
			checkpoint,
			"test-five-color-mana-ability",
			ALICE,
		);
		const action: ActivateAbilityAction = {
			kind: "activate ability",
			source: source.id,
			ability: fiveColorMana,
		};
		const replayState = structuredClone(checkpoint);
		const agent = choosingMana(() => ({ optionId: "3" }));
		const recorder = ChoiceController.record([agent, new ScriptedAgent()]);

		executeAbilityAction(checkpoint, ALICE, action, recorder);
		const serialized = JSON.stringify(recorder.transcript());
		const transcript = JSON.parse(serialized) as ChoiceTranscript;
		expect(transcript.choices).toMatchObject([
			{
				request: {
					kind: "mana",
					context: {
						source: source.id,
						ability: fiveColorMana,
					},
				},
				answer: { optionId: "3" },
			},
		]);

		const replay = ChoiceController.replay(transcript);
		executeAbilityAction(replayState, ALICE, action, replay);
		replay.assertComplete();
		expect(replayState).toEqual(checkpoint);
	});

	test("rejects absent, multiple, or unlisted selections before tapping", () => {
		for (const answer of [
			{ optionIds: [] },
			{ optionIds: ["0", "1"] },
			{ optionId: "not-an-option" },
		] satisfies ChoiceAnswer[]) {
			const state = setupMain();
			const source = spawnPermanent(
				state,
				"test-two-color-mana-ability",
				ALICE,
			);
			const action: ActivateAbilityAction = {
				kind: "activate ability",
				source: source.id,
				ability: twoColorMana,
			};
			const before = structuredClone(state);
			const agent = choosingMana(() => answer);

			expect(() =>
				executeAbilityAction(state, ALICE, action, [
					agent,
					new ScriptedAgent(),
				]),
			).toThrow(InvalidChoiceAnswerError);
			expect(state).toEqual(before);
		}
	});

	test("fixed production remains immediate and does not ask for an outcome", () => {
		const state = setupMain();
		const forest = spawnPermanent(state, "forest", ALICE);
		const rejectingModalChoice: SyncAgent = {
			choose(_view, request) {
				if (request.kind === "mana") {
					throw new Error("fixed mana ability asked for a mana option");
				}
				const first = request.options[0];
				if (!first) throw new Error("expected a choice option");
				return { optionId: first.id };
			},
		};

		executeAbilityAction(state, ALICE, manaAction(forest.id), [
			rejectingModalChoice,
			new ScriptedAgent(),
		]);

		expect(state.objects.get(forest.id)).toMatchObject({ tapped: true });
		expect(state.players[ALICE].manaPool.g).toBe(1);
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
		completePreGame(checkpoint, [new ScriptedAgent(), new ScriptedAgent()]);

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

describe("fixed activation payments", () => {
	function action(
		source: ObjectId,
		ability: typeof paidTarget | typeof paidTap | typeof paidMana,
	): ActivateAbilityAction {
		return { kind: "activate ability", source, ability };
	}

	test("activates multiple mana sources and exposes a generic-plus-colored ability at normal priority", () => {
		const state = setupMain();
		const firstForest = spawnPermanent(state, "forest", ALICE);
		const secondForest = spawnPermanent(state, "forest", ALICE);
		const source = spawnPermanent(
			state,
			"test-paid-activated-abilities",
			ALICE,
			{ tapped: true },
		);
		const paidAction = action(source.id, paidTarget);
		const scripted = new ScriptedAgent(
			[],
			[],
			[manaAction(firstForest.id), manaAction(secondForest.id), paidAction],
		);
		const availability: { green: number; offered: boolean }[] = [];
		const observingAgent: SyncAgent = {
			choose(view, request) {
				if (request.kind === "priorityAction" && request.player === ALICE) {
					availability.push({
						green: state.players[ALICE].manaPool.g,
						offered: request.options.some(
							(option) => option.id === priorityOptionId(paidAction),
						),
					});
				}
				return scripted.choose(view, request);
			},
		};

		settlePriority(state, [observingAgent, new ScriptedAgent()]);

		expect(scripted.priorityActions).toHaveLength(0);
		expect(availability.slice(0, 4)).toEqual([
			{ green: 0, offered: false },
			{ green: 1, offered: false },
			{ green: 2, offered: true },
			{ green: 0, offered: false },
		]);
		expect(state.objects.get(firstForest.id)).toMatchObject({ tapped: true });
		expect(state.objects.get(secondForest.id)).toMatchObject({ tapped: true });
		expect(state.objects.get(source.id)).toMatchObject({ tapped: true });
		expect(state.players[ALICE].manaPool.g).toBe(0);
		expect(state.players[ALICE].life).toBe(19);
		expect(state.stack).toHaveLength(0);
	});

	test("offers each ability according to its own mana and tap requirements", () => {
		const state = setupMain();
		const source = spawnPermanent(
			state,
			"test-paid-activated-abilities",
			ALICE,
			{ tapped: true },
		);
		state.players[ALICE].manaPool = { w: 0, u: 0, b: 0, r: 1, g: 2, c: 0 };

		const actions = getObservableActions(state, ALICE);
		expect(actions).toContainEqual(action(source.id, paidTarget));
		expect(actions).toContainEqual(action(source.id, paidMana));
		expect(actions).not.toContainEqual(action(source.id, paidTap));

		state.players[ALICE].manaPool = { w: 0, u: 0, b: 0, r: 0, g: 0, c: 0 };
		const unaffordable = getObservableActions(state, ALICE);
		expect(unaffordable).not.toContainEqual(action(source.id, paidTarget));
		expect(unaffordable).not.toContainEqual(action(source.id, paidTap));
		expect(unaffordable).not.toContainEqual(action(source.id, paidMana));
	});

	test("chooses a target before paying a mana-only activation on a tapped source", () => {
		const state = setupMain();
		const source = spawnPermanent(
			state,
			"test-paid-activated-abilities",
			ALICE,
			{ tapped: true },
		);
		state.players[ALICE].manaPool.g = 1;
		state.players[ALICE].manaPool.c = 1;
		let poolSeenWhileTargeting: ManaAmount | undefined;
		const choosingTarget: SyncAgent = {
			choose(_view, request) {
				if (request.kind === "target") {
					poolSeenWhileTargeting = { ...state.players[ALICE].manaPool };
					return { optionId: "player:1" };
				}
				const first = request.options[0];
				if (!first) throw new Error("expected a choice option");
				return { optionId: first.id };
			},
		};

		executeAbilityAction(state, ALICE, action(source.id, paidTarget), [
			choosingTarget,
			new ScriptedAgent(),
		]);

		expect(poolSeenWhileTargeting).toMatchObject({ g: 1, c: 1 });
		expect(state.players[ALICE].manaPool).toMatchObject({ g: 0, c: 0 });
		expect(state.objects.get(source.id)).toMatchObject({ tapped: true });
		expect(state.stack).toHaveLength(1);
	});

	test("an invalid target leaves generic and colored mana untouched", () => {
		const state = setupMain();
		const source = spawnPermanent(
			state,
			"test-paid-activated-abilities",
			ALICE,
		);
		state.players[ALICE].manaPool.g = 2;
		const before = structuredClone(state);
		const invalidTarget: SyncAgent = {
			choose(_view, request) {
				if (request.kind === "target") {
					return { optionId: "permanent:999999" };
				}
				const first = request.options[0];
				if (!first) throw new Error("expected a choice option");
				return { optionId: first.id };
			},
		};

		expect(() =>
			executeAbilityAction(state, ALICE, action(source.id, paidTarget), [
				invalidTarget,
				new ScriptedAgent(),
			]),
		).toThrow(InvalidChoiceAnswerError);
		expect(state).toEqual(before);
	});

	test("pays mana and tap together for an ordinary activated ability", () => {
		const state = setupMain();
		const source = spawnPermanent(
			state,
			"test-paid-activated-abilities",
			ALICE,
		);
		state.players[ALICE].manaPool.g = 1;

		executeAbilityAction(
			state,
			ALICE,
			action(source.id, paidTap),
			passingAgents(),
		);

		expect(state.players[ALICE].manaPool.g).toBe(0);
		expect(state.objects.get(source.id)).toMatchObject({ tapped: true });
		expect(state.stack).toHaveLength(1);
	});

	test("a paid mana ability resolves immediately at normal priority without tapping or using the stack", () => {
		const state = setupMain();
		const source = spawnPermanent(
			state,
			"test-paid-activated-abilities",
			ALICE,
			{ tapped: true },
		);
		state.players[ALICE].manaPool.r = 1;
		const scripted = new ScriptedAgent([], [], [action(source.id, paidMana)]);

		settlePriority(state, [scripted, new ScriptedAgent()]);

		expect(scripted.priorityActions).toHaveLength(0);
		expect(state.players[ALICE].manaPool).toMatchObject({ r: 0, g: 1 });
		expect(state.objects.get(source.id)).toMatchObject({ tapped: true });
		expect(state.stack).toHaveLength(0);
	});

	test("an unaffordable forced activation changes no state", () => {
		const state = setupMain();
		const source = spawnPermanent(
			state,
			"test-paid-activated-abilities",
			ALICE,
		);
		const before = structuredClone(state);

		expect(() =>
			executeAbilityAction(
				state,
				ALICE,
				action(source.id, paidTap),
				passingAgents(),
			),
		).toThrow(IllegalAbilityActivationError);
		expect(state).toEqual(before);
	});

	test("async replay pays combined mana and tap costs exactly once", async () => {
		const checkpoint = setupMain();
		spawnPermanent(checkpoint, "test-paid-tap-pass-through", BOB);
		spawnPermanent(checkpoint, "test-paid-tap-pass-through-second", BOB);
		const forest = spawnPermanent(checkpoint, "forest", ALICE);
		const source = spawnPermanent(
			checkpoint,
			"test-paid-activated-abilities",
			ALICE,
		);
		const activate = action(source.id, paidTap);
		const before = structuredClone(checkpoint);
		const scripted = new ScriptedAgent(
			[],
			[],
			[manaAction(forest.id), activate],
		);
		let replacementRequests = 0;
		const asyncReplacement: Agent = {
			choose(view, request) {
				if (request.kind !== "replacement") {
					return scripted.choose(view, request);
				}
				replacementRequests++;
				const first = request.options[0];
				if (!first) throw new Error("expected a replacement option");
				return Promise.resolve({ optionId: first.id });
			},
		};

		const result = await advanceWithReplay(checkpoint, [
			asyncReplacement,
			new ScriptedAgent(),
		]);

		expect(checkpoint).toEqual(before);
		expect(result.attempts).toBe(2);
		expect(replacementRequests).toBe(1);
		expect(result.state.objects.get(forest.id)).toMatchObject({ tapped: true });
		expect(result.state.objects.get(source.id)).toMatchObject({ tapped: true });
		expect(result.state.players[ALICE].manaPool.g).toBe(0);
		expect(result.state.players[ALICE].life).toBe(21);
		expect(result.state.stack).toHaveLength(0);
	});

	test("a replaced-away tap rolls back mana, announcement, and replacement effects", () => {
		const state = setupMain();
		spawnPermanent(state, "test-paid-tap-fizzle", BOB);
		const source = spawnPermanent(
			state,
			"test-paid-activated-abilities",
			ALICE,
		);
		state.players[ALICE].manaPool.g = 1;
		const before = structuredClone(state);

		expect(() =>
			executeAbilityAction(
				state,
				ALICE,
				action(source.id, paidTap),
				passingAgents(),
			),
		).toThrow(IllegalAbilityActivationError);
		expect(state).toEqual(before);
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

	test("summoning sickness prevents a creature from paying a tap cost", () => {
		const state = setupMain();
		const looter = spawnPermanent(state, "merfolk-looter", ALICE);
		const action = looterAction(looter.id);

		expect(getObservableActions(state, ALICE)).not.toContainEqual(action);
		expect(() =>
			executeAbilityAction(state, ALICE, action, passingAgents()),
		).toThrow(IllegalAbilityActivationError);
		expect(state.objects.get(looter.id)).toMatchObject({ tapped: false });
	});

	function looterAction(source: ObjectId): ActivateAbilityAction {
		return { kind: "activate ability", source, ability: looterAbility };
	}

	test("taps and captures instructions, then resolves after its source leaves", () => {
		const state = setupMain();
		const looter = spawnPermanent(state, "merfolk-looter", ALICE, {
			summoningSick: false,
		});
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
		const looter = spawnPermanent(checkpoint, "merfolk-looter", ALICE, {
			summoningSick: false,
		});
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
