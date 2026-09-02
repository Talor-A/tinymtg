import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "./agents.ts";
import "./cards.ts";
import {
	activatedAbilityId,
	advanceWithReplay,
	buildGameView,
	type CharacteristicsSnapshot,
	createReadContext,
	newGame,
	type PlayerId,
	perform,
	physicalCardId,
	prohibitionAbilityId,
	readObject,
	registerCard,
	replacementAbilityId,
	resolveActivatedAbility,
	resolveStaticAbility,
	resolveTriggeredAbility,
	spawnCard,
	spawnPermanent,
	spawnToken,
	staticAbilityId,
	triggeredAbilityId,
	view,
} from "./index.ts";

const P1 = 0 as PlayerId;
const P2 = 1 as PlayerId;
const agents: [ScriptedAgent, ScriptedAgent] = [
	new ScriptedAgent(),
	new ScriptedAgent(),
];

/**
 * "Creatures you control gain X" — the case that forces definitions and
 * possession apart. The instruction hosts the executable ability and the
 * layer-6 effect that hands it out, but prints neither: it is an enchantment,
 * it can't tap to draw, and nothing ever triggers off it entering.
 */
const GRANT_CARD = "test-communal-instruction";
const GRANTED_ACTIVATED = String(activatedAbilityId(GRANT_CARD, 0));
const GRANTED_TRIGGERED = String(triggeredAbilityId(GRANT_CARD, 0));
const GRANT_STATIC = String(staticAbilityId(GRANT_CARD, 0));

const COMMUNAL_INSTRUCTION = registerCard({
	id: GRANT_CARD,
	name: "Communal Instruction",
	types: ["enchantment"],
	colors: ["u"],
	manaCost: { u: 1, c: 1 },
	activatedAbilities: [
		{
			id: "granted-draw",
			text: "{T}: Draw a card.",
			manaAbility: false,
			costs: [{ kind: "tap-self" }],
			targets: [],
			effects: [{ kind: "draw", player: "you", amount: 1 }],
		},
	],
	triggers: [
		{
			id: "granted-etb-life",
			text: "When this creature enters, you gain 3 life.",
			condition: {
				kind: "change zone",
				from: "any",
				to: "battlefield",
				selector: "self",
			},
			effects: [{ kind: "gain-life", player: "you", amount: 3 }],
		},
	],
	statics: [
		{
			layer: "6-ability-changing",
			text: 'Creatures you control have "{T}: Draw a card." and "When this creature enters, you gain 3 life."',
			applies: (v, _state, source) =>
				source.kind === "permanent" &&
				source.zone === "battlefield" &&
				v.types.includes("creature") &&
				v.controller === source.controller,
			modify: (v) => {
				v.abilities.activated.push(activatedAbilityId(GRANT_CARD, 0));
				v.abilities.triggered.push(triggeredAbilityId(GRANT_CARD, 0));
			},
		},
	],
	// Definitions only: the instruction itself has no activated or triggered
	// ability, just the static that grants them away.
	printed: { activated: [], triggered: [] },
});

