import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "../agents.ts";
import "../cards.ts"; // side effect: registers the card database
import type {
	CharacteristicsSnapshot,
	GameState,
	ObjectId,
	PlayerId,
	ReadContext,
} from "../index.ts";
import {
	abilityId,
	advanceWithReplay,
	cloneCharacteristics,
	createReadContext,
	newGame,
	perform,
	permanent,
	readObject,
	registerCard,
	spawnCard,
	spawnPermanent,
	spawnToken,
	view,
} from "../index.ts";

const P1 = 0 as PlayerId;
const agents: [ScriptedAgent, ScriptedAgent] = [
	new ScriptedAgent(),
	new ScriptedAgent(),
];

/**
 * An ordinary, hand-written enter-the-battlefield replacement: no
 * `entersTapped` shorthand, no synthesis, and the default `functionsFrom` that a
 * card author would reach for. It only ever fires on the object it is bound to.
 *
 * `applies` is deliberately permissive about the counters already on the
 * event, so the effect would happily fire on its own output. CR 614.5's
 * once-per-event rule is the only thing stopping it, which is what makes
 * "exactly one counter" a meaningful assertion.
 */
const GUARD = "test-entry-guard";
const GUARD_ENTRY = String(abilityId("replacement", GUARD, 0));

registerCard({
	id: GUARD,
	name: "Entry Guard",
	types: ["creature"],
	subtypes: ["Golem"],
	colors: [],
	manaCost: { c: 3 },
	power: 2,
	toughness: 2,
	replacements: [
		{
			label: "entry",
			layer: "other",
			text: "Entry Guard enters tapped and with a +1/+1 counter on it.",
			applies: (ev, ctx) =>
				ev.kind === "change zone" &&
				ev.to === "battlefield" &&
				ev.object === ctx.self?.id,
			replace: (ev) =>
				ev.kind === "change zone"
					? [
							{
								...ev,
								entersTapped: true,
								entersWithCounters: {
									...ev.entersWithCounters,
									"+1/+1": (ev.entersWithCounters?.["+1/+1"] ?? 0) + 1,
								},
							},
						]
					: [ev],
			onApplied: (_ev, ctx) => {
				ctx.data.applications = (ctx.data.applications ?? 0) + 1;
			},
		},
	],
});

/**
 * A Clone whose copy ability carries the *same human label* as Entry Guard's
 * entry replacement, and which also prints its own "enters tapped".
 *
 * Both halves are load-bearing. The shared label proves that effect identity
 * comes from the `cardId:index` reference and not from the label — under label
 * identity the copy tier would consume the copied effect's slot in the
 * once-per-event set. The printed "enters tapped" proves the converse
 * direction of CR 616.1c: once the copy applies, the mimic's *own* entry
 * ability is gone (the Rusted Sentinel / Essence of the Wild ruling).
 */
const MIMIC = "test-mimic";

registerCard({
	id: MIMIC,
	name: "Test Mimic",
	types: ["creature"],
	subtypes: ["Shapeshifter"],
	colors: ["u"],
	manaCost: { u: 1, c: 2 },
	power: 0,
	toughness: 0,
	entersTapped: true,
	replacements: [
		{
			label: "entry",
			layer: "copy",
			functionsFrom: "any",
			text: "Test Mimic enters as a copy of a creature on the battlefield.",
			applies: (ev, ctx) =>
				ev.kind === "change zone" &&
				ev.to === "battlefield" &&
				ev.object === ctx.self?.id &&
				ev.copiableOverride === undefined &&
				firstCreature(ctx.read) !== null,
			replace(ev, ctx) {
				const target = firstCreature(ctx.read);
				return ev.kind === "change zone" && target
					? [{ ...ev, copiableOverride: cloneCharacteristics(target) }]
					: [ev];
			},
		},
	],
});

function firstCreature(read: ReadContext): CharacteristicsSnapshot | null {
	for (const id of read.state.battlefield) {
		const snapshot = readObject(read, id);
		if (
			snapshot.kind === "permanent" &&
			snapshot.currentCharacteristics.types.includes("creature")
		)
			return snapshot.copiableValues;
	}
	return null;
}

/** A vanilla body used as a copy target that contributes no entry effects. */
registerCard({
	id: "test-plain-bear",
	name: "Plain Bear",
	types: ["creature"],
	subtypes: ["Bear"],
	colors: ["g"],
	manaCost: { g: 1, c: 1 },
	power: 2,
	toughness: 2,
});

/** `entersTapped` shorthand, to prove the compiled form copies too. */
registerCard({
	id: "test-rusted-sentinel",
	name: "Rusted Sentinel",
	types: ["artifact", "creature"],
	subtypes: ["Construct"],
	colors: [],
	manaCost: { c: 4 },
	power: 3,
	toughness: 3,
	entersTapped: true,
});

