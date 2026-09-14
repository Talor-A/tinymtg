/**
 * forge-import.ts — the strict Forge-to-engine bridge.
 *
 *     External Forge text
 *       -> parseForgeCardScript(text).card       Forge-owned syntax/references
 *       -> lowerForgeCard(ast, { id })           supported semantic subset
 *       -> CardDefInput -> defineCard(input)      engine-owned definitions
 *
 * Neither `lowerForgeCard` nor `importForgeCard` touches game state. A rejected
 * card exposes no partially-usable `CardDef`: `ok: false`
 * carries only diagnostics.
 *
 * This module accounts for every root rule (`A`, `T`, `R`, `S`, `K`) on a card
 * or rejects the whole card; it does not claim full Magic rules coverage. Only
 * the concrete subset documented in the acceptance matrix in README.md lowers.
 *
 * Deferred / explicitly unsupported (each rejects rather than approximating):
 * `ChangeZone` searches other than a single card from a library, hidden Hand
 * origins and Stack origins; multi-object movement other than the exact
 * shuffle-into-library forms documented below; random or multi-card discard;
 * alternate spell costs; additional spell costs other than one permanent
 * sacrifice and/or one-card discard; activation costs other than fixed
 * generic/coloured mana, tap-self, one permanent sacrifice, and one-card
 * discard; X/colorless/hybrid/Phyrexian/snow mana
 * and dynamic amounts; `Investigate` with an explicit count or player;
 * more than one target slot,
 * or an optional one; selector modifiers outside
 * `Other`/`YouCtrl`/`OppCtrl`/`YouOwn`/`OppOwn`, the exact
 * target form `Creature.Other+YouCtrl`, and `non`-prefixable color, card type,
 * and supertype words (so hexproof, shroud,
 * protection, and combat- or zone-dependent restrictions all reject, while a
 * subtype is only readable as a selector's base); more than one spell ability, or a
 * spell ability on a permanent card; conditions, alternate "unless" costs, or
 * new target declarations on a `SubAbility`/`Execute` continuation;
 * alternate/specialize faces, `Variant:` patches, and `Draft:` actions; and any
 * `Card.Self`-containing selector inside a global (`ActiveZones$`) replacement
 * (see `lowerReplacement`).
 */

import assert from "node:assert/strict";
import type {
	ActivatedEffectDef,
	ActivationCost,
	AdditionalCosts,
	AnyActivatedAbilityDefinition,
	CardDef,
	CardDefInput,
	CardType,
	CharacteristicsSnapshot,
	Color,
	EffectDef,
	EffectPlayerSubject,
	GameEvent,
	Keyword,
	ManaCostType,
	ManaPool,
	ManaType,
	ObjectPredicateDef,
	PayableActivationManaCost,
	PublicObjectZone,
	RelativeEffectPlayer,
	ReplacementEffectDefinition,
	SpellAbilityDef,
	StaticAbilityDefinition,
	Supertype,
	TargetDef,
	TargetEffectRef,
	TriggerEffectPlayer,
	TriggeredAbilityDefinition,
	TriggeringZoneChangeResultEffectRef,
	ValidPlayer,
	Zone,
	ZoneChangeEffectDestination,
} from "../index.ts";
import {
	abilityId,
	characteristicsFromCardDef,
	cloneCharacteristics,
	defineCard,
	effectTargetUses,
	getSnapshot,
	MANA_COST_TYPES,
	objectMatchesPredicate,
	targetSelectorSatisfies,
} from "../index.ts";
import { assertDefined } from "../lib/assert.ts";
import { CLUE_TOKEN } from "../tokens.ts";
import type {
	ForgeAbilityRecord,
	ForgeCardAst,
	ForgeFaceAst,
	ForgeKeywordRecord,
	ForgeParamList,
	ForgeSVarRecord,
} from "./ast.ts";
import {
	forgeAbilityDiscriminator,
	getForgeParam,
	lookupForgeSVar,
	parseForgeCardScript,
} from "./ast.ts";
import { forgeTokenScript } from "./token-corpus.ts";

interface Ok<T> {
	ok: true;
	value: T;
}

function ok<T>(value: T): Ok<T> {
	return { ok: true, value };
}

function err<E>(error: E): Err<E> {
	return { ok: false, error };
}

interface Err<E> {
	ok: false;
	error: E;
}

type Result<T, E> = Ok<T> | Err<E>;

export interface ImportIssue {
	code: string;
	message: string;
	nodeId?: string;
	line?: number;
	paramId?: string;
}

export type ImportResult =
	| { ok: true; card: CardDef; diagnostics: [] }
	| { ok: false; diagnostics: [ImportIssue, ...ImportIssue[]] };

function issue(
	code: string,
	message: string,
	extra: { nodeId?: string; line?: number; paramId?: string } = {},
): Err<ImportIssue> {
	return err({ code, message, ...extra });
}

function reject(i: ImportIssue | Err<ImportIssue>): {
	ok: false;
	diagnostics: [ImportIssue];
} {
	if ("ok" in i) return { ok: false, diagnostics: [i.error] };
	return { ok: false, diagnostics: [i] };
}

/* ------------------------------------------------------------------------- */
/* Small lookup tables. Only the forms below are supported; everything else  */
/* is data that the lowering rules reject explicitly.                        */
/* ------------------------------------------------------------------------- */

// Keyed by the lower-cased word a card script writes, so a lookup both tests
// membership and produces the engine's value. `Map`, not a plain object, for
// the same prototype reason as COLOR_WORDS below.
const CARD_TYPES = new Map<string, CardType>([
	["artifact", "artifact"],
	["creature", "creature"],
	["enchantment", "enchantment"],
	["instant", "instant"],
	["land", "land"],
	["planeswalker", "planeswalker"],
	["sorcery", "sorcery"],
]);
const SUPERTYPES = new Map<string, Supertype>([
	["basic", "basic"],
	["legendary", "legendary"],
	["snow", "snow"],
]);
/**
 * The public zones an object can be moved out of, activated from, or targeted
 * in. Hidden zones (`Hand`, `Library`) and `Stack` are deliberately absent:
 * a lookup that misses is a rejection.
 */
const PUBLIC_ZONES = new Map<string, PublicObjectZone>([
	["Battlefield", "battlefield"],
	["Graveyard", "graveyard"],
	["Exile", "exile"],
]);
/**
 * Where a permanent that leaves the battlefield can end up. Forge writes an
 * unrestricted destination as `Any`, which matches every departure.
 *
 * `Ante` and `Command` are absent because the engine has no such zone, so a
 * lookup that misses rejects the trigger.
 */
const BATTLEFIELD_DEPARTURES = new Map<string, Zone | "any">([
	["Any", "any"],
	["Graveyard", "graveyard"],
	["Exile", "exile"],
	["Hand", "hand"],
	["Library", "library"],
]);
// `Map`, not a plain object: an object literal's lookups fall through to
// `Object.prototype` (`obj["constructor"]` resolves to `Function`), and every
// key here comes straight from untrusted card text.
const COLOR_WORDS = new Map<string, Color>([
	["w", "w"],
	["white", "w"],
	["u", "u"],
	["blue", "u"],
	["b", "b"],
	["black", "b"],
	["r", "r"],
	["red", "r"],
	["g", "g"],
	["green", "g"],
]);
/**
 * The fixed symbols accepted in `Produced$` values. Colorless belongs here but
 * never in {@link COLOR_WORDS}: `Produced$ C` makes colorless mana, while a
 * card producing it is not thereby any color. A space-separated list of these
 * symbols produces every listed symbol. `Combo` followed by two or more
 * distinct fixed symbols is a modal choice of exactly one of them; `Any` is
 * the five colored choices. Variables, dynamic amounts, and other forms reject.
 */
const PRODUCED_MANA_SYMBOLS = new Map<string, ManaType>([
	["W", "w"],
	["U", "u"],
	["B", "b"],
	["R", "r"],
	["G", "g"],
	["C", "c"],
]);
const BARE_KEYWORDS = new Map<string, Keyword>([
	["Deathtouch", "deathtouch"],
	["Flying", "flying"],
	["Reach", "reach"],
	["Defender", "defender"],
	["Lifelink", "lifelink"],
	["Indestructible", "indestructible"],
	["Hexproof", "hexproof"],
	["Shroud", "shroud"],
	["Haste", "haste"],
	["Vigilance", "vigilance"],
	["Trample", "trample"],
	["Flash", "flash"],
	["Prowess", "prowess"],
]);
const COUNTER_NAMES = new Map<string, "+1/+1" | "-1/-1">([
	["P1P1", "+1/+1"],
	["M1M1", "-1/-1"],
]);
const BASIC_LAND_MANA = new Map<string, Color>([
	["Plains", "w"],
	["Island", "u"],
	["Swamp", "b"],
	["Mountain", "r"],
	["Forest", "g"],
]);
/** Directive keys Forge stores at the card level, not per-face. */
const ALLOWED_CARD_DIRECTIVES = new Set([
	"AI",
	"DeckHints",
	"DeckNeeds",
	"DeckHas",
]);

/* ------------------------------------------------------------------------- */
/* Parameter-list checking                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Parameter keys that carry no semantics for this bridge, so they are accepted
 * on every record without appearing on any operation's allowlist.
 *
 * `AILogic` names a strategy class that Forge's automated player consults when
 * deciding whether and when to use an ability. It never changes the ability's
 * instructions, its costs, or its targets, so the engine's lowering of a record
 * is identical with and without it. `ast.ts` already classifies it as a
 * non-SVar-referencing display-ish key for the same reason.
 */
const IGNORED_PARAMS: ReadonlySet<string> = new Set(["ailogic"]);

/**
 * Scalar SVars Forge's AI and deck builder consult, but which do not affect a
 * card's rules. Keep this vocabulary explicit: an unknown unused SVar still
 * rejects, because it may be a rules value the importer has failed to consume.
 *
 * The names are stored lower-case because Forge SVar references are
 * case-insensitive.
 */
const IGNORED_UNUSED_SVARS: ReadonlySet<string> = new Set([
	"aipreference",
	"aiprioritymodifier",
	"ambushai",
	"antibuffedby",
	"buffedby",
	"donateme",
	"needstoplay",
	"needstoplayvar",
	"noncombatpriority",
	"nonstackingeffect",
	"playmain1",
]);

/**
 * Claims the complete parameter list for one lowering branch. Every semantic
 * parameter present must be consumed by that branch's explicit vocabulary,
 * and no semantic parameter may repeat. {@link IGNORED_PARAMS} keys are
 * metadata and are discarded before both checks.
 */
function consumeParams(
	params: ForgeParamList,
	allowedLower: ReadonlySet<string>,
	where: { nodeId?: string; line?: number },
): Result<null, ImportIssue> {
	const counts = new Map<string, number>();
	for (const entry of params.entries) {
		if (entry.malformed) {
			return issue(
				"UNSUPPORTED_PARAMETER",
				`malformed parameter fragment "${entry.raw}"`,
				{ ...where, paramId: entry.id },
			);
		}
		const lower = entry.key.toLowerCase();
		if (IGNORED_PARAMS.has(lower)) continue;
		counts.set(lower, (counts.get(lower) ?? 0) + 1);
		if (!allowedLower.has(lower)) {
			return issue(
				"UNSUPPORTED_PARAMETER",
				`unsupported parameter ${entry.key}`,
				{
					...where,
					paramId: entry.id,
				},
			);
		}
	}
	for (const [key, count] of counts) {
		if (count > 1) {
			return issue(
				"UNSUPPORTED_PARAMETER",
				`duplicate parameter ${key}`,
				where,
			);
		}
	}
	return ok(null);
}

function positiveInteger(
	value: string | undefined,
	fallback?: number,
): number | null {
	if (value === undefined) return fallback ?? null;
	return /^\d+$/.test(value) &&
		Number.isSafeInteger(Number(value)) &&
		Number(value) > 0
		? Number(value)
		: null;
}

function signedInteger(value: string | undefined): number | null {
	if (value === undefined || !/^[+-]?\d+$/.test(value)) return null;
	const n = Number(value);
	return Number.isSafeInteger(n) ? n : null;
}

function player(value: string | undefined): RelativeEffectPlayer | null {
	if (value === undefined || value === "You") return "you";
	if (value === "Opponent" || value === "Player.Opponent") return "opponent";
	return null;
}

function triggerEffectPlayer(
	value: string | undefined,
): TriggerEffectPlayer | null {
	if (value === "TriggeredPlayer") return "triggering-player";
	return player(value);
}

function selfDepartureEffectPlayer(
	value: string | undefined,
): TriggerEffectPlayer | null {
	// A Card.Self trigger watching its own departure from the battlefield
	// captures its controller from the permanent before it leaves. In that
	// trigger shape, whatever destination the permanent reaches,
	// TriggeredCardController is therefore the ability controller ("you").
	if (value === "TriggeredCardController") return "you";
	return triggerEffectPlayer(value);
}

function spellCastEffectPlayer(
	value: string | undefined,
): TriggerEffectPlayer | null {
	if (value === "TriggeredActivator") return "triggering-player";
	return triggerEffectPlayer(value);
}

/* ------------------------------------------------------------------------- */
/* Selectors and targets                                                      */
/* ------------------------------------------------------------------------- */

function combinePredicates(
	kind: "and" | "or",
	predicates: ObjectPredicateDef[],
): ObjectPredicateDef {
	const only = predicates[0];
	if (predicates.length === 1 && only) return only;
	assert(predicates.length >= 2, "a boolean predicate needs two operands");
	return {
		kind,
		predicates: predicates as [
			ObjectPredicateDef,
			ObjectPredicateDef,
			...ObjectPredicateDef[],
		],
	};
}

/**
 * One `.`-separated restriction following the base, such as the `nonBlack` of
 * `Creature.nonBlack`. Colors, card types, and supertypes lower exactly,
 * and `NEGATABLE_SUBTYPES` extends the vocabulary to negated subtypes. Every
 * `attacking` and `blocking` are the supported combat-state restrictions.
 * Every other Forge restriction (zone, counters, subtype-as-modifier without
 * `non`) rejects the card rather than being approximated.
 */
/**
 * `ValidPlayer$` -> the engine's relative-player vocabulary.
 *
 * Forge writes the player set a trigger, replacement, or static watches
 * relative to the source's controller. Only the three unqualified words map
 * cleanly:
 *
 *     You       -> "you"        the controller alone
 *     Opponent  -> "opponent"   any opponent of the controller
 *     Player    -> "either"     any player, controller included
 *
 * `Player.Opponent` is Forge's long spelling of `Opponent` and means the same
 * set. Every other dotted form (`Player.EnchantedController`,
 * `You.lifeGE1`, `Player.IsRemembered`, ...) restricts the set by game state
 * the engine has no relative-player equivalent for, so it returns null and the
 * caller rejects the card rather than silently widening the set.
 */
function parseValidPlayer(value: string): ValidPlayer | null {
	const trimmed = value.trim();
	if (trimmed === "You") return "you";
	if (trimmed === "Opponent" || trimmed === "Player.Opponent")
		return "opponent";
	if (trimmed === "Player") return "either";
	return null;
}

/**
 * The player who drew, from a `Mode$ Drawn` trigger's `ValidCard$`.
 *
 * A card is only ever drawn from its owner's library into that same player's
 * hand, so both the ownership and the control modifier name the drawer.
 */
function parseDrawnPlayer(value: string | undefined): ValidPlayer | null {
	if (value === undefined) return null;
	const trimmed = value.trim();
	if (trimmed === "Card.YouCtrl" || trimmed === "Card.YouOwn") return "you";
	if (trimmed === "Card.OppCtrl" || trimmed === "Card.OppOwn")
		return "opponent";
	if (trimmed === "Card") return "either";
	return null;
}

/**
 * Modifiers Forge's `!` prefix may negate, such as the `!token` of
 * `Creature.YouCtrl+!token`.
 *
 * `!` negates any restriction in Forge, and the corpus negates about a
 * hundred distinct words. Almost all of them name state the engine does not
 * model -- `!IsRemembered`, `!ManaAbility`, `!wasCastFromYourHand`,
 * `!attackedThisTurn` -- and reject on the word itself. These three are the
 * surveyed remainder: their positive form already lowers, and the negation
 * says exactly what it denies. A word whose negation would have to pick
 * between two readings is why this is a list and not a blanket rule; add to
 * it when a card needs it.
 */
const NEGATABLE_MODIFIERS: ReadonlySet<string> = new Set([
	"token",
	"Token",
	"attacking",
	"blocking",
]);

type ManaValueComparison = Extract<
	ObjectPredicateDef,
	{ kind: "mana value" }
>["comparison"];

/** Forge's mana value comparators, spelled as the predicate spells them. */
const CMC_COMPARISONS = new Map<string, ManaValueComparison>([
	["GE", "at least"],
	["GT", "greater than"],
	["LE", "at most"],
	["LT", "less than"],
	["EQ", "exactly"],
	["NE", "other than"],
]);

function parseSelectorModifier(modifier: string): ObjectPredicateDef | null {
	if (modifier.startsWith("!")) {
		const inner = modifier.slice(1);
		if (!NEGATABLE_MODIFIERS.has(inner)) return null;
		const predicate = parseSelectorModifier(inner);
		if (!predicate) return null;
		return { kind: "not", predicate };
	}
	if (modifier === "Other") return { kind: "not", predicate: { kind: "self" } };
	if (modifier === "attacking") return { kind: "attacking" };
	if (modifier === "blocking") return { kind: "blocking" };
	if (modifier === "YouCtrl") return { kind: "controller", player: "you" };
	if (modifier === "OppCtrl") return { kind: "controller", player: "opponent" };
	if (modifier === "YouOwn") return { kind: "owner", player: "you" };
	if (modifier === "OppOwn") return { kind: "owner", player: "opponent" };
	// Both spellings of the word appear in the corpus and mean the same
	// property: a permanent or nonbattlefield object that is a token.
	if (modifier === "token" || modifier === "Token") return { kind: "token" };
	// `cmcGE5`: a mana value comparison against a literal bound. Forge also
	// writes the bound as `X` (`cmcLEX`, `cmcEQX`), which reads a value chosen
	// elsewhere on the card; a selector has no access to that value here, so
	// only the literal form lowers.
	const cmc = /^cmc([A-Z]{2})(\d+)$/.exec(modifier);
	if (cmc) {
		const comparison = CMC_COMPARISONS.get(cmc[1] ?? "");
		const value = Number(cmc[2]);
		if (comparison === undefined || !Number.isSafeInteger(value)) return null;
		return { kind: "mana value", comparison, value };
	}
	const negated = modifier.startsWith("non");
	const inner = negated ? modifier.slice(3) : modifier;
	const word = inner.toLowerCase();
	const color = COLOR_WORDS.get(word);
	const type = CARD_TYPES.get(word);
	const supertype = SUPERTYPES.get(word);
	let predicate: ObjectPredicateDef | null = null;
	if (color) predicate = { kind: "color", color };
	else if (type) predicate = { kind: "type", type };
	else if (supertype) predicate = { kind: "supertype", supertype };
	if (predicate) return negated ? { kind: "not", predicate } : predicate;
	// `nonAngel`: a negated subtype. Only a surveyed one lowers, so Forge
	// pseudo-restrictions such as `nonChosenCard`, and typos, reject rather
	// than lower to a restriction no card can satisfy.
	if (negated && NEGATABLE_SUBTYPES.has(inner))
		return { kind: "not", predicate: { kind: "subtype", subtype: inner } };
	return null;
}

