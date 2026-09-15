import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "../agents.ts";
import { CARDS, prismaticStrands } from "../cards.ts";
import {
	type ActivatedAbilityDef,
	type Agent,
	type AnyActivatedAbilityDefinition,
	abilityId,
	addTemporaryEffect,
	ChoiceController,
	type ChoiceRequest,
	createEngine,
	defineCard,
	type EntityRef,
	type GameState,
	getSnapshot,
	IllegalAbilityActivationError,
	InvalidChoiceAnswerError,
	type ObjectId,
	type PlayerId,
	type PlayerView,
	type SyncAgent,
	turnLocation,
} from "../index.ts";
import {
	advanceUntil,
	loadCardFixture,
	passingAgents,
} from "./utils/engine-helpers.ts";

const FIXTURE_CARDS = [
	"p/prodigal_sorcerer",
	"f/flametongue_kavu",
	"m/manic_vandal",
	"c/charcoal_diamond",
	"l/lightning_bolt",
].map(loadCardFixture);

const PRODIGAL_SORCERER_TAP = abilityId("activated", "prodigal-sorcerer", 0);
const SELF_DESTROYER_TAP = abilityId("activated", "test-self-destroyer", 0);
const ARTIFACT_PINGER_TAP = abilityId("activated", "test-artifact-pinger", 0);
const PINGER_TAP = abilityId("activated", "test-pinger", 0);
const ASSASSIN_TAP = abilityId("activated", "test-assassin", 0);

const artifactTarget = {
	id: "target-1",
	min: 1,
	max: 1,
	legal: {
		kind: "permanent" as const,
		predicate: { kind: "type" as const, type: "artifact" as const },
	},
};

/**
 * Prodigal Sorcerer's ability on a plain blue creature. Everything the damage
 * event reads off this source — its colours, its lifelink, its controller —
 * is acquired *after* activation in the tests below, so an activation-time
 * snapshot would give different answers than CR 608.2h requires.
 */
const TEST_CARD_1 = defineCard({
	id: "test-pinger",
	name: "Test pinger",
	types: ["creature"],
	subtypes: ["Wizard"],
	colors: ["u"],
	manaCost: { u: 1 },
	power: 1,
	toughness: 1,
	activatedAbilities: [
		{
			kind: "activated",
			id: "ping",
			text: "{T}: This creature deals 2 damage to any target.",
			cost: { mana: "zero", tapSelf: true },
			targets: [
				{ id: "target-1", min: 1, max: 1, legal: { kind: "any-target" } },
			],
			effects: [
				{
					kind: "damage",
					subject: { kind: "target", slot: "target-1" },
					amount: 2,
				},
			],
		},
	],
});

const TEST_CARD_2 = defineCard({
	id: "test-lifelink-grant",
	name: "Test lifelink grant",
	types: ["enchantment"],
	colors: [],
	manaCost: "zero",
	statics: [
		{
			kind: "characteristic",
			text: "Creatures have lifelink.",
			applies: (v) => v.currentCharacteristics.types.includes("creature"),
			effects: [
				{
					layer: "6-ability-changing",
					modify: (v) => {
						v.keywords.push("lifelink");
					},
				},
			],
		},
	],
});

const TEST_CARD_3 = defineCard({
	id: "test-red-creatures",
	name: "Test red creatures",
	types: ["enchantment"],
	colors: [],
	manaCost: "zero",
	statics: [
		{
			kind: "characteristic",
			text: "Creatures are red.",
			applies: (v) => v.currentCharacteristics.types.includes("creature"),
			effects: [
				{
					layer: "5-color-changing",
					modify: (v) => {
						v.colors = ["r"];
					},
				},
			],
		},
	],
});

/** A targeted trigger with an untargeted effect after it, like Sorin's Thirst. */
const TEST_CARD_4 = defineCard({
	id: "test-vengeful-herald",
	name: "Test vengeful herald",
	types: ["creature"],
	subtypes: ["Cleric"],
	colors: ["w"],
	manaCost: { w: 1 },
	power: 1,
	toughness: 1,
	triggers: [
		{
			id: "etb-strike",
			text: "When this creature enters, destroy target creature. You gain 3 life.",
			condition: {
				kind: "change zone",
				from: "any",
				to: "battlefield",
				predicate: { kind: "self" },
			},
			targets: [
				{
					id: "target-1",
					min: 1,
					max: 1,
					legal: {
						kind: "permanent",
						predicate: { kind: "type", type: "creature" },
					},
				},
			],
			effects: [
				{ kind: "destroy", subject: { kind: "target", slot: "target-1" } },
				{
					kind: "gain-life",
					subject: { kind: "relative-player", player: "you" },
					amount: 3,
				},
			],
		},
	],
});

