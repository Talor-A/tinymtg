import { ScriptedAgent } from "../agents.ts";
import type { GameState, PlayerId, SyncAgent } from "../index.ts";
import { advance, isTurnStep } from "../index.ts";

export const ALICE = 0 as PlayerId;
export const BOB = 1 as PlayerId;
export type SyncAgents = [SyncAgent, SyncAgent];

export function passingAgents(): SyncAgents {
	return [new ScriptedAgent(), new ScriptedAgent()];
}

export function advanceUntil(
	state: GameState,
	agents: SyncAgents,
	done: (state: GameState) => boolean,
	maxAdvances = 100,
): void {
	for (let count = 0; count < maxAdvances; count++) {
		if (done(state)) return;
		advance(state, agents);
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
export function beginFirstTurn(state: GameState, agents: SyncAgents): void {
	advanceUntil(state, agents, (next) => isTurnStep(next, "upkeep"));
}