describe("derived game views", () => {
	test("static ability IDs are exact cardId:index registry references", () => {
		const state = newGame();
		const source = spawnPermanent(
			state,
			"baby-mycosynth-lattice",
			P1,
			"battlefield",
		);
		const snapshot = readObject(createReadContext(state), source.id);
		expect(snapshot.kind).toBe("permanent");
		if (snapshot.kind !== "permanent") return;
		expect(snapshot.copiableValues.abilities.static.map(String)).toEqual([
			"baby-mycosynth-lattice:0",
		]);
		const colonCardStatic = {
			layer: "4-type-changing" as const,
			text: "test callback",
			applies: () => false,
			modify: () => {},
		};
		registerCard({
			id: "card:id:with:colons",
			name: "Colon Test Card",
			types: ["artifact"],
			colors: [],
			manaCost: "zero",
			statics: [colonCardStatic],
		});
		const id = staticAbilityId("card:id:with:colons", 0);
		expect(String(id)).toBe("card:id:with:colons:0");
		expect(resolveStaticAbility(id)).toBe(colonCardStatic);
		expect(
			resolveStaticAbility(snapshot.copiableValues.abilities.static[0]!),
		).toBeDefined();
	});

	test("activated ability IDs resolve and survive tokens and copying", () => {
		registerCard({
			id: "snapshot-activation-test",
			name: "Snapshot Activation Test",
			types: ["creature"],
			colors: [],
			manaCost: "zero",
			power: 1,
			toughness: 1,
			activatedAbilities: [
				{
					id: "unused-runtime-name",
					text: "{T}: Draw a card.",
					manaAbility: false,
					costs: [{ kind: "tap-self" }],
					targets: [],
					effects: [{ kind: "draw", player: "you", amount: 1 }],
				},
			],
		});
		const state = newGame();
		const source = spawnPermanent(
			state,
			"snapshot-activation-test",
			P1,
			"battlefield",
		);
		const sourceSnapshot = readObject(createReadContext(state), source.id);
		expect(sourceSnapshot.kind).toBe("permanent");
		if (sourceSnapshot.kind !== "permanent") return;
		expect(
			sourceSnapshot.copiableValues.abilities.activated.map(String),
		).toEqual(["snapshot-activation-test:0"]);
		const id = activatedAbilityId("snapshot-activation-test", 0);
		expect(resolveActivatedAbility(id).id).toBe("unused-runtime-name");

		const token = spawnToken(
			state,
			P1,
			structuredClone(sourceSnapshot.copiableValues),
		);
		const tokenSnapshot = readObject(createReadContext(state), token.id);
		expect(tokenSnapshot.kind).toBe("permanent");
		if (tokenSnapshot.kind !== "permanent") return;
		expect(
			tokenSnapshot.copiableValues.abilities.activated.map(String),
		).toEqual(["snapshot-activation-test:0"]);

		const clone = spawnCard(state, "clone", P1, "hand");
		const result = perform(
			state,
			{
				kind: "change zone",
				object: clone.id,
				from: "hand",
				to: "battlefield",
				cause: "resolve",
				toController: P1,
			},
			agents,
		);
		const copied = readObject(createReadContext(state), result.created[0]!);
		expect(copied.kind).toBe("permanent");
		if (copied.kind !== "permanent") return;
		expect(copied.copiableValues.abilities.activated.map(String)).toEqual([
			"snapshot-activation-test:0",
		]);
		expect(() => structuredClone(state)).not.toThrow();
	});

	test("triggered ability IDs resolve directly by cardId:index", () => {
		const state = newGame();
		const cleric = spawnPermanent(state, "arashin-cleric", P1, "battlefield");
		const snapshot = readObject(createReadContext(state), cleric.id);
		expect(snapshot.kind).toBe("permanent");
		if (snapshot.kind !== "permanent") return;
		expect(snapshot.copiableValues.abilities.triggered.map(String)).toEqual([
			"arashin-cleric:0",
		]);
		const id = triggeredAbilityId("arashin-cleric", 0);
		expect(resolveTriggeredAbility(id).id).toBe("etb-life");
	});

	test("counters change current characteristics but not copiable values", () => {
		const state = newGame();
		const bears = spawnPermanent(state, "grizzly-bears", P1, "battlefield", {
			counters: { "+1/+1": 1 },
		});
		const snapshot = readObject(createReadContext(state), bears.id);
		expect(snapshot.kind).toBe("permanent");
		if (snapshot.kind !== "permanent") return;
		expect(snapshot.copiableValues).toMatchObject({
			kind: "creature",
			power: 2,
			toughness: 2,
		});
		expect(snapshot.currentCharacteristics).toMatchObject({
			kind: "creature",
			power: 3,
			toughness: 3,
		});
	});

	test("a successful mutation makes an existing ReadContext stale", () => {
		const state = newGame();
		const bears = spawnPermanent(state, "grizzly-bears", P1, "battlefield");
		const read = createReadContext(state);
		expect(readObject(read, bears.id).kind).toBe("permanent");
		perform(
			state,
			{
				kind: "add counters",
				target: { type: "permanent", id: bears.id },
				counter: "+1/+1",
				amount: 1,
			},
			agents,
		);
		expect(() => readObject(read, bears.id)).toThrow(/stale ReadContext/);
	});

	test("Clone copies a creature token's actual copiable values", () => {
		const state = newGame();
		const bears = spawnPermanent(state, "grizzly-bears", P1, "battlefield");
		const bearsSnapshot = readObject(createReadContext(state), bears.id);
		expect(bearsSnapshot.kind).toBe("permanent");
		if (bearsSnapshot.kind !== "permanent") return;
		perform(
			state,
			{
				kind: "change zone",
				object: bears.id,
				from: "battlefield",
				to: "graveyard",
				cause: "effect",
				toController: P1,
			},
			agents,
		);
		const tokenValues = structuredClone(bearsSnapshot.copiableValues);
		tokenValues.name = "Test Bear Token";
		spawnToken(state, P1, tokenValues);
		const clone = spawnCard(state, "clone", P1, "hand");
		const result = perform(
			state,
			{
				kind: "change zone",
				object: clone.id,
				from: "hand",
				to: "battlefield",
				cause: "resolve",
				toController: P1,
			},
			agents,
		);
		const copiedId = result.created[0];
		expect(copiedId).toBeDefined();
		if (copiedId === undefined) return;
		const copied = readObject(createReadContext(state), copiedId);
		expect(copied.kind).toBe("permanent");
		if (copied.kind !== "permanent") return;
		expect(copied.copiableValues.name).toBe("Test Bear Token");
		expect(copied.copiableValues).toEqual(tokenValues);
		const copiedObject = state.objects.get(copiedId);
		expect(copiedObject).toBeDefined();
		if (!copiedObject) return;
		expect(physicalCardId(copiedObject)).toBe("clone");
	});

	test("an arbitrary token name never becomes registry identity", () => {
		const state = newGame();
		const arbitraryName = "Definitely Not A Registered Card";
		const token = spawnToken(state, P1, {
			kind: "creature",
			name: arbitraryName,
			manaCost: "zero",
			colors: [],
			supertypes: [],
			types: ["creature"],
			subtypes: ["Test"],
			keywords: [],
			abilities: {
				static: [],
				activated: [],
				triggered: [],
				replacement: [],
				prohibition: [],
			},
			power: 1,
			toughness: 1,
		});

		expect(token.representation).toEqual({
			kind: "token",
			createdValues: expect.objectContaining({ name: arbitraryName }),
		});
		expect(() => buildGameView(state)).not.toThrow();
		expect(buildGameView(state).objects.get(token.id)).toMatchObject({
			kind: "permanent",
			currentCharacteristics: { name: arbitraryName },
		});
		expect(() => view(state, token.id)).not.toThrow();
		expect(view(state, token.id)).toMatchObject({
			name: arbitraryName,
			cardId: null,
		});
		expect(physicalCardId(token)).toBe(null);

		const clone = spawnCard(state, "clone", P1, "hand");
		let result: ReturnType<typeof perform> | undefined;
		expect(() => {
			result = perform(
				state,
				{
					kind: "change zone",
					object: clone.id,
					from: "hand",
					to: "battlefield",
					cause: "resolve",
					toController: P1,
				},
				agents,
			);
		}).not.toThrow();
		expect(result).toBeDefined();
		if (result === undefined) return;
		const copiedId = result.created[0];
		expect(copiedId).toBeDefined();
		if (copiedId === undefined) return;
		expect(view(state, copiedId).name).toBe(arbitraryName);
		expect(physicalCardId(token)).toBe(null);
	});

	test("copy-of-copy keeps effective values and a copied Clone leaves as Clone", () => {
		const state = newGame();
		const ballista = spawnPermanent(
			state,
			"walking-ballista",
			P1,
			"battlefield",
		);
		const firstCard = spawnCard(state, "clone", P1, "hand");
		const firstResult = perform(
			state,
			{
				kind: "change zone",
				object: firstCard.id,
				from: "hand",
				to: "battlefield",
				cause: "resolve",
				toController: P1,
			},
			agents,
		);
		const firstId = firstResult.created[0]!;
		perform(
			state,
			{
				kind: "change zone",
				object: ballista.id,
				from: "battlefield",
				to: "graveyard",
				cause: "effect",
				toController: P1,
			},
			agents,
		);
		const secondCard = spawnCard(state, "clone", P1, "hand");
		const secondResult = perform(
			state,
			{
				kind: "change zone",
				object: secondCard.id,
				from: "hand",
				to: "battlefield",
				cause: "resolve",
				toController: P1,
			},
			agents,
		);
		const first = readObject(createReadContext(state), firstId);
		const second = readObject(
			createReadContext(state),
			secondResult.created[0]!,
		);
		expect(first.kind).toBe("permanent");
		expect(second.kind).toBe("permanent");
		if (first.kind !== "permanent" || second.kind !== "permanent") return;
		expect(second.copiableValues).toEqual(first.copiableValues);

		const leave = perform(
			state,
			{
				kind: "change zone",
				object: firstId,
				from: "battlefield",
				to: "graveyard",
				cause: "effect",
				toController: P1,
			},
			agents,
		);
		const graveyardObject = state.objects.get(leave.created[0]!);
		expect(graveyardObject).toMatchObject({
			kind: "card",
			cardId: "clone",
			zone: "graveyard",
		});
	});

	test("callback-bearing token state is structuredClone and replay safe", async () => {
		const state = newGame();
		const lattice = spawnPermanent(
			state,
			"baby-mycosynth-lattice",
			P1,
			"battlefield",
		);
		const source = readObject(createReadContext(state), lattice.id);
		expect(source.kind).toBe("permanent");
		if (source.kind !== "permanent") return;
		const values = structuredClone(
			source.copiableValues,
		) as CharacteristicsSnapshot;
		perform(
			state,
			{
				kind: "change zone",
				object: lattice.id,
				from: "battlefield",
				to: "graveyard",
				cause: "effect",
				toController: P1,
			},
			agents,
		);
		const bears = spawnPermanent(state, "grizzly-bears", P1, "battlefield");
		const token = spawnToken(state, P1, values);
		expect(values.abilities.static.map(String)).toEqual([
			"baby-mycosynth-lattice:0",
		]);
		expect(physicalCardId(token)).toBe(null);
		expect(view(state, bears.id).types).toContain("artifact");
		expect(() => structuredClone(state)).not.toThrow();
		expect(() => buildGameView(structuredClone(state))).not.toThrow();
		const result = await advanceWithReplay(state, agents);
		expect(result.state.objects.has(token.id)).toBe(true);
	});
});