/**
 * Subtypes the `non` modifier may negate, such as the `nonAngel` of
 * `Creature.nonAngel`.
 *
 * Surveyed from the corpus: every word that follows `non` in a card script
 * and names a subtype on some `Types:` line, plus `Army`, a real type whose
 * only cards are tokens. Colors, card types, and supertypes resolve before
 * this list is consulted; the words that follow `non` and are not subtypes at
 * all — Forge pseudo-restrictions like `nonChosenCard` and `nonCopiedSpell` —
 * reject. A subtype missing from this list rejects too: add it when a card
 * needs it.
 */
const NEGATABLE_SUBTYPES: ReadonlySet<string> = new Set([
	"Angel",
	"Archon",
	"Army",
	"Assassin",
	"Aura",
	"Avatar",
	"Bear",
	"Bolas",
	"Borg",
	"Brushwagg",
	"Cat",
	"Dalek",
	"Demon",
	"Detective",
	"Devil",
	"Dinosaur",
	"Dragon",
	"Eldrazi",
	"Elemental",
	"Elephant",
	"Elf",
	"Equipment",
	"Eye",
	"Faerie",
	"Food",
	"Forest",
	"Fox",
	"Frog",
	"Gideon",
	"Giant",
	"Gnome",
	"Goat",
	"God",
	"Gorgon",
	"Horror",
	"Human",
	"Hydra",
	"Imp",
	"Insect",
	"Island",
	"Kraken",
	"Kree",
	"Lair",
	"Lemur",
	"Lesson",
	"Leviathan",
	"Merfolk",
	"Mount",
	"Mountain",
	"Mutant",
	"Octopus",
	"Ogre",
	"Ooze",
	"Phyrexian",
	"Pilot",
	"Pirate",
	"Rat",
	"Rogue",
	"Saga",
	"Salamander",
	"Serpent",
	"Shapeshifter",
	"Shark",
	"Skeleton",
	"Sliver",
	"Soldier",
	"Spacecraft",
	"Spider",
	"Spirit",
	"Squirrel",
	"Swamp",
	"Vampire",
	"Vehicle",
	"Villain",
	"Wall",
	"Warrior",
	"Werewolf",
	"Wizard",
	"Wolf",
	"Zombie",
]);

function parseSelectorPart(value: string): ObjectPredicateDef | null {
	if (value === "Card.Self" || value === "Self") return { kind: "self" };
	// `+` AND-combines restrictions, like the `YouCtrl` of
	// `Creature.nonAngel+YouCtrl`. Only the first segment names a base; each
	// later segment is a bare modifier with no base of its own.
	const segments = value.split("+");
	const pieces = segments[0]?.split(".") ?? [];
	const base = pieces.shift();
	const parts: ObjectPredicateDef[] = [];
	const type = base ? (CARD_TYPES.get(base.toLowerCase()) ?? null) : null;
	if (type) parts.push({ kind: "type", type });
	else if (base === "Player" || base === "Any") return null;
	else if (base && base !== "Card" && base !== "Permanent")
		parts.push({ kind: "subtype", subtype: base });
	for (const modifier of pieces) {
		const parsed = parseSelectorModifier(modifier);
		if (!parsed) return null;
		parts.push(parsed);
	}
	for (const modifier of segments.slice(1)) {
		const parsed = parseSelectorModifier(modifier);
		if (!parsed) return null;
		parts.push(parsed);
	}
	return parts.length > 0 ? combinePredicates("and", parts) : null;
}

function parseSelector(value: string): ObjectPredicateDef | null {
	const choices = value
		.split(",")
		.map((part) => parseSelectorPart(part.trim()));
	return choices.every(
		(choice): choice is ObjectPredicateDef => choice !== null,
	)
		? combinePredicates("or", choices)
		: null;
}

/**
 * One choice of a selector that may carry Forge's `.Other` suffix, which
 * excludes the source object itself from an otherwise matching set.
 */
function parseSelectorChoice(value: string): ObjectPredicateDef | null {
	const trimmed = value.trim();
	const excludesSelf = trimmed.endsWith(".Other");
	const selector = parseSelectorPart(
		excludesSelf ? trimmed.slice(0, -".Other".length) : trimmed,
	);
	if (!selector) return null;
	return excludesSelf
		? combinePredicates("and", [
				selector,
				{ kind: "not", predicate: { kind: "self" } },
			])
		: selector;
}

function parseCopySelector(value: string): ObjectPredicateDef | null {
	const choices = value.split(",").map(parseSelectorChoice);
	return choices.every(
		(choice): choice is ObjectPredicateDef => choice !== null,
	)
		? combinePredicates("or", choices)
		: null;
}

/** The one target slot the engine supports; every lowered effect refers to it. */
const TARGET_SLOT = "target-1";

/**
 * Forge's remembered-card set for the supported Dig -> Effect may-play chain.
 * The engine binds the cards that actually reached exile under this slot.
 */
const REMEMBERED_EXILE_SLOT = "remembered-exile-cards";

/**
 * Forge's remembered object for the supported targeted exile-then-return chain.
 * The binding is the new card object created in exile, not the old permanent.
 */
const REMEMBERED_ZONE_CHANGE_SLOT = "remembered-zone-change-object";

/** The old library object chosen by a search, before its following movement. */
const SEARCHED_LIBRARY_SLOT = "searched-library-card";

/**
 * A targeting effect and its ability's `ValidTgts$` have to agree, or the
 * engine would resolve an effect against a target nobody checked.
 */
function checkEffectTargetSlots<Player extends TriggerEffectPlayer>(
	effects: EffectDef<Player>[],
	targets: TargetDef[],
	where: { nodeId?: string; line?: number },
): Err<ImportIssue> | null {
	for (const effect of effects) {
		if (effect.kind === "may") {
			const inner = checkEffectTargetSlots(effect.effects, targets, where);
			if (inner) return inner;
			continue;
		}
		for (const use of effectTargetUses(effect)) {
			const target = targets[0];
			if (targets.length !== 1 || !target || use.slot !== target.id) {
				return issue(
					"UNSUPPORTED_TARGET",
					"targeted effects must reference the declared target slot",
					where,
				);
			}
			if (!targetSelectorSatisfies(target.legal, use.required))
				return issue("UNSUPPORTED_TARGET", use.required.message, where);
		}
	}
	return null;
}

/**
 * The public card zone a `ChangeZone` record's targets sit in, for the
 * `ValidTgts$` parse. Only a graveyard or exile origin targets a card; a
 * battlefield origin targets the permanent, which `parseTarget` reads from the
 * selector alone.
 */
function changeZoneTargetZone(
	params: ForgeParamList,
	isChangeZone: boolean,
): "graveyard" | "exile" | undefined {
	if (!isChangeZone) return undefined;
	const originText = getForgeParam(params, "Origin");
	const origin =
		originText === undefined ? undefined : PUBLIC_ZONES.get(originText);
	return origin === "graveyard" || origin === "exile" ? origin : undefined;
}

/**
 * `ValidTgts$`-shaped values. Object selectors are evaluated inside the domain
 * established here: a spell on the stack, a public-zone card, or a permanent.
 * `Any`, `Player`, and `Opponent` are the forms that are not object
 * restrictions at all.
 */
function parseTarget(
	validTgts: string | undefined,
	targetType?: string,
	cardZone?: "graveyard" | "exile",
): TargetDef[] | null {
	if (validTgts === undefined) return [];

	let legal: TargetDef["legal"];
	if (targetType === "Spell") {
		if (validTgts === "Card") legal = { kind: "spell" };
		else {
			// On the battlefield, `Permanent` is the whole established domain. On
			// the stack it means only a permanent spell, so the domain-free selector
			// parser cannot lower that base without broadening it to every spell.
			const hasPermanentBase = validTgts.split(",").some((choice) => {
				const base = choice.trim().split(/[.+]/, 1)[0];
				return base === "Permanent";
			});
			if (hasPermanentBase) return null;
			const predicate = parseSelector(validTgts);
			if (!predicate) return null;
			legal = { kind: "spell", predicate };
		}
	} else if (targetType !== undefined) return null;
	else if (cardZone !== undefined) {
		if (validTgts === "Card") legal = { kind: "card", zone: cardZone };
		else {
			const parsed = parseSelector(validTgts);
			if (!parsed) return null;
			const ownership = (predicate: ObjectPredicateDef): ObjectPredicateDef => {
				switch (predicate.kind) {
					case "controller":
						// Forge's YouCtrl/OppCtrl restrictions use ownership for cards
						// outside the battlefield, where cards have no controller.
						return { kind: "owner", player: predicate.player };
					case "and":
					case "or": {
						const [first, second, ...rest] = predicate.predicates;
						return {
							kind: predicate.kind,
							predicates: [
								ownership(first),
								ownership(second),
								...rest.map(ownership),
							],
						};
					}
					case "not":
						return {
							kind: "not",
							predicate: ownership(predicate.predicate),
						};
					default:
						return predicate;
				}
			};
			legal = { kind: "card", zone: cardZone, predicate: ownership(parsed) };
		}
	} else if (validTgts === "Any") legal = { kind: "any-target" };
	else if (validTgts === "Player") legal = { kind: "player", player: "either" };
	else if (validTgts === "Opponent")
		legal = { kind: "player", player: "opponent" };
	else if (validTgts === "Permanent") legal = { kind: "permanent" };
	else {
		const selector = parseSelector(validTgts);
		if (!selector) return null;
		legal = { kind: "permanent", predicate: selector };
	}
	return [{ id: TARGET_SLOT, min: 1, max: 1, legal }];
}

/* ------------------------------------------------------------------------- */
/* Effects                                                                    */
/* ------------------------------------------------------------------------- */

const COMMON_EFFECT_PARAMS = [
	"spelldescription",
	"stackdescription",
	"subability",
	"cost",
];

interface AbilityHost {
	cardId: string;
	activated: AnyActivatedAbilityDefinition[];
	triggered: TriggeredAbilityDefinition[];
	hostedActivatedIndices: Set<number>;
	hostedTriggeredIndices: Set<number>;
}

interface SVarResolver {
	face: ForgeFaceAst;
	consumed: Set<string>;
}

type ForgeAbilitySVarRecord = ForgeSVarRecord & {
	parsed: { kind: "params"; params: ForgeParamList };
};

function consumeAbilitySVar(
	resolver: SVarResolver,
	name: string,
	reference: string,
	where: { nodeId?: string; line?: number },
): Result<ForgeAbilitySVarRecord, ImportIssue> {
	const normalized = name.trim().toLowerCase();
	const bucket = resolver.face.svarIndex.get(normalized);
	if (!bucket || bucket.length === 0)
		return issue(
			"UNSUPPORTED_REFERENCE",
			`unresolved ${reference} ${name}`,
			where,
		);
	if (bucket.length > 1)
		return issue(
			"UNSUPPORTED_REFERENCE",
			`ambiguous duplicate SVar ${name}`,
			where,
		);
	const svar = bucket[0];
	assert(svar !== undefined, "a one-element SVar bucket has a record");
	if (svar.parsed.kind !== "params")
		return issue(
			"UNSUPPORTED_REFERENCE",
			`${reference} ${name} is not an ability body`,
			where,
		);
	resolver.consumed.add(normalized);
	return ok(svar as ForgeAbilitySVarRecord);
}

function fixedTokenCharacteristics(
	scriptId: string,
	where: { nodeId?: string; line?: number },
	host: AbilityHost,
): Result<CharacteristicsSnapshot, ImportIssue> {
	if (!/^[A-Za-z0-9_]+$/.test(scriptId))
		return issue(
			"UNSUPPORTED_PARAMETER",
			`unsupported TokenScript$ value ${scriptId}`,
			where,
		);

	// TokenScript$ is a foreign key, not an encoded characteristic list.
	// forgeTokenScript asserts that the vendored token corpus contains it.
	const imported = importForgeCard(forgeTokenScript(scriptId), {
		id: `forge-token-${scriptId.toLowerCase()}`,
	});
	if (!imported.ok)
		return issue(
			"UNSUPPORTED_EFFECT",
			`unsupported Forge token script ${scriptId}: ${imported.diagnostics
				.map((diagnostic) => diagnostic.message)
				.join("; ")}`,
			where,
		);
	// Activated abilities lower onto the creating card below, so a token
	// script may carry any of them, mana or not: Treasure's mana ability and
	// Food's "{2}, {T}, Sacrifice this token: You gain 3 life" host the same
	// way. Other token ability kinds remain outside this importer subset.
	if (
		imported.card.spell ||
		imported.card.printedAbilities.static.length > 0 ||
		imported.card.printedAbilities.triggered.length > 0 ||
		imported.card.printedAbilities.replacement.length > 0 ||
		imported.card.printedAbilities.prohibition.length > 0
	)
		return issue(
			"UNSUPPORTED_EFFECT",
			`Forge token script ${scriptId} has unsupported abilities`,
			where,
		);

	const tokenDefinitions = imported.card.abilityDefinitions.activated;
	const tokenReferences = imported.card.printedAbilities.activated;
	if (tokenDefinitions.length !== tokenReferences.length)
		return issue(
			"UNSUPPORTED_EFFECT",
			`Forge token script ${scriptId} has unprinted activated abilities`,
			where,
		);

	const characteristics = characteristicsFromCardDef(imported.card);
	characteristics.abilities.activated = tokenDefinitions.map(
		(definition, tokenIndex) => {
			assert.equal(
				String(tokenReferences[tokenIndex]),
				`${imported.card.id}:${tokenIndex}`,
				"imported token ability references must match definition order",
			);
			const hostIndex = host.activated.length;
			host.activated.push(definition);
			host.hostedActivatedIndices.add(hostIndex);
			return abilityId("activated", host.cardId, hostIndex);
		},
	);
	return ok(characteristics);
}

/**
 * Effects that move one player's single fixed count. Only the Forge parameter
 * holding the count, its default when that parameter is omitted, and the
 * engine's effect kind differ between them; an absent default means the count
 * has to be written out.
 */
const SUBJECT_AMOUNT_EFFECTS = new Map<
	string,
	{
		kind: "gain-life" | "lose-life" | "scry" | "surveil" | "mill";
		amountParam: string;
		defaultAmount?: number;
		message: string;
	}
>([
	[
		"gainlife",
		{
			kind: "gain-life",
			amountParam: "LifeAmount",
			message: "unsupported or missing LifeAmount$/player for gainlife",
		},
	],
	[
		"loselife",
		{
			kind: "lose-life",
			amountParam: "LifeAmount",
			message: "unsupported or missing LifeAmount$/player for loselife",
		},
	],
	[
		"scry",
		{
			kind: "scry",
			amountParam: "ScryNum",
			defaultAmount: 1,
			message: "unsupported scry amount/player",
		},
	],
	[
		"surveil",
		{
			kind: "surveil",
			amountParam: "Amount",
			defaultAmount: 1,
			message: "unsupported surveil amount/player",
		},
	],
	[
		"mill",
		{
			kind: "mill",
			amountParam: "NumCards",
			defaultAmount: 1,
			message: "unsupported mill amount/player",
		},
	],
]);

/**
 * Forge's player operand. `Defined$ Targeted`, and an omitted `Defined$` on an
 * ability that declares `ValidTgts$`, both name the player this ability
 * targets; every other spelling is relative to the source's controller.
 */
function parseEffectPlayer<Player extends TriggerEffectPlayer>(
	params: ForgeParamList,
	parsePlayer: (value: string | undefined) => Player | null,
): EffectPlayerSubject<Player> | null {
	const defined = getForgeParam(params, "Defined");
	if (defined === "Targeted")
		return { kind: "target-player", slot: TARGET_SLOT };
	if (defined === undefined && getForgeParam(params, "ValidTgts") !== undefined)
		return { kind: "target-player", slot: TARGET_SLOT };
	const player = parsePlayer(defined);
	return player === null ? null : { kind: "relative-player", player };
}

type NonMayEffect<Player extends TriggerEffectPlayer> = Exclude<
	EffectDef<Player>,
	{ kind: "may" }
>;

