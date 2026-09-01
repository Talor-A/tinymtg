import type {
	ForgeCardIR,
	ForgeDiagnostic,
	ForgeResult,
	ForgeSelector,
} from "./forge-ir.ts";
import { validateForgeCardIR } from "./forge-ir.ts";
import type {
	CardDef,
	CardDefInput,
	ContinuousEffect,
	EffectDef,
	PermanentView,
	TriggerDef,
} from "./index.ts";
import { defineCard, etbPreview } from "./index.ts";

function compileManaCost(ir: ForgeCardIR): CardDef["manaCost"] {
	if (ir.manaCost.kind === "none") return "none";
	if (ir.manaCost.kind === "zero") return "zero";
	const result: Exclude<CardDef["manaCost"], "none" | "zero"> = {};
	if (ir.manaCost.generic > 0) result.c = ir.manaCost.generic;
	for (const color of ["w", "u", "b", "r", "g"] as const) {
		if (ir.manaCost[color] > 0) result[color] = ir.manaCost[color];
	}
	return result;
}

function selectorMatches(
	selector: ForgeSelector,
	view: PermanentView,
	sourceController: 0 | 1,
	sourceId: number | null,
): boolean {
	switch (selector.kind) {
		case "self":
			return sourceId !== null && view.id === sourceId;
		case "type":
			return view.types.includes(selector.type);
		case "supertype":
			return view.supertypes.includes(selector.supertype);
		case "subtype":
			return view.subtypes.includes(selector.subtype);
		case "color":
			return view.colors.includes(selector.color);
		case "controller":
			return selector.player === "you"
				? view.controller === sourceController
				: view.controller !== sourceController;
		case "all":
			return selector.selectors.every((part) =>
				selectorMatches(part, view, sourceController, sourceId),
			);
		case "any":
			return selector.selectors.some((part) =>
				selectorMatches(part, view, sourceController, sourceId),
			);
		case "not":
			return !selectorMatches(
				selector.selector,
				view,
				sourceController,
				sourceId,
			);
	}
}

function isRuntimeTriggerEffect(effect: EffectDef): boolean {
	switch (effect.kind) {
		case "gain-life":
		case "lose-life":
		case "draw":
			return true;
		case "may":
			return (
				effect.effects.length > 0 &&
				effect.effects.every(isRuntimeTriggerEffect)
			);
		case "damage":
		case "destroy":
		case "modify-pt":
		case "add-mana":
			return false;
	}
}

function compileTrigger(
	rule: Extract<ForgeCardIR["rules"][number], { kind: "triggered" }>,
): TriggerDef {
	let condition: TriggerDef["condition"];
	switch (rule.condition.kind) {
		case "begin-step":
			condition = {
				kind: "begin step",
				step: rule.condition.step,
				player: rule.condition.player,
			};
			break;
		case "change-zone":
			condition = {
				kind: "change zone",
				from: "any",
				to: "battlefield",
				selector: "self",
			};
			break;
		case "declare-attackers":
			condition = { kind: "declare attackers", selector: "self" };
			break;
	}
	return {
		id: rule.id,
		text: rule.text,
		condition,
		...(rule.functionsIn[0] !== "battlefield"
			? { functionsIn: [rule.functionsIn[0]!] }
			: {}),
		effects: structuredClone(rule.effects),
	};
}

/** Compile validated, inert JSON data into the engine's callback-capable card. */
export function compileForgeCard(value: ForgeCardIR): ForgeResult<CardDef> {
	const validated = validateForgeCardIR(value);
	if (!validated.ok) return validated;
	const ir = validated.value;
	const diagnostics: ForgeDiagnostic[] = [];
	for (const [index, rule] of ir.rules.entries()) {
		if (rule.kind !== "triggered") continue;
		if (!rule.effects.every(isRuntimeTriggerEffect)) {
			return {
				ok: false,
				diagnostics: [
					{
						stage: "compile",
						code: "UNSUPPORTED_TRIGGER_EFFECT",
						message: `trigger ${rule.id} has an effect unsupported by the runtime`,
						path: `$.rules[${index}].effects`,
					},
				],
			};
		}
		if (rule.functionsIn.length !== 1) {
			return {
				ok: false,
				diagnostics: [
					{
						stage: "compile",
						code: "UNSUPPORTED_TRIGGER_ZONE",
						message: "triggers must function in exactly one zone",
						path: `$.rules[${index}].functionsIn`,
					},
				],
			};
		}
	}

	const card: CardDefInput = {
		id: ir.id,
		name: ir.name,
		...(ir.supertypes.length > 0 ? { supertypes: [...ir.supertypes] } : {}),
		types: [...ir.types],
		...(ir.subtypes.length > 0 ? { subtypes: [...ir.subtypes] } : {}),
		colors: [...ir.colors],
		manaCost: compileManaCost(ir),
		...(ir.power !== undefined ? { power: ir.power } : {}),
		...(ir.toughness !== undefined ? { toughness: ir.toughness } : {}),
		...(ir.keywords.length > 0 ? { keywords: [...ir.keywords] } : {}),
	};

	for (const rule of ir.rules) {
		switch (rule.kind) {
			case "enters-with-counters":
				card.entersWith ??= {};
				card.entersWith[rule.counter] =
					(card.entersWith[rule.counter] ?? 0) + rule.amount;
				break;
			case "enters-tapped":
				if (rule.selector.kind === "self") {
					card.entersTapped = true;
				} else {
					const selector = structuredClone(rule.selector);
					card.replacements ??= [];
					card.replacements.push({
						label: rule.id,
						layer: "other",
						text: rule.text,
						applies(ev, ctx) {
							if (
								ctx.self?.zone !== "battlefield" ||
								ev.kind !== "change zone" ||
								ev.to !== "battlefield" ||
								ev.entersTapped
							)
								return false;
							return selectorMatches(
								selector,
								etbPreview(ctx.state, ev),
								ctx.controller,
								ctx.self.id,
							);
						},
						replace: (ev) =>
							ev.kind === "change zone"
								? [{ ...ev, entersTapped: true }]
								: [ev],
					});
				}
				break;
			case "triggered":
				card.triggers ??= [];
				card.triggers.push(compileTrigger(rule));
				break;
			case "static": {
				const selector = structuredClone(rule.selector);
				const power = rule.modification.power;
				const toughness = rule.modification.toughness;
				const effect: ContinuousEffect = {
					layer: "7c-modify-power-toughness",
					text: rule.text,
					applies(view, _state, source) {
						return (
							source.zone === "battlefield" &&
							selectorMatches(selector, view, source.controller, source.id)
						);
					},
					modify(view) {
						if (!("power" in view) || !("toughness" in view)) return;
						view.power += power;
						view.toughness += toughness;
					},
				};
				card.statics ??= [];
				card.statics.push(effect);
				break;
			}
			case "spell": {
				const compiled = structuredClone(rule);
				card.spell = {
					id: compiled.id,
					text: compiled.text,
					targets: compiled.targets,
					effects: compiled.effects,
				};
				break;
			}
			case "activated": {
				const compiled = structuredClone(rule);
				card.activatedAbilities ??= [];
				card.activatedAbilities.push({
					id: compiled.id,
					text: compiled.text,
					manaAbility: compiled.manaAbility,
					costs: compiled.costs,
					targets: compiled.targets,
					effects: compiled.effects,
				});
				break;
			}
		}
	}

	return { ok: true, value: defineCard(card), diagnostics };
}
