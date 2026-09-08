/**
 * forge-import.ts — the strict Forge-to-engine bridge.
 *
 *     External Forge text
 *       -> parseForgeCardScript(text).card       Forge-owned syntax/references
 *       -> lowerForgeCard(ast, { id })           supported semantic subset
 *       -> CardDefInput -> defineCard(input)      engine-owned definitions
 *       -> registerCard(definition)               explicit caller action
 *
 * Neither `lowerForgeCard` nor `importForgeCard` register a card or touch game
 * state. A rejected card exposes no partially-usable `CardDef`: `ok: false`
 * carries only diagnostics.
 *
 * This module accounts for every root rule (`A`, `T`, `R`, `S`, `K`) on a card
 * or rejects the whole card; it does not claim full Magic rules coverage. Only
 * the concrete subset documented in the acceptance matrix in README.md lowers.
 *
 * Deferred / explicitly unsupported (each rejects rather than approximating):
 * `ChangeZone` other than Battlefield to Hand (so no reanimation, tutoring,
 * blinking, or exile); random or multi-card discard; alternate/additional
 * costs on spells, and activation costs other than fixed generic/coloured mana,
 * tap-self, and one permanent sacrifice; X/colorless/hybrid/Phyrexian/snow mana
 * and dynamic amounts;
 * more than one target slot,
 * or an optional one; selector modifiers outside `YouCtrl`/`OppCtrl`, the exact
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
	ActivationCost,
	AnyActivatedAbilityDefinition,
	CardDef,
	CardDefInput,
	CardType,
	CharacteristicsSnapshot,
	Color,
	EffectDef,
	GameEvent,
	Keyword,
	ManaCostType,
	ManaPool,
	ManaType,
	ObjectId,
	ObjectSelectorDef,
	PayableActivationManaCost,
	ReadContext,
	RelativeEffectPlayer,
	ReplacementEffectDefinition,
	SpellAbilityDef,
	SpellAdditionalCostDef,
	StaticAbilityDefinition,
	Supertype,
	TargetDef,
	TargetSlotRef,
	TriggerEffectPlayer,
	TriggeredAbilityDefinition,
	ValidPlayer,
} from "../index.ts";
import {
	characteristicsFromCardDef,
	cloneCharacteristics,
	defineCard,
	etbPreview,
	MANA_COST_TYPES,
	readObject,
	selectorMatches,
} from "../index.ts";
import type {
	ForgeAbilityRecord,
	ForgeCardAst,
	ForgeFaceAst,
	ForgeKeywordRecord,
	ForgeParamList,
	ForgeSVarRecord,
} from "./ast.ts";
import { getForgeParam, lookupForgeSVar, parseForgeCardScript } from "./ast.ts";
import { forgeTokenScript } from "./token-corpus.ts";

export interface ImportIssue {
	code: string;
	message: string;
	nodeId?: string;
	line?: number;
	paramId?: string;
}

export type ImportResult =
	| { ok: true; card: CardDef; diagnostics: ImportIssue[] }
	| { ok: false; diagnostics: [ImportIssue, ...ImportIssue[]] };

function issue(
	code: string,
	message: string,
	extra: { nodeId?: string; line?: number; paramId?: string } = {},
): ImportIssue {
	return { code, message, ...extra };
}

function reject(i: ImportIssue): { ok: false; diagnostics: [ImportIssue] } {
	return { ok: false, diagnostics: [i] };
}

/* ------------------------------------------------------------------------- */
/* Small lookup tables. Only the forms below are supported; everything else  */
/* is data that the lowering rules reject explicitly.                        */
/* ------------------------------------------------------------------------- */

const CARD_TYPES = new Set<CardType>([
	"artifact",
	"creature",
	"enchantment",
	"instant",
	"land",
	"planeswalker",
	"sorcery",
]);
const SUPERTYPES = new Set<Supertype>(["basic", "legendary", "snow"]);
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
 * distinct fixed symbols is a modal choice of exactly one of them; `Any`,
 * variables, dynamic amounts, and other Forge forms still reject.
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
	["Flying", "flying"],
	["Reach", "reach"],
	["Defender", "defender"],
	["Lifelink", "lifelink"],
	["Indestructible", "indestructible"],
	["Haste", "haste"],
	["Vigilance", "vigilance"],
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
 * Every semantic parameter on a record must be on its operation's allowlist,
 * and no semantic parameter may repeat: Forge's own last-write-wins projection
 * is not something this bridge relies on.
 */