function parseEffects<Player extends TriggerEffectPlayer>(
	resolver: SVarResolver,
	params: ForgeParamList,
	discriminatorLower: string,
	api: string,
	where: { nodeId?: string; line?: number },
	parsePlayer: (value: string | undefined) => Player | null,
	allowSourceObject: boolean,
	abilityHost: AbilityHost,
	triggeringZoneChangeDestination: PublicObjectZone | null,
): Result<NonMayEffect<Player>[], ImportIssue> {
	// Every branch claims this record's whole parameter list, and every branch's
	// list opens with its own discriminator and closes with the keys common to
	// all effects. `claim` supplies those invariant ends, so a branch states
	// exactly the vocabulary that is its own.
	const claim = (...keys: string[]) =>
		consumeParams(
			params,
			new Set([
				discriminatorLower,
				...keys,
				...COMMON_EFFECT_PARAMS,
				...(discriminatorLower === "ab" ? ["sorceryspeed"] : []),
			]),
			where,
		);
	switch (api) {
		case "gainlife":
		case "loselife":
		case "scry":
		case "surveil":
		case "mill": {
			const shape = SUBJECT_AMOUNT_EFFECTS.get(api);
			assertDefined(shape);
			const badParams = claim(
				"defined",
				"validtgts",
				"tgtprompt",
				shape.amountParam.toLowerCase(),
			);
			if (!badParams.ok) return badParams;
			const who = parseEffectPlayer(params, parsePlayer);
			const amount = positiveInteger(
				getForgeParam(params, shape.amountParam),
				shape.defaultAmount,
			);
			if (!who || !amount)
				return issue("UNSUPPORTED_PARAMETER", shape.message, where);
			return ok([{ kind: shape.kind, subject: who, amount }]);
		}
		case "dig": {
			const badParams = claim(
				"defined",
				"dignum",
				"changenum",
				"noreveal",
				"destinationzone",
				"rememberchanged",
			);
			if (!badParams.ok) return badParams;
			const who = parseEffectPlayer(params, parsePlayer);
			const amount = positiveInteger(getForgeParam(params, "DigNum"));
			const changeNum = getForgeParam(params, "ChangeNum");
			const keep = positiveInteger(getForgeParam(params, "ChangeNum"), 1);
			const noReveal = getForgeParam(params, "NoReveal");
			const destination = getForgeParam(params, "DestinationZone");
			const rememberChanged = getForgeParam(params, "RememberChanged");
			if (destination !== undefined || rememberChanged !== undefined) {
				if (
					who?.kind !== "relative-player" ||
					who.player !== "you" ||
					!amount ||
					changeNum !== "All" ||
					destination !== "Exile" ||
					rememberChanged !== "True" ||
					noReveal !== undefined
				) {
					return issue(
						"UNSUPPORTED_PARAMETER",
						"remembered Dig requires a fixed positive DigNum, Defined$ You, ChangeNum$ All, DestinationZone$ Exile, and RememberChanged$ True",
						where,
					);
				}
				return ok([
					{
						kind: "exile-top",
						subject: who,
						amount,
						resultSlot: REMEMBERED_EXILE_SLOT,
					},
				]);
			}
			if (
				who?.kind !== "relative-player" ||
				who.player !== "you" ||
				!amount ||
				!keep ||
				keep > amount ||
				(noReveal !== undefined && noReveal !== "True")
			) {
				return issue(
					"UNSUPPORTED_PARAMETER",
					"only fixed hidden Dig forms that put a fixed number of cards into hand and order the rest on the library bottom are supported",
					where,
				);
			}
			return ok([
				{ kind: "choose-from-top", subject: who.player, amount, keep },
			]);
		}
		case "investigate": {
			const badParams = claim();
			if (!badParams.ok) return badParams;
			// With no Defined$ or Num$, Forge's Investigate API means its
			// controller investigates once. Explicit variants reject above.
			const controller = parsePlayer(undefined);
			assert(controller !== null, "default effect player must be supported");
			return ok([
				{
					kind: "create-token",
					controller: { kind: "relative-player", player: controller },
					characteristics: cloneCharacteristics(CLUE_TOKEN),
					amount: 1,
				},
			]);
		}
		case "draw": {
			const badParams = claim("defined", "validtgts", "tgtprompt", "numcards");
			if (!badParams.ok) return badParams;
			const amount = positiveInteger(getForgeParam(params, "NumCards"), 1);
			if (!amount)
				return issue("UNSUPPORTED_PARAMETER", "unsupported draw amount", where);
			if (getForgeParam(params, "Defined") === "Player")
				return ok([
					{
						kind: "draw",
						subject: "each-player",
						amount,
					},
				]);
			const who = parseEffectPlayer(params, parsePlayer);
			if (!who)
				return issue("UNSUPPORTED_PARAMETER", "unsupported draw player", where);
			return ok([{ kind: "draw", subject: who, amount }]);
		}
		case "discard": {
			const badParams = claim(
				"defined",
				"mode",
				"numcards",
				"validtgts",
				"tgtprompt",
			);
			if (!badParams.ok) return badParams;
			if (getForgeParam(params, "Mode") !== "TgtChoose")
				return issue(
					"UNSUPPORTED_EFFECT",
					"only Mode$ TgtChoose discard is supported",
					where,
				);
			const who = parseEffectPlayer(params, parsePlayer);
			const amount = positiveInteger(getForgeParam(params, "NumCards"), 1);
			if (!who || amount !== 1)
				return issue(
					"UNSUPPORTED_EFFECT",
					"only discarding exactly one chosen card is supported",
					where,
				);
			return ok([
				{ kind: "discard", selector: "any", amount: 1, subject: who },
			]);
		}
		case "sacrifice": {
			const badParams = claim(
				"defined",
				"validtgts",
				"tgtprompt",
				"sacvalid",
				"amount",
			);
			if (!badParams.ok) return badParams;
			const defined = getForgeParam(params, "Defined");
			const validTargets = getForgeParam(params, "ValidTgts");
			if (
				validTargets !== undefined &&
				defined !== undefined &&
				defined !== "Targeted"
			)
				return issue(
					"UNSUPPORTED_PARAMETER",
					"targeted Sacrifice cannot also name a different Defined$ player",
					where,
				);
			const who = parseEffectPlayer(params, parsePlayer);
			const selectorText = getForgeParam(params, "SacValid");
			const selector = selectorText ? parseSelector(selectorText) : null;
			const amount = positiveInteger(getForgeParam(params, "Amount"), 1);
			if (!who || !selector || amount !== 1)
				return issue(
					"UNSUPPORTED_EFFECT",
					"Sacrifice requires a supported player, selector, and an amount of one",
					where,
				);
			return ok([
				{
					kind: "sacrifice",
					subject: who,
					predicate: selector,
					amount: 1,
				},
			]);
		}
		case "dealdamage": {
			const badParams = claim("validtgts", "tgtprompt", "defined", "numdmg");
			if (!badParams.ok) return badParams;
			const amount = positiveInteger(getForgeParam(params, "NumDmg"));
			if (!amount)
				return issue("UNSUPPORTED_PARAMETER", "unsupported NumDmg", where);
			const defined = getForgeParam(params, "Defined");
			if (defined === undefined)
				return ok([
					{
						kind: "damage",
						subject: { kind: "target", slot: TARGET_SLOT },
						amount,
					},
				]);
			const player = parsePlayer(defined);
			if (!player)
				return issue(
					"UNSUPPORTED_PARAMETER",
					"unsupported Defined$ damage recipient",
					where,
				);
			return ok([
				{
					kind: "damage",
					subject: { kind: "relative-player", player },
					amount,
				},
			]);
		}
		case "destroy": {
			const badParams = claim("validtgts", "tgtprompt");
			if (!badParams.ok) return badParams;
			return ok([
				{
					kind: "destroy",
					subject: { kind: "target", slot: TARGET_SLOT },
				},
			]);
		}
		case "tap":
		case "untap": {
			const badParams = claim("validtgts", "tgtprompt");
			if (!badParams.ok) return badParams;
			return ok([
				{
					kind: api,
					subject: { kind: "target", slot: TARGET_SLOT },
				},
			]);
		}
		case "tapall": {
			const badParams = claim("validcards");
			if (!badParams.ok) return badParams;
			const validCards = getForgeParam(params, "ValidCards");
			const predicate = validCards ? parseSelector(validCards) : null;
			if (!predicate)
				return issue(
					"UNSUPPORTED_PARAMETER",
					"TapAll requires a supported ValidCards$ predicate",
					where,
				);
			return ok([
				{
					kind: "tap",
					subjects: { kind: "matching-permanents", predicate },
				},
			]);
		}
		case "counter": {
			const badParams = claim("validtgts", "tgtprompt", "targettype");
			if (!badParams.ok) return badParams;
			return ok([
				{
					kind: "counter",
					subject: { kind: "target", slot: TARGET_SLOT },
				},
			]);
		}
		case "changezone": {
			const badParams = claim(
				"origin",
				"destination",
				"defined",
				"validtgts",
				"tgtprompt",
				"tgtzone",
				"changenum",
				"gaincontrol",
				"tapped",
				"libraryposition",
				"activationzone",
				"remembertargets",
				"forgetothertargets",
				"hidden",
				"mandatory",
				"changetype",
				"changetypedesc",
				"shuffle",
			);
			if (!badParams.ok) return badParams;
			const originText = getForgeParam(params, "Origin");
			const changeType = getForgeParam(params, "ChangeType");
			const shuffle = getForgeParam(params, "Shuffle");
			if (shuffle !== undefined) {
				if (
					shuffle !== "True" ||
					originText !== "Graveyard" ||
					getForgeParam(params, "Destination") !== "Library" ||
					getForgeParam(params, "Defined") !== "TriggeredCardLKICopy" ||
					triggeringZoneChangeDestination !== "graveyard" ||
					getForgeParam(params, "ValidTgts") !== undefined ||
					getForgeParam(params, "TgtZone") !== undefined ||
					getForgeParam(params, "ChangeNum") !== undefined ||
					getForgeParam(params, "GainControl") !== undefined ||
					getForgeParam(params, "Tapped") !== undefined ||
					getForgeParam(params, "LibraryPosition") !== undefined ||
					getForgeParam(params, "ActivationZone") !== undefined ||
					getForgeParam(params, "RememberTargets") !== undefined ||
					getForgeParam(params, "ForgetOtherTargets") !== undefined ||
					getForgeParam(params, "Hidden") !== undefined ||
					getForgeParam(params, "Mandatory") !== undefined ||
					changeType !== undefined ||
					getForgeParam(params, "ChangeTypeDesc") !== undefined
				)
					return issue(
						"UNSUPPORTED_PARAMETER",
						"unsupported ChangeZone shuffle shape",
						where,
					);
				return ok([
					{
						kind: "shuffle-into-library",
						owners: { kind: "triggering-zone-change-result-owner" },
						from: ["graveyard"],
						predicate: { kind: "self" },
					},
				]);
			}
			if (originText === "Library") {
				const amount = positiveInteger(getForgeParam(params, "ChangeNum"), 1);
				const predicate =
					changeType === "Card"
						? undefined
						: changeType === undefined
							? null
							: parseSelector(changeType);
				const owner = parseEffectPlayer(params, parsePlayer);
				const searcher = parsePlayer("You");
				const destinationText = getForgeParam(params, "Destination");
				const gainControl = getForgeParam(params, "GainControl");
				const tapped = getForgeParam(params, "Tapped");
				const mandatory = getForgeParam(params, "Mandatory");
				if (
					amount !== 1 ||
					predicate === null ||
					!owner ||
					!searcher ||
					(getForgeParam(params, "Hidden") !== undefined &&
						getForgeParam(params, "Hidden") !== "True") ||
					(mandatory !== undefined && mandatory !== "True") ||
					getForgeParam(params, "TgtZone") !== undefined ||
					getForgeParam(params, "LibraryPosition") !== undefined ||
					getForgeParam(params, "ActivationZone") !== undefined ||
					getForgeParam(params, "RememberTargets") !== undefined ||
					getForgeParam(params, "ForgetOtherTargets") !== undefined
				) {
					return issue(
						"UNSUPPORTED_PARAMETER",
						"library search requires one supported card selector and destination",
						where,
					);
				}

				let destination: Exclude<
					ZoneChangeEffectDestination<Player>,
					{ zone: "library" }
				>;
				if (
					destinationText === "Hand" ||
					destinationText === "Graveyard" ||
					destinationText === "Exile"
				) {
					if (gainControl !== undefined || tapped !== undefined)
						return issue(
							"UNSUPPORTED_PARAMETER",
							"library search destination metadata does not match its destination",
							where,
						);
					// A qualified search into a hidden hand must reveal the found card
					// to every player. The engine has no one-shot reveal projection yet,
					// so accepting that family would hide rules-visible information.
					if (destinationText === "Hand" && predicate !== undefined)
						return issue(
							"UNSUPPORTED_EFFECT",
							"qualified searches into a hand require reveal support",
							where,
						);
					destination = {
						zone: destinationText.toLowerCase() as
							| "hand"
							| "graveyard"
							| "exile",
					};
				} else if (destinationText === "Battlefield") {
					if (
						(gainControl !== undefined &&
							gainControl !== "True" &&
							gainControl !== "False") ||
						(tapped !== undefined && tapped !== "True" && tapped !== "False")
					)
						return issue(
							"UNSUPPORTED_PARAMETER",
							"unsupported battlefield library search destination",
							where,
						);
					destination = {
						zone: "battlefield",
						controller: gainControl === "True" ? searcher : "owner",
						...(tapped === "True" ? { tapped: true } : {}),
					};
				} else {
					return issue(
						"UNSUPPORTED_PARAMETER",
						"unsupported library search destination",
						where,
					);
				}

				return ok([
					{
						kind: "search-library",
						searcher: { kind: "relative-player", player: searcher },
						owner,
						...(predicate ? { predicate } : {}),
						resultSlot: SEARCHED_LIBRARY_SLOT,
					},
					{
						kind: "change-zone",
						subject: {
							kind: "effect-result",
							slot: SEARCHED_LIBRARY_SLOT,
						},
						from: "library",
						destination,
					},
					{ kind: "shuffle-library", subject: owner },
				]);
			}
			if (getForgeParam(params, "ChangeTypeDesc") !== undefined)
				return issue(
					"UNSUPPORTED_PARAMETER",
					"ChangeTypeDesc is supported only for library searches",
					where,
				);
			if (changeType !== undefined) {
				const selector = parseSelector(changeType);
				const amount = positiveInteger(getForgeParam(params, "ChangeNum"), 1);
				if (
					selector === null ||
					amount !== 1 ||
					(originText !== undefined && originText !== "Battlefield") ||
					getForgeParam(params, "Destination") !== "Hand" ||
					getForgeParam(params, "Hidden") !== "True" ||
					getForgeParam(params, "Mandatory") !== "True" ||
					getForgeParam(params, "Defined") !== undefined ||
					getForgeParam(params, "ValidTgts") !== undefined ||
					getForgeParam(params, "TgtZone") !== undefined ||
					getForgeParam(params, "GainControl") !== undefined ||
					getForgeParam(params, "Tapped") !== undefined ||
					getForgeParam(params, "LibraryPosition") !== undefined ||
					getForgeParam(params, "ActivationZone") !== undefined ||
					getForgeParam(params, "RememberTargets") !== undefined ||
					getForgeParam(params, "ForgetOtherTargets") !== undefined
				) {
					return issue(
						"UNSUPPORTED_PARAMETER",
						"unsupported non-targeted ChangeZone choice",
						where,
					);
				}
				const chooser = parsePlayer("You");
				assert(chooser !== null, "ability controller must be supported");
				return ok([
					{
						kind: "change-zone",
						subject: {
							kind: "chosen-permanent",
							player: chooser,
							predicate: selector,
							prompt:
								getForgeParam(params, "SpellDescription") ??
								"Choose a permanent to return to its owner's hand.",
						},
						from: "battlefield",
						destination: { zone: "hand" },
					},
				]);
			}
			const origin =
				originText === undefined ? undefined : PUBLIC_ZONES.get(originText);
			if (!origin) {
				return issue(
					"UNSUPPORTED_PARAMETER",
					"ChangeZone requires one public Battlefield, Graveyard, or Exile origin",
					where,
				);
			}
			const targetZone = getForgeParam(params, "TgtZone");
			if (targetZone !== undefined && targetZone !== originText)
				return issue(
					"UNSUPPORTED_PARAMETER",
					"ChangeZone TgtZone$ must match Origin$",
					where,
				);
			const changeNum = getForgeParam(params, "ChangeNum");
			if (changeNum !== undefined && changeNum !== "1")
				return issue(
					"UNSUPPORTED_PARAMETER",
					"only a one-object ChangeZone is supported",
					where,
				);

			const destinationText = getForgeParam(params, "Destination");
			const libraryPosition = getForgeParam(params, "LibraryPosition");
			const gainControl = getForgeParam(params, "GainControl");
			const tapped = getForgeParam(params, "Tapped");
			let destination: ZoneChangeEffectDestination<Player>;
			if (
				destinationText === "Hand" ||
				destinationText === "Graveyard" ||
				destinationText === "Exile"
			) {
				if (
					libraryPosition !== undefined ||
					gainControl !== undefined ||
					tapped !== undefined
				)
					return issue(
						"UNSUPPORTED_PARAMETER",
						"ChangeZone destination metadata does not match its destination",
						where,
					);
				destination = {
					zone: destinationText.toLowerCase() as "hand" | "graveyard" | "exile",
				};
			} else if (destinationText === "Library") {
				if (
					gainControl !== undefined ||
					tapped !== undefined ||
					(libraryPosition !== undefined &&
						libraryPosition !== "0" &&
						libraryPosition !== "-1")
				)
					return issue(
						"UNSUPPORTED_PARAMETER",
						"ChangeZone supports only top or bottom library destinations",
						where,
					);
				destination = {
					zone: "library",
					position: libraryPosition === "-1" ? "bottom" : "top",
				};
			} else if (destinationText === "Battlefield") {
				if (
					libraryPosition !== undefined ||
					(gainControl !== undefined &&
						gainControl !== "True" &&
						gainControl !== "False") ||
					(tapped !== undefined && tapped !== "True" && tapped !== "False")
				)
					return issue(
						"UNSUPPORTED_PARAMETER",
						"unsupported battlefield ChangeZone destination metadata",
						where,
					);
				const controller =
					gainControl === "True" ? parsePlayer("You") : "owner";
				assert(controller !== null);
				destination = {
					zone: "battlefield",
					controller,
					...(tapped === "True" ? { tapped: true } : {}),
				};
			} else {
				return issue(
					"UNSUPPORTED_PARAMETER",
					"unsupported ChangeZone destination",
					where,
				);
			}
			const validTargets = getForgeParam(params, "ValidTgts");
			const defined = getForgeParam(params, "Defined");
			const rememberTargets = getForgeParam(params, "RememberTargets");
			if (rememberTargets !== undefined && rememberTargets !== "True")
				return issue(
					"UNSUPPORTED_PARAMETER",
					"RememberTargets$ must be True",
					where,
				);
			// ForgetOtherTargets clears objects remembered by earlier resolutions
			// of the same ability. The remembered chain below binds its target per
			// resolution (the return sub-ability consumes it immediately), so on
			// that chain the parameter is a no-op; anywhere else it would clear a
			// cross-ability remembered set the engine does not model, so it
			// rejects.
			const forgetOtherTargets = getForgeParam(params, "ForgetOtherTargets");
			if (
				forgetOtherTargets !== undefined &&
				(forgetOtherTargets !== "True" || rememberTargets !== "True")
			)
				return issue(
					"UNSUPPORTED_PARAMETER",
					"ForgetOtherTargets requires the RememberTargets chain",
					where,
				);
			let subject:
				| { kind: "source" }
				| TargetEffectRef
				| TriggeringZoneChangeResultEffectRef;
			if (defined === "TriggeredNewCardLKICopy") {
				if (
					triggeringZoneChangeDestination === null ||
					triggeringZoneChangeDestination !== origin ||
					validTargets !== undefined
				)
					return issue(
						"UNSUPPORTED_PARAMETER",
						"TriggeredNewCardLKICopy must name the destination object of this trigger's zone change",
						where,
					);
				subject = { kind: "triggering-zone-change-result" };
			} else if (validTargets !== undefined || defined === "Targeted") {
				if (defined !== undefined && defined !== "Targeted")
					return issue(
						"UNSUPPORTED_PARAMETER",
						"targeted ChangeZone cannot name a different Defined$ subject",
						where,
					);
				subject = { kind: "target", slot: TARGET_SLOT };
			} else {
				// Forge defaults an omitted Defined$ to the source object. Accept the
				// explicit spelling too, but reject every other non-target subject.
				if (!allowSourceObject || (defined !== undefined && defined !== "Self"))
					return issue(
						"UNSUPPORTED_PARAMETER",
						"unsupported Defined$ ChangeZone subject",
						where,
					);
				subject = { kind: "source" };
			}
			if (
				rememberTargets === "True" &&
				(subject.kind !== "target" ||
					origin !== "battlefield" ||
					destination.zone !== "exile")
			)
				return issue(
					"UNSUPPORTED_PARAMETER",
					"remembered ChangeZone requires one targeted battlefield object moving to exile",
					where,
				);
			if (destination.zone === origin)
				return issue(
					"UNSUPPORTED_PARAMETER",
					"ChangeZone origin and destination must differ",
					where,
				);
			// The engine's type pairs each origin with the destinations that are not
			// that same zone, so each arm re-states, for its one origin, the
			// comparison made above. Only the battlefield-to-exile remembered chain
			// reaches here with RememberTargets$ True.
			switch (origin) {
				case "battlefield":
					assert(destination.zone !== "battlefield");
					return ok([
						{
							kind: "change-zone",
							subject,
							from: origin,
							destination,
							...(rememberTargets === "True"
								? { resultSlot: REMEMBERED_ZONE_CHANGE_SLOT }
								: {}),
						},
					]);
				case "graveyard":
					assert(destination.zone !== "graveyard");
					return ok([
						{
							kind: "change-zone",
							subject,
							from: origin,
							destination,
						},
					]);
				case "exile":
					assert(destination.zone !== "exile");
					return ok([
						{
							kind: "change-zone",
							subject,
							from: origin,
							destination,
						},
					]);
			}
			throw new Error("unreachable ChangeZone origin");
		}
		case "changezoneall": {
			const badParams = claim(
				"changetype",
				"origin",
				"destination",
				"defined",
				"shuffle",
				"usealloriginzones",
			);
			if (!badParams.ok) return badParams;
			const origins = getForgeParam(params, "Origin")?.split(",");
			if (
				getForgeParam(params, "ChangeType") !== "Card" ||
				origins?.length !== 2 ||
				origins[0] !== "Hand" ||
				origins[1] !== "Graveyard" ||
				getForgeParam(params, "Destination") !== "Library" ||
				getForgeParam(params, "Defined") !== undefined ||
				getForgeParam(params, "Shuffle") !== "True" ||
				getForgeParam(params, "UseAllOriginZones") !== "True"
			)
				return issue(
					"UNSUPPORTED_PARAMETER",
					"only each player's whole hand and graveyard shuffled into their library is supported",
					where,
				);
			return ok([
				{
					kind: "shuffle-into-library",
					owners: "each-player",
					from: ["hand", "graveyard"],
				},
			]);
		}
		case "putcounter": {
			const badParams = claim(
				"defined",
				"validtgts",
				"tgtprompt",
				"countertype",
				"counternum",
			);
			if (!badParams.ok) return badParams;
			const counter = COUNTER_NAMES.get(
				getForgeParam(params, "CounterType") ?? "",
			);
			const amount = positiveInteger(getForgeParam(params, "CounterNum"));
			if (counter === undefined || amount === null)
				return issue(
					"UNSUPPORTED_PARAMETER",
					"PutCounter requires a supported CounterType$ and a positive CounterNum$",
					where,
				);
			const defined = getForgeParam(params, "Defined");
			const validTargets = getForgeParam(params, "ValidTgts");
			if (validTargets !== undefined) {
				if (defined !== undefined)
					return issue(
						"UNSUPPORTED_PARAMETER",
						"targeted PutCounter cannot also use Defined$",
						where,
					);
				return ok([
					{
						kind: "add counters",
						subject: { kind: "target", slot: TARGET_SLOT },
						counter,
						amount,
					},
				]);
			}
			// Forge defaults an omitted Defined$ to the source object when the
			// ability declares no targets. Only permanent abilities can use that
			// source as the recipient of counters.
			if (!allowSourceObject || (defined !== undefined && defined !== "Self"))
				return issue(
					"UNSUPPORTED_PARAMETER",
					"unsupported non-targeted PutCounter subject",
					where,
				);
			return ok([
				{
					kind: "add counters",
					subject: { kind: "source" },
					counter,
					amount,
				},
			]);
		}
		case "token": {
			const badParams = claim(
				"tokenscript",
				"tokenowner",
				"tokenamount",
				"validtgts",
				"tgtprompt",
			);
			if (!badParams.ok) return badParams;
			const scriptId = getForgeParam(params, "TokenScript");
			if (!scriptId)
				return issue(
					"UNSUPPORTED_PARAMETER",
					"Token requires TokenScript$",
					where,
				);
			// Forge names the token's owner with its own key rather than
			// `Defined$`, and an absent one means the source's controller. Both
			// targeted spellings name the player this ability targets;
			// `TargetedController` instead reads a targeted *object's*
			// controller, which is a different operand and still rejects.
			const owner = getForgeParam(params, "TokenOwner");
			let controller: EffectPlayerSubject<Player>;
			if (owner === "Targeted" || owner === "TargetedPlayer") {
				controller = { kind: "target-player", slot: TARGET_SLOT };
			} else {
				const relative = parsePlayer(owner);
				if (relative === null)
					return issue(
						"UNSUPPORTED_PARAMETER",
						"unsupported token controller",
						where,
					);
				controller = { kind: "relative-player", player: relative };
			}
			const amount = positiveInteger(getForgeParam(params, "TokenAmount"), 1);
			if (!amount)
				return issue(
					"UNSUPPORTED_PARAMETER",
					"TokenAmount$ must be a positive integer",
					where,
				);
			const characteristics = fixedTokenCharacteristics(
				scriptId,
				where,
				abilityHost,
			);
			if (!characteristics.ok) return characteristics;
			return ok([
				{
					kind: "create-token",
					controller,
					characteristics: characteristics.value,
					amount,
				},
			]);
		}
		case "animate": {
			const badParams = claim(
				"defined",
				"validtgts",
				"tgtprompt",
				"keywords",
				"triggers",
				"duration",
			);
			if (!badParams.ok) return badParams;
			const defined = getForgeParam(params, "Defined");
			const validTargets = getForgeParam(params, "ValidTgts");
			const targetsRoot =
				discriminatorLower === "sp" &&
				defined === undefined &&
				validTargets !== undefined;
			const continuesForParentTarget =
				discriminatorLower === "db" &&
				defined === "ParentTarget" &&
				validTargets === undefined;
			if (!targetsRoot && !continuesForParentTarget)
				return issue(
					"UNSUPPORTED_PARAMETER",
					"Animate must target at the spell root or continue for Defined$ ParentTarget",
					where,
				);
			const duration = getForgeParam(params, "Duration");
			if (duration !== undefined && duration !== "UntilEndOfTurn")
				return issue(
					"UNSUPPORTED_PARAMETER",
					"Animate supports only an until-end-of-turn duration",
					where,
				);

			const effects: NonMayEffect<Player>[] = [];
			const subject: TargetEffectRef = { kind: "target", slot: TARGET_SLOT };
			const rawKeywords = getForgeParam(params, "Keywords");
			for (const rawKeyword of rawKeywords
				?.split("&")
				.map((value) => value.trim()) ?? []) {
				const keyword = BARE_KEYWORDS.get(rawKeyword);
				if (keyword === undefined)
					return issue(
						"UNSUPPORTED_PARAMETER",
						`unsupported temporary keyword ${rawKeyword}`,
						where,
					);
				effects.push({
					kind: "grant-keyword",
					subject,
					keyword,
					duration: "until-end-of-turn",
				});
			}

			const triggerName = getForgeParam(params, "Triggers");
			if (!triggerName)
				return issue(
					"UNSUPPORTED_PARAMETER",
					"Animate requires one Triggers$ SVar reference",
					where,
				);
			const triggerSVar = consumeAbilitySVar(
				resolver,
				triggerName,
				"Triggers",
				where,
			);
			if (!triggerSVar.ok) return triggerSVar;
			const loweredTrigger = lowerTrigger(
				resolver,
				{
					params: triggerSVar.value.parsed.params,
					source: triggerSVar.value.source,
				},
				abilityHost,
			);
			if (!loweredTrigger.ok) return loweredTrigger;
			const triggerIndex = abilityHost.triggered.length;
			abilityHost.triggered.push(loweredTrigger.value);
			abilityHost.hostedTriggeredIndices.add(triggerIndex);
			effects.push({
				kind: "grant-triggered",
				subject,
				ability: abilityId("triggered", abilityHost.cardId, triggerIndex),
				duration: "until-end-of-turn",
			});
			return ok(effects);
		}
		case "pump": {
			const badParams = claim(
				"defined",
				"validtgts",
				"tgtprompt",
				"numatt",
				"numdef",
				"kw",
			);
			if (!badParams.ok) return badParams;

			const pumpEffect: {
				p: number | null;
				t: number | null;
				keywords: Keyword[] | null;
				subject: { kind: "source" } | TargetEffectRef | null;
			} = { p: null, t: null, keywords: null, subject: null };

			const powerText = getForgeParam(params, "NumAtt");
			const toughnessText = getForgeParam(params, "NumDef");
			const rawKwList = getForgeParam(params, "KW")
				?.split("&")
				.map((str) => str.trim());

			if (
				rawKwList === undefined &&
				powerText === undefined &&
				toughnessText === undefined
			)
				return issue(
					"UNSUPPORTED_PARAMETER",
					"Pump effect didn't apply a keyword, power, or toughness",
					where,
				);

			for (const rawKw of rawKwList ?? []) {
				if (!BARE_KEYWORDS.has(rawKw)) {
					return issue(
						"UNSUPPORTED_PARAMETER",
						`unsupported temporary keyword ${rawKwList}`,

						where,
					);
				}
				const keyword = BARE_KEYWORDS.get(rawKw);
				assertDefined(keyword);

				pumpEffect.keywords ??= [];

				pumpEffect.keywords.push(keyword);
			}

			// Forge omits the side that doesn't change: `NumAtt$ +2` alone is
			// +2/+0. Only a side that is present must parse as a fixed integer.
			if (powerText !== undefined || toughnessText !== undefined) {
				const power = powerText === undefined ? 0 : signedInteger(powerText);
				const toughness =
					toughnessText === undefined ? 0 : signedInteger(toughnessText);
				if (power === null || toughness === null) {
					return issue(
						"UNSUPPORTED_PARAMETER",
						"Pump requires fixed NumAtt$/NumDef$ values, or a supported KW$",
						where,
					);
				}

				pumpEffect.p = power;
				pumpEffect.t = toughness;
			}

			// `Defined$ Self` pumps the ability's own source ("it gets +1/+1");
			// `ValidTgts$` pumps a chosen target. Anything else -- both, neither,
			// or another Defined -- is outside the supported subset.
			const defined = getForgeParam(params, "Defined");
			const validTargets = getForgeParam(params, "ValidTgts");

			if (defined === "Self" && validTargets === undefined) {
				pumpEffect.subject = { kind: "source" };
			} else if (defined === undefined && validTargets !== undefined) {
				pumpEffect.subject = { kind: "target", slot: TARGET_SLOT };
			}

			if (pumpEffect.subject === null)
				return issue(
					"UNSUPPORTED_PARAMETER",
					"Pump must either define Self or declare targets",
					where,
				);

			const effectList: NonMayEffect<Player>[] = [];
			for (const keyword of pumpEffect.keywords ?? []) {
				effectList.push({
					kind: "grant-keyword",
					subject: pumpEffect.subject,
					keyword,
					duration: "until-end-of-turn",
				});
			}

			// `p` and `t` are set together, and either may legitimately be 0.
			if (pumpEffect.p !== null) {
				assertDefined(pumpEffect.t);
				effectList.push({
					kind: "modify-pt",
					subject: pumpEffect.subject,
					power: pumpEffect.p,
					toughness: pumpEffect.t,
					duration: "until-end-of-turn",
				});
			}

			if (effectList.length) return ok(effectList);
			return issue(
				"UNSUPPORTED_EFFECT",
				`no parseable effects for Pump`,
				where,
			);
		}
		default:
			return issue(
				"UNSUPPORTED_EFFECT",
				`unsupported effect api ${api}`,
				where,
			);
	}
}

