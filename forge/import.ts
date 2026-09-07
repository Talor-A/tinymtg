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
 * temporary P/T effects; random or multi-card discard; alternate/additional
 * costs on spells or activations other than a bare tap-self;
 * X/hybrid/Phyrexian/snow mana and dynamic amounts; more than one target slot,
 * or an optional one; selector modifiers outside `YouCtrl`/`OppCtrl` and
 * `non`-prefixable color, card type, and supertype words (so hexproof, shroud,
 * protection, and combat- or zone-dependent restrictions all reject, while a
 * subtype is only readable as a selector's base); more than one spell ability, or a
 * spell ability on a permanent card; conditions, alternate "unless" costs, or
 * new target declarations on a `SubAbility`/`Execute` continuation;
 * alternate/specialize faces, `Variant:` patches, and `Draft:` actions; and any
 * `Card.Self`-containing selector inside a global (`ActiveZones$`) replacement
 * (see `lowerReplacement`).
 */

import type {
	AnyActivatedAbilityDefinition,
	CardDef,
	CardDefInput,
	CardType,
	Color,
	EffectDef,
	GameEvent,
	ManaCostType,
	ManaPool,
	ManaType,
	ReplacementEffectDefinition,
	SpellAbilityDef,
	StaticAbilityDefinition,
	Supertype,
	TargetDef,
	TargetSelectorDef,
	TriggeredAbilityDefinition,
	ValidPlayer,
} from "../index.ts";
import {
	defineCard,
	etbPreview,
	MANA_COST_TYPES,
	selectorMatches,
} from "../index.ts";
import type {
	ForgeAbilityRecord,
	ForgeCardAst,
	ForgeFaceAst,
	ForgeParamList,
	ForgeSVarRecord,
} from "./ast.ts";
import { getForgeParam, lookupForgeSVar, parseForgeCardScript } from "./ast.ts";

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
 * The `Produced$` values that name exactly one kind of mana. Colorless belongs
 * here but never in {@link COLOR_WORDS}: `Produced$ C` makes colorless mana,
 * while a card producing it is not thereby any color.
 *
 * Everything else Forge writes here — `Any`, `Combo W U`, `Chosen`, and the
 * multi-symbol forms — is a choice the engine cannot yet represent, so it
 * rejects the card.
 */
const PRODUCED_MANA_SYMBOLS = new Map<string, ManaType>([
	["W", "w"],
	["U", "u"],
	["B", "b"],
	["R", "r"],
	["G", "g"],
	["C", "c"],
]);
const BARE_KEYWORDS = new Map<
	string,
	"indestructible" | "lifelink" | "flying" | "vigilance"
>([
	["Flying", "flying"],
	["Lifelink", "lifelink"],
	["Indestructible", "indestructible"],
	["Vigilance", "vigilance"],
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

function player(value: string | undefined): "you" | "opponent" | null {
	if (value === undefined || value === "You") return "you";
	if (value === "Opponent") return "opponent";
	return null;
}

/* ------------------------------------------------------------------------- */
/* Selectors and targets                                                      */
/* ------------------------------------------------------------------------- */

function combineSelectors(
	kind: "all" | "any",
	selectors: TargetSelectorDef[],
): TargetSelectorDef {
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

function parseSelectorModifier(modifier: string): TargetSelectorDef | null {
	if (modifier === "YouCtrl") return { kind: "controller", player: "you" };
	if (modifier === "OppCtrl") return { kind: "controller", player: "opponent" };
	const negated = modifier.startsWith("non");
	const word = (negated ? modifier.slice(3) : modifier).toLowerCase();
	const color = COLOR_WORDS.get(word);
	const type = [...CARD_TYPES].find((candidate) => candidate === word);
	const supertype = [...SUPERTYPES].find((candidate) => candidate === word);
	let selector: TargetSelectorDef | null = null;
	if (color) selector = { kind: "color", color };
	else if (type) selector = { kind: "type", type };
	else if (supertype) selector = { kind: "supertype", supertype };
	if (!selector) return null;
	return negated ? { kind: "not", selector } : selector;
}

function parseSelectorPart(value: string): TargetSelectorDef | null {
	if (value === "Card.Self" || value === "Self") return { kind: "self" };
	const pieces = value.split(".");
	const base = pieces.shift();
	const parts: TargetSelectorDef[] = [];
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

function parseSelector(value: string): TargetSelectorDef | null {
	const choices = value
		.split(",")
		.map((part) => parseSelectorPart(part.trim()));
	return choices.every((choice): choice is TargetSelectorDef => choice !== null)
		? combineSelectors("any", choices)
		: null;
}

/** The one target slot the engine supports; every lowered effect refers to it. */
const TARGET_SLOT = "target-1";

/**
 * A targeting effect and its ability's `ValidTgts$` have to agree, or the
 * engine would resolve an effect against a target nobody checked.
 */
function checkEffectTargetSlots(
	effects: EffectDef[],
	targets: TargetDef[],
	where: { nodeId?: string; line?: number },
): ImportIssue | null {
	for (const effect of effects) {
		if (effect.kind === "may") {
			const inner = checkEffectTargetSlots(effect.effects, targets, where);
			if (inner) return inner;
			continue;
		}
		if (effect.kind !== "damage" && effect.kind !== "destroy") continue;
		const target = targets[0];
		if (targets.length !== 1 || !target || effect.targetSlot !== target.id) {
			return issue(
				"UNSUPPORTED_TARGET",
				"damage/destroy effects must reference the declared target slot",
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
	}
	return null;
}

/**
 * `ValidTgts$`-shaped values. Anything `parseSelector` accepts is a permanent
 * restriction the engine can check; `Any` and `Player` are the two forms that
 * are not object restrictions at all.
 */
function parseTarget(value: string | undefined): TargetDef[] | null {
	if (value === undefined) return [];
	let legal: TargetDef["legal"];
	if (value === "Any") legal = { kind: "any-target" };
	else if (value === "Player") legal = { kind: "player" };
	else {
		const selector = parseSelector(value);
		if (!selector) return null;
		legal = { kind: "permanent", selector };
	}
	return [{ id: TARGET_SLOT, min: 1, max: 1, legal }];
}

/* ------------------------------------------------------------------------- */
/* Effects                                                                    */
/* ------------------------------------------------------------------------- */

const COMMON_EFFECT_PARAMS = ["spelldescription", "subability", "cost"];

function parseSingleEffect(
	params: ForgeParamList,
	discriminatorLower: string,
	api: string,
	where: { nodeId?: string; line?: number },
): Exclude<EffectDef, { kind: "may" }> | ImportIssue {
	switch (api) {
		case "gainlife":
		case "loselife": {
			const badParams = checkParams(
				params,
				new Set([
					discriminatorLower,
					"defined",
					"lifeamount",
					...COMMON_EFFECT_PARAMS,
				]),
				where,
			);
			if (badParams) return badParams;
			const who = player(getForgeParam(params, "Defined"));
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
		case "draw": {
			const badParams = checkParams(
				params,
				new Set([
					discriminatorLower,
					"defined",
					"numcards",
					...COMMON_EFFECT_PARAMS,
				]),
				where,
			);
			if (badParams) return badParams;
			const who = player(getForgeParam(params, "Defined"));
			const amount = positiveInteger(getForgeParam(params, "NumCards"), 1);
			if (!who || !amount)
				return issue(
					"UNSUPPORTED_PARAMETER",
					"unsupported draw amount/player",
					where,
				);
			return { kind: "draw", player: who, amount };
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
			const who = player(getForgeParam(params, "Defined"));
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
					"numdmg",
					...COMMON_EFFECT_PARAMS,
				]),
				where,
			);
			if (badParams) return badParams;
			const amount = positiveInteger(getForgeParam(params, "NumDmg"));
			if (!amount)
				return issue("UNSUPPORTED_PARAMETER", "unsupported NumDmg", where);
			return { kind: "damage", targetSlot: TARGET_SLOT, amount };
		}
		case "destroy": {
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
			return { kind: "destroy", targetSlot: TARGET_SLOT };
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
function lowerEffectChain(
	face: ForgeFaceAst,
	rootParams: ForgeParamList,
	rootWhere: { nodeId?: string; line?: number },
	rejectAtRoot: boolean,
	rootTokens: readonly (typeof ABILITY_DISCRIMINATOR_TOKENS)[number][],
): { effects: EffectDef[]; usedSVarNames: string[] } | ImportIssue {
	const effects: EffectDef[] = [];
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

function selectorContainsSelf(selector: TargetSelectorDef): boolean {
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
				ev.to !== "battlefield" ||
				ev.entersTapped
			)
				return false;
			return selectorMatches(selector, etbPreview(ctx.state, ev), {
				controller: ctx.controller,
				id: ctx.self.id,
			});
		},
		replace: (ev: GameEvent) =>
			ev.kind === "change zone" ? [{ ...ev, entersTapped: true }] : [ev],
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
		case "ChangesZone": {
			const badParams = checkParams(
				params,
				new Set([
					"mode",
					"origin",
					"destination",
					"validcard",
					"execute",
					"triggerdescription",
				]),
				where,
			);
			if (badParams) return badParams;
			if (
				getForgeParam(params, "Origin") !== "Any" ||
				getForgeParam(params, "Destination") !== "Battlefield" ||
				getForgeParam(params, "ValidCard") !== "Card.Self"
			)
				return issue(
					"UNSUPPORTED_EFFECT",
					"unsupported ChangesZone trigger shape",
					where,
				);
			return {
				id: execute,
				text,
				condition: {
					kind: "change zone",
					from: "any",
					to: "battlefield",
					selector: "self",
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
				condition: { kind: "declare attackers", selector: "self" },
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

	const keywords: ("indestructible" | "lifelink" | "flying" | "vigilance")[] =
		[];
	const entersWith: Partial<Record<"+1/+1" | "-1/-1", number>> = {};
	for (const record of face.keywordRecords) {
		const where = { nodeId: record.source.nodeId, line: record.source.line };
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

	const usedSVarNames = new Set<string>();
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

	const replacements: ReplacementEffectDefinition[] = [];
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

		if (disc.token === "AB" && disc.api === "mana") {
			const badParams = checkParams(
				params,
				new Set(["ab", "cost", "produced", "amount", "spelldescription"]),
				where,
			);
			if (badParams) return reject(badParams);
			if (getForgeParam(params, "Cost") !== "T") {
				return reject(
					issue(
						"UNSUPPORTED_COST",
						"only a tap-self cost is supported for mana abilities",
						where,
					),
				);
			}
			const produced = getForgeParam(params, "Produced");
			const type = produced ? PRODUCED_MANA_SYMBOLS.get(produced) : undefined;
			if (!type) {
				return reject(
					issue(
						"UNSUPPORTED_EFFECT",
						`unsupported produced mana ${produced ?? "(none)"}`,
						where,
					),
				);
			}
			// A `Count$`/SVar amount (Urza's Tower) lands here: the symbol is
			// fine, the quantity is the part the engine cannot yet express.
			const amount = positiveInteger(getForgeParam(params, "Amount"), 1);
			if (!amount) {
				return reject(
					issue(
						"UNSUPPORTED_EFFECT",
						`unsupported mana amount ${getForgeParam(params, "Amount") ?? ""}`,
						where,
					),
				);
			}
			activatedCount += 1;
			activatedAbilities.push({
				kind: "mana",
				id: `activated-${activatedCount}`,
				text: getForgeParam(params, "SpellDescription") ?? `Add {${produced}}.`,
				costs: [{ kind: "tap-self" }],
				effects: [
					{ kind: "add-mana", player: "you", mana: fullMana(type, amount) },
				],
			});
			continue;
		}

		if (disc.token === "AB" && getForgeParam(params, "Cost") !== "T") {
			return reject(
				issue(
					"UNSUPPORTED_COST",
					"only a tap-self activation cost is supported",
					where,
				),
			);
		}
		if (disc.token === "SP" && getForgeParam(params, "Cost") !== undefined) {
			return reject(
				issue(
					"UNSUPPORTED_COST",
					"additional spell costs are unsupported",
					where,
				),
			);
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
		);
		if ("code" in chain) return reject(chain);
		const targets = parseTarget(getForgeParam(params, "ValidTgts"));
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
				targets,
				effects: chain.effects,
			};
		} else {
			activatedCount += 1;
			activatedAbilities.push({
				kind: "activated",
				id: `activated-${activatedCount}`,
				text: description,
				costs: [{ kind: "tap-self" }],
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
					ability.costs.length === 1 &&
					ability.costs[0]?.kind === "tap-self" &&
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
				costs: [{ kind: "tap-self" }],
				effects: [{ kind: "add-mana", player: "you", mana: fullMana(color) }],
			});
		}
	}

	// Recognized non-referenced SVars, kept exactly as data by design (AI hints /
	// deck-building metadata), scoped to when the feature they describe is present.
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
