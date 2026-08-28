import type { CardDef, Color, Supertype } from "./index.ts";
import fs from "node:fs";

type CardType = CardDef["types"][number];

const CARD_TYPES = new Set<CardType>([
	"artifact",
	"creature",
	"enchantment",
	"instant",
	"land",
	"planeswalker",
	"sorcery",
]);

// The engine currently represents only the supertypes in CardDef.
const SUPERTYPES = new Set<string>([
	"basic",
	"legendary",
	"snow",
] satisfies Supertype[]);

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

// These are the only printed keywords currently present on engine CardDefs.
const KEYWORDS = {
	Flying: "flying",
	Lifelink: "lifelink",
	Indestructible: "indestructible",
} as const;

const COUNTERS: Record<string, string> = {
	P1P1: "+1/+1",
	M1M1: "-1/-1",
};

interface SourceLine {
	key: string;
	value: string;
}

function sourceLines(text: string): SourceLine[] | null {
	const out: SourceLine[] = [];
	for (const raw of text.replaceAll("\r\n", "\n").split("\n")) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#")) continue;
		if (line === "ALTERNATE" || line === "SPECIALIZE") return null;
		const colon = line.indexOf(":");
		if (colon <= 0) return null;
		out.push({
			key: line.slice(0, colon),
			value: line.slice(colon + 1).trim(),
		});
	}
	return out;
}

function exactlyOne(lines: SourceLine[], key: string): string | null {
	const values = lines
		.filter((line) => line.key === key)
		.map((line) => line.value);
	const value = values[0];
	return values.length === 1 && value ? value : null;
}