function enter(
	state: GameState,
	object: ObjectId,
	from: "hand" | "battlefield" = "hand",
): ObjectId {
	const result = perform(
		state,
		{
			kind: "change zone",
			object,
			from,
			to: "battlefield",
			cause: "resolve",
			toController: P1,
		},
		agents,
	);
	const created = result.created[0];
	if (created === undefined) throw new Error("nothing entered");
	return created;
}

function leave(state: GameState, object: ObjectId): ObjectId {
	const result = perform(
		state,
		{
			kind: "change zone",
			object,
			from: "battlefield",
			to: "graveyard",
			cause: "effect",
			toController: P1,
		},
		agents,
	);
	const created = result.created[0];
	if (created === undefined) throw new Error("nothing left the battlefield");
	return created;
}

/** Copiable values of a permanent, ready to hand to `spawnToken`. */
function copiableOf(state: GameState, id: ObjectId): CharacteristicsSnapshot {
	const snapshot = readObject(createReadContext(state), id);
	if (snapshot.kind !== "permanent") throw new Error("expected a permanent");
	return structuredClone(snapshot.copiableValues);
}

describe("copied enter-the-battlefield replacements", () => {
	test("a copy executes the copied card's own explicit ETB replacement", () => {
		const state = newGame();
		spawnPermanent(state, GUARD, P1);
		const clone = spawnCard(state, "clone", P1, "hand");

		const entered = enter(state, clone.id);
		const copy = permanent(state, entered);

		expect(view(state, entered).name).toBe("Entry Guard");
		// The replacement reached the event during the Clone's own entry, not
		// afterwards: both fields are written by `moveObject`, not by any later
		// mutation.
		expect(copy.tapped, "copied ETB replacement tapped it").toBe(true);
		expect(copy.counters["+1/+1"], "and gave it exactly one counter").toBe(1);
	});

	test("the copied replacement is acquired as a reference, not a card lookup", () => {
		const state = newGame();
		spawnPermanent(state, GUARD, P1);
		const clone = spawnCard(state, "clone", P1, "hand");
		const entered = enter(state, clone.id);

		const snapshot = readObject(createReadContext(state), entered);
		if (snapshot.kind !== "permanent") throw new Error("expected a permanent");
		expect(
			snapshot.copiableValues.abilities.replacement.map(String),
			"possession travelled on the copy snapshot",
		).toEqual([GUARD_ENTRY]);
		// Physical identity never moved with it.
		expect(snapshot.representation).toEqual({ kind: "card", cardId: "clone" });
	});

	test("a copy of a card entering under its own ETB replacement is unaffected", () => {
		const state = newGame();
		const guard = spawnCard(state, GUARD, P1, "hand");
		const entered = enter(state, guard.id);
		const self = permanent(state, entered);
		expect(self.tapped).toBe(true);
		expect(self.counters["+1/+1"]).toBe(1);
	});

	test("copied entersTapped and entersWith work with no copied card identity", () => {
		const tapped = newGame();
		spawnPermanent(tapped, "test-rusted-sentinel", P1);
		const sentinelCopy = permanent(
			tapped,
			enter(tapped, spawnCard(tapped, "clone", P1, "hand").id),
		);
		expect(view(tapped, sentinelCopy.id).name).toBe("Rusted Sentinel");
		expect(sentinelCopy.tapped, "copied entersTapped applied").toBe(true);
		expect(sentinelCopy.representation, "still physically a Clone").toEqual({
			kind: "card",
			cardId: "clone",
		});

		const counters = newGame();
		spawnPermanent(counters, "walking-ballista", P1);
		const ballistaCopy = permanent(
			counters,
			enter(counters, spawnCard(counters, "clone", P1, "hand").id),
		);
		expect(view(counters, ballistaCopy.id).name).toBe("Walking Ballista");
		expect(ballistaCopy.counters["+1/+1"], "copied entersWith applied").toBe(2);
	});

	test("the copy replaces entry abilities rather than adding to them", () => {
		// CR 616.1c, quoted in the engine: a Rusted Sentinel that enters as a copy
		// of something else no longer has the ability that taps it.
		const state = newGame();
		spawnPermanent(state, "test-plain-bear", P1);
		const mimic = spawnCard(state, MIMIC, P1, "hand");
		const entered = permanent(state, enter(state, mimic.id));

		expect(view(state, entered.id).name).toBe("Plain Bear");
		expect(entered.tapped, "the mimic's own entersTapped was copied away").toBe(
			false,
		);

		// Without a copy target it keeps its own printed entry ability.
		const alone = newGame();
		const solo = spawnCard(alone, MIMIC, P1, "hand");
		expect(permanent(alone, enter(alone, solo.id)).tapped).toBe(true);
	});

	test("effect identity is the ability reference, not the human label", () => {
		// The mimic's copy ability and Entry Guard's entry ability share the label
		// "entry". Under label-keyed identity the copy would consume the entry
		// effect's once-per-event slot and the counter would never be placed.
		const state = newGame();
		spawnPermanent(state, GUARD, P1);
		const mimic = spawnCard(state, MIMIC, P1, "hand");
		const entered = permanent(state, enter(state, mimic.id));

		expect(view(state, entered.id).name).toBe("Entry Guard");
		expect(entered.tapped).toBe(true);
		expect(entered.counters["+1/+1"], "applied exactly once").toBe(1);
	});

	test("effect data is keyed by ability reference and not shared between cards", () => {
		const state = newGame();
		const guard = spawnPermanent(state, GUARD, P1);
		spawnCard(state, MIMIC, P1, "hand");
		enter(state, spawnCard(state, "clone", P1, "hand").id);

		expect(Object.keys(guard.effectData)).toEqual([GUARD_ENTRY]);
		for (const object of state.objects.values()) {
			for (const key of Object.keys(object.effectData)) {
				expect(key, "effect data slots are cardId:index references").toMatch(
					/^[^:]+:\d+$/,
				);
			}
		}
	});
});

