import { registerCardFixture } from "./corpus.ts";
import type {
	CharacteristicsSnapshot,
	Color,
	EffectCtx,
	GameEvent,
	NewTemporaryEffect,
	ObjectId,
	PermanentCounter,
	PermanentCounterBag,
	PlayerId,
	ReadContext,
	ReadonlyGameState,
} from "./index.ts";
import {
	activePlayer,
	cloneCharacteristics,
	etbPreview,
	getSnapshot,
	maybeObject,
	maybePermanent,
	registerCard,
	turnLocation,
} from "./index.ts";
import { assert, assertDefined } from "./lib/assert.ts";

/* ------------------------------------------------------------------ *
 * Cards sourced from the Forge corpus
 *
 * These lower through `forge/import.ts` unchanged, so there is no reason to
 * hand-write them. Everything below this block is still hand-authored only
 * because the importer rejects the real Forge script; each one moves up here
 * as its gap closes, and this file goes away once the list is empty.
 * ------------------------------------------------------------------ */

registerCardFixture("f/forest");
registerCardFixture("g/grizzly_bears");
registerCardFixture("e/eager_cadet");
registerCardFixture("d/darksteel_myr");
registerCardFixture("d/darksteel_relic");
registerCardFixture("f/faithful_watchdog");
registerCardFixture("a/ajanis_mantra");
registerCardFixture("a/arashin_cleric");
registerCardFixture("r/rhox_war_monk");
registerCardFixture("r/root_maze");
registerCardFixture("r/revitalize");
registerCardFixture("v/viscera_seer");
registerCardFixture("b/blazing_hellhound");
registerCardFixture("b/bartolome_del_presidio");
registerCardFixture("a/acolyte_of_aclazotz");
registerCardFixture("c/counterspell");
registerCardFixture("b/beast_whisperer");
registerCardFixture("s/staff_of_the_death_magus");
registerCardFixture("s/student_of_ojutai");
registerCardFixture("t/third_path_iconoclast");
registerCardFixture("c/clone");
registerCardFixture("b/benalish_veteran");
registerCardFixture("z/zof_shade");
registerCardFixture("u/unsummon");
registerCardFixture("i/impulse");
registerCardFixture("s/stock_up");
registerCardFixture("t/thrashing_brontodon");
registerCardFixture("c/cathar_commando");
registerCardFixture("r/resolute_reinforcements");
registerCardFixture("m/monastery_swiftspear");
registerCardFixture("t/thor_odinson");
registerCardFixture("j/jewel_thief");
registerCardFixture("g/gilded_goose");
registerCardFixture("s/sweettooth_witch");
registerCardFixture("b/blood_servitor");

/* ------------------------------------------------------------------ *
 * Helpers for the counter-modifying family
 *
 * The subtle bit: Hardened Scales and Doubling Season apply both to
 * `addCounters` events *and* to counters a permanent is entering with,
 * which live on the zoneChange event. One `applies` has to cover both,
 * or your engine quietly gets Walking Ballista wrong.
 * ------------------------------------------------------------------ */

function eventCounters(ev: GameEvent): PermanentCounterBag | null {
	if (ev.kind === "add counters") {
		return { [ev.counter]: ev.amount };
	}
	if (
		ev.kind === "change zone" &&
		ev.destination.zone === "battlefield" &&
		ev.destination.counters
	) {
		return ev.destination.counters;
	}
	return null;
}

function withCounters(ev: GameEvent, bag: PermanentCounterBag): GameEvent[] {
	if (ev.kind === "add counters")
		return [{ ...ev, amount: bag[ev.counter] ?? 0 }];
	if (ev.kind === "change zone" && ev.destination.zone === "battlefield")
		return [{ ...ev, destination: { ...ev.destination, counters: bag } }];
	return [ev];
}

/** Who will control the object receiving the counters. */
function counterRecipientController(
	state: ReadonlyGameState,
	ev: GameEvent,
): PlayerId | null {
	if (ev.kind === "add counters") {
		return maybePermanent(state, ev.permanent.id)?.controller ?? null;
	}
	if (ev.kind === "change zone" && ev.destination.zone === "battlefield")
		return ev.destination.controller;
	return null;
}

