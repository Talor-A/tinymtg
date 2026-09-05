import type { Color, EffectDef, Keyword, Supertype } from "./index.ts";

/** The JSON format emitted by the Forge source parser. Bump for breaking changes. */
export const FORGE_CARD_IR_VERSION = 2 as const;

export type ForgeCardType =
	| "artifact"
	| "creature"
	| "enchantment"
	| "instant"
	| "land"
	| "planeswalker"
	| "sorcery";

export type ForgeZone =
	| "library"
	| "hand"
	| "battlefield"
	| "graveyard"
	| "exile"
	| "stack";

/** A deliberately explicit mana cost. Zero values are retained in JSON. */
export type ForgeManaCost =
	| { kind: "none" }
	| { kind: "zero" }
	| {
			kind: "symbols";
			generic: number;
			w: number;
			u: number;
			b: number;
			r: number;
			g: number;
	  };

/** Normalized selector expressions. No Forge selector strings survive parsing. */
export type ForgeSelector =
	| { kind: "self" }
	| { kind: "type"; type: ForgeCardType }
	| { kind: "supertype"; supertype: Supertype }
	| { kind: "subtype"; subtype: string }
	| { kind: "color"; color: Color }
	| { kind: "controller"; player: "you" | "opponent" }
	| { kind: "all"; selectors: ForgeSelector[] }
	| { kind: "any"; selectors: ForgeSelector[] }
	| { kind: "not"; selector: ForgeSelector };

export type ForgeTarget = {
	id: string;
	min: number;
	max: number;
	legal:
		| { kind: "player" }
		| { kind: "permanent"; selector: ForgeSelector }
		| { kind: "any-target" };
};

export type ForgeTriggerCondition =
	| { kind: "begin-step"; step: "upkeep"; player: "you" }
	| {
			kind: "change-zone";
			from: "any";
			to: "battlefield";
			selector: { kind: "self" };
	  }
	| { kind: "declare-attackers"; selector: { kind: "self" } };

export type ForgeRule =
	| {
			kind: "enters-tapped";
			id: string;
			text: string;
			selector: ForgeSelector;
	  }
	| {
			kind: "enters-with-counters";
			id: string;
			counter: "+1/+1" | "-1/-1";
			amount: number;
	  }
	| {
			kind: "triggered";
			id: string;
			text: string;
			functionsIn: ForgeZone[];
			condition: ForgeTriggerCondition;
			effects: EffectDef[];
	  }
	| {
			kind: "static";
			id: string;
			text: string;
			selector: ForgeSelector;
			modification: {
				kind: "modify-pt";
				power: number;
				toughness: number;
			};
	  }
	| {
			kind: "spell";
			id: string;
			text: string;
			targets: ForgeTarget[];
			effects: EffectDef[];
	  }
	| {
			kind: "activated";
			id: string;
			text: string;
			costs: { kind: "tap-self" }[];
			targets: ForgeTarget[];
			effects: EffectDef[];
	  }
	| {
			kind: "mana";
			id: string;
			text: string;
			costs: { kind: "tap-self" }[];
			effects: EffectDef[];
	  };

/**
 * Versioned, callback-free and JSON-round-trippable representation of a card.
 * Declared arrays are always present so a consumer never has to infer defaults.
 * Fields forbidden by a variant, such as targets on mana abilities, are absent.
 */
export interface ForgeCardIR {
	schemaVersion: typeof FORGE_CARD_IR_VERSION;
	id: string;
	name: string;
	supertypes: Supertype[];
	types: ForgeCardType[];
	subtypes: string[];
	colors: Color[];
	manaCost: ForgeManaCost;
	power?: number;
	toughness?: number;
	keywords: Keyword[];
	rules: ForgeRule[];
}

export interface ForgeDiagnostic {
	stage: "source" | "normalize" | "validate" | "compile";
	code: string;
	message: string;
	line?: number;
	path?: string;
}

