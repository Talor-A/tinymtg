import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "../agents.ts";
import { CARDS } from "../cards.ts";
import {
	type Agent,
	type ChoiceAnswer,
	ChoiceController,
	ChoicePendingError,
	ChoiceReplayMismatchError,
	type ChoiceRequest,
	type ChoiceTranscript,
	createEngine,
	type GameState,
	InvalidChoiceAnswerError,
	type ObjectId,
	type PlayerView,
	type SyncAgent,
} from "../index.ts";

const engine = createEngine(CARDS);

function cards(state: GameState): ObjectId[] {
	return [
		engine.spawnCard(state, "forest", 0, "library").id,
		engine.spawnCard(state, "grizzly-bears", 0, "library").id,
		engine.spawnCard(state, "eager-cadet", 0, "library").id,
	];
}

describe("scry choices", () => {
	test("returns an ordered partition and replays it exactly", () => {
		const state = engine.newGame();
		const [a, b, c] = cards(state);
		if (a === undefined || b === undefined || c === undefined) {
			throw new Error("expected three cards");
		}
		let requestSeen: ChoiceRequest | undefined;
		const agent: SyncAgent = {
			choose(_view, request) {
				requestSeen = request;
				return { groups: [[String(b), String(c)], [String(a)]] };
			},
		};
		const recorder = ChoiceController.record(engine, [agent, agent]);

		expect(
			recorder.choosePartition(state, 0, [c, b, a], "scry", [
				{ label: "top" },
				{ label: "bottom" },
			]),
		).toEqual({ groups: [[b, c], [a]] });
		expect(requestSeen?.kind).toBe("partition");
		if (requestSeen?.kind === "partition") {
			expect(requestSeen.context.reason).toBe("scry");
			expect(requestSeen.context.cards).toEqual([c, b, a]);
		}

		const replay = ChoiceController.replay(
			engine,
			JSON.parse(JSON.stringify(recorder.transcript())),
		);
		expect(
			replay.choosePartition(state, 0, [c, b, a], "scry", [
				{ label: "top" },
				{ label: "bottom" },
			]),
		).toEqual({ groups: [[b, c], [a]] });
		replay.assertComplete();
	});

	test("reports a corrupt recorded answer as a replay mismatch", () => {
		const state = engine.newGame();
		const [a, b, c] = cards(state);
		if (a === undefined || b === undefined || c === undefined) {
			throw new Error("expected three cards");
		}
		const agent: SyncAgent = {
			choose: () => ({ groups: [[String(b), String(c)], [String(a)]] }),
		};
		const recorder = ChoiceController.record(engine, [agent, agent]);
		recorder.choosePartition(state, 0, [c, b, a], "scry", [
			{ label: "top" },
			{ label: "bottom" },
		]);

		// A transcript that no longer describes a legal answer is a broken
		// transcript, whichever choice recorded it.
		const transcript = JSON.parse(
			JSON.stringify(recorder.transcript()),
		) as ChoiceTranscript;
		const recorded = transcript.choices[0];
		if (!recorded) throw new Error("expected a recorded choice");
		recorded.answer = { groups: [[String(b)], [String(a)]] };

		expect(() =>
			ChoiceController.replay(engine, transcript).choosePartition(
				state,
				0,
				[c, b, a],
				"scry",
				[{ label: "top" }, { label: "bottom" }],
			),
		).toThrow(ChoiceReplayMismatchError);
	});

	test("rejects missing, duplicate, and unknown cards", () => {
		const state = engine.newGame();
		const [a, b] = cards(state);
		if (a === undefined || b === undefined) throw new Error("expected cards");
		const answers: ChoiceAnswer[] = [
			{ optionIds: [String(a), String(b)] },
			{ groups: [[String(a)], []] },
			{ groups: [[String(a), String(a)], [String(b)]] },
			{ groups: [[String(a), String(b)], ["not-a-card"]] },
		];
		for (const answer of answers) {
			expect(() =>
				ChoiceController.record(engine, [
					{ choose: () => answer },
					new ScriptedAgent(),
				]).choosePartition(state, 0, [a, b], "scry", [
					{ label: "top" },
					{ label: "bottom" },
				]),
			).toThrow(InvalidChoiceAnswerError);
		}
	});

	test("supports suspension without recording a speculative answer", async () => {
		const state = engine.newGame();
		const [a, b] = cards(state);
		if (a === undefined || b === undefined) throw new Error("expected cards");
		let resolveAnswer: ((answer: ChoiceAnswer) => void) | undefined;
		const answer = new Promise<ChoiceAnswer>((resolve) => {
			resolveAnswer = resolve;
		});
		const agent: Agent = { choose: () => answer };
		const choices = ChoiceController.suspending(engine, [agent, agent]);

		let pending: ChoicePendingError | undefined;
		try {
			choices.choosePartition(state, 0, [b, a], "scry", [
				{ label: "top" },
				{ label: "bottom" },
			]);
		} catch (error) {
			if (!(error instanceof ChoicePendingError)) throw error;
			pending = error;
		}
		if (!pending || !resolveAnswer) throw new Error("expected pending choice");
		expect(choices.transcript().choices).toHaveLength(0);

		resolveAnswer({ groups: [[String(a)], [String(b)]] });
		choices.recordAnswer(pending.request, await pending.answer);
		choices.rewind();
		expect(
			choices.choosePartition(state, 0, [b, a], "scry", [
				{ label: "top" },
				{ label: "bottom" },
			]),
		).toEqual({ groups: [[a], [b]] });
		choices.assertComplete();
	});
});