function isCreatureRecipient(ctx: EffectCtx, ev: GameEvent): boolean {
	if (ev.kind === "add counters") {
		const snapshot = getSnapshot(ctx.read, ev.permanent.id);
		return (
			snapshot.kind === "permanent" &&
			snapshot.currentCharacteristics.types.includes("creature")
		);
	}
	if (ev.kind === "change zone" && ev.destination.zone === "battlefield")
		return etbPreview(ctx.state, ev).currentCharacteristics.types.includes(
			"creature",
		);
	return false;
}

function onBattlefield(ctx: EffectCtx): boolean {
	return ctx.self !== null && ctx.self.zone === "battlefield";
}

/* ------------------------------------------------------------------ *
 * Counter modifiers
 * ------------------------------------------------------------------ */

export const HARDENED_SCALES = registerCard({
	id: "hardened-scales",
	name: "Hardened Scales",
	types: ["enchantment"],
	colors: ["g"],
	manaCost: {
		g: 1,
	},
	replacements: [
		{
			label: "scales-counter-place",
			layer: "other",
			text: "If one or more +1/+1 counters would be put on a creature you control, that many plus one are put instead.",
			applies(ev, ctx) {
				if (!onBattlefield(ctx)) return false;
				if (ev.kind !== "add counters") return false;
				if (counterRecipientController(ctx.state, ev) !== ctx.controller)
					return false;
				return isCreatureRecipient(ctx, ev);
			},
			replace(ev) {
				assert(ev.kind === "add counters", "Event should be addCounters");

				const counters = eventCounters(ev);
				assertDefined(counters);
				const bag = { ...eventCounters(ev) };
				bag["+1/+1"] = (bag["+1/+1"] ?? 0) + 1;
				return withCounters(ev, bag);
			},
		},
		{
			label: "scales-counter-enter-with",
			layer: "other",
			text: "If one or more +1/+1 counters would be put on a creature you control, that many plus one are put instead.",
			applies(ev, ctx) {
				if (ev.kind !== "change zone" || ev.destination.zone !== "battlefield")
					return false;

				if (!onBattlefield(ctx)) return false;
				if (!ev.destination.counters) return false;
				if (!ev.destination.counters["+1/+1"]) return false;
				if (ev.destination.counters["+1/+1"] === 0) return false;
				if (ev.destination.controller !== ctx.controller) return false;
				return isCreatureRecipient(ctx, ev);
			},
			replace(ev) {
				assert(ev.kind === "change zone", "Event should be zoneChange");
				const counters = eventCounters(ev);
				assertDefined(counters);
				const bag = { ...eventCounters(ev) };
				bag["+1/+1"] = (bag["+1/+1"] ?? 0) + 1;
				return withCounters(ev, bag);
			},
		},
	],
});

export const DOUBLING_SEASON = registerCard({
	id: "doubling-season",
	name: "Doubling Season",
	types: ["enchantment"],
	colors: ["g"],
	manaCost: {
		g: 1,
		n: 4,
	},
	replacements: [
		{
			label: "season:counters",
			layer: "other",
			text: "If an effect would put counters on a permanent you control, twice that many are put instead.",
			applies(ev, ctx) {
				if (!onBattlefield(ctx)) return false;
				const bag = eventCounters(ev);
				if (!bag || Object.values(bag).every((n) => n <= 0)) return false;
				return counterRecipientController(ctx.state, ev) === ctx.controller;
			},
			replace(ev) {
				const bag = { ...eventCounters(ev) };
				for (const k of Object.keys(bag) as PermanentCounter[])
					bag[k] = (bag[k] ?? 0) * 2;
				return withCounters(ev, bag);
			},
		},
		{
			label: "season:tokens",
			layer: "other",
			text: "If an effect would create tokens under your control, it creates twice that many instead.",
			applies: (ev, ctx) =>
				onBattlefield(ctx) &&
				ev.kind === "create token" &&
				ev.controller === ctx.controller,
			replace: (ev) =>
				ev.kind === "create token" ? [{ ...ev, amount: ev.amount * 2 }] : [ev],
		},
	],
});

/* ------------------------------------------------------------------ *
 * Self-replacement (CR 614.1c / 616.1a)
 * ------------------------------------------------------------------ */