describe("copied entry replacements across tokens and copy chains", () => {
	test("a token copy carries the entry replacement to the next copy", () => {
		const state = newGame();
		const guard = spawnPermanent(state, GUARD, P1);
		const values = copiableOf(state, guard.id);
		values.name = "Guard Token";
		leave(state, guard.id);
		const token = spawnToken(state, P1, values);
		expect(token.representation.kind).toBe("token");

		const entered = permanent(
			state,
			enter(state, spawnCard(state, "clone", P1, "hand").id),
		);
		expect(view(state, entered.id).name).toBe("Guard Token");
		expect(entered.tapped).toBe(true);
		expect(entered.counters["+1/+1"]).toBe(1);
	});

	test("a token that is itself a copy still runs its own entry replacement", () => {
		const state = newGame();
		const guard = spawnPermanent(state, GUARD, P1);
		const values = copiableOf(state, guard.id);
		leave(state, guard.id);
		// Tokens are put onto the battlefield directly rather than through a zone
		// change, so nothing here should have entered tapped.
		const token = spawnToken(state, P1, values);
		expect(permanent(state, token.id).tapped).toBe(false);
	});

	test("copy of a copy keeps the same-event entry behavior", () => {
		const state = newGame();
		const guard = spawnPermanent(state, GUARD, P1);
		const first = enter(state, spawnCard(state, "clone", P1, "hand").id);
		expect(permanent(state, first).counters["+1/+1"]).toBe(1);

		// Remove the original so the second Clone can only see the copy.
		leave(state, guard.id);
		const second = enter(state, spawnCard(state, "clone", P1, "hand").id);

		expect(view(state, second).name).toBe("Entry Guard");
		expect(permanent(state, second).tapped).toBe(true);
		expect(permanent(state, second).counters["+1/+1"]).toBe(1);
		const read = createReadContext(state);
		const a = readObject(read, first);
		const b = readObject(read, second);
		if (a.kind !== "permanent" || b.kind !== "permanent")
			throw new Error("expected permanents");
		expect(b.copiableValues).toEqual(a.copiableValues);
	});
});

describe("physical identity and serialization of copied entry replacements", () => {
	test("a copied Clone is still a Clone card in the graveyard", () => {
		const state = newGame();
		spawnPermanent(state, GUARD, P1);
		const entered = enter(state, spawnCard(state, "clone", P1, "hand").id);
		expect(view(state, entered).name).toBe("Entry Guard");

		const inGraveyard = leave(state, entered);
		expect(state.objects.get(inGraveyard)).toMatchObject({
			kind: "card",
			cardId: "clone",
			zone: "graveyard",
		});
	});

	test("state with copied entry replacements is structuredClone and replay safe", async () => {
		const state = newGame();
		spawnPermanent(state, GUARD, P1);
		const entered = enter(state, spawnCard(state, "clone", P1, "hand").id);

		expect(() => structuredClone(state)).not.toThrow();
		const roundTripped = structuredClone(state);
		const snapshot = readObject(createReadContext(roundTripped), entered);
		if (snapshot.kind !== "permanent") throw new Error("expected a permanent");
		expect(snapshot.copiableValues.abilities.replacement.map(String)).toEqual([
			GUARD_ENTRY,
		]);

		const replayed = await advanceWithReplay(state, agents);
		expect(replayed.state.objects.has(entered)).toBe(true);
	});
});
