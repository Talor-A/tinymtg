import {
	printedEntryReplacements,
	printedKeywordTriggers,
} from "./abilities.ts";
import {
	ABILITY_CATEGORIES,
	abilityId,
	type AbilityCategory,
	type AbilityDefinitions,
	type AnyActivatedAbilityDefinition,
	type CardDef,
	type CardDefBase,
	type PrintedAbilities,
	type ProhibitionDef,
	type ReplacementEffectDefinition,
	type StaticAbilityDefinition,
	type TriggeredAbilityDefinition,
	validateCardEffectResultFlow,
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