/**
 * Synthetic: the only shape in the supported effect set where an ability's own
 * source leaves the battlefield partway through that ability's resolution.
 */
const TEST_CARD_5 = defineCard({
	id: "test-self-destroyer",
	name: "Test self destroyer",
	types: ["artifact", "creature"],
	subtypes: ["Construct"],
	colors: [],
	manaCost: { n: 1 },
	power: 1,
	toughness: 1,
	activatedAbilities: [
		{
			kind: "activated",
			id: "wreck",
			text: "{T}: Destroy target artifact. This deals 2 damage to it.",
			cost: { mana: "zero", tapSelf: true },
			targets: [artifactTarget],
			effects: [
				{ kind: "destroy", subject: { kind: "target", slot: "target-1" } },
				{
					kind: "damage",
					subject: { kind: "target", slot: "target-1" },
					amount: 2,
				},
			],
		},
	],
});

/** Synthetic: a controller restriction, which no imported card carries yet. */
const TEST_CARD_6 = defineCard({
	id: "test-assassin",
	name: "Test assassin",
	types: ["creature"],
	subtypes: ["Assassin"],
	colors: ["b"],
	manaCost: { b: 1 },
	power: 1,
	toughness: 1,
	activatedAbilities: [
		{
			kind: "activated",
			id: "slay",
			text: "{T}: Destroy target creature an opponent controls.",
			cost: { mana: "zero", tapSelf: true },
			targets: [
				{
					id: "target-1",
					min: 1,
					max: 1,
					legal: {
						kind: "permanent",
						predicate: {
							kind: "and",
							predicates: [
								{ kind: "type", type: "creature" },
								{ kind: "controller", player: "opponent" },
							],
						},
					},
				},
			],
			effects: [
				{ kind: "destroy", subject: { kind: "target", slot: "target-1" } },
			],
		},
	],
});

/**
 * Synthetic: a replacement that lets paying a tap cost be the thing that
 * removes the source, which is the only way an activation's own cost can
 * destroy its source under the supported event set.
 */
const TEST_CARD_7 = defineCard({
	id: "test-tap-backlash",
	name: "Test tap backlash",
	types: ["enchantment"],
	colors: [],
	manaCost: "zero",
	replacements: [
		{
			label: "tap-backlash",
			text: "If a permanent would become tapped, it becomes tapped and is destroyed.",
			layer: "other",
			functionsFrom: "any",
			applies: (ev) => ev.kind === "tap" && ev.objects.length === 1,
			replace(ev) {
				if (ev.kind !== "tap" || ev.objects.length !== 1) return [ev];
				const object = ev.objects[0];
				if (object === undefined) throw new Error("tap event has no object");
				return [ev, { kind: "destroy", object, noRegen: true }];
			},
		},
	],
});

/**
 * Synthetic: a replacement that makes paying the tap cost impossible after it
 * has already changed the game, so a failed activation has something to undo.
 */
const TEST_CARD_8 = defineCard({
	id: "test-tap-fizzle",
	name: "Test tap fizzle",
	types: ["enchantment"],
	colors: [],
	manaCost: "zero",
	replacements: [
		{
			label: "tap-fizzle",
			text: "If a permanent would become tapped, its controller loses 1 life instead.",
			layer: "other",
			functionsFrom: "any",
			applies: (ev) => ev.kind === "tap" && ev.objects.length === 1,
			replace: (_ev, ctx) => [
				{ kind: "lose life", player: ctx.controller, amount: 1 },
			],
		},
	],
});