const ABILITY_DISCRIMINATOR_TOKENS = ["AB", "SP", "ST", "DB"] as const;

function discriminator(
	params: ForgeParamList,
	where: { nodeId?: string; line?: number },
): Result<
	{ token: (typeof ABILITY_DISCRIMINATOR_TOKENS)[number]; api: string },
	ImportIssue
> {
	const normalized = forgeAbilityDiscriminator(params);
	if (normalized === null) {
		const present = ABILITY_DISCRIMINATOR_TOKENS.filter((token) =>
			params.effectiveLower.has(token.toLowerCase()),
		);
		return issue(
			"UNSUPPORTED_PARAMETER",
			present.length === 0
				? "ability record has no AB/SP/ST/DB discriminator"
				: "ability record declares more than one AB/SP/ST/DB discriminator",
			where,
		);
	}
	return ok(normalized);
}

/**
 * The `DB$ Cleanup | ClearRemembered$ True` sub-ability that closes a
 * remembered chain. It lowers to nothing — the engine consumes a remembered
 * binding inside the resolution that creates it — so this only proves the
 * script says exactly that and says nothing more.
 */
function checkRememberedCleanup(
	resolver: SVarResolver,
	name: string,
	where: { nodeId?: string; line?: number },
	message: string,
): Err<ImportIssue> | null {
	const _cleanupSVar = consumeAbilitySVar(resolver, name, "SubAbility", where);
	if (!_cleanupSVar.ok) return _cleanupSVar;
	const cleanupSVar = _cleanupSVar.value;
	const cleanupWhere = {
		nodeId: cleanupSVar.source.nodeId,
		line: cleanupSVar.source.line,
	};
	const _cleanupDisc = discriminator(cleanupSVar.parsed.params, cleanupWhere);
	if (!_cleanupDisc.ok) return _cleanupDisc;
	const badCleanupParams = consumeParams(
		cleanupSVar.parsed.params,
		new Set(["db", "clearremembered"]),
		cleanupWhere,
	);
	if (!badCleanupParams.ok) return badCleanupParams;
	if (
		_cleanupDisc.value.token !== "DB" ||
		_cleanupDisc.value.api !== "cleanup" ||
		getForgeParam(cleanupSVar.parsed.params, "ClearRemembered") !== "True"
	)
		return issue("UNSUPPORTED_PARAMETER", message, cleanupWhere);
	return null;
}

const CHAIN_FORBIDDEN = [
	"cost",
	"unlesscost",
	"conditiondefined",
	"conditionchecksvar",
];

/**
 * Follows `SubAbility$`/`Execute$` chains through face-local SVars.
 * `rejectAtRoot` additionally forbids costs and conditions on the first link,
 * for trigger `Execute$` chains (triggers never carry these). A new target
 * declaration is forbidden on every continuation, and allowed only at a root:
 * an ability declares its targets once, where it is announced.
 */
function lowerEffectChain<Player extends TriggerEffectPlayer>(
	resolver: SVarResolver,
	rootParams: ForgeParamList,
	rootWhere: { nodeId?: string; line?: number },
	targets: TargetDef[],
	rejectAtRoot: boolean,
	rootTokens: readonly (typeof ABILITY_DISCRIMINATOR_TOKENS)[number][],
	parsePlayer: (value: string | undefined) => Player | null,
	allowSourceObject: boolean,
	abilityHost: AbilityHost,
	triggeringZoneChangeDestination: PublicObjectZone | null,
): Result<EffectDef<Player>[], ImportIssue> {
	const effects: EffectDef<Player>[] = [];
	let current = rootParams;
	let where = rootWhere;
	const seen = new Set<string>();
	let depth = 0;
	for (;;) {
		if (depth > 0 && current.effectiveLower.has("validtgts")) {
			return issue(
				"UNSUPPORTED_EFFECT",
				"validtgts is not supported on a sub-ability continuation",
				where,
			);
		}
		if (depth > 0 || rejectAtRoot) {
			for (const key of CHAIN_FORBIDDEN) {
				if (current.effectiveLower.has(key)) {
					return issue(
						"UNSUPPORTED_EFFECT",
						`${key} is not supported on a sub-ability continuation`,
						where,
					);
				}
			}
		}
		const _disc = discriminator(current, where);
		if (!_disc.ok) return _disc;
		const allowedHere = depth === 0 ? rootTokens : (["DB"] as const);
		const disc = _disc.value;
		if (!(allowedHere as readonly string[]).includes(disc.token)) {
			return issue(
				"UNSUPPORTED_EFFECT",
				`expected ${allowedHere.join("/")} but found ${disc.token}`,
				where,
			);
		}
		const pendingRememberedDig = effects.at(-1);
		if (
			pendingRememberedDig?.kind === "exile-top" &&
			pendingRememberedDig.resultSlot === REMEMBERED_EXILE_SLOT &&
			disc.api !== "effect"
		) {
			return issue(
				"UNSUPPORTED_EFFECT",
				"remembered exile Dig must be followed immediately by DB$ Effect",
				where,
			);
		}
		const pendingRememberedChange = effects.at(-1);
		if (
			pendingRememberedChange?.kind === "change-zone" &&
			pendingRememberedChange.resultSlot === REMEMBERED_ZONE_CHANGE_SLOT &&
			disc.api !== "changezone"
		) {
			return issue(
				"UNSUPPORTED_EFFECT",
				"remembered ChangeZone must be followed immediately by its DB$ ChangeZone return",
				where,
			);
		}
		if (
			pendingRememberedChange?.kind === "change-zone" &&
			pendingRememberedChange.resultSlot === REMEMBERED_ZONE_CHANGE_SLOT
		) {
			const badReturnParams = consumeParams(
				current,
				new Set([
					"db",
					"defined",
					"origin",
					"destination",
					"gaincontrol",
					"subability",
				]),
				where,
			);
			if (!badReturnParams.ok) return badReturnParams;
			const cleanupName = getForgeParam(current, "SubAbility");
			// The remembered object is the card the previous effect just moved to
			// exile, and nothing can move it before this sub-ability resolves, so
			// Origin$ Exile and Origin$ All spell the same return. GainControl$ True
			// stays required: without it Forge returns the card under its owner's
			// control, a different effect. The cleanup SubAbility is Forge-side
			// bookkeeping — it lowers to nothing, since the engine consumes the
			// remembered binding within this resolution — so a card that keeps its
			// remembered set clean some other way (ForgetOtherTargets$ True on the
			// exile step) may omit it.
			const returnOrigin = getForgeParam(current, "Origin");
			if (
				disc.token !== "DB" ||
				getForgeParam(current, "Defined") !== "Remembered" ||
				(returnOrigin !== "All" && returnOrigin !== "Exile") ||
				getForgeParam(current, "Destination") !== "Battlefield" ||
				getForgeParam(current, "GainControl") !== "True"
			) {
				return issue(
					"UNSUPPORTED_PARAMETER",
					"remembered ChangeZone return requires DB$ ChangeZone, Defined$ Remembered, Origin$ All/Exile, Destination$ Battlefield, and GainControl$ True",
					where,
				);
			}

			if (cleanupName) {
				const badCleanup = checkRememberedCleanup(
					resolver,
					cleanupName,
					where,
					"remembered ChangeZone cleanup requires DB$ Cleanup and ClearRemembered$ True",
				);
				if (badCleanup) return badCleanup;
			}

			const controller = parsePlayer("You");
			assert(controller !== null, "controller must be supported");
			effects.push({
				kind: "change-zone",
				subject: {
					kind: "effect-result",
					slot: pendingRememberedChange.resultSlot,
				},
				from: "exile",
				destination: { zone: "battlefield", controller },
			});
			return ok(effects);
		}
		if (disc.api === "effect") {
			const rememberedDig = effects.at(-1);
			if (
				rememberedDig?.kind !== "exile-top" ||
				rememberedDig.resultSlot !== REMEMBERED_EXILE_SLOT
			) {
				return issue(
					"UNSUPPORTED_EFFECT",
					"Effect is supported only immediately after a remembered exile Dig",
					where,
				);
			}

			const badEffectParams = consumeParams(
				current,
				new Set([
					"db",
					"rememberobjects",
					"staticabilities",
					"subability",
					"forgetonmoved",
					"duration",
				]),
				where,
			);
			if (!badEffectParams.ok) return badEffectParams;
			const staticName = getForgeParam(current, "StaticAbilities");
			const cleanupName = getForgeParam(current, "SubAbility");
			if (
				getForgeParam(current, "RememberObjects") !== "RememberedCard" ||
				!staticName ||
				!cleanupName ||
				getForgeParam(current, "ForgetOnMoved") !== "Exile" ||
				getForgeParam(current, "Duration") !== "UntilTheEndOfYourNextTurn"
			) {
				return issue(
					"UNSUPPORTED_PARAMETER",
					"remembered-card Effect requires RememberObjects$ RememberedCard, one StaticAbilities$ reference, ForgetOnMoved$ Exile, Duration$ UntilTheEndOfYourNextTurn, and a cleanup SubAbility$",
					where,
				);
			}

			const _staticSVar = consumeAbilitySVar(
				resolver,
				staticName,
				"StaticAbilities",
				where,
			);
			if (!_staticSVar.ok) return _staticSVar;
			const staticSVar = _staticSVar.value;
			const staticWhere = {
				nodeId: staticSVar.source.nodeId,
				line: staticSVar.source.line,
			};
			const badStaticParams = consumeParams(
				staticSVar.parsed.params,
				new Set(["mode", "mayplay", "affected", "affectedzone", "description"]),
				staticWhere,
			);
			if (!badStaticParams.ok) return badStaticParams;
			if (
				getForgeParam(staticSVar.parsed.params, "Mode") !== "Continuous" ||
				getForgeParam(staticSVar.parsed.params, "MayPlay") !== "True" ||
				getForgeParam(staticSVar.parsed.params, "Affected") !==
					"Card.IsRemembered" ||
				getForgeParam(staticSVar.parsed.params, "AffectedZone") !== "Exile"
			) {
				return issue(
					"UNSUPPORTED_PARAMETER",
					"remembered-card static requires Mode$ Continuous, MayPlay$ True, Affected$ Card.IsRemembered, and AffectedZone$ Exile",
					staticWhere,
				);
			}

			const badCleanup = checkRememberedCleanup(
				resolver,
				cleanupName,
				where,
				"remembered-card Effect cleanup requires DB$ Cleanup and ClearRemembered$ True",
			);
			if (badCleanup) return badCleanup;

			assert.equal(
				rememberedDig.resultSlot,
				REMEMBERED_EXILE_SLOT,
				"remembered Dig and may-play Effect must share one result slot",
			);
			effects.push({
				kind: "may-play",
				subject: {
					kind: "effect-result",
					slot: rememberedDig.resultSlot,
				},
				from: "exile",
				duration: "until-end-of-your-next-turn",
			});
			return ok(effects);
		}
		const _lowered = parseEffects(
			resolver,
			current,
			disc.token.toLowerCase(),
			disc.api,
			where,
			parsePlayer,
			allowSourceObject,
			abilityHost,
			triggeringZoneChangeDestination,
		);
		if (!_lowered.ok) return _lowered;
		const lowered = _lowered.value;
		const targetIssue = checkEffectTargetSlots(lowered, targets, where);
		if (targetIssue) return targetIssue;
		effects.push(...lowered);
		const next = getForgeParam(current, "SubAbility");
		if (next === undefined) {
			if (
				lowered.length === 1 &&
				lowered[0]?.kind === "exile-top" &&
				lowered[0].resultSlot === REMEMBERED_EXILE_SLOT
			) {
				return issue(
					"UNSUPPORTED_EFFECT",
					"remembered exile Dig must be followed immediately by DB$ Effect",
					where,
				);
			}
			if (
				lowered.length === 1 &&
				lowered[0]?.kind === "change-zone" &&
				lowered[0].resultSlot === REMEMBERED_ZONE_CHANGE_SLOT
			) {
				return issue(
					"UNSUPPORTED_EFFECT",
					"remembered ChangeZone must be followed immediately by its DB$ ChangeZone return",
					where,
				);
			}
			return ok(effects);
		}
		const nextLower = next.trim().toLowerCase();
		if (seen.has(nextLower))
			return issue(
				"UNSUPPORTED_REFERENCE",
				`cyclic SubAbility chain at ${next}`,
				where,
			);
		seen.add(nextLower);
		const _svar = consumeAbilitySVar(resolver, next, "SubAbility", where);
		if (!_svar.ok) return _svar;
		const svar = _svar.value;
		current = svar.parsed.params;
		where = { nodeId: svar.source.nodeId, line: svar.source.line };
		depth += 1;
		if (depth > 32)
			return issue(
				"UNSUPPORTED_REFERENCE",
				"SubAbility chain exceeds supported depth",
				where,
			);
	}
}

