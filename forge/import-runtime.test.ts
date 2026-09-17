import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ScriptedAgent } from "../agents.ts";
import { defineCard } from "../card-def.ts";
import { CARDS } from "../cards.ts";
import type {
	CardDef,
	CharacteristicsSnapshot,
	ChoiceSource,
	GameState,
	ObjectId,
	PlayerId,
	SyncAgent,
} from "../index.ts";
import {
	abilityId,
	activePlayer,
	advance,
	ChoiceController,
	createEngine,
	createReadContext,
	eligibleBlockers,
	executeAbilityAction,
	executeCastAction,
	getObservableActions,
	getSnapshot,
	isTurnStep,
	name,
	newGame,
	perform,
	permanent,
	settlePriority,
	spawnCard,
	spawnPermanent,
	spawnToken,
} from "../index.ts";
import {
	ALICE,
	advanceUntil,
	BOB,
	beginFirstTurn,
	created,
	newInProgressGame,
	passingAgents,
	type SyncAgents,
	setupMain,
} from "../test/utils/engine-helpers.ts";
import { importForgeCard } from "./import.ts";

const CORPUS_ROOT = join(import.meta.dir, "..", "cards", "cardsfolder");

/**
 * Registers a fixture straight through the bridge under a caller-chosen id,
 * distinct from the hand-authored ids `cards.ts` already owns for some of
 * these same printed cards (e.g. `root-maze`, `faithful-watchdog`). This file
 * proves the *imported* definitions actually run, independent of whichever
 * hand-written stand-ins other suites exercise.
 */
function loadRuntimeFixture(path: string, id: string): CardDef {
	const text = readFileSync(join(CORPUS_ROOT, `${path}.txt`), "utf8");
	const result = importForgeCard(text, { id });
	if (!result.ok) {
		throw new Error(
			`unsupported runtime fixture ${path}: ${result.diagnostics
				.map((d) => `${d.code}: ${d.message}`)
				.join("; ")}`,
		);
	}
	return result.card;
}

const RUNTIME_CARDS = [
	loadRuntimeFixture("g/grizzly_bears", "rt-grizzly-bears"),
	loadRuntimeFixture("g/glorious_anthem", "rt-glorious-anthem"),
	loadRuntimeFixture("s/spidersilk_armor", "rt-spidersilk-armor"),
	loadRuntimeFixture("a/air_nomad_legacy", "rt-air-nomad-legacy"),
	loadRuntimeFixture("e/exploration", "rt-exploration"),
	loadRuntimeFixture("a/aesthir_glider", "rt-aesthir-glider"),
	loadRuntimeFixture("r/root_maze", "rt-root-maze"),
	loadRuntimeFixture("f/faithful_watchdog", "rt-faithful-watchdog"),
	loadRuntimeFixture("a/arashin_cleric", "rt-arashin-cleric"),
	loadRuntimeFixture("s/soul_warden", "rt-soul-warden"),
	loadRuntimeFixture("e/essence_warden", "rt-essence-warden"),
	loadRuntimeFixture("w/wall_of_omens", "rt-wall-of-omens"),
	loadRuntimeFixture("p/priest_of_ancient_lore", "rt-priest-of-ancient-lore"),
	loadRuntimeFixture("a/arcanis_the_omnipotent", "rt-arcanis"),
	loadRuntimeFixture("p/persistent_specimen", "rt-persistent-specimen"),
	loadRuntimeFixture("a/ajanis_mantra", "rt-ajanis-mantra"),
	loadRuntimeFixture("n/necrogen_mists", "rt-necrogen-mists"),
	loadRuntimeFixture("n/network_disruptor", "rt-network-disruptor"),
	loadRuntimeFixture("p/preordain", "rt-preordain"),
	loadRuntimeFixture("s/sleight_of_hand", "rt-sleight-of-hand"),
	loadRuntimeFixture("i/impulse", "rt-impulse"),
	loadRuntimeFixture("s/stock_up", "rt-stock-up"),
	loadRuntimeFixture("c/consider", "rt-consider"),
	loadRuntimeFixture("c/cremate", "rt-cremate"),
	loadRuntimeFixture("d/disentomb", "rt-disentomb"),
	loadRuntimeFixture("r/reclaim", "rt-reclaim"),
	loadRuntimeFixture("h/hymn_of_rebirth", "rt-hymn-of-rebirth"),
	loadRuntimeFixture("v/village_rites", "rt-village-rites"),
	loadRuntimeFixture("d/deadly_dispute", "rt-deadly-dispute"),
	loadRuntimeFixture("d/diabolic_edict", "rt-diabolic-edict"),
	loadRuntimeFixture("d/dredge", "rt-dredge"),
	loadRuntimeFixture("l/llanowar_elves", "rt-llanowar-elves"),
	loadRuntimeFixture("s/soulmender", "rt-soulmender"),
	loadRuntimeFixture("v/viscera_seer", "rt-viscera-seer"),
	loadRuntimeFixture("t/thrashing_brontodon", "rt-thrashing-brontodon"),
	loadRuntimeFixture("c/cathar_commando", "rt-cathar-commando"),
	loadRuntimeFixture("r/resolute_reinforcements", "rt-resolute-reinforcements"),
	loadRuntimeFixture("s/selfless_savior", "rt-selfless-savior"),
	loadRuntimeFixture("b/blazing_hellhound", "rt-blazing-hellhound"),
	loadRuntimeFixture("b/bartolome_del_presidio", "rt-bartolome-del-presidio"),
	loadRuntimeFixture("a/acolyte_of_aclazotz", "rt-acolyte-of-aclazotz"),
	loadRuntimeFixture("r/rod_of_ruin", "rt-rod-of-ruin"),
	loadRuntimeFixture("i/icy_manipulator", "rt-icy-manipulator"),
	loadRuntimeFixture("w/wirewood_lodge", "rt-wirewood-lodge"),
	loadRuntimeFixture("c/charcoal_diamond", "rt-charcoal-diamond"),
	loadRuntimeFixture("t/timeless_lotus", "rt-timeless-lotus"),
	loadRuntimeFixture("t/temple_of_epiphany", "rt-temple-of-epiphany"),
	loadRuntimeFixture("g/golgari_rot_farm", "rt-golgari-rot-farm"),
	loadRuntimeFixture("c/clone", "rt-clone"),
	loadRuntimeFixture("c/copy_artifact", "rt-copy-artifact"),
	loadRuntimeFixture("b/blood_pact", "rt-blood-pact"),
	loadRuntimeFixture("t/tome_scour", "rt-tome-scour"),
	loadRuntimeFixture("f/firebrand_archer", "rt-firebrand-archer"),
	loadRuntimeFixture("k/kessig_flamebreather", "rt-kessig-flamebreather"),
	loadRuntimeFixture("k/kambal_consul_of_allocation", "rt-kambal"),
	loadRuntimeFixture("f/flayed_one", "rt-flayed-one"),
	loadRuntimeFixture("m/mire_triton", "rt-mire-triton"),
	loadRuntimeFixture("b/baleful_strix", "rt-baleful-strix"),
	loadRuntimeFixture("p/pierce_strider", "rt-pierce-strider"),
	loadRuntimeFixture("e/etched_familiar", "rt-etched-familiar"),
	loadRuntimeFixture("d/deathgreeter", "rt-deathgreeter"),
	loadRuntimeFixture("t/thraben_inspector", "rt-thraben-inspector"),
	loadRuntimeFixture("d/doomed_dissenter", "rt-doomed-dissenter"),
	loadRuntimeFixture("t/timberland_guide", "rt-timberland-guide"),
	loadRuntimeFixture("l/lorescale_coatl", "rt-lorescale-coatl"),
	loadRuntimeFixture("u/underworld_dreams", "rt-underworld-dreams"),
	loadRuntimeFixture("r/rummaging_goblin", "rt-rummaging-goblin"),
	loadRuntimeFixture("t/traveling_minister", "rt-traveling-minister"),
	loadRuntimeFixture("b/black_lotus", "rt-black-lotus"),
	loadRuntimeFixture("w/wrenns_resolve", "rt-wrenns-resolve"),
	loadRuntimeFixture("c/cloudshift", "rt-cloudshift"),
	loadRuntimeFixture("g/giant_caterpillar", "rt-giant-caterpillar"),
	loadRuntimeFixture("p/pain_101", "rt-pain-101"),
	loadRuntimeFixture("v/verdant_rebirth", "rt-verdant-rebirth"),
	loadRuntimeFixture("j/judith_the_scourge_diva", "rt-judith"),
];

const SELF_COUNTER = (() => {
	const text = `Name:Test Self Counter
ManaCost:1 G
Types:Creature Shaman
PT:1/1
T:Mode$ Phase | Phase$ Upkeep | ValidPlayer$ You | TriggerZones$ Battlefield | Execute$ TrigPutCounter | TriggerDescription$ x
SVar:TrigPutCounter:DB$ PutCounter | Defined$ Self | CounterType$ P1P1 | CounterNum$ 1
Oracle:
`;
	const result = importForgeCard(text, { id: "rt-test-self-counter" });
	if (!result.ok) throw new Error("expected self-counter fixture to import");
	return result.card;
})();

function chooseCopiedObject(choice: ObjectId | null): SyncAgent {
	const fallback = new ScriptedAgent();
	return {
		choose(view, request) {
			if (request.kind === "object" && request.context.reason.kind === "copy") {
				return { optionId: choice === null ? "decline" : String(choice) };
			}
			return fallback.choose(view, request);
		},
	};
}

/**
 * Synthetic: a static that makes every permanent an artifact, purely to
 * exercise the CR 614.12 own-entry guard on Root Maze's imported global
 * enters-tapped replacement (a general "artifacts and lands enter tapped"
 * effect does not apply to its own source's entry, even if some other effect
 * would make that source match). Not a stand-in for any real card's rules.
 */
const TEST_CARD_1 = defineCard({
	id: "rt-test-all-permanents-artifacts",
	name: "Test: All Permanents Are Artifacts",
	types: ["enchantment"],
	colors: [],
	manaCost: "zero",
	statics: [
		{
			kind: "characteristic",
			text: "Synthetic: all permanents are artifacts.",
			applies: () => true,
			effects: [
				{
					layer: "4-type-changing",
					modify: (v) => {
						if (!v.types.includes("artifact"))
							v.types = [...v.types, "artifact"];
					},
				},
			],
		},
	],
});

/**
 * Synthetic: an optional upkeep trigger whose effect sequence has two steps
 * (gain life, then draw), to prove the whole sequence is offered and applied
 * as one choice rather than per-effect.
 */
const OPTIONAL_MULTI = (() => {
	const text = `Name:Test Optional Multi
ManaCost:1 W
Types:Enchantment
T:Mode$ Phase | Phase$ Upkeep | ValidPlayer$ You | TriggerZones$ Battlefield | Execute$ TrigA | OptionalDecider$ You | TriggerDescription$ x
SVar:TrigA:DB$ GainLife | Defined$ You | LifeAmount$ 3 | SubAbility$ TrigB
SVar:TrigB:DB$ Draw | Defined$ You | NumCards$ 1
Oracle:
`;
	const result = importForgeCard(text, { id: "rt-test-optional-multi" });
	if (!result.ok)
		throw new Error("expected synthetic optional-multi fixture to import");
	return result.card;
})();

/**
 * Synthetic: an optional trigger that also targets, to pin down the order of
 * the two decisions — the target is chosen when the ability goes on the stack,
 * the "may" only when it resolves.
 */
const OPTIONAL_TARGETED = (() => {
	const text = `Name:Test Optional Targeted
ManaCost:1 R
Types:Enchantment
T:Mode$ Phase | Phase$ Upkeep | ValidPlayer$ You | TriggerZones$ Battlefield | Execute$ TrigZap | OptionalDecider$ You | TriggerDescription$ x
SVar:TrigZap:DB$ DealDamage | ValidTgts$ Creature | NumDmg$ 2 | SubAbility$ TrigGain
SVar:TrigGain:DB$ GainLife | Defined$ You | LifeAmount$ 2
Oracle:
`;
	const result = importForgeCard(text, { id: "rt-test-optional-targeted" });
	if (!result.ok)
		throw new Error("expected synthetic optional-targeted fixture to import");
	return result.card;
})();

/** A vanilla 2/2 to spawn with `spawnToken`, for the nontoken predicates. */
const ZOMBIE_TOKEN: CharacteristicsSnapshot = {
	kind: "creature",
	name: "Zombie Token",
	manaCost: "none",
	colors: ["b"],
	supertypes: [],
	types: ["creature"],
	subtypes: ["Zombie"],
	keywords: [],
	abilities: {
		static: [],
		activated: [],
		triggered: [],
		replacement: [],
		prohibition: [],
	},
	power: 2,
	toughness: 2,
};

const engine = createEngine([
	...CARDS,
	...RUNTIME_CARDS,
	SELF_COUNTER,
	TEST_CARD_1,
	OPTIONAL_MULTI,
	OPTIONAL_TARGETED,
]);

function atUpkeepOf(state: GameState, player: PlayerId): boolean {
	return isTurnStep(state, "upkeep") && activePlayer(state) === player;
}

function stockLibraries(state: GameState): void {
	for (const player of [ALICE, BOB] as const) {
		for (let i = 0; i < 3; i++) spawnCard(state, "forest", player, "library");
	}
}