/** Synthetic: only this test mutates its registry definition, so it owns one. */
const TEST_CARD_9 = defineCard({
	id: "test-registry-probe",
	name: "Test registry probe",
	types: ["creature"],
	subtypes: ["Wizard"],
	colors: ["u"],
	manaCost: { u: 1 },
	power: 1,
	toughness: 1,
	activatedAbilities: [
		{
			kind: "activated",
			id: "ping",
			text: "{T}: This creature deals 2 damage to any target.",
			cost: { mana: "zero", tapSelf: true },
			targets: [
				{ id: "target-1", min: 1, max: 1, legal: { kind: "any-target" } },
			],
			effects: [
				{
					kind: "damage",
					subject: { kind: "target", slot: "target-1" },
					amount: 2,
				},
			],
		},
	],
});

/** Synthetic: a targeted activation whose restriction is not always satisfiable. */
const TEST_CARD_10 = defineCard({
	id: "test-artifact-pinger",
	name: "Test artifact pinger",
	types: ["creature"],
	subtypes: ["Wizard"],
	colors: ["r"],
	manaCost: { r: 1 },
	power: 1,
	toughness: 1,
	activatedAbilities: [
		{
			kind: "activated",
			id: "ping",
			text: "{T}: This creature deals 1 damage to target artifact.",
			cost: { mana: "zero", tapSelf: true },
			targets: [artifactTarget],
			effects: [
				{
					kind: "damage",
					subject: { kind: "target", slot: "target-1" },
					amount: 1,
				},
			],
		},
	],
});

const engine = createEngine([
	...CARDS,
	...FIXTURE_CARDS,
	TEST_CARD_1,
	TEST_CARD_2,
	TEST_CARD_3,
	TEST_CARD_4,
	TEST_CARD_5,
	TEST_CARD_6,
	TEST_CARD_7,
	TEST_CARD_8,
	TEST_CARD_9,
	TEST_CARD_10,
]);

function assertActivated(
	definition: AnyActivatedAbilityDefinition,
): asserts definition is ActivatedAbilityDef {
	if (definition.kind !== "activated")
		throw new Error("expected an activation");
}

function mainPhaseGame(): GameState {
	const state = engine.newGame();
	for (const player of [0, 1] as const) {
		for (let i = 0; i < 5; i++)
			engine.spawnCard(state, "forest", player, "library");
	}
	advanceUntil(
		engine,
		state,
		passingAgents(),
		(next) => turnLocation(next)?.kind === "mainPhase",
	);
	return state;
}

function activateAt(
	state: GameState,
	source: ObjectId,
	ability: ReturnType<typeof abilityId<"activated">>,
	target: EntityRef,
): void {
	const agents = passingAgents();
	agents[0].targetChoices.push(target);
	engine.executeAbilityAction(
		state,
		0,
		{ kind: "activate ability", source, ability },
		agents,
	);
	expect(agents[0].targetChoices).toHaveLength(0);
}

describe("self-pumping activated abilities", () => {
	test("Zof Shade's activated pump applies through the layer system", () => {
		const state = mainPhaseGame();
		const shade = engine.spawnPermanent(state, "zof-shade", 0);
		state.players[0].manaPool.b = 1;
		state.players[0].manaPool.c = 2;

		const read = () =>
			getSnapshot(engine.createReadContext(state), shade.id)
				.currentCharacteristics;
		expect(read()).toMatchObject({ power: 2, toughness: 2 });

		engine.executeAbilityAction(
			state,
			0,
			{
				kind: "activate ability",
				source: shade.id,
				ability: abilityId("activated", "zof-shade", 0),
			},
			passingAgents(),
		);
		engine.settlePriority(state, passingAgents());

		// The bonus comes from the ability's own definition, reached through the
		// temporary effect's reference to it.
		expect(read()).toMatchObject({ power: 4, toughness: 4 });
		expect(state.temporaryEffects).toHaveLength(1);
		expect(state.temporaryEffects[0]).toMatchObject({
			source: { origin: "ability-effect", category: "activated" },
		});
	});
});