/**
 * The same split, for the two ability kinds whose runtime collectors used to
 * read the card's definition arrays directly.
 */
const WARD_CARD = "test-collective-ward";
const GRANTED_REPLACEMENT = String(replacementAbilityId(WARD_CARD, 0));
const GRANTED_PROHIBITION = String(prohibitionAbilityId(WARD_CARD, 0));

registerCard({
	id: WARD_CARD,
	name: "Collective Ward",
	types: ["enchantment"],
	colors: ["w"],
	manaCost: { w: 1 },
	replacements: [
		{
			label: "granted:extra-counter",
			layer: "other",
			text: "If one or more +1/+1 counters would be put on this creature, that many plus one are put instead.",
			applies: (ev, ctx) =>
				ctx.self?.zone === "battlefield" &&
				ev.kind === "add counters" &&
				ev.counter === "+1/+1" &&
				ev.target.type === "permanent" &&
				ev.target.id === ctx.self.id,
			replace: (ev) =>
				ev.kind === "add counters" ? [{ ...ev, amount: ev.amount + 1 }] : [ev],
		},
	],
	prohibitions: [
		{
			label: "granted:indestructible",
			text: "This creature can't be destroyed.",
			applies: (ev, ctx) => ev.kind === "destroy" && ev.object === ctx.self?.id,
		},
	],
	statics: [
		{
			layer: "6-ability-changing",
			text: "Creatures you control gain those abilities.",
			applies: (v, _state, source) =>
				source.kind === "permanent" &&
				source.zone === "battlefield" &&
				v.types.includes("creature") &&
				v.controller === source.controller,
			modify: (v) => {
				v.abilities.replacement.push(replacementAbilityId(WARD_CARD, 0));
				v.abilities.prohibition.push(prohibitionAbilityId(WARD_CARD, 0));
			},
		},
	],
	printed: { replacement: [], prohibition: [] },
});