/** Lower Forge's exact "at the beginning of the next end step" ability. */
function lowerNextEndStepDelayedTrigger(
	resolver: SVarResolver,
	params: ForgeParamList,
	where: { nodeId?: string; line?: number },
	description: string,
	host: AbilityHost,
): Result<ActivatedEffectDef[], ImportIssue> {
	const badParams = consumeParams(
		params,
		new Set([
			"ab",
			"cost",
			"mode",
			"phase",
			"execute",
			"spelldescription",
			"sorceryspeed",
		]),
		where,
	);
	if (!badParams.ok) return badParams;
	if (
		getForgeParam(params, "Mode") !== "Phase" ||
		getForgeParam(params, "Phase") !== "End of Turn"
	) {
		return issue(
			"UNSUPPORTED_EFFECT",
			"DelayedTrigger requires Mode$ Phase and Phase$ End of Turn",
			where,
		);
	}

	const execute = getForgeParam(params, "Execute");
	if (!execute)
		return issue(
			"UNSUPPORTED_REFERENCE",
			"DelayedTrigger requires Execute$",
			where,
		);
	const _executeSVar = consumeAbilitySVar(resolver, execute, "Execute", where);
	if (!_executeSVar.ok) return _executeSVar;
	const executeSVar = _executeSVar.value;
	const executeParams = executeSVar.parsed.params;
	const targets = parseTarget(
		getForgeParam(executeParams, "ValidTgts"),
		undefined,
		changeZoneTargetZone(
			executeParams,
			getForgeParam(executeParams, "DB") === "ChangeZone",
		),
	);
	if (!targets)
		return issue("UNSUPPORTED_TARGET", "unsupported ValidTgts$ value", where);
	const effects = lowerEffectChain(
		resolver,
		executeParams,
		{ nodeId: executeSVar.source.nodeId, line: executeSVar.source.line },
		targets,
		true,
		["DB"],
		triggerEffectPlayer,
		true,
		host,
		null,
	);
	if (!effects.ok) return effects;

	const triggerIndex = host.triggered.length;
	host.triggered.push({
		id: execute,
		text: description,
		condition: { kind: "begin step", player: "either", step: "end" },
		targets,
		effects: effects.value,
	});
	host.hostedTriggeredIndices.add(triggerIndex);
	return ok([
		{
			kind: "create-delayed-trigger",
			ability: abilityId("triggered", host.cardId, triggerIndex),
		},
	]);
}

/* ------------------------------------------------------------------------- */
/* Continuous effects and replacements                                       */
/* ------------------------------------------------------------------------- */

function lowerStatic(
	record:
		| ForgeAbilityRecord
		| { params: ForgeParamList; source: { nodeId: string; line: number } },
): Result<StaticAbilityDefinition, ImportIssue> {
	const params = record.params;
	const where = { nodeId: record.source.nodeId, line: record.source.line };
	const badParams = consumeParams(
		params,
		new Set([
			"mode",
			"affected",
			"addpower",
			"addtoughness",
			"adjustlandplays",
			"validcard",
			"description",
		]),
		where,
	);
	if (!badParams.ok) return badParams;
	const mode = getForgeParam(params, "Mode");
	const description = getForgeParam(params, "Description");
	if (mode === "CantBlock") {
		if (
			getForgeParam(params, "ValidCard") !== "Card.Self" ||
			getForgeParam(params, "Affected") !== undefined ||
			getForgeParam(params, "AddPower") !== undefined ||
			getForgeParam(params, "AddToughness") !== undefined ||
			getForgeParam(params, "AdjustLandPlays") !== undefined ||
			!description
		)
			return issue(
				"UNSUPPORTED_EFFECT",
				"only unconditional CantBlock for Card.Self is supported",
				where,
			);
		return ok({ kind: "cant-block-self", text: description });
	}
	if (mode !== "Continuous")
		return issue(
			"UNSUPPORTED_EFFECT",
			"only supported Continuous and CantBlock statics are implemented",
			where,
		);
	const affected = getForgeParam(params, "Affected");
	const adjustLandPlaysText = getForgeParam(params, "AdjustLandPlays");
	if (adjustLandPlaysText !== undefined) {
		const amount = positiveInteger(adjustLandPlaysText);
		if (
			affected !== "You" ||
			amount === null ||
			getForgeParam(params, "ValidCard") !== undefined ||
			getForgeParam(params, "AddPower") !== undefined ||
			getForgeParam(params, "AddToughness") !== undefined ||
			!description
		)
			return issue(
				"UNSUPPORTED_EFFECT",
				"only finite positive AdjustLandPlays effects affecting You are supported",
				where,
			);
		return ok({
			kind: "adjust-land-plays",
			text: description,
			affects: "you",
			amount,
		});
	}
	const selector = affected ? parseSelector(affected) : null;
	// Forge omits the half it does not change, so `+1/+0` is written as
	// `AddPower$ 1` with no AddToughness$ at all. An omitted half adds 0; a
	// half that is present but not a signed integer — `AddPower$ X` and its
	// kind — still rejects, so a variable pump never lowers as a fixed one.
	const powerText = getForgeParam(params, "AddPower");
	const toughnessText = getForgeParam(params, "AddToughness");
	const addPower = powerText === undefined ? 0 : signedInteger(powerText);
	const addToughness =
		toughnessText === undefined ? 0 : signedInteger(toughnessText);
	if (
		!selector ||
		(powerText === undefined && toughnessText === undefined) ||
		addPower === null ||
		addToughness === null ||
		getForgeParam(params, "ValidCard") !== undefined ||
		!description
	)
		return issue(
			"UNSUPPORTED_EFFECT",
			"unsupported static ability shape",
			where,
		);
	return ok({
		layer: "7c-modify-power-toughness",
		text: description,
		applies(view, _state, source) {
			return (
				source.zone === "battlefield" &&
				objectMatchesPredicate(selector, view, {
					controller: source.controller,
					source: source.id,
				})
			);
		},
		modify(view) {
			if (!("power" in view) || !("toughness" in view)) return;
			view.power += addPower;
			view.toughness += addToughness;
		},
	});
}

function predicateContainsSelf(predicate: ObjectPredicateDef): boolean {
	switch (predicate.kind) {
		case "self":
			return true;
		case "and":
		case "or":
			return predicate.predicates.some(predicateContainsSelf);
		case "not":
			return predicateContainsSelf(predicate.predicate);
		default:
			return false;
	}
}

type ReplacementLowering =
	| { kind: "self-entry" }
	| { kind: "global"; def: ReplacementEffectDefinition };

function lowerCopyEtbKeyword(
	resolver: SVarResolver,
	record: ForgeKeywordRecord,
): Result<ReplacementEffectDefinition, ImportIssue> {
	const where = { nodeId: record.source.nodeId, line: record.source.line };
	if (
		record.segments.length !== 4 ||
		record.segments[1] !== "Copy" ||
		record.segments[3] !== "Optional"
	) {
		return issue(
			"UNSUPPORTED_KEYWORD",
			`unsupported keyword: ${record.raw}`,
			where,
		);
	}
	const svarName = record.segments[2];
	assert(svarName !== undefined);
	const _body = consumeAbilitySVar(resolver, svarName, "ETBReplacement", where);
	if (!_body.ok) return _body;
	const body = _body.value;
	const bodyWhere = { nodeId: body.source.nodeId, line: body.source.line };
	const badParams = consumeParams(
		body.parsed.params,
		new Set(["addtypes", "db", "choices", "spelldescription"]),
		bodyWhere,
	);
	if (!badParams.ok) return badParams;
	const text = getForgeParam(body.parsed.params, "SpellDescription");
	const choices = getForgeParam(body.parsed.params, "Choices");
	const selector = choices ? parseCopySelector(choices) : null;
	const addTypes = getForgeParam(body.parsed.params, "AddTypes");
	if (
		getForgeParam(body.parsed.params, "DB") !== "Clone" ||
		selector === null ||
		(addTypes !== undefined && addTypes !== "Enchantment") ||
		text === undefined
	) {
		return issue(
			"UNSUPPORTED_EFFECT",
			"unsupported ETBReplacement copy body",
			bodyWhere,
		);
	}

	const def: ReplacementEffectDefinition = {
		label: `import:${where.nodeId}`,
		text,
		layer: "copy",
		functionsFrom: "any",
		applies(ev, ctx) {
			return (
				ev.kind === "change zone" &&
				ev.destination.zone === "battlefield" &&
				ev.object === ctx.self?.id &&
				ev.destination.copiableOverride === undefined &&
				ctx.read.state.battlefield.some((id) => {
					const object = getSnapshot(ctx.read, id);
					return (
						object.kind === "permanent" &&
						objectMatchesPredicate(selector, object, {
							controller: ctx.controller,
							source: ctx.self?.id ?? null,
						})
					);
				})
			);
		},
		replace(ev, ctx) {
			assert(ev.kind === "change zone");
			const source = ctx.self;
			assert(source, "copy ETB replacement must have a source");
			const chosenId = ctx.choices.chooseObject(ctx.state, ctx.controller, {
				reason: { kind: "copy", event: ev, source: source.id },
				objects: ctx.read.state.battlefield,
				predicate: {
					definition: selector,
					context: { controller: ctx.controller, source: source.id },
				},
				optional: { label: "Don't copy" },
			});
			if (chosenId === null) return [ev];
			const chosen = getSnapshot(ctx.read, chosenId);
			assert(
				chosen.kind === "permanent",
				"copy-as candidate must be a permanent",
			);
			assert(
				ev.kind === "change zone" && ev.destination.zone === "battlefield",
			);
			const copied = cloneCharacteristics(chosen.copiableValues);
			if (addTypes === "Enchantment" && !copied.types.includes("enchantment"))
				copied.types.push("enchantment");
			return [
				{
					...ev,
					destination: {
						...ev.destination,
						copiableOverride: copied,
					},
				},
			];
		},
	};
	return ok(def);
}

/**
 * The graveyard-to-exile family: `Origin$ Battlefield | Destination$ Graveyard`
 * with a `ReplaceWith$` body that moves the replaced card to exile instead
 * (Samurai of the Pale Curtain, Rest in Peace's second ability).
 *
 * Unlike the entry family below, a replacement here does apply to its own
 * source: CR 614.12 is about an object entering the battlefield, and a Samurai
 * that dies while another one is out is exiled by it, as is the Samurai itself
 * by its own ability. So no self-exclusion is imposed on the selector.
 */
function lowerGraveyardExileReplacement(
	resolver: SVarResolver,
	params: ForgeParamList,
	where: { nodeId: string; line: number },
): Result<ReplacementLowering, ImportIssue> {
	if (
		getForgeParam(params, "Origin") !== "Battlefield" ||
		getForgeParam(params, "ActiveZones") !== "Battlefield" ||
		getForgeParam(params, "ReplacementResult") !== undefined
	)
		return issue("UNSUPPORTED_EFFECT", "unsupported replacement shape", where);

	const validCard = getForgeParam(params, "ValidCard");
	if (validCard === undefined)
		return issue("UNSUPPORTED_PARAMETER", "ValidCard$ is required", where);
	// Only a permanent can leave the battlefield, so Forge's bare `Permanent`
	// restricts nothing beyond the movement matched below and lowers to no
	// selector at all. Anything narrower has to parse.
	const selector = validCard === "Permanent" ? null : parseSelector(validCard);
	if (selector === null && validCard !== "Permanent")
		return issue("UNSUPPORTED_TARGET", "unsupported ValidCard selector", where);

	const replaceWith = getForgeParam(params, "ReplaceWith");
	if (replaceWith === undefined)
		return issue("UNSUPPORTED_REFERENCE", "missing ReplaceWith$", where);
	const _effectSVar = consumeAbilitySVar(
		resolver,
		replaceWith,
		"ReplaceWith",
		where,
	);
	if (!_effectSVar.ok) return _effectSVar;
	const effectSVar = _effectSVar.value;

	const effectParams = effectSVar.parsed.params;
	const effectWhere = {
		nodeId: effectSVar.source.nodeId,
		line: effectSVar.source.line,
	};
	const effectBad = consumeParams(
		effectParams,
		new Set(["db", "origin", "destination", "defined"]),
		effectWhere,
	);
	if (!effectBad.ok) return effectBad;
	if (
		getForgeParam(effectParams, "DB") !== "ChangeZone" ||
		getForgeParam(effectParams, "Origin") !== "Battlefield" ||
		getForgeParam(effectParams, "Destination") !== "Exile" ||
		getForgeParam(effectParams, "Defined") !== "ReplacedCard"
	)
		return issue(
			"UNSUPPORTED_EFFECT",
			"unsupported ReplaceWith effect body",
			effectWhere,
		);

	const description =
		getForgeParam(params, "Description") ??
		"If a permanent would be put into a graveyard, exile it instead.";
	const def: ReplacementEffectDefinition = {
		label: `import:${where.nodeId}`,
		text: description,
		layer: "other",
		functionsFrom: "any",
		applies(ev, ctx) {
			if (
				ctx.self?.zone !== "battlefield" ||
				ev.kind !== "change zone" ||
				ev.from !== "battlefield" ||
				ev.destination.zone !== "graveyard"
			)
				return false;
			if (selector === null) return true;
			// The permanent is still on the battlefield while the replacement is
			// evaluated, so its current characteristics are what the selector
			// reads (CR 608.2h's last known information is not needed yet).
			return objectMatchesPredicate(
				selector,
				getSnapshot(ctx.read, ev.object),
				{
					controller: ctx.controller,
					source: ctx.self.id,
				},
			);
		},
		// `from !== null` excludes a token's creation event, which shares the
		// change-zone kind but must keep its battlefield destination.
		replace: (ev: GameEvent) =>
			ev.kind === "change zone" &&
			ev.from !== null &&
			ev.destination.zone === "graveyard"
				? [{ ...ev, destination: { zone: "exile" } }]
				: [ev],
	};
	return ok({ kind: "global", def });
}

/**
 * Two canonical enters-tapped shapes share `Event$ Moved | ... | ReplaceWith$`:
 *
 * - The self form (Charcoal Diamond, Diregraf Ghoul) has no `ActiveZones$`,
 *   `ValidCard$ Card.Self`, and its body reads `Defined$ Self`. It lowers
 *   directly to `CardDefInput.entersTapped`; `defineCard` then synthesizes
 *   one ordinary self-scoped replacement from that (see
 *   `printedEntryReplacements`). No `K:` keyword expresses this rule.
 * - The global form (Root Maze, Blind Obedience) has `ActiveZones$
 *   Battlefield`, a supported `ValidCard$` selector, and its body reads
 *   `Defined$ ReplacedCard`. Per CR 614.12, a general effect (one that would
 *   affect a subset of objects rather than only its own source) never applies
 *   to its own source's entry, which is why the engine's callback below gates
 *   on the source already being on the battlefield. Self-containing selectors
 *   with explicit `ActiveZones$` are outside this importer's subset and are
 *   rejected.
 */