function enterFromHand(
	state: GameState,
	cardId: string,
	controller: PlayerId,
	agents: ChoiceSource,
): ObjectId {
	const card = spawnCard(state, cardId, controller, "hand");
	const result = perform(
		engine,
		state,
		{
			kind: "change zone",
			object: card.id,
			from: "hand",
			destination: { zone: "battlefield", controller: controller },
			cause: "resolve",
		},
		agents,
	);
	return created(result);
}

describe("forge-import runtime: triggers", () => {
	test("Soul Warden and Essence Warden trigger for other creatures and gain life for their controllers", () => {
		const state = newGame();
		const agents: SyncAgents = [new ScriptedAgent(), new ScriptedAgent()];
		beginFirstTurn(engine, state, agents);

		enterFromHand(state, "rt-soul-warden", ALICE, agents);
		expect(
			state.pendingTriggers,
			"Soul Warden does not trigger for itself",
		).toHaveLength(0);

		enterFromHand(state, "rt-essence-warden", BOB, agents);
		expect(
			state.pendingTriggers,
			"only the Soul Warden already on the battlefield triggers",
		).toHaveLength(1);
		settlePriority(engine, state, agents);
		expect(state.players[ALICE].life).toBe(21);
		expect(state.players[BOB].life).toBe(20);

		enterFromHand(state, "rt-grizzly-bears", BOB, agents);
		expect(
			state.pendingTriggers,
			"both Wardens see either player's creature",
		).toHaveLength(2);
		settlePriority(engine, state, agents);
		expect(state.players[ALICE].life).toBe(22);
		expect(state.players[BOB].life).toBe(21);
	});

	test("Arashin Cleric's imported ETB trigger queues and gains life on resolution", () => {
		const state = newGame();
		const agents: SyncAgents = [new ScriptedAgent(), new ScriptedAgent()];
		beginFirstTurn(engine, state, agents);

		enterFromHand(state, "rt-arashin-cleric", ALICE, agents);

		expect(state.players[ALICE].life, "trigger has not resolved yet").toBe(20);
		expect(state.pendingTriggers).toHaveLength(1);

		settlePriority(engine, state, agents);
		expect(state.players[ALICE].life).toBe(23);
		expect(state.stack).toHaveLength(0);
	});

	test("Wall of Omens' imported ETB trigger draws a card on resolution", () => {
		const state = newGame();
		const agents: SyncAgents = [new ScriptedAgent(), new ScriptedAgent()];
		stockLibraries(state);
		beginFirstTurn(engine, state, agents);
		const librarySize = state.players[ALICE].library.length;

		enterFromHand(state, "rt-wall-of-omens", ALICE, agents);

		expect(
			state.players[ALICE].library,
			"trigger has not resolved yet",
		).toHaveLength(librarySize);
		expect(state.pendingTriggers).toHaveLength(1);

		settlePriority(engine, state, agents);
		expect(state.players[ALICE].library).toHaveLength(librarySize - 1);
		expect(state.stack).toHaveLength(0);
	});

	test("Flayed One's imported ETB trigger mills three cards on resolution", () => {
		const state = newGame();
		const agents: SyncAgents = [new ScriptedAgent(), new ScriptedAgent()];
		beginFirstTurn(engine, state, agents);
		for (let i = 0; i < 5; i++) spawnCard(state, "forest", ALICE, "library");
		const library = [...state.players[ALICE].library];

		enterFromHand(state, "rt-flayed-one", ALICE, agents);
		expect(
			state.players[ALICE].graveyard,
			"trigger has not resolved yet",
		).toHaveLength(0);
		expect(state.pendingTriggers).toHaveLength(1);

		settlePriority(engine, state, agents);
		// The library's last element is its top card, so milling three takes the
		// last three and leaves the rest in order.
		expect(state.players[ALICE].library).toEqual(library.slice(0, -3));
		// A card gets a fresh object id when it changes zone, so the milled cards
		// are identified by name rather than by the ids the library held.
		expect(
			state.players[ALICE].graveyard.map((id) => name(engine, state, id)),
		).toEqual(["Forest", "Forest", "Forest"]);
	});

	test("Mire Triton's imported ETB mills two cards, then gains two life", () => {
		const state = newGame();
		const agents: SyncAgents = [new ScriptedAgent(), new ScriptedAgent()];
		beginFirstTurn(engine, state, agents);
		for (let i = 0; i < 4; i++) spawnCard(state, "forest", ALICE, "library");
		const library = [...state.players[ALICE].library];
		state.players[ALICE].life = 17;

		enterFromHand(state, "rt-mire-triton", ALICE, agents);
		expect(state.players[ALICE].library).toEqual(library);
		expect(state.players[ALICE].life).toBe(17);
		expect(state.pendingTriggers).toHaveLength(1);

		settlePriority(engine, state, agents);
		expect(state.players[ALICE].library).toEqual(library.slice(0, -2));
		expect(
			state.players[ALICE].graveyard.map((id) => name(engine, state, id)),
		).toEqual(["Forest", "Forest"]);
		expect(state.players[ALICE].life).toBe(19);
	});

	test("Baleful Strix's imported ETB draws one card on resolution", () => {
		const state = newGame();
		const agents: SyncAgents = [new ScriptedAgent(), new ScriptedAgent()];
		stockLibraries(state);
		beginFirstTurn(engine, state, agents);
		const library = [...state.players[ALICE].library];

		const strix = enterFromHand(state, "rt-baleful-strix", ALICE, agents);
		const characteristics = getSnapshot(
			createReadContext(engine, state),
			strix,
		).currentCharacteristics;
		expect(characteristics.types).toEqual(["artifact", "creature"]);
		expect(characteristics.keywords).toEqual(["flying", "deathtouch"]);
		expect(state.players[ALICE].library).toEqual(library);
		expect(state.players[ALICE].hand).toHaveLength(0);
		expect(state.pendingTriggers).toHaveLength(1);

		settlePriority(engine, state, agents);
		expect(state.players[ALICE].library).toEqual(library.slice(0, -1));
		expect(
			state.players[ALICE].hand.map((id) => name(engine, state, id)),
		).toEqual(["Forest"]);
		expect(state.stack).toHaveLength(0);
	});

	test("Pierce Strider's imported ETB targets only its controller's opponent", () => {
		const state = newGame();
		const fallback = new ScriptedAgent();
		let targetOptions: string[] = [];
		const alice: SyncAgent = {
			choose(view, request) {
				if (request.kind === "target") {
					targetOptions = request.options.map((option) => option.label);
				}
				return fallback.choose(view, request);
			},
		};
		const agents: SyncAgents = [alice, new ScriptedAgent()];
		beginFirstTurn(engine, state, agents);

		enterFromHand(state, "rt-pierce-strider", ALICE, agents);
		expect(state.pendingTriggers).toHaveLength(1);
		expect(state.players[ALICE].life).toBe(20);
		expect(state.players[BOB].life).toBe(20);

		settlePriority(engine, state, agents);
		expect(targetOptions).toEqual(["Player 1"]);
		expect(state.players[ALICE].life).toBe(20);
		expect(state.players[BOB].life).toBe(17);
		expect(state.stack).toHaveLength(0);
	});

	test("Thraben Inspector's imported ETB trigger creates one usable Clue", () => {
		const state = newGame();
		const agents: SyncAgents = [new ScriptedAgent(), new ScriptedAgent()];
		stockLibraries(state);
		beginFirstTurn(engine, state, agents);

		const inspector = enterFromHand(
			state,
			"rt-thraben-inspector",
			ALICE,
			agents,
		);
		expect(state.battlefield).toEqual([inspector]);
		expect(state.pendingTriggers).toHaveLength(1);

		settlePriority(engine, state, agents);
		const clues = state.battlefield.filter(
			(id) => name(engine, state, id) === "Clue Token",
		);
		expect(clues).toHaveLength(1);
		const clue = clues[0];
		if (clue === undefined) throw new Error("Thraben Inspector made no Clue");
		expect(permanent(state, clue)).toMatchObject({
			controller: ALICE,
			token: true,
		});
		expect(
			getSnapshot(createReadContext(engine, state), clue)
				.currentCharacteristics,
		).toMatchObject({
			types: ["artifact"],
			subtypes: ["Clue"],
			abilities: { activated: [abilityId("activated", "clue-token", 0)] },
		});
		expect(state.pendingTriggers).toHaveLength(0);
		expect(state.stack).toHaveLength(0);
	});

	test("Etched Familiar's imported dies trigger drains its controller's opponent", () => {
		const state = newGame();
		const agents: SyncAgents = [new ScriptedAgent(), new ScriptedAgent()];
		beginFirstTurn(engine, state, agents);
		expect(state.players).toHaveLength(2);
		const familiar = spawnPermanent(engine, state, "rt-etched-familiar", BOB);

		perform(
			engine,
			state,
			{
				kind: "change zone",
				object: familiar.id,
				from: "battlefield",
				destination: { zone: "graveyard" },
				cause: "effect",
			},
			agents,
		);
		expect(state.pendingTriggers).toHaveLength(1);
		expect(state.players[ALICE].life).toBe(20);
		expect(state.players[BOB].life).toBe(20);

		settlePriority(engine, state, agents);
		expect(state.players[ALICE].life).toBe(18);
		expect(state.players[BOB].life).toBe(22);
		expect(state.stack).toHaveLength(0);
	});

	test("Deathgreeter's imported dies predicate watches another creature", () => {
		const state = newGame();
		const agents: SyncAgents = [new ScriptedAgent(), new ScriptedAgent()];
		const watcher = spawnPermanent(engine, state, "rt-deathgreeter", ALICE);
		const victim = spawnPermanent(engine, state, "rt-grizzly-bears", BOB);

		perform(
			engine,
			state,
			{
				kind: "change zone",
				object: victim.id,
				from: "battlefield",
				destination: { zone: "graveyard" },
				cause: "destroy",
			},
			agents,
		);

		expect(state.pendingTriggers).toHaveLength(1);
		expect(state.pendingTriggers[0]).toMatchObject({
			source: watcher.id,
			controller: ALICE,
		});
	});

	test("Judith's imported dies trigger ignores tokens and her anthem spares herself", () => {
		const state = newGame();
		const agents: SyncAgents = [new ScriptedAgent(), new ScriptedAgent()];
		const judith = spawnPermanent(engine, state, "rt-judith", ALICE);
		const bears = spawnPermanent(engine, state, "rt-grizzly-bears", ALICE);
		const token = spawnToken(state, ALICE, ZOMBIE_TOKEN);

		// `Affected$ Creature.Other+YouCtrl | AddPower$ 1`: the other creature
		// gains power only, and Judith is not her own anthem's subject.
		const read = createReadContext(engine, state);
		expect(getSnapshot(read, bears.id).currentCharacteristics).toMatchObject({
			power: 3,
			toughness: 2,
		});
		expect(getSnapshot(read, judith.id).currentCharacteristics).toMatchObject({
			power: 2,
			toughness: 2,
		});
		expect(getSnapshot(read, token.id).currentCharacteristics).toMatchObject({
			power: 3,
			toughness: 2,
		});

		// A token dying does not match `ValidCard$ Creature.YouCtrl+!token`.
		perform(
			engine,
			state,
			{
				kind: "change zone",
				object: token.id,
				from: "battlefield",
				destination: { zone: "graveyard" },
				cause: "destroy",
			},
			agents,
		);
		expect(state.pendingTriggers).toHaveLength(0);

		// The nontoken creature does.
		perform(
			engine,
			state,
			{
				kind: "change zone",
				object: bears.id,
				from: "battlefield",
				destination: { zone: "graveyard" },
				cause: "destroy",
			},
			agents,
		);
		expect(state.pendingTriggers).toHaveLength(1);
		expect(state.pendingTriggers[0]).toMatchObject({
			source: judith.id,
			controller: ALICE,
		});
	});

	test("Resolute Reinforcements casts during an opponent's turn and creates its Soldier", () => {
		const state = setupMain(engine);
		expect(activePlayer(state)).toBe(ALICE);
		const card = spawnCard(state, "rt-resolute-reinforcements", BOB, "hand");
		state.players[BOB].manaPool.c = 1;
		state.players[BOB].manaPool.w = 1;

		expect(getObservableActions(engine, state, BOB)).toContainEqual({
			kind: "cast",
			card: card.id,
		});
		const caster = new ScriptedAgent([], [], [{ kind: "cast", card: card.id }]);
		settlePriority(engine, state, [new ScriptedAgent(), caster]);

		expect(caster.priorityActions).toHaveLength(0);
		expect(state.players[BOB].manaPool).toMatchObject({ c: 0, w: 0 });
		const reinforcements = state.battlefield.filter(
			(id) => name(engine, state, id) === "Resolute Reinforcements",
		);
		const soldiers = state.battlefield.filter(
			(id) => name(engine, state, id) === "Soldier Token",
		);
		expect(reinforcements).toHaveLength(1);
		expect(soldiers).toHaveLength(1);
		const soldier = soldiers[0];
		if (soldier === undefined) throw new Error("Soldier token was not created");
		expect(permanent(state, soldier)).toMatchObject({
			token: true,
			controller: BOB,
		});
		expect(
			getSnapshot(createReadContext(engine, state), soldier)
				.currentCharacteristics,
		).toMatchObject({
			kind: "creature",
			colors: ["w"],
			types: ["creature"],
			subtypes: ["Soldier"],
			power: 1,
			toughness: 1,
		});
	});

	test("Timberland Guide's imported ETB trigger puts a counter on its chosen creature", () => {
		const state = newGame();
		const alice = new ScriptedAgent();
		const agents: SyncAgents = [alice, new ScriptedAgent()];
		beginFirstTurn(engine, state, agents);
		const target = spawnPermanent(engine, state, "rt-grizzly-bears", BOB);
		alice.targetChoices.push({ type: "permanent", id: target.id });

		const guide = enterFromHand(state, "rt-timberland-guide", ALICE, agents);

		expect(state.pendingTriggers).toHaveLength(1);
		expect(permanent(state, target.id).counters).toEqual({});
		settlePriority(engine, state, agents);
		expect(permanent(state, target.id).counters).toEqual({ "+1/+1": 1 });
		expect(permanent(state, guide).counters).toEqual({});
		expect(
			getSnapshot(createReadContext(engine, state), target.id)
				.currentCharacteristics,
		).toMatchObject({ power: 3, toughness: 3 });
	});

	test("Network Disruptor's imported ETB trigger taps any target permanent and keeps flying", () => {
		const state = newGame();
		const alice = new ScriptedAgent();
		const agents: SyncAgents = [alice, new ScriptedAgent()];
		beginFirstTurn(engine, state, agents);
		const land = spawnPermanent(engine, state, "forest", BOB);
		const groundCreature = spawnPermanent(
			engine,
			state,
			"rt-grizzly-bears",
			BOB,
		);
		alice.targetChoices.push({ type: "permanent", id: land.id });

		const disruptor = enterFromHand(
			state,
			"rt-network-disruptor",
			ALICE,
			agents,
		);

		expect(state.pendingTriggers).toHaveLength(1);
		expect(permanent(state, land.id).tapped).toBe(false);
		settlePriority(engine, state, agents);
		expect(permanent(state, land.id).tapped).toBe(true);
		expect(alice.targetChoices).toHaveLength(0);
		expect(eligibleBlockers(engine, state, BOB, disruptor)).not.toContain(
			groundCreature.id,
		);
	});

	test("Priest of Ancient Lore's imported ETB trigger gains life and draws", () => {
		const state = newGame();
		const agents: SyncAgents = [new ScriptedAgent(), new ScriptedAgent()];
		stockLibraries(state);
		beginFirstTurn(engine, state, agents);

		enterFromHand(state, "rt-priest-of-ancient-lore", ALICE, agents);

		expect(state.players[ALICE].life, "trigger has not resolved yet").toBe(20);
		expect(state.players[ALICE].library).toHaveLength(3);
		expect(state.pendingTriggers).toHaveLength(1);

		settlePriority(engine, state, agents);
		expect(state.players[ALICE].life).toBe(21);
		expect(state.players[ALICE].library).toHaveLength(2);
		expect(state.stack).toHaveLength(0);
	});

	test("Ajani's Mantra's imported upkeep trigger fires only for its controller, and its choice is genuinely optional", () => {
		const accept = newInProgressGame(engine);
		const acceptAgents: SyncAgents = [new ScriptedAgent(), new ScriptedAgent()];
		spawnPermanent(engine, accept, "rt-ajanis-mantra", ALICE);
		stockLibraries(accept);
		advanceUntil(engine, accept, acceptAgents, (next) =>
			atUpkeepOf(next, ALICE),
		);
		expect(accept.players[ALICE].life).toBe(21);
		advanceUntil(engine, accept, acceptAgents, (next) => atUpkeepOf(next, BOB));
		expect(
			accept.players[ALICE].life,
			"opponent's upkeep does not trigger it",
		).toBe(21);

		const decline = newInProgressGame(engine);
		const declineAgents: SyncAgents = [
			new ScriptedAgent([], [false]),
			new ScriptedAgent(),
		];
		spawnPermanent(engine, decline, "rt-ajanis-mantra", ALICE);
		stockLibraries(decline);
		advanceUntil(engine, decline, declineAgents, (next) =>
			atUpkeepOf(next, ALICE),
		);
		expect(decline.players[ALICE].life, "declined the optional gain").toBe(20);
	});

	test("Kambal makes the opponent who cast a noncreature spell lose life", () => {
		const state = setupMain(engine);
		const agents = passingAgents();
		spawnPermanent(engine, state, "rt-kambal", ALICE);
		const spell = spawnCard(state, "rt-consider", BOB, "hand");
		perform(
			engine,
			state,
			{
				kind: "add mana",
				source: spell.id,
				player: BOB,
				mana: { u: 1 },
			},
			agents,
		);

		executeCastAction(
			engine,
			state,
			BOB,
			{ kind: "cast", card: spell.id },
			agents,
		);
		settlePriority(engine, state, agents);

		expect(state.players[ALICE].life).toBe(22);
		expect(state.players[BOB].life).toBe(18);
	});

	test("Firebrand Archer and Kessig Flamebreather damage their controller's opponent", () => {
		for (const cardId of ["rt-firebrand-archer", "rt-kessig-flamebreather"]) {
			const state = setupMain(engine);
			spawnPermanent(engine, state, cardId, ALICE);
			const spell = spawnCard(state, "darksteel-relic", ALICE, "hand");

			executeCastAction(
				engine,
				state,
				ALICE,
				{ kind: "cast", card: spell.id },
				passingAgents(),
			);
			settlePriority(engine, state, passingAgents());

			expect(state.players[ALICE].life, `${cardId} does not damage you`).toBe(
				20,
			);
			expect(state.players[BOB].life, `${cardId} damages your opponent`).toBe(
				19,
			);
		}
	});

	test("a self PutCounter trigger adds its counter to its source", () => {
		const state = newInProgressGame(engine);
		const agents: SyncAgents = [new ScriptedAgent(), new ScriptedAgent()];
		const source = spawnPermanent(engine, state, "rt-test-self-counter", ALICE);
		stockLibraries(state);

		advanceUntil(engine, state, agents, (next) => atUpkeepOf(next, ALICE));

		expect(permanent(state, source.id).counters).toEqual({ "+1/+1": 1 });
		expect(
			getSnapshot(createReadContext(engine, state), source.id)
				.currentCharacteristics,
		).toMatchObject({ power: 2, toughness: 2 });
	});

	test("Lorescale Coatl's imported Drawn trigger fires on its controller's draws only", () => {
		const state = newGame();
		const agents: SyncAgents = [new ScriptedAgent(), new ScriptedAgent()];
		stockLibraries(state);
		beginFirstTurn(engine, state, agents);
		const coatl = spawnPermanent(engine, state, "rt-lorescale-coatl", ALICE);

		perform(engine, state, { kind: "draw", player: BOB }, agents);
		expect(
			state.pendingTriggers,
			"an opponent's draw is not this trigger's event",
		).toHaveLength(0);

		perform(engine, state, { kind: "draw", player: ALICE }, agents);
		expect(state.pendingTriggers).toHaveLength(1);
		expect(
			permanent(state, coatl.id).counters,
			"trigger has not resolved yet",
		).toEqual({});

		settlePriority(engine, state, agents);
		expect(permanent(state, coatl.id).counters).toEqual({ "+1/+1": 1 });
		expect(
			getSnapshot(createReadContext(engine, state), coatl.id)
				.currentCharacteristics,
		).toMatchObject({ power: 3, toughness: 3 });
	});

	test("Underworld Dreams damages the opponent whose draw triggered it", () => {
		const state = newGame();
		const agents: SyncAgents = [new ScriptedAgent(), new ScriptedAgent()];
		stockLibraries(state);
		beginFirstTurn(engine, state, agents);
		spawnPermanent(engine, state, "rt-underworld-dreams", ALICE);

		perform(engine, state, { kind: "draw", player: ALICE }, agents);
		expect(
			state.pendingTriggers,
			"your own draw is not an opponent's draw",
		).toHaveLength(0);

		perform(engine, state, { kind: "draw", player: BOB }, agents);
		settlePriority(engine, state, agents);
		expect(state.players[ALICE].life).toBe(20);
		expect(state.players[BOB].life).toBe(19);
	});

	test("Necrogen Mists makes the player whose upkeep began discard", () => {
		const state = newInProgressGame(engine);
		const agents: SyncAgents = [new ScriptedAgent(), new ScriptedAgent()];
		spawnPermanent(engine, state, "rt-necrogen-mists", ALICE);
		stockLibraries(state);

		advanceUntil(
			engine,
			state,
			agents,
			(next) => isTurnStep(next, "untap") && activePlayer(next) === BOB,
		);
		const aliceCard = spawnCard(state, "forest", ALICE, "hand");
		spawnCard(state, "forest", BOB, "hand");
		const bobHandBefore = state.players[BOB].hand.length;
		const bobGraveyardBefore = state.players[BOB].graveyard.length;

		advanceUntil(engine, state, agents, (next) => atUpkeepOf(next, BOB));

		expect(state.players[ALICE].hand).toContain(aliceCard.id);
		expect(state.players[BOB].hand).toHaveLength(bobHandBefore - 1);
		expect(state.players[BOB].graveyard).toHaveLength(bobGraveyardBefore + 1);
	});

	test("an optional trigger's whole multi-effect sequence is accepted or declined as one choice", () => {
		const accept = newInProgressGame(engine);
		const acceptAgents: SyncAgents = [
			new ScriptedAgent([], [true]),
			new ScriptedAgent(),
		];
		spawnPermanent(engine, accept, "rt-test-optional-multi", ALICE);
		stockLibraries(accept);
		const handBefore = accept.players[ALICE].hand.length;
		advanceUntil(engine, accept, acceptAgents, (next) =>
			atUpkeepOf(next, ALICE),
		);
		expect(accept.players[ALICE].life, "both effects applied together").toBe(
			23,
		);
		expect(accept.players[ALICE].hand.length).toBe(handBefore + 1);

		const decline = newInProgressGame(engine);
		const declineAgents: SyncAgents = [
			new ScriptedAgent([], [false]),
			new ScriptedAgent(),
		];
		spawnPermanent(engine, decline, "rt-test-optional-multi", ALICE);
		stockLibraries(decline);
		const declineHandBefore = decline.players[ALICE].hand.length;
		advanceUntil(engine, decline, declineAgents, (next) =>
			atUpkeepOf(next, ALICE),
		);
		expect(decline.players[ALICE].life, "neither effect applied").toBe(20);
		expect(decline.players[ALICE].hand.length).toBe(declineHandBefore);
	});

	test("an optional targeted trigger picks its target before it asks the question", () => {
		for (const accepted of [true, false]) {
			const state = newInProgressGame(engine);
			const agents: SyncAgents = [
				new ScriptedAgent([], [accepted]),
				new ScriptedAgent(),
			];
			spawnPermanent(engine, state, "rt-test-optional-targeted", ALICE);
			const bears = spawnPermanent(engine, state, "rt-grizzly-bears", BOB);
			stockLibraries(state);
			advanceUntil(engine, state, agents, (next) => atUpkeepOf(next, ALICE));

			// 2 damage is lethal to a 2/2, so accepting kills it outright.
			expect(state.objects.has(bears.id)).toBe(!accepted);
			expect(state.players[ALICE].life).toBe(accepted ? 22 : 20);
		}
	});

	test("Doomed Dissenter's imported dies trigger makes a 2/2 black Zombie for its controller", () => {
		const state = newGame();
		const agents: SyncAgents = [new ScriptedAgent(), new ScriptedAgent()];
		beginFirstTurn(engine, state, agents);

		const dissenter = spawnPermanent(
			engine,
			state,
			"rt-doomed-dissenter",
			ALICE,
		);
		perform(
			engine,
			state,
			{
				kind: "change zone",
				object: dissenter.id,
				from: "battlefield",
				destination: { zone: "graveyard" },
				cause: "effect",
			},
			agents,
		);
		expect(state.pendingTriggers).toHaveLength(1);
		expect(state.battlefield).toHaveLength(0);

		settlePriority(engine, state, agents);

		expect(state.battlefield).toHaveLength(1);
		const zombieId = state.battlefield[0];
		if (zombieId === undefined) throw new Error("no token was created");
		const zombie = permanent(state, zombieId);
		expect(zombie.token).toBe(true);
		expect(zombie.controller).toBe(ALICE);
		const characteristics = getSnapshot(
			createReadContext(engine, state),
			zombieId,
		).currentCharacteristics;
		expect(characteristics.name).toBe("Zombie Token");
		expect(characteristics.colors).toEqual(["b"]);
		expect(characteristics.subtypes).toEqual(["Zombie"]);
		expect(characteristics.kind === "creature" && characteristics.power).toBe(
			2,
		);
		expect(
			characteristics.kind === "creature" && characteristics.toughness,
		).toBe(2);
	});

	test("an optional targeted trigger with no legal target is never put on the stack", () => {
		const state = newInProgressGame(engine);
		// The agent would say yes; it is never asked, because there is no creature
		// for the trigger to target when it would go on the stack.
		const agents: SyncAgents = [
			new ScriptedAgent([], [true]),
			new ScriptedAgent(),
		];
		spawnPermanent(engine, state, "rt-test-optional-targeted", ALICE);
		stockLibraries(state);
		advanceUntil(engine, state, agents, (next) => atUpkeepOf(next, ALICE));

		expect(state.players[ALICE].life).toBe(20);
		expect(state.stack).toHaveLength(0);
	});
});

