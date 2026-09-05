import { compileForgeCard } from "./forge-compiler.ts";
import {
	FORGE_CARD_IR_VERSION,
	type ForgeCardIR,
	type ForgeCardType,
	type ForgeDiagnostic,
	type ForgeResult,
	type ForgeRule,
	type ForgeSelector,
	type ForgeTarget,
	validateForgeCardIR,
} from "./forge-ir.ts";
import type { CardDef, Color, EffectDef, Keyword, Supertype } from "./index.ts";

interface SourceLine {
	key: string;
	value: string;
	line: number;
}

const CARD_TYPES = new Map<string, ForgeCardType>(
	[
		"artifact",
		"creature",
		"enchantment",
		"instant",
		"land",
		"planeswalker",
		"sorcery",
	].map((type) => [type, type as ForgeCardType]),
);
const SUPERTYPES = new Map<string, Supertype>(
	["basic", "legendary", "snow"].map((type) => [type, type as Supertype]),
);
const COLORS: Record<string, Color> = {
	w: "w",
	white: "w",
	u: "u",
	blue: "u",
	b: "b",
	black: "b",
	r: "r",
	red: "r",
	g: "g",
	green: "g",
};
const KEYWORDS: Record<string, Keyword> = {
	Flying: "flying",
	Lifelink: "lifelink",
	Indestructible: "indestructible",
};
const COUNTERS = { P1P1: "+1/+1", M1M1: "-1/-1" } as const;
const BASIC_LAND_MANA: Record<string, Color | undefined> = {
	Plains: "w",
	Island: "u",
	Swamp: "b",
	Mountain: "r",
	Forest: "g",
};

function failure(
	stage: ForgeDiagnostic["stage"],
	code: string,
	message: string,
	line?: number,
): ForgeResult<never> {
	return {
		ok: false,
		diagnostics: [{ stage, code, message, ...(line ? { line } : {}) }],
	};
}

function sourceLines(text: string): ForgeResult<SourceLine[]> {
	const out: SourceLine[] = [];
	for (const [index, raw] of text
		.replaceAll("\r\n", "\n")
		.split("\n")
		.entries()) {
		const value = raw.trim();
		if (value === "" || value.startsWith("#")) continue;
		if (value === "ALTERNATE" || value === "SPECIALIZE")
			return failure(
				"source",
				"UNSUPPORTED_FACE",
				`${value} cards are unsupported`,
				index + 1,
			);
		const colon = value.indexOf(":");
		if (colon <= 0)
			return failure(
				"source",
				"MALFORMED_LINE",
				"expected key:value",
				index + 1,
			);
		out.push({
			key: value.slice(0, colon),
			value: value.slice(colon + 1).trim(),
			line: index + 1,
		});
	}
	return { ok: true, value: out, diagnostics: [] };
}

function one(lines: SourceLine[], key: string): ForgeResult<SourceLine> {
	const found = lines.filter((line) => line.key === key);
	if (found.length !== 1 || !found[0]?.value)
		return failure(
			"source",
			"REQUIRED_FIELD",
			`expected exactly one non-empty ${key}`,
			found[1]?.line ?? found[0]?.line,
		);
	return { ok: true, value: found[0], diagnostics: [] };
}