function lowerReplacement(
	resolver: SVarResolver,
	record:
		| ForgeAbilityRecord
		| { params: ForgeParamList; source: { nodeId: string; line: number } },
): Result<ReplacementLowering, ImportIssue> {
	const params = record.params;
	const where = { nodeId: record.source.nodeId, line: record.source.line };
	const badParams = consumeParams(
		params,
		new Set([
			"event",
			"validcard",
			"origin",
			"destination",
			"replacewith",
			"replacementresult",
			"activezones",
			"description",
		]),
		where,
	);
	if (!badParams.ok) return badParams;
	if (getForgeParam(params, "Event") !== "Moved")
		return issue("UNSUPPORTED_EFFECT", "unsupported replacement shape", where);
	// The two families split on where the replaced movement was headed: into
	// play (enters tapped, below) or into a graveyard (exiled instead).
	if (getForgeParam(params, "Destination") === "Graveyard")
		return lowerGraveyardExileReplacement(resolver, params, where);
	if (
		getForgeParam(params, "Destination") !== "Battlefield" ||
		getForgeParam(params, "Origin") !== undefined ||
		getForgeParam(params, "ReplacementResult") !== "Updated"
	)
		return issue("UNSUPPORTED_EFFECT", "unsupported replacement shape", where);
	const validCard = getForgeParam(params, "ValidCard");
	if (validCard === undefined)
		return issue("UNSUPPORTED_PARAMETER", "ValidCard$ is required", where);
	const replaceWith = getForgeParam(params, "ReplaceWith");
	if (replaceWith === undefined)
		return issue("UNSUPPORTED_REFERENCE", "missing ReplaceWith$", where);
	const effectSVar = consumeAbilitySVar(
		resolver,
		replaceWith,
		"ReplaceWith",
		where,
	);
	if (!effectSVar.ok) return effectSVar;
	const effectParams = effectSVar.value.parsed.params;
	const effectWhere = {
		nodeId: effectSVar.value.source.nodeId,
		line: effectSVar.value.source.line,
	};
	const effectBad = consumeParams(
		effectParams,
		new Set(["db", "etb", "defined"]),
		effectWhere,
	);
	if (!effectBad.ok) return effectBad;
	if (
		getForgeParam(effectParams, "DB") !== "Tap" ||
		getForgeParam(effectParams, "ETB") !== "True"
	)
		return issue(
			"UNSUPPORTED_EFFECT",
			"unsupported ReplaceWith effect body",
			effectWhere,
		);

	const activeZones = getForgeParam(params, "ActiveZones");
	const isSelfForm =
		(validCard === "Card.Self" || validCard === "Self") &&
		activeZones === undefined;
	if (isSelfForm) {
		if (getForgeParam(effectParams, "Defined") !== "Self")
			return issue(
				"UNSUPPORTED_EFFECT",
				"unsupported self ReplaceWith effect body",
				effectWhere,
			);
		return ok({ kind: "self-entry" });
	}

	if (activeZones !== "Battlefield")
		return issue("UNSUPPORTED_EFFECT", "unsupported replacement shape", where);
	if (getForgeParam(effectParams, "Defined") !== "ReplacedCard")
		return issue(
			"UNSUPPORTED_EFFECT",
			"unsupported ReplaceWith effect body",
			effectWhere,
		);
	const selector = parseSelector(validCard);
	if (!selector || predicateContainsSelf(selector))
		return issue("UNSUPPORTED_TARGET", "unsupported ValidCard selector", where);
	const description = getForgeParam(params, "Description") ?? "Enters tapped.";
	const def: ReplacementEffectDefinition = {
		label: `import:${where.nodeId}`,
		text: description,
		layer: "other",
		functionsFrom: "any",
		applies(ev, ctx) {
			// CR 614.12: a replacement affecting a general subset that happens to
			// include its own source (rather than affecting only that source)
			// does not apply to that source's own entry. The source must already
			// be on the battlefield; it is never let through as the very object
			// entering in `ev`, even if some other effect would make it match
			// `selector` (e.g. Root Maze made into an artifact by something else
			// while it enters stays untapped, absent a *different* copy already
			// on the battlefield).
			if (
				ctx.self?.zone !== "battlefield" ||
				ev.kind !== "change zone" ||
				ev.destination.zone !== "battlefield" ||
				ev.destination.tapped
			)
				return false;
			return objectMatchesPredicate(
				selector,
				ctx.read.engine.etbPreview(ctx.state, ev),
				{
					controller: ctx.controller,
					source: ctx.self.id,
				},
			);
		},
		replace: (ev: GameEvent) =>
			ev.kind === "change zone" && ev.destination.zone === "battlefield"
				? [{ ...ev, destination: { ...ev.destination, tapped: true } }]
				: [ev],
	};
	return ok({ kind: "global", def });
}

/* ------------------------------------------------------------------------- */
/* Triggers                                                                   */
/* ------------------------------------------------------------------------- */

function lowerTrigger(
	resolver: SVarResolver,
	record: { params: ForgeParamList; source: { nodeId: string; line: number } },
	abilityHost: AbilityHost,
): Result<TriggeredAbilityDefinition, ImportIssue> {
	const params = record.params;
	const where = { nodeId: record.source.nodeId, line: record.source.line };
	const mode = getForgeParam(params, "Mode");
	const execute = getForgeParam(params, "Execute");
	const text = getForgeParam(params, "TriggerDescription");
	if (!mode || !execute || !text)
		return issue(
			"UNSUPPORTED_EFFECT",
			"trigger requires Mode$/Execute$/TriggerDescription$",
			where,
		);

	const _executeSVar = consumeAbilitySVar(resolver, execute, "Execute", where);
	if (!_executeSVar.ok) return _executeSVar;
	const executeSVar = _executeSVar.value;
	const executeParams = executeSVar.parsed.params;

	const optionalDecider = getForgeParam(params, "OptionalDecider");
	if (optionalDecider !== undefined && optionalDecider !== "You")
		return issue(
			"UNSUPPORTED_EFFECT",
			"only OptionalDecider$ You is supported",
			where,
		);

	const isSelfDeparture =
		mode === "ChangesZone" &&
		getForgeParam(params, "Origin") === "Battlefield" &&
		getForgeParam(params, "ValidCard") === "Card.Self";
	// An effect can name the object its own departure created only when the
	// trigger declares one destination to look in. `Destination$ Any` declares
	// none, and a destination outside the public zones holds no object an
	// effect could name.
	const departureDestination = isSelfDeparture
		? (PUBLIC_ZONES.get(getForgeParam(params, "Destination") ?? "") ?? null)
		: null;
	const isSelfGraveyardArrival =
		mode === "ChangesZone" &&
		getForgeParam(params, "Origin") === "Any" &&
		getForgeParam(params, "Destination") === "Graveyard" &&
		getForgeParam(params, "ValidCard") === "Card.Self";
	// The trigger declares targets on its executed ability. Parse them before
	// effects so every effect is checked as it is constructed.
	const targets = parseTarget(
		getForgeParam(executeParams, "ValidTgts"),
		undefined,
		changeZoneTargetZone(
			executeParams,
			getForgeParam(executeParams, "DB") === "ChangeZone",
		),
	);
	if (!targets)
		return issue("UNSUPPORTED_TARGET", "unsupported ValidTgts$ value", where);
	const chain = lowerEffectChain(
		resolver,
		executeParams,
		{ nodeId: executeSVar.source.nodeId, line: executeSVar.source.line },
		targets,
		true,
		["DB"],
		mode === "SpellCast"
			? spellCastEffectPlayer
			: isSelfDeparture
				? selfDepartureEffectPlayer
				: triggerEffectPlayer,
		true,
		abilityHost,
		isSelfGraveyardArrival ? "graveyard" : departureDestination,
	);
	if (!chain.ok) return chain;
	const effects = optionalDecider
		? [
				{
					kind: "may" as const,
					decider: "you" as const,
					effects: chain.value,
				},
			]
		: chain.value;

	// Each mode claims the trigger record's whole parameter list. Mode$,
	// Execute$, and TriggerDescription$ are required of every trigger and were
	// read above, so a mode states only the keys that are its own — including
	// the ones it deliberately omits, such as Attacks rejecting TriggerZones$.
	const claim = (...keys: string[]) =>
		consumeParams(
			params,
			new Set(["mode", "execute", "triggerdescription", ...keys]),
			where,
		);
	switch (mode) {
		case "SpellCast": {
			const badParams = claim(
				"validcard",
				"validactivatingplayer",
				"triggerzones",
				"secondary",
				"optionaldecider",
			);
			if (!badParams.ok) return badParams;
			// Forge's `Secondary$ True` marks a trigger whose printed text is
			// already covered by an earlier trigger's description, as on the two
			// halves of "When CARDNAME enters and whenever you cast...". It says
			// nothing about how the trigger works, so it only has to be the flag
			// it claims to be.
			const secondary = getForgeParam(params, "Secondary");
			if (secondary !== undefined && secondary !== "True")
				return issue("UNSUPPORTED_PARAMETER", "Secondary$ must be True", where);
			const triggerZones = getForgeParam(params, "TriggerZones");
			const rawSelector = getForgeParam(params, "ValidCard");
			const rawPlayer = getForgeParam(params, "ValidActivatingPlayer");
			const selfCast = rawSelector === "Card.Self" || rawSelector === "Self";
			const castPlayer = rawPlayer
				? parseValidPlayer(rawPlayer)
				: selfCast
					? "you"
					: null;
			if (castPlayer === null || (selfCast && castPlayer !== "you"))
				return issue(
					"UNSUPPORTED_PARAMETER",
					"SpellCast requires a supported ValidActivatingPlayer$",
					where,
				);
			if (
				selfCast
					? triggerZones !== undefined && triggerZones !== "Stack"
					: triggerZones !== "Battlefield"
			)
				return issue(
					"UNSUPPORTED_EFFECT",
					"SpellCast triggers must function from the battlefield, or be an exact self-cast trigger from the stack",
					where,
				);

			// An omitted `ValidCard$`, or the bare `Card` spelling, watches every
			// spell cast, so the condition carries no selector. Bare `Permanent`
			// would need to exclude instant and sorcery spells, which the selector
			// vocabulary cannot express, so it still rejects.
			let selector: ObjectPredicateDef | undefined;
			if (rawSelector !== undefined && rawSelector !== "Card") {
				const parsed = parseSelector(rawSelector);
				if (parsed === null)
					return issue(
						"UNSUPPORTED_PARAMETER",
						"SpellCast requires a supported ValidCard$ selector",
						where,
					);
				selector = parsed;
			}

			return ok({
				id: execute,
				text,
				...(selfCast ? { functionsFrom: ["stack"] as ["stack"] } : {}),
				condition:
					selector === undefined
						? { kind: "cast", player: castPlayer }
						: { kind: "cast", player: castPlayer, predicate: selector },
				targets,
				effects,
			});
		}
		case "Cycled": {
			const badParams = claim(
				"validcard",
				"validplayer",
				"triggerzones",
				"secondary",
				"optionaldecider",
			);
			if (!badParams.ok) return badParams;
			const rawSelector = getForgeParam(params, "ValidCard");
			const selector = rawSelector ? parseSelector(rawSelector) : null;
			if (
				selector === null ||
				rawSelector?.includes("YouCtrl") ||
				rawSelector?.includes("OppCtrl")
			)
				return issue(
					"UNSUPPORTED_PARAMETER",
					"Cycled requires a supported ownership-based ValidCard$ selector",
					where,
				);
			const rawPlayer = getForgeParam(params, "ValidPlayer");
			const cyclingPlayer =
				rawPlayer === undefined ? "either" : parseValidPlayer(rawPlayer);
			if (cyclingPlayer === null)
				return issue(
					"UNSUPPORTED_PARAMETER",
					`unsupported ValidPlayer$ ${rawPlayer}`,
					where,
				);
			const secondary = getForgeParam(params, "Secondary");
			if (secondary !== undefined && secondary !== "True")
				return issue("UNSUPPORTED_PARAMETER", "Secondary$ must be True", where);
			const triggerZone = getForgeParam(params, "TriggerZones");
			let functionsFrom: ["battlefield" | "graveyard"];
			if (triggerZone === "Battlefield") functionsFrom = ["battlefield"];
			else if (triggerZone === "Graveyard") functionsFrom = ["graveyard"];
			else if (
				triggerZone === undefined &&
				(rawSelector === "Card.Self" || rawSelector === "Self")
			)
				functionsFrom = ["graveyard"];
			else
				return issue(
					"UNSUPPORTED_EFFECT",
					"Cycled triggers must function from an explicit supported zone or from the cycled card's graveyard object",
					where,
				);
			return ok({
				id: execute,
				text,
				condition: {
					kind: "cycle",
					player: cyclingPlayer,
					predicate: selector,
				},
				functionsFrom,
				targets,
				effects,
			});
		}
		case "Sacrificed": {
			const badParams = claim(
				"validcard",
				"validplayer",
				"triggerzones",
				"optionaldecider",
			);
			if (!badParams.ok) return badParams;
			const triggerZones = getForgeParam(params, "TriggerZones");
			if (triggerZones !== undefined && triggerZones !== "Battlefield")
				return issue(
					"UNSUPPORTED_EFFECT",
					"Sacrificed triggers must function from the battlefield",
					where,
				);
			const rawSelector = getForgeParam(params, "ValidCard");
			const selector = rawSelector ? parseSelector(rawSelector) : null;
			if (selector === null)
				return issue(
					"UNSUPPORTED_PARAMETER",
					"Sacrificed requires a supported ValidCard$ selector",
					where,
				);
			const rawPlayer = getForgeParam(params, "ValidPlayer");
			const sacrificingPlayer = rawPlayer
				? parseValidPlayer(rawPlayer)
				: "either";
			if (sacrificingPlayer === null)
				return issue(
					"UNSUPPORTED_PARAMETER",
					`unsupported ValidPlayer$ ${rawPlayer}`,
					where,
				);
			return ok({
				id: execute,
				text,
				condition: {
					kind: "sacrifice",
					player: sacrificingPlayer,
					predicate: selector,
				},
				targets,
				effects,
			});
		}
		case "ChangesZone": {
			const badParams = claim(
				"origin",
				"destination",
				"validcard",
				"triggerzones",
				"secondary",
				"optionaldecider",
				"triggercontroller",
			);
			if (!badParams.ok) return badParams;
			const triggerZones = getForgeParam(params, "TriggerZones");
			const secondary = getForgeParam(params, "Secondary");
			const triggerController = getForgeParam(params, "TriggerController");
			const origin = getForgeParam(params, "Origin");
			const destination = getForgeParam(params, "Destination");
			// The trigger watches the battlefield either way: an
			// enters-the-battlefield trigger from any zone, or a departure from
			// the battlefield. Forge omits TriggerZones on the latter, which
			// matches the engine's battlefield-by-default functionsFrom. Forge
			// also omits Origin$ on some enters-the-battlefield triggers (Priest
			// of Ancient Lore), which defaults to Any.
			const etb = (origin ?? "Any") === "Any" && destination === "Battlefield";
			// A departure is one event whatever its destination: "dies" is the
			// graveyard spelling of it, and the rest of them have no such name.
			const departure =
				origin === "Battlefield"
					? (BATTLEFIELD_DEPARTURES.get(destination ?? "") ?? null)
					: null;
			const selfGraveyardArrival =
				origin === "Any" &&
				destination === "Graveyard" &&
				getForgeParam(params, "ValidCard") === "Card.Self";
			if (
				!(etb || departure !== null || selfGraveyardArrival) ||
				(triggerZones !== undefined &&
					triggerZones !==
						(selfGraveyardArrival ? "Graveyard" : "Battlefield")) ||
				(secondary !== undefined && secondary !== "True") ||
				(triggerController !== undefined &&
					(departure === null ||
						triggerController !== "TriggeredCardController"))
			)
				return issue(
					"UNSUPPORTED_EFFECT",
					"unsupported ChangesZone trigger shape",
					where,
				);
			const rawSelector = getForgeParam(params, "ValidCard");
			const selector = rawSelector ? parseSelector(rawSelector) : null;
			if (selector === null)
				return issue(
					"UNSUPPORTED_PARAMETER",
					"ChangesZone requires a supported ValidCard$ selector",
					where,
				);
			return ok({
				id: execute,
				text,
				condition:
					departure !== null
						? {
								kind: "change zone",
								from: "battlefield",
								to: departure,
								predicate: selector,
							}
						: selfGraveyardArrival
							? {
									kind: "change zone",
									from: "any",
									to: "graveyard",
									predicate: selector,
								}
							: {
									kind: "change zone",
									from: "any",
									to: "battlefield",
									predicate: selector,
								},
				...(selfGraveyardArrival
					? { functionsFrom: ["graveyard"] as ["graveyard"] }
					: {}),
				targets,
				effects,
			});
		}
		case "Phase": {
			const badParams = claim(
				"phase",
				"validplayer",
				"triggerzones",
				"optionaldecider",
			);
			if (!badParams.ok) return badParams;
			if (
				getForgeParam(params, "Phase") !== "Upkeep" ||
				getForgeParam(params, "TriggerZones") !== "Battlefield"
			)
				return issue(
					"UNSUPPORTED_EFFECT",
					"unsupported Phase trigger shape",
					where,
				);
			const rawPlayer = getForgeParam(params, "ValidPlayer");
			if (rawPlayer === undefined)
				return issue(
					"UNSUPPORTED_PARAMETER",
					"ValidPlayer$ is required",
					where,
				);
			const player = parseValidPlayer(rawPlayer);
			if (player === null)
				return issue(
					"UNSUPPORTED_PARAMETER",
					`unsupported ValidPlayer$ ${rawPlayer}`,
					where,
				);
			return ok({
				id: execute,
				text,
				condition: { kind: "begin step", player, step: "upkeep" },
				targets,
				effects,
			});
		}
		case "Drawn": {
			const badParams = claim(
				"validcard",
				"number",
				"firstcardindrawstep",
				"triggerzones",
				"optionaldecider",
			);
			if (!badParams.ok) return badParams;
			// Sneaky Snacker is the first graveyard-sourced Drawn trigger: it
			// functions from its owner's graveyard, so only that single zone (or
			// the default battlefield) is accepted, not a comma-separated list.
			const triggerZones = getForgeParam(params, "TriggerZones");
			if (
				triggerZones !== undefined &&
				triggerZones !== "Battlefield" &&
				triggerZones !== "Graveyard"
			)
				return issue(
					"UNSUPPORTED_EFFECT",
					"only battlefield and graveyard Drawn triggers are supported",
					where,
				);
			// Forge matches the drawn card, but a card is only ever drawn from
			// its owner's library into that same player's hand, so the card's
			// controller and owner are both the player who drew it. The engine's
			// draw trigger asks for that player directly.
			const rawSelector = getForgeParam(params, "ValidCard");
			const drawPlayer = parseDrawnPlayer(rawSelector);
			if (drawPlayer === null)
				return issue(
					"UNSUPPORTED_PARAMETER",
					`unsupported Drawn ValidCard$ ${rawSelector}`,
					where,
				);
			// Number$ N fires only on the Nth draw of the turn — an equality, not a
			// threshold (Red Ghost Intangible Genius, Sneaky Snacker).
			const numberText = getForgeParam(params, "Number");
			const nth =
				numberText === undefined ? undefined : positiveInteger(numberText);
			if (nth === null)
				return issue(
					"UNSUPPORTED_PARAMETER",
					"Drawn Number$ must be a positive integer",
					where,
				);
			// FirstCardInDrawStep$ False is Xyris's "except the first one they
			// draw in each of their draw steps". The True form (Notion Thief and
			// friends) matches only the first draw-step card; nothing in the
			// corpus needs it yet, so it is rejected rather than half-supported.
			const firstCardInDrawStep = getForgeParam(params, "FirstCardInDrawStep");
			if (firstCardInDrawStep !== undefined && firstCardInDrawStep !== "False")
				return issue(
					"UNSUPPORTED_PARAMETER",
					"only FirstCardInDrawStep$ False is supported",
					where,
				);
			// The engine's condition holds one qualifier, so a script naming
			// both count forms cannot lower. No corpus card combines them.
			if (nth !== undefined && firstCardInDrawStep !== undefined)
				return issue(
					"UNSUPPORTED_PARAMETER",
					"a Drawn trigger cannot combine Number$ and FirstCardInDrawStep$",
					where,
				);
			const qualifier =
				nth !== undefined
					? { nth }
					: firstCardInDrawStep !== undefined
						? "except-first-in-draw-step"
						: undefined;
			// A graveyard Drawn trigger functions with a card as its source, so
			// the only effect the engine can resolve from there is the source
			// reanimating itself: ChangeZone Graveyard -> Battlefield. Everything
			// else assumes a permanent source (Cellar Coatl's self PutCounter) and
			// would resolve to a silent no-op, so reject it here.
			if (triggerZones === "Graveyard") {
				const reanimation = effects.every(
					(effect) =>
						effect.kind === "change-zone" &&
						effect.subject.kind === "source" &&
						effect.from === "graveyard" &&
						effect.destination.zone === "battlefield",
				);
				if (!reanimation)
					return issue(
						"UNSUPPORTED_EFFECT",
						"a graveyard Drawn trigger can only reanimate its source",
						where,
					);
			}
			return ok({
				id: execute,
				text,
				condition: {
					kind: "draw",
					player: drawPlayer,
					...(qualifier !== undefined ? { qualifier } : {}),
				},
				targets,
				effects,
				...(triggerZones === "Graveyard"
					? { functionsFrom: ["graveyard"] }
					: {}),
			});
		}
		case "Attacks": {
			const badParams = claim("validcard", "triggerzones");
			if (!badParams.ok) return badParams;
			if (
				getForgeParam(params, "ValidCard") !== "Card.Self" ||
				(getForgeParam(params, "TriggerZones") !== undefined &&
					getForgeParam(params, "TriggerZones") !== "Battlefield")
			)
				return issue(
					"UNSUPPORTED_EFFECT",
					"unsupported Attacks trigger shape",
					where,
				);
			return ok({
				id: execute,
				text,
				condition: { kind: "declare attackers", predicate: { kind: "self" } },
				targets,
				effects,
			});
		}
		case "DamageDone": {
			const badParams = claim(
				"validsource",
				"validtarget",
				"combatdamage",
				"triggerzones",
				"optionaldecider",
			);
			if (!badParams.ok) return badParams;
			const triggerZones = getForgeParam(params, "TriggerZones");
			if (
				getForgeParam(params, "ValidSource") !== "Card.Self" ||
				getForgeParam(params, "ValidTarget") !== "Player" ||
				getForgeParam(params, "CombatDamage") !== "True" ||
				(triggerZones !== undefined && triggerZones !== "Battlefield")
			)
				return issue(
					"UNSUPPORTED_EFFECT",
					"unsupported DamageDone trigger shape",
					where,
				);
			return ok({
				id: execute,
				text,
				condition: {
					kind: "damage",
					source: "self",
					recipient: "player",
					combat: true,
				},
				targets,
				effects,
			});
		}
		default:
			return issue(
				"UNSUPPORTED_KEYWORD",
				`unsupported trigger mode ${mode}`,
				where,
			);
	}
}