describe("forge-import runtime: statics and replacements", () => {
	test("Clone's imported replacement may copy any chosen creature or decline", () => {
		const copying = newGame();
		spawnPermanent(engine, copying, "darksteel-relic", BOB);
		spawnPermanent(engine, copying, "rt-grizzly-bears", BOB);
		const selected = spawnPermanent(engine, copying, "eager-cadet", BOB);
		const copied = enterFromHand(copying, "rt-clone", ALICE, [
			chooseCopiedObject(selected.id),
			new ScriptedAgent(),
		]);
		expect(
			getSnapshot(createReadContext(engine, copying), copied)
				.currentCharacteristics.name,
		).toBe("Eager Cadet");

		const declining = newGame();
		spawnPermanent(engine, declining, "rt-grizzly-bears", BOB);
		const unchanged = enterFromHand(declining, "rt-clone", ALICE, [
			chooseCopiedObject(null),
			new ScriptedAgent(),
		]);
		expect(
			getSnapshot(createReadContext(engine, declining), unchanged)
				.currentCharacteristics.name,
		).toBe("Clone");
	});

	test("Copy Artifact offers artifacts and keeps its enchantment exception", () => {
		const state = newGame();
		spawnPermanent(engine, state, "rt-grizzly-bears", BOB);
		const relic = spawnPermanent(engine, state, "darksteel-relic", BOB);
		const recorder = ChoiceController.record(engine, [
			chooseCopiedObject(relic.id),
			new ScriptedAgent(),
		]);
		const copied = enterFromHand(state, "rt-copy-artifact", ALICE, recorder);
		const snapshot = getSnapshot(createReadContext(engine, state), copied);

		expect(snapshot.currentCharacteristics.name).toBe("Darksteel Relic");
		expect(snapshot.copiableValues.types).toEqual(["artifact", "enchantment"]);
		expect(recorder.transcript().choices[0]?.request.options).toEqual([
			{ id: String(relic.id), label: `Darksteel Relic#${relic.id}` },
			{ id: "decline", label: "Don't copy" },
		]);
	});

	test("Aesthir Glider's imported static removes only itself from blocker candidates", () => {
		const state = newGame();
		const glider = spawnPermanent(engine, state, "rt-aesthir-glider", BOB);
		const bear = spawnPermanent(engine, state, "rt-grizzly-bears", BOB);
		expect(eligibleBlockers(engine, state, BOB)).toEqual([bear.id]);
		expect(eligibleBlockers(engine, state, BOB)).not.toContain(glider.id);
	});

	test("Exploration's imported rule effect offers exactly one additional land", () => {
		const state = setupMain(engine);
		spawnPermanent(engine, state, "rt-exploration", ALICE);
		const land = spawnCard(state, "forest", ALICE, "hand");

		state.players[ALICE].stats.lands.played = 1;
		expect(getObservableActions(engine, state, ALICE)).toContainEqual({
			kind: "play land",
			card: land.id,
		});

		state.players[ALICE].stats.lands.played = 2;
		expect(getObservableActions(engine, state, ALICE)).not.toContainEqual({
			kind: "play land",
			card: land.id,
		});
	});

	test("Glorious Anthem's imported static only pumps creatures its controller controls", () => {
		const state = newGame();
		spawnPermanent(engine, state, "rt-glorious-anthem", ALICE);
		const mine = spawnPermanent(engine, state, "rt-grizzly-bears", ALICE);
		const theirs = spawnPermanent(engine, state, "rt-grizzly-bears", BOB);

		expect(
			getSnapshot(createReadContext(engine, state), mine.id)
				.currentCharacteristics,
		).toMatchObject({ power: 3, toughness: 3 });
		expect(
			getSnapshot(createReadContext(engine, state), theirs.id)
				.currentCharacteristics,
		).toMatchObject({ power: 2, toughness: 2 });
	});

	test("Spidersilk Armor grants reach and +0/+1 only to its controller's creatures", () => {
		const state = newGame();
		spawnPermanent(engine, state, "rt-spidersilk-armor", BOB);
		const mine = spawnPermanent(engine, state, "rt-grizzly-bears", BOB);
		const theirs = spawnPermanent(engine, state, "rt-grizzly-bears", ALICE);
		const flyingAttacker = spawnPermanent(
			engine,
			state,
			"rt-network-disruptor",
			ALICE,
		);

		expect(
			getSnapshot(createReadContext(engine, state), mine.id)
				.currentCharacteristics,
		).toMatchObject({ power: 2, toughness: 3, keywords: ["reach"] });
		expect(
			getSnapshot(createReadContext(engine, state), theirs.id)
				.currentCharacteristics,
		).toMatchObject({ power: 2, toughness: 2, keywords: [] });
		expect(eligibleBlockers(engine, state, BOB, flyingAttacker.id)).toContain(
			mine.id,
		);
	});

	test("Air Nomad Legacy's keyword predicate pumps only its controller's flyers", () => {
		const state = newGame();
		spawnPermanent(engine, state, "rt-air-nomad-legacy", ALICE);
		const flyer = spawnPermanent(engine, state, "rt-network-disruptor", ALICE);
		const groundCreature = spawnPermanent(
			engine,
			state,
			"rt-grizzly-bears",
			ALICE,
		);
		const opposingFlyer = spawnPermanent(
			engine,
			state,
			"rt-network-disruptor",
			BOB,
		);

		expect(
			getSnapshot(createReadContext(engine, state), flyer.id)
				.currentCharacteristics,
		).toMatchObject({ power: 2, toughness: 2 });
		expect(
			getSnapshot(createReadContext(engine, state), groundCreature.id)
				.currentCharacteristics,
		).toMatchObject({ power: 2, toughness: 2 });
		expect(
			getSnapshot(createReadContext(engine, state), opposingFlyer.id)
				.currentCharacteristics,
		).toMatchObject({ power: 1, toughness: 1 });
	});

	test("Root Maze's imported replacement taps entering artifacts and lands but not creatures", () => {
		const state = newGame();
		const agents: SyncAgents = [new ScriptedAgent(), new ScriptedAgent()];
		beginFirstTurn(engine, state, agents);
		spawnPermanent(engine, state, "rt-root-maze", ALICE);

		const relic = enterFromHand(state, "darksteel-relic", ALICE, agents);
		expect(permanent(state, relic).tapped, "artifact enters tapped").toBe(true);

		const forest = enterFromHand(state, "forest", ALICE, agents);
		expect(permanent(state, forest).tapped, "land enters tapped").toBe(true);

		const bear = enterFromHand(state, "rt-grizzly-bears", ALICE, agents);
		expect(permanent(state, bear).tapped, "creature is unaffected").toBe(false);
	});

	test("Root Maze's imported replacement matches an incoming object's derived type, not just its printed one", () => {
		const state = newGame();
		const agents: SyncAgents = [new ScriptedAgent(), new ScriptedAgent()];
		beginFirstTurn(engine, state, agents);
		spawnPermanent(engine, state, "rt-root-maze", ALICE);
		spawnPermanent(engine, state, "rt-test-all-permanents-artifacts", ALICE);

		// Grizzly Bears is a creature by its printed characteristics, but the
		// synthetic static above adds "artifact" to every permanent's derived
		// type. Root Maze's replacement previews the *incoming* object through
		// that same static (etbPreview), so it must see "artifact" here too.
		const bear = enterFromHand(state, "rt-grizzly-bears", ALICE, agents);
		expect(
			permanent(state, bear).tapped,
			"Root Maze sees the previewed, derived type of the entering object",
		).toBe(true);
	});

	test("Faithful Watchdog's imported entersWith replacement grants its printed counters", () => {
		const state = newGame();
		const agents: SyncAgents = [new ScriptedAgent(), new ScriptedAgent()];
		beginFirstTurn(engine, state, agents);

		const dog = enterFromHand(state, "rt-faithful-watchdog", ALICE, agents);
		expect(permanent(state, dog).counters).toEqual({ "+1/+1": 3 });
		expect(
			getSnapshot(createReadContext(engine, state), dog).currentCharacteristics,
		).toMatchObject({
			power: 3,
			toughness: 3,
			keywords: ["vigilance"],
		});
	});

	test("Charcoal Diamond's imported canonical self-entry form enters tapped", () => {
		const state = newGame();
		const agents: SyncAgents = [new ScriptedAgent(), new ScriptedAgent()];
		beginFirstTurn(engine, state, agents);

		const diamond = enterFromHand(state, "rt-charcoal-diamond", ALICE, agents);
		expect(permanent(state, diamond).tapped).toBe(true);
	});

	test("Root Maze's imported global replacement does not tap its own entry, even if another effect would make it match (CR 614.12)", () => {
		const state = newGame();
		const agents: SyncAgents = [new ScriptedAgent(), new ScriptedAgent()];
		beginFirstTurn(engine, state, agents);
		spawnPermanent(engine, state, "rt-test-all-permanents-artifacts", ALICE);

		const rootMaze = enterFromHand(state, "rt-root-maze", ALICE, agents);
		expect(
			permanent(state, rootMaze).tapped,
			"a general effect matching its own source's entry does not apply to that entry",
		).toBe(false);

		// Sanity check: the same effect *does* still tap an unrelated artifact
		// entering afterward, proving Root Maze itself is still working.
		const relic = enterFromHand(state, "darksteel-relic", ALICE, agents);
		expect(permanent(state, relic).tapped).toBe(true);
	});
});

