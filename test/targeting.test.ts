import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "../agents.ts";
import "../cards.ts";
import { priorityOptionId } from "../choices.ts";
import {
	type Agent,
	abilityId,
	advanceWithReplay,
	buildPlayerView,
	ChoiceController,
	ChoiceReplayMismatchError,
	type EntityRef,
	executeCastAction,
	type GameState,
	getObservableActions,
	IllegalCastError,
	InvalidChoiceAnswerError,
	newGame,
	type ObjectId,
	perform,
	registerCard,
	type SpellTargets,
	settlePriority,
	spawnCard,
	spawnPermanent,
	type TargetDef,
	turnLocation,
} from "../index.ts";
import {
	advanceUntil,
	passingAgents,
	registerCardFixture,
} from "./utils/engine-helpers.ts";

for (const file of [
	"m/murder",
	"l/lightning_bolt",
	"g/giant_growth",
	"s/swamp",
	"s/sorins_thirst",
]) {
	registerCardFixture(file);
}

const creatureTarget: TargetDef = {
	id: "target-1",
	min: 1,
	max: 1,
	legal: { kind: "permanent", selector: { kind: "type", type: "creature" } },
};

describe("target bindings and choices", () => {
	test("zone movement installs detached bindings visible to both players", () => {
		const state = newGame();
		const spell = spawnCard(state, "murder", 0, "hand");
		const creature = spawnPermanent(state, "grizzly-bears", 1);
		const targets: SpellTargets = [
			{ slot: "target-1", target: { type: "permanent", id: creature.id } },
		];
		perform(
			state,
			{
				kind: "change zone",
				object: spell.id,
				from: "hand",
				to: "stack",
				cause: "cast",
				toController: 0,
				spellTargets: targets,
			},
			passingAgents(),
		);
		const entry = state.stack[0];
		if (entry?.kind !== "spell") throw new Error("expected spell");
		expect(entry.objectId).not.toBe(spell.id);
		expect(entry.targets).toEqual(targets);
		expect(entry.targets).not.toBe(targets);
		for (const player of [0, 1] as const) {
			const view = buildPlayerView(state, player);
			expect(view.stack[0]).toMatchObject({ targets });
			expect(JSON.parse(JSON.stringify(view)).stack[0].targets).toEqual(
				targets,
			);
		}
		const cloned = structuredClone(state);
		expect(buildPlayerView(cloned, 1).stack[0]).toMatchObject({ targets });
	});

	test("target choices replay and reject a changed candidate list", () => {
		const state = newGame();
		const spell = spawnCard(state, "murder", 0, "hand");
		const creature = spawnPermanent(state, "grizzly-bears", 1);
		const target: EntityRef = { type: "permanent", id: creature.id };
		const controller = ChoiceController.record(passingAgents());
		expect(
			controller.chooseTarget(state, 0, spell.id, creatureTarget, [target]),
		).toEqual(target);
		const transcript = JSON.parse(JSON.stringify(controller.transcript()));
		const replay = ChoiceController.replay(transcript);
		expect(
			replay.chooseTarget(state, 0, spell.id, creatureTarget, [target]),
		).toEqual(target);
		replay.assertComplete();
		expect(() =>
			ChoiceController.replay(transcript).chooseTarget(
				state,
				0,
				spell.id,
				creatureTarget,
				[{ type: "player", player: 1 }],
			),
		).toThrow(ChoiceReplayMismatchError);
	});
});

// This definition follows cards/cardsfolder/d/doom_blade.txt. Its Forge
// syntax is outside the importer subset.
registerCard({
	id: "target-test-doom-blade",
	name: "Doom Blade",
	types: ["instant"],
	colors: ["b"],
	manaCost: { c: 1, b: 1 },
	spell: {
		id: "spell",
		text: "Destroy target nonblack creature.",
		targets: [
			{
				...creatureTarget,
				legal: {
					kind: "permanent",
					selector: {
						kind: "all",
						selectors: [
							{ kind: "type", type: "creature" },
							{ kind: "not", selector: { kind: "color", color: "b" } },
						],
					},
				},
			},
		],
		effects: [{ kind: "destroy", target: "target-1" }],
	},
});
// Synthetic fixture isolates a layer-4 change without adding another card mechanic.
registerCard({
	id: "target-test-remove-creature-type",
	name: "Test creature type removal",
	types: ["enchantment"],
	colors: [],
	manaCost: "zero",
	statics: [
		{
			layer: "4-type-changing",
			text: "Creatures are noncreature artifacts.",
			applies: (v) => v.types.includes("creature"),
			modify: (v) => {
				v.types = ["artifact"];
			},
		},
	],
});

// Only the type matters: this fixture deliberately has no planeswalker mechanics.
registerCard({
	id: "target-test-planeswalker-type",
	name: "Test planeswalker type change",
	types: ["enchantment"],
	colors: [],
	manaCost: "zero",
	statics: [
		{
			layer: "4-type-changing",
			text: "Creatures are planeswalkers.",
			applies: (v) => v.types.includes("creature"),
			modify: (v) => {
				v.types = ["planeswalker"];
			},
		},
	],
});