function cardId(name: string): string | null {
	return (
		name
			.normalize("NFKD")
			.replace(/[\u0300-\u036f]/g, "")
			.toLowerCase()
			.replace(/[’']/g, "")
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "") || null
	);
}

function parseManaCost(text: string): ForgeCardIR["manaCost"] | null {
	if (text === "no cost") return { kind: "none" };
	if (text === "0") return { kind: "zero" };
	const result = {
		kind: "symbols" as const,
		generic: 0,
		w: 0,
		u: 0,
		b: 0,
		r: 0,
		g: 0,
	};
	for (const symbol of text.split(/\s+/)) {
		if (/^[1-9]\d*$/.test(symbol)) result.generic += Number(symbol);
		else if (
			symbol === "W" ||
			symbol === "U" ||
			symbol === "B" ||
			symbol === "R" ||
			symbol === "G"
		)
			result[symbol.toLowerCase() as Color] += 1;
		else return null;
	}
	return result.generic + result.w + result.u + result.b + result.r + result.g >
		0
		? result
		: null;
}

function manaColors(mana: ForgeCardIR["manaCost"]): Color[] {
	if (mana.kind !== "symbols") return [];
	return (["w", "u", "b", "r", "g"] as const).filter(
		(color) => mana[color] > 0,
	);
}

function parseTypes(
	value: string,
): Pick<ForgeCardIR, "types" | "subtypes" | "supertypes"> | null {
	const words = value.split(/\s+/).filter(Boolean);
	const types: ForgeCardType[] = [];
	const supertypes: Supertype[] = [];
	let lastType = -1;
	for (const [index, raw] of words.entries()) {
		const word = raw.toLowerCase();
		const supertype = SUPERTYPES.get(word);
		if (supertype) {
			if (lastType >= 0 || supertypes.includes(supertype)) return null;
			supertypes.push(supertype);
			continue;
		}
		const type = CARD_TYPES.get(word);
		if (type) {
			if (types.includes(type)) return null;
			types.push(type);
			lastType = index;
			continue;
		}
		if (lastType < 0) return null;
	}
	if (types.length === 0) return null;
	return { supertypes, types, subtypes: words.slice(lastType + 1) };
}

function parseFields(value: string): Map<string, string> | null {
	const result = new Map<string, string>();
	for (const raw of value.split("|")) {
		const part = raw.trim();
		const dollar = part.indexOf("$");
		if (dollar <= 0) return null;
		const key = part.slice(0, dollar).trim();
		if (result.has(key)) return null;
		result.set(key, part.slice(dollar + 1).trim());
	}
	return result;
}

function only(fields: Map<string, string>, allowed: string[]): boolean {
	const set = new Set(allowed);
	return [...fields.keys()].every((key) => set.has(key));
}

function positiveInteger(
	value: string | undefined,
	fallback?: number,
): number | null {
	if (value === undefined) return fallback ?? null;
	return /^\d+$/.test(value) && Number(value) > 0 ? Number(value) : null;
}

function signedInteger(value: string | undefined): number | null {
	return value !== undefined && /^[+-]?\d+$/.test(value) ? Number(value) : null;
}

function parseColors(value: string): Color[] | null {
	if (value.toLowerCase() === "colorless") return [];
	const result: Color[] = [];
	for (const part of value.split(",")) {
		const color = COLORS[part.trim().toLowerCase()];
		if (!color) return null;
		if (!result.includes(color)) result.push(color);
	}
	return result;
}

function combine(
	kind: "all" | "any",
	selectors: ForgeSelector[],
): ForgeSelector {
	return selectors.length === 1 ? selectors[0]! : { kind, selectors };
}

function parseSelectorPart(value: string): ForgeSelector | null {
	if (value === "Card.Self" || value === "Self") return { kind: "self" };
	const pieces = value.split(".");
	const base = pieces.shift();
	const selectors: ForgeSelector[] = [];
	const type = base ? CARD_TYPES.get(base.toLowerCase()) : undefined;
	if (type) selectors.push({ kind: "type", type });
	else if (base === "Player" || base === "Any") return null;
	else if (base && base !== "Card" && base !== "Permanent")
		selectors.push({ kind: "subtype", subtype: base });
	for (const modifier of pieces) {
		if (modifier === "YouCtrl")
			selectors.push({ kind: "controller", player: "you" });
		else if (modifier === "OppCtrl")
			selectors.push({ kind: "controller", player: "opponent" });
		else return null;
	}
	return selectors.length > 0 ? combine("all", selectors) : null;
}

function parseSelector(value: string): ForgeSelector | null {
	const choices = value
		.split(",")
		.map((part) => parseSelectorPart(part.trim()));
	return choices.every((choice) => choice !== null)
		? combine("any", choices as ForgeSelector[])
		: null;
}

function parseTarget(
	value: string | undefined,
	fields: Map<string, string>,
): ForgeTarget[] | null {
	if (!value) return [];
	const min = fields.has("TargetMin") ? Number(fields.get("TargetMin")) : 1;
	const max = fields.has("TargetMax") ? Number(fields.get("TargetMax")) : 1;
	if (
		!Number.isSafeInteger(min) ||
		!Number.isSafeInteger(max) ||
		min < 0 ||
		max < 1 ||
		min > max ||
		max !== 1
	)
		return null;
	let legal: ForgeTarget["legal"];
	if (value === "Any") legal = { kind: "any-target" };
	else if (value === "Player") legal = { kind: "player" };
	else {
		const selector = parseSelector(value);
		if (!selector) return null;
		legal = { kind: "permanent", selector };
	}
	return [{ id: "target-1", min, max, legal }];
}

function player(value: string | undefined): "you" | "opponent" | null {
	if (value === undefined || value === "You") return "you";
	if (value === "Opponent") return "opponent";
	return null;
}

function parseEffect(
	fields: Map<string, string>,
): Exclude<EffectDef, { kind: "may" }> | null {
	const api = fields.get("SP") ?? fields.get("AB") ?? fields.get("DB");
	switch (api) {
		case "GainLife": {
			if (
				!only(fields, [
					"SP",
					"AB",
					"DB",
					"Defined",
					"LifeAmount",
					"SpellDescription",
					"SubAbility",
					"Cost",
				])
			)
				return null;
			const who = player(fields.get("Defined"));
			const amount = positiveInteger(fields.get("LifeAmount"), 1);
			return who && amount ? { kind: "gain-life", player: who, amount } : null;
		}
		case "LoseLife": {
			if (
				!only(fields, [
					"SP",
					"AB",
					"DB",
					"Defined",
					"LifeAmount",
					"SpellDescription",
					"SubAbility",
					"Cost",
				])
			)
				return null;
			const who = player(fields.get("Defined"));
			const amount = positiveInteger(fields.get("LifeAmount"), 1);
			return who && amount ? { kind: "lose-life", player: who, amount } : null;
		}
		case "Draw": {
			if (
				!only(fields, [
					"SP",
					"AB",
					"DB",
					"Defined",
					"NumCards",
					"SpellDescription",
					"SubAbility",
					"Cost",
				])
			)
				return null;
			const who = player(fields.get("Defined"));
			const amount = positiveInteger(fields.get("NumCards"), 1);
			return who && amount ? { kind: "draw", player: who, amount } : null;
		}
		case "Discard": {
			if (
				!only(fields, [
					"SP",
					"AB",
					"DB",
					"Defined",
					"Mode",
					"NumCards",
					"SpellDescription",
					"SubAbility",
					"Cost",
				]) ||
				fields.get("Mode") !== "TgtChoose"
			)
				return null;
			const who = player(fields.get("Defined"));
			const amount = positiveInteger(fields.get("NumCards"), 1);
			return who && amount === 1
				? { kind: "discard", selector: "any", amount, player: who }
				: null;
		}
		case "DealDamage": {
			if (
				!only(fields, [
					"SP",
					"AB",
					"DB",
					"ValidTgts",
					"TgtPrompt",
					"NumDmg",
					"SpellDescription",
					"SubAbility",
					"Cost",
				])
			)
				return null;
			const amount = positiveInteger(fields.get("NumDmg"));
			return amount && fields.has("ValidTgts")
				? { kind: "damage", target: "target-1", amount }
				: null;
		}
		case "Destroy":
			return only(fields, [
				"SP",
				"AB",
				"DB",
				"ValidTgts",
				"TgtPrompt",
				"SpellDescription",
				"SubAbility",
				"Cost",
			]) && fields.has("ValidTgts")
				? { kind: "destroy", target: "target-1" }
				: null;
		case "Pump": {
			if (
				!only(fields, [
					"SP",
					"AB",
					"DB",
					"ValidTgts",
					"TgtPrompt",
					"NumAtt",
					"NumDef",
					"SpellDescription",
					"SubAbility",
					"Cost",
				])
			)
				return null;
			const power = signedInteger(fields.get("NumAtt"));
			const toughness = signedInteger(fields.get("NumDef"));
			return power !== null && toughness !== null && fields.has("ValidTgts")
				? {
						kind: "modify-pt",
						target: "target-1",
						power,
						toughness,
						duration: "until-end-of-turn",
					}
				: null;
		}
		default:
			return null;
	}
}

function fullMana(color: Color, amount = 1): Record<Color, number> {
	return {
		w: color === "w" ? amount : 0,
		u: color === "u" ? amount : 0,
		b: color === "b" ? amount : 0,
		r: color === "r" ? amount : 0,
		g: color === "g" ? amount : 0,
	};
}

function followEffects(
	fields: Map<string, string>,
	svars: Map<string, { value: string; line: number }>,
	usedSvars: Set<string>,
): EffectDef[] | null {
	const effects: EffectDef[] = [];
	let current = fields;
	const seen = new Set<string>();
	let depth = 0;
	for (;;) {
		if (
			depth > 0 &&
			(current.has("ValidTgts") ||
				current.has("Cost") ||
				current.has("UnlessCost") ||
				current.has("ConditionDefined") ||
				current.has("ConditionCheckSVar"))
		)
			return null;
		const effect = parseEffect(current);
		if (!effect) return null;
		effects.push(effect);
		const next = current.get("SubAbility");
		if (!next) return effects;
		if (seen.has(next)) return null;
		seen.add(next);
		const svar = svars.get(next);
		if (!svar) return null;
		const parsed = parseFields(svar.value);
		if (!parsed) return null;
		usedSvars.add(next);
		current = parsed;
		depth += 1;
	}
}

function triggerRule(
	value: string,
	svars: Map<string, { value: string; line: number }>,
	usedSvars: Set<string>,
): ForgeRule | null {
	const fields = parseFields(value);
	if (!fields) return null;
	const execute = fields.get("Execute");
	const text = fields.get("TriggerDescription");
	const svar = execute ? svars.get(execute) : undefined;
	if (!execute || !text || !svar) return null;
	const effectFields = parseFields(svar.value);
	if (!effectFields || effectFields.has("Cost")) return null;
	const effects = followEffects(effectFields, svars, usedSvars);
	if (!effects) return null;
	usedSvars.add(execute);
	const base = {
		kind: "triggered" as const,
		id: execute,
		text,
		functionsIn: ["battlefield" as const],
		effects,
	};
	if (fields.get("Mode") === "Phase") {
		if (
			!only(fields, [
				"Mode",
				"Phase",
				"ValidPlayer",
				"TriggerZones",
				"Execute",
				"OptionalDecider",
				"TriggerDescription",
			]) ||
			fields.get("Phase") !== "Upkeep" ||
			fields.get("ValidPlayer") !== "You" ||
			fields.get("TriggerZones") !== "Battlefield" ||
			(fields.has("OptionalDecider") && fields.get("OptionalDecider") !== "You")
		)
			return null;
		return {
			...base,
			condition: { kind: "begin-step", step: "upkeep", player: "you" },
			effects: fields.has("OptionalDecider")
				? [{ kind: "may", decider: "you", effects }]
				: effects,
		};
	}
	if (fields.get("Mode") === "ChangesZone") {
		if (
			!only(fields, [
				"Mode",
				"Origin",
				"Destination",
				"ValidCard",
				"Execute",
				"TriggerDescription",
			]) ||
			fields.get("Origin") !== "Any" ||
			fields.get("Destination") !== "Battlefield" ||
			fields.get("ValidCard") !== "Card.Self"
		)
			return null;
		return {
			...base,
			condition: {
				kind: "change-zone",
				from: "any",
				to: "battlefield",
				selector: { kind: "self" },
			},
		};
	}
	if (fields.get("Mode") === "Attacks") {
		if (
			!only(fields, ["Mode", "ValidCard", "Execute", "TriggerDescription"]) ||
			fields.get("ValidCard") !== "Card.Self"
		)
			return null;
		return {
			...base,
			condition: { kind: "declare-attackers", selector: { kind: "self" } },
		};
	}
	return null;
}

/** Parse Forge text into rigid, versioned, callback-free JSON data. */
export function parseForgeCard(text: string): ForgeResult<ForgeCardIR> {
	const source = sourceLines(text);
	if (!source.ok) return source;
	const lines = source.value;
	const nameLine = one(lines, "Name");
	const manaLine = one(lines, "ManaCost");
	const typeLine = one(lines, "Types");
	if (!nameLine.ok) return nameLine;
	if (!manaLine.ok) return manaLine;
	if (!typeLine.ok) return typeLine;
	const id = cardId(nameLine.value.value);
	const manaCost = parseManaCost(manaLine.value.value);
	const typeInfo = parseTypes(typeLine.value.value);
	if (!id)
		return failure(
			"normalize",
			"INVALID_NAME",
			"name does not produce an id",
			nameLine.value.line,
		);
	if (!manaCost)
		return failure(
			"normalize",
			"UNSUPPORTED_MANA_COST",
			`unsupported mana cost: ${manaLine.value.value}`,
			manaLine.value.line,
		);
	if (!typeInfo)
		return failure(
			"normalize",
			"INVALID_TYPES",
			`invalid type line: ${typeLine.value.value}`,
			typeLine.value.line,
		);

	let colors = manaColors(manaCost);
	const colorLines = lines.filter((line) => line.key === "Colors");
	if (colorLines.length > 1)
		return failure(
			"source",
			"DUPLICATE_FIELD",
			"duplicate Colors",
			colorLines[1]?.line,
		);
	if (colorLines[0]) {
		const parsed = parseColors(colorLines[0].value);
		if (!parsed)
			return failure(
				"normalize",
				"INVALID_COLORS",
				"unsupported Colors value",
				colorLines[0].line,
			);
		colors = parsed;
	}

	let power: number | undefined;
	let toughness: number | undefined;
	const ptLines = lines.filter((line) => line.key === "PT");
	if (ptLines.length > 1)
		return failure(
			"source",
			"DUPLICATE_FIELD",
			"duplicate PT",
			ptLines[1]?.line,
		);
	if (ptLines[0]) {
		const match = /^(-?\d+)\/(-?\d+)$/.exec(ptLines[0].value);
		if (!match || !typeInfo.types.includes("creature"))
			return failure(
				"normalize",
				"INVALID_PT",
				"invalid power/toughness",
				ptLines[0].line,
			);
		power = Number(match[1]);
		toughness = Number(match[2]);
	} else if (typeInfo.types.includes("creature")) {
		return failure(
			"normalize",
			"MISSING_PT",
			"creatures require PT",
			typeLine.value.line,
		);
	}

	const rules: ForgeRule[] = [];
	const keywords: Keyword[] = [];
	let ruleNumber = 0;
	for (const line of lines.filter((entry) => entry.key === "K")) {
		const counter = /^etbCounter:([^:]+):(\d+)$/.exec(line.value);
		if (counter) {
			const name = COUNTERS[counter[1] as keyof typeof COUNTERS];
			const amount = Number(counter[2]);
			if (!name || amount <= 0)
				return failure(
					"normalize",
					"UNSUPPORTED_KEYWORD",
					`unsupported keyword: ${line.value}`,
					line.line,
				);
			rules.push({
				kind: "enters-with-counters",
				id: `keyword-${++ruleNumber}`,
				counter: name,
				amount,
			});
			continue;
		}
		const keyword = KEYWORDS[line.value];
		if (!keyword)
			return failure(
				"normalize",
				"UNSUPPORTED_KEYWORD",
				`unsupported keyword: ${line.value}`,
				line.line,
			);
		keywords.push(keyword);
	}

	const svars = new Map<string, { value: string; line: number }>();
	for (const line of lines.filter((entry) => entry.key === "SVar")) {
		const colon = line.value.indexOf(":");
		if (colon <= 0)
			return failure(
				"source",
				"MALFORMED_SVAR",
				"expected SVar:name:value",
				line.line,
			);
		const name = line.value.slice(0, colon);
		if (svars.has(name))
			return failure(
				"source",
				"DUPLICATE_SVAR",
				`duplicate SVar ${name}`,
				line.line,
			);
		svars.set(name, { value: line.value.slice(colon + 1), line: line.line });
	}
	const usedSvars = new Set<string>();

	for (const line of lines.filter((entry) => entry.key === "R")) {
		const fields = parseFields(line.value);
		const replacement = fields?.get("ReplaceWith");
		const svar = replacement ? svars.get(replacement) : undefined;
		const effect = svar ? parseFields(svar.value) : null;
		if (
			!fields ||
			!replacement ||
			!effect ||
			fields.get("Event") !== "Moved" ||
			fields.get("Destination") !== "Battlefield" ||
			fields.get("ReplacementResult") !== "Updated" ||
			!only(fields, [
				"Event",
				"ValidCard",
				"Destination",
				"ReplacementResult",
				"ReplaceWith",
				"ActiveZones",
				"Description",
			]) ||
			!only(effect, ["DB", "Defined", "ETB"]) ||
			effect.get("DB") !== "Tap" ||
			effect.get("ETB") !== "True"
		)
			return failure(
				"normalize",
				"UNSUPPORTED_REPLACEMENT",
				"unsupported replacement effect",
				line.line,
			);
		const valid = fields.get("ValidCard");
		const selector = valid ? parseSelector(valid) : null;
		const isSelf =
			valid === "Card.Self" &&
			effect.get("Defined") === "Self" &&
			!fields.has("ActiveZones");
		const isGlobal =
			selector &&
			effect.get("Defined") === "ReplacedCard" &&
			fields.get("ActiveZones") === "Battlefield";
		if (!isSelf && !isGlobal)
			return failure(
				"normalize",
				"UNSUPPORTED_REPLACEMENT",
				"unsupported enters-tapped selector",
				line.line,
			);
		usedSvars.add(replacement);
		rules.push({
			kind: "enters-tapped",
			id: `replacement-${++ruleNumber}`,
			text: fields.get("Description") ?? "Enters tapped.",
			selector: isSelf ? { kind: "self" } : selector!,
		});
	}

	for (const line of lines.filter((entry) => entry.key === "T")) {
		const rule = triggerRule(line.value, svars, usedSvars);
		if (!rule)
			return failure(
				"normalize",
				"UNSUPPORTED_TRIGGER",
				"unsupported trigger",
				line.line,
			);
		if (rules.some((candidate) => candidate.id === rule.id))
			return failure(
				"normalize",
				"DUPLICATE_RULE_ID",
				`duplicate rule id ${rule.id}`,
				line.line,
			);
		rules.push(rule);
	}

	for (const line of lines.filter((entry) => entry.key === "S")) {
		const fields = parseFields(line.value);
		const selector = fields?.get("Affected")
			? parseSelector(fields.get("Affected")!)
			: null;
		const addPower = fields ? signedInteger(fields.get("AddPower")) : null;
		const addToughness = fields
			? signedInteger(fields.get("AddToughness"))
			: null;
		if (
			!fields ||
			!only(fields, [
				"Mode",
				"Affected",
				"AddPower",
				"AddToughness",
				"Description",
			]) ||
			fields.get("Mode") !== "Continuous" ||
			!selector ||
			addPower === null ||
			addToughness === null ||
			!fields.get("Description")
		)
			return failure(
				"normalize",
				"UNSUPPORTED_STATIC",
				"unsupported static ability",
				line.line,
			);
		rules.push({
			kind: "static",
			id: `static-${++ruleNumber}`,
			text: fields.get("Description")!,
			selector,
			modification: {
				kind: "modify-pt",
				power: addPower,
				toughness: addToughness,
			},
		});
	}

	let spellCount = 0;
	let activatedCount = 0;
	for (const line of lines.filter((entry) => entry.key === "A")) {
		const fields = parseFields(line.value);
		if (!fields)
			return failure(
				"normalize",
				"MALFORMED_ABILITY",
				"malformed ability",
				line.line,
			);
		const type = fields.has("SP")
			? "spell"
			: fields.has("AB")
				? "activated"
				: null;
		if (!type)
			return failure(
				"normalize",
				"UNSUPPORTED_ABILITY",
				"expected SP or AB ability",
				line.line,
			);
		if (type === "activated" && fields.get("AB") === "Mana") {
			if (
				!only(fields, [
					"AB",
					"Cost",
					"Produced",
					"Amount",
					"SpellDescription",
				]) ||
				fields.get("Cost") !== "T"
			)
				return failure(
					"normalize",
					"UNSUPPORTED_MANA_ABILITY",
					"only tap-for-one-fixed-color mana abilities are supported",
					line.line,
				);
			const produced = fields.get("Produced");
			const color = produced && COLORS[produced.toLowerCase()];
			const amount = positiveInteger(fields.get("Amount"), 1);
			if (!color || !amount || produced?.length !== 1)
				return failure(
					"normalize",
					"UNSUPPORTED_MANA_ABILITY",
					"only a fixed colored mana symbol is supported",
					line.line,
				);
			rules.push({
				kind: "mana",
				id: `activated-${++activatedCount}`,
				text: fields.get("SpellDescription") ?? `Add {${produced}}.`,
				costs: [{ kind: "tap-self" }],
				effects: [
					{ kind: "add-mana", player: "you", mana: fullMana(color, amount) },
				],
			});
			continue;
		}
		if (type === "activated" && fields.get("Cost") !== "T")
			return failure(
				"normalize",
				"UNSUPPORTED_ACTIVATION_COST",
				"only tap-self activation costs are supported",
				line.line,
			);
		if (type === "spell" && fields.has("Cost")) {
			return failure(
				"normalize",
				"UNSUPPORTED_SPELL_COST",
				"additional spell costs are unsupported",
				line.line,
			);
		}
		const firstSubAbility = fields.get("SubAbility");
		if (firstSubAbility) {
			const sub = svars.get(firstSubAbility);
			const subFields = sub ? parseFields(sub.value) : null;
			if (
				!subFields ||
				subFields.has("ValidTgts") ||
				subFields.has("Cost") ||
				subFields.has("UnlessCost") ||
				subFields.has("ConditionDefined") ||
				subFields.has("ConditionCheckSVar")
			) {
				return failure(
					"normalize",
					"UNSUPPORTED_SUB_ABILITY",
					"sub-abilities with targets, costs, or conditions are unsupported",
					line.line,
				);
			}
		}
		const effects = followEffects(fields, svars, usedSvars);
		const targets = parseTarget(fields.get("ValidTgts"), fields);
		if (!effects || !targets || !fields.get("SpellDescription"))
			return failure(
				"normalize",
				"UNSUPPORTED_ABILITY",
				"unsupported effect or targets",
				line.line,
			);
		if (type === "spell") {
			if (spellCount > 0)
				return failure(
					"normalize",
					"MULTIPLE_SPELL_ABILITIES",
					"multiple spell abilities are unsupported",
					line.line,
				);
			rules.push({
				kind: "spell",
				id: `spell-${++spellCount}`,
				text: fields.get("SpellDescription")!,
				targets,
				effects,
			});
		} else {
			rules.push({
				kind: "activated",
				id: `activated-${++activatedCount}`,
				text: fields.get("SpellDescription")!,
				costs: [{ kind: "tap-self" }],
				targets,
				effects,
			});
		}
	}

	// Each basic land type intrinsically grants its mana ability, whether or not
	// the card also has the "basic" supertype (for example, Dryad Arbor).
	if (typeInfo.types.includes("land")) {
		const intrinsicColors = typeInfo.subtypes
			.map((subtype) => BASIC_LAND_MANA[subtype])
			.filter((color): color is Color => color !== undefined);
		for (const color of intrinsicColors) {
			const alreadyPresent = rules.some(
				(rule) =>
					rule.kind === "mana" &&
					rule.effects.some(
						(effect) =>
							effect.kind === "add-mana" && (effect.mana[color] ?? 0) > 0,
					),
			);
			if (alreadyPresent) continue;
			rules.push({
				kind: "mana",
				id: `intrinsic-mana-${color}`,
				text: `Add {${color.toUpperCase()}}.`,
				costs: [{ kind: "tap-self" }],
				effects: [{ kind: "add-mana", player: "you", mana: fullMana(color) }],
			});
		}
	}

	const hasAttackTrigger = rules.some(
		(rule) =>
			rule.kind === "triggered" && rule.condition.kind === "declare-attackers",
	);
	if (hasAttackTrigger && svars.get("HasAttackEffect")?.value === "TRUE")
		usedSvars.add("HasAttackEffect");
	if (
		rules.some((rule) => rule.kind === "static") &&
		svars.get("PlayMain1")?.value === "TRUE"
	)
		usedSvars.add("PlayMain1");
	if (
		rules.some((rule) => rule.kind === "activated") &&
		svars.get("NonCombatPriority")?.value === "1"
	)
		usedSvars.add("NonCombatPriority");
	const unused = [...svars.entries()].find(([key]) => !usedSvars.has(key));
	if (unused)
		return failure(
			"normalize",
			"UNUSED_SVAR",
			`unused SVar ${unused[0]}`,
			unused[1].line,
		);

	const allowed = new Set([
		"Name",
		"ManaCost",
		"Types",
		"Colors",
		"PT",
		"K",
		"R",
		"T",
		"S",
		"A",
		"SVar",
		"Oracle",
		"DeckHas",
		"DeckHints",
		"DeckNeeds",
		"AI",
	]);
	const unknown = lines.find((line) => !allowed.has(line.key));
	if (unknown)
		return failure(
			"normalize",
			"UNKNOWN_DIRECTIVE",
			`unknown directive ${unknown.key}`,
			unknown.line,
		);

	const ir: ForgeCardIR = {
		schemaVersion: FORGE_CARD_IR_VERSION,
		id,
		name: nameLine.value.value,
		supertypes: typeInfo.supertypes,
		types: typeInfo.types,
		subtypes: typeInfo.subtypes,
		colors,
		manaCost,
		...(power !== undefined ? { power } : {}),
		...(toughness !== undefined ? { toughness } : {}),
		keywords,
		rules,
	};
	return validateForgeCardIR(ir);
}

/** Parse and compile while retaining diagnostics and the serializable IR. */
export function parseCardDetailed(
	text: string,
): ForgeResult<{ ir: ForgeCardIR; card: CardDef }> {
	const parsed = parseForgeCard(text);
	if (!parsed.ok) return parsed;
	const compiled = compileForgeCard(parsed.value);
	if (!compiled.ok) return compiled;
	return {
		ok: true,
		value: { ir: parsed.value, card: compiled.value },
		diagnostics: [...parsed.diagnostics, ...compiled.diagnostics],
	};
}

/** Compatibility facade: unsupported or malformed Forge input returns null. */
export function parseCard(text: string): CardDef | null {
	const result = parseCardDetailed(text);
	return result.ok ? result.value.card : null;
}

export type { ForgeCardIR, ForgeDiagnostic, ForgeResult } from "./forge-ir.ts";
export { compileForgeCard, validateForgeCardIR };
