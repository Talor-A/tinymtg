import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "../agents.ts";
import { CARDS } from "../cards.ts";
import type {
	ChoiceAnswer,
	ChoiceRequest,
	DeclareBlockersChoiceRequest,
	GameState,
	ObjectId,
	PlayerView,
	SyncAgent,
} from "../index.ts";
import {
	createEngine,
	InvalidChoiceAnswerError,
	isTurnStep,
} from "../index.ts";
import {
	type SyncAgents as Agents,
	ALICE,
	advanceUntil,
	BOB,
	newInProgressGame,
} from "./utils/engine-helpers.ts";

const engine = createEngine(CARDS);

/** Captures the one declare-blockers request and answers it with `answer`. */
class BlockingAgent implements SyncAgent {
	request: DeclareBlockersChoiceRequest | null = null;

	constructor(
		private readonly answer: (
			request: DeclareBlockersChoiceRequest,
		) => ChoiceAnswer,
	) {}

	choose(_view: PlayerView, request: ChoiceRequest): ChoiceAnswer {
		if (request.kind !== "declareBlockers") {
			const first = request.options[0];
			if (!first) throw new Error(`empty ${request.kind} choice`);
			return request.kind === "declareAttackers" ||
				request.kind === "triggerOrder"
				? { optionIds: [] }
				: { optionId: first.id };
		}
		this.request = request;
		return this.answer(request);
	}
}

/**
 * Two attackers and one blocker able to block either of them, so the blocker
 * appears in two options and only one of them may be chosen.
 */
function oneBlockerTwoAttackers(blocker: BlockingAgent): {
	state: GameState;
	attackers: [ObjectId, ObjectId];
	run: () => void;
} {
	const state = newInProgressGame(engine);
	const first = engine.spawnPermanent(state, "grizzly-bears", ALICE).id;
	const second = engine.spawnPermanent(state, "grizzly-bears", ALICE).id;
	engine.spawnPermanent(state, "grizzly-bears", BOB);
	engine.spawnCard(state, "forest", ALICE, "library");
	engine.spawnCard(state, "forest", BOB, "library");
	const agents: Agents = [
		new ScriptedAgent([], [], [], [[first, second]]),
		blocker,
	];
	return {
		state,
		attackers: [first, second],
		run: () =>
			advanceUntil(engine, state, agents, (next) =>
				isTurnStep(next, "combat damage"),
			),
	};
}

describe("the declare-blockers choice", () => {
	test("names the blocker and attacker each option would pair", () => {
		const agent = new BlockingAgent(() => ({ optionIds: [] }));
		const { attackers, run } = oneBlockerTwoAttackers(agent);
		run();

		const request = agent.request;
		expect(request).not.toBe(null);
		if (!request) throw new Error("no declare-blockers request");
		// One option per attacker the single blocker may block, each carrying
		// the pair it declares rather than leaving it in the display label.
		expect(request.options).toHaveLength(2);
		const [blocker] = request.context.eligibleBlockers;
		if (blocker === undefined) throw new Error("no eligible blocker");
		for (const option of request.options)
			expect(option.assignment.blocker).toBe(blocker);
		expect(
			request.options.map((option) => option.assignment.attacker).sort(),
		).toEqual([...attackers].sort());
	});

	test("rejects an answer that assigns one blocker to two attackers", () => {
		const agent = new BlockingAgent((request) => ({
			optionIds: request.options.map((option) => option.id),
		}));
		const { run } = oneBlockerTwoAttackers(agent);
		// Reported as a bad answer to this choice, not as an illegal block
		// declaration thrown from the turn-based action that consumes it.
		expect(run).toThrow(InvalidChoiceAnswerError);
	});
});