// Not the real Walking Ballista (cards/cardsfolder/w/walking_ballista.txt):
// the real card enters with X counters read from the mana paid and has two
// activated abilities (pay 4 to add a counter; remove a counter to ping).
// Neither is implemented here — this fixture only exercises "enters with a
// fixed number of +1/+1 counters" for CR 614.1c self-replacement tests.
export const TEST_ENTERS_WITH_COUNTERS = registerCard({
	id: "test-enters-with-counters",
	name: "TEST ONLY — Enters With Counters",
	types: ["artifact", "creature"],
	subtypes: ["Construct"],
	colors: [],
	manaCost: "zero",
	power: 0,
	toughness: 0,
	entersWith: { "+1/+1": 2 },
});

export const EXPLORATION = registerCard({
	id: "exploration",
	name: "Exploration",
	types: ["enchantment"],
	colors: ["g"],
	manaCost: { g: 1 },
	statics: [
		{
			kind: "adjust-land-plays",
			text: "You may play an additional land on each of your turns.",
			affects: "you",
			amount: 1,
		},
	],
});

export const AZUSA_LOST_BUT_SEEKING = registerCard({
	id: "azusa-lost-but-seeking",
	name: "Azusa, Lost but Seeking",
	supertypes: ["legendary"],
	types: ["creature"],
	subtypes: ["Human", "Monk"],
	colors: ["g"],
	manaCost: { g: 1, n: 2 },
	power: 1,
	toughness: 2,
	statics: [
		{
			kind: "adjust-land-plays",
			text: "You may play two additional lands on each of your turns.",
			affects: "you",
			amount: 2,
		},
	],
});

export const AESTHIR_GLIDER = registerCard({
	id: "aesthir-glider",
	name: "Aesthir Glider",
	types: ["artifact", "creature"],
	subtypes: ["Bird", "Construct"],
	colors: [],
	manaCost: { n: 3 },
	power: 2,
	toughness: 1,
	keywords: ["flying"],
	statics: [
		{
			kind: "cant-block-self",
			text: "CARDNAME can't block.",
		},
	],
});
/* ------------------------------------------------------------------ *
 * Zone-change replacement — the classic two-hate-cards conflict
 * ------------------------------------------------------------------ */

function goingToGraveyard(ev: GameEvent): boolean {
	return ev.kind === "change zone" && ev.destination.zone === "graveyard";
}

// This is the graveyard-replacement half of Rest in Peace. The real card's
// ETB ability that exiles all graveyards is not implemented yet.
export const BABY_REST_IN_PEACE = registerCard({
	id: "baby-rest-in-peace",
	name: "Baby Rest in Peace",
	types: ["enchantment"],
	colors: ["w"],
	manaCost: {
		w: 1,
		n: 1,
	},
	replacements: [
		{
			label: "rip",
			layer: "other",
			text: "If a card or token would be put into a graveyard from anywhere, exile it instead.",
			applies: (ev, ctx) => onBattlefield(ctx) && goingToGraveyard(ev),
			replace: (ev) =>
				ev.kind === "change zone" && ev.from !== null
					? [{ ...ev, destination: { zone: "exile" } }]
					: [ev],
		},
	],
});

// this only implements the graveyard-replacement half of leyline of the void
// card text; it does not implement the opening-hand ability (the engine has
// no pre-game phase yet).
export const BABY_LEYLINE_OF_THE_VOID = registerCard({
	id: "baby-leyline-of-the-void",
	name: "Baby Leyline of the Void",
	types: ["enchantment"],
	colors: ["b"],
	manaCost: {
		b: 2,
		n: 2,
	},
	replacements: [
		{
			label: "leyline",
			layer: "other",
			text: "If a card would be put into an opponent's graveyard from anywhere, exile it instead.",
			applies(ev, ctx) {
				if (
					!onBattlefield(ctx) ||
					ev.kind !== "change zone" ||
					ev.destination.zone !== "graveyard"
				)
					return false;
				const o = maybeObject(ctx.state, ev.object);
				return !!o && o.owner !== ctx.controller;
			},
			replace: (ev) =>
				ev.kind === "change zone" && ev.from !== null
					? [{ ...ev, destination: { zone: "exile" } }]
					: [ev],
		},
	],
});

/* ------------------------------------------------------------------ *
 * Draw replacement, and the chain that must terminate
 * ------------------------------------------------------------------ */

