import type {
	Color,
	CounterBag,
	CounterNames,
	EffectCtx,
	GameEvent,
	GameState,
	ObjectId,
	PlayerId,
} from "./index.ts";
import {
	etbPreview,
	maybeObject,
	maybePermanent,
	registerCard,
	view,
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
	if (ev.kind === "addCounters" && ev.target.type === "permanent") {
		return { [ev.counter]: ev.amount };
	}
	if (
		ev.kind === "zoneChange" &&
		ev.to === "battlefield" &&
		ev.entersWithCounters
	) {
		return ev.entersWithCounters;
	}
	return null;
}

function withCounters(ev: GameEvent, bag: CounterBag): GameEvent[] {
	if (ev.kind === "addCounters")
		return [{ ...ev, amount: bag[ev.counter] ?? 0 }];
	if (ev.kind === "zoneChange") return [{ ...ev, entersWithCounters: bag }];
	return [ev];
}

/** Who will control the object receiving the counters. */
function counterRecipientController(
	state: GameState,
	ev: GameEvent,
): PlayerId | null {
	if (ev.kind === "addCounters") {
		if (ev.target.type !== "permanent") return null;
		return maybePermanent(state, ev.target.id)?.controller ?? null;
	}
	if (ev.kind === "zoneChange" && ev.to === "battlefield")
		return ev.toController;
	return null;
}

