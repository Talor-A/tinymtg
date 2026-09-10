import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "../agents.ts";
import { CARDS } from "../cards.ts";
import {
	type Agent,
	type ChoiceAnswer,
	ChoiceController,
	ChoicePendingError,
	type ChoiceRequest,
	createEngine,
	type GameState,
	InvalidChoiceAnswerError,
	type ObjectId,
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

describe("choose-from-top choices", () => {
	test("chooses two cards and replays the exact kept set and bottom order", () => {
		const state = engine.newGame();
		const [a, b, c] = cards(state);
		if (a === undefined || b === undefined || c === undefined) {
			throw new Error("expected three cards");
		}
		let requestSeen: ChoiceRequest | undefined;
		const agent: SyncAgent = {
			choose(_view, request) {
				requestSeen = request;
				return {
					kept: [String(b), String(a)],
					bottom: [String(c)],
				};
			},
		};
		const recorder = ChoiceController.record(engine, [agent, agent]);

		expect(recorder.chooseFromTop(state, 0, [c, b, a], 2)).toEqual({
			kept: [b, a],
			bottom: [c],
		});
		expect(requestSeen?.kind).toBe("chooseFromTop");
		if (requestSeen?.kind === "chooseFromTop") {
			expect(requestSeen.context).toEqual({ cards: [c, b, a], keep: 2 });
		}

		const replay = ChoiceController.replay(
			engine,
			JSON.parse(JSON.stringify(recorder.transcript())),
		);
		expect(replay.chooseFromTop(state, 0, [c, b, a], 2)).toEqual({
			kept: [b, a],
			bottom: [c],
		});
		replay.assertComplete();
	});

	test("supports a one-card choice and suspension without a speculative answer", async () => {
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
			choices.chooseFromTop(state, 0, [b, a], 1);
		} catch (error) {
			if (!(error instanceof ChoicePendingError)) throw error;
			pending = error;
		}
		if (!pending || !resolveAnswer) throw new Error("expected pending choice");
		expect(choices.transcript().choices).toHaveLength(0);

		resolveAnswer({ kept: [String(a)], bottom: [String(b)] });
		choices.recordAnswer(pending.request, await pending.answer);
		choices.rewind();
		expect(choices.chooseFromTop(state, 0, [b, a], 1)).toEqual({
			kept: [a],
			bottom: [b],
		});
		choices.assertComplete();
	});

	test("rejects a wrong kept count, missing, duplicate, or unknown card", () => {
		const state = engine.newGame();
		const [a, b, c] = cards(state);
		if (a === undefined || b === undefined || c === undefined) {
			throw new Error("expected cards");
		}
		const answers: ChoiceAnswer[] = [
			{ optionId: String(a) },
			{ kept: [String(a)], bottom: [String(b), String(c)] },
			{ kept: [String(a), String(b)], bottom: [] },
			{ kept: [String(a), String(b)], bottom: [String(a)] },
			{ kept: [String(a), "not-a-card"], bottom: [String(c)] },
		];
		for (const answer of answers) {
			expect(() =>
				ChoiceController.record(engine, [
					{ choose: () => answer },
					new ScriptedAgent(),
				]).chooseFromTop(state, 0, [a, b, c], 2),
			).toThrow(InvalidChoiceAnswerError);
		}
	});
});

describe("choose-from-top events", () => {
	test("puts two kept cards into hand and the ordered rest on the bottom", () => {
		const state = engine.newGame();
		const untouched = engine.spawnCard(state, "darksteel-myr", 0, "library").id;
		const a = engine.spawnCard(state, "forest", 0, "library").id;
		const b = engine.spawnCard(state, "grizzly-bears", 0, "library").id;
		const c = engine.spawnCard(state, "eager-cadet", 0, "library").id;
		const d = engine.spawnCard(state, "darksteel-relic", 0, "library").id;
		const e = engine.spawnCard(state, "monastery-swiftspear", 0, "library").id;
		const agent: SyncAgent = {
			choose(_view, request) {
				if (request.kind !== "chooseFromTop") {
					throw new Error("expected choose-from-top choice");
				}
				expect(request.context).toEqual({
					cards: [e, d, c, b, a],
					keep: 2,
				});
				return {
					kept: [String(c), String(e)],
					bottom: [String(a), String(d), String(b)],
				};
			},
		};

		engine.perform(
			state,
			{ kind: "choose from top", player: 0, amount: 5, keep: 2 },
			[agent, agent],
		);

		expect(state.players[0].hand.map((id) => engine.name(state, id))).toEqual([
			"Eager Cadet",
			"Monastery Swiftspear",
		]);
		// Library arrays run bottom-to-top. The first selected bottom card is
		// nearest the untouched library and will be drawn before the other two.
		expect(state.players[0].library).toEqual([b, d, a, untouched]);
	});

	test("keeps every available card without a choice when fewer than n remain", () => {
		const state = engine.newGame();
		const only = engine.spawnCard(state, "forest", 0, "library").id;
		const agent: SyncAgent = {
			choose() {
				throw new Error("an undersized library must not request a choice");
			},
		};

		engine.perform(
			state,
			{ kind: "choose from top", player: 0, amount: 5, keep: 2 },
			[agent, agent],
		);
		expect(state.players[0].library).toEqual([]);
		expect(state.players[0].hand.map((id) => engine.name(state, id))).toEqual([
			"Forest",
		]);
		expect(state.objects.has(only)).toBe(false);

		engine.perform(
			state,
			{ kind: "choose from top", player: 0, amount: 5, keep: 2 },
			[agent, agent],
		);
	});
});
