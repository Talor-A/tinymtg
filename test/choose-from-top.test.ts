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
	name,
	newGame,
	type ObjectId,
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

describe("choose-from-top choices", () => {
	test("chooses one card and replays the exact bottom order", () => {
		const state = newGame();
		const [a, b, c] = cards(state);
		if (a === undefined || b === undefined || c === undefined) {
			throw new Error("expected three cards");
		}
		let requestSeen: ChoiceRequest | undefined;
		const agent: SyncAgent = {
			choose(_view, request) {
				requestSeen = request;
				return { chosen: String(b), bottom: [String(a), String(c)] };
			},
		};
		const recorder = ChoiceController.record([agent, agent]);

		expect(recorder.chooseFromTop(state, 0, [c, b, a])).toEqual({
			chosen: b,
			bottom: [a, c],
		});
		expect(requestSeen?.kind).toBe("chooseFromTop");
		if (requestSeen?.kind === "chooseFromTop") {
			expect(requestSeen.context.cards).toEqual([c, b, a]);
		}

		const replay = ChoiceController.replay(
			JSON.parse(JSON.stringify(recorder.transcript())),
		);
		expect(replay.chooseFromTop(state, 0, [c, b, a])).toEqual({
			chosen: b,
			bottom: [a, c],
		});
		replay.assertComplete();
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
			choices.chooseFromTop(state, 0, [b, a]);
		} catch (error) {
			if (!(error instanceof ChoicePendingError)) throw error;
			pending = error;
		}
		if (!pending || !resolveAnswer) throw new Error("expected pending choice");
		expect(choices.transcript().choices).toHaveLength(0);

		resolveAnswer({ chosen: String(a), bottom: [String(b)] });
		choices.recordAnswer(pending.request, await pending.answer);
		choices.rewind();
		expect(choices.chooseFromTop(state, 0, [b, a])).toEqual({
			chosen: a,
			bottom: [b],
		});
		choices.assertComplete();
	});

	test("rejects a missing, duplicate, or unknown card", () => {
		const state = newGame();
		const [a, b] = cards(state);
		if (a === undefined || b === undefined) throw new Error("expected cards");
		const answers: ChoiceAnswer[] = [
			{ optionId: String(a) },
			{ chosen: String(a), bottom: [] },
			{ chosen: String(a), bottom: [String(a)] },
			{ chosen: "not-a-card", bottom: [String(a)] },
		];
		for (const answer of answers) {
			expect(() =>
				ChoiceController.record([
					{ choose: () => answer },
					new ScriptedAgent(),
				]).chooseFromTop(state, 0, [a, b]),
			).toThrow(InvalidChoiceAnswerError);
		}
	});
});

describe("choose-from-top events", () => {
	test("puts the chosen card into hand and the ordered rest on the bottom", () => {
		const state = newGame();
		const untouched = spawnCard(state, "darksteel-myr", 0, "library").id;
		const a = spawnCard(state, "forest", 0, "library").id;
		const b = spawnCard(state, "grizzly-bears", 0, "library").id;
		const c = spawnCard(state, "eager-cadet", 0, "library").id;
		const d = spawnCard(state, "darksteel-relic", 0, "library").id;
		const agent: SyncAgent = {
			choose(_view, request) {
				if (request.kind !== "chooseFromTop") {
					throw new Error("expected choose-from-top choice");
				}
				expect(request.context.cards).toEqual([d, c, b, a]);
				return {
					chosen: String(c),
					bottom: [String(a), String(d), String(b)],
				};
			},
		};

		perform(state, { kind: "choose from top", player: 0, amount: 4 }, [
			agent,
			agent,
		]);

		expect(state.players[0].hand.map((id) => name(state, id))).toEqual([
			"Eager Cadet",
		]);
		// The existing deeper card stays above the three cards put on the bottom.
		expect(state.players[0].library).toEqual([b, d, a, untouched]);
	});

	test("uses every available card and makes no choice with fewer than two", () => {
		const state = newGame();
		const only = spawnCard(state, "forest", 0, "library").id;
		const agent: SyncAgent = {
			choose() {
				throw new Error("zero or one card must not request a choice");
			},
		};

		perform(state, { kind: "choose from top", player: 0, amount: 4 }, [
			agent,
			agent,
		]);
		expect(state.players[0].library).toEqual([]);
		expect(state.players[0].hand.map((id) => name(state, id))).toEqual([
			"Forest",
		]);
		expect(state.objects.has(only)).toBe(false);

		perform(state, { kind: "choose from top", player: 0, amount: 4 }, [
			agent,
			agent,
		]);
	});
});
