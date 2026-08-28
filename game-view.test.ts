import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "./agents.ts";
import "./cards.ts";
import {
	advanceWithReplay,
	buildGameView,
	createReadContext,
	newGame,
	perform,
	readObject,
	registerCard,
	resolveStaticAbility,
	spawnCard,
	spawnPermanent,
	spawnToken,
	staticAbilityId,
	type CharacteristicsSnapshot,
	type PlayerId,
} from "./index.ts";

const P1 = 0 as PlayerId;
const agents: [ScriptedAgent, ScriptedAgent] = [
	new ScriptedAgent(),
	new ScriptedAgent(),
];

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
		expect(resolveStaticAbility(snapshot.copiableValues.abilities.static[0]!)).toBeDefined();
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
		spawnToken(state, P1, tokenValues, "grizzly-bears");
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
		expect(copied.copiableValues.name).toBe("Test Bear Token");
		expect(copied.copiableValues).toEqual(tokenValues);
	});

	test("copy-of-copy keeps effective values and a copied Clone leaves as Clone", () => {
		const state = newGame();
		const ballista = spawnPermanent(state, "walking-ballista", P1, "battlefield");
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
		const second = readObject(createReadContext(state), secondResult.created[0]!);
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
		const token = spawnToken(state, P1, values, "baby-mycosynth-lattice");
		expect(values.abilities.static.map(String)).toEqual([
			"baby-mycosynth-lattice:0",
		]);
		expect(() => structuredClone(state)).not.toThrow();
		expect(() => buildGameView(structuredClone(state))).not.toThrow();
		const result = await advanceWithReplay(state, agents);
		expect(result.state.objects.has(token.id)).toBe(true);
	});
});