describe("forge-import runtime: spell effects", () => {
	test("Pain 101 grants a dies trigger that returns the new card tapped", () => {
		const state = setupMain(engine);
		const target = spawnPermanent(engine, state, "rt-grizzly-bears", ALICE);
		const originalId = target.id;
		const spell = spawnCard(state, "rt-pain-101", ALICE, "hand");
		state.players[ALICE].manaPool.b = 1;
		state.players[ALICE].manaPool.c = 1;
		const alice = new ScriptedAgent();
		alice.targetChoices.push({ type: "permanent", id: target.id });

		executeCastAction(engine, state, ALICE, { kind: "cast", card: spell.id }, [
			alice,
			new ScriptedAgent(),
		]);
		settlePriority(engine, state, passingAgents());
		expect(
			getSnapshot(createReadContext(engine, state), target.id)
				.currentCharacteristics.keywords,
		).toContain("deathtouch");

		perform(
			engine,
			state,
			{ kind: "destroy", object: target.id, noRegen: false },
			passingAgents(),
		);
		settlePriority(engine, state, passingAgents());

		expect(state.objects.has(originalId)).toBe(false);
		const returned = state.battlefield.find(
			(id) => name(engine, state, id) === "Grizzly Bears",
		);
		if (returned === undefined)
			throw new Error("Pain 101 returned no creature");
		expect(returned).not.toBe(originalId);
		expect(permanent(state, returned).tapped).toBe(true);
	});

	test("Verdant Rebirth draws, then its granted dies trigger returns the new card to hand", () => {
		const state = setupMain(engine);
		spawnCard(state, "forest", ALICE, "library");
		const librarySize = state.players[ALICE].library.length;
		const target = spawnPermanent(engine, state, "rt-grizzly-bears", ALICE);
		const originalId = target.id;
		const spell = spawnCard(state, "rt-verdant-rebirth", ALICE, "hand");
		state.players[ALICE].manaPool.g = 1;
		state.players[ALICE].manaPool.c = 1;
		const alice = new ScriptedAgent();
		alice.targetChoices.push({ type: "permanent", id: target.id });

		executeCastAction(engine, state, ALICE, { kind: "cast", card: spell.id }, [
			alice,
			new ScriptedAgent(),
		]);
		settlePriority(engine, state, passingAgents());
		expect(state.players[ALICE].library).toHaveLength(librarySize - 1);

		perform(
			engine,
			state,
			{ kind: "destroy", object: target.id, noRegen: false },
			passingAgents(),
		);
		settlePriority(engine, state, passingAgents());

		expect(state.objects.has(originalId)).toBe(false);
		const returned = state.players[ALICE].hand.find(
			(id) => name(engine, state, id) === "Grizzly Bears",
		);
		expect(returned).toBeDefined();
		expect(returned).not.toBe(originalId);
	});

	test("Wrenn's Resolve permits only the cards its imported Dig actually exiles", () => {
		const state = setupMain(engine);
		const unrelated = spawnCard(state, "darksteel-relic", ALICE, "exile");
		spawnCard(state, "forest", ALICE, "library");
		spawnCard(state, "darksteel-relic", ALICE, "library");
		const spell = spawnCard(state, "rt-wrenns-resolve", ALICE, "hand");
		state.players[ALICE].manaPool.c = 1;
		state.players[ALICE].manaPool.r = 1;

		executeCastAction(
			engine,
			state,
			ALICE,
			{ kind: "cast", card: spell.id },
			passingAgents(),
		);
		settlePriority(engine, state, passingAgents());

		const [unrelatedId, firstExiled, secondExiled] = state.players[ALICE].exile;
		expect(unrelatedId).toBe(unrelated.id);
		if (firstExiled === undefined || secondExiled === undefined)
			throw new Error("expected Wrenn's Resolve to exile two cards");
		expect(getObservableActions(engine, state, ALICE)).toEqual(
			expect.arrayContaining([
				{ kind: "cast", card: firstExiled },
				{ kind: "play land", card: secondExiled },
			]),
		);
		expect(getObservableActions(engine, state, ALICE)).not.toContainEqual({
			kind: "cast",
			card: unrelated.id,
		});
		expect(getObservableActions(engine, state, BOB)).not.toContainEqual({
			kind: "cast",
			card: firstExiled,
		});
		expect(state.temporaryEffects).toHaveLength(2);
		for (const effect of state.temporaryEffects) {
			expect(effect).toMatchObject({
				controller: ALICE,
				source: {
					origin: "spell-effect",
					cardId: "rt-wrenns-resolve",
					effectIndex: 1,
				},
				duration: "until-end-of-your-next-turn",
				expiresAtEndOfTurn: null,
			});
		}
	});

	test("Cloudshift returns the new exile object and retriggers the imported ETB", () => {
		const state = setupMain(engine);
		const target = spawnPermanent(engine, state, "rt-wall-of-omens", ALICE);
		target.tapped = true;
		target.damage = 1;
		target.counters["+1/+1"] = 1;
		const originalId = target.id;
		const librarySize = state.players[ALICE].library.length;
		const spell = spawnCard(state, "rt-cloudshift", ALICE, "hand");
		state.players[ALICE].manaPool.w = 1;

		executeCastAction(
			engine,
			state,
			ALICE,
			{ kind: "cast", card: spell.id },
			passingAgents(),
		);
		settlePriority(engine, state, passingAgents());

		expect(state.objects.has(originalId)).toBe(false);
		expect(state.players[ALICE].exile).toEqual([]);
		const returnedId = state.battlefield[0];
		if (returnedId === undefined)
			throw new Error("Cloudshift returned nothing");
		expect(returnedId).not.toBe(originalId);
		expect(permanent(state, returnedId)).toMatchObject({
			kind: "permanent",
			controller: ALICE,
			owner: ALICE,
			zone: "battlefield",
			representation: { kind: "card", cardId: "rt-wall-of-omens" },
			tapped: false,
			summoningSick: true,
			counters: {},
			damage: 0,
		});
		expect(
			state.players[ALICE].library,
			"the returned Wall of Omens triggered and drew",
		).toHaveLength(librarySize - 1);
		expect(state.pendingTriggers).toEqual([]);
		expect(state.stack).toEqual([]);
	});

	test("Preordain's imported scry arrangement is applied before its draw", () => {
		const state = setupMain(engine);
		const bottom = spawnCard(state, "darksteel-relic", ALICE, "library").id;
		const first = spawnCard(state, "forest", ALICE, "library").id;
		const second = spawnCard(state, "rt-grizzly-bears", ALICE, "library").id;
		const spell = spawnCard(state, "rt-preordain", ALICE, "hand");
		perform(
			engine,
			state,
			{
				kind: "add mana",
				source: spell.id,
				player: ALICE,
				mana: { u: 1 },
			},
			passingAgents(),
		);
		const agents = passingAgents();
		agents[ALICE].scryChoices.push({
			top: [second],
			bottom: [first],
		});

		executeCastAction(
			engine,
			state,
			ALICE,
			{ kind: "cast", card: spell.id },
			agents,
		);
		settlePriority(engine, state, agents);

		expect(
			state.players[ALICE].hand.map((id) => name(engine, state, id)),
		).toContain("Grizzly Bears");
		expect(state.players[ALICE].library[0]).toBe(first);
		expect(state.players[ALICE].library.at(-1)).toBe(bottom);
		expect(agents[ALICE].scryChoices).toHaveLength(0);
	});

	test("Sleight of Hand keeps one chosen card when ChangeNum is omitted", () => {
		const state = setupMain(engine);
		const existingLibrary = [...state.players[ALICE].library];
		const bottomed = spawnCard(state, "forest", ALICE, "library").id;
		const chosen = spawnCard(state, "darksteel-relic", ALICE, "library").id;
		const spell = spawnCard(state, "rt-sleight-of-hand", ALICE, "hand");
		perform(
			engine,
			state,
			{
				kind: "add mana",
				source: spell.id,
				player: ALICE,
				mana: { u: 1 },
			},
			passingAgents(),
		);
		const agents = passingAgents();
		agents[ALICE].chooseFromTopChoices.push({
			kept: [chosen],
			bottom: [bottomed],
		});

		executeCastAction(
			engine,
			state,
			ALICE,
			{ kind: "cast", card: spell.id },
			agents,
		);
		settlePriority(engine, state, agents);

		expect(
			state.players[ALICE].hand.map((id) => name(engine, state, id)),
		).toContain("Darksteel Relic");
		expect(state.players[ALICE].library).toEqual([
			bottomed,
			...existingLibrary,
		]);
		expect(agents[ALICE].chooseFromTopChoices).toHaveLength(0);
	});

	test("Impulse puts the chosen top-four card into hand and the rest on the bottom in the chosen order", () => {
		const state = setupMain(engine);
		const existingLibrary = [...state.players[ALICE].library];
		const first = spawnCard(state, "forest", ALICE, "library").id;
		const second = spawnCard(state, "rt-grizzly-bears", ALICE, "library").id;
		const chosen = spawnCard(state, "darksteel-relic", ALICE, "library").id;
		const fourth = spawnCard(state, "rt-aesthir-glider", ALICE, "library").id;
		const spell = spawnCard(state, "rt-impulse", ALICE, "hand");
		perform(
			engine,
			state,
			{
				kind: "add mana",
				source: spell.id,
				player: ALICE,
				mana: { u: 1, c: 1 },
			},
			passingAgents(),
		);
		const agents = passingAgents();
		agents[ALICE].chooseFromTopChoices.push({
			kept: [chosen],
			bottom: [second, fourth, first],
		});

		executeCastAction(
			engine,
			state,
			ALICE,
			{ kind: "cast", card: spell.id },
			agents,
		);
		settlePriority(engine, state, agents);

		expect(
			state.players[ALICE].hand.map((id) => name(engine, state, id)),
		).toContain("Darksteel Relic");
		expect(state.players[ALICE].library).toEqual([
			first,
			fourth,
			second,
			...existingLibrary,
		]);
		expect(agents[ALICE].chooseFromTopChoices).toHaveLength(0);
	});

	test("Stock Up puts two chosen top-five cards into hand and orders the rest on the bottom", () => {
		const state = setupMain(engine);
		const existingLibrary = [...state.players[ALICE].library];
		const first = spawnCard(state, "forest", ALICE, "library").id;
		const keptFirst = spawnCard(state, "rt-grizzly-bears", ALICE, "library").id;
		const third = spawnCard(state, "darksteel-relic", ALICE, "library").id;
		const fourth = spawnCard(state, "rt-aesthir-glider", ALICE, "library").id;
		const keptSecond = spawnCard(
			state,
			"monastery-swiftspear",
			ALICE,
			"library",
		).id;
		const spell = spawnCard(state, "rt-stock-up", ALICE, "hand");
		perform(
			engine,
			state,
			{
				kind: "add mana",
				source: spell.id,
				player: ALICE,
				mana: { u: 1, c: 2 },
			},
			passingAgents(),
		);
		const agents = passingAgents();
		agents[ALICE].chooseFromTopChoices.push({
			kept: [keptSecond, keptFirst],
			bottom: [fourth, first, third],
		});

		executeCastAction(
			engine,
			state,
			ALICE,
			{ kind: "cast", card: spell.id },
			agents,
		);
		settlePriority(engine, state, agents);

		const hand = state.players[ALICE].hand.map((id) => name(engine, state, id));
		expect(hand).toContain("Monastery Swiftspear");
		expect(hand).toContain("Grizzly Bears");
		expect(state.players[ALICE].library).toEqual([
			third,
			first,
			fourth,
			...existingLibrary,
		]);
		expect(agents[ALICE].chooseFromTopChoices).toHaveLength(0);
	});

	test("Village Rites' imported additional cost sacrifices before it draws", () => {
		const state = setupMain(engine);
		// The end of a library array is its top, so these two are drawn spawnCard(state, "forest", ALICE, "library");
		spawnCard(state, "darksteel-relic", ALICE, "library");
		const fodder = spawnPermanent(engine, state, "rt-grizzly-bears", ALICE).id;
		const spell = spawnCard(state, "rt-village-rites", ALICE, "hand");
		perform(
			engine,
			state,
			{ kind: "add mana", source: spell.id, player: ALICE, mana: { b: 1 } },
			passingAgents(),
		);
		const agents = passingAgents();
		agents[ALICE].sacrificeChoices.push(fodder);

		executeCastAction(
			engine,
			state,
			ALICE,
			{ kind: "cast", card: spell.id },
			agents,
		);
		// The creature is gone as a cost, while the spell is still on the stack:
		// CR 601.2h pays costs during casting, not on resolution.
		expect(state.battlefield).not.toContain(fodder);
		expect(state.players[ALICE].hand).not.toContain(spell.id);
		settlePriority(engine, state, agents);

		// Names, not ids: a zone change creates a new object (CR 400.7), so the
		// cards that arrive in hand are not the objects that were in the library.
		const hand = state.players[ALICE].hand.map((id) => name(engine, state, id));
		expect(hand).toContain("Forest");
		expect(hand).toContain("Darksteel Relic");
		expect(agents[ALICE].sacrificeChoices).toHaveLength(0);
	});

	test("Village Rites is not castable with no creature to sacrifice", () => {
		const state = setupMain(engine);
		const spell = spawnCard(state, "rt-village-rites", ALICE, "hand");
		perform(
			engine,
			state,
			{ kind: "add mana", source: spell.id, player: ALICE, mana: { b: 1 } },
			passingAgents(),
		);
		const castable = getObservableActions(engine, state, ALICE).some(
			(action) => action.kind === "cast" && action.card === spell.id,
		);
		expect(castable).toBe(false);
	});

	test("Deadly Dispute sacrifices an artifact, draws two, and creates a working Treasure", () => {
		const state = setupMain(engine);
		spawnCard(state, "forest", ALICE, "library");
		spawnCard(state, "darksteel-relic", ALICE, "library");
		const artifact = spawnPermanent(engine, state, "darksteel-relic", ALICE).id;
		const spell = spawnCard(state, "rt-deadly-dispute", ALICE, "hand");
		state.players[ALICE].manaPool.c = 1;
		state.players[ALICE].manaPool.b = 1;
		const agents = passingAgents();
		agents[ALICE].sacrificeChoices.push(artifact);

		executeCastAction(
			engine,
			state,
			ALICE,
			{ kind: "cast", card: spell.id },
			agents,
		);
		expect(
			state.objects.has(artifact),
			"the additional cost is paid before resolution",
		).toBe(false);

		settlePriority(engine, state, agents);
		expect(
			state.players[ALICE].hand.map((id) => name(engine, state, id)),
		).toEqual(expect.arrayContaining(["Forest", "Darksteel Relic"]));
		const treasure = state.battlefield.find(
			(id) => permanent(state, id).representation.kind === "token",
		);
		if (treasure === undefined)
			throw new Error("Deadly Dispute created no token");
		const treasureMana = abilityId("activated", "rt-deadly-dispute", 0);
		executeAbilityAction(
			engine,
			state,
			ALICE,
			{ kind: "activate ability", source: treasure, ability: treasureMana },
			agents,
		);
		expect(state.objects.has(treasure)).toBe(false);
		expect(state.players[ALICE].manaPool.w).toBe(1);
	});

	test("Deadly Dispute is not castable without an artifact or creature", () => {
		const state = setupMain(engine);
		const spell = spawnCard(state, "rt-deadly-dispute", ALICE, "hand");
		state.players[ALICE].manaPool.c = 1;
		state.players[ALICE].manaPool.b = 1;
		expect(
			getObservableActions(engine, state, ALICE).some(
				(action) => action.kind === "cast" && action.card === spell.id,
			),
		).toBe(false);
	});

	test("Diabolic Edict's targeted player chooses the creature sacrificed on resolution", () => {
		const state = setupMain(engine);
		const first = spawnPermanent(engine, state, "rt-grizzly-bears", BOB);
		const chosen = spawnPermanent(engine, state, "rt-doomed-dissenter", BOB);
		const spell = spawnCard(state, "rt-diabolic-edict", ALICE, "hand");
		state.players[ALICE].manaPool.c = 1;
		state.players[ALICE].manaPool.b = 1;
		const alice = new ScriptedAgent();
		alice.targetChoices.push({ type: "player", player: BOB });
		const bob = new ScriptedAgent();
		bob.sacrificeChoices.push(chosen.id);

		executeCastAction(engine, state, ALICE, { kind: "cast", card: spell.id }, [
			alice,
			bob,
		]);
		expect(state.battlefield).toContain(chosen.id);
		settlePriority(engine, state, [alice, bob]);

		expect(state.battlefield).toContain(first.id);
		expect(state.battlefield).not.toContain(chosen.id);
		expect(state.players[BOB].graveyard).toHaveLength(1);
		expect(bob.sacrificeChoices).toHaveLength(0);
	});

	test("Dredge's controller sacrifices before the following draw resolves", () => {
		const state = setupMain(engine);
		const drawn = spawnCard(state, "forest", ALICE, "library");
		const creature = spawnPermanent(engine, state, "rt-grizzly-bears", ALICE);
		const spell = spawnCard(state, "rt-dredge", ALICE, "hand");
		state.players[ALICE].manaPool.b = 1;
		const alice = new ScriptedAgent();
		alice.sacrificeChoices.push(creature.id);

		executeCastAction(engine, state, ALICE, { kind: "cast", card: spell.id }, [
			alice,
			new ScriptedAgent(),
		]);
		settlePriority(engine, state, [alice, new ScriptedAgent()]);

		expect(state.battlefield).not.toContain(creature.id);
		expect(
			state.players[ALICE].hand.map((id) => name(engine, state, id)),
		).toContain("Forest");
		expect(state.players[ALICE].library).not.toContain(drawn.id);
		expect(alice.sacrificeChoices).toHaveLength(0);
	});

	test("Blood Pact's imported halves both act on the one targeted player", () => {
		const state = setupMain(engine);
		// The end of a library array is its top, so these two are drawn spawnCard(state, "forest", BOB, "library");
		spawnCard(state, "darksteel-relic", BOB, "library");
		const spell = spawnCard(state, "rt-blood-pact", ALICE, "hand");
		perform(
			engine,
			state,
			{
				kind: "add mana",
				source: spell.id,
				player: ALICE,
				mana: { b: 1, c: 2 },
			},
			passingAgents(),
		);
		const bobHandBefore = state.players[BOB].hand.length;
		const agents = passingAgents();
		agents[ALICE].targetChoices.push({ type: "player", player: BOB });

		executeCastAction(
			engine,
			state,
			ALICE,
			{ kind: "cast", card: spell.id },
			agents,
		);
		settlePriority(engine, state, agents);

		// The draw and the life loss name the same target slot, so both land on
		// Bob -- not on Alice, who controls the spell and is the default player
		// an undefined operand would resolve to.
		const bobHand = state.players[BOB].hand.map((id) =>
			name(engine, state, id),
		);
		expect(bobHand).toHaveLength(bobHandBefore + 2);
		expect(bobHand).toContain("Forest");
		expect(bobHand).toContain("Darksteel Relic");
		expect(state.players[BOB].life).toBe(18);
		expect(state.players[ALICE].life).toBe(20);
		expect(agents[ALICE].targetChoices).toHaveLength(0);
	});

	test("Tome Scour's imported mill runs against the targeted player", () => {
		const state = setupMain(engine);
		for (let i = 0; i < 5; i++) spawnCard(state, "forest", BOB, "library");
		const bobLibrary = [...state.players[BOB].library];
		const aliceLibrary = [...state.players[ALICE].library];
		const spell = spawnCard(state, "rt-tome-scour", ALICE, "hand");
		perform(
			engine,
			state,
			{ kind: "add mana", source: spell.id, player: ALICE, mana: { u: 1 } },
			passingAgents(),
		);
		const agents = passingAgents();
		agents[ALICE].targetChoices.push({ type: "player", player: BOB });

		executeCastAction(
			engine,
			state,
			ALICE,
			{ kind: "cast", card: spell.id },
			agents,
		);
		settlePriority(engine, state, agents);

		// The library's last element is its top card, so milling five takes the
		// last five and leaves the rest in order.
		expect(state.players[BOB].library).toEqual(bobLibrary.slice(0, -5));
		expect(state.players[BOB].graveyard).toHaveLength(5);
		// Alice cast it, so an operand that fell back to the controller would
		// have emptied her library instead.
		expect(state.players[ALICE].library).toEqual(aliceLibrary);
		expect(agents[ALICE].targetChoices).toHaveLength(0);
	});

	test("Consider's imported surveil moves the chosen card before drawing", () => {
		const state = setupMain(engine);
		spawnCard(state, "forest", ALICE, "library");
		const surveilled = spawnCard(
			state,
			"rt-grizzly-bears",
			ALICE,
			"library",
		).id;
		const spell = spawnCard(state, "rt-consider", ALICE, "hand");
		perform(
			engine,
			state,
			{
				kind: "add mana",
				source: spell.id,
				player: ALICE,
				mana: { u: 1 },
			},
			passingAgents(),
		);
		const agents = passingAgents();
		agents[ALICE].surveilChoices.push({ top: [], bottom: [surveilled] });

		executeCastAction(
			engine,
			state,
			ALICE,
			{ kind: "cast", card: spell.id },
			agents,
		);
		settlePriority(engine, state, agents);

		expect(
			state.players[ALICE].hand.map((id) => name(engine, state, id)),
		).toContain("Forest");
		expect(
			state.players[ALICE].graveyard.map((id) => name(engine, state, id)),
		).toContain("Grizzly Bears");
		expect(agents[ALICE].surveilChoices).toHaveLength(0);
	});

	test("Disentomb targets only a creature card its caster owns", () => {
		const state = setupMain(engine);
		const own = spawnCard(state, "rt-grizzly-bears", ALICE, "graveyard");
		const opposing = spawnCard(state, "rt-grizzly-bears", BOB, "graveyard");
		const spell = spawnCard(state, "rt-disentomb", ALICE, "hand");
		state.players[ALICE].manaPool.b = 1;
		const agents = passingAgents();
		agents[ALICE].targetChoices.push({ type: "card", id: opposing.id });

		expect(() =>
			executeCastAction(
				engine,
				state,
				ALICE,
				{ kind: "cast", card: spell.id },
				agents,
			),
		).toThrow();
		expect(state.players[ALICE].hand).toContain(spell.id);
		expect(state.players[BOB].graveyard).toContain(opposing.id);

		agents[ALICE].targetChoices.push({ type: "card", id: own.id });
		executeCastAction(
			engine,
			state,
			ALICE,
			{ kind: "cast", card: spell.id },
			agents,
		);
		settlePriority(engine, state, agents);
		expect(state.players[ALICE].graveyard).not.toContain(own.id);
		expect(
			state.players[ALICE].hand.map((id) => name(engine, state, id)),
		).toContain("Grizzly Bears");
	});

	test("Cremate fizzles when its graveyard target becomes a new object", () => {
		const state = setupMain(engine);
		const drawn = spawnCard(state, "forest", ALICE, "library");
		const target = spawnCard(state, "rt-grizzly-bears", BOB, "graveyard");
		const spell = spawnCard(state, "rt-cremate", ALICE, "hand");
		state.players[ALICE].manaPool.b = 1;
		const agents = passingAgents();
		agents[ALICE].targetChoices.push({ type: "card", id: target.id });

		executeCastAction(
			engine,
			state,
			ALICE,
			{ kind: "cast", card: spell.id },
			agents,
		);
		perform(
			engine,
			state,
			{
				kind: "change zone",
				object: target.id,
				from: "graveyard",
				destination: { zone: "exile" },
				cause: "effect",
			},
			agents,
		);
		settlePriority(engine, state, agents);

		expect(state.players[ALICE].library).toContain(drawn.id);
		expect(state.log.some((line) => line.includes("[illegal target]"))).toBe(
			true,
		);
	});

	test("Reclaim uses the top library position and Hymn of Rebirth uses its controller", () => {
		const reclaimState = setupMain(engine);
		const reclaimed = spawnCard(
			reclaimState,
			"rt-grizzly-bears",
			ALICE,
			"graveyard",
		);
		const reclaim = spawnCard(reclaimState, "rt-reclaim", ALICE, "hand");
		reclaimState.players[ALICE].manaPool.g = 1;
		const reclaimAgents = passingAgents();
		reclaimAgents[ALICE].targetChoices.push({
			type: "card",
			id: reclaimed.id,
		});
		executeCastAction(
			engine,
			reclaimState,
			ALICE,
			{ kind: "cast", card: reclaim.id },
			reclaimAgents,
		);
		settlePriority(engine, reclaimState, reclaimAgents);
		const libraryTop = reclaimState.players[ALICE].library.at(-1);
		if (libraryTop === undefined)
			throw new Error("Reclaim left no library top");
		expect(name(engine, reclaimState, libraryTop)).toBe("Grizzly Bears");

		const riseState = setupMain(engine);
		const risen = spawnCard(riseState, "rt-grizzly-bears", BOB, "graveyard");
		const rise = spawnCard(riseState, "rt-hymn-of-rebirth", ALICE, "hand");
		riseState.players[ALICE].manaPool.g = 1;
		riseState.players[ALICE].manaPool.w = 1;
		riseState.players[ALICE].manaPool.c = 3;
		const riseAgents = passingAgents();
		riseAgents[ALICE].targetChoices.push({ type: "card", id: risen.id });
		executeCastAction(
			engine,
			riseState,
			ALICE,
			{ kind: "cast", card: rise.id },
			riseAgents,
		);
		settlePriority(engine, riseState, riseAgents);
		const permanentId = riseState.battlefield.find(
			(id) => name(engine, riseState, id) === "Grizzly Bears",
		);
		if (permanentId === undefined)
			throw new Error("Hymn of Rebirth returned no card");
		expect(permanent(riseState, permanentId)).toMatchObject({
			owner: BOB,
			controller: ALICE,
		});
	});
});

