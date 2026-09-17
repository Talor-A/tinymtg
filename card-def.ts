import {
	printedEntryReplacements,
	printedKeywordTriggers,
} from "./abilities.ts";
import {
	ABILITY_CATEGORIES,
	type AbilityCategory,
	type AbilityDefinitions,
	type AnyActivatedAbilityDefinition,
	abilityId,
	type CardDef,
	type CardDefBase,
	declaredEffectResult,
	type EffectDef,
	effectTargetUses,
	MANA_TYPES,
	type ManaType,
	type PrintedAbilities,
	type ProhibitionDef,
	type ReplacementEffectDefinition,
	type StaticAbilityDefinition,
	type TargetDef,
	type TargetRequirement,
	type TriggerEffectPlayer,
	type TriggeredAbilityDefinition,
	type Zone,
} from "./index.ts";
import { assert } from "./lib/assert.ts";

/**
 * Authoring shape for cards, the compiler, and tests. The per-kind arrays are
 * the card's definitions; by default the card prints all of them.
 */
export interface CardDefInput extends CardDefBase {
	statics?: StaticAbilityDefinition[];
	activatedAbilities?: AnyActivatedAbilityDefinition[];
	triggers?: TriggeredAbilityDefinition[];
	replacements?: ReplacementEffectDefinition[];
	prohibitions?: ProhibitionDef[];
	/**
	 * Which definition *indices* the card actually prints, per kind. Omit a kind
	 * to print all of its definitions (the normal case). Supply `[]` for a card
	 * that only hosts an implementation — e.g. an anthem whose layer-6 effect
	 * grants an ability the anthem itself doesn't have.
	 */
	printed?: Partial<Record<AbilityCategory, readonly number[]>>;
}

function printedRefsFor(
	id: string,
	definitions: AbilityDefinitions,
	printed: CardDefInput["printed"],
): PrintedAbilities {
	const refs = {} as Record<AbilityCategory, string[]>;
	for (const category of ABILITY_CATEGORIES) {
		const count = definitions[category].length;
		const indices =
			printed?.[category] ?? definitions[category].map((_, i) => i);
		refs[category] = indices.map((index) => {
			assert(
				Number.isSafeInteger(index) && index >= 0 && index < count,
				`${id}: printed ${category} ability index ${index} has no definition`,
			);
			return abilityId(category, id, index);
		});
	}
	return refs as PrintedAbilities;
}

export function defineCard(input: CardDefInput | CardDef): CardDef {
	assert(
		!input.keywords?.includes("devoid") || input.colors.length === 0,
		`devoid card ${input.id} must be colorless`,
	);
	if ("abilityDefinitions" in input) {
		validateCardEffectResultFlow(input);
		return input;
	}
	const {
		statics,
		activatedAbilities,
		triggers,
		replacements,
		prohibitions,
		printed,
		...base
	} = input;
	const abilityDefinitions: AbilityDefinitions = {
		static: statics ?? [],
		activated: activatedAbilities ?? [],
		triggered: [...(triggers ?? [])],
		replacement: [...(replacements ?? [])],
		prohibition: prohibitions ?? [],
	};

	const printedAbilities = printedRefsFor(
		input.id,
		abilityDefinitions,
		printed,
	);
	for (const trigger of printedKeywordTriggers(input.keywords ?? [])) {
		printedAbilities.triggered.push(
			abilityId("triggered", input.id, abilityDefinitions.triggered.length),
		);
		abilityDefinitions.triggered.push(trigger);
	}
	for (const entry of printedEntryReplacements(input)) {
		printedAbilities.replacement.push(
			abilityId("replacement", input.id, abilityDefinitions.replacement.length),
		);
		abilityDefinitions.replacement.push(entry);
	}
	const definition: CardDef = {
		...base,
		abilityDefinitions,
		printedAbilities,
	};
	validateCardEffectResultFlow(definition);
	return definition;
}

