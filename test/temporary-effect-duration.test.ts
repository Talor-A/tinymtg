import { describe, expect, test } from "bun:test";
import { CARDS } from "../cards.ts";
import {
	activePlayer,
	addTemporaryEffect,
	createEngine,
	type GameState,
	type PlayerId,
	type TemporaryEffect,
	type TemporaryEffectDuration,
	turnLocation,
} from "../index.ts";
import {
	ALICE,
	advanceUntil,
	BOB,
	passingAgents,
	setupMain,
} from "./utils/engine-helpers.ts";

const engine = createEngine(CARDS);

function hasEffect(state: GameState, id: TemporaryEffect["id"]): boolean {
	return state.temporaryEffects.some((effect) => effect.id === id);
}

function currentTurnId(state: GameState) {
	const progress = state.turnScheduler.progress;
	if (progress.kind !== "inTurn") throw new Error("expected a current turn");
	return progress.turn.id;
}

function addDurationEffect(
	state: GameState,
	controller: PlayerId,
	duration: TemporaryEffectDuration,
): TemporaryEffect["id"] {
	addTemporaryEffect(
		state,
		controller,
		{
			source: {
				origin: "builtin",
				builtin: { kind: "prevent-color-damage", color: "w" },
			},
			bindings: {},
		},
		duration,
	);
	const created = state.temporaryEffects.at(-1);
	if (!created) throw new Error("expected a temporary effect");
	return created.id;
}

function advanceToStep(
	state: GameState,
	player: PlayerId,
	step: "end" | "cleanup",
): void {
	advanceUntil(engine, state, passingAgents(), (next) => {
		const location = turnLocation(next);
		return (
			activePlayer(next) === player &&
			location?.kind === "step" &&
			location.step.kind === step
		);
	});
}

describe("temporary effect durations", () => {
	test("next-turn duration survives this turn and the opponent's turn", () => {
		const state = setupMain(engine);
		const endOfTurn = addDurationEffect(state, ALICE, "until-end-of-turn");
		const nextTurn = addDurationEffect(
			state,
			ALICE,
			"until-end-of-your-next-turn",
		);
		expect(
			state.temporaryEffects.find((effect) => effect.id === nextTurn),
		).toMatchObject({ expiresAtEndOfTurn: null });

		advanceToStep(state, ALICE, "end");
		expect(hasEffect(state, endOfTurn)).toBe(true);
		expect(hasEffect(state, nextTurn)).toBe(true);

		engine.advance(state, passingAgents());
		const cleanup = turnLocation(state);
		expect(cleanup?.kind === "step" && cleanup.step.kind).toBe("cleanup");
		expect(hasEffect(state, endOfTurn)).toBe(false);
		expect(hasEffect(state, nextTurn)).toBe(true);

		advanceToStep(state, BOB, "cleanup");
		expect(hasEffect(state, nextTurn)).toBe(true);

		advanceToStep(state, ALICE, "end");
		const effect = state.temporaryEffects.find(
			(candidate) => candidate.id === nextTurn,
		);
		expect(effect).toMatchObject({
			duration: "until-end-of-your-next-turn",
			expiresAtEndOfTurn: currentTurnId(state),
		});

		engine.advance(state, passingAgents());
		expect(hasEffect(state, nextTurn)).toBe(false);
	});

	test("next turn means the controller's next turn when created during an opponent's turn", () => {
		const state = setupMain(engine);
		const nextTurn = addDurationEffect(
			state,
			BOB,
			"until-end-of-your-next-turn",
		);
		expect(
			state.temporaryEffects.find((effect) => effect.id === nextTurn),
		).toMatchObject({ expiresAtEndOfTurn: null });

		advanceToStep(state, ALICE, "cleanup");
		expect(hasEffect(state, nextTurn)).toBe(true);

		advanceToStep(state, BOB, "end");
		const effect = state.temporaryEffects.find(
			(candidate) => candidate.id === nextTurn,
		);
		expect(effect).toMatchObject({
			duration: "until-end-of-your-next-turn",
			expiresAtEndOfTurn: currentTurnId(state),
		});
		expect(hasEffect(state, nextTurn)).toBe(true);

		engine.advance(state, passingAgents());
		expect(hasEffect(state, nextTurn)).toBe(false);
	});
});
