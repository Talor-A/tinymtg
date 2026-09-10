import { describe, expect, test } from "bun:test";
import { CARDS } from "../cards.ts";
import {
	ChoiceController,
	createEngine,
	type GameState,
	getSnapshot,
	type ObjectId,
} from "../index.ts";
import {
	ALICE,
	BOB,
	passingAgents,
	setupMain,
} from "./utils/engine-helpers.ts";

const engine = createEngine(CARDS);

/**
 * A game at ALICE's precombat main with Resolute Reinforcements on the
 * battlefield. The helper spawns the permanent directly, so no enters trigger
 * has resolved and the board holds no soldier tokens yet; the test watches
 * the one the flicker re-triggers come into existence.
 */
function flickerBoard() {
	const state = setupMain(engine);
	const reinforcements = engine.spawnPermanent(
		state,
		"resolute-reinforcements",
		ALICE,
	);
	const angel = engine.spawnCard(state, "restoration-angel", ALICE, "hand");
	engine.perform(
		state,
		{
			kind: "add mana",
			source: angel.id,
			player: ALICE,
			mana: { w: 4 },
		},
		passingAgents(),
	);
	return { state, reinforcements, angel };
}

/** The battlefield's Soldier tokens, by object id. */
function soldiers(state: GameState): ObjectId[] {
	const read = engine.createReadContext(state);
	return state.battlefield.filter((id) => {
		const snapshot = getSnapshot(read, id);
		return snapshot.currentCharacteristics.name === "Soldier Token";
	});
}

describe("Restoration Angel", () => {
	test("flickers a non-Angel creature you control, re-triggering its ETB", () => {
		const { state, reinforcements, angel } = flickerBoard();
		expect(soldiers(state)).toHaveLength(0);

		engine.executeCastAction(
			state,
			ALICE,
			{ kind: "cast", card: angel.id },
			passingAgents(),
		);
		// The trigger's may-answer defaults to yes, and its target choice
		// falls to the first offered option: only the reinforcements qualify.
		engine.settlePriority(state, passingAgents());

		// CR 400.7: the returned card is a new permanent object, and it
		// entered, so its ETB created a soldier token.
		const read = engine.createReadContext(state);
		const returned = state.battlefield.find((id) => {
			const snapshot = getSnapshot(read, id);
			return (
				snapshot.currentCharacteristics.name === "Resolute Reinforcements" &&
				id !== reinforcements.id
			);
		});
		expect(
			returned,
			"the reinforcements returned as a new object",
		).toBeDefined();
		expect(state.objects.has(reinforcements.id)).toBe(false);
		expect(soldiers(state)).toHaveLength(1);
		expect(
			state.battlefield.some((id) => {
				const snapshot = getSnapshot(read, id);
				return snapshot.currentCharacteristics.name === "Restoration Angel";
			}),
			"the angel itself is on the battlefield",
		).toBe(true);
		expect(state.pendingTriggers).toHaveLength(0);
		expect(state.stack).toHaveLength(0);
	});

	test("offers only the controller's non-Angel creatures as targets", () => {
		const { state, reinforcements, angel } = flickerBoard();
		// The cast angel is an Angel once it resolves, and so is this one
		// already standing on the battlefield; BOB's bear is a legal creature
		// but not ALICE's to target.
		const otherAngel = engine.spawnPermanent(state, "restoration-angel", ALICE);
		const bears = engine.spawnPermanent(state, "grizzly-bears", BOB);

		const choices = ChoiceController.record(engine, passingAgents());
		engine.executeCastAction(
			state,
			ALICE,
			{ kind: "cast", card: angel.id },
			choices,
		);
		engine.settlePriority(state, choices);

		const targetRequest = choices
			.transcript()
			.choices.find((recorded) => recorded.request.kind === "target")?.request;
		expect(targetRequest?.kind).toBe("target");
		if (targetRequest?.kind !== "target") return;
		expect(targetRequest.options.map((option) => option.id)).toEqual([
			`permanent:${reinforcements.id}`,
		]);
		// The may-answer was yes, so the flicker happened against the one legal
		// target: the bears never left and the standing angel was never exiled.
		expect(state.battlefield).toContain(bears.id);
		expect(state.battlefield).toContain(otherAngel.id);
		expect(soldiers(state)).toHaveLength(1);
	});

	test("declining the may leaves the battlefield untouched", () => {
		const { state, reinforcements, angel } = flickerBoard();
		const declining = passingAgents();
		// The next optional choice the controller faces — the trigger's may —
		// is answered no.
		declining[0].optionalChoices.push(false);
		engine.executeCastAction(
			state,
			ALICE,
			{ kind: "cast", card: angel.id },
			declining,
		);
		engine.settlePriority(state, declining);

		expect(state.battlefield).toContain(reinforcements.id);
		expect(soldiers(state)).toHaveLength(0);
	});
});
