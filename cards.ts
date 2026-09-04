import type {
	CharacteristicsSnapshot,
	Color,
	CounterBag,
	CounterNames,
	EffectCtx,
	GameEvent,
	ObjectId,
	PlayerId,
	ReadContext,
	ReadonlyGameState,
} from "./index.ts";
import {
	activePlayer,
	cloneCharacteristics,
	etbPreview,
	maybeObject,
	maybePermanent,
	readObject,
	registerCard,
	turnLocation,
} from "./index.ts";
import { assert, assertDefined } from "./lib/assert.ts";

/* ------------------------------------------------------------------ *
 * Helpers for the counter-modifying family
 *
 * The subtle bit: Hardened Scales and Doubling Season apply both to
 * `addCounters` events *and* to counters a permanent is entering with,
 * which live on the zoneChange event. One `applies` has to cover both,
 * or your engine quietly gets Walking Ballista wrong.
 * ------------------------------------------------------------------ */

function eventCounters(ev: GameEvent): CounterBag | null {
	if (ev.kind === "add counters" && ev.target.type === "permanent") {
		return { [ev.counter]: ev.amount };
	}
	if (
		ev.kind === "change zone" &&
		ev.to === "battlefield" &&
		ev.entersWithCounters
	) {
		return ev.entersWithCounters;
	}
	return null;
}

function withCounters(ev: GameEvent, bag: CounterBag): GameEvent[] {
	if (ev.kind === "add counters")
		return [{ ...ev, amount: bag[ev.counter] ?? 0 }];
	if (ev.kind === "change zone") return [{ ...ev, entersWithCounters: bag }];
	return [ev];
}

/** Who will control the object receiving the counters. */
function counterRecipientController(
	state: ReadonlyGameState,
	ev: GameEvent,
): PlayerId | null {
	if (ev.kind === "add counters") {
		if (ev.target.type !== "permanent") return null;
		return maybePermanent(state, ev.target.id)?.controller ?? null;
	}
	if (ev.kind === "change zone" && ev.to === "battlefield")
		return ev.toController;
	return null;
}

