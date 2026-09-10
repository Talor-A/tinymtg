import { describe, expect, test } from "bun:test";
import type {
	ActivationCost,
	ManaPool,
	PayableActivationManaCost,
} from "../index.ts";
import { planManaPayment } from "../index.ts";

function pool(amounts: Partial<ManaPool>): ManaPool {
	return { w: 0, u: 0, b: 0, r: 0, g: 0, c: 0, ...amounts };
}

const manaOnly = {
	mana: { n: 2, u: 1 },
	tapSelf: false,
} satisfies ActivationCost;
const tapOnly = {
	mana: "zero",
	tapSelf: true,
} satisfies ActivationCost;
const combined = {
	mana: { w: 1 },
	tapSelf: true,
} satisfies ActivationCost;
const zero = {
	mana: "zero",
	tapSelf: false,
} satisfies ActivationCost;
const sacrificeOnly = {
	mana: "zero",
	tapSelf: false,
	sacrifice: {
		predicate: { kind: "type", type: "creature" },
		amount: 1,
	},
} satisfies ActivationCost;
const combinedWithSacrifice = {
	mana: { b: 1 },
	tapSelf: true,
	sacrifice: {
		predicate: { kind: "self" },
		amount: 1,
	},
} satisfies ActivationCost;

// "none" describes a card with no mana cost. It is not payable.
// @ts-expect-error activation costs cannot contain card-only no-mana semantics
const noManaCost: PayableActivationManaCost = "none";

// TINY-65 says generic/coloured mana. Specifically colorless {C} is outside
// that scope, while colorless mana may still pay a generic requirement.
// @ts-expect-error specifically colorless activation requirements are excluded
const specificallyColorless: PayableActivationManaCost = { c: 1 };

// Unsupported mana and nonmana primitives have no place in the exact shape.
const variableMana: ActivationCost = {
	// @ts-expect-error variable mana is not a fixed activation mana cost
	mana: { x: 1 },
	tapSelf: false,
};
const lifePayment: ActivationCost = {
	mana: "zero",
	tapSelf: false,
	// @ts-expect-error life payment is not an activation cost component
	life: 1,
};

// The singular shape cannot encode duplicate mana, tap, or sacrifice components.
const duplicateComponents: ActivationCost = {
	// @ts-expect-error legacy component arrays are not activation costs
	costs: [{ kind: "tap-self" }, { kind: "tap-self" }],
};

void noManaCost;
void specificallyColorless;
void variableMana;
void lifePayment;
void duplicateComponents;

describe("payable activation costs", () => {
	test("represent each supported combination of cost components", () => {
		expect([manaOnly, tapOnly, combined, zero]).toEqual([
			{ mana: { n: 2, u: 1 }, tapSelf: false },
			{ mana: "zero", tapSelf: true },
			{ mana: { w: 1 }, tapSelf: true },
			{ mana: "zero", tapSelf: false },
		]);
		expect(sacrificeOnly).toEqual({
			mana: "zero",
			tapSelf: false,
			sacrifice: {
				predicate: { kind: "type", type: "creature" },
				amount: 1,
			},
		});
		expect(combinedWithSacrifice).toEqual({
			mana: { b: 1 },
			tapSelf: true,
			sacrifice: { predicate: { kind: "self" }, amount: 1 },
		});
	});

	test("the spell planner accepts the narrower activation mana contract", () => {
		expect(planManaPayment(pool({ u: 1, c: 2 }), manaOnly.mana)).toEqual(
			pool({ u: 1, c: 2 }),
		);
		expect(planManaPayment(pool({ w: 1 }), combined.mana)).toEqual(
			pool({ w: 1 }),
		);
		expect(planManaPayment(pool({ g: 1 }), tapOnly.mana)).toEqual(pool({}));
		expect(planManaPayment(pool({ g: 1 }), zero.mana)).toEqual(pool({}));
	});

	test("the planner asserts finite nonnegative fixed quantities", () => {
		expect(() => planManaPayment(pool({ w: 1 }), { w: -1 })).toThrow(
			"invalid w quantity in mana cost",
		);
		expect(() => planManaPayment(pool({ w: 1 }), { n: 0.5 })).toThrow(
			"invalid generic quantity in mana cost",
		);
		expect(() => planManaPayment(pool({ w: 1 }), { n: Infinity })).toThrow(
			"invalid generic quantity in mana cost",
		);
	});
});
