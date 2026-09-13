import { expect, test } from "bun:test";
import type {
	ActivatedEffectDef,
	SpellEffectDef,
	TriggeredEffectDef,
} from "../index";

test("effect aliases preserve their allowed player vocabulary through nesting", () => {
	const triggered: TriggeredEffectDef = {
		kind: "draw",
		subject: { kind: "relative-player", player: "triggering-player" },
		amount: 1,
	};
	const spell: SpellEffectDef = {
		kind: "may",
		decider: "you",
		effects: [
			{
				kind: "draw",
				subject: { kind: "relative-player", player: "opponent" },
				amount: 1,
			},
		],
	};
	const activated: ActivatedEffectDef = {
		kind: "draw",
		// @ts-expect-error activated effects have no triggering player
		subject: { kind: "relative-player", player: "triggering-player" },
		amount: 1,
	};
	const invalidNestedSpell: SpellEffectDef = {
		kind: "may",
		decider: "you",
		effects: [
			{
				kind: "draw",
				// @ts-expect-error nested spell effects retain the spell vocabulary
				subject: { kind: "relative-player", player: "triggering-player" },
				amount: 1,
			},
		],
	};

	expect(triggered.kind).toBe("draw");
	expect(spell.kind).toBe("may");
	expect(activated.kind).toBe("draw");
	expect(invalidNestedSpell.kind).toBe("may");
});