export const CHAINS_OF_MEPHISTOPHELES = registerCard({
	id: "chains-of-mephistopheles",
	name: "Chains of Mephistopheles",
	types: ["enchantment"],
	colors: ["b"],
	manaCost: {
		b: 1,
		n: 1,
	},
	replacements: [
		{
			label: "chains",
			layer: "other",
			text:
				"If a player would draw a card except the first one they draw in their draw step each turn, " +
				"that player discards a card instead. If the player discards a card this way, they draw a card. " +
				"If the player doesn't discard a card this way, they mill a card.",
			applies(ev, ctx) {
				// If a player would draw a card...
				if (!onBattlefield(ctx) || ev.kind !== "draw") return false;
				const location = turnLocation(ctx.state);
				const inOwnDrawStep =
					location?.kind === "step" &&
					location.step.kind === "draw" &&
					activePlayer(ctx.state) === ev.player;
				const isFirstDrawOfDrawStep =
					inOwnDrawStep && ctx.state.players[ev.player].drawnInDrawStep === 0;
				// except the first draw of the draw step...
				return !isFirstDrawOfDrawStep;
			},
			replace(ev, ctx): GameEvent[] {
				if (ev.kind !== "draw") return [ev];
				const tag = `chains:discarded:${ev.player}:${ctx.rc.depth}:${ctx.rc.applied.size}`;
				return [
					{
						kind: "discard",
						player: ev.player,
						fact: tag,
						cards: { kind: "any" },
					},

					{ kind: "draw", player: ev.player, guard: tag },
					{ kind: "mill", player: ev.player, amount: 1, unless: tag },
				];
			},
		},
	],
});

// Not the real Necropotence (cards/cardsfolder/n/necropotence.txt): the real
// card's defining ability — paying life to exile cards from your library into
// a delayed hand — and its graveyard-exile trigger are both missing. Only the
// "skip your draw step" clause is implemented, which is the card's drawback,
// not its function. This fixture exists to test the "skip" replacement
// pattern (CR 614.10), not to stand in for Necropotence.
export const TEST_SKIP_DRAW_STEP = registerCard({
	id: "test-skip-draw-step",
	name: "TEST ONLY — Skip Draw Step",
	types: ["enchantment"],
	colors: ["b"],
	manaCost: {
		b: 3,
	},
	replacements: [
		{
			label: "skipdraw",
			layer: "other",
			text: "TEST ONLY: skip your draw step.",
			applies: (ev, ctx) =>
				onBattlefield(ctx) &&
				ev.kind === "begin step" &&
				ev.step === "draw" &&
				ev.player === ctx.controller,
			// CR 614.10: "skip" effects replace the event with nothing at all.
			replace: () => [],
		},
	],
});

/* ------------------------------------------------------------------ *
 * Damage: doubling, redirection, prevention
 * ------------------------------------------------------------------ */

export const FURNACE_OF_RATH = registerCard({
	id: "furnace-of-rath",
	name: "Furnace of Rath",
	types: ["enchantment"],
	colors: ["r"],
	manaCost: {
		r: 3,
		n: 1,
	},
	replacements: [
		{
			label: "furnace",
			layer: "other",
			text: "If a source would deal damage to a permanent or player, it deals double that damage instead.",
			applies: (ev, ctx) =>
				onBattlefield(ctx) && ev.kind === "damage" && ev.amount > 0,
			replace: (ev) =>
				ev.kind === "damage" ? [{ ...ev, amount: ev.amount * 2 }] : [ev],
		},
	],
});

export const PALISADE_GIANT = registerCard({
	id: "palisade-giant",
	name: "Palisade Giant",
	types: ["creature"],
	subtypes: ["Giant", "Soldier"],
	colors: ["w"],
	manaCost: {
		w: 2,
		n: 4,
	},
	power: 2,
	toughness: 7,
	replacements: [
		{
			label: "palisade",
			layer: "other",
			text: "All damage that would be dealt to you and other permanents you control is dealt to Palisade Giant instead.",
			applies(ev, ctx) {
				if (!onBattlefield(ctx) || ev.kind !== "damage") return false;
				if (ev.recipient.type === "player")
					return ev.recipient.player === ctx.controller;
				assert(ctx.self);
				return (
					maybePermanent(ctx.state, ev.recipient.id)?.controller ===
					ctx.controller
				);
			},
			replace(ev, ctx): GameEvent[] {
				if (ev.kind !== "damage") return [ev];
				assert(ctx.self);
				return [{ ...ev, recipient: { type: "permanent", id: ctx.self.id } }];
			},
		},
	],
});