describe("layer 6 ability grants", () => {
	function withInstruction() {
		const state = newGame();
		const instruction = spawnPermanent(state, GRANT_CARD, P1, "battlefield");
		return { state, instruction };
	}

	test("a granted ability reaches current characteristics, never copiable values", () => {
		const { state } = withInstruction();
		const bears = spawnPermanent(state, "grizzly-bears", P1, "battlefield");
		const snapshot = readObject(createReadContext(state), bears.id);
		expect(snapshot.kind).toBe("permanent");
		if (snapshot.kind !== "permanent") return;

		expect(
			snapshot.currentCharacteristics.abilities.activated.map(String),
		).toEqual([GRANTED_ACTIVATED]);
		expect(
			snapshot.currentCharacteristics.abilities.triggered.map(String),
		).toEqual([GRANTED_TRIGGERED]);
		// Layer 1a is finished long before layer 6 runs, so the grant is invisible
		// to anything that copies this creature.
		expect(snapshot.copiableValues.abilities.activated).toEqual([]);
		expect(snapshot.copiableValues.abilities.triggered).toEqual([]);

		// The reference is a plain string that resolves back to the registry.
		const granted = snapshot.currentCharacteristics.abilities.activated[0];
		expect(granted).toBeDefined();
		if (!granted) return;
		expect(resolveActivatedAbility(granted).id).toBe("granted-draw");
		expect(() => structuredClone(state)).not.toThrow();
	});

	test("the grant respects its own condition", () => {
		const { state } = withInstruction();
		const theirs = spawnPermanent(state, "grizzly-bears", P2, "battlefield");
		const mine = spawnPermanent(
			state,
			"baby-mycosynth-lattice",
			P1,
			"battlefield",
		);
		const read = createReadContext(state);

		const theirSnapshot = readObject(read, theirs.id);
		if (theirSnapshot.kind !== "permanent")
			throw new Error("expected permanent");
		expect(theirSnapshot.currentCharacteristics.abilities.activated).toEqual(
			[],
		);

		const noncreature = readObject(read, mine.id);
		if (noncreature.kind !== "permanent") throw new Error("expected permanent");
		expect(noncreature.currentCharacteristics.abilities.activated).toEqual([]);
	});

	test("the granting card hosts the definitions without possessing them", () => {
		expect(COMMUNAL_INSTRUCTION.abilityDefinitions.activated).toHaveLength(1);
		expect(COMMUNAL_INSTRUCTION.abilityDefinitions.triggered).toHaveLength(1);
		expect(COMMUNAL_INSTRUCTION.printedAbilities.activated).toEqual([]);
		expect(COMMUNAL_INSTRUCTION.printedAbilities.triggered).toEqual([]);
		expect(COMMUNAL_INSTRUCTION.printedAbilities.static.map(String)).toEqual([
			GRANT_STATIC,
		]);

		// A definition it does not print still resolves: the registry owns the
		// implementation, `printedAbilities` owns possession.
		expect(resolveTriggeredAbility(triggeredAbilityId(GRANT_CARD, 0)).id).toBe(
			"granted-etb-life",
		);

		const { state, instruction } = withInstruction();
		const snapshot = readObject(createReadContext(state), instruction.id);
		if (snapshot.kind !== "permanent") throw new Error("expected permanent");
		expect(snapshot.currentCharacteristics.abilities.activated).toEqual([]);
		expect(snapshot.currentCharacteristics.abilities.triggered).toEqual([]);
		expect(
			snapshot.currentCharacteristics.abilities.static.map(String),
		).toEqual([GRANT_STATIC]);
	});

	test("a granted trigger fires through its reference", () => {
		const { state } = withInstruction();
		const cadet = spawnCard(state, "eager-cadet", P1, "hand");
		const result = perform(
			state,
			{
				kind: "change zone",
				object: cadet.id,
				from: "hand",
				to: "battlefield",
				cause: "resolve",
				toController: P1,
			},
			agents,
		);
		const entered = result.created[0];
		expect(entered).toBeDefined();
		const pending = state.pendingTriggers.filter((t) => t.source === entered);
		expect(pending.map((t) => String(t.triggerId))).toEqual([
			GRANTED_TRIGGERED,
		]);
		expect(pending[0]?.text).toBe(
			"When this creature enters, you gain 3 life.",
		);
	});

	test("Clone copies the creature, not the grant hanging on it", () => {
		const { state, instruction } = withInstruction();
		spawnPermanent(state, "grizzly-bears", P1, "battlefield");
		const cloneCard = spawnCard(state, "clone", P1, "hand");
		const result = perform(
			state,
			{
				kind: "change zone",
				object: cloneCard.id,
				from: "hand",
				to: "battlefield",
				cause: "resolve",
				toController: P1,
			},
			agents,
		);
		const copiedId = result.created[0];
		expect(copiedId).toBeDefined();
		if (copiedId === undefined) return;

		const copied = readObject(createReadContext(state), copiedId);
		if (copied.kind !== "permanent") throw new Error("expected permanent");
		expect(copied.copiableValues.name).toBe("Grizzly Bears");
		// Clone copies copiable values, and the grant was never part of them.
		expect(copied.copiableValues.abilities.activated).toEqual([]);
		// It is still a creature its controller controls, so the grant applies to
		// it directly — from the instruction, not from the copy.
		expect(
			copied.currentCharacteristics.abilities.activated.map(String),
		).toEqual([GRANTED_ACTIVATED]);

		perform(
			state,
			{
				kind: "change zone",
				object: instruction.id,
				from: "battlefield",
				to: "graveyard",
				cause: "effect",
				toController: P1,
			},
			agents,
		);

		const afterwards = readObject(createReadContext(state), copiedId);
		if (afterwards.kind !== "permanent") throw new Error("expected permanent");
		expect(afterwards.currentCharacteristics.abilities.activated).toEqual([]);
		expect(afterwards.currentCharacteristics.abilities.triggered).toEqual([]);
		expect(afterwards.copiableValues.name).toBe("Grizzly Bears");
		expect(() => structuredClone(state)).not.toThrow();

		// Physical identity is untouched by any of it: the copy is still a Clone
		// card once it leaves the battlefield.
		const left = perform(
			state,
			{
				kind: "change zone",
				object: copiedId,
				from: "battlefield",
				to: "graveyard",
				cause: "effect",
				toController: P1,
			},
			agents,
		);
		expect(state.objects.get(left.created[0]!)).toMatchObject({
			kind: "card",
			cardId: "clone",
			zone: "graveyard",
		});
	});

	test("granted references survive structuredClone and replay", async () => {
		const { state } = withInstruction();
		const bears = spawnPermanent(state, "grizzly-bears", P1, "battlefield");
		const cloned = structuredClone(state);
		const snapshot = readObject(createReadContext(cloned), bears.id);
		if (snapshot.kind !== "permanent") throw new Error("expected permanent");
		expect(
			snapshot.currentCharacteristics.abilities.activated.map(String),
		).toEqual([GRANTED_ACTIVATED]);
		const result = await advanceWithReplay(state, agents);
		expect(result.state.objects.has(bears.id)).toBe(true);
	});
});