/* ------------------------------------------------------------------------- */
/* Mana costs, and the costs an ability is activated for                     */
/* ------------------------------------------------------------------------- */

function parseManaCost(text: string): CardDefInput["manaCost"] | null {
	if (text === "no cost") return "none";
	if (text === "0") return "zero";
	const result: Record<ManaCostType, number> = {
		n: 0,
		c: 0,
		w: 0,
		u: 0,
		b: 0,
		r: 0,
		g: 0,
	};
	for (const symbol of text.split(/\s+/).filter(Boolean)) {
		if (/^[1-9]\d*$/.test(symbol)) {
			const generic = Number(symbol);
			if (!Number.isSafeInteger(generic)) return null;
			result.n += generic;
		} else if (
			symbol === "W" ||
			symbol === "U" ||
			symbol === "B" ||
			symbol === "R" ||
			symbol === "G" ||
			// {C}: a colorless requirement, not generic. Kozilek and friends.
			symbol === "C"
		)
			result[symbol.toLowerCase() as ManaType] += 1;
		else return null;
	}
	const total = MANA_COST_TYPES.reduce((sum, type) => sum + result[type], 0);
	if (total === 0 || !Number.isSafeInteger(total)) return null;
	const out: Exclude<CardDefInput["manaCost"], "none" | "zero"> = {};
	for (const type of MANA_COST_TYPES) {
		if (result[type] > 0) out[type] = result[type];
	}
	return out;
}

function parseActivationCost(
	text: string | undefined,
	where: { nodeId?: string; line?: number },
): Result<ActivationCost, ImportIssue> {
	if (text === undefined || text === "") {
		return issue(
			"UNSUPPORTED_COST",
			"malformed activation cost: expected mana and/or T",
			where,
		);
	}

	const terms: string[] = [];
	let term = "";
	let insideAngleBrackets = false;
	for (const character of text) {
		if (character === " " && !insideAngleBrackets) {
			terms.push(term);
			term = "";
			continue;
		}
		term += character;
		if (character === "<") insideAngleBrackets = true;
		if (character === ">") insideAngleBrackets = false;
	}
	terms.push(term);

	const mana: Exclude<ActivationCost["mana"], "zero"> = {};
	let tapSelf = false;
	let sacrifice: ActivationCost["sacrifice"];
	let discard: ActivationCost["discard"];
	let life: ActivationCost["life"];
	// `0` is the whole mana cost when it appears, so a term of it may be written
	// once and never beside another mana term. The terms are counted here and
	// judged together once the list has been read.
	let zeroTerms = 0;
	let sawMana = false;
	for (const term of terms) {
		if (term === "") {
			return issue(
				"UNSUPPORTED_COST",
				"malformed activation cost: empty term",
				where,
			);
		}
		if (term === "T") {
			if (tapSelf) {
				return issue(
					"UNSUPPORTED_COST",
					"malformed activation cost: duplicate T term",
					where,
				);
			}
			tapSelf = true;
			continue;
		}
		if (
			term === "W" ||
			term === "U" ||
			term === "B" ||
			term === "R" ||
			term === "G"
		) {
			const type = term.toLowerCase() as "w" | "u" | "b" | "r" | "g";
			mana[type] = (mana[type] ?? 0) + 1;
			sawMana = true;
			continue;
		}
		const sacrificeMatch = term.match(/^Sac<1\/([^/]+)(?:\/[^>]*)?>$/);
		if (sacrificeMatch) {
			if (sacrifice) {
				return issue(
					"UNSUPPORTED_COST",
					"multiple sacrifice activation costs are unsupported",
					where,
				);
			}
			const selectorText = sacrificeMatch[1];
			assert(selectorText !== undefined);
			const selectorChoices: ObjectPredicateDef[] = [];
			for (const choice of selectorText.split(";")) {
				if (choice === "CARDNAME") {
					selectorChoices.push({ kind: "self" });
					continue;
				}
				const parsed = parseSelectorChoice(choice);
				if (!parsed) {
					return issue(
						"UNSUPPORTED_COST",
						`unsupported sacrifice selector ${selectorText}`,
						where,
					);
				}
				selectorChoices.push(parsed);
			}
			sacrifice = {
				predicate: combinePredicates("or", selectorChoices),
				amount: 1,
			};
			continue;
		}
		// Forge writes the printed "Discard a card" as one card of any kind,
		// with an optional trailing description as in Sac<1/CARDNAME/this token>.
		// Nothing narrower (a type, a named card, more than one) is supported.
		if (term.startsWith("Discard<")) {
			if (!/^Discard<1\/Card(?:\/[^>]*)?>$/.test(term)) {
				return issue(
					"UNSUPPORTED_COST",
					`unsupported discard activation cost term ${term}`,
					where,
				);
			}
			if (discard) {
				return issue(
					"UNSUPPORTED_COST",
					"multiple discard activation costs are unsupported",
					where,
				);
			}
			discard = { amount: 1 };
			continue;
		}
		const lifeMatch = term.match(/^PayLife<([1-9]\d*)>$/);
		if (lifeMatch) {
			if (life) {
				return issue(
					"UNSUPPORTED_COST",
					"multiple life payment costs are unsupported",
					where,
				);
			}
			const amount = Number(lifeMatch[1]);
			if (!Number.isSafeInteger(amount)) {
				return issue(
					"UNSUPPORTED_COST",
					`unsupported life payment cost term ${term}: quantity is not a safe integer`,
					where,
				);
			}
			life = { amount };
			continue;
		}
		if (/^\d+$/.test(term)) {
			if (term !== "0" && term.startsWith("0")) {
				return issue(
					"UNSUPPORTED_COST",
					`malformed generic activation cost term ${term}`,
					where,
				);
			}
			const amount = Number(term);
			if (!Number.isSafeInteger(amount)) {
				return issue(
					"UNSUPPORTED_COST",
					`unsupported generic activation cost term ${term}: quantity is not a safe integer`,
					where,
				);
			}
			if (amount === 0) {
				zeroTerms += 1;
				continue;
			}
			const generic = (mana.n ?? 0) + amount;
			if (!Number.isSafeInteger(generic)) {
				return issue(
					"UNSUPPORTED_COST",
					`unsupported generic activation cost term ${term}: total is not a safe integer`,
					where,
				);
			}
			mana.n = generic;
			sawMana = true;
			continue;
		}
		return issue(
			"UNSUPPORTED_COST",
			`unsupported activation cost term ${term}`,
			where,
		);
	}

	if (zeroTerms > 0 && (sawMana || zeroTerms > 1)) {
		return issue(
			"UNSUPPORTED_COST",
			"malformed activation cost: 0 cannot be combined with other mana terms",
			where,
		);
	}

	return ok({
		mana: sawMana ? mana : "zero",
		tapSelf,
		...(sacrifice ? { sacrifice } : {}),
		...(discard ? { discard } : {}),
		...(life ? { life } : {}),
	});
}

/**
 * Whether a spell's `Cost$` mana terms are the card's printed mana cost.
 *
 * Forge repeats the mana cost inside `Cost$` and appends the additional costs
 * after it, so the two must agree. They are separate parses of separate lines,
 * and a disagreement means the importer has misread one of them — charging the
 * `Cost$` mana on top of `ManaCost:` would double the spell's price.
 *
 * `{C}` has no activation-cost spelling, so a colorless requirement can never
 * be restated and is rejected here rather than silently dropped.
 */
function restatesManaCost(
	restated: PayableActivationManaCost,
	printed: CardDefInput["manaCost"],
): boolean {
	if (printed === "none") return false;
	if (printed === "zero") return restated === "zero";
	if (restated === "zero") return false;
	if ((printed.c ?? 0) > 0) return false;
	return (["w", "u", "b", "r", "g", "n"] as const).every(
		(type) => (restated[type] ?? 0) === (printed[type] ?? 0),
	);
}

function manaCostColors(mana: CardDefInput["manaCost"]): Color[] {
	if (mana === "none" || mana === "zero") return [];
	return (["w", "u", "b", "r", "g"] as const).filter(
		(color) => (mana[color] ?? 0) > 0,
	);
}

function fullMana(produced: ManaType, amount = 1): ManaPool {
	return {
		w: produced === "w" ? amount : 0,
		u: produced === "u" ? amount : 0,
		b: produced === "b" ? amount : 0,
		r: produced === "r" ? amount : 0,
		g: produced === "g" ? amount : 0,
		c: produced === "c" ? amount : 0,
	};
}

/* ------------------------------------------------------------------------- */
/* Whole-card lowering                                                       */
/* ------------------------------------------------------------------------- */

function countKey(face: ForgeFaceAst, key: string): number {
	return face.characteristics.all.filter((d) => d.key.trim() === key).length;
}