describe("targeted activated abilities", () => {
	test("Prodigal Sorcerer offers every any-target and damages the one chosen", () => {
		const state = mainPhaseGame();
		const sorcerer = engine.spawnPermanent(state, "prodigal-sorcerer", 0, {
			summoningSick: false,
		});
		const bears = engine.spawnPermanent(state, "grizzly-bears", 1);
		engine.spawnPermanent(state, "forest", 1);

		expect(engine.getObservableActions(state, 0)).toContainEqual({
			kind: "activate ability",
			source: sorcerer.id,
			ability: PRODIGAL_SORCERER_TAP,
		});

		const choices = ChoiceController.record(engine, passingAgents());
		engine.executeAbilityAction(
			state,
			0,
			{
				kind: "activate ability",
				source: sorcerer.id,
				ability: PRODIGAL_SORCERER_TAP,
			},
			choices,
		);
		const request = choices.transcript().choices[0]?.request;
		expect(request?.kind).toBe("target");
		expect(request?.options.map((option) => option.id)).toEqual([
			"player:0",
			"player:1",
			`permanent:${sorcerer.id}`,
			`permanent:${bears.id}`,
		]);
		expect(state.stack).toHaveLength(1);
		expect(sorcerer.tapped).toBe(true);

		engine.settlePriority(state, passingAgents());
		expect(state.players[1].life).toBe(20);
		expect(state.players[0].life).toBe(19);
	});

	test("a restricted activation is not offered and cannot be forced without a target", () => {
		const state = mainPhaseGame();
		const pinger = engine.spawnPermanent(state, "test-artifact-pinger", 0, {
			summoningSick: false,
		});
		expect(engine.getObservableActions(state, 0)).not.toContainEqual({
			kind: "activate ability",
			source: pinger.id,
			ability: ARTIFACT_PINGER_TAP,
		});
		const before = structuredClone(state);
		expect(() =>
			engine.executeAbilityAction(
				state,
				0,
				{
					kind: "activate ability",
					source: pinger.id,
					ability: ARTIFACT_PINGER_TAP,
				},
				passingAgents(),
			),
		).toThrow(IllegalAbilityActivationError);
		expect(state).toEqual(before);

		engine.spawnPermanent(state, "darksteel-relic", 1);
		expect(engine.getObservableActions(state, 0)).toContainEqual({
			kind: "activate ability",
			source: pinger.id,
			ability: ARTIFACT_PINGER_TAP,
		});
	});

	test("an invalid target answer leaves the source untapped and the stack empty", () => {
		const state = mainPhaseGame();
		const sorcerer = engine.spawnPermanent(state, "prodigal-sorcerer", 0, {
			summoningSick: false,
		});
		const before = structuredClone(state);
		expect(() =>
			engine.executeAbilityAction(
				state,
				0,
				{
					kind: "activate ability",
					source: sorcerer.id,
					ability: PRODIGAL_SORCERER_TAP,
				},
				[
					{ choose: () => ({ optionId: "permanent:999999" }) },
					new ScriptedAgent(),
				],
			),
		).toThrow(InvalidChoiceAnswerError);
		expect(state).toEqual(before);
		expect(sorcerer.tapped).toBe(false);
	});

	test("a controller restriction is rechecked, and only the opponent's creatures qualify", () => {
		const state = mainPhaseGame();
		const assassin = engine.spawnPermanent(state, "test-assassin", 0, {
			summoningSick: false,
		});
		const mine = engine.spawnPermanent(state, "grizzly-bears", 0);
		const theirs = engine.spawnPermanent(state, "grizzly-bears", 1);

		const choices = ChoiceController.record(engine, passingAgents());
		engine.executeAbilityAction(
			state,
			0,
			{
				kind: "activate ability",
				source: assassin.id,
				ability: ASSASSIN_TAP,
			},
			choices,
		);
		const request = choices.transcript().choices[0]?.request;
		expect(request?.options.map((option) => option.id)).toEqual([
			`permanent:${theirs.id}`,
		]);
		expect(mine.id).not.toBe(theirs.id);

		// Control-changing effects are not implemented; this is the canonical
		// state one would leave behind.
		theirs.controller = 0;
		state.revision++;
		engine.settlePriority(state, passingAgents());
		expect(state.objects.has(theirs.id)).toBe(true);
		expect(state.log.some((line) => line.includes("[illegal target]"))).toBe(
			true,
		);
	});

	test("an illegal target at resolution stops the ability", () => {
		const state = mainPhaseGame();
		const sorcerer = engine.spawnPermanent(state, "prodigal-sorcerer", 0, {
			summoningSick: false,
		});
		const bears = engine.spawnPermanent(state, "grizzly-bears", 1);
		activateAt(state, sorcerer.id, PRODIGAL_SORCERER_TAP, {
			type: "permanent",
			id: bears.id,
		});
		engine.perform(
			state,
			{ kind: "destroy", object: bears.id, noRegen: false },
			passingAgents(),
		);
		engine.settlePriority(state, passingAgents());
		expect(state.stack).toHaveLength(0);
		expect(state.log.some((line) => line.includes("[illegal target]"))).toBe(
			true,
		);
	});
});

