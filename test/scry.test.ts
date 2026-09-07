import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "../agents.ts";
import "../cards.ts";
import {
	type Agent,
	type ChoiceAnswer,
	ChoiceController,
	ChoicePendingError,
	type ChoiceRequest,
	InvalidChoiceAnswerError,
	newGame,
	type ObjectId,
	type PlayerView,
	perform,
	type SyncAgent,
	spawnCard,
} from "../index.ts";

function cards(state: ReturnType<typeof newGame>): ObjectId[] {
	return [
		spawnCard(state, "forest", 0, "library").id,
		spawnCard(state, "grizzly-bears", 0, "library").id,
		spawnCard(state, "eager-cadet", 0, "library").id,
	];
}

describe("scry choices", () => {
	test("returns an ordered partition and replays it exactly", () => {
		const state = newGame();
		const [a, b, c] = cards(state);
		if (a === undefined || b === undefined || c === undefined) {
			throw new Error("expected three cards");
		}
		let requestSeen: ChoiceRequest | undefined;
		const agent: SyncAgent = {
			choose(_view, request) {
				requestSeen = request;
				return { top: [String(b), String(c)], bottom: [String(a)] };
			},
		};
		const recorder = ChoiceController.record([agent, agent]);

		expect(recorder.chooseScry(state, 0, [c, b, a])).toEqual({
			top: [b, c],
			bottom: [a],
		});
		expect(requestSeen?.kind).toBe("scry");
		if (requestSeen?.kind === "scry") {
			expect(requestSeen.context.cards).toEqual([c, b, a]);
		}

		const replay = ChoiceController.replay(
			JSON.parse(JSON.stringify(recorder.transcript())),
		);
		expect(replay.chooseScry(state, 0, [c, b, a])).toEqual({
			top: [b, c],
			bottom: [a],
		});
		replay.assertComplete();
	});

	test("rejects missing, duplicate, and unknown cards", () => {
		const state = newGame();
		const [a, b] = cards(state);
		if (a === undefined || b === undefined) throw new Error("expected cards");
		const answers: ChoiceAnswer[] = [
			{ optionIds: [String(a), String(b)] },
			{ top: [String(a)], bottom: [] },
			{ top: [String(a), String(a)], bottom: [String(b)] },
			{ top: [String(a), String(b)], bottom: ["not-a-card"] },
		];
		for (const answer of answers) {
			expect(() =>
				ChoiceController.record([
					{ choose: () => answer },
					new ScriptedAgent(),
				]).chooseScry(state, 0, [a, b]),
			).toThrow(InvalidChoiceAnswerError);
		}
	});

	test("supports suspension without recording a speculative answer", async () => {
		const state = newGame();
		const [a, b] = cards(state);
		if (a === undefined || b === undefined) throw new Error("expected cards");
		let resolveAnswer: ((answer: ChoiceAnswer) => void) | undefined;
		const answer = new Promise<ChoiceAnswer>((resolve) => {
			resolveAnswer = resolve;
		});
		const agent: Agent = { choose: () => answer };
		const choices = ChoiceController.suspending([agent, agent]);

		let pending: ChoicePendingError | undefined;
		try {
			choices.chooseScry(state, 0, [b, a]);
		} catch (error) {
			if (!(error instanceof ChoicePendingError)) throw error;
			pending = error;
		}
		if (!pending || !resolveAnswer) throw new Error("expected pending choice");
		expect(choices.transcript().choices).toHaveLength(0);

		resolveAnswer({ top: [String(a)], bottom: [String(b)] });
		choices.recordAnswer(pending.request, await pending.answer);
		choices.rewind();
		expect(choices.chooseScry(state, 0, [b, a])).toEqual({
			top: [a],
			bottom: [b],
		});
		choices.assertComplete();
	});
});

describe("scry events", () => {
	test("applies top and bottom order to the library atomically", () => {
		const state = newGame();
		const untouched = spawnCard(state, "darksteel-myr", 0, "library").id;
		const [a, b, c] = cards(state);
		if (a === undefined || b === undefined || c === undefined) {
			throw new Error("expected cards");
		}
		let seen: ObjectId[] | undefined;
		const agent: SyncAgent = {
			choose(_view: PlayerView, request: ChoiceRequest): ChoiceAnswer {
				if (request.kind !== "scry") throw new Error("expected scry choice");
				seen = request.context.cards;
				return { top: [String(b), String(c)], bottom: [String(a)] };
			},
		};

		const result = perform(state, { kind: "scry", player: 0, amount: 3 }, [
			agent,
			agent,
		]);

		expect(seen).toEqual([c, b, a]);
		// Canonical storage is bottom-to-top, so draws are b, c, untouched, a.
		expect(state.players[0].library).toEqual([a, untouched, c, b]);
		expect(result.executed).toEqual([{ kind: "scry", player: 0, amount: 3 }]);
	});

	test("positive scry on an empty library happens, while scry 0 does not", () => {
		const state = newGame();
		let choices = 0;
		const agent: SyncAgent = {
			choose() {
				choices++;
				throw new Error("empty scry must not request a choice");
			},
		};

		expect(
			perform(state, { kind: "scry", player: 0, amount: 3 }, [agent, agent])
				.executed,
		).toEqual([{ kind: "scry", player: 0, amount: 3 }]);
		expect(
			perform(state, { kind: "scry", player: 0, amount: 0 }, [agent, agent])
				.executed,
		).toEqual([]);
		expect(choices).toBe(0);
	});

	test("looks at every available card when the library has fewer than X", () => {
		const state = newGame();
		const only = spawnCard(state, "forest", 0, "library").id;
		let seen: ObjectId[] | undefined;
		const agent: SyncAgent = {
			choose(_view, request) {
				if (request.kind !== "scry") throw new Error("expected scry choice");
				seen = request.context.cards;
				return { top: [], bottom: [String(only)] };
			},
		};

		perform(state, { kind: "scry", player: 0, amount: 5 }, [agent, agent]);
		expect(seen).toEqual([only]);
		expect(state.players[0].library).toEqual([only]);
	});
});
