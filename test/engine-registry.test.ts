import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "../agents.ts";
import { createEngine, defineCard } from "../index.ts";

function registryProbe(name: string) {
	return defineCard({
		id: "registry-probe",
		name,
		types: ["creature"],
		colors: [],
		manaCost: "zero",
		power: 1,
		toughness: 1,
	});
}

describe("engine card registries", () => {
	test("engines with the same card ID remain isolated", () => {
		const first = createEngine([registryProbe("First Definition")]);
		const second = createEngine([registryProbe("Second Definition")]);
		const state = first.newGame();
		const permanent = first.spawnPermanent(state, "registry-probe", 0);

		expect(
			first.buildGameView(state).objects.get(permanent.id)
				?.currentCharacteristics.name,
		).toBe("First Definition");
		expect(
			second.buildGameView(state).objects.get(permanent.id)
				?.currentCharacteristics.name,
		).toBe("Second Definition");
	});

	test("an engine rejects duplicate card IDs", () => {
		expect(() =>
			createEngine([
				registryProbe("First Definition"),
				registryProbe("Duplicate Definition"),
			]),
		).toThrow("duplicate card: registry-probe");
	});

	test("definitions stay outside structured-cloned and replayed state", async () => {
		const engine = createEngine([
			defineCard({
				id: "callback-probe",
				name: "Callback Probe",
				types: ["enchantment"],
				colors: [],
				manaCost: "zero",
				statics: [
					{
						layer: "4-type-changing",
						text: "This callback proves definitions are not in GameState.",
						applies: () => false,
						modify: () => {},
					},
				],
			}),
		]);
		const checkpoint = engine.newGame();
		const permanent = engine.spawnPermanent(checkpoint, "callback-probe", 0);
		const before = structuredClone(checkpoint);

		expect(checkpoint).not.toHaveProperty("engine");
		expect(() => structuredClone(checkpoint)).not.toThrow();

		const result = await engine.advanceWithReplay(checkpoint, [
			new ScriptedAgent(),
			new ScriptedAgent(),
		]);

		expect(checkpoint).toEqual(before);
		expect(result.attempts).toBe(1);
		expect(() => structuredClone(result.state)).not.toThrow();
		expect(() => JSON.stringify(result.transcript)).not.toThrow();
		expect(
			engine.buildGameView(result.state).objects.get(permanent.id)
				?.currentCharacteristics.name,
		).toBe("Callback Probe");
	});
});