describe("an ability outliving its source", () => {
	test("lifelink and the life's recipient come from the source's last existence", () => {
		const state = mainPhaseGame();
		const pinger = engine.spawnPermanent(state, "test-pinger", 0, {
			summoningSick: false,
		});
		// P0 controls the ability and points it at themself, so the damage and the
		// lifelink life go to different players and cannot be confused.
		activateAt(state, pinger.id, PINGER_TAP, { type: "player", player: 0 });

		engine.spawnPermanent(state, "test-lifelink-grant", 0);
		// Control-changing effects are not implemented; this is the canonical
		// state one would leave behind.
		pinger.controller = 1;
		state.revision++;
		engine.perform(
			state,
			{ kind: "destroy", object: pinger.id, noRegen: false },
			passingAgents(),
		);
		expect(state.objects.has(pinger.id)).toBe(false);

		engine.settlePriority(state, passingAgents());
		expect(state.players[0].life).toBe(18);
		// Lifelink was granted, and control moved, after the ability was
		// activated: both are read as the source last existed.
		expect(state.players[1].life).toBe(22);
	});

	test("the departed source's colors still decide whether prevention applies", () => {
		const state = mainPhaseGame();
		const pinger = engine.spawnPermanent(state, "test-pinger", 0, {
			summoningSick: false,
		});
		activateAt(state, pinger.id, PINGER_TAP, { type: "player", player: 1 });

		// The source is blue when activated and red when it leaves.
		engine.spawnPermanent(state, "test-red-creatures", 0);
		// "Prevent all damage red sources would deal this turn."
		addTemporaryEffect(state, 1, prismaticStrands("r"));
		engine.perform(
			state,
			{ kind: "destroy", object: pinger.id, noRegen: false },
			passingAgents(),
		);
		engine.settlePriority(state, passingAgents());
		expect(state.players[1].life).toBe(20);
	});

	test("paying the tap cost can remove the source, and the ability still resolves", () => {
		const state = mainPhaseGame();
		engine.spawnPermanent(state, "test-tap-backlash", 1);
		engine.spawnPermanent(state, "test-lifelink-grant", 1);
		const pinger = engine.spawnPermanent(state, "test-pinger", 0, {
			summoningSick: false,
		});

		activateAt(state, pinger.id, PINGER_TAP, { type: "player", player: 1 });
		// The tap cost was paid and the same replacement then destroyed the source.
		expect(state.objects.has(pinger.id)).toBe(false);
		expect(state.stack).toHaveLength(1);

		engine.settlePriority(state, passingAgents());
		expect(state.players[1].life).toBe(18);
		// The lifelink the source had when it left still applies, so the ability
		// resolved from the information captured during its own cost payment.
		expect(state.players[0].life).toBe(22);
	});

	test("an unpayable tap cost rewinds the announcement and everything with it", () => {
		const state = mainPhaseGame();
		engine.spawnPermanent(state, "test-tap-fizzle", 1);
		const pinger = engine.spawnPermanent(state, "test-pinger", 0, {
			summoningSick: false,
		});
		const before = structuredClone(state);

		const agents = passingAgents();
		agents[0].targetChoices.push({ type: "player", player: 1 });
		expect(() =>
			engine.executeAbilityAction(
				state,
				0,
				{ kind: "activate ability", source: pinger.id, ability: PINGER_TAP },
				agents,
			),
		).toThrow(IllegalAbilityActivationError);

		// The replacement's life loss, the announced stack item, the log lines and
		// the stack-item counter are all rolled back (CR 733.1).
		expect(state).toEqual(before);
	});

	test("a rejected choice while paying rewinds the announcement too", () => {
		const state = mainPhaseGame();
		// Two copies make the tap replacement a real decision for P0.
		engine.spawnPermanent(state, "test-tap-fizzle", 1);
		engine.spawnPermanent(state, "test-tap-fizzle", 1);
		const pinger = engine.spawnPermanent(state, "test-pinger", 0, {
			summoningSick: false,
		});
		const before = structuredClone(state);

		expect(() =>
			engine.executeAbilityAction(
				state,
				0,
				{ kind: "activate ability", source: pinger.id, ability: PINGER_TAP },
				[
					{
						choose: (_view, request) =>
							request.kind === "target"
								? { optionId: "player:1" }
								: { optionId: "not-an-option" },
					},
					new ScriptedAgent(),
				],
			),
		).toThrow(InvalidChoiceAnswerError);
		expect(state).toEqual(before);
	});

	test("a source that destroys itself mid-resolution still finishes the ability", () => {
		const state = mainPhaseGame();
		const destroyer = engine.spawnPermanent(state, "test-self-destroyer", 0, {
			summoningSick: false,
		});
		activateAt(state, destroyer.id, SELF_DESTROYER_TAP, {
			type: "permanent",
			id: destroyer.id,
		});
		engine.settlePriority(state, passingAgents());
		// The destroy leaves; the damage that follows finds no target, so it does
		// nothing and gains nobody life, but it still reads its departed source.
		expect(state.objects.has(destroyer.id)).toBe(false);
		expect(state.players[0].graveyard).toHaveLength(1);
		expect(state.players[0].life).toBe(20);
		expect(state.stack).toHaveLength(0);
	});
});

