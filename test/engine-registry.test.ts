import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "../agents.ts";
import {
	advanceWithReplay,
	buildGameView,
	createEngine,
	defineCard,
	newGame,
	spawnPermanent,
} from "../index.ts";

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
		const state = newGame();
		const permanent = spawnPermanent(first, state, "registry-probe", 0);

		expect(
			buildGameView(first, state).objects.get(permanent.id)
				?.currentCharacteristics.name,
		).toBe("First Definition");
		expect(
			buildGameView(second, state).objects.get(permanent.id)
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
						kind: "characteristic",
						text: "This callback proves definitions are not in GameState.",
						applies: () => false,
						effects: [{ layer: "4-type-changing", modify: () => {} }],
					},
				],
			}),
		]);
		const checkpoint = newGame();
		const permanent = spawnPermanent(engine, checkpoint, "callback-probe", 0);
		const before = structuredClone(checkpoint);

		expect(checkpoint).not.toHaveProperty("engine");
		expect(() => structuredClone(checkpoint)).not.toThrow();

		const result = await advanceWithReplay(engine, checkpoint, [
			new ScriptedAgent(),
			new ScriptedAgent(),
		]);

		expect(checkpoint).toEqual(before);
		expect(result.attempts).toBe(1);
		expect(() => structuredClone(result.state)).not.toThrow();
		expect(() => JSON.stringify(result.transcript)).not.toThrow();
		expect(
			buildGameView(engine, result.state).objects.get(permanent.id)
				?.currentCharacteristics.name,
		).toBe("Callback Probe");
	});
});