function validateEffectResultFlow(
	effects: EffectDef<TriggerEffectPlayer>[],
	triggeringZoneChangeDestination: Zone | "any" | null = null,
): void {
	const check = (
		sequence: EffectDef<TriggerEffectPlayer>[],
		available: Map<string, Zone>,
	): void => {
		for (const effect of sequence) {
			if (effect.kind === "may") {
				// The optional branch may not execute. It can read preceding results and
				// pass its own results between inner instructions, but it cannot make a
				// result definitely available to a following outer instruction.
				check(effect.effects, new Map(available));
				continue;
			}
			if (
				effect.kind === "change-zone" &&
				effect.subject.kind === "triggering-zone-change-result"
			) {
				assert(
					triggeringZoneChangeDestination === "any" ||
						triggeringZoneChangeDestination === effect.from,
					`change-zone refers to an unavailable triggering ${effect.from} object`,
				);
			}
			if (
				effect.kind === "change-zone" &&
				effect.subject.kind === "effect-result"
			) {
				assert(
					available.get(effect.subject.slot) === effect.from,
					`change-zone refers to unavailable ${effect.from} effect result ${effect.subject.slot}`,
				);
			}
			const declaredResult = declaredEffectResult(effect);
			if (declaredResult) {
				assert(
					declaredResult.slot.length > 0,
					"effect result slot must have a name",
				);
				assert(
					!available.has(declaredResult.slot),
					`duplicate effect result slot ${declaredResult.slot}`,
				);
				available.set(declaredResult.slot, declaredResult.zone);
			}
			if (
				effect.kind === "may-play" &&
				effect.subject.kind === "effect-result"
			) {
				assert(
					available.get(effect.subject.slot) === effect.from,
					`may-play refers to unavailable effect result ${effect.subject.slot}`,
				);
			}
		}
	};
	check(effects, new Map());
}

function validateCardEffectResultFlow(definition: CardDef): void {
	if (definition.spell) {
		validateEffectResultFlow(definition.spell.effects);
		requiredTargetDefinition(
			definition.spell.targets,
			definition.spell.effects,
		);
	}
	for (const ability of definition.abilityDefinitions.activated) {
		if (ability.kind === "mana") {
			assert(ability.manaOptions.length > 0, "mana ability has no outcomes");
			for (const mana of ability.manaOptions) {
				assert(
					typeof mana === "object" && mana !== null && !Array.isArray(mana),
					"mana ability has an invalid outcome",
				);
				for (const type of Object.keys(mana))
					assert(
						MANA_TYPES.includes(type as ManaType),
						`mana ability produces invalid mana type ${type}`,
					);
				let total = 0;
				for (const type of MANA_TYPES) {
					const amount = mana[type] ?? 0;
					assert(
						Number.isSafeInteger(amount) && amount >= 0,
						`mana ability produces an invalid ${type} quantity`,
					);
					total += amount;
				}
				assert(total > 0, "mana ability outcome produces no mana");
			}
			continue;
		}
		validateEffectResultFlow(ability.effects);
		requiredTargetDefinition(ability.targets, ability.effects);
	}
	for (const trigger of definition.abilityDefinitions.triggered) {
		validateEffectResultFlow(
			trigger.effects,
			trigger.condition.kind === "change zone" ? trigger.condition.to : null,
		);
		requiredTargetDefinition(trigger.targets, trigger.effects);
	}
}

/**
 * The single required target slot a spell or ability declares, or null, after
 * checking that its targets and instructions fall inside the executable
 * subset. Every announcement path runs this before it can spend a cost, so an
 * unsupported definition can never leave a half-paid cast behind.
 */
export function requiredTargetDefinition(
	targets: TargetDef[],
	effects: EffectDef<TriggerEffectPlayer>[],
): TargetDef | null {
	assert(targets.length <= 1, "multiple target slots are not implemented");
	const target = targets[0] ?? null;
	if (target) {
		assert(
			target.min === 1 && target.max === 1,
			"only one required target is implemented",
		);
	}
	const check = (effect: EffectDef<TriggerEffectPlayer>): void => {
		if (effect.kind === "may") {
			for (const inner of effect.effects) check(inner);
			return;
		}
		if (effect.kind === "sacrifice") {
			assert(
				effect.amount === 1,
				"only sacrificing one permanent is implemented",
			);
		}
		for (const use of effectTargetUses(effect)) {
			assert(
				target !== null && use.slot === target.id,
				"effect must reference its ability's target slot",
			);
			assert(
				targetSelectorSatisfies(target.legal, use.required),
				use.required.message,
			);
		}
	};
	for (const effect of effects) check(effect);
	return target;
}

export function targetSelectorSatisfies(
	selector: TargetDef["legal"],
	requirement: TargetRequirement,
): boolean {
	if (requirement.kind === "damage-recipient")
		return (
			selector.kind === "player" ||
			selector.kind === "permanent" ||
			selector.kind === "any-target"
		);
	if (requirement.kind === "card")
		return selector.kind === "card" && selector.zone === requirement.zone;
	return selector.kind === requirement.kind;
}