describe("captured stack items", () => {
	test("a stack item survives its card definition changing under it", () => {
		const state = mainPhaseGame();
		const probe = engine.spawnPermanent(state, "test-registry-probe", 0, {
			summoningSick: false,
		});
		const ability = abilityId("activated", "test-registry-probe", 0);
		activateAt(state, probe.id, ability, { type: "player", player: 1 });

		const definition = engine.getAbilityDefinition("activated", ability);
		assertActivated(definition);
		definition.targets.length = 0;
		definition.effects.push({
			kind: "gain-life",
			subject: { kind: "relative-player", player: "you" },
			amount: 10,
		});

		const item = state.stack[0];
		expect(item?.kind).toBe("activated ability");
		if (item?.kind !== "activated ability") throw new Error("expected ability");
		expect(item.targetDefinitions).toHaveLength(1);
		expect(item.effects).toEqual([
			{
				kind: "damage",
				subject: { kind: "target", slot: "target-1" },
				amount: 2,
			},
		]);

		// A clone carries the same detached instructions, and resolving it runs
		// only what was captured.
		const cloned = structuredClone(state);
		expect(cloned.stack[0]).toEqual(item);
		engine.settlePriority(cloned, passingAgents());
		expect(cloned.players[1].life).toBe(18);
		expect(cloned.players[0].life).toBe(20);
	});
});