function isCreatureRecipient(ctx: EffectCtx, ev: GameEvent): boolean {
	if (ev.kind === "add counters" && ev.target.type === "permanent") {
		const snapshot = readObject(ctx.read, ev.target.id);
		return (
			snapshot.kind === "permanent" &&
			snapshot.currentCharacteristics.types.includes("creature")
		);
	}
	if (ev.kind === "change zone")
		return etbPreview(ctx.state, ev).types.includes("creature");
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
				if (ev.kind !== "change zone") return false;
				if (ev.to !== "battlefield") return false;

				if (!onBattlefield(ctx)) return false;
				if (!ev.entersWithCounters) return false;
				if (!ev.entersWithCounters["+1/+1"]) return false;
				if (ev.entersWithCounters["+1/+1"] === 0) return false;
				if (ev.toController !== ctx.controller) return false;
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
		c: 4,
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
				const bag = { ...eventCounters(ev)! };
				for (const k of Object.keys(bag) as CounterNames[])
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

export const WALKING_BALLISTA = registerCard({
	id: "walking-ballista",
	name: "Walking Ballista",
	types: ["artifact", "creature"],
	subtypes: ["Construct"],
	colors: [],
	manaCost: "zero",
	power: 0,
	toughness: 0,
	// X=2 baked in for the sketch; in a real engine this reads the cost paid.
	entersWith: { "+1/+1": 2 },
});

export const GRIZZLY_BEARS = registerCard({
	id: "grizzly-bears",
	name: "Grizzly Bears",
	types: ["creature"],
	subtypes: ["Bear"],
	colors: ["g"],
	manaCost: {
		g: 1,
		c: 1,
	},
	power: 2,
	toughness: 2,
});

export const EAGER_CADET = registerCard({
	id: "eager-cadet",
	name: "Eager Cadet",
	types: ["creature"],
	subtypes: ["Human", "Soldier"],
	colors: ["w"],
	manaCost: {
		w: 1,
	},
	power: 1,
	toughness: 1,
});

export const DARKSTEEL_MYR = registerCard({
	id: "darksteel-myr",
	name: "Darksteel Myr",
	types: ["artifact", "creature"],
	subtypes: ["Myr"],
	colors: [],
	manaCost: {
		c: 3,
	},
	power: 0,
	toughness: 1,
	keywords: ["indestructible"],
});

export const AJANIS_MANTRA = registerCard({
	id: "ajanis-mantra",
	name: "Ajani's Mantra",
	types: ["enchantment"],
	colors: ["w"],
	manaCost: {
		w: 1,
		c: 1,
	},
	triggers: [
		{
			id: "upkeep-life",
			text: "At the beginning of your upkeep, you may gain 1 life.",
			condition: { kind: "begin step", player: "you", step: "upkeep" },
			effects: [
				{
					kind: "may",
					decider: "you",
					effects: [{ kind: "gain-life", player: "you", amount: 1 }],
				},
			],
		},
	],
});

export const ARASHIN_CLERIC = registerCard({
	id: "arashin-cleric",
	name: "Arashin Cleric",
	types: ["creature"],
	subtypes: ["Human", "Cleric"],
	colors: ["w"],
	manaCost: {
		w: 1,
		c: 1,
	},
	power: 1,
	toughness: 3,
	triggers: [
		{
			id: "etb-life",
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
});

/** Vanilla lifelink — no other abilities, so it exercises lifelink alone. */
export const RHOX_WAR_MONK = registerCard({
	id: "rhox-war-monk",
	name: "Rhox War Monk",
	types: ["creature"],
	subtypes: ["Rhino", "Monk"],
	colors: ["g", "w", "u"],
	manaCost: {
		g: 1,
		w: 1,
		u: 1,
	},
	power: 3,
	toughness: 4,
	keywords: ["lifelink"],
});

export const FOREST = registerCard({
	id: "forest",
	name: "Forest",
	types: ["land"],
	subtypes: ["Forest"],
	colors: [],
	manaCost: "none",
	activatedAbilities: [
		{
			kind: "mana",
			id: "intrinsic-mana-g",
			text: "Add {G}.",
			costs: [{ kind: "tap-self" }],
			effects: [
				{
					kind: "add-mana",
					player: "you",
					mana: { w: 0, u: 0, b: 0, r: 0, g: 1 },
				},
			],
		},
	],
});

export const SAPROLING_TOKEN = registerCard({
	id: "saproling-token",
	name: "Saproling",
	types: ["creature"],
	subtypes: ["Saproling"],
	colors: ["g"],
	manaCost: "none",
	power: 1,
	toughness: 1,
});

/* ------------------------------------------------------------------ *
 * Zone-change replacement — the classic two-hate-cards conflict
 * ------------------------------------------------------------------ */

function goingToGraveyard(ev: GameEvent): boolean {
	return ev.kind === "change zone" && ev.to === "graveyard";
}

export const REST_IN_PEACE = registerCard({
	id: "rest-in-peace",
	name: "Rest in Peace",
	types: ["enchantment"],
	colors: ["w"],
	manaCost: {
		w: 1,
		c: 1,
	},
	replacements: [
		{
			label: "rip",
			layer: "other",
			text: "If a card would be put into a graveyard from anywhere, exile it instead.",
			applies: (ev, ctx) => onBattlefield(ctx) && goingToGraveyard(ev),
			replace: (ev) =>
				ev.kind === "change zone" ? [{ ...ev, to: "exile" }] : [ev],
		},
	],
});

export const LEYLINE_OF_THE_VOID = registerCard({
	id: "leyline-of-the-void",
	name: "Leyline of the Void",
	types: ["enchantment"],
	colors: ["b"],
	manaCost: {
		b: 2,
		c: 2,
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
					ev.to !== "graveyard"
				)
					return false;
				const o = maybeObject(ctx.state, ev.object);
				return !!o && o.owner !== ctx.controller;
			},
			replace: (ev) =>
				ev.kind === "change zone" ? [{ ...ev, to: "exile" }] : [ev],
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
		c: 1,
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

export const NECROPOTENCE = registerCard({
	id: "necropotence",
	name: "Necropotence",
	types: ["enchantment"],
	colors: ["b"],
	manaCost: {
		b: 3,
	},
	replacements: [
		{
			label: "necro:skipdraw",
			layer: "other",
			text: "Skip your draw step.",
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
		c: 1,
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
		c: 4,
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
				if (ev.target.type === "player")
					return ev.target.player === ctx.controller;
				assert(ctx.self);
				return (
					maybePermanent(ctx.state, ev.target.id)?.controller === ctx.controller
				);
			},
			replace(ev, ctx): GameEvent[] {
				if (ev.kind !== "damage") return [ev];
				assert(ctx.self);
				return [{ ...ev, target: { type: "permanent", id: ctx.self.id } }];
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
				src.zone === "battlefield" && !v.types.includes("artifact"),
			modify: (v) => {
				v.types.push("artifact");
			},
		},
	],
});

export const ROOT_MAZE = registerCard({
	id: "root-maze",
	name: "Root Maze",
	types: ["enchantment"],
	colors: ["g"],
	manaCost: {
		g: 1,
	},
	replacements: [
		{
			label: "rootmaze",
			layer: "other",
			text: "Artifacts and lands enter tapped.",
			applies(ev, ctx) {
				if (
					!onBattlefield(ctx) ||
					ev.kind !== "change zone" ||
					ev.to !== "battlefield"
				)
					return false;
				if (ev.entersTapped) return false;
				// Preview, not the printed card: Mycosynth Lattice can make this an artifact.
				const v = etbPreview(ctx.state, ev);
				return v.types.includes("artifact") || v.types.includes("land");
			},
			replace: (ev) =>
				ev.kind === "change zone" ? [{ ...ev, entersTapped: true }] : [ev],
		},
	],
});

/* ------------------------------------------------------------------ *
 * Copy tier (CR 616.1c)
 * ------------------------------------------------------------------ */

export const CLONE = registerCard({
	id: "clone",
	name: "Clone",
	types: ["creature"],
	subtypes: ["Shapeshifter"],
	colors: ["u"],
	manaCost: {
		u: 1,
		c: 3,
	},
	power: 0,
	toughness: 0,
	replacements: [
		{
			label: "clone",
			layer: "copy",
			functionsFrom: "any",
			text: "You may have Clone enter as a copy of any creature on the battlefield.",
			applies: (ev, ctx) =>
				ev.kind === "change zone" &&
				ev.to === "battlefield" &&
				ev.object === ctx.self?.id &&
				ev.copiableOverride === undefined &&
				pickCloneTarget(ctx.read) !== null,
			replace(ev, ctx) {
				if (ev.kind !== "change zone") return [ev];
				const target = pickCloneTarget(ctx.read);
				// The copiable values carry the copied object's ability references,
				// which is the whole of what Clone acquires. No card identity comes
				// along: the Clone stays physically a Clone.
				return target
					? [{ ...ev, copiableOverride: cloneCharacteristics(target) }]
					: [ev];
			},
		},
	],
});

/** Stand-in for a real choice — a policy would pick here. */
function pickCloneTarget(read: ReadContext): CharacteristicsSnapshot | null {
	for (const id of read.state.battlefield) {
		const snapshot = readObject(read, id);
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
		c: 2,
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
		c: 7,
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
/** "Prevent the next N damage that would be dealt to <target> this turn." */
export function preventNextDamageShield(
	target:
		| { type: "player"; player: PlayerId }
		| { type: "permanent"; id: ObjectId },
	n: number,
): { factory: string; params: Record<string, number | string> } {
	return {
		factory: "preventNextDamage",
		params:
			target.type === "player"
				? { targetType: "player", targetPlayer: target.player, amount: n }
				: { targetType: "permanent", targetId: target.id, amount: n },
	};
}

/** Prismatic Strands: prevent all damage sources of the chosen color would deal. */
export function prismaticStrands(color: Color): {
	factory: string;
	params: Record<string, number | string>;
} {
	return { factory: "prismaticStrands", params: { color } };
}

/** "The next time this creature would be destroyed this turn, regenerate it instead." */
export function regenerationShield(target: ObjectId): {
	factory: string;
	params: Record<string, number | string>;
} {
	return { factory: "regenerationShield", params: { target } };
}

/** Gather Specimens — the control-changing tier (CR 616.1b). */
export function gatherSpecimens(you: PlayerId): {
	factory: string;
	params: Record<string, number | string>;
} {
	return { factory: "gatherSpecimens", params: { you } };
}

/* ------------------------------------------------------------------ *
 * A replacement that produces *two* events — the case that forces the
 * pipeline to recurse and to carry the applied-set forward.
 * ------------------------------------------------------------------ */

export const ZOMBIE_TOKEN = registerCard({
	id: "zombie-token",
	name: "Zombie",
	types: ["creature"],
	subtypes: ["Zombie"],
	colors: ["b"],
	manaCost: "none",
	power: 2,
	toughness: 2,
});

export const KALITAS = registerCard({
	id: "kalitas",
	name: "Kalitas, Traitor of Ghet",
	types: ["creature"],
	subtypes: ["Vampire", "Warrior"],
	colors: ["b"],
	manaCost: {
		c: 2,
		b: 2,
	},
	power: 3,
	toughness: 4,
	keywords: ["lifelink"],
	replacements: [
		{
			label: "kalitas",
			layer: "other",
			text: "If a nontoken creature an opponent controls would die, instead exile it and create a 2/2 black Zombie token.",
			applies(ev, ctx) {
				if (!onBattlefield(ctx) || ev.kind !== "change zone") return false;
				if (ev.from !== "battlefield" || ev.to !== "graveyard") return false;
				const o = maybePermanent(ctx.state, ev.object);
				if (!o || o.token || o.controller === ctx.controller) return false;
				const snapshot = readObject(ctx.read, o.id);
				return (
					snapshot.kind === "permanent" &&
					snapshot.currentCharacteristics.types.includes("creature")
				);
			},
			replace(ev, ctx) {
				if (ev.kind !== "change zone") return [ev];
				return [
					{ ...ev, to: "exile" },
					{
						kind: "create token",
						controller: ctx.controller,
						tokenDefinitionId: "zombie-token",
						amount: 1,
					},
				];
			},
		},
	],
});

export const REVITALIZE = registerCard({
	id: "revitalize",
	name: "Revitalize",
	types: ["instant"],
	colors: [],
	manaCost: {
		c: 1,
		w: 1,
	},
	spell: {
		id: "spell-1",
		text: "You gain 3 life. Draw a card.",
		targets: [],
		effects: [
			{ kind: "gain-life", amount: 3, player: "you" },
			{ kind: "draw", amount: 1, player: "you" },
		],
	},
});