function cardId(name: string): string | null {
	const id = name
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[’']/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
	return id || null;
}

function parseManaCost(cost: string): { mv: number; colors: Color[] } | null {
	if (cost === "no cost") return { mv: 0, colors: [] };

	let mv = 0;
	const colors = new Set<Color>();
	const symbols = cost.split(/\s+/);
	if (symbols.length === 0) return null;

	for (const symbol of symbols) {
		if (/^\d+$/.test(symbol)) {
			mv += Number(symbol);
			continue;
		}
		if (/^[XYZ]$/.test(symbol)) continue;
		if (!/^(?:[WUBRGCS]|P|\d+)(?:\/?[WUBRGCS]|\/?P)*$/.test(symbol)) {
			return null;
		}

		for (const letter of symbol) {
			const color = COLORS[letter.toLowerCase()];
			if (color) colors.add(color);
		}

		// Forge writes both compact ("WU", "2W", "WP") and slash ("2/W")
		// hybrid symbols. A two-generic hybrid symbol has mana value 2; every
		// other non-numeric mana symbol has mana value 1.
		const generic = symbol.match(/^\d+/)?.[0];
		mv += generic ? Number(generic) : 1;
	}

	return { mv, colors: [...colors] };
}

function parseExplicitColors(value: string): Color[] | null {
	if (value.toLowerCase() === "colorless") return [];
	const colors = new Set<Color>();
	for (const part of value.split(",")) {
		const color = COLORS[part.trim().toLowerCase()];
		if (!color) return null;
		colors.add(color);
	}
	return [...colors];
}

function parseTypes(
	value: string,
): Pick<CardDef, "types" | "subtypes" | "supertypes"> | null {
	const words = value.split(/\s+/).filter(Boolean);
	const types: CardType[] = [];
	const supertypes: Supertype[] = [];

	let lastType = -1;

	for (const [i, rawWord] of words.entries()) {
		const word = rawWord.toLowerCase() as CardType;
		if (SUPERTYPES.has(word)) {
			if (lastType >= 0) return null;
			supertypes.push(word as Supertype);
			continue;
		}
		if (CARD_TYPES.has(word)) {
			if (types.includes(word)) return null;
			types.push(word);
			lastType = i;
			continue;
		}
		if (lastType < 0) return null;
	}

	if (types.length === 0) return null;
	const subtypes = words.slice(lastType + 1);
	const result: Pick<CardDef, "types" | "subtypes" | "supertypes"> = { types };
	if (subtypes.length > 0) result.subtypes = subtypes;
	if (supertypes.length > 0) result.supertypes = supertypes;
	return result;
}

function parsePt(value: string): { power: number; toughness: number } | null {
	const match = /^(-?\d+)\/(-?\d+)$/.exec(value);
	if (!match) return null;
	return { power: Number(match[1]), toughness: Number(match[2]) };
}

function fields(value: string): Map<string, string> | null {
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

function tappedReplacementReferences(value: string): string | null {
	const f = fields(value);
	if (!f) return null;
	const allowed = new Set([
		"Event",
		"ValidCard",
		"Destination",
		"ReplacementResult",
		"ReplaceWith",
		"Description",
	]);
	if ([...f.keys()].some((key) => !allowed.has(key))) return null;
	if (
		f.get("Event") !== "Moved" ||
		f.get("ValidCard") !== "Card.Self" ||
		f.get("Destination") !== "Battlefield" ||
		f.get("ReplacementResult") !== "Updated"
	) {
		return null;
	}
	return f.get("ReplaceWith") ?? null;
}

function isTappedSVar(value: string): boolean {
	const f = fields(value);
	if (f?.size !== 3) return false;
	return (
		f.get("DB") === "Tap" &&
		f.get("Defined") === "Self" &&
		f.get("ETB") === "True"
	);
}

type TriggerDef = NonNullable<CardDef["triggers"]>[number];

function gainLifeEffect(value: string): TriggerDef["effects"][number] | null {
	const f = fields(value);
	if (!f) return null;
	const allowed = new Set(["DB", "Defined", "LifeAmount"]);
	if ([...f.keys()].some((key) => !allowed.has(key))) return null;
	if (f.get("DB") !== "GainLife") return null;
	if (f.has("Defined") && f.get("Defined") !== "You") return null;
	const amount = f.get("LifeAmount");
	if (!amount || !/^\d+$/.test(amount) || Number(amount) <= 0) return null;
	return { kind: "gainLife", player: "controller", amount: Number(amount) };
}

function parseTrigger(
	value: string,
	svars: Map<string, string>,
): { trigger: TriggerDef; reference: string } | null {
	const f = fields(value);
	if (!f) return null;
	const reference = f.get("Execute");
	const text = f.get("TriggerDescription");
	if (!reference || !text) return null;
	const effectSource = svars.get(reference);
	const effect = effectSource ? gainLifeEffect(effectSource) : null;
	if (!effect) return null;

	if (f.get("Mode") === "Phase") {
		const allowed = new Set([
			"Mode",
			"Phase",
			"ValidPlayer",
			"TriggerZones",
			"Execute",
			"OptionalDecider",
			"TriggerDescription",
		]);
		if ([...f.keys()].some((key) => !allowed.has(key))) return null;
		if (
			f.get("Phase") !== "Upkeep" ||
			f.get("ValidPlayer") !== "You" ||
			f.get("TriggerZones") !== "Battlefield"
		) {
			return null;
		}
		if (f.has("OptionalDecider") && f.get("OptionalDecider") !== "You") {
			return null;
		}
		return {
			reference,
			trigger: {
				id: reference,
				text,
				condition: {
					kind: "beginStep",
					step: "upkeep",
					player: "controller",
				},
				...(f.get("OptionalDecider") === "You" ? { optional: true } : {}),
				effects: [effect],
			},
		};
	}

	if (f.get("Mode") === "ChangesZone") {
		const allowed = new Set([
			"Mode",
			"Origin",
			"Destination",
			"ValidCard",
			"Execute",
			"TriggerDescription",
		]);
		if ([...f.keys()].some((key) => !allowed.has(key))) return null;
		if (
			f.get("Origin") !== "Any" ||
			f.get("Destination") !== "Battlefield" ||
			f.get("ValidCard") !== "Card.Self"
		) {
			return null;
		}
		return {
			reference,
			trigger: {
				id: reference,
				text,
				condition: { kind: "entersBattlefield", object: "self" },
				effects: [effect],
			},
		};
	}

	if (f.get("Mode") === "Attacks") {
		const allowed = new Set([
			"Mode",
			"ValidCard",
			"Execute",
			"TriggerDescription",
		]);
		if ([...f.keys()].some((key) => !allowed.has(key))) return null;
		if (f.get("ValidCard") !== "Card.Self") return null;
		return {
			reference,
			trigger: {
				id: reference,
				text,
				condition: { kind: "declaredAttacker", object: "self" },
				effects: [effect],
			},
		};
	}

	return null;
}

/**
 * Parse the deliberately small, Forge-style card format understood by tinymtg.
 * Unsupported rules, dynamic values, malformed input, and unknown directives
 * return null rather than being silently discarded.
 */
export function parseCard(text: string): CardDef | null {
	const lines = sourceLines(text);
	if (!lines) return null;

	const name = exactlyOne(lines, "Name");
	const manaText = exactlyOne(lines, "ManaCost");
	const typeText = exactlyOne(lines, "Types");
	if (!name || !manaText || !typeText) return null;

	const id = cardId(name);
	const mana = parseManaCost(manaText);
	const typeInfo = parseTypes(typeText);
	if (!id || !mana || !typeInfo) return null;

	const card: CardDef = {
		id,
		name,
		...(typeInfo.supertypes ? { supertypes: typeInfo.supertypes } : {}),
		types: typeInfo.types,
		...(typeInfo.subtypes ? { subtypes: typeInfo.subtypes } : {}),
		colors: mana.colors,
		mv: mana.mv,
	};

	const colorsLines = lines.filter((line) => line.key === "Colors");
	if (colorsLines.length > 1) return null;
	const explicitColors = colorsLines[0];
	if (explicitColors) {
		const colors = parseExplicitColors(explicitColors.value);
		if (!colors) return null;
		card.colors = colors;
	}

	const ptLines = lines.filter((line) => line.key === "PT");
	if (ptLines.length > 1) return null;
	const ptLine = ptLines[0];
	if (ptLine) {
		if (!card.types.includes("creature")) return null;
		const pt = parsePt(ptLine.value);
		if (!pt) return null;
		card.power = pt.power;
		card.toughness = pt.toughness;
	} else if (card.types.includes("creature")) {
		return null;
	}

	const counters: Record<string, number> = {};
	for (const line of lines.filter((entry) => entry.key === "K")) {
		const counter = /^etbCounter:([^:]+):(\d+)$/.exec(line.value);
		if (counter) {
			const type = COUNTERS[counter[1] ?? ""];
			if (!type) return null;
			counters[type] = (counters[type] ?? 0) + Number(counter[2]);
			continue;
		}
		const keyword = KEYWORDS[line.value as keyof typeof KEYWORDS];
		if (!keyword) return null;
		card.keywords ??= [];

		card.keywords.push(keyword);
	}
	if (Object.keys(counters).length > 0) card.entersWith = counters;

	const svars = new Map<string, string>();
	for (const line of lines.filter((entry) => entry.key === "SVar")) {
		const colon = line.value.indexOf(":");
		if (colon <= 0) return null;
		const key = line.value.slice(0, colon);
		if (svars.has(key)) return null;
		svars.set(key, line.value.slice(colon + 1));
	}

	const usedSvars = new Set<string>();
	for (const line of lines.filter((entry) => entry.key === "R")) {
		const reference = tappedReplacementReferences(line.value);
		if (!reference || usedSvars.has(reference)) return null;
		const svar = svars.get(reference);
		if (!svar || !isTappedSVar(svar)) return null;
		usedSvars.add(reference);
		card.entersTapped = true;
	}

	for (const line of lines.filter((entry) => entry.key === "T")) {
		const parsed = parseTrigger(line.value, svars);
		if (!parsed || usedSvars.has(parsed.reference)) return null;
		usedSvars.add(parsed.reference);
		card.triggers ??= [];
		if (card.triggers.some((trigger) => trigger.id === parsed.trigger.id)) {
			return null;
		}
		card.triggers.push(parsed.trigger);
	}

	// Forge writes this exact SVar alongside "Attacks" triggers as UI metadata
	// (whether the card has an attack-trigger effect for AI/UI purposes). It
	// carries no rules meaning and is never itself referenced. That metadata
	// alone must never make an otherwise-unremarkable card parse: it is only
	// narrowly accepted as pre-used UI noise when the card actually has a self
	// declared-attacker trigger, matching what the SVar claims to describe.
	const hasSelfAttackTrigger = (card.triggers ?? []).some(
		(trigger) => trigger.condition.kind === "declaredAttacker",
	);
	if (hasSelfAttackTrigger && svars.get("HasAttackEffect") === "TRUE") {
		usedSvars.add("HasAttackEffect");
	}

	if ([...svars.keys()].some((key) => !usedSvars.has(key))) return null;

	const allowed = new Set([
		"Name",
		"ManaCost",
		"Types",
		"Colors",
		"PT",
		"K",
		"R",
		"T",
		"SVar",
		"Oracle",
		"DeckHas",
		"DeckHints",
		"DeckNeeds",
		"AI",
	]);
	if (lines.some((line) => !allowed.has(line.key))) return null;

	return card;
}

/**
 * Loads and parses one card straight from the Forge cardsfolder fixture, so
 * callers never hand-transcribe card data that the parser can produce itself.
 */
export function loadCard(
	/** like darksteel_myr */
	name: string,
): CardDef {
	const text = fs.readFileSync(
		`./cards/cardsfolder/${name[0]}/${name}.txt`,
		"utf-8",
	);
	const card = parseCard(text);
	if (!card) throw new Error(`Failed to parse card ${name}`);
	return card;
}