describe("granted replacements and prohibitions resolve through references", () => {
	function withWard() {
		const state = newGame();
		const ward = spawnPermanent(state, WARD_CARD, P1, "battlefield");
		const bears = spawnPermanent(state, "grizzly-bears", P1, "battlefield");
		return { state, ward, bears };
	}

	test("the grant shows up as references on the creature, not on the ward", () => {
		const { state, ward, bears } = withWard();
		const read = createReadContext(state);
		const creature = readObject(read, bears.id);
		const source = readObject(read, ward.id);
		if (creature.kind !== "permanent" || source.kind !== "permanent")
			throw new Error("expected permanents");

		expect(
			creature.currentCharacteristics.abilities.replacement.map(String),
		).toEqual([GRANTED_REPLACEMENT]);
		expect(
			creature.currentCharacteristics.abilities.prohibition.map(String),
		).toEqual([GRANTED_PROHIBITION]);
		expect(creature.copiableValues.abilities.replacement).toEqual([]);
		expect(creature.copiableValues.abilities.prohibition).toEqual([]);
		expect(source.currentCharacteristics.abilities.replacement).toEqual([]);
		expect(source.currentCharacteristics.abilities.prohibition).toEqual([]);
	});

	test("a granted replacement is collected and applied", () => {
		const { state, ward, bears } = withWard();
		perform(
			state,
			{
				kind: "add counters",
				target: { type: "permanent", id: bears.id },
				counter: "+1/+1",
				amount: 1,
			},
			agents,
		);
		expect(state.objects.get(bears.id)).toMatchObject({
			counters: { "+1/+1": 2 },
		});

		perform(
			state,
			{
				kind: "change zone",
				object: ward.id,
				from: "battlefield",
				to: "graveyard",
				cause: "effect",
				toController: P1,
			},
			agents,
		);
		perform(
			state,
			{
				kind: "add counters",
				target: { type: "permanent", id: bears.id },
				counter: "+1/+1",
				amount: 1,
			},
			agents,
		);
		expect(state.objects.get(bears.id)).toMatchObject({
			counters: { "+1/+1": 3 },
		});
	});

	test("a granted prohibition is collected and stops the event", () => {
		const { state, ward, bears } = withWard();
		perform(
			state,
			{ kind: "destroy", object: bears.id, noRegen: false },
			agents,
		);
		expect(state.battlefield).toContain(bears.id);

		perform(
			state,
			{
				kind: "change zone",
				object: ward.id,
				from: "battlefield",
				to: "graveyard",
				cause: "effect",
				toController: P1,
			},
			agents,
		);
		perform(
			state,
			{ kind: "destroy", object: bears.id, noRegen: false },
			agents,
		);
		expect(state.battlefield).not.toContain(bears.id);
	});
});