export type ForgeResult<T> =
	| { ok: true; value: T; diagnostics: ForgeDiagnostic[] }
	| {
			ok: false;
			diagnostics: [ForgeDiagnostic, ...ForgeDiagnostic[]];
	  };

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const CARD_TYPES = new Set<ForgeCardType>([
	"artifact",
	"creature",
	"enchantment",
	"instant",
	"land",
	"planeswalker",
	"sorcery",
]);
const COLORS = new Set<Color>(["w", "u", "b", "r", "g"]);
const SUPERTYPES = new Set<Supertype>(["basic", "legendary", "snow"]);
const KEYWORDS = new Set<Keyword>(["flying", "lifelink", "indestructible"]);
const ZONES = new Set<ForgeZone>([
	"library",
	"hand",
	"battlefield",
	"graveyard",
	"exile",
	"stack",
]);

/** Strict runtime validation for IR read back from JSON or another process. */
export function validateForgeCardIR(value: unknown): ForgeResult<ForgeCardIR> {
	const diagnostics: ForgeDiagnostic[] = [];
	const error = (path: string, message: string) =>
		diagnostics.push({ stage: "validate", code: "INVALID_IR", message, path });
	const object = (v: unknown, path: string): Record<string, unknown> | null => {
		if (!isObject(v)) {
			error(path, "expected an object");
			return null;
		}
		return v;
	};
	const exact = (
		o: Record<string, unknown>,
		path: string,
		required: string[],
		optional: string[] = [],
	) => {
		const allowed = new Set([...required, ...optional]);
		for (const key of Object.keys(o)) {
			if (!allowed.has(key)) error(`${path}.${key}`, "unknown property");
		}
		for (const key of required) {
			if (!(key in o)) error(`${path}.${key}`, "missing property");
		}
	};
	const string = (v: unknown, path: string, nonempty = true): v is string => {
		if (typeof v !== "string" || (nonempty && v.length === 0)) {
			error(
				path,
				nonempty ? "expected a non-empty string" : "expected a string",
			);
			return false;
		}
		return true;
	};
	const integer = (v: unknown, path: string, min = Number.MIN_SAFE_INTEGER) => {
		if (!Number.isSafeInteger(v) || (v as number) < min) {
			error(path, `expected a safe integer >= ${min}`);
			return false;
		}
		return true;
	};
	const enumValue = <T extends string>(
		v: unknown,
		path: string,
		values: Set<T>,
	): v is T => {
		if (typeof v !== "string" || !values.has(v as T)) {
			error(path, "unexpected enum value");
			return false;
		}
		return true;
	};
	const array = <T>(
		v: unknown,
		path: string,
		check: (entry: unknown, entryPath: string) => entry is T,
	): v is T[] => {
		if (!Array.isArray(v)) {
			error(path, "expected an array");
			return false;
		}
		for (const [index, entry] of v.entries()) check(entry, `${path}[${index}]`);
		return true;
	};

	const selector = (v: unknown, path: string): v is ForgeSelector => {
		const o = object(v, path);
		if (!o || !string(o.kind, `${path}.kind`)) return false;
		switch (o.kind) {
			case "self":
				exact(o, path, ["kind"]);
				return true;
			case "type":
				exact(o, path, ["kind", "type"]);
				enumValue(o.type, `${path}.type`, CARD_TYPES);
				return true;
			case "supertype":
				exact(o, path, ["kind", "supertype"]);
				enumValue(o.supertype, `${path}.supertype`, SUPERTYPES);
				return true;
			case "subtype":
				exact(o, path, ["kind", "subtype"]);
				string(o.subtype, `${path}.subtype`);
				return true;
			case "color":
				exact(o, path, ["kind", "color"]);
				enumValue(o.color, `${path}.color`, COLORS);
				return true;
			case "controller":
				exact(o, path, ["kind", "player"]);
				if (o.player !== "you" && o.player !== "opponent")
					error(`${path}.player`, "expected you or opponent");
				return true;
			case "all":
			case "any":
				exact(o, path, ["kind", "selectors"]);
				if (
					array(o.selectors, `${path}.selectors`, selector) &&
					o.selectors.length === 0
				)
					error(`${path}.selectors`, "must not be empty");
				return true;
			case "not":
				exact(o, path, ["kind", "selector"]);
				selector(o.selector, `${path}.selector`);
				return true;
			default:
				error(`${path}.kind`, "unknown selector kind");
				return false;
		}
	};

	const target = (v: unknown, path: string): v is ForgeTarget => {
		const o = object(v, path);
		if (!o) return false;
		exact(o, path, ["id", "min", "max", "legal"]);
		string(o.id, `${path}.id`);
		integer(o.min, `${path}.min`, 0);
		integer(o.max, `${path}.max`, 1);
		if (typeof o.min === "number" && typeof o.max === "number" && o.min > o.max)
			error(path, "target min exceeds max");
		const legal = object(o.legal, `${path}.legal`);
		if (legal && string(legal.kind, `${path}.legal.kind`)) {
			switch (legal.kind) {
				case "player":
				case "any-target":
					exact(legal, `${path}.legal`, ["kind"]);
					break;
				case "permanent":
					exact(legal, `${path}.legal`, ["kind", "selector"]);
					selector(legal.selector, `${path}.legal.selector`);
					break;
				default:
					error(`${path}.legal.kind`, "unknown target kind");
			}
		}
		return true;
	};

	const effect = (v: unknown, path: string): v is EffectDef => {
		const o = object(v, path);
		if (!o || !string(o.kind, `${path}.kind`)) return false;
		switch (o.kind) {
			case "gain-life":
			case "lose-life":
			case "draw":
				exact(o, path, ["kind", "player", "amount"]);
				if (o.player !== "you" && o.player !== "opponent")
					error(`${path}.player`, "expected you or opponent");
				integer(o.amount, `${path}.amount`, 1);
				return true;
			case "discard":
				exact(o, path, ["kind", "selector", "amount", "player"]);
				if (o.selector !== "any" && o.selector !== "random")
					error(`${path}.selector`, "expected any or random");
				integer(o.amount, `${path}.amount`, 1);
				if (o.player !== "you" && o.player !== "opponent")
					error(`${path}.player`, "expected you or opponent");
				return true;
			case "damage":
				exact(o, path, ["kind", "target", "amount"]);
				string(o.target, `${path}.target`);
				integer(o.amount, `${path}.amount`, 1);
				return true;
			case "destroy":
				exact(o, path, ["kind", "target"]);
				string(o.target, `${path}.target`);
				return true;
			case "modify-pt":
				exact(o, path, ["kind", "target", "power", "toughness", "duration"]);
				string(o.target, `${path}.target`);
				integer(o.power, `${path}.power`);
				integer(o.toughness, `${path}.toughness`);
				if (o.duration !== "until-end-of-turn")
					error(`${path}.duration`, "unsupported duration");
				return true;
			case "may":
				exact(o, path, ["kind", "decider", "effects"]);
				if (o.decider !== "you" && o.decider !== "opponent")
					error(`${path}.decider`, "expected you or opponent");
				if (
					array(o.effects, `${path}.effects`, effect) &&
					o.effects.length === 0
				)
					error(`${path}.effects`, "must not be empty");
				return true;
			case "add-mana": {
				exact(o, path, ["kind", "player", "mana"]);
				if (o.player !== "you") error(`${path}.player`, "expected you");
				const mana = object(o.mana, `${path}.mana`);
				if (mana) {
					exact(mana, `${path}.mana`, ["w", "u", "b", "r", "g"]);
					for (const color of COLORS)
						integer(mana[color], `${path}.mana.${color}`, 0);
				}
				return true;
			}
			default:
				error(`${path}.kind`, "unknown effect kind");
				return false;
		}
	};

	const rule = (v: unknown, path: string): v is ForgeRule => {
		const o = object(v, path);
		if (!o || !string(o.kind, `${path}.kind`)) return false;
		switch (o.kind) {
			case "enters-tapped":
				exact(o, path, ["kind", "id", "text", "selector"]);
				string(o.id, `${path}.id`);
				string(o.text, `${path}.text`, false);
				selector(o.selector, `${path}.selector`);
				return true;
			case "enters-with-counters":
				exact(o, path, ["kind", "id", "counter", "amount"]);
				string(o.id, `${path}.id`);
				if (o.counter !== "+1/+1" && o.counter !== "-1/-1")
					error(`${path}.counter`, "unsupported counter");
				integer(o.amount, `${path}.amount`, 1);
				return true;
			case "triggered": {
				exact(o, path, [
					"kind",
					"id",
					"text",
					"functionsIn",
					"condition",
					"effects",
				]);
				string(o.id, `${path}.id`);
				string(o.text, `${path}.text`);
				array(
					o.functionsIn,
					`${path}.functionsIn`,
					(entry, p): entry is ForgeZone => enumValue(entry, p, ZONES),
				);
				const condition = object(o.condition, `${path}.condition`);
				if (condition && string(condition.kind, `${path}.condition.kind`)) {
					switch (condition.kind) {
						case "begin-step":
							exact(condition, `${path}.condition`, ["kind", "step", "player"]);
							if (condition.step !== "upkeep")
								error(`${path}.condition.step`, "expected upkeep");
							if (condition.player !== "you")
								error(`${path}.condition.player`, "expected you");
							break;
						case "change-zone":
							exact(condition, `${path}.condition`, [
								"kind",
								"from",
								"to",
								"selector",
							]);
							if (condition.from !== "any" || condition.to !== "battlefield")
								error(`${path}.condition`, "unsupported zone change");
							selector(condition.selector, `${path}.condition.selector`);
							break;
						case "declare-attackers":
							exact(condition, `${path}.condition`, ["kind", "selector"]);
							selector(condition.selector, `${path}.condition.selector`);
							break;
						default:
							error(`${path}.condition.kind`, "unknown trigger condition");
					}
				}
				array(o.effects, `${path}.effects`, effect);
				return true;
			}
			case "static": {
				exact(o, path, ["kind", "id", "text", "selector", "modification"]);
				string(o.id, `${path}.id`);
				string(o.text, `${path}.text`);
				selector(o.selector, `${path}.selector`);
				const modification = object(o.modification, `${path}.modification`);
				if (modification) {
					exact(modification, `${path}.modification`, [
						"kind",
						"power",
						"toughness",
					]);
					if (modification.kind !== "modify-pt")
						error(`${path}.modification.kind`, "expected modify-pt");
					integer(modification.power, `${path}.modification.power`);
					integer(modification.toughness, `${path}.modification.toughness`);
				}
				return true;
			}
			case "spell":
				exact(o, path, ["kind", "id", "text", "targets", "effects"]);
				string(o.id, `${path}.id`);
				string(o.text, `${path}.text`);
				array(o.targets, `${path}.targets`, target);
				array(o.effects, `${path}.effects`, effect);
				return true;
			case "activated":
				exact(o, path, ["kind", "id", "text", "costs", "targets", "effects"]);
				string(o.id, `${path}.id`);
				string(o.text, `${path}.text`);
				array(
					o.costs,
					`${path}.costs`,
					(entry, p): entry is { kind: "tap-self" } => {
						const cost = object(entry, p);
						if (!cost) return false;
						exact(cost, p, ["kind"]);
						if (cost.kind !== "tap-self")
							error(`${p}.kind`, "expected tap-self");
						return true;
					},
				);
				array(o.targets, `${path}.targets`, target);
				array(o.effects, `${path}.effects`, effect);
				return true;
			case "mana":
				exact(o, path, ["kind", "id", "text", "costs", "effects"]);
				string(o.id, `${path}.id`);
				string(o.text, `${path}.text`);
				array(
					o.costs,
					`${path}.costs`,
					(entry, p): entry is { kind: "tap-self" } => {
						const cost = object(entry, p);
						if (!cost) return false;
						exact(cost, p, ["kind"]);
						if (cost.kind !== "tap-self")
							error(`${p}.kind`, "expected tap-self");
						return true;
					},
				);
				array(o.effects, `${path}.effects`, effect);
				return true;
			default:
				error(`${path}.kind`, "unknown rule kind");
				return false;
		}
	};

	const root = object(value, "$");
	if (root) {
		exact(
			root,
			"$",
			[
				"schemaVersion",
				"id",
				"name",
				"supertypes",
				"types",
				"subtypes",
				"colors",
				"manaCost",
				"keywords",
				"rules",
			],
			["power", "toughness"],
		);
		if (root.schemaVersion !== FORGE_CARD_IR_VERSION)
			error("$.schemaVersion", `expected ${FORGE_CARD_IR_VERSION}`);
		string(root.id, "$.id");
		string(root.name, "$.name");
		array(root.supertypes, "$.supertypes", (entry, p): entry is Supertype =>
			enumValue(entry, p, SUPERTYPES),
		);
		array(root.types, "$.types", (entry, p): entry is ForgeCardType =>
			enumValue(entry, p, CARD_TYPES),
		);
		array(root.subtypes, "$.subtypes", (entry, p): entry is string =>
			string(entry, p),
		);
		array(root.colors, "$.colors", (entry, p): entry is Color =>
			enumValue(entry, p, COLORS),
		);
		array(root.keywords, "$.keywords", (entry, p): entry is Keyword =>
			enumValue(entry, p, KEYWORDS),
		);
		if (root.power !== undefined) integer(root.power, "$.power");
		if (root.toughness !== undefined) integer(root.toughness, "$.toughness");
		const types = Array.isArray(root.types) ? root.types : [];
		if (types.includes("creature")) {
			if (root.power === undefined || root.toughness === undefined)
				error("$", "creatures require power and toughness");
		} else if (root.power !== undefined || root.toughness !== undefined) {
			error("$", "noncreatures cannot have power or toughness");
		}
		const mana = object(root.manaCost, "$.manaCost");
		if (mana && string(mana.kind, "$.manaCost.kind")) {
			if (mana.kind === "none" || mana.kind === "zero") {
				exact(mana, "$.manaCost", ["kind"]);
			} else if (mana.kind === "symbols") {
				exact(mana, "$.manaCost", ["kind", "generic", "w", "u", "b", "r", "g"]);
				for (const key of ["generic", "w", "u", "b", "r", "g"])
					integer(mana[key], `$.manaCost.${key}`, 0);
			} else error("$.manaCost.kind", "unknown mana cost kind");
		}
		if (array(root.rules, "$.rules", rule)) {
			const ids = new Set<string>();
			for (const [index, candidate] of root.rules.entries()) {
				if (!isObject(candidate) || typeof candidate.id !== "string") continue;
				if (ids.has(candidate.id))
					error(`$.rules[${index}].id`, "duplicate rule id");
				ids.add(candidate.id);
				const targets: unknown[] =
					"targets" in candidate && Array.isArray(candidate.targets)
						? candidate.targets
						: [];
				const targetIds = new Set(
					targets
						.filter(isObject)
						.map((target) => target.id)
						.filter(
							(targetId): targetId is string => typeof targetId === "string",
						),
				);
				const effects: unknown[] =
					"effects" in candidate && Array.isArray(candidate.effects)
						? candidate.effects
						: [];
				const validateEffectTargets = (
					effectCandidate: unknown,
					path: string,
				): void => {
					if (!isObject(effectCandidate)) return;
					if (
						effectCandidate.kind === "may" &&
						Array.isArray(effectCandidate.effects)
					) {
						for (const [childIndex, child] of effectCandidate.effects.entries())
							validateEffectTargets(child, `${path}.effects[${childIndex}]`);
						return;
					}
					if (
						"target" in effectCandidate &&
						!targetIds.has(effectCandidate.target as string)
					)
						error(path, "effect references an unknown target");
				};
				for (const [effectIndex, effectCandidate] of effects.entries())
					validateEffectTargets(
						effectCandidate,
						`$.rules[${index}].effects[${effectIndex}]`,
					);
			}
		}
	}

	if (diagnostics.length > 0)
		return {
			ok: false,
			diagnostics: diagnostics as [ForgeDiagnostic, ...ForgeDiagnostic[]],
		};
	return { ok: true, value: value as ForgeCardIR, diagnostics: [] };
}
