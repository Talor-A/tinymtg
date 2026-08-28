import { describe, expect, test } from "bun:test";
import { FuzzAgent } from "./test/fuzz-agent.ts";
import "./cards.ts";
import {
	advance,
	ChoiceController,
	type GameState,
	gameOver,
	newGame,
	type SyncAgent,
	spawnCard,
	spawnPermanent,
} from "./index.ts";

const LIBRARY_CARDS = [
	"forest",
	"grizzly-bears",
	"eager-cadet",
	"walking-ballista",
] as const;

const PERMANENTS = [
	"ajanis-mantra",
	"chains-of-mephistopheles",
	"doubling-season",
	"eager-cadet",
	"furnace-of-rath",
	"grizzly-bears",
	"hardened-scales",
	"leyline-of-the-void",
	"necropotence",
	"rest-in-peace",
	"root-maze",
] as const;

/** Deterministic xorshift-based PRNG so failures are reproducible. */
function mulberry32(seed: number): () => number {
	let t = seed >>> 0 || 1;
	return () => {
		t = (t + 0x6d2b79f5) >>> 0;
		let r = t;
		r = Math.imul(r ^ (r >>> 15), r | 1) >>> 0;
		r ^= Math.imul(r ^ (r >>> 7), r | 61) >>> 0;
		return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
	};
}

function pick<T>(rng: () => number, values: readonly T[]): T {
	const value = values[Math.floor(rng() * values.length)];
	if (value === undefined) throw new Error("pick from empty array");
	return value;
}

/**
 * Builds varied but scheduler-valid games. The fuzzer only calls advance(); it
 * does not inject arbitrary events into states where their preconditions may
 * not hold.
 */
function startingState(seed: number): GameState {
	const rng = mulberry32(seed);
	const state = newGame();

	for (const player of [0, 1] as const) {
		const librarySize = 8 + Math.floor(rng() * 8);
		for (let i = 0; i < librarySize; i++) {
			spawnCard(state, pick(rng, LIBRARY_CARDS), player, "library");
		}

		// Some games begin above maximum hand size so cleanup produces choices.
		const handSize = Math.floor(rng() * 11);
		for (let i = 0; i < handSize; i++) {
			spawnCard(state, pick(rng, LIBRARY_CARDS), player, "hand");
		}

		const permanentCount = 1 + Math.floor(rng() * 8);
		for (let i = 0; i < permanentCount; i++) {
			spawnPermanent(state, pick(rng, PERMANENTS), player, "battlefield");
		}
	}

	return state;
}

function runAdvances(
	state: GameState,
	choices: ChoiceController,
	limit: number,
): number {
	let advances = 0;
	while (advances < limit && !gameOver(state)) {
		advance(state, choices);
		advances++;
	}
	return advances;
}

function agents(seed: number): [SyncAgent, SyncAgent] {
	return [new FuzzAgent(seed * 2 + 1), new FuzzAgent(seed * 2 + 2)];
}

describe("choice transcript fuzz", () => {
	test("replay reconstructs random-agent games from their starting states", () => {
		const choiceKinds = new Set<string>();
		for (let seed = 0; seed < 200; seed++) {
			const checkpoint = startingState(seed);
			const recordedState = structuredClone(checkpoint);
			const recorder = ChoiceController.record(agents(seed));
			const advances = runAdvances(recordedState, recorder, 200);
			const transcript = JSON.parse(
				JSON.stringify(recorder.transcript()),
			) as ReturnType<ChoiceController["transcript"]>;
			for (const choice of transcript.choices) {
				choiceKinds.add(choice.request.kind);
			}

			const replayedState = structuredClone(checkpoint);
			const replay = ChoiceController.replay(transcript);
			const replayedAdvances = runAdvances(replayedState, replay, advances);
			replay.assertComplete();

			expect(replayedAdvances, `seed ${seed}: advancement count`).toBe(
				advances,
			);
			expect(replayedState, `seed ${seed}: final state`).toEqual(recordedState);
		}

		expect(choiceKinds).toEqual(
			new Set([
				"replacement",
				"ownHand",
				"optional",
				"priorityAction",
				"declareAttackers",
			]),
		);
	});
});
