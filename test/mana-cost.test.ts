import { describe, expect, test } from "bun:test";
import type { ManaPool } from "../index.ts";
import { planManaPayment } from "../index.ts";

function pool(amounts: Partial<ManaPool>): ManaPool {
	return { w: 0, u: 0, b: 0, r: 0, g: 0, c: 0, ...amounts };
}

describe("planManaPayment: generic (n) versus colorless (c)", () => {
	test("generic is payable by mana of any type", () => {
		expect(planManaPayment(pool({ c: 2 }), { n: 2 })).toEqual(pool({ c: 2 }));
		expect(planManaPayment(pool({ g: 2 }), { n: 2 })).toEqual(pool({ g: 2 }));
	});

	test("a colorless requirement is not payable by colored mana", () => {
		expect(planManaPayment(pool({ g: 2 }), { c: 1, n: 1 })).toBeNull();
	});

	test("a colorless requirement is payable by colorless mana", () => {
		expect(planManaPayment(pool({ g: 1, c: 1 }), { c: 1, n: 1 })).toEqual(
			pool({ g: 1, c: 1 }),
		);
	});

	// The generic part is paid colorless-first, so this only works because the
	// specific `c` requirement is reserved before generic spends anything.
	test("colorless is reserved for the colorless requirement first", () => {
		expect(planManaPayment(pool({ g: 1, c: 1 }), { c: 1 })).toEqual(
			pool({ c: 1 }),
		);
		expect(planManaPayment(pool({ c: 3 }), { c: 1, n: 2 })).toEqual(
			pool({ c: 3 }),
		);
		expect(planManaPayment(pool({ c: 2 }), { c: 1, n: 2 })).toBeNull();
	});

	test("a colored requirement still needs its own color", () => {
		expect(planManaPayment(pool({ c: 2 }), { g: 1, n: 1 })).toBeNull();
		expect(planManaPayment(pool({ g: 1, c: 1 }), { g: 1, n: 1 })).toEqual(
			pool({ g: 1, c: 1 }),
		);
	});

	test("zero costs pay nothing and no-cost cards cannot be paid at all", () => {
		expect(planManaPayment(pool({ g: 1 }), "zero")).toEqual(pool({}));
		expect(planManaPayment(pool({ g: 1 }), "none")).toBeNull();
	});
});