describe("targeted triggered abilities", () => {
	test("Flametongue Kavu's trigger targets and damages a creature on resolution", () => {
		const state = mainPhaseGame();
		const bears = engine.spawnPermanent(state, "grizzly-bears", 1);
		const kavu = engine.spawnCard(state, "flametongue-kavu", 0, "hand");
		engine.perform(
			state,
			{
				kind: "change zone",
				object: kavu.id,
				from: "hand",
				destination: { zone: "battlefield", controller: 0 },
				cause: "resolve",
			},
			passingAgents(),
		);
		expect(state.pendingTriggers).toHaveLength(1);
		// CR 603.3d: a pending trigger carries the restriction but no choice yet.
		expect(state.pendingTriggers[0]?.targetDefinitions).toHaveLength(1);

		const agents = passingAgents();
		agents[0].targetChoices.push({ type: "permanent", id: bears.id });
		engine.settlePriority(state, agents);
		expect(state.objects.has(bears.id)).toBe(false);
	});

	test("a trigger with no legal target is removed instead of waiting on the stack", () => {
		const state = mainPhaseGame();
		const vandal = engine.spawnCard(state, "manic-vandal", 0, "hand");
		engine.perform(
			state,
			{
				kind: "change zone",
				object: vandal.id,
				from: "hand",
				destination: { zone: "battlefield", controller: 0 },
				cause: "resolve",
			},
			passingAgents(),
		);
		expect(state.pendingTriggers).toHaveLength(1);
		engine.settlePriority(state, passingAgents());
		expect(state.stack).toHaveLength(0);
		expect(state.log.some((line) => line.includes("[illegal target]"))).toBe(
			true,
		);
	});

	test("Manic Vandal destroys the artifact it targeted", () => {
		const state = mainPhaseGame();
		const diamond = engine.spawnPermanent(state, "charcoal-diamond", 1);
		const vandal = engine.spawnCard(state, "manic-vandal", 0, "hand");
		engine.perform(
			state,
			{
				kind: "change zone",
				object: vandal.id,
				from: "hand",
				destination: { zone: "battlefield", controller: 0 },
				cause: "resolve",
			},
			passingAgents(),
		);
		const agents = passingAgents();
		agents[0].targetChoices.push({ type: "permanent", id: diamond.id });
		engine.settlePriority(state, agents);
		expect(state.objects.has(diamond.id)).toBe(false);
		expect(state.players[1].graveyard).toHaveLength(1);
	});

	test("an illegal target at resolution also stops the trigger's untargeted effect", () => {
		const state = mainPhaseGame();
		const bears = engine.spawnPermanent(state, "grizzly-bears", 1);
		const bolt = engine.spawnCard(state, "lightning-bolt", 1, "hand");
		engine.perform(
			state,
			{ kind: "add mana", source: bolt.id, player: 1, mana: { r: 1 } },
			passingAgents(),
		);
		const herald = engine.spawnCard(state, "test-vengeful-herald", 0, "hand");
		engine.perform(
			state,
			{
				kind: "change zone",
				object: herald.id,
				from: "hand",
				destination: { zone: "battlefield", controller: 0 },
				cause: "resolve",
			},
			passingAgents(),
		);

		const agents = passingAgents();
		agents[0].targetChoices.push({ type: "permanent", id: bears.id });
		agents[1].priorityActions.push({ kind: "cast", card: bolt.id });
		agents[1].targetChoices.push({ type: "permanent", id: bears.id });
		engine.settlePriority(state, agents);

		expect(agents[1].priorityActions).toHaveLength(0);
		expect(state.objects.has(bears.id)).toBe(false);
		// CR 608.2b: the sole target was illegal, so the life gain does not happen
		// either.
		expect(state.players[0].life).toBe(20);
		expect(state.stack).toHaveLength(0);
	});

	test("targets are chosen when the trigger goes on the stack, not when it triggered", () => {
		const state = mainPhaseGame();
		const first = engine.spawnPermanent(state, "grizzly-bears", 1);
		const kavu = engine.spawnCard(state, "flametongue-kavu", 0, "hand");
		engine.perform(
			state,
			{
				kind: "change zone",
				object: kavu.id,
				from: "hand",
				destination: { zone: "battlefield", controller: 0 },
				cause: "resolve",
			},
			passingAgents(),
		);
		// Added after the trigger event, before any player would receive priority.
		const late = engine.spawnPermanent(state, "eager-cadet", 1);

		const choices = ChoiceController.record(engine, passingAgents());
		engine.settlePriority(state, choices);
		const request = choices
			.transcript()
			.choices.find((choice) => choice.request.kind === "target")?.request;
		expect(request?.options.map((option) => option.id)).toContain(
			`permanent:${late.id}`,
		);
		expect(request?.options.map((option) => option.id)).toContain(
			`permanent:${first.id}`,
		);
	});

	test("the non-active player orders and targets after the active player's triggers are on the stack", () => {
		const state = mainPhaseGame();
		engine.spawnPermanent(state, "grizzly-bears", 1);
		// Two triggers each: both players make a real ordering decision, and the
		// non-active player makes theirs second.
		const sources = [
			engine.spawnCard(state, "flametongue-kavu", 0, "hand"),
			engine.spawnCard(state, "flametongue-kavu", 0, "hand"),
			engine.spawnCard(state, "flametongue-kavu", 1, "hand"),
			engine.spawnCard(state, "flametongue-kavu", 1, "hand"),
		];
		for (const source of sources) {
			engine.perform(
				state,
				{
					kind: "change zone",
					object: source.id,
					from: "hand",
					destination: { zone: "battlefield", controller: source.owner },
					cause: "resolve",
				},
				passingAgents(),
			);
		}
		expect(state.pendingTriggers).toHaveLength(4);

		const stackSeen: Record<PlayerId, number[]> = { 0: [], 1: [] };
		let boundWhenNonactiveOrdered = -1;
		const observer = (player: PlayerId): SyncAgent => ({
			choose(view: PlayerView, request: ChoiceRequest) {
				if (request.kind === "target")
					stackSeen[player].push(view.stack.length);
				if (request.kind === "triggerOrder" && player === 1) {
					boundWhenNonactiveOrdered = view.stack.filter(
						(entry) => entry.kind === "triggered ability" && entry.targets[0],
					).length;
				}
				return new ScriptedAgent().choose(view, request);
			},
		});
		engine.settlePriority(state, [observer(0), observer(1)]);
		// The active player targets an empty stack and then their own first item;
		// the non-active player orders and targets only after both are on it, with
		// their targets already chosen.
		expect(stackSeen[0]).toEqual([0, 1]);
		expect(stackSeen[1]).toEqual([2, 3]);
		expect(boundWhenNonactiveOrdered).toBe(2);
	});
});

