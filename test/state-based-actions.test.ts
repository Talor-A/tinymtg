import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "../agents.ts";
import { CARDS, regenerationShield } from "../cards.ts";
import {
	addTemporaryEffect,
	type CharacteristicsSnapshot,
	createEngine,
	defineCard,
	getSnapshot,
	permanent,
	physicalCardId,
} from "../index.ts";
import { assert } from "../lib/assert.ts";
import {
	type SyncAgents as Agents,
	ALICE,
	BOB,
	created,
} from "./utils/engine-helpers.ts";

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

const INDESTRUCTIBLE_ANTHEM = defineCard({
	id: "test-indestructible-anthem",
	name: "Indestructible Anthem",
	types: ["enchantment"],
	colors: ["w"],
	manaCost: { w: 1 },
	statics: [
		{
			layer: "6-ability-changing",
			text: "Creatures you control have indestructible.",
			applies: (view, _state, source) =>
				source.kind === "permanent" &&
				source.zone === "battlefield" &&
				view.currentCharacteristics.types.includes("creature") &&
				view.controller === source.controller,
			modify: (view) => {
				assert(
					!view.keywords.includes("indestructible"),
					"test fixture cannot grant duplicate indestructible",
				);
				view.keywords.push("indestructible");
			},
		},
	],
});

const engine = createEngine([...CARDS, INDESTRUCTIBLE_ANTHEM]);

describe("indestructible permanents", () => {
	test("a layer-6 grant follows its source without changing copiable values", () => {
		const state = engine.newGame();
		const agents: Agents = [new ScriptedAgent(), new ScriptedAgent()];
		const anthem = engine.spawnPermanent(
			state,
			INDESTRUCTIBLE_ANTHEM.id,
			ALICE,
		);
		const bears = engine.spawnPermanent(state, "grizzly-bears", ALICE);

		const granted = getSnapshot(engine.createReadContext(state), bears.id);
		expect(granted.currentCharacteristics.keywords).toContain("indestructible");
		expect(granted.copiableValues.keywords).not.toContain("indestructible");
		engine.perform(
			state,
			{ kind: "destroy", object: bears.id, noRegen: false },
			agents,
		);
		expect(state.battlefield).toContain(bears.id);

		engine.perform(
			state,
			{
				kind: "change zone",
				object: anthem.id,
				from: "battlefield",
				destination: { zone: "graveyard" },
				cause: "effect",
			},
			agents,
		);
		const expired = getSnapshot(engine.createReadContext(state), bears.id);
		expect(expired.currentCharacteristics.keywords).not.toContain(
			"indestructible",
		);

		engine.perform(
			state,
			{ kind: "destroy", object: bears.id, noRegen: false },
			agents,
		);
		expect(state.battlefield).not.toContain(bears.id);
	});

	test("a failed destruction attempt doesn't consume a regeneration shield", () => {
		const state = engine.newGame();
		const agents: Agents = [new ScriptedAgent(), new ScriptedAgent()];
		const myr = engine.spawnPermanent(state, "darksteel-myr", ALICE);
		addTemporaryEffect(state, ALICE, regenerationShield(myr.id));

		const result = engine.perform(
			state,
			{ kind: "destroy", object: myr.id, noRegen: false },
			agents,
		);

		expect(result.executed, "the prohibited event didn't execute").toEqual([]);
		expect(state.battlefield.includes(myr.id), "Myr survived").toBe(true);
		expect(
			state.temporaryEffects[0]?.source.origin === "builtin" &&
				state.temporaryEffects[0].source.builtin.kind ===
					"regeneration-shield" &&
				state.temporaryEffects[0].source.builtin.used,
			"a non-self replacement can't apply to a prohibited event (CR 614.17c)",
		).toBe(false);
	});

	test("lethal damage and deathtouch don't destroy them", () => {
		const state = engine.newGame();
		const agents: Agents = [new ScriptedAgent(), new ScriptedAgent()];
		const lethal = engine.spawnPermanent(state, "darksteel-myr", ALICE);
		const deathtouched = engine.spawnPermanent(state, "darksteel-myr", ALICE, {
			counters: { "+1/+1": 1 },
		});
		permanent(state, lethal.id).damage = 1;
		permanent(state, deathtouched.id).damage = 1;
		permanent(state, deathtouched.id).attributes.deathtouched = true;

		engine.checkStateBasedActions(state, agents);

		expect(state.battlefield.includes(lethal.id)).toBe(true);
		expect(state.battlefield.includes(deathtouched.id)).toBe(true);
		expect(
			permanent(state, deathtouched.id).attributes.deathtouched,
			"the next SBA check must not reuse old deathtouch damage",
		).toBeUndefined();
	});

	test("zero toughness still puts them into the graveyard", () => {
		const state = engine.newGame();
		const agents: Agents = [new ScriptedAgent(), new ScriptedAgent()];
		const myr = engine.spawnPermanent(state, "darksteel-myr", ALICE, {
			counters: { "-1/-1": 1 },
		});

		engine.checkStateBasedActions(state, agents);

		expect(state.battlefield.includes(myr.id)).toBe(false);
	});
});