/* ------------------------------------------------------------------ *
 * Statics used to exercise CR 614.12 (ETB replacements see the
 * characteristics the permanent *would* have on the battlefield)
 * ------------------------------------------------------------------ */

// this only implements the first half of mycosynth lattice card text.
export const BABY_MYCOSYNTH = registerCard({
	id: "baby-mycosynth-lattice",
	name: "Baby Mycosynth Lattice",
	types: ["artifact"],
	colors: [],
	manaCost: "zero",
	statics: [
		{
			layer: "4-type-changing",
			text: "All permanents are artifacts in addition to their other types.",
			applies: (v, _s, src) =>
				src.zone === "battlefield" &&
				!v.currentCharacteristics.types.includes("artifact"),
			modify: (v) => {
				v.types.push("artifact");
			},
		},
	],
});

/* ------------------------------------------------------------------ *
 * Copy tier (CR 616.1c)
 *
 * TEST_FORCED_COPY is not the real Clone (cards/cardsfolder/c/clone.txt):
 * the real card is optional ("you may") and lets the controller choose which
 * creature to copy. This fixture always copies, and deterministically picks
 * the first creature on the battlefield, so it must never carry Clone's name
 * or card id. Do not import the real Clone under this definition.
 * ------------------------------------------------------------------ */

export const TEST_FORCED_COPY = registerCard({
	id: "test-forced-copy",
	name: "TEST ONLY — Forced Copy",
	types: ["creature"],
	subtypes: ["Shapeshifter"],
	colors: ["u"],
	manaCost: {
		u: 1,
		n: 3,
	},
	power: 0,
	toughness: 0,
	replacements: [
		{
			label: "forced-copy",
			layer: "copy",
			functionsFrom: "any",
			text: "TEST ONLY: unconditionally enters as a copy of the first creature on the battlefield. Not real card text.",
			applies: (ev, ctx) =>
				ev.kind === "change zone" &&
				ev.destination.zone === "battlefield" &&
				ev.object === ctx.self?.id &&
				ev.destination.copiableOverride === undefined &&
				pickForcedCopySource(ctx.read) !== null,
			replace(ev, ctx) {
				if (ev.kind !== "change zone") return [ev];
				const source = pickForcedCopySource(ctx.read);
				// The copiable values carry the copied object's ability references,
				// which is the whole of what this fixture acquires. No card identity
				// comes along: it stays physically this test card.
				return source && ev.destination.zone === "battlefield"
					? [
							{
								...ev,
								destination: {
									...ev.destination,
									copiableOverride: cloneCharacteristics(source),
								},
							},
						]
					: [ev];
			},
		},
	],
});

/** Stand-in for a real choice — a policy would pick here. */
function pickForcedCopySource(
	read: ReadContext,
): CharacteristicsSnapshot | null {
	for (const id of read.state.battlefield) {
		const snapshot = getSnapshot(read, id);
		if (
			snapshot.kind !== "permanent" ||
			!snapshot.currentCharacteristics.types.includes("creature")
		)
			continue;
		return snapshot.copiableValues;
	}
	return null;
}

/* ------------------------------------------------------------------ *
 * Can't lose / alternate win conditions
 * ------------------------------------------------------------------ */

export const LABORATORY_MANIAC = registerCard({
	id: "laboratory-maniac",
	name: "Laboratory Maniac",
	types: ["creature"],
	subtypes: ["Human", "Wizard"],
	colors: ["u"],
	manaCost: {
		u: 1,
		n: 2,
	},
	power: 2,
	toughness: 2,
	replacements: [
		{
			label: "labman:win",
			layer: "other",
			text: "If you would draw a card while your library has no cards in it, you win the game instead of drawing the card.",
			applies(ev, ctx) {
				if (!onBattlefield(ctx) || ev.kind !== "draw") return false;
				if (ev.player !== ctx.controller) return false;
				return ctx.state.players[ev.player]?.library.length === 0;
			},
			replace(ev) {
				if (ev.kind !== "draw") return [ev];
				return [
					{
						kind: "win game",
						player: ev.player,
						reason: "Laboratory Maniac",
					},
				];
			},
		},
	],
});