describe("asynchronous target selection", () => {
	test("two targeted triggers replay without repeating an earlier choice", async () => {
		const state = mainPhaseGame();
		engine.spawnPermanent(state, "grizzly-bears", 1);
		engine.spawnPermanent(state, "eager-cadet", 1);
		for (const cardId of ["flametongue-kavu", "flametongue-kavu"]) {
			const card = engine.spawnCard(state, cardId, 0, "hand");
			engine.perform(
				state,
				{
					kind: "change zone",
					object: card.id,
					from: "hand",
					destination: { zone: "battlefield", controller: 0 },
					cause: "resolve",
				},
				passingAgents(),
			);
		}
		expect(state.pendingTriggers).toHaveLength(2);

		const before = structuredClone(state);
		let targetRequests = 0;
		const agent: Agent = {
			choose(view, request) {
				if (request.kind !== "target")
					return new ScriptedAgent().choose(view, request);
				targetRequests++;
				const option = request.options[0];
				if (!option) throw new Error("no target offered");
				return Promise.resolve({ optionId: option.id });
			},
		};
		const result = await engine.advanceWithReplay(state, [
			agent,
			new ScriptedAgent(),
		]);
		// The original checkpoint is never mutated by a suspended attempt.
		expect(state).toEqual(before);
		// One suspension per trigger, and each answered choice is replayed from
		// the transcript rather than being asked again.
		expect(result.attempts).toBe(3);
		expect(targetRequests).toBe(2);
		expect(
			result.transcript.choices.filter(
				(choice) => choice.request.kind === "target",
			),
		).toHaveLength(2);
		expect(result.state.pendingTriggers).toHaveLength(0);
	});

	test("a targeted activation replays without paying its tap cost twice", async () => {
		const state = mainPhaseGame();
		const sorcerer = engine.spawnPermanent(state, "prodigal-sorcerer", 0, {
			summoningSick: false,
		});
		const activate = {
			kind: "activate ability" as const,
			source: sorcerer.id,
			ability: PRODIGAL_SORCERER_TAP,
		};
		const before = structuredClone(state);
		let targetRequests = 0;
		const scripted = new ScriptedAgent([], [], [activate]);
		const agent: Agent = {
			choose(view, request) {
				if (request.kind !== "target") return scripted.choose(view, request);
				targetRequests++;
				return Promise.resolve({ optionId: "player:1" });
			},
		};
		const result = await engine.advanceWithReplay(state, [
			agent,
			new ScriptedAgent(),
		]);
		expect(state).toEqual(before);
		expect(result.attempts).toBe(2);
		expect(targetRequests).toBe(1);
		const tapped = result.state.objects.get(sorcerer.id);
		expect(tapped?.kind === "permanent" && tapped.tapped).toBe(true);
		expect(result.state.players[1].life).toBe(19);
	});
});
