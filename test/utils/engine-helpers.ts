import { ScriptedAgent } from "../../agents.ts";
import type {
	Engine,
	GameState,
	ObjectId,
	PlayerId,
	StepKind,
	SyncAgent,
} from "../../index.ts";
import { gameOver, isTurnStep, turnLocation } from "../../index.ts";

export { loadCardFixture } from "../../corpus.ts";

export const ALICE = 0 as PlayerId;
export const BOB = 1 as PlayerId;
export type SyncAgents = [SyncAgent, SyncAgent];

export function passingAgents(): [ScriptedAgent, ScriptedAgent] {
	return [new ScriptedAgent(), new ScriptedAgent()];
}

/**
 * Asserts a scripted agent used every action it was given.
 *
 * `ScriptedAgent` falls back to the first offered option whenever its next
 * scripted action is not on the menu, and the first option is always "pass".
 * That fallback is what makes `passingAgents()` work, but it also means a test
 * whose scripted action stopped being offered keeps passing while silently
 * doing nothing. Calling this after the engine runs turns that into a failure.
 */
export function expectScriptConsumed(agent: ScriptedAgent): void {
	if (agent.priorityActions.length === 0) return;
	throw new Error(
		`scripted agent did not use ${agent.priorityActions.length} action(s): ` +
			`${agent.priorityActions.map((action) => action.kind).join(", ")} — ` +
			"the engine never offered them",
	);
}

export function advanceUntil(
	engine: Engine,
	state: GameState,
	agents: SyncAgents,
	done: (state: GameState) => boolean,
	maxAdvances = 100,
): void {
	for (let count = 0; count < maxAdvances; count++) {
		if (done(state)) return;
		engine.advance(state, agents);
	}
	throw new Error(
		`engine did not reach the expected state after ${maxAdvances} advances`,
	);
}

/**
 * Advances a fresh game to the upkeep step of its first turn.
 *
 * Priority and the APNAP order triggers follow onto the stack are both defined
 * relative to the active player, so a test that exercises either needs a turn
 * genuinely in progress. Upkeep is the earliest place to stop: the untap step
 * opens no priority window and deliberately holds triggers back (CR 502.4),
 * and the draw step would draw from the empty libraries most tests set up.
 */
export function beginFirstTurn(
	engine: Engine,
	state: GameState,
	agents: SyncAgents,
): void {
	if (state.turnScheduler.progress.kind === "notStarted") skipPreGame(state);
	advanceUntil(engine, state, agents, (next) => isTurnStep(next, "upkeep"));
}

/**
 * Consumes the CR 103 pre-game without entering the first turn, leaving the
 * next engine.advance() to be the one that installs the turn and its untap step.
 *
 * `engine.startGame()` stops one transition later, inside the turn. Use this instead
 * when the untap transition itself is what a test is exercising.
 */
export function completePreGame(
	engine: Engine,
	state: GameState,
	agents: SyncAgents,
): void {
	advanceUntil(
		engine,
		state,
		agents,
		(next) =>
			next.turnScheduler.progress.kind === "pregame" &&
			next.turnScheduler.remainingPregameSteps.length === 0,
	);
}

/** Reports whether the game is currently at `expected`, where "main" is either main phase. */
export function isAt(state: GameState, expected: StepKind | "main"): boolean {
	const location = turnLocation(state);
	return expected === "main"
		? location?.kind === "mainPhase"
		: location?.kind === "step" && location.step.kind === expected;
}

/** Reports whether the game is at the named main phase specifically. */
export function atMain(
	state: GameState,
	role: "precombat" | "postcombat",
): boolean {
	const location = turnLocation(state);
	return location?.kind === "mainPhase" && location.role === role;
}

/** Advances until one more turn has completed, or the game has ended. */
export function playOneTurn(
	engine: Engine,
	state: GameState,
	agents: SyncAgents,
): void {
	const completedTurns = state.completedTurns;
	advanceUntil(
		engine,
		state,
		agents,
		(next) => next.completedTurns > completedTurns || gameOver(next),
	);
}

/**
 * Gives each player a small library.
 *
 * Tests that let the scheduler run through a draw step need this: an empty
 * library would lose the drawing player the game before the test's own subject
 * is ever reached.
 */
export function seedLibraries(
	engine: Engine,
	state: GameState,
	count = 3,
): void {
	for (let i = 0; i < count; i++) {
		engine.spawnCard(state, "forest", ALICE, "library");
		engine.spawnCard(state, "forest", BOB, "library");
	}
}

/** A fresh game advanced to the named main phase, with libraries seeded. */
export function setupMain(
	engine: Engine,
	role: "precombat" | "postcombat" = "precombat",
): GameState {
	const state = newInProgressGame(engine);
	seedLibraries(engine, state);
	advanceUntil(engine, state, passingAgents(), (next) => atMain(next, role));
	return state;
}

/** The first object an event result created, for tests that assert on it. */
export function created(result: { created: ObjectId[] }): ObjectId {
	const id = result.created[0];
	if (id === undefined) throw new Error("nothing created");
	return id;
}
/** Start a game while deliberately skipping shuffle and opening-hand draws. */
export function newInProgressGame(engine: Engine, seed = 0) {
	const state = engine.newGame(seed);
	skipPreGame(state);
	return state;
}

/** Position a test state immediately after pregame without performing its actions. */
export function skipPreGame(state: GameState): void {
	if (state.turnScheduler.progress.kind !== "notStarted")
		throw new Error("only a fresh game can skip pregame");
	state.turnScheduler = {
		nextAction: { kind: "advancePreGameStep" },
		// start the game after opening hand actions.
		progress: { kind: "pregame", step: "opening hand" },
		pendingTurns: [],
		nextRegularPlayer: 0 as PlayerId,
		remainingSteps: [],
		remainingPregameSteps: [],
		nextId: 0,
	};
}
