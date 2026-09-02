import { ScriptedAgent } from "../agents.ts";
import type { GameState, PlayerId, SyncAgent } from "../index.ts";
import { advance } from "../index.ts";

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