function setupCast(cardId = "murder") {
	const state = newGame();
	for (const player of [0, 1] as const) {
		for (let i = 0; i < 5; i++) spawnCard(state, "forest", player, "library");
	}
	advanceUntil(
		state,
		passingAgents(),
		(next) => turnLocation(next)?.kind === "mainPhase",
	);
	const spell = spawnCard(state, cardId, 0, "hand");
	// Focus these tests on targeting; mana activation has its own integration tests.
	perform(
		state,
		{
			kind: "add mana",
			source: spell.id,
			player: 0,
			mana: { b: 3, r: 1, g: 1 },
		},
		passingAgents(),
	);
	return { state, spell };
}

function castAt(state: GameState, card: ObjectId, target: EntityRef) {
	const agents = passingAgents();
	agents[0].targetChoices.push(target);
	executeCastAction(state, 0, { kind: "cast", card }, agents);
	expect(agents[0].targetChoices).toHaveLength(0);
}

describe("single-target spell casting", () => {
	test("Murder is unavailable with no creature; direct execution changes nothing", () => {
		const { state, spell } = setupCast();
		spawnPermanent(state, "forest", 1);
		expect(getObservableActions(state, 0)).not.toContainEqual({
			kind: "cast",
			card: spell.id,
		});
		const before = structuredClone(state);
		expect(() =>
			executeCastAction(
				state,
				0,
				{ kind: "cast", card: spell.id },
				passingAgents(),
			),
		).toThrow(IllegalCastError);
		expect(state).toEqual(before);
	});

	test("invalid and multiple-choice target answers spend no mana or move the card", () => {
		for (const answer of [
			{ optionId: "permanent:999999" },
			{ optionIds: ["player:0", "player:1"] },
		]) {
			const { state, spell } = setupCast();
			spawnPermanent(state, "grizzly-bears", 1);
			const before = structuredClone(state);
			expect(() =>
				executeCastAction(state, 0, { kind: "cast", card: spell.id }, [
					{ choose: () => answer },
					new ScriptedAgent(),
				]),
			).toThrow(InvalidChoiceAnswerError);
			expect(state).toEqual(before);
		}
	});

	test("deferred selectors and P/T effects fail before payment", () => {
		for (const cardId of ["target-test-doom-blade", "giant-growth"]) {
			const { state, spell } = setupCast(cardId);
			spawnPermanent(state, "grizzly-bears", 1);
			const before = structuredClone(state);
			expect(() =>
				executeCastAction(
					state,
					0,
					{ kind: "cast", card: spell.id },
					passingAgents(),
				),
			).toThrow(/not implemented/);
			expect(state).toEqual(before);
		}
	});

	test("Murder resolves through the destroy pipeline, including indestructible", () => {
		for (const cardId of ["grizzly-bears", "darksteel-myr"]) {
			const { state, spell } = setupCast();
			const creature = spawnPermanent(state, cardId, 1);
			castAt(state, spell.id, { type: "permanent", id: creature.id });
			expect(state.players[0].manaPool.b).toBe(0);
			expect(state.stack[0]).toMatchObject({
				targets: [
					{ slot: "target-1", target: { type: "permanent", id: creature.id } },
				],
			});
			settlePriority(state, passingAgents());
			expect(state.objects.has(creature.id)).toBe(cardId === "darksteel-myr");
			expect(state.stack).toHaveLength(0);
			expect(state.players[0].graveyard).toHaveLength(1);
		}
	});

	test("Bolt offers players and creatures, excludes ordinary lands, and honors damage replacement", () => {
		const { state, spell } = setupCast("lightning-bolt");
		const creature = spawnPermanent(state, "grizzly-bears", 1);
		spawnPermanent(state, "forest", 1);
		spawnPermanent(state, "furnace-of-rath", 1);
		const choices = ChoiceController.record(passingAgents());
		executeCastAction(state, 0, { kind: "cast", card: spell.id }, choices);
		const request = choices.transcript().choices[0]?.request;
		expect(request?.kind).toBe("target");
		expect(request?.options.map((option) => option.id)).toEqual([
			"player:0",
			"player:1",
			`permanent:${creature.id}`,
		]);
		settlePriority(state, passingAgents());
		expect(state.players[0].life).toBe(14);
	});

	test("Bolt kills a creature through state-based actions", () => {
		const { state, spell } = setupCast("lightning-bolt");
		const creature = spawnPermanent(state, "grizzly-bears", 1);
		castAt(state, spell.id, { type: "permanent", id: creature.id });
		settlePriority(state, passingAgents());
		expect(state.objects.has(creature.id)).toBe(false);
		expect(state.players[1].graveyard).toHaveLength(1);
	});

	test("a response removes Murder's target before it resolves", () => {
		const { state, spell } = setupCast();
		const creature = spawnPermanent(state, "grizzly-bears", 1);
		castAt(state, spell.id, { type: "permanent", id: creature.id });
		const response = spawnCard(state, "lightning-bolt", 1, "hand");
		perform(
			state,
			{ kind: "add mana", source: response.id, player: 1, mana: { r: 1 } },
			passingAgents(),
		);
		const agents = passingAgents();
		agents[1].priorityActions.push({ kind: "cast", card: response.id });
		agents[1].targetChoices.push({ type: "permanent", id: creature.id });
		settlePriority(state, agents);
		expect(agents[1].priorityActions).toHaveLength(0);
		expect(state.stack).toHaveLength(0);
		expect(state.objects.has(creature.id)).toBe(false);
		expect(state.log.some((line) => line.includes("[illegal target]"))).toBe(
			true,
		);
	});

	test("leaving and returning creates a new object that Murder cannot destroy", () => {
		const { state, spell } = setupCast();
		const creature = spawnPermanent(state, "grizzly-bears", 1);
		castAt(state, spell.id, { type: "permanent", id: creature.id });
		const [away] = perform(
			state,
			{
				kind: "change zone",
				object: creature.id,
				from: "battlefield",
				to: "exile",
				cause: "effect",
				toController: 1,
			},
			passingAgents(),
		).created;
		if (away === undefined) throw new Error("missing exiled card");
		const [returned] = perform(
			state,
			{
				kind: "change zone",
				object: away,
				from: "exile",
				to: "battlefield",
				cause: "effect",
				toController: 1,
			},
			passingAgents(),
		).created;
		settlePriority(state, passingAgents());
		if (returned === undefined) throw new Error("missing returned permanent");
		expect(returned).not.toBe(creature.id);
		expect(state.battlefield).toContain(returned);
	});

	test("current type is rechecked before resolving Murder", () => {
		const { state, spell } = setupCast();
		const creature = spawnPermanent(state, "grizzly-bears", 1);
		castAt(state, spell.id, { type: "permanent", id: creature.id });
		spawnPermanent(state, "target-test-remove-creature-type", 1);
		settlePriority(state, passingAgents());
		expect(state.battlefield).toContain(creature.id);
		expect(state.log.some((line) => line.includes("[illegal target]"))).toBe(
			true,
		);
	});

	test("damage asserts on current planeswalker characteristics", () => {
		const { state, spell } = setupCast("lightning-bolt");
		const creature = spawnPermanent(state, "grizzly-bears", 1);
		castAt(state, spell.id, { type: "permanent", id: creature.id });
		spawnPermanent(state, "target-test-planeswalker-type", 1);
		expect(() => settlePriority(state, passingAgents())).toThrow(
			"planeswalker damage is not implemented",
		);
		expect(creature.damage).toBe(0);
	});

	test("an illegal target stops even Sorin's Thirst's untargeted life gain", () => {
		const { state, spell } = setupCast("sorins-thirst");
		const creature = spawnPermanent(state, "grizzly-bears", 1);
		castAt(state, spell.id, { type: "permanent", id: creature.id });
		perform(
			state,
			{ kind: "destroy", object: creature.id, noRegen: false },
			passingAgents(),
		);
		settlePriority(state, passingAgents());
		expect(state.players[0].life).toBe(20);
		expect(state.stack).toHaveLength(0);
	});

	test("async target selection replays the cast without repeating the priority choice", async () => {
		const { state, spell } = setupCast();
		const creature = spawnPermanent(state, "grizzly-bears", 1);
		const swamps = [0, 1, 2].map(() => spawnPermanent(state, "swamp", 0));
		const scripted = new ScriptedAgent(
			[],
			[],
			[
				...swamps.map((source) => ({
					kind: "activate ability" as const,
					source: source.id,
					ability: abilityId("activated", "swamp", 0),
				})),
				{ kind: "cast", card: spell.id },
			],
		);
		const before = structuredClone(state);
		let castChoices = 0;
		let targetChoices = 0;
		const agent: Agent = {
			choose(_view, request) {
				if (request.kind === "target") {
					targetChoices++;
					return Promise.resolve({ optionId: `permanent:${creature.id}` });
				}
				const answer = scripted.choose(_view, request);
				if (
					"optionId" in answer &&
					answer.optionId === priorityOptionId({ kind: "cast", card: spell.id })
				)
					castChoices++;
				return answer;
			},
		};
		let checkpoint = state;
		let attempts = 0;
		for (let i = 0; i < 10 && checkpoint.objects.has(spell.id); i++) {
			const result = await advanceWithReplay(checkpoint, [
				agent,
				new ScriptedAgent(),
			]);
			checkpoint = result.state;
			attempts = Math.max(attempts, result.attempts);
		}
		expect(state).toEqual(before);
		expect(castChoices).toBe(1);
		expect(targetChoices).toBe(1);
		expect(attempts).toBe(2);
		expect(checkpoint.objects.has(spell.id)).toBe(false);
		expect(checkpoint.players[0].manaPool.b).toBe(0);
	});
});