function isCreatureRecipient(state: GameState, ev: GameEvent): boolean {
	if (ev.kind === "addCounters" && ev.target.type === "permanent") {
		const o = maybePermanent(state, ev.target.id);
		return !!o && view(state, o.id).types.includes("creature");
	}
	if (ev.kind === "zoneChange")
		return etbPreview(state, ev).types.includes("creature");
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
	mv: 1,
	replacements: [
		{
			label: "scales-counter-place",
			layer: "other",
			text: "If one or more +1/+1 counters would be put on a creature you control, that many plus one are put instead.",
			applies(ev, ctx) {
				if (!onBattlefield(ctx)) return false;
				if (ev.kind !== "addCounters") return false;
				if (counterRecipientController(ctx.state, ev) !== ctx.controller)
					return false;
				return isCreatureRecipient(ctx.state, ev);
			},
			replace(ev) {
				assert(ev.kind === "addCounters", "Event should be addCounters");

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
				if (ev.kind !== "zoneChange") return false;
				if (ev.to !== "battlefield") return false;

				if (!onBattlefield(ctx)) return false;
				if (!ev.entersWithCounters) return false;
				if (!ev.entersWithCounters["+1/+1"]) return false;
				if (ev.entersWithCounters["+1/+1"] === 0) return false;
				if (ev.toController !== ctx.controller) return false;
				return isCreatureRecipient(ctx.state, ev);
			},
			replace(ev) {
				assert(ev.kind === "zoneChange", "Event should be zoneChange");
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
	mv: 5,
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
				ev.kind === "createToken" &&
				ev.controller === ctx.controller,
			replace: (ev) =>
				ev.kind === "createToken" ? [{ ...ev, amount: ev.amount * 2 }] : [ev],
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
	mv: 0,
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
	mv: 2,
	power: 2,
	toughness: 2,
});

export const EAGER_CADET = registerCard({
	id: "eager-cadet",
	name: "Eager Cadet",
	types: ["creature"],
	subtypes: ["Human", "Soldier"],
	colors: ["w"],
	mv: 1,
	power: 1,
	toughness: 1,
});

export const DARKSTEEL_MYR = registerCard({
	id: "darksteel-myr",
	name: "Darksteel Myr",
	types: ["artifact", "creature"],
	subtypes: ["Myr"],
	colors: [],
	mv: 3,
	power: 0,
	toughness: 1,
	keywords: ["indestructible"],
});

export const AJANIS_MANTRA = registerCard({
	id: "ajanis-mantra",
	name: "Ajani's Mantra",
	types: ["enchantment"],
	colors: ["w"],
	mv: 2,
	triggers: [
		{
			id: "upkeep-life",
			text: "At the beginning of your upkeep, you may gain 1 life.",
			condition: { kind: "beginStep", step: "upkeep", player: "controller" },
			optional: true,
			effects: [{ kind: "gainLife", player: "controller", amount: 1 }],
		},
	],
});

export const ARASHIN_CLERIC = registerCard({
	id: "arashin-cleric",
	name: "Arashin Cleric",
	types: ["creature"],
	subtypes: ["Human", "Cleric"],
	colors: ["w"],
	mv: 2,
	power: 1,
	toughness: 3,
	triggers: [
		{
			id: "etb-life",
			text: "When this creature enters, you gain 3 life.",
			condition: { kind: "entersBattlefield", object: "self" },
			effects: [{ kind: "gainLife", player: "controller", amount: 3 }],
		},
	],
});

/** STUB: dies triggers are not yet supported. */
export const OUTLAW_MEDIC = registerCard({
	id: "outlaw-medic",
	name: "Outlaw Medic",
	types: ["creature"],
	subtypes: ["Human", "Rogue"],
	colors: ["w"],
	mv: 2,
	power: 1,
	toughness: 3,
	keywords: ["lifelink"],
	triggers: [
		// "When this creature dies, draw a card."
	],
});

export const FOREST = registerCard({
	id: "forest",
	name: "Forest",
	types: ["land"],
	subtypes: ["Forest"],
	colors: [],
	mv: 0,
});

export const SAPROLING_TOKEN = registerCard({
	id: "saproling-token",
	name: "Saproling",
	types: ["creature"],
	subtypes: ["Saproling"],
	colors: ["g"],
	mv: 0,
	power: 1,
	toughness: 1,
});

/* ------------------------------------------------------------------ *
 * Zone-change replacement — the classic two-hate-cards conflict
 * ------------------------------------------------------------------ */

function goingToGraveyard(ev: GameEvent): boolean {
	return ev.kind === "zoneChange" && ev.to === "graveyard";
}

export const REST_IN_PEACE = registerCard({
	id: "rest-in-peace",
	name: "Rest in Peace",
	types: ["enchantment"],
	colors: ["w"],
	mv: 2,
	replacements: [
		{
			label: "rip",
			layer: "other",
			text: "If a card would be put into a graveyard from anywhere, exile it instead.",
			applies: (ev, ctx) => onBattlefield(ctx) && goingToGraveyard(ev),
			replace: (ev) =>
				ev.kind === "zoneChange" ? [{ ...ev, to: "exile" }] : [ev],
		},
	],
});

export const LEYLINE_OF_THE_VOID = registerCard({
	id: "leyline-of-the-void",
	name: "Leyline of the Void",
	types: ["enchantment"],
	colors: ["b"],
	mv: 4,
	replacements: [
		{
			label: "leyline",
			layer: "other",
			text: "If a card would be put into an opponent's graveyard from anywhere, exile it instead.",
			applies(ev, ctx) {
				if (
					!onBattlefield(ctx) ||
					ev.kind !== "zoneChange" ||
					ev.to !== "graveyard"
				)
					return false;
				const o = maybeObject(ctx.state, ev.object);
				return !!o && o.owner !== ctx.controller;
			},
			replace: (ev) =>
				ev.kind === "zoneChange" ? [{ ...ev, to: "exile" }] : [ev],
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
	mv: 2,
	replacements: [
		{
			label: "chains",
			layer: "other",
			text:
				"If a player would draw a card except the first one they draw in their draw step each turn, " +
				"that player discards a card instead. If the player discards a card this way, they draw a card.",
			applies(ev, ctx) {
				if (!onBattlefield(ctx) || ev.kind !== "draw") return false;
				const inOwnDrawStep =
					ctx.state.step === "draw" && ctx.state.activePlayer === ev.player;
				const isFirstDrawOfDrawStep =
					inOwnDrawStep && ctx.state.players[ev.player].drawnInDrawStep === 0;
				return !isFirstDrawOfDrawStep;
			},
			replace(ev, ctx): GameEvent[] {
				if (ev.kind !== "draw") return [ev];
				const tag = `chains:discarded:${ev.player}:${ctx.state.nextTag++}`;
				return [
					{
						kind: "discard",
						player: ev.player,
						fact: tag,
						cards: { kind: "any" },
					},
					// "If the player discards a card this way" — the guard makes the second
					// half conditional without smuggling a closure into the event.
					{ kind: "draw", player: ev.player, guard: tag },
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
	mv: 3,
	replacements: [
		{
			label: "necro:skipdraw",
			layer: "other",
			text: "Skip your draw step.",
			applies: (ev, ctx) =>
				onBattlefield(ctx) &&
				ev.kind === "beginStep" &&
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
	mv: 4,
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
	subtypes: ["Giant", "Wall"],
	colors: ["w"],
	mv: 6,
	power: 2,
	toughness: 6,
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

export const MYCOSYNTH_LATTICE = registerCard({
	id: "mycosynth-lattice",
	name: "Mycosynth Lattice",
	types: ["artifact"],
	colors: [],
	mv: 6,
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
	mv: 2,
	replacements: [
		{
			label: "rootmaze",
			layer: "other",
			text: "Artifacts and lands enter tapped.",
			applies(ev, ctx) {
				if (
					!onBattlefield(ctx) ||
					ev.kind !== "zoneChange" ||
					ev.to !== "battlefield"
				)
					return false;
				if (ev.entersTapped) return false;
				// Preview, not the printed card: Mycosynth Lattice can make this an artifact.
				const v = etbPreview(ctx.state, ev);
				return v.types.includes("artifact") || v.types.includes("land");
			},
			replace: (ev) =>
				ev.kind === "zoneChange" ? [{ ...ev, entersTapped: true }] : [ev],
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
	mv: 4,
	power: 0,
	toughness: 0,
	replacements: [
		{
			label: "clone",
			layer: "copy",
			functionsIn: ["any"],
			text: "You may have Clone enter as a copy of any creature on the battlefield.",
			applies: (ev, ctx) =>
				ev.kind === "zoneChange" &&
				ev.to === "battlefield" &&
				ev.object === ctx.self?.id &&
				ev.copyOf === undefined &&
				pickCloneTarget(ctx.state, ctx.controller) !== null,
			replace(ev, ctx) {
				if (ev.kind !== "zoneChange") return [ev];
				const target = pickCloneTarget(ctx.state, ctx.controller);
				return [{ ...ev, copyOf: target ?? undefined }];
			},
		},
	],
});

/** Stand-in for a real choice — a policy would pick here. */
function pickCloneTarget(
	state: GameState,
	_controller: PlayerId,
): string | null {
	for (const id of state.battlefield) {
		const v = view(state, id);
		if (v.types.includes("creature")) return v.cardId;
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
	mv: 3,
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
						kind: "winGame",
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
	mv: 7,
	power: 4,
	toughness: 4,
	keywords: ["flying"],
	prohibitions: [
		{
			label: "platinum:lose",
			text: "You can't lose the game.",
			applies: (ev, ctx) =>
				ev.kind === "loseGame" && ev.player === ctx.controller,
		},
		{
			label: "platinum:win",
			text: "Your opponents can't win the game.",
			applies: (ev, ctx) =>
				ev.kind === "winGame" && ev.player !== ctx.controller,
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
	mv: 0,
	power: 2,
	toughness: 2,
});

export const KALITAS = registerCard({
	id: "kalitas",
	name: "Kalitas, Traitor of Ghet",
	types: ["creature"],
	subtypes: ["Vampire", "Warrior"],
	colors: ["b"],
	mv: 4,
	power: 3,
	toughness: 4,
	keywords: ["lifelink"],
	replacements: [
		{
			label: "kalitas",
			layer: "other",
			text: "If a nontoken creature an opponent controls would die, instead exile it and create a 2/2 black Zombie token.",
			applies(ev, ctx) {
				if (!onBattlefield(ctx) || ev.kind !== "zoneChange") return false;
				if (ev.from !== "battlefield" || ev.to !== "graveyard") return false;
				const o = maybePermanent(ctx.state, ev.object);
				if (!o || o.token || o.controller === ctx.controller) return false;
				return view(ctx.state, o.id).types.includes("creature");
			},
			replace(ev, ctx) {
				if (ev.kind !== "zoneChange") return [ev];
				return [
					{ ...ev, to: "exile" },
					{
						kind: "createToken",
						controller: ctx.controller,
						cardId: "zombie-token",
						amount: 1,
					},
				];
			},
		},
	],
});