export const PLATINUM_ANGEL = registerCard({
	id: "platinum-angel",
	name: "Platinum Angel",
	types: ["artifact", "creature"],
	subtypes: ["Angel"],
	colors: [],
	manaCost: {
		n: 7,
	},
	power: 4,
	toughness: 4,
	keywords: ["flying"],
	prohibitions: [
		{
			label: "platinum:lose",
			text: "You can't lose the game.",
			applies: (ev, ctx) =>
				ev.kind === "lose game" && ev.player === ctx.controller,
		},
		{
			label: "platinum:win",
			text: "Your opponents can't win the game.",
			applies: (ev, ctx) =>
				ev.kind === "win game" && ev.player !== ctx.controller,
		},
	],
});
/** "Prevent the next N damage that would be dealt to <recipient> this turn." */
export function preventNextDamageShield(
	recipient:
		| { type: "player"; player: PlayerId }
		| { type: "permanent"; id: ObjectId },
	n: number,
): NewTemporaryEffect {
	return {
		source: {
			origin: "builtin",
			builtin: { kind: "prevent-next-damage", recipient, remaining: n },
		},
		bindings: {},
	};
}

/** Prismatic Strands: prevent all damage sources of the chosen color would deal. */
export function prismaticStrands(color: Color): NewTemporaryEffect {
	return {
		source: {
			origin: "builtin",
			builtin: { kind: "prevent-color-damage", color },
		},
		bindings: {},
	};
}

/** "The next time this creature would be destroyed this turn, regenerate it instead." */
export function regenerationShield(permanent: ObjectId): NewTemporaryEffect {
	return {
		source: {
			origin: "builtin",
			builtin: { kind: "regeneration-shield", permanent, used: false },
		},
		bindings: {},
	};
}

/** Gather Specimens — the control-changing tier (CR 616.1b). */
export function gatherSpecimens(): NewTemporaryEffect {
	return {
		source: {
			origin: "builtin",
			builtin: { kind: "control-entering-creatures" },
		},
		bindings: {},
	};
}

/* ------------------------------------------------------------------ *
 * A replacement that produces *two* events — the case that forces the
 * pipeline to recurse and to carry the applied-set forward.
 *
 * Not the real Kalitas, Traitor of Ghet
 * (cards/cardsfolder/k/kalitas_traitor_of_ghet.txt): this only implements the
 * graveyard-replacement half, which matches the oracle text exactly. The
 * activated ability ("{2}{B}, Sacrifice another Vampire or Zombie: put two
 * +1/+1 counters on Kalitas") is not implemented, since nothing here
 * exercises it.
 * ------------------------------------------------------------------ */

export const TEST_KALITAS_REPLACEMENT = registerCard({
	id: "test-kalitas-replacement",
	name: "TEST ONLY — Kalitas-Style Graveyard Replacement",
	types: ["creature"],
	subtypes: ["Vampire", "Warrior"],
	colors: ["b"],
	manaCost: {
		n: 2,
		b: 2,
	},
	power: 3,
	toughness: 4,
	keywords: ["lifelink"],
	replacements: [
		{
			label: "kalitas-style-replacement",
			layer: "other",
			text: "If a nontoken creature an opponent controls would die, instead exile it and create a 2/2 black Zombie token.",
			applies(ev, ctx) {
				if (!onBattlefield(ctx) || ev.kind !== "change zone") return false;
				if (ev.from !== "battlefield" || ev.destination.zone !== "graveyard")
					return false;
				const o = maybePermanent(ctx.state, ev.object);
				if (!o || o.token || o.controller === ctx.controller) return false;
				const snapshot = getSnapshot(ctx.read, o.id);
				return (
					snapshot.kind === "permanent" &&
					snapshot.currentCharacteristics.types.includes("creature")
				);
			},
			replace(ev, ctx) {
				if (ev.kind !== "change zone" || ev.from === null) return [ev];
				return [
					{ ...ev, destination: { zone: "exile" } },
					{
						kind: "create token",
						controller: ctx.controller,
						amount: 1,
						characteristics: {
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
						},
					},
				];
			},
		},
	],
});