describe("tokens leaving the battlefield", () => {
	test("a token on the battlefield has no physical card ID", () => {
		const state = engine.newGame();
		const token = engine.spawnToken(state, ALICE, ZOMBIE_TOKEN);

		expect(physicalCardId(token)).toBe(null);
	});

	test("the zone change happens before the token ceases to exist as an SBA", () => {
		const state = engine.newGame();
		const agents: Agents = [new ScriptedAgent(), new ScriptedAgent()];
		const token = engine.spawnToken(state, ALICE, ZOMBIE_TOKEN);

		const result = engine.perform(
			state,
			{
				kind: "change zone",
				object: token.id,
				from: "battlefield",
				destination: { zone: "graveyard" },
				cause: "sacrifice",
			},
			agents,
		);

		expect(result.executed).toHaveLength(1);
		expect(result.created).toHaveLength(1);
		const movedId = created(result);
		const moved = state.objects.get(movedId);
		expect(moved?.kind).toBe("nonbattlefield-token");
		expect(moved?.zone).toBe("graveyard");
		if (!moved) return;
		expect(physicalCardId(moved)).toBe(null);
		if (moved.kind !== "nonbattlefield-token") return;
		expect(moved.createdValues.name).toBe("Zombie Token");

		engine.checkStateBasedActions(state, agents);
		expect(state.objects.has(movedId)).toBe(false);
		expect(state.players[ALICE].graveyard.includes(movedId)).toBe(false);
	});
});

describe("regenerating a creature", () => {
	test("regeneration saves it from lethal damage but not zero toughness", () => {
		const state = engine.newGame();
		const agents: Agents = [new ScriptedAgent(), new ScriptedAgent()];
		const bears = engine.spawnPermanent(state, "grizzly-bears", 0);
		const pyro = engine.spawnPermanent(state, "eager-cadet", 1);
		addTemporaryEffect(state, 0, regenerationShield(bears.id));

		engine.perform(
			state,
			{
				kind: "damage",
				source: pyro.id,
				sourceController: BOB,
				sourceColors: ["r"],
				recipient: { type: "permanent", id: bears.id },
				amount: 2,
				combat: false,
				deathtouch: false,
				lifelink: false,
				unpreventable: false,
			},
			agents,
		);
		engine.checkStateBasedActions(state, agents);
		expect(state.battlefield.includes(bears.id), "bears survived").toBe(true);
		expect(
			permanent(state, bears.id).tapped,
			"bears tapped by regeneration",
		).toBe(true);
		expect(permanent(state, bears.id).damage, "damage removed").toBe(0);

		// Shrink it to 0 toughness: no destroy event, so no shield to hook.
		engine.perform(
			state,
			{
				kind: "add counters",
				permanent: { type: "permanent", id: bears.id },
				counter: "-1/-1",
				amount: 2,
			},
			agents,
		);
		engine.checkStateBasedActions(state, agents);
		expect(state.battlefield.includes(bears.id), "bears died to SBA").toBe(
			false,
		);
	});
});

describe("player counters", () => {
	test("poison counters go on, come off, and kill at ten", () => {
		const state = engine.newGame();
		const agents: Agents = [new ScriptedAgent(), new ScriptedAgent()];

		engine.perform(
			state,
			{
				kind: "add player counters",
				player: ALICE,
				counter: "poison",
				amount: 10,
			},
			agents,
		);
		expect(state.players[ALICE].counters.poison).toBe(10);

		// Removal is symmetric with addition: nine off leaves one, below the
		// 704.5c threshold.
		engine.perform(
			state,
			{
				kind: "remove player counters",
				player: ALICE,
				counters: { poison: 9 },
			},
			agents,
		);
		expect(state.players[ALICE].counters.poison).toBe(1);
		engine.checkStateBasedActions(state, agents);
		expect(state.players[ALICE].lost, "one poison is survivable").toBe(false);

		engine.perform(
			state,
			{
				kind: "add player counters",
				player: ALICE,
				counter: "poison",
				amount: 9,
			},
			agents,
		);
		engine.checkStateBasedActions(state, agents);
		expect(state.players[ALICE].lost, "ten poison loses the game").toBe(true);
	});
});