function checkParams(
	params: ForgeParamList,
	allowedLower: ReadonlySet<string>,
	where: { nodeId?: string; line?: number },
): ImportIssue | null {
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
	return null;
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

function spellCastEffectPlayer(
	value: string | undefined,
): TriggerEffectPlayer | null {
	if (value === "TriggeredActivator") return "triggering-player";
	return triggerEffectPlayer(value);
}

/* ------------------------------------------------------------------------- */
/* Selectors and targets                                                      */
/* ------------------------------------------------------------------------- */

function combineSelectors(
	kind: "all" | "any",
	selectors: ObjectSelectorDef[],
): ObjectSelectorDef {
	const only = selectors[0];
	return selectors.length === 1 && only ? only : { kind, selectors };
}

/**
 * One `.`-separated restriction following the base, such as the `nonBlack` of
 * `Creature.nonBlack`. Only this closed vocabulary lowers; every other Forge
 * restriction (zone, combat state, counters, subtype-as-modifier) rejects the
 * card rather than being approximated.
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

function parseSelectorModifier(modifier: string): ObjectSelectorDef | null {
	if (modifier === "YouCtrl") return { kind: "controller", player: "you" };
	if (modifier === "OppCtrl") return { kind: "controller", player: "opponent" };
	const negated = modifier.startsWith("non");
	const word = (negated ? modifier.slice(3) : modifier).toLowerCase();
	const color = COLOR_WORDS.get(word);
	const type = [...CARD_TYPES].find((candidate) => candidate === word);
	const supertype = [...SUPERTYPES].find((candidate) => candidate === word);
	let selector: ObjectSelectorDef | null = null;
	if (color) selector = { kind: "color", color };
	else if (type) selector = { kind: "type", type };
	else if (supertype) selector = { kind: "supertype", supertype };
	if (!selector) return null;
	return negated ? { kind: "not", selector } : selector;
}

function parseSelectorPart(value: string): ObjectSelectorDef | null {
	if (value === "Card.Self" || value === "Self") return { kind: "self" };
	const pieces = value.split(".");
	const base = pieces.shift();
	const parts: ObjectSelectorDef[] = [];
	const type = base
		? ([...CARD_TYPES].find((t) => t === base.toLowerCase()) ?? null)
		: null;
	if (type) parts.push({ kind: "type", type });
	else if (base === "Player" || base === "Any") return null;
	else if (base && base !== "Card" && base !== "Permanent")
		parts.push({ kind: "subtype", subtype: base });
	for (const modifier of pieces) {
		const parsed = parseSelectorModifier(modifier);
		if (!parsed) return null;
		parts.push(parsed);
	}
	return parts.length > 0 ? combineSelectors("all", parts) : null;
}

function parseSelector(value: string): ObjectSelectorDef | null {
	const choices = value
		.split(",")
		.map((part) => parseSelectorPart(part.trim()));
	return choices.every((choice): choice is ObjectSelectorDef => choice !== null)
		? combineSelectors("any", choices)
		: null;
}

/** The one target slot the engine supports; every lowered effect refers to it. */
const TARGET_SLOT = "target-1";

/**
 * A targeting effect and its ability's `ValidTgts$` have to agree, or the
 * engine would resolve an effect against a target nobody checked.
 */
function checkEffectTargetSlots<Player extends TriggerEffectPlayer>(
	effects: EffectDef<Player>[],
	targets: TargetDef[],
	where: { nodeId?: string; line?: number },
): ImportIssue | null {
	for (const effect of effects) {
		if (effect.kind === "may") {
			const inner = checkEffectTargetSlots(effect.effects, targets, where);
			if (inner) return inner;
			continue;
		}
		const damageTarget =
			effect.kind === "damage" && "targetSlot" in effect.recipient
				? effect.recipient
				: null;
		const playerTarget =
			(effect.kind === "gain-life" ||
				effect.kind === "lose-life" ||
				effect.kind === "draw" ||
				effect.kind === "scry" ||
				effect.kind === "surveil" ||
				effect.kind === "mill") &&
			typeof effect.player !== "string"
				? effect.player
				: null;
		if (
			damageTarget === null &&
			playerTarget === null &&
			effect.kind !== "destroy" &&
			effect.kind !== "tap" &&
			effect.kind !== "counter" &&
			effect.kind !== "return to hand" &&
			effect.kind !== "modify-pt" &&
			effect.kind !== "grant-keyword" &&
			effect.kind !== "add counters"
		)
			continue;
		const objectTarget =
			(effect.kind === "destroy" ||
				effect.kind === "tap" ||
				effect.kind === "return to hand" ||
				effect.kind === "modify-pt" ||
				effect.kind === "grant-keyword" ||
				effect.kind === "add counters") &&
			effect.object !== "source"
				? effect.object
				: null;
		// An effect on its own source declares no target to check.
		if (
			(effect.kind === "return to hand" ||
				effect.kind === "modify-pt" ||
				effect.kind === "grant-keyword" ||
				effect.kind === "add counters") &&
			effect.object === "source"
		)
			continue;
		const counterTarget = effect.kind === "counter" ? effect.spell : null;
		const effectSlot =
			damageTarget?.targetSlot ??
			playerTarget?.targetSlot ??
			objectTarget?.targetSlot ??
			counterTarget?.targetSlot;
		assert(effectSlot !== undefined);
		const target = targets[0];
		if (targets.length !== 1 || !target || effectSlot !== target.id) {
			return issue(
				"UNSUPPORTED_TARGET",
				"targeted effects must reference the declared target slot",
				where,
			);
		}
		if (playerTarget !== null && target.legal.kind !== "player") {
			return issue(
				"UNSUPPORTED_TARGET",
				"a targeted player effect requires ValidTgts$ Player",
				where,
			);
		}
		if (effect.kind === "destroy" && target.legal.kind !== "permanent") {
			return issue(
				"UNSUPPORTED_TARGET",
				"Destroy requires a permanent target",
				where,
			);
		}
		if (effect.kind === "tap" && target.legal.kind !== "permanent") {
			return issue(
				"UNSUPPORTED_TARGET",
				"Tap requires a permanent target",
				where,
			);
		}
		if (effect.kind === "counter" && target.legal.kind !== "spell") {
			return issue(
				"UNSUPPORTED_TARGET",
				"Counter requires a spell target",
				where,
			);
		}
		if (effect.kind === "return to hand" && target.legal.kind !== "permanent") {
			return issue(
				"UNSUPPORTED_TARGET",
				"ChangeZone to hand requires a permanent target",
				where,
			);
		}
		if (effect.kind === "modify-pt" && target.legal.kind !== "permanent") {
			return issue(
				"UNSUPPORTED_TARGET",
				"Pump requires a permanent target",
				where,
			);
		}
		if (effect.kind === "grant-keyword" && target.legal.kind !== "permanent") {
			return issue(
				"UNSUPPORTED_TARGET",
				"keyword grants require a permanent target",
				where,
			);
		}
		if (effect.kind === "add counters" && target.legal.kind !== "permanent") {
			return issue(
				"UNSUPPORTED_TARGET",
				"PutCounter requires a permanent target",
				where,
			);
		}
	}
	return null;
}

/**
 * `ValidTgts$`-shaped values. Anything `parseSelector` accepts is a permanent
 * restriction the engine can check; `Any` and `Player` are the two forms that
 * are not object restrictions at all.
 */
function parseTarget(
	value: string | undefined,
	targetType?: string,
): TargetDef[] | null {
	if (value === undefined) return [];
	let legal: TargetDef["legal"];
	if (value === "Card" && targetType === "Spell") legal = { kind: "spell" };
	else if (targetType !== undefined) return null;
	else if (value === "Any") legal = { kind: "any-target" };
	else if (value === "Player") legal = { kind: "player" };
	else if (value === "Permanent") legal = { kind: "permanent" };
	else if (value === "Creature.Other+YouCtrl") {
		legal = {
			kind: "permanent",
			selector: {
				kind: "all",
				selectors: [
					{ kind: "type", type: "creature" },
					{ kind: "not", selector: { kind: "self" } },
					{ kind: "controller", player: "you" },
				],
			},
		};
	} else {
		const selector = parseSelector(value);
		if (!selector) return null;
		legal = { kind: "permanent", selector };
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

function fixedTokenCharacteristics(
	scriptId: string,
	where: { nodeId?: string; line?: number },
): CharacteristicsSnapshot | ImportIssue {
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
	if (
		imported.card.spell ||
		Object.values(imported.card.printedAbilities).some(
			(abilities) => abilities.length > 0,
		)
	)
		return issue(
			"UNSUPPORTED_EFFECT",
			`Forge token script ${scriptId} has abilities`,
			where,
		);
	return characteristicsFromCardDef(imported.card);
}

/**
 * Forge's player operand. `Defined$ Targeted`, and an omitted `Defined$` on an
 * ability that declares `ValidTgts$`, both name the player this ability
 * targets; every other spelling is relative to the source's controller.
 */
function parseEffectPlayer<Player extends TriggerEffectPlayer>(
	params: ForgeParamList,
	parsePlayer: (value: string | undefined) => Player | null,
): Player | TargetSlotRef | null {
	const defined = getForgeParam(params, "Defined");
	if (defined === "Targeted") return { targetSlot: TARGET_SLOT };
	if (defined === undefined && getForgeParam(params, "ValidTgts") !== undefined)
		return { targetSlot: TARGET_SLOT };
	return parsePlayer(defined);
}

function parseSingleEffect<Player extends TriggerEffectPlayer>(
	params: ForgeParamList,
	discriminatorLower: string,
	api: string,
	where: { nodeId?: string; line?: number },
	parsePlayer: (value: string | undefined) => Player | null,
	allowSourceObject: boolean,
): Exclude<EffectDef<Player>, { kind: "may" }> | ImportIssue {
	switch (api) {
		case "gainlife":
		case "loselife": {
			const badParams = checkParams(
				params,
				new Set([
					discriminatorLower,
					"defined",
					"validtgts",
					"tgtprompt",
					"lifeamount",
					...COMMON_EFFECT_PARAMS,
				]),
				where,
			);
			if (badParams) return badParams;
			const who = parseEffectPlayer(params, parsePlayer);
			const amount = positiveInteger(getForgeParam(params, "LifeAmount"));
			if (!who || !amount)
				return issue(
					"UNSUPPORTED_PARAMETER",
					`unsupported or missing LifeAmount$/player for ${api}`,
					where,
				);
			return {
				kind: api === "gainlife" ? "gain-life" : "lose-life",
				player: who,
				amount,
			};
		}
		case "scry": {
			const badParams = checkParams(
				params,
				new Set([
					discriminatorLower,
					"defined",
					"validtgts",
					"tgtprompt",
					"scrynum",
					...COMMON_EFFECT_PARAMS,
				]),
				where,
			);
			if (badParams) return badParams;
			const who = parseEffectPlayer(params, parsePlayer);
			const amount = positiveInteger(getForgeParam(params, "ScryNum"), 1);
			if (!who || !amount)
				return issue(
					"UNSUPPORTED_PARAMETER",
					"unsupported scry amount/player",
					where,
				);
			return { kind: "scry", player: who, amount };
		}
		case "surveil": {
			const badParams = checkParams(
				params,
				new Set([
					discriminatorLower,
					"defined",
					"validtgts",
					"tgtprompt",
					"amount",
					...COMMON_EFFECT_PARAMS,
				]),
				where,
			);
			if (badParams) return badParams;
			const who = parseEffectPlayer(params, parsePlayer);
			const amount = positiveInteger(getForgeParam(params, "Amount"), 1);
			if (!who || !amount)
				return issue(
					"UNSUPPORTED_PARAMETER",
					"unsupported surveil amount/player",
					where,
				);
			return { kind: "surveil", player: who, amount };
		}
		case "dig": {
			const badParams = checkParams(
				params,
				new Set([
					discriminatorLower,
					"defined",
					"dignum",
					"changenum",
					"noreveal",
					...COMMON_EFFECT_PARAMS,
				]),
				where,
			);
			if (badParams) return badParams;
			const who = parseEffectPlayer(params, parsePlayer);
			const amount = positiveInteger(getForgeParam(params, "DigNum"));
			const keep = positiveInteger(getForgeParam(params, "ChangeNum"));
			const noReveal = getForgeParam(params, "NoReveal");
			if (
				who !== "you" ||
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
			return { kind: "choose-from-top", player: who, amount, keep };
		}
		case "draw": {
			const badParams = checkParams(
				params,
				new Set([
					discriminatorLower,
					"defined",
					"validtgts",
					"tgtprompt",
					"numcards",
					...COMMON_EFFECT_PARAMS,
				]),
				where,
			);
			if (badParams) return badParams;
			const who = parseEffectPlayer(params, parsePlayer);
			const amount = positiveInteger(getForgeParam(params, "NumCards"), 1);
			if (!who || !amount)
				return issue(
					"UNSUPPORTED_PARAMETER",
					"unsupported draw amount/player",
					where,
				);
			return { kind: "draw", player: who, amount };
		}
		case "mill": {
			const badParams = checkParams(
				params,
				new Set([
					discriminatorLower,
					"defined",
					"validtgts",
					"tgtprompt",
					"numcards",
					...COMMON_EFFECT_PARAMS,
				]),
				where,
			);
			if (badParams) return badParams;
			const who = parseEffectPlayer(params, parsePlayer);
			const amount = positiveInteger(getForgeParam(params, "NumCards"), 1);
			if (!who || !amount)
				return issue(
					"UNSUPPORTED_PARAMETER",
					"unsupported mill amount/player",
					where,
				);
			return { kind: "mill", player: who, amount };
		}
		case "discard": {
			const badParams = checkParams(
				params,
				new Set([
					discriminatorLower,
					"defined",
					"mode",
					"numcards",
					...COMMON_EFFECT_PARAMS,
				]),
				where,
			);
			if (badParams) return badParams;
			if (getForgeParam(params, "Mode") !== "TgtChoose")
				return issue(
					"UNSUPPORTED_EFFECT",
					"only Mode$ TgtChoose discard is supported",
					where,
				);
			const who = parsePlayer(getForgeParam(params, "Defined"));
			const amount = positiveInteger(getForgeParam(params, "NumCards"), 1);
			if (!who || amount !== 1)
				return issue(
					"UNSUPPORTED_EFFECT",
					"only discarding exactly one chosen card is supported",
					where,
				);
			return { kind: "discard", selector: "any", amount: 1, player: who };
		}
		case "dealdamage": {
			const badParams = checkParams(
				params,
				new Set([
					discriminatorLower,
					"validtgts",
					"tgtprompt",
					"defined",
					"numdmg",
					...COMMON_EFFECT_PARAMS,
				]),
				where,
			);
			if (badParams) return badParams;
			const amount = positiveInteger(getForgeParam(params, "NumDmg"));
			if (!amount)
				return issue("UNSUPPORTED_PARAMETER", "unsupported NumDmg", where);
			const defined = getForgeParam(params, "Defined");
			if (defined === undefined)
				return {
					kind: "damage",
					recipient: { targetSlot: TARGET_SLOT },
					amount,
				};
			const player = parsePlayer(defined);
			if (!player)
				return issue(
					"UNSUPPORTED_PARAMETER",
					"unsupported Defined$ damage recipient",
					where,
				);
			return { kind: "damage", recipient: { player }, amount };
		}
		case "destroy": {
			const badParams = checkParams(
				params,
				new Set([
					discriminatorLower,
					"validtgts",
					"tgtprompt",
					// AILogic controls only Forge's automated-player timing. It does
					// not change the destroy instruction the engine executes.
					"ailogic",
					...COMMON_EFFECT_PARAMS,
				]),
				where,
			);
			if (badParams) return badParams;
			return {
				kind: "destroy",
				object: { targetSlot: TARGET_SLOT },
			};
		}
		case "tap": {
			const badParams = checkParams(
				params,
				new Set([
					discriminatorLower,
					"validtgts",
					"tgtprompt",
					...COMMON_EFFECT_PARAMS,
				]),
				where,
			);
			if (badParams) return badParams;
			return {
				kind: "tap",
				object: { targetSlot: TARGET_SLOT },
			};
		}
		case "counter": {
			const badParams = checkParams(
				params,
				new Set([
					discriminatorLower,
					"validtgts",
					"tgtprompt",
					"targettype",
					...COMMON_EFFECT_PARAMS,
				]),
				where,
			);
			if (badParams) return badParams;
			return {
				kind: "counter",
				spell: { targetSlot: TARGET_SLOT },
			};
		}
		case "changezone": {
			const badParams = checkParams(
				params,
				new Set([
					discriminatorLower,
					"origin",
					"destination",
					"defined",
					"validtgts",
					"tgtprompt",
					...COMMON_EFFECT_PARAMS,
				]),
				where,
			);
			if (badParams) return badParams;
			// Only the bounce case is lowered. Every other origin/destination pair
			// -- reanimation, tutoring, blinking, exile -- needs zone handling this
			// effect does not have, so they reject rather than approximate.
			const origin = getForgeParam(params, "Origin");
			const destination = getForgeParam(params, "Destination");
			if (origin !== "Battlefield" || destination !== "Hand") {
				return issue(
					"UNSUPPORTED_PARAMETER",
					"only ChangeZone from Battlefield to Hand is supported",
					where,
				);
			}
			const validTargets = getForgeParam(params, "ValidTgts");
			const defined = getForgeParam(params, "Defined");
			if (validTargets !== undefined) {
				if (defined !== undefined)
					return issue(
						"UNSUPPORTED_PARAMETER",
						"targeted ChangeZone cannot also use Defined$",
						where,
					);
				return {
					kind: "return to hand",
					object: { targetSlot: TARGET_SLOT },
				};
			}
			// Forge defaults an omitted Defined$ to the source object. Accept the
			// explicit spelling too, but reject every other non-target subject.
			if (!allowSourceObject || (defined !== undefined && defined !== "Self"))
				return issue(
					"UNSUPPORTED_PARAMETER",
					"unsupported Defined$ ChangeZone subject",
					where,
				);
			return { kind: "return to hand", object: "source" };
		}
		case "putcounter": {
			const badParams = checkParams(
				params,
				new Set([
					discriminatorLower,
					"defined",
					"validtgts",
					"tgtprompt",
					"countertype",
					"counternum",
					...COMMON_EFFECT_PARAMS,
				]),
				where,
			);
			if (badParams) return badParams;
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
				return {
					kind: "add counters",
					object: { targetSlot: TARGET_SLOT },
					counter,
					amount,
				};
			}
			// Forge defaults an omitted Defined$ to the source object when the
			// ability declares no targets. Only permanent abilities can use that
			// source as the recipient of counters.
			if (
				!allowSourceObject ||
				(defined !== undefined && defined !== "Self")
			)
				return issue(
					"UNSUPPORTED_PARAMETER",
					"unsupported non-targeted PutCounter subject",
					where,
				);
			return { kind: "add counters", object: "source", counter, amount };
		}
		case "token": {
			const badParams = checkParams(
				params,
				new Set([
					discriminatorLower,
					"tokenscript",
					"tokenowner",
					"tokenamount",
					...COMMON_EFFECT_PARAMS,
				]),
				where,
			);
			if (badParams) return badParams;
			const scriptId = getForgeParam(params, "TokenScript");
			if (!scriptId)
				return issue(
					"UNSUPPORTED_PARAMETER",
					"Token requires TokenScript$",
					where,
				);
			const owner = getForgeParam(params, "TokenOwner");
			if (owner !== undefined && owner !== "You")
				return issue(
					"UNSUPPORTED_PARAMETER",
					`unsupported TokenOwner$ ${owner}`,
					where,
				);
			const controller = parsePlayer(owner);
			if (!controller)
				return issue(
					"UNSUPPORTED_PARAMETER",
					"unsupported token controller",
					where,
				);
			const amount = positiveInteger(getForgeParam(params, "TokenAmount"), 1);
			if (!amount)
				return issue(
					"UNSUPPORTED_PARAMETER",
					"TokenAmount$ must be a positive integer",
					where,
				);
			const characteristics = fixedTokenCharacteristics(scriptId, where);
			if ("code" in characteristics) return characteristics;
			return {
				kind: "create-token",
				controller,
				characteristics,
				amount,
			};
		}
		case "pump": {
			const badParams = checkParams(
				params,
				new Set([
					discriminatorLower,
					"defined",
					"validtgts",
					"tgtprompt",
					"numatt",
					"numdef",
					"kw",
					...COMMON_EFFECT_PARAMS,
				]),
				where,
			);
			if (badParams) return badParams;
			const powerText = getForgeParam(params, "NumAtt");
			const toughnessText = getForgeParam(params, "NumDef");
			const keywordText = getForgeParam(params, "KW");
			if (
				keywordText !== undefined &&
				(powerText !== undefined || toughnessText !== undefined)
			)
				return issue(
					"UNSUPPORTED_PARAMETER",
					"Pump cannot combine KW$ with NumAtt$ or NumDef$",
					where,
				);
			if (keywordText !== undefined && keywordText !== "Indestructible")
				return issue(
					"UNSUPPORTED_PARAMETER",
					`unsupported temporary keyword ${keywordText}`,
					where,
				);
			const power = signedInteger(powerText);
			const toughness = signedInteger(toughnessText);
			if (keywordText === undefined && (power === null || toughness === null))
				return issue(
					"UNSUPPORTED_PARAMETER",
					"Pump requires fixed NumAtt and NumDef values, or KW$ Indestructible",
					where,
				);
			// `Defined$ Self` pumps the ability's own source ("it gets +1/+1");
			// `ValidTgts$` pumps a chosen target. Anything else -- both, neither,
			// or another Defined -- is outside the supported subset.
			const defined = getForgeParam(params, "Defined");
			const validTargets = getForgeParam(params, "ValidTgts");
			if (defined === "Self" && validTargets === undefined) {
				if (keywordText === "Indestructible") {
					return {
						kind: "grant-keyword",
						object: "source",
						keyword: "indestructible",
						duration: "until-end-of-turn",
					};
				}
				assert(power !== null && toughness !== null);
				return {
					kind: "modify-pt",
					object: "source",
					power,
					toughness,
					duration: "until-end-of-turn",
				};
			}
			if (defined === undefined && validTargets !== undefined) {
				if (keywordText === "Indestructible") {
					return {
						kind: "grant-keyword",
						object: { targetSlot: TARGET_SLOT },
						keyword: "indestructible",
						duration: "until-end-of-turn",
					};
				}
				assert(power !== null && toughness !== null);
				return {
					kind: "modify-pt",
					object: { targetSlot: TARGET_SLOT },
					power,
					toughness,
					duration: "until-end-of-turn",
				};
			}
			return issue(
				"UNSUPPORTED_PARAMETER",
				"Pump must either define Self or declare targets",
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
):
	| { token: (typeof ABILITY_DISCRIMINATOR_TOKENS)[number]; api: string }
	| ImportIssue {
	const present = ABILITY_DISCRIMINATOR_TOKENS.filter(
		(token) => params.effectiveLower[token.toLowerCase()] !== undefined,
	);
	if (present.length !== 1) {
		return issue(
			"UNSUPPORTED_PARAMETER",
			present.length === 0
				? "ability record has no AB/SP/ST/DB discriminator"
				: "ability record declares more than one AB/SP/ST/DB discriminator",
			where,
		);
	}
	const token = present[0] as (typeof ABILITY_DISCRIMINATOR_TOKENS)[number];
	return {
		token,
		api: (params.effectiveLower[token.toLowerCase()] ?? "").toLowerCase(),
	};
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
	face: ForgeFaceAst,
	rootParams: ForgeParamList,
	rootWhere: { nodeId?: string; line?: number },
	rejectAtRoot: boolean,
	rootTokens: readonly (typeof ABILITY_DISCRIMINATOR_TOKENS)[number][],
	parsePlayer: (value: string | undefined) => Player | null,
	allowSourceObject: boolean,
): { effects: EffectDef<Player>[]; usedSVarNames: string[] } | ImportIssue {
	const effects: EffectDef<Player>[] = [];
	const usedSVarNames: string[] = [];
	let current = rootParams;
	let where = rootWhere;
	const seen = new Set<string>();
	let depth = 0;
	for (;;) {
		if (depth > 0 && current.effectiveLower.validtgts !== undefined) {
			return issue(
				"UNSUPPORTED_EFFECT",
				"validtgts is not supported on a sub-ability continuation",
				where,
			);
		}
		if (depth > 0 || rejectAtRoot) {
			for (const key of CHAIN_FORBIDDEN) {
				if (current.effectiveLower[key] !== undefined) {
					return issue(
						"UNSUPPORTED_EFFECT",
						`${key} is not supported on a sub-ability continuation`,
						where,
					);
				}
			}
		}
		const disc = discriminator(current, where);
		if ("code" in disc) return disc;
		const allowedHere = depth === 0 ? rootTokens : (["DB"] as const);
		if (!(allowedHere as readonly string[]).includes(disc.token)) {
			return issue(
				"UNSUPPORTED_EFFECT",
				`expected ${allowedHere.join("/")} but found ${disc.token}`,
				where,
			);
		}
		const effect = parseSingleEffect(
			current,
			disc.token.toLowerCase(),
			disc.api,
			where,
			parsePlayer,
			allowSourceObject,
		);
		if ("code" in effect) return effect;
		effects.push(effect);
		const next = getForgeParam(current, "SubAbility");
		if (next === undefined) return { effects, usedSVarNames };
		const nextLower = next.trim().toLowerCase();
		if (seen.has(nextLower))
			return issue(
				"UNSUPPORTED_REFERENCE",
				`cyclic SubAbility chain at ${next}`,
				where,
			);
		seen.add(nextLower);
		const bucket = face.svarIndex[nextLower];
		if (!bucket || bucket.length === 0)
			return issue(
				"UNSUPPORTED_REFERENCE",
				`unresolved SubAbility ${next}`,
				where,
			);
		if (bucket.length > 1)
			return issue(
				"UNSUPPORTED_REFERENCE",
				`ambiguous duplicate SVar ${next}`,
				where,
			);
		const svar = bucket[0] as ForgeSVarRecord;
		if (svar.parsed.kind !== "params")
			return issue(
				"UNSUPPORTED_REFERENCE",
				`SubAbility ${next} is not an ability body`,
				where,
			);
		usedSVarNames.push(nextLower);
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

/* ------------------------------------------------------------------------- */
/* Continuous effects and replacements                                       */
/* ------------------------------------------------------------------------- */

function lowerStatic(
	record:
		| ForgeAbilityRecord
		| { params: ForgeParamList; source: { nodeId: string; line: number } },
): StaticAbilityDefinition | ImportIssue {
	const params = record.params;
	const where = { nodeId: record.source.nodeId, line: record.source.line };
	const badParams = checkParams(
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
	if (badParams) return badParams;
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
		return { kind: "cant-block-self", text: description };
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
		return {
			kind: "adjust-land-plays",
			text: description,
			affects: "you",
			amount,
		};
	}
	const selector = affected ? parseSelector(affected) : null;
	const addPower = signedInteger(getForgeParam(params, "AddPower"));
	const addToughness = signedInteger(getForgeParam(params, "AddToughness"));
	if (
		!selector ||
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
	return {
		layer: "7c-modify-power-toughness",
		text: description,
		applies(view, _state, source) {
			return (
				source.zone === "battlefield" &&
				selectorMatches(selector, view, {
					controller: source.controller,
					id: source.id,
				})
			);
		},
		modify(view) {
			if (!("power" in view) || !("toughness" in view)) return;
			view.power += addPower;
			view.toughness += addToughness;
		},
	};
}

function selectorContainsSelf(selector: ObjectSelectorDef): boolean {
	switch (selector.kind) {
		case "self":
			return true;
		case "all":
		case "any":
			return selector.selectors.some(selectorContainsSelf);
		case "not":
			return selectorContainsSelf(selector.selector);
		default:
			return false;
	}
}

type ReplacementLowering =
	| { kind: "self-entry" }
	| { kind: "global"; def: ReplacementEffectDefinition };

function lowerCopyEtbKeyword(
	face: ForgeFaceAst,
	record: ForgeKeywordRecord,
): { def: ReplacementEffectDefinition; usedSVar: string } | ImportIssue {
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
	const bucket = face.svarIndex[svarName.toLowerCase()];
	if (!bucket || bucket.length === 0) {
		return issue(
			"UNSUPPORTED_REFERENCE",
			`unresolved ETBReplacement ${svarName}`,
			where,
		);
	}
	if (bucket.length > 1) {
		return issue(
			"UNSUPPORTED_REFERENCE",
			`ambiguous duplicate SVar ${svarName}`,
			where,
		);
	}
	const body = bucket[0] as ForgeSVarRecord;
	if (body.parsed.kind !== "params") {
		return issue(
			"UNSUPPORTED_REFERENCE",
			`${svarName} is not an ability body`,
			where,
		);
	}
	const bodyWhere = { nodeId: body.source.nodeId, line: body.source.line };
	const badParams = checkParams(
		body.parsed.params,
		new Set(["db", "choices", "spelldescription"]),
		bodyWhere,
	);
	if (badParams) return badParams;
	const text = getForgeParam(body.parsed.params, "SpellDescription");
	if (
		getForgeParam(body.parsed.params, "DB") !== "Clone" ||
		getForgeParam(body.parsed.params, "Choices") !== "Creature.Other" ||
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
				copyableCreatureCandidates(ctx.read).length > 0
			);
		},
		replace(ev, ctx) {
			assert(ev.kind === "change zone");
			assert(ctx.self, "copy ETB replacement must have a source");
			const targetId = ctx.choices.chooseCopyAs(
				ctx.state,
				ctx.controller,
				ev,
				ctx.self.id,
				copyableCreatureCandidates(ctx.read),
			);
			if (targetId === null) return [ev];
			const target = readObject(ctx.read, targetId);
			assert(
				target.kind === "permanent",
				"copy-as candidate must be a permanent",
			);
			assert(ev.destination.zone === "battlefield");
			return [
				{
					...ev,
					destination: {
						...ev.destination,
						copiableOverride: cloneCharacteristics(target.copiableValues),
					},
				},
			];
		},
	};
	return { def, usedSVar: svarName.toLowerCase() };
}

function copyableCreatureCandidates(read: ReadContext): ObjectId[] {
	const candidates: ObjectId[] = [];
	for (const id of read.state.battlefield) {
		const snapshot = readObject(read, id);
		if (
			snapshot.kind === "permanent" &&
			snapshot.currentCharacteristics.types.includes("creature")
		)
			candidates.push(id);
	}
	return candidates;
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
	face: ForgeFaceAst,
	record:
		| ForgeAbilityRecord
		| { params: ForgeParamList; source: { nodeId: string; line: number } },
): ReplacementLowering | ImportIssue {
	const params = record.params;
	const where = { nodeId: record.source.nodeId, line: record.source.line };
	const badParams = checkParams(
		params,
		new Set([
			"event",
			"validcard",
			"destination",
			"replacewith",
			"replacementresult",
			"activezones",
			"description",
		]),
		where,
	);
	if (badParams) return badParams;
	if (
		getForgeParam(params, "Event") !== "Moved" ||
		getForgeParam(params, "Destination") !== "Battlefield" ||
		getForgeParam(params, "ReplacementResult") !== "Updated"
	)
		return issue("UNSUPPORTED_EFFECT", "unsupported replacement shape", where);
	const validCard = getForgeParam(params, "ValidCard");
	if (validCard === undefined)
		return issue("UNSUPPORTED_PARAMETER", "ValidCard$ is required", where);
	const replaceWith = getForgeParam(params, "ReplaceWith");
	if (replaceWith === undefined)
		return issue("UNSUPPORTED_REFERENCE", "missing ReplaceWith$", where);
	const bucket = face.svarIndex[replaceWith.trim().toLowerCase()];
	if (!bucket || bucket.length === 0)
		return issue(
			"UNSUPPORTED_REFERENCE",
			`unresolved ReplaceWith ${replaceWith}`,
			where,
		);
	if (bucket.length > 1)
		return issue(
			"UNSUPPORTED_REFERENCE",
			`ambiguous duplicate SVar ${replaceWith}`,
			where,
		);
	const effectSVar = bucket[0] as ForgeSVarRecord;
	if (effectSVar.parsed.kind !== "params")
		return issue(
			"UNSUPPORTED_REFERENCE",
			`${replaceWith} is not an ability body`,
			where,
		);
	const effectParams = effectSVar.parsed.params;
	const effectWhere = {
		nodeId: effectSVar.source.nodeId,
		line: effectSVar.source.line,
	};
	const effectBad = checkParams(
		effectParams,
		new Set(["db", "etb", "defined"]),
		effectWhere,
	);
	if (effectBad) return effectBad;
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
		return { kind: "self-entry" };
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
	if (!selector || selectorContainsSelf(selector))
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
			return selectorMatches(selector, etbPreview(ctx.state, ev), {
				controller: ctx.controller,
				id: ctx.self.id,
			});
		},
		replace: (ev: GameEvent) =>
			ev.kind === "change zone" && ev.destination.zone === "battlefield"
				? [{ ...ev, destination: { ...ev.destination, tapped: true } }]
				: [ev],
	};
	return { kind: "global", def };
}

/* ------------------------------------------------------------------------- */
/* Triggers                                                                   */
/* ------------------------------------------------------------------------- */

function lowerTrigger(
	face: ForgeFaceAst,
	record: { params: ForgeParamList; source: { nodeId: string; line: number } },
	used: Set<string>,
): TriggeredAbilityDefinition | ImportIssue {
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

	const bucket = face.svarIndex[execute.trim().toLowerCase()];
	if (!bucket || bucket.length === 0)
		return issue(
			"UNSUPPORTED_REFERENCE",
			`unresolved Execute ${execute}`,
			where,
		);
	if (bucket.length > 1)
		return issue(
			"UNSUPPORTED_REFERENCE",
			`ambiguous duplicate SVar ${execute}`,
			where,
		);
	const executeSVar = bucket[0] as ForgeSVarRecord;
	if (executeSVar.parsed.kind !== "params")
		return issue(
			"UNSUPPORTED_REFERENCE",
			`${execute} is not an ability body`,
			where,
		);
	used.add(execute.trim().toLowerCase());

	const optionalDecider = getForgeParam(params, "OptionalDecider");
	if (optionalDecider !== undefined && optionalDecider !== "You")
		return issue(
			"UNSUPPORTED_EFFECT",
			"only OptionalDecider$ You is supported",
			where,
		);

	const chain = lowerEffectChain(
		face,
		executeSVar.parsed.params,
		{ nodeId: executeSVar.source.nodeId, line: executeSVar.source.line },
		true,
		["DB"],
		mode === "SpellCast" ? spellCastEffectPlayer : triggerEffectPlayer,
		true,
	);
	if ("code" in chain) return chain;
	for (const n of chain.usedSVarNames) used.add(n);
	const effects = optionalDecider
		? [
				{
					kind: "may" as const,
					decider: "you" as const,
					effects: chain.effects,
				},
			]
		: chain.effects;

	// The trigger declares its targets on the executed ability, not on the T:
	// line, and the engine chooses them when the ability goes on the stack.
	const targets = parseTarget(
		getForgeParam(executeSVar.parsed.params, "ValidTgts"),
	);
	if (!targets)
		return issue("UNSUPPORTED_TARGET", "unsupported ValidTgts$ value", where);
	const slotIssue = checkEffectTargetSlots(effects, targets, where);
	if (slotIssue) return slotIssue;

	switch (mode) {
		case "SpellCast": {
			const badParams = checkParams(
				params,
				new Set([
					"mode",
					"validcard",
					"validactivatingplayer",
					"triggerzones",
					"execute",
					"optionaldecider",
					"triggerdescription",
				]),
				where,
			);
			if (badParams) return badParams;
			if (getForgeParam(params, "TriggerZones") !== "Battlefield")
				return issue(
					"UNSUPPORTED_EFFECT",
					"only battlefield SpellCast triggers are supported",
					where,
				);

			const rawPlayer = getForgeParam(params, "ValidActivatingPlayer");
			const castPlayer = rawPlayer ? parseValidPlayer(rawPlayer) : null;
			if (castPlayer === null)
				return issue(
					"UNSUPPORTED_PARAMETER",
					"SpellCast requires a supported ValidActivatingPlayer$",
					where,
				);

			const rawSelector = getForgeParam(params, "ValidCard");
			const selector = rawSelector ? parseSelector(rawSelector) : null;
			if (selector === null)
				return issue(
					"UNSUPPORTED_PARAMETER",
					"SpellCast requires a supported ValidCard$ selector",
					where,
				);

			return {
				id: execute,
				text,
				condition: { kind: "cast", player: castPlayer, selector },
				targets,
				effects,
			};
		}
		case "ChangesZone": {
			const badParams = checkParams(
				params,
				new Set([
					"mode",
					"origin",
					"destination",
					"validcard",
					"triggerzones",
					"secondary",
					"execute",
					"triggerdescription",
				]),
				where,
			);
			if (badParams) return badParams;
			const triggerZones = getForgeParam(params, "TriggerZones");
			const secondary = getForgeParam(params, "Secondary");
			const origin = getForgeParam(params, "Origin");
			const destination = getForgeParam(params, "Destination");
			// The trigger watches the battlefield either way: an
			// enters-the-battlefield trigger from any zone, or a dies trigger on
			// the permanent itself. Forge omits TriggerZones on the latter,
			// which matches the engine's battlefield-by-default functionsFrom.
			const etb = origin === "Any" && destination === "Battlefield";
			const dies = origin === "Battlefield" && destination === "Graveyard";
			if (
				!(etb || dies) ||
				(triggerZones !== undefined && triggerZones !== "Battlefield") ||
				(secondary !== undefined && secondary !== "True")
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
			// The engine only resolves battlefield-origin triggers for the
			// departing permanent itself; anything wider throws at trigger time,
			// so reject it here instead of importing a card that cannot die.
			if (dies && selector.kind !== "self")
				return issue(
					"UNSUPPORTED_PARAMETER",
					"only Card.Self dies triggers are supported",
					where,
				);
			return {
				id: execute,
				text,
				condition: dies
					? {
							kind: "change zone",
							from: "battlefield",
							to: "graveyard",
							selector,
						}
					: {
							kind: "change zone",
							from: "any",
							to: "battlefield",
							selector,
						},
				targets,
				effects,
			};
		}
		case "Phase": {
			const badParams = checkParams(
				params,
				new Set([
					"mode",
					"phase",
					"validplayer",
					"triggerzones",
					"execute",
					"optionaldecider",
					"triggerdescription",
				]),
				where,
			);
			if (badParams) return badParams;
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
			return {
				id: execute,
				text,
				condition: { kind: "begin step", player, step: "upkeep" },
				targets,
				effects,
			};
		}
		case "Attacks": {
			const badParams = checkParams(
				params,
				new Set(["mode", "validcard", "execute", "triggerdescription"]),
				where,
			);
			if (badParams) return badParams;
			if (getForgeParam(params, "ValidCard") !== "Card.Self")
				return issue(
					"UNSUPPORTED_EFFECT",
					"unsupported Attacks trigger shape",
					where,
				);
			return {
				id: execute,
				text,
				condition: { kind: "declare attackers", selector: { kind: "self" } },
				targets,
				effects,
			};
		}
		case "DamageDone": {
			const badParams = checkParams(
				params,
				new Set([
					"mode",
					"validsource",
					"validtarget",
					"combatdamage",
					"triggerzones",
					"execute",
					"optionaldecider",
					"triggerdescription",
				]),
				where,
			);
			if (badParams) return badParams;
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
			return {
				id: execute,
				text,
				condition: {
					kind: "damage",
					source: "self",
					target: "player",
					combat: true,
				},
				targets,
				effects,
			};
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
/* Mana cost                                                                  */
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
): ActivationCost | ImportIssue {
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
	let sawZero = false;
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
			if (sawZero) {
				return issue(
					"UNSUPPORTED_COST",
					"malformed activation cost: 0 cannot be combined with other mana terms",
					where,
				);
			}
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
			const selectorChoices: ObjectSelectorDef[] = [];
			for (const choice of selectorText.split(";")) {
				if (choice === "CARDNAME") {
					selectorChoices.push({ kind: "self" });
					continue;
				}
				const excludesSelf = choice.endsWith(".Other");
				const parsed = parseSelectorPart(
					excludesSelf ? choice.slice(0, -".Other".length) : choice,
				);
				if (!parsed) {
					return issue(
						"UNSUPPORTED_COST",
						`unsupported sacrifice selector ${selectorText}`,
						where,
					);
				}
				selectorChoices.push(
					excludesSelf
						? combineSelectors("all", [
								parsed,
								{ kind: "not", selector: { kind: "self" } },
							])
						: parsed,
				);
			}
			sacrifice = {
				selector: combineSelectors("any", selectorChoices),
				amount: 1,
			};
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
				if (sawZero || sawMana) {
					return issue(
						"UNSUPPORTED_COST",
						"malformed activation cost: 0 cannot be combined with other mana terms",
						where,
					);
				}
				sawZero = true;
				continue;
			}
			if (sawZero) {
				return issue(
					"UNSUPPORTED_COST",
					"malformed activation cost: 0 cannot be combined with other mana terms",
					where,
				);
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

	return {
		mana: sawMana ? mana : "zero",
		tapSelf,
		...(sacrifice ? { sacrifice } : {}),
	};
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
		if ((SUPERTYPES as ReadonlySet<string>).has(word)) {
			const supertype = word as Supertype;
			if (lastType >= 0 || sawSubtype || supertypes.includes(supertype))
				return invalidTypesLine();
			supertypes.push(supertype);
			continue;
		}
		if ((CARD_TYPES as ReadonlySet<string>).has(word)) {
			const type = word as CardType;
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
	const usedSVarNames = new Set<string>();
	const entersWith: Partial<Record<"+1/+1" | "-1/-1", number>> = {};
	for (const record of face.keywordRecords) {
		const where = { nodeId: record.source.nodeId, line: record.source.line };
		if (record.keyword === "ETBReplacement") {
			const lowered = lowerCopyEtbKeyword(face, record);
			if ("code" in lowered) return reject(lowered);
			keywordReplacements.push(lowered.def);
			usedSVarNames.add(lowered.usedSVar);
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

	for (const bucket of Object.values(face.svarIndex)) {
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
		if ("code" in lowered) return reject(lowered);
		statics.push(lowered);
	}

	const replacements: ReplacementEffectDefinition[] = [...keywordReplacements];
	let entersTappedFromReplacement = false;
	for (const record of face.replacements) {
		const lowered = lowerReplacement(face, record);
		if ("code" in lowered) return reject(lowered);
		if (lowered.kind === "self-entry") {
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
			replacements.push(lowered.def);
		}
		const replaceWith = getForgeParam(record.params, "ReplaceWith");
		if (replaceWith) usedSVarNames.add(replaceWith.toLowerCase());
	}

	const triggers: TriggeredAbilityDefinition[] = [];
	for (const record of face.triggers) {
		const lowered = lowerTrigger(face, record, usedSVarNames);
		if ("code" in lowered) return reject(lowered);
		triggers.push(lowered);
	}

	let spell: SpellAbilityDef | undefined;
	const activatedAbilities: AnyActivatedAbilityDefinition[] = [];
	let spellCount = 0;
	let activatedCount = 0;
	for (const record of face.abilities) {
		const where = { nodeId: record.source.nodeId, line: record.source.line };
		const params = record.params;
		const disc = discriminator(params, where);
		if ("code" in disc) return reject(disc);
		if (disc.token !== "AB" && disc.token !== "SP") {
			return reject(
				issue(
					"UNSUPPORTED_EFFECT",
					"expected an AB$ or SP$ root ability",
					where,
				),
			);
		}

		const activationCost =
			disc.token === "AB"
				? parseActivationCost(getForgeParam(params, "Cost"), where)
				: undefined;
		if (activationCost && "code" in activationCost) {
			return reject(activationCost);
		}

		if (disc.token === "AB" && disc.api === "mana") {
			const badParams = checkParams(
				params,
				new Set(["ab", "cost", "produced", "amount", "spelldescription"]),
				where,
			);
			if (badParams) return reject(badParams);
			assert(activationCost !== undefined && !("code" in activationCost));
			const produced = getForgeParam(params, "Produced");
			const modal = produced?.startsWith("Combo ") ?? false;
			// Forge's fixed multi-mana form is exactly a space-separated list of
			// printed symbols. `Combo` uses the same symbol list for mutually
			// exclusive choices. Keep both forms strict so `Any`, variables,
			// compact (`WU`), and malformed separators cannot change meaning.
			const producedSymbols = modal
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
					new Set(producedTypes).size !== producedTypes.length ||
					(amountText !== undefined && amountText !== "1")
				) {
					return reject(
						issue(
							"UNSUPPORTED_EFFECT",
							`unsupported produced mana ${produced ?? "(none)"}`,
							where,
						),
					);
				}
				const [first, second, ...rest] = producedTypes.map((type) =>
					fullMana(type),
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
						`Add ${producedSymbols.map((symbol) => `{${symbol}}`).join(" or ")}.`,
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
				effects: [{ kind: "add-mana", player: "you", mana }],
			});
			continue;
		}

		// A spell's `Cost$` restates the printed mana cost and then appends the
		// additional costs. Only the appended part is new information, so the
		// mana part is checked against `ManaCost:` rather than charged again.
		let additionalCost: SpellAdditionalCostDef | undefined;
		if (disc.token === "SP") {
			const costText = getForgeParam(params, "Cost");
			if (costText !== undefined) {
				const parsed = parseActivationCost(costText, where);
				if ("code" in parsed) return reject(parsed);
				const restated = restatesManaCost(parsed.mana, manaCost);
				if (parsed.tapSelf || !restated || !parsed.sacrifice) {
					return reject(
						issue(
							"UNSUPPORTED_COST",
							`unsupported additional spell cost ${costText}`,
							where,
						),
					);
				}
				// The engine models exactly one additional cost: sacrifice one
				// creature you control. A narrower or wider selector (Sac<1/Goblin>,
				// Sac<1/Permanent>) would change which permanents pay it.
				const selector = parsed.sacrifice.selector;
				if (!(selector.kind === "type" && selector.type === "creature")) {
					return reject(
						issue(
							"UNSUPPORTED_COST",
							`unsupported additional sacrifice cost ${costText}`,
							where,
						),
					);
				}
				additionalCost = {
					kind: "sacrifice",
					selector: { kind: "type", type: "creature" },
					amount: 1,
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

		const chain = lowerEffectChain(
			face,
			params,
			where,
			false,
			disc.token === "SP" ? ["SP"] : ["AB"],
			player,
			disc.token === "AB",
		);
		if ("code" in chain) return reject(chain);
		const targets = parseTarget(
			getForgeParam(params, "ValidTgts"),
			getForgeParam(params, "TargetType"),
		);
		if (!targets)
			return reject(
				issue("UNSUPPORTED_TARGET", "unsupported ValidTgts$ value", where),
			);
		const slotIssue = checkEffectTargetSlots(chain.effects, targets, where);
		if (slotIssue) return reject(slotIssue);
		const description = getForgeParam(params, "SpellDescription");
		if (!description)
			return reject(
				issue("UNSUPPORTED_PARAMETER", "SpellDescription$ is required", where),
			);

		for (const n of chain.usedSVarNames) usedSVarNames.add(n);

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
				...(additionalCost ? { additionalCost } : {}),
				targets,
				effects: chain.effects,
			};
		} else {
			assert(activationCost !== undefined && !("code" in activationCost));
			activatedCount += 1;
			activatedAbilities.push({
				kind: "activated",
				id: `activated-${activatedCount}`,
				text: description,
				cost: activationCost,
				targets,
				effects: chain.effects,
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
							ability.effects[0] as Extract<EffectDef, { kind: "add-mana" }>
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
				effects: [{ kind: "add-mana", player: "you", mana: fullMana(color) }],
			});
		}
	}

	// Recognized non-referenced SVars, kept exactly as data by design (AI hints /
	// deck-building metadata), scoped to when the feature they describe is present.
	const buffedBy = lookupForgeSVar(face, "BuffedBy")?.parsed;
	// `BuffedBy` is an AI/deck-building hint. A cast trigger carries its complete
	// rules in the trigger and executed SVar, so retain this conventional hint
	// only when the card has a supported cast-triggered source modification or
	// direct-damage effect.
	if (
		triggers.some(
			(trigger) =>
				trigger.condition.kind === "cast" &&
				trigger.effects.some(
					(effect) =>
						effect.kind === "add counters" || effect.kind === "damage",
				),
		) &&
		buffedBy?.kind === "scalar"
	)
		usedSVarNames.add("buffedby");
	const hasAttackEffect = lookupForgeSVar(face, "HasAttackEffect")?.parsed;
	if (
		triggers.some((t) => t.condition.kind === "declare attackers") &&
		hasAttackEffect?.kind === "scalar" &&
		hasAttackEffect.value === "TRUE"
	)
		usedSVarNames.add("hasattackeffect");
	// PlayMain1 tells Forge's AI to cast the card before combat, which only says
	// anything about a card that does something once it is on the battlefield.
	const playMain1 = lookupForgeSVar(face, "PlayMain1")?.parsed;
	if (
		(statics.length > 0 || triggers.length > 0) &&
		playMain1?.kind === "scalar" &&
		playMain1.value === "TRUE"
	)
		usedSVarNames.add("playmain1");
	// SacMe ranks how eagerly Forge's AI sacrifices the card, which only says
	// anything about a card that wants to be in the graveyard. A dies trigger is
	// the supported shape that gives it that reason.
	const sacMe = lookupForgeSVar(face, "SacMe")?.parsed;
	if (
		triggers.some(
			(trigger) =>
				trigger.condition.kind === "change zone" &&
				trigger.condition.from === "battlefield",
		) &&
		sacMe?.kind === "scalar" &&
		/^[0-9]+$/.test(sacMe.value)
	)
		usedSVarNames.add("sacme");
	const nonCombatPriority = lookupForgeSVar(face, "NonCombatPriority")?.parsed;
	if (
		activatedAbilities.length > 0 &&
		nonCombatPriority?.kind === "scalar" &&
		nonCombatPriority.value === "1"
	)
		usedSVarNames.add("noncombatpriority");

	for (const record of face.svars) {
		if (!usedSVarNames.has(record.name.toLowerCase())) {
			return reject(
				issue("UNSUPPORTED_REFERENCE", `unused SVar ${record.name}`, {
					nodeId: record.source.nodeId,
					line: record.source.line,
				}),
			);
		}
	}

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