export function lowerForgeCard(
	ast: ForgeCardAst,
	options: { id: string },
): ImportResult {
	const { id } = options;
	if (!id)
		return reject(issue("UNSUPPORTED_FACE", "an explicit id is required"));

	for (const directive of ast.cardDirectives) {
		if (!ALLOWED_CARD_DIRECTIVES.has(directive.key.trim())) {
			return reject(
				issue(
					"UNSUPPORTED_KEYWORD",
					`unsupported card directive ${directive.key}`,
					{
						nodeId: directive.nodeId,
						line: directive.line,
					},
				),
			);
		}
	}

	if (ast.faces.length !== 1) {
		return reject(
			issue(
				"UNSUPPORTED_FACE",
				"cards with alternate/specialize faces are not supported",
			),
		);
	}
	const face = ast.faces[0] as ForgeFaceAst;
	if (face.state !== "original") {
		return reject(
			issue("UNSUPPORTED_FACE", "only the original face is supported"),
		);
	}
	if (face.draftActions.length > 0) {
		return reject(
			issue("UNSUPPORTED_KEYWORD", "Draft$ actions are not supported"),
		);
	}
	if (face.variants.length > 0) {
		return reject(
			issue("UNSUPPORTED_KEYWORD", "Variant$ patches are not supported"),
		);
	}
	if (face.otherDirectives.length > 0) {
		const other = face.otherDirectives[0];
		if (other) {
			return reject(
				issue("UNSUPPORTED_KEYWORD", `unknown directive ${other.key}`, {
					nodeId: other.nodeId,
					line: other.line,
				}),
			);
		}
	}
	if (face.characteristics.copyFaceFrom) {
		return reject(issue("UNSUPPORTED_FACE", "CopyFaceFrom is not supported"));
	}
	for (const characteristic of [
		"loyalty",
		"defense",
		"attractionLights",
	] as const) {
		const ref = face.characteristics[characteristic];
		if (ref) {
			return reject(
				issue("UNSUPPORTED_PARAMETER", `${ref.key} is not supported`, {
					nodeId: ref.nodeId,
					line: ref.line,
				}),
			);
		}
	}
	for (const node of ast.document.nodes) {
		if (node.kind === "malformed") {
			return reject(
				issue("UNSUPPORTED_PARAMETER", `malformed source line: ${node.raw}`, {
					nodeId: node.id,
					line: node.line,
				}),
			);
		}
		if (node.kind === "face-marker") {
			return reject(
				issue("UNSUPPORTED_FACE", `unsupported face marker ${node.marker}`, {
					nodeId: node.id,
					line: node.line,
				}),
			);
		}
	}

	for (const key of ["Name", "ManaCost", "Types", "Colors", "PT"]) {
		if (countKey(face, key) > 1) {
			return reject(
				issue("UNSUPPORTED_PARAMETER", `duplicate ${key} directive`),
			);
		}
	}

	const nameRef = face.characteristics.name;
	if (!nameRef || nameRef.value === "") {
		return reject(issue("UNSUPPORTED_PARAMETER", "Name$ is required"));
	}
	const name = nameRef.value;

	const manaCostRef = face.characteristics.manaCost;
	const manaCost = manaCostRef ? parseManaCost(manaCostRef.value) : null;
	if (!manaCost) {
		return reject(
			issue(
				"UNSUPPORTED_COST",
				`unsupported mana cost: ${manaCostRef?.value ?? ""}`,
				{
					nodeId: manaCostRef?.nodeId,
					line: manaCostRef?.line,
				},
			),
		);
	}

	const typesRef = face.characteristics.types;
	if (!typesRef)
		return reject(issue("UNSUPPORTED_PARAMETER", "Types$ is required"));
	const words = typesRef.value.split(/\s+/).filter(Boolean);
	const types: CardType[] = [];
	const supertypes: Supertype[] = [];
	const invalidTypesLine = () =>
		reject(
			issue("UNSUPPORTED_PARAMETER", `invalid Types$ line: ${typesRef.value}`, {
				nodeId: typesRef.nodeId,
				line: typesRef.line,
			}),
		);
	let lastType = -1;
	let sawSubtype = false;
	for (const [index, raw] of words.entries()) {
		const word = raw.toLowerCase();
		const supertype = SUPERTYPES.get(word);
		if (supertype) {
			if (lastType >= 0 || sawSubtype || supertypes.includes(supertype))
				return invalidTypesLine();
			supertypes.push(supertype);
			continue;
		}
		const type = CARD_TYPES.get(word);
		if (type) {
			if (types.includes(type) || sawSubtype) return invalidTypesLine();
			types.push(type);
			lastType = index;
			continue;
		}
		if (lastType < 0) return invalidTypesLine();
		sawSubtype = true;
	}
	if (types.length === 0) return invalidTypesLine();
	if (types.includes("planeswalker")) {
		return reject(
			issue("UNSUPPORTED_EFFECT", "planeswalkers are not supported", {
				nodeId: typesRef.nodeId,
				line: typesRef.line,
			}),
		);
	}
	const PERMANENT_TYPES: readonly CardType[] = [
		"artifact",
		"creature",
		"enchantment",
		"land",
		"planeswalker",
	];
	const SPELL_TYPES: readonly CardType[] = ["instant", "sorcery"];
	const hasPermanentType = types.some((t) => PERMANENT_TYPES.includes(t));
	const spellTypeCount = types.filter((t) => SPELL_TYPES.includes(t)).length;
	if ((hasPermanentType && spellTypeCount > 0) || spellTypeCount > 1) {
		return reject(
			issue("UNSUPPORTED_PARAMETER", `invalid Types$ line: ${typesRef.value}`, {
				nodeId: typesRef.nodeId,
				line: typesRef.line,
			}),
		);
	}
	const subtypes = words.slice(lastType + 1);

	let colors = manaCostColors(manaCost);
	const colorsRef = face.characteristics.colors;
	if (colorsRef) {
		if (colorsRef.value.toLowerCase() === "colorless") {
			colors = [];
		} else {
			const parsed: Color[] = [];
			let bad = false;
			for (const part of colorsRef.value.split(",")) {
				const color = COLOR_WORDS.get(part.trim().toLowerCase());
				if (!color) {
					bad = true;
					break;
				}
				if (!parsed.includes(color)) parsed.push(color);
			}
			if (bad) {
				return reject(
					issue(
						"UNSUPPORTED_PARAMETER",
						`unsupported Colors$ value: ${colorsRef.value}`,
						{
							nodeId: colorsRef.nodeId,
							line: colorsRef.line,
						},
					),
				);
			}
			colors = parsed;
		}
	}

	let power: number | undefined;
	let toughness: number | undefined;
	const ptRef = face.characteristics.pt;
	if (ptRef) {
		const match = /^(-?\d+)\/(-?\d+)$/.exec(ptRef.value);
		const parsedPower = match ? Number(match[1]) : null;
		const parsedToughness = match ? Number(match[2]) : null;
		if (
			!match ||
			!types.includes("creature") ||
			parsedPower === null ||
			parsedToughness === null ||
			!Number.isSafeInteger(parsedPower) ||
			!Number.isSafeInteger(parsedToughness)
		) {
			return reject(
				issue("UNSUPPORTED_PARAMETER", `invalid PT$: ${ptRef.value}`, {
					nodeId: ptRef.nodeId,
					line: ptRef.line,
				}),
			);
		}
		power = parsedPower;
		toughness = parsedToughness;
	} else if (types.includes("creature")) {
		return reject(issue("UNSUPPORTED_PARAMETER", "creatures require PT$"));
	}

	const keywords: Keyword[] = [];
	const keywordReplacements: ReplacementEffectDefinition[] = [];
	const cyclingCosts: Pick<ActivationCost, "mana" | "life">[] = [];
	const resolver: SVarResolver = { face, consumed: new Set() };
	const usedSVarNames = resolver.consumed;
	const entersWith: Partial<Record<"+1/+1" | "-1/-1", number>> = {};
	for (const record of face.keywordRecords) {
		const where = { nodeId: record.source.nodeId, line: record.source.line };
		if (record.keyword === "Devoid") {
			if (record.segments.length !== 1)
				return reject(
					issue(
						"UNSUPPORTED_KEYWORD",
						`unsupported keyword: ${record.raw}`,
						where,
					),
				);
			// CR 702.114a: devoid is a characteristic-defining ability that makes
			// the card colorless regardless of the colored symbols in its mana cost.
			colors = [];
			keywords.push("devoid");
			continue;
		}
		if (record.keyword === "Cycling") {
			const [, costText] = record.segments;
			if (record.segments.length !== 2 || !costText)
				return reject(
					issue(
						"UNSUPPORTED_KEYWORD",
						`unsupported keyword: ${record.raw}`,
						where,
					),
				);
			const parsed = parseActivationCost(costText, where);
			if (!parsed.ok) return reject(parsed);
			if (
				parsed.value.tapSelf ||
				parsed.value.sacrifice !== undefined ||
				parsed.value.discard !== undefined
			)
				return reject(
					issue(
						"UNSUPPORTED_COST",
						`unsupported cycling cost ${costText}`,
						where,
					),
				);
			cyclingCosts.push({
				mana: parsed.value.mana,
				...(parsed.value.life ? { life: parsed.value.life } : {}),
			});
			continue;
		}
		if (record.keyword === "ETBReplacement") {
			const lowered = lowerCopyEtbKeyword(resolver, record);
			if (!lowered.ok) return reject(lowered);
			keywordReplacements.push(lowered.value);
			continue;
		}
		if (record.keyword === "etbCounter") {
			const [, counterKind, amountText] = record.segments;
			const counterName = counterKind
				? COUNTER_NAMES.get(counterKind)
				: undefined;
			const amount = amountText ? positiveInteger(amountText) : null;
			if (record.segments.length !== 3 || !counterName || !amount) {
				return reject(
					issue(
						"UNSUPPORTED_KEYWORD",
						`unsupported keyword: ${record.raw}`,
						where,
					),
				);
			}
			const summed = (entersWith[counterName] ?? 0) + amount;
			if (!Number.isSafeInteger(summed)) {
				return reject(
					issue(
						"UNSUPPORTED_KEYWORD",
						`unsafe summed entry counter count: ${record.raw}`,
						where,
					),
				);
			}
			entersWith[counterName] = summed;
			continue;
		}
		// Bushido carries its amount in a second segment (`K:Bushido:1`), which
		// the engine keeps inside the keyword itself.
		if (record.keyword === "Bushido") {
			const [, amountText] = record.segments;
			const amount = amountText ? positiveInteger(amountText) : null;
			if (record.segments.length !== 2 || !amount) {
				return reject(
					issue(
						"UNSUPPORTED_KEYWORD",
						`unsupported keyword: ${record.raw}`,
						where,
					),
				);
			}
			keywords.push(`bushido ${amount}`);
			continue;
		}
		const bare = BARE_KEYWORDS.get(record.keyword);
		if (record.segments.length !== 1 || !bare) {
			return reject(
				issue(
					"UNSUPPORTED_KEYWORD",
					`unsupported keyword: ${record.raw}`,
					where,
				),
			);
		}
		keywords.push(bare);
	}

	for (const bucket of face.svarIndex.values()) {
		if (bucket.length > 1) {
			const first = bucket[0] as ForgeSVarRecord;
			return reject(
				issue("UNSUPPORTED_REFERENCE", `duplicate SVar ${first.name}`, {
					nodeId: first.source.nodeId,
					line: first.source.line,
				}),
			);
		}
	}

	const statics: StaticAbilityDefinition[] = [];
	for (const record of face.statics) {
		const lowered = lowerStatic(record);
		if (!lowered.ok) return reject(lowered);
		statics.push(lowered.value);
	}

	const replacements: ReplacementEffectDefinition[] = [...keywordReplacements];
	let entersTappedFromReplacement = false;
	for (const record of face.replacements) {
		const lowered = lowerReplacement(resolver, record);
		if (!lowered.ok) return reject(lowered);
		if (lowered.value.kind === "self-entry") {
			if (entersTappedFromReplacement) {
				return reject(
					issue("UNSUPPORTED_KEYWORD", "duplicate enters-tapped rule", {
						nodeId: record.source.nodeId,
						line: record.source.line,
					}),
				);
			}
			entersTappedFromReplacement = true;
		} else {
			replacements.push(lowered.value.def);
		}
	}

	const activatedAbilities: AnyActivatedAbilityDefinition[] = [];
	let activatedCount = 0;
	for (const cyclingCost of cyclingCosts) {
		activatedCount += 1;
		activatedAbilities.push({
			kind: "cycling",
			id: `activated-${activatedCount}`,
			text: "Cycling.",
			functionsFrom: ["hand"],
			cost: {
				mana: cyclingCost.mana,
				tapSelf: false,
				discard: { amount: 1, subject: "source" },
				...(cyclingCost.life ? { life: cyclingCost.life } : {}),
			},
			targets: [],
			effects: [
				{
					kind: "draw",
					subject: { kind: "relative-player", player: "you" },
					amount: 1,
				},
			],
		});
	}
	const triggers: TriggeredAbilityDefinition[] = [];
	const abilityHost: AbilityHost = {
		cardId: id,
		activated: activatedAbilities,
		triggered: triggers,
		hostedActivatedIndices: new Set(),
		hostedTriggeredIndices: new Set(),
	};
	for (const record of face.triggers) {
		const lowered = lowerTrigger(resolver, record, abilityHost);
		if (!lowered.ok) return reject(lowered);
		triggers.push(lowered.value);
	}

	let spell: SpellAbilityDef | undefined;
	let spellCount = 0;
	for (const record of face.abilities) {
		const where = { nodeId: record.source.nodeId, line: record.source.line };
		const params = record.params;
		const _disc = discriminator(params, where);
		if (!_disc.ok) return reject(_disc);
		const disc = _disc.value;
		if (disc.token !== "AB" && disc.token !== "SP") {
			return reject(
				issue(
					"UNSUPPORTED_EFFECT",
					"expected an AB$ or SP$ root ability",
					where,
				),
			);
		}

		let activationCost: ActivationCost | undefined;
		let restrictions: { asSorcery: true } | undefined;
		if (disc.token === "AB") {
			const parsedCost = parseActivationCost(
				getForgeParam(params, "Cost"),
				where,
			);
			if (!parsedCost.ok) return reject(parsedCost);
			activationCost = parsedCost.value;

			const sorcerySpeed = getForgeParam(params, "SorcerySpeed");
			if (sorcerySpeed !== undefined) {
				if (sorcerySpeed !== "True") {
					return reject(
						issue("UNSUPPORTED_PARAMETER", "SorcerySpeed$ must be True", where),
					);
				}
				restrictions = { asSorcery: true };
			}
		}

		if (disc.token === "AB" && disc.api === "delayedtrigger") {
			const description = getForgeParam(params, "SpellDescription");
			if (!description)
				return reject(
					issue(
						"UNSUPPORTED_PARAMETER",
						"SpellDescription$ is required",
						where,
					),
				);
			const delayed = lowerNextEndStepDelayedTrigger(
				resolver,
				params,
				where,
				description,
				abilityHost,
			);
			if (!delayed.ok) return reject(delayed);
			assert(activationCost !== undefined);
			activatedCount += 1;
			activatedAbilities.push({
				kind: "activated",
				id: `activated-${activatedCount}`,
				text: description,
				cost: activationCost,
				...(restrictions ? { restrictions } : {}),
				targets: [],
				effects: delayed.value,
			});
			continue;
		}

		if (disc.token === "AB" && disc.api === "mana") {
			const badParams = consumeParams(
				params,
				new Set(["ab", "cost", "produced", "amount", "spelldescription"]),
				where,
			);
			if (!badParams.ok) return reject(badParams);
			assert(activationCost !== undefined);
			const produced = getForgeParam(params, "Produced");
			const anyColor = produced === "Any";
			const modal = anyColor || (produced?.startsWith("Combo ") ?? false);
			// Forge's fixed multi-mana form is exactly a space-separated list of
			// printed symbols. `Combo` uses the same symbol list for mutually
			// exclusive choices, and `Any` is exactly W/U/B/R/G. Keep all forms
			// strict so variables, compact (`WU`), and malformed separators cannot
			// change meaning.
			const producedSymbols = anyColor
				? ["W", "U", "B", "R", "G"]
				: modal
					? (produced?.slice("Combo ".length).split(" ") ?? [])
					: (produced?.split(" ") ?? []);
			const producedTypes: ManaType[] = [];
			for (const symbol of producedSymbols) {
				const type = PRODUCED_MANA_SYMBOLS.get(symbol);
				if (!type) {
					return reject(
						issue(
							"UNSUPPORTED_EFFECT",
							`unsupported produced mana ${produced ?? "(none)"}`,
							where,
						),
					);
				}
				producedTypes.push(type);
			}
			if (producedTypes.length === 0) {
				return reject(
					issue(
						"UNSUPPORTED_EFFECT",
						"unsupported produced mana (none)",
						where,
					),
				);
			}

			const amountText = getForgeParam(params, "Amount");
			if (modal) {
				if (
					producedTypes.length < 2 ||
					new Set(producedTypes).size !== producedTypes.length
				) {
					return reject(
						issue(
							"UNSUPPORTED_EFFECT",
							`unsupported produced mana ${produced ?? "(none)"}`,
							where,
						),
					);
				}
				// `Produced$ Any | Amount$ N` is N mana of the one colour chosen —
				// "Add three mana of any one color" (Black Lotus, Gilded Lotus) — so
				// every option carries the full amount. Every corpus card pairing
				// `Any` with an amount above one reads that way.
				//
				// `Produced$ Combo R G | Amount$ N` is a different instruction: "add
				// three mana in any combination of {R} and/or {G}" (Orcish Lumberjack)
				// lets the player mix the symbols, which is N independent choices
				// rather than one, and no fixed `manaOptions` list can express it.
				// Only N = 1, where mixing is vacuous, is a single modal choice.
				let modalAmount: number | null;
				if (anyColor) {
					modalAmount = positiveInteger(amountText, 1);
				} else {
					modalAmount =
						amountText === undefined || amountText === "1" ? 1 : null;
				}
				if (!modalAmount) {
					return reject(
						issue(
							"UNSUPPORTED_EFFECT",
							`unsupported mana amount ${amountText ?? ""}`,
							where,
						),
					);
				}
				const [first, second, ...rest] = producedTypes.map((type) =>
					fullMana(type, modalAmount),
				);
				assert(
					first !== undefined && second !== undefined,
					"a validated Combo produces at least two distinct symbols",
				);
				activatedCount += 1;
				activatedAbilities.push({
					kind: "mana",
					id: `activated-${activatedCount}`,
					text:
						getForgeParam(params, "SpellDescription") ??
						`Add ${producedSymbols
							.map((symbol) => `{${symbol}}`.repeat(modalAmount))
							.join(" or ")}.`,
					cost: activationCost,
					manaOptions: [first, second, ...rest],
				});
				continue;
			}

			// A `Count$`/SVar amount (Urza's Tower) lands here: the symbol is
			// fine, the quantity is the part the engine cannot yet express. Lists
			// encode their quantities by repeating symbols, so an additional
			// Amount$ would be a separate, unsupported quantity form.
			const amount =
				producedTypes.length === 1
					? positiveInteger(amountText, 1)
					: amountText === undefined
						? 1
						: null;
			if (!amount) {
				return reject(
					issue(
						"UNSUPPORTED_EFFECT",
						`unsupported mana amount ${amountText ?? ""}`,
						where,
					),
				);
			}

			const mana: ManaPool = { w: 0, u: 0, b: 0, r: 0, g: 0, c: 0 };
			for (const type of producedTypes) mana[type] += amount;
			activatedCount += 1;
			activatedAbilities.push({
				kind: "mana",
				id: `activated-${activatedCount}`,
				text:
					getForgeParam(params, "SpellDescription") ??
					`Add ${producedSymbols.map((symbol) => `{${symbol}}`).join("")}.`,
				cost: activationCost,
				effects: [{ kind: "add-mana", subject: "you", mana }],
			});
			continue;
		}

		let functionsFrom: [PublicObjectZone] | undefined;
		if (disc.token === "AB") {
			const activationZone = getForgeParam(params, "ActivationZone");
			if (activationZone !== undefined) {
				const zone = PUBLIC_ZONES.get(activationZone);
				if (!zone)
					return reject(
						issue(
							"UNSUPPORTED_PARAMETER",
							"ActivationZone$ must be Battlefield, Graveyard, or Exile",
							where,
						),
					);
				functionsFrom = [zone];
			}
		}

		// A spell's `Cost$` restates the printed mana cost and then appends the
		// additional costs. Only the appended part is new information, so the
		// mana part is checked against `ManaCost:` rather than charged again.
		let additionalCosts: AdditionalCosts | undefined;
		if (disc.token === "SP") {
			const costText = getForgeParam(params, "Cost");
			if (costText !== undefined) {
				const parsedCost = parseActivationCost(costText, where);
				if (!parsedCost.ok) return reject(parsedCost);
				const restated = restatesManaCost(parsedCost.value.mana, manaCost);
				if (
					parsedCost.value.tapSelf ||
					!restated ||
					(!parsedCost.value.sacrifice &&
						!parsedCost.value.discard &&
						!parsedCost.value.life)
				) {
					return reject(
						issue(
							"UNSUPPORTED_COST",
							`unsupported additional spell cost ${costText}`,
							where,
						),
					);
				}
				additionalCosts = {
					...(parsedCost.value.sacrifice
						? { sacrifice: parsedCost.value.sacrifice }
						: {}),
					...(parsedCost.value.discard
						? { discard: parsedCost.value.discard }
						: {}),
					...(parsedCost.value.life ? { life: parsedCost.value.life } : {}),
				};
			}
		}
		if (
			disc.token === "SP" &&
			!(types.includes("instant") || types.includes("sorcery"))
		) {
			return reject(
				issue(
					"UNSUPPORTED_EFFECT",
					"SP$ abilities on permanent cards are never resolved by the engine",
					where,
				),
			);
		}

		const targets = parseTarget(
			getForgeParam(params, "ValidTgts"),
			getForgeParam(params, "TargetType"),
			changeZoneTargetZone(params, disc.api === "changezone"),
		);
		if (!targets)
			return reject(
				issue("UNSUPPORTED_TARGET", "unsupported ValidTgts$ value", where),
			);
		const chain = lowerEffectChain(
			resolver,
			params,
			where,
			targets,
			false,
			disc.token === "SP" ? ["SP"] : ["AB"],
			player,
			disc.token === "AB",
			abilityHost,
			null,
		);
		if (!chain.ok) return reject(chain);
		const description = getForgeParam(params, "SpellDescription");
		if (!description)
			return reject(
				issue("UNSUPPORTED_PARAMETER", "SpellDescription$ is required", where),
			);

		if (disc.token === "SP") {
			spellCount += 1;
			if (spellCount > 1) {
				return reject(
					issue(
						"UNSUPPORTED_EFFECT",
						"multiple spell abilities are not supported",
						where,
					),
				);
			}
			spell = {
				id: `spell-${spellCount}`,
				text: description,
				...(additionalCosts ? { additionalCosts } : {}),
				targets,
				effects: chain.value,
			};
		} else {
			assert(activationCost !== undefined);
			activatedCount += 1;
			activatedAbilities.push({
				kind: "activated",
				id: `activated-${activatedCount}`,
				text: description,
				cost: activationCost,
				...(functionsFrom ? { functionsFrom } : {}),
				...(restrictions ? { restrictions } : {}),
				targets,
				effects: chain.value,
			});
		}
	}

	if ((types.includes("instant") || types.includes("sorcery")) && !spell) {
		return reject(
			issue(
				"UNSUPPORTED_EFFECT",
				"instants and sorceries require exactly one SP$ ability",
			),
		);
	}

	// Basic land types intrinsically grant their tap-for-mana ability, whether or
	// not the card also carries the "basic" supertype (e.g. Dryad Arbor). Only an
	// *exact* pre-existing duplicate (a fixed tap-self ability producing exactly
	// one of that color and nothing else) is treated as already covering it, so
	// an explicit ability that happens to also produce that color never silently
	// absorbs the intrinsic grant.
	if (types.includes("land")) {
		const intrinsicColors = new Set(
			subtypes
				.map((subtype) => BASIC_LAND_MANA.get(subtype))
				.filter((c): c is Color => c !== undefined),
		);
		for (const color of intrinsicColors) {
			const exactDuplicate = activatedAbilities.some(
				(ability) =>
					ability.kind === "mana" &&
					!("manaOptions" in ability) &&
					ability.cost.mana === "zero" &&
					ability.cost.tapSelf &&
					ability.effects.length === 1 &&
					ability.effects[0]?.kind === "add-mana" &&
					(() => {
						const mana = (
							ability.effects[0] as Extract<
								ActivatedEffectDef,
								{ kind: "add-mana" }
							>
						).mana;
						return (
							mana[color] === 1 &&
							(["w", "u", "b", "r", "g", "c"] as const)
								.filter((c) => c !== color)
								.every((c) => (mana[c] ?? 0) === 0)
						);
					})(),
			);
			if (exactDuplicate) continue;
			activatedCount += 1;
			activatedAbilities.push({
				kind: "mana",
				id: `intrinsic-mana-${color}`,
				text: `Add {${color.toUpperCase()}}.`,
				cost: { mana: "zero", tapSelf: true },
				effects: [{ kind: "add-mana", subject: "you", mana: fullMana(color) }],
			});
		}
	}

	// These Forge AI hints remain contextual: their names also occur in card
	// scripts where accepting them unconditionally would hide a missed rule.
	const scalarMetadata = (name: string): string | undefined => {
		const parsed = lookupForgeSVar(face, name)?.parsed;
		return parsed?.kind === "scalar" ? parsed.value : undefined;
	};
	if (
		triggers.some(
			(trigger) => trigger.condition.kind === "declare attackers",
		) &&
		scalarMetadata("HasAttackEffect") === "TRUE"
	)
		usedSVarNames.add("hasattackeffect");
	const hasGraveyardBehavior =
		activatedAbilities.some(
			(ability) =>
				ability.kind === "activated" &&
				ability.functionsFrom?.[0] === "graveyard",
		) || triggers.some((trigger) => trigger.functionsFrom?.[0] === "graveyard");
	if (
		(triggers.some(
			(trigger) =>
				trigger.condition.kind === "change zone" &&
				trigger.condition.from === "battlefield",
		) ||
			hasGraveyardBehavior) &&
		/^\d+$/.test(scalarMetadata("SacMe") ?? "")
	)
		usedSVarNames.add("sacme");
	if (hasGraveyardBehavior && /^\d+$/.test(scalarMetadata("DiscardMe") ?? ""))
		usedSVarNames.add("discardme");

	for (const record of face.svars) {
		if (
			!usedSVarNames.has(record.name.toLowerCase()) &&
			!IGNORED_UNUSED_SVARS.has(record.name.toLowerCase())
		) {
			return reject(
				issue("UNSUPPORTED_REFERENCE", `unused SVar ${record.name}`, {
					nodeId: record.source.nodeId,
					line: record.source.line,
				}),
			);
		}
	}

	const printed: CardDefInput["printed"] = {};
	if (abilityHost.hostedActivatedIndices.size > 0) {
		printed.activated = activatedAbilities
			.map((_, index) => index)
			.filter((index) => !abilityHost.hostedActivatedIndices.has(index));
	}
	if (abilityHost.hostedTriggeredIndices.size > 0) {
		printed.triggered = triggers
			.map((_, index) => index)
			.filter((index) => !abilityHost.hostedTriggeredIndices.has(index));
	}
	const hasRegistryHostedAbilities =
		abilityHost.hostedActivatedIndices.size > 0 ||
		abilityHost.hostedTriggeredIndices.size > 0;

	const input: CardDefInput = {
		id,
		name,
		...(supertypes.length > 0 ? { supertypes } : {}),
		types,
		...(subtypes.length > 0 ? { subtypes } : {}),
		colors,
		manaCost,
		...(power !== undefined ? { power } : {}),
		...(toughness !== undefined ? { toughness } : {}),
		...(keywords.length > 0 ? { keywords } : {}),
		...(entersTappedFromReplacement ? { entersTapped: true } : {}),
		...(Object.keys(entersWith).length > 0 ? { entersWith } : {}),
		...(spell ? { spell } : {}),
		...(statics.length > 0 ? { statics } : {}),
		...(activatedAbilities.length > 0 ? { activatedAbilities } : {}),
		...(hasRegistryHostedAbilities ? { printed } : {}),
		...(triggers.length > 0 ? { triggers } : {}),
		...(replacements.length > 0 ? { replacements } : {}),
	};

	return { ok: true, card: defineCard(input), diagnostics: [] };
}

export function importForgeCard(
	text: string,
	options: { id: string },
): ImportResult {
	const { card } = parseForgeCardScript(text);
	return lowerForgeCard(card, options);
}