describe("scry events", () => {
	test("applies top and bottom order to the library atomically", () => {
		const state = engine.newGame();
		const untouched = engine.spawnCard(state, "darksteel-myr", 0, "library").id;
		const [a, b, c] = cards(state);
		if (a === undefined || b === undefined || c === undefined) {
			throw new Error("expected cards");
		}
		let seen: ObjectId[] | undefined;
		const agent: SyncAgent = {
			choose(_view: PlayerView, request: ChoiceRequest): ChoiceAnswer {
				if (request.kind !== "partition" || request.context.reason !== "scry")
					throw new Error("expected scry partition");
				seen = request.context.cards;
				return { groups: [[String(b), String(c)], [String(a)]] };
			},
		};

		const result = engine.perform(
			state,
			{ kind: "scry", player: 0, amount: 3 },
			[agent, agent],
		);

		expect(seen).toEqual([c, b, a]);
		// Canonical storage is bottom-to-top, so draws are b, c, untouched, a.
		expect(state.players[0].library).toEqual([a, untouched, c, b]);
		expect(result.executed).toEqual([{ kind: "scry", player: 0, amount: 3 }]);
	});

	test("positive scry on an empty library happens, while scry 0 does not", () => {
		const state = engine.newGame();
		let choices = 0;
		const agent: SyncAgent = {
			choose() {
				choices++;
				throw new Error("empty scry must not request a choice");
			},
		};

		expect(
			engine.perform(state, { kind: "scry", player: 0, amount: 3 }, [
				agent,
				agent,
			]).executed,
		).toEqual([{ kind: "scry", player: 0, amount: 3 }]);
		expect(
			engine.perform(state, { kind: "scry", player: 0, amount: 0 }, [
				agent,
				agent,
			]).executed,
		).toEqual([]);
		expect(choices).toBe(0);
	});

	test("looks at every available card when the library has fewer than X", () => {
		const state = engine.newGame();
		const only = engine.spawnCard(state, "forest", 0, "library").id;
		let seen: ObjectId[] | undefined;
		const agent: SyncAgent = {
			choose(_view, request) {
				if (request.kind !== "partition" || request.context.reason !== "scry")
					throw new Error("expected scry partition");
				seen = request.context.cards;
				return { groups: [[], [String(only)]] };
			},
		};

		engine.perform(state, { kind: "scry", player: 0, amount: 5 }, [
			agent,
			agent,
		]);
		expect(seen).toEqual([only]);
		expect(state.players[0].library).toEqual([only]);
	});
});
