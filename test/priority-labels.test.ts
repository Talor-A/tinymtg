import { describe, expect, test } from "bun:test";
import { CARDS } from "../cards.ts";
import type {
	ChoiceAnswer,
	ChoiceRequest,
	PlayerView,
	SyncAgent,
} from "../index.ts";
import { advance, createEngine, spawnPermanent } from "../index.ts";
import {
	type SyncAgents as Agents,
	ALICE,
	advanceUntil,
	atMain,
	loadCardFixture,
	newInProgressGame,
	seedLibraries,
} from "./utils/engine-helpers.ts";

const engine = createEngine([
	...CARDS,
	loadCardFixture("c/contaminated_aquifer"),
]);

/** Captures the first priority choice offered to ALICE, then passes. */
class Capturing implements SyncAgent {
	options: readonly { id: string; label: string }[] | null = null;

	choose(_view: PlayerView, request: ChoiceRequest): ChoiceAnswer {
		if (request.kind === "priorityAction" && request.player === ALICE)
			this.options ??= request.options;
		const [first] = request.options;
		if (!first) return { optionIds: [] };
		return request.kind === "declareAttackers" ||
			request.kind === "declareBlockers" ||
			request.kind === "triggerOrder"
			? { optionIds: [] }
			: { optionId: first.id };
	}
}

describe("priority option labels", () => {
	test("name an activated ability by its rules text, not its registry id", () => {
		const state = newInProgressGame(engine);
		seedLibraries(engine, state);
		// A land whose two mana abilities differ only in the color they add:
		// labelled by ability id they read `contaminated-aquifer:0` and `:1`.
		spawnPermanent(engine, state, "contaminated-aquifer", ALICE);
		const alice = new Capturing();
		const agents: Agents = [alice, new Capturing()];
		advanceUntil(engine, state, agents, (next) => atMain(next, "precombat"));
		advance(engine, state, agents);

		const labels = (alice.options ?? []).map((option) => option.label);
		expect(labels).toContain("pass");
		// The object id is whatever the game assigned, so compare the rest.
		expect(
			labels
				.filter((label) => label.includes("Contaminated Aquifer"))
				.map((label) => label.replace(/#\d+/, "#N"))
				.sort(),
		).toEqual([
			"activate Contaminated Aquifer#N — Add {B}.",
			"activate Contaminated Aquifer#N — Add {U}.",
		]);
	});
});
