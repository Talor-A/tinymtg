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
					groups: [[String(b), String(a)], [String(c)]],
				};
			},
		};
		const recorder = ChoiceController.record(engine, [agent, agent]);

		expect(
			recorder.choosePartition(state, 0, [c, b, a], "choose-from-top", [
				{ label: "hand", exactSize: 2 },
				{ label: "bottom" },
			]),
		).toEqual({ groups: [[b, a], [c]] });
		expect(requestSeen?.kind).toBe("partition");
		if (requestSeen?.kind === "partition") {
			expect(requestSeen.context).toEqual({
				reason: "choose-from-top",
				cards: [c, b, a],
				groups: [{ label: "hand", exactSize: 2 }, { label: "bottom" }],
			});
		}

		const replay = ChoiceController.replay(
			engine,
			JSON.parse(JSON.stringify(recorder.transcript())),
		);
		expect(
			replay.choosePartition(state, 0, [c, b, a], "choose-from-top", [
				{ label: "hand", exactSize: 2 },
				{ label: "bottom" },
			]),
		).toEqual({ groups: [[b, a], [c]] });
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
			choices.choosePartition(state, 0, [b, a], "choose-from-top", [
				{ label: "hand", exactSize: 1 },
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
			choices.choosePartition(state, 0, [b, a], "choose-from-top", [
				{ label: "hand", exactSize: 1 },
				{ label: "bottom" },
			]),
		).toEqual({ groups: [[a], [b]] });
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
			{ groups: [[String(a)], [String(b), String(c)]] },
			{ groups: [[String(a), String(b)], []] },
			{ groups: [[String(a), String(b)], [String(a)]] },
			{ groups: [[String(a), "not-a-card"], [String(c)]] },
		];
		for (const answer of answers) {
			expect(() =>
				ChoiceController.record(engine, [
					{ choose: () => answer },
					new ScriptedAgent(),
				]).choosePartition(state, 0, [a, b, c], "choose-from-top", [
					{ label: "hand", exactSize: 2 },
					{ label: "bottom" },
				]),
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
				if (
					request.kind !== "partition" ||
					request.context.reason !== "choose-from-top"
				) {
					throw new Error("expected choose-from-top partition");
				}
				expect(request.context).toEqual({
					reason: "choose-from-top",
					cards: [e, d, c, b, a],
					groups: [
						{ label: "hand", exactSize: 2 },
						{ label: "bottom of library" },
					],
				});
				return {
					groups: [
						[String(c), String(e)],
						[String(a), String(d), String(b)],
					],
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
