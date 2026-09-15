import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "../agents.ts";
import { CARDS } from "../cards.ts";
import {
	type ChoiceAnswer,
	ChoiceController,
	type ChoiceRequest,
	createEngine,
	type GameState,
	name,
	newGame,
	type ObjectId,
	perform,
	type SyncAgent,
	spawnCard,
} from "../index.ts";

const engine = createEngine(CARDS);

function cards(state: GameState): ObjectId[] {
	return [
		spawnCard(state, "forest", 0, "library").id,
		spawnCard(state, "grizzly-bears", 0, "library").id,
		spawnCard(state, "eager-cadet", 0, "library").id,
	];
}

describe("surveil choices", () => {
	test("returns and replays the same ordered partition shape as scry", () => {
		const state = newGame();
		const [a, b, c] = cards(state);
		if (a === undefined || b === undefined || c === undefined) {
			throw new Error("expected three cards");
		}
		let requestSeen: ChoiceRequest | undefined;
		const agent: SyncAgent = {
			choose(_view, request) {
				requestSeen = request;
				return { groups: [[String(b)], [String(c), String(a)]] };
			},
		};
		const recorder = ChoiceController.record(engine, [agent, agent]);

		expect(
			recorder.choosePartition(state, 0, [c, b, a], "surveil", [
				{ label: "top" },
				{ label: "graveyard" },
			]),
		).toEqual({ groups: [[b], [c, a]] });
		expect(requestSeen?.kind).toBe("partition");
		if (requestSeen?.kind === "partition") {
			expect(requestSeen.context.reason).toBe("surveil");
		}

		const replay = ChoiceController.replay(
			engine,
			JSON.parse(JSON.stringify(recorder.transcript())),
		);
		expect(
			replay.choosePartition(state, 0, [c, b, a], "surveil", [
				{ label: "top" },
				{ label: "graveyard" },
			]),
		).toEqual({ groups: [[b], [c, a]] });
		replay.assertComplete();
	});
});

describe("surveil events", () => {
	test("orders kept cards and moves the others to the graveyard", () => {
		const state = newGame();
		const untouched = spawnCard(state, "darksteel-myr", 0, "library").id;
		const [a, b, c] = cards(state);
		if (a === undefined || b === undefined || c === undefined) {
			throw new Error("expected three cards");
		}
		let seen: ObjectId[] | undefined;
		const agent: SyncAgent = {
			choose(_view, request): ChoiceAnswer {
				if (
					request.kind !== "partition" ||
					request.context.reason !== "surveil"
				) {
					throw new Error("expected surveil partition");
				}
				seen = request.context.cards;
				return { groups: [[String(b)], [String(c), String(a)]] };
			},
		};

		const result = perform(
			engine,
			state,
			{ kind: "surveil", player: 0, amount: 3 },
			[agent, agent],
		);

		expect(seen).toEqual([c, b, a]);
		expect(state.players[0].library).toEqual([untouched, b]);
		expect(
			state.players[0].graveyard.map((id) => name(engine, state, id)),
		).toEqual(["Forest", "Eager Cadet"]);
		expect(result.executed.at(-1)).toEqual({
			kind: "surveil",
			player: 0,
			amount: 3,
		});
	});

	test("positive surveil on an empty library happens without a choice", () => {
		const state = newGame();
		const agent: SyncAgent = {
			choose() {
				throw new Error("empty surveil must not request a choice");
			},
		};
		expect(
			perform(engine, state, { kind: "surveil", player: 0, amount: 2 }, [
				agent,
				agent,
			]).executed,
		).toEqual([{ kind: "surveil", player: 0, amount: 2 }]);
	});

	test("ScriptedAgent defaults to keeping every card on top", () => {
		const state = newGame();
		const [a] = cards(state);
		if (a === undefined) throw new Error("expected a card");
		const choices = ChoiceController.record(engine, [
			new ScriptedAgent(),
			new ScriptedAgent(),
		]);
		expect(
			choices.choosePartition(state, 0, [a], "surveil", [
				{ label: "top" },
				{ label: "graveyard" },
			]),
		).toEqual({ groups: [[a], []] });
	});
});