describe("forge-import runtime: activated abilities", () => {
	test("Traveling Minister can be activated only during its controller's main phase with an empty stack", () => {
		const ability = abilityId("activated", "rt-traveling-minister", 0);
		const actionFor = (source: ObjectId) => ({
			kind: "activate ability" as const,
			source,
			ability,
		});

		const upkeep = newGame();
		stockLibraries(upkeep);
		beginFirstTurn(engine, upkeep, passingAgents());
		const upkeepMinister = spawnPermanent(
			engine,
			upkeep,
			"rt-traveling-minister",
			ALICE,
			{ summoningSick: false },
		);
		expect(getObservableActions(engine, upkeep, ALICE)).not.toContainEqual(
			actionFor(upkeepMinister.id),
		);
		expect(() =>
			executeAbilityAction(
				engine,
				upkeep,
				ALICE,
				actionFor(upkeepMinister.id),
				passingAgents(),
			),
		).toThrow("only as a sorcery");
		expect(permanent(upkeep, upkeepMinister.id).tapped).toBe(false);

		const main = setupMain(engine);
		const mainMinister = spawnPermanent(
			engine,
			main,
			"rt-traveling-minister",
			ALICE,
			{ summoningSick: false },
		);
		expect(getObservableActions(engine, main, ALICE)).toContainEqual(
			actionFor(mainMinister.id),
		);
		executeAbilityAction(
			engine,
			main,
			ALICE,
			actionFor(mainMinister.id),
			passingAgents(),
		);
		expect(permanent(main, mainMinister.id).tapped).toBe(true);
		expect(main.stack).toHaveLength(1);

		const nonactive = setupMain(engine);
		const bobsMinister = spawnPermanent(
			engine,
			nonactive,
			"rt-traveling-minister",
			BOB,
			{ summoningSick: false },
		);
		expect(getObservableActions(engine, nonactive, BOB)).not.toContainEqual(
			actionFor(bobsMinister.id),
		);
		expect(() =>
			executeAbilityAction(
				engine,
				nonactive,
				BOB,
				actionFor(bobsMinister.id),
				passingAgents(),
			),
		).toThrow("only as a sorcery");

		const stacked = setupMain(engine);
		const stackedMinister = spawnPermanent(
			engine,
			stacked,
			"rt-traveling-minister",
			ALICE,
			{ summoningSick: false },
		);
		const bears = spawnCard(stacked, "grizzly-bears", BOB, "hand");
		perform(
			engine,
			stacked,
			{
				kind: "change zone",
				object: bears.id,
				from: "hand",
				destination: { zone: "stack", controller: BOB, targets: [] },
				cause: "cast",
			},
			passingAgents(),
		);
		expect(getObservableActions(engine, stacked, ALICE)).not.toContainEqual(
			actionFor(stackedMinister.id),
		);
		expect(() =>
			executeAbilityAction(
				engine,
				stacked,
				ALICE,
				actionFor(stackedMinister.id),
				passingAgents(),
			),
		).toThrow("only as a sorcery");
	});

	test("Giant Caterpillar survives its source sacrifice as a delayed end-step trigger", () => {
		const state = setupMain(engine);
		const agents = passingAgents();
		const caterpillar = spawnPermanent(
			engine,
			state,
			"rt-giant-caterpillar",
			ALICE,
		);
		state.players[ALICE].manaPool.g = 1;

		executeAbilityAction(
			engine,
			state,
			ALICE,
			{
				kind: "activate ability",
				source: caterpillar.id,
				ability: abilityId("activated", "rt-giant-caterpillar", 0),
			},
			agents,
		);

		expect(state.battlefield).not.toContain(caterpillar.id);
		expect(state.delayedTriggers).toHaveLength(0);
		settlePriority(engine, state, agents);
		expect(state.delayedTriggers).toMatchObject([
			{
				controller: ALICE,
				source: caterpillar.id,
				triggerId: "rt-giant-caterpillar:0",
				sourceLastKnown: { controller: ALICE },
			},
		]);
		expect(
			state.battlefield.some((id) => name(engine, state, id) === "Butterfly"),
		).toBe(false);

		advanceUntil(engine, state, agents, (next) => isTurnStep(next, "end"));

		expect(state.delayedTriggers).toHaveLength(0);
		expect(
			state.battlefield.filter((id) => name(engine, state, id) === "Butterfly"),
		).toHaveLength(1);
	});

	test("Giant Caterpillar activated during an end step waits for the following end step", () => {
		const state = setupMain(engine);
		const agents = passingAgents();
		advanceUntil(engine, state, agents, (next) => isTurnStep(next, "end"));
		const completedTurns = state.completedTurns;
		const caterpillar = spawnPermanent(
			engine,
			state,
			"rt-giant-caterpillar",
			ALICE,
		);
		state.players[ALICE].manaPool.g = 1;

		executeAbilityAction(
			engine,
			state,
			ALICE,
			{
				kind: "activate ability",
				source: caterpillar.id,
				ability: abilityId("activated", "rt-giant-caterpillar", 0),
			},
			agents,
		);
		settlePriority(engine, state, agents);
		expect(state.delayedTriggers).toHaveLength(1);

		advance(engine, state, agents);
		expect(
			state.battlefield.some((id) => name(engine, state, id) === "Butterfly"),
		).toBe(false);
		advanceUntil(
			engine,
			state,
			agents,
			(next) => next.completedTurns > completedTurns && isTurnStep(next, "end"),
		);

		expect(state.delayedTriggers).toHaveLength(0);
		expect(
			state.battlefield.filter((id) => name(engine, state, id) === "Butterfly"),
		).toHaveLength(1);
	});

	test("Rummaging Goblin's imported discard cost is paid before it draws", () => {
		const state = setupMain(engine);
		const agents = passingAgents();
		const goblin = spawnPermanent(engine, state, "rt-rummaging-goblin", ALICE, {
			summoningSick: false,
		});
		spawnCard(state, "forest", ALICE, "hand");
		const handBefore = state.players[ALICE].hand.length;
		const libraryBefore = state.players[ALICE].library.length;
		const graveyardBefore = state.players[ALICE].graveyard.length;

		executeAbilityAction(
			engine,
			state,
			ALICE,
			{
				kind: "activate ability",
				source: goblin.id,
				ability: abilityId("activated", "rt-rummaging-goblin", 0),
			},
			agents,
		);
		settlePriority(engine, state, agents);

		expect(permanent(state, goblin.id).tapped, "the tap cost was paid").toBe(
			true,
		);
		expect(
			state.players[ALICE].graveyard,
			"the discard cost was paid",
		).toHaveLength(graveyardBefore + 1);
		expect(
			state.players[ALICE].hand,
			"one card discarded, one drawn",
		).toHaveLength(handBefore);
		expect(state.players[ALICE].library).toHaveLength(libraryBefore - 1);
	});

	test("Persistent Specimen activates only from its owner's graveyard and returns tapped", () => {
		const state = setupMain(engine);
		const specimen = spawnCard(
			state,
			"rt-persistent-specimen",
			ALICE,
			"graveyard",
		);
		const ability = abilityId("activated", "rt-persistent-specimen", 0);
		state.players[ALICE].manaPool.b = 1;
		state.players[ALICE].manaPool.c = 2;
		const action = {
			kind: "activate ability" as const,
			source: specimen.id,
			ability,
		};

		expect(getObservableActions(engine, state, ALICE)).toContainEqual(action);
		expect(getObservableActions(engine, state, BOB)).not.toContainEqual(action);
		executeAbilityAction(engine, state, ALICE, action, passingAgents());
		expect(state.players[ALICE].graveyard).toContain(specimen.id);
		settlePriority(engine, state, passingAgents());

		const returned = state.battlefield.find(
			(id) => name(engine, state, id) === "Persistent Specimen",
		);
		if (returned === undefined) throw new Error("specimen did not return");
		expect(permanent(state, returned)).toMatchObject({
			controller: ALICE,
			tapped: true,
		});
		expect(getObservableActions(engine, state, ALICE)).not.toContainEqual({
			...action,
			source: returned,
		});
		expect(() =>
			executeAbilityAction(
				engine,
				state,
				ALICE,
				{ ...action, source: returned },
				passingAgents(),
			),
		).toThrow();
	});

	test("Arcanis's imported nontargeted ability returns its source to its owner's hand", () => {
		const state = setupMain(engine);
		const arcanis = spawnPermanent(engine, state, "rt-arcanis", ALICE);
		const handSize = state.players[ALICE].hand.length;
		const ability = abilityId("activated", "rt-arcanis", 1);
		state.players[ALICE].manaPool.u = 2;
		state.players[ALICE].manaPool.c = 2;

		executeAbilityAction(
			engine,
			state,
			ALICE,
			{ kind: "activate ability", source: arcanis.id, ability },
			passingAgents(),
		);

		expect(state.stack).toHaveLength(1);
		expect(state.battlefield).toContain(arcanis.id);
		settlePriority(engine, state, passingAgents());
		expect(state.battlefield).not.toContain(arcanis.id);
		expect(state.players[ALICE].hand).toHaveLength(handSize + 1);
		expect(
			state.players[ALICE].hand.some(
				(object) => name(engine, state, object) === "Arcanis the Omnipotent",
			),
		).toBe(true);
		expect(state.stack).toHaveLength(0);
	});

	test("Timeless Lotus's imported fixed list adds W/U and the other symbols in one activation", () => {
		const state = setupMain(engine);
		const lotus = spawnPermanent(engine, state, "rt-timeless-lotus", ALICE);
		const ability = abilityId("activated", "rt-timeless-lotus", 0);

		executeAbilityAction(
			engine,
			state,
			ALICE,
			{ kind: "activate ability", source: lotus.id, ability },
			passingAgents(),
		);

		expect(permanent(state, lotus.id).tapped).toBe(true);
		expect(state.players[ALICE].manaPool).toEqual({
			w: 1,
			u: 1,
			b: 1,
			r: 1,
			g: 1,
			c: 0,
		});
		expect(state.stack).toHaveLength(0);
	});

	// Both branches of `Produced$ Combo U R` are exercised: the ability offers
	// exactly the two printed symbols, and the pool receives only the chosen one.
	for (const [chosenLabel, expectedPool] of [
		["Add {U}.", { w: 0, u: 1, b: 0, r: 0, g: 0, c: 0 }],
		["Add {R}.", { w: 0, u: 0, b: 0, r: 1, g: 0, c: 0 }],
	] as const) {
		test(`Temple of Epiphany enters tapped, scries one, and taps for ${chosenLabel}`, () => {
			const state = newGame();
			const alice = new ScriptedAgent();
			// The end of a library array is its top, so `scried` is the card the
			// scry looks at and `deeper` stays untouched beneath it.
			const deeper = spawnCard(state, "darksteel-relic", ALICE, "library").id;
			const scried = spawnCard(state, "forest", ALICE, "library").id;
			alice.scryChoices.push({ top: [], bottom: [scried] });
			const offeredLabels: string[][] = [];
			const chooseColor: SyncAgent = {
				choose(view, request) {
					if (request.kind === "mana") {
						offeredLabels.push(request.options.map((option) => option.label));
						const chosen = request.options.find(
							(option) => option.label === chosenLabel,
						);
						if (!chosen) {
							throw new Error(`no ${chosenLabel} option was offered`);
						}
						return { optionId: chosen.id };
					}
					return alice.choose(view, request);
				},
			};
			const agents: SyncAgents = [chooseColor, new ScriptedAgent()];
			beginFirstTurn(engine, state, agents);

			const temple = enterFromHand(
				state,
				"rt-temple-of-epiphany",
				ALICE,
				agents,
			);
			expect(permanent(state, temple).tapped).toBe(true);
			expect(state.pendingTriggers).toHaveLength(1);

			settlePriority(engine, state, agents);
			// The enters-tapped replacement and the scry trigger are independent:
			// the trigger must have resolved and consumed the scripted scry.
			expect(alice.scryChoices).toHaveLength(0);
			expect(state.players[ALICE].library[0]).toBe(scried);
			expect(state.players[ALICE].library.at(-1)).toBe(deeper);

			perform(engine, state, { kind: "untap", objects: [temple] }, agents);
			expect(permanent(state, temple).tapped).toBe(false);

			executeAbilityAction(
				engine,
				state,
				ALICE,
				{
					kind: "activate ability",
					source: temple,
					ability: abilityId("activated", "rt-temple-of-epiphany", 0),
				},
				agents,
			);

			expect(offeredLabels).toEqual([["Add {U}.", "Add {R}."]]);
			expect(permanent(state, temple).tapped).toBe(true);
			expect(state.players[ALICE].manaPool).toEqual(expectedPool);
			// A mana ability never uses the stack (CR 605.3a).
			expect(state.stack).toHaveLength(0);
		});
	}

	test("Golgari Rot Farm enters tapped, returns a chosen land, and taps for {B}{G}", () => {
		const state = newGame();
		const forest = spawnPermanent(engine, state, "forest", ALICE);
		const offered: ObjectId[][] = [];
		const alice = new ScriptedAgent();
		const chooseForest: SyncAgent = {
			choose(view, request) {
				if (
					request.kind === "object" &&
					request.context.reason.kind === "select"
				) {
					offered.push([...request.context.objects]);
					return { optionId: String(forest.id) };
				}
				return alice.choose(view, request);
			},
		};
		const agents: SyncAgents = [chooseForest, new ScriptedAgent()];
		beginFirstTurn(engine, state, agents);

		const farm = enterFromHand(state, "rt-golgari-rot-farm", ALICE, agents);
		expect(permanent(state, farm).tapped).toBe(true);
		expect(state.pendingTriggers).toHaveLength(1);

		settlePriority(engine, state, agents);
		expect(offered).toEqual([[forest.id, farm]]);
		expect(state.battlefield).not.toContain(forest.id);
		expect(state.objects.has(forest.id)).toBe(false);
		expect(
			state.players[ALICE].hand.map((id) => name(engine, state, id)),
		).toContain("Forest");
		expect(permanent(state, farm).tapped).toBe(true);

		perform(engine, state, { kind: "untap", objects: [farm] }, agents);
		executeAbilityAction(
			engine,
			state,
			ALICE,
			{
				kind: "activate ability",
				source: farm,
				ability: abilityId("activated", "rt-golgari-rot-farm", 0),
			},
			agents,
		);
		expect(state.players[ALICE].manaPool).toEqual({
			w: 0,
			u: 0,
			b: 1,
			r: 0,
			g: 1,
			c: 0,
		});
	});

	test("Black Lotus offers three of each colour, sacrifices itself, and pays out only the chosen colour", () => {
		const state = setupMain(engine);
		const lotus = spawnPermanent(engine, state, "rt-black-lotus", ALICE);
		const ability = abilityId("activated", "rt-black-lotus", 0);
		const offeredLabels: string[][] = [];
		const fallback = new ScriptedAgent();
		const chooseBlack: SyncAgent = {
			choose(view, request) {
				if (request.kind === "mana") {
					offeredLabels.push(request.options.map((option) => option.label));
					const chosen = request.options.find(
						(option) => option.label === "Add 3{B}.",
					);
					if (!chosen) throw new Error("no black option was offered");
					return { optionId: chosen.id };
				}
				return fallback.choose(view, request);
			},
		};

		executeAbilityAction(
			engine,
			state,
			ALICE,
			{ kind: "activate ability", source: lotus.id, ability },
			[chooseBlack, new ScriptedAgent()],
		);

		expect(offeredLabels).toEqual([
			["Add 3{W}.", "Add 3{U}.", "Add 3{B}.", "Add 3{R}.", "Add 3{G}."],
		]);
		// Three of the one chosen colour, not three spread over the choices.
		expect(state.players[ALICE].manaPool).toEqual({
			w: 0,
			u: 0,
			b: 3,
			r: 0,
			g: 0,
			c: 0,
		});
		// The sacrifice cost put it in the graveyard, so it is no longer a
		// permanent on the battlefield.
		expect(state.objects.get(lotus.id)).toBeUndefined();
		expect(state.players[ALICE].graveyard).toHaveLength(1);
		expect(state.stack).toHaveLength(0);
	});

	test("Llanowar Elves' imported mana ability taps and adds green mana immediately", () => {
		const state = setupMain(engine);
		const elves = spawnPermanent(engine, state, "rt-llanowar-elves", ALICE, {
			summoningSick: false,
		});
		const ability = abilityId("activated", "rt-llanowar-elves", 0);

		executeAbilityAction(
			engine,
			state,
			ALICE,
			{ kind: "activate ability", source: elves.id, ability },
			passingAgents(),
		);

		expect(permanent(state, elves.id).tapped).toBe(true);
		expect(state.players[ALICE].manaPool.g).toBe(1);
		expect(state.stack).toHaveLength(0);
	});

	test("Rod of Ruin's imported paid ability executes through normal priority", () => {
		const state = setupMain(engine);
		const rod = spawnPermanent(engine, state, "rt-rod-of-ruin", ALICE);
		const ability = abilityId("activated", "rt-rod-of-ruin", 0);
		state.players[ALICE].manaPool.c = 3;
		const alice = new ScriptedAgent();
		alice.priorityActions.push({
			kind: "activate ability",
			source: rod.id,
			ability,
		});
		alice.targetChoices.push({ type: "player", player: BOB });

		settlePriority(engine, state, [alice, new ScriptedAgent()]);

		expect(alice.priorityActions).toHaveLength(0);
		expect(alice.targetChoices).toHaveLength(0);
		expect(permanent(state, rod.id).tapped).toBe(true);
		expect(state.players[ALICE].manaPool.c).toBe(0);
		expect(state.players[BOB].life).toBe(19);
		expect(state.stack).toHaveLength(0);
	});

	test("Icy Manipulator's imported ability pays its costs and taps its target on resolution", () => {
		const state = setupMain(engine);
		const icy = spawnPermanent(engine, state, "rt-icy-manipulator", ALICE);
		const target = spawnPermanent(engine, state, "rt-grizzly-bears", BOB);
		const ability = abilityId("activated", "rt-icy-manipulator", 0);
		state.players[ALICE].manaPool.c = 1;
		const alice = new ScriptedAgent();
		alice.targetChoices.push({ type: "permanent", id: target.id });

		executeAbilityAction(
			engine,
			state,
			ALICE,
			{ kind: "activate ability", source: icy.id, ability },
			[alice, new ScriptedAgent()],
		);

		expect(permanent(state, icy.id).tapped).toBe(true);
		expect(permanent(state, target.id).tapped).toBe(false);
		expect(state.players[ALICE].manaPool.c).toBe(0);
		expect(state.stack).toHaveLength(1);

		settlePriority(engine, state, passingAgents());

		expect(permanent(state, target.id).tapped).toBe(true);
		expect(state.stack).toHaveLength(0);
	});

	test("Wirewood Lodge's imported ability pays its costs and untaps its Elf target on resolution", () => {
		const state = setupMain(engine);
		const lodge = spawnPermanent(engine, state, "rt-wirewood-lodge", ALICE);
		const target = spawnPermanent(engine, state, "rt-llanowar-elves", ALICE, {
			tapped: true,
		});
		const ability = abilityId("activated", "rt-wirewood-lodge", 1);
		state.players[ALICE].manaPool.g = 1;
		const alice = new ScriptedAgent();
		alice.targetChoices.push({ type: "permanent", id: target.id });

		executeAbilityAction(
			engine,
			state,
			ALICE,
			{ kind: "activate ability", source: lodge.id, ability },
			[alice, new ScriptedAgent()],
		);

		expect(permanent(state, lodge.id).tapped).toBe(true);
		expect(permanent(state, target.id).tapped).toBe(true);
		expect(state.players[ALICE].manaPool.g).toBe(0);
		expect(state.stack).toHaveLength(1);

		settlePriority(engine, state, passingAgents());

		expect(permanent(state, target.id).tapped).toBe(false);
		expect(state.stack).toHaveLength(0);
	});

	test("Viscera Seer's imported ability can sacrifice itself and scry", () => {
		const state = setupMain(engine);
		const top = spawnCard(state, "forest", ALICE, "library");
		const seer = spawnPermanent(engine, state, "rt-viscera-seer", ALICE);
		const ability = abilityId("activated", "rt-viscera-seer", 0);
		const alice = new ScriptedAgent(
			[],
			[],
			[],
			[],
			[],
			[],
			[{ top: [], bottom: [top.id] }],
			[seer.id],
		);

		executeAbilityAction(
			engine,
			state,
			ALICE,
			{ kind: "activate ability", source: seer.id, ability },
			[alice, new ScriptedAgent()],
		);

		expect(state.battlefield).not.toContain(seer.id);
		expect(state.players[ALICE].graveyard).toHaveLength(1);
		expect(
			name(engine, state, state.players[ALICE].graveyard[0] as ObjectId),
		).toBe("Viscera Seer");
		expect(state.stack).toHaveLength(1);
		settlePriority(engine, state, [alice, new ScriptedAgent()]);
		expect(state.players[ALICE].library[0]).toBe(top.id);
		expect(state.stack).toHaveLength(0);
	});

	test("Cathar Commando casts during an opponent's turn, then sacrifices itself to destroy", () => {
		const state = setupMain(engine);
		expect(activePlayer(state)).toBe(ALICE);
		const card = spawnCard(state, "rt-cathar-commando", BOB, "hand");
		const target = spawnPermanent(engine, state, "rt-glorious-anthem", ALICE);
		state.players[BOB].manaPool.c = 2;
		state.players[BOB].manaPool.w = 1;

		expect(getObservableActions(engine, state, BOB)).toContainEqual({
			kind: "cast",
			card: card.id,
		});
		const caster = new ScriptedAgent([], [], [{ kind: "cast", card: card.id }]);
		settlePriority(engine, state, [new ScriptedAgent(), caster]);
		expect(caster.priorityActions).toHaveLength(0);
		expect(state.players[BOB].manaPool).toMatchObject({ c: 1, w: 0 });

		const commando = state.battlefield.find(
			(id) => name(engine, state, id) === "Cathar Commando",
		);
		if (commando === undefined)
			throw new Error("Cathar Commando did not resolve to the battlefield");
		const ability = abilityId("activated", "rt-cathar-commando", 0);
		const bob = new ScriptedAgent();
		bob.targetChoices.push({ type: "permanent", id: target.id });
		executeAbilityAction(
			engine,
			state,
			BOB,
			{ kind: "activate ability", source: commando, ability },
			[new ScriptedAgent(), bob],
		);

		expect(state.players[BOB].manaPool.c).toBe(0);
		expect(state.battlefield).not.toContain(commando);
		expect(state.battlefield).toContain(target.id);
		settlePriority(engine, state, passingAgents());
		expect(state.battlefield).not.toContain(target.id);
	});

	for (const [targetCard, targetType] of [
		["rt-timeless-lotus", "artifact"],
		["rt-glorious-anthem", "enchantment"],
	] as const) {
		test(`Thrashing Brontodon sacrifices itself to destroy a target ${targetType}`, () => {
			const state = setupMain(engine);
			const brontodon = spawnPermanent(
				engine,
				state,
				"rt-thrashing-brontodon",
				ALICE,
			);
			const target = spawnPermanent(engine, state, targetCard, BOB);
			const ability = abilityId("activated", "rt-thrashing-brontodon", 0);
			state.players[ALICE].manaPool.c = 1;
			const alice = new ScriptedAgent();
			alice.targetChoices.push({ type: "permanent", id: target.id });

			executeAbilityAction(
				engine,
				state,
				ALICE,
				{ kind: "activate ability", source: brontodon.id, ability },
				[alice, new ScriptedAgent()],
			);

			expect(state.players[ALICE].manaPool.c).toBe(0);
			expect(state.battlefield).not.toContain(brontodon.id);
			expect(state.battlefield).toContain(target.id);
			expect(state.stack).toHaveLength(1);

			settlePriority(engine, state, passingAgents());

			expect(state.battlefield).not.toContain(target.id);
			expect(state.stack).toHaveLength(0);
		});
	}

	test("Selfless Savior sacrifices itself to grant another creature indestructible", () => {
		const state = setupMain(engine);
		const savior = spawnPermanent(engine, state, "rt-selfless-savior", ALICE);
		const target = spawnPermanent(engine, state, "rt-grizzly-bears", ALICE);
		const ability = abilityId("activated", "rt-selfless-savior", 0);

		const invalid = new ScriptedAgent();
		invalid.targetChoices.push({ type: "permanent", id: savior.id });
		expect(() =>
			executeAbilityAction(
				engine,
				state,
				ALICE,
				{ kind: "activate ability", source: savior.id, ability },
				[invalid, new ScriptedAgent()],
			),
		).toThrow();
		expect(state.battlefield).toContain(savior.id);

		const alice = new ScriptedAgent();
		alice.targetChoices.push({ type: "permanent", id: target.id });
		executeAbilityAction(
			engine,
			state,
			ALICE,
			{ kind: "activate ability", source: savior.id, ability },
			[alice, new ScriptedAgent()],
		);

		expect(state.battlefield).not.toContain(savior.id);
		expect(
			getSnapshot(createReadContext(engine, state), target.id)
				.currentCharacteristics.keywords,
		).not.toContain("indestructible");
		settlePriority(engine, state, passingAgents());
		expect(
			getSnapshot(createReadContext(engine, state), target.id)
				.currentCharacteristics.keywords,
		).toContain("indestructible");
		expect(state.temporaryEffects[0]).toMatchObject({
			source: {
				origin: "ability-effect",
				category: "activated",
				abilityId: ability,
				effectIndex: 0,
			},
			bindings: { "target-1": { type: "permanent", id: target.id } },
			duration: "until-end-of-turn",
		});

		perform(
			engine,
			state,
			{ kind: "destroy", object: target.id, noRegen: false },
			passingAgents(),
		);
		expect(state.battlefield).toContain(target.id);
	});

	test("Blazing Hellhound sacrifices another creature but not itself", () => {
		const state = setupMain(engine);
		const hellhound = spawnPermanent(
			engine,
			state,
			"rt-blazing-hellhound",
			ALICE,
		);
		const ability = abilityId("activated", "rt-blazing-hellhound", 0);
		state.players[ALICE].manaPool.c = 1;
		expect(
			getObservableActions(engine, state, ALICE).some(
				(action) =>
					action.kind === "activate ability" && action.ability === ability,
			),
		).toBe(false);

		const fodder = spawnPermanent(engine, state, "rt-grizzly-bears", ALICE);
		const alice = new ScriptedAgent([], [], [], [], [], [], [], [fodder.id]);
		alice.targetChoices.push({ type: "player", player: BOB });
		expect(
			getObservableActions(engine, state, ALICE).some(
				(action) =>
					action.kind === "activate ability" && action.ability === ability,
			),
		).toBe(true);

		executeAbilityAction(
			engine,
			state,
			ALICE,
			{ kind: "activate ability", source: hellhound.id, ability },
			[alice, new ScriptedAgent()],
		);
		expect(state.battlefield).toContain(hellhound.id);
		expect(state.battlefield).not.toContain(fodder.id);
		settlePriority(engine, state, [alice, new ScriptedAgent()]);
		expect(state.players[BOB].life).toBe(19);
	});

	test("Bartolomé sacrifices another artifact, then gets its counter on resolution", () => {
		const state = setupMain(engine);
		const bartolome = spawnPermanent(
			engine,
			state,
			"rt-bartolome-del-presidio",
			ALICE,
		);
		const ability = abilityId("activated", "rt-bartolome-del-presidio", 0);
		expect(
			getObservableActions(engine, state, ALICE).some(
				(action) =>
					action.kind === "activate ability" && action.ability === ability,
			),
			"Bartolomé cannot pay the another-permanent cost with itself",
		).toBe(false);

		const relic = spawnPermanent(engine, state, "darksteel-relic", ALICE);
		const alice = new ScriptedAgent([], [], [], [], [], [], [], [relic.id]);
		executeAbilityAction(
			engine,
			state,
			ALICE,
			{ kind: "activate ability", source: bartolome.id, ability },
			[alice, new ScriptedAgent()],
		);

		expect(state.battlefield).toContain(bartolome.id);
		expect(state.battlefield).not.toContain(relic.id);
		expect(permanent(state, bartolome.id).counters["+1/+1"] ?? 0).toBe(0);
		expect(state.stack).toHaveLength(1);

		settlePriority(engine, state, [alice, new ScriptedAgent()]);
		expect(permanent(state, bartolome.id).counters["+1/+1"]).toBe(1);
		expect(state.stack).toHaveLength(0);
	});

	test("Acolyte of Aclazotz sacrifices another artifact and drains its opponent", () => {
		const state = setupMain(engine);
		const acolyte = spawnPermanent(
			engine,
			state,
			"rt-acolyte-of-aclazotz",
			ALICE,
			{
				summoningSick: false,
			},
		);
		const relic = spawnPermanent(engine, state, "darksteel-relic", ALICE);
		const ability = abilityId("activated", "rt-acolyte-of-aclazotz", 0);
		const alice = new ScriptedAgent([], [], [], [], [], [], [], [relic.id]);

		executeAbilityAction(
			engine,
			state,
			ALICE,
			{ kind: "activate ability", source: acolyte.id, ability },
			[alice, new ScriptedAgent()],
		);
		expect(state.battlefield).toContain(acolyte.id);
		expect(state.battlefield).not.toContain(relic.id);
		settlePriority(engine, state, [alice, new ScriptedAgent()]);
		expect(state.players[ALICE].life).toBe(21);
		expect(state.players[BOB].life).toBe(19);
	});

	test("Soulmender's imported targetless activated ability resolves through the stack", () => {
		const state = setupMain(engine);
		const soulmender = spawnPermanent(engine, state, "rt-soulmender", ALICE, {
			summoningSick: false,
		});
		const ability = abilityId("activated", "rt-soulmender", 0);

		executeAbilityAction(
			engine,
			state,
			ALICE,
			{ kind: "activate ability", source: soulmender.id, ability },
			passingAgents(),
		);
		expect(permanent(state, soulmender.id).tapped).toBe(true);
		expect(
			state.players[ALICE].life,
			"effect is on the stack, not resolved",
		).toBe(20);

		settlePriority(engine, state, passingAgents());
		expect(state.players[ALICE].life).toBe(21);
		expect(state.stack).toHaveLength(0);
	});
});

describe("forge-import runtime: registry and clone integrity", () => {
	test("an imported card with a static and a replacement survives structuredClone and rebuilds identical views", () => {
		const state = newGame();
		const agents: SyncAgents = [new ScriptedAgent(), new ScriptedAgent()];
		beginFirstTurn(engine, state, agents);
		spawnPermanent(engine, state, "rt-glorious-anthem", ALICE);
		spawnPermanent(engine, state, "rt-root-maze", ALICE);
		const bear = spawnPermanent(engine, state, "rt-grizzly-bears", ALICE);

		const before = getSnapshot(
			createReadContext(engine, state),
			bear.id,
		).currentCharacteristics;
		const cloned = structuredClone(state);
		const after = getSnapshot(
			createReadContext(engine, cloned),
			bear.id,
		).currentCharacteristics;

		expect(after).toEqual(before);
		expect(after).toMatchObject({ power: 3, toughness: 3 });
	});
});
