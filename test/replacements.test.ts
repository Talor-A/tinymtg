import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "../agents.ts";
import "../cards.ts"; // side effect: registers the card database
import type { Agent, GameState, ObjectId, SyncAgent } from "../index.ts";
import {
	addFloating,
	affectedPlayer,
	ChoiceController,
	ChoicePendingError,
	createReadContext,
	newGame,
	perform,
	permanent,
	readObject,
	registerCard,
	spawnCard,
	spawnPermanent,
} from "../index.ts";
import {
	type SyncAgents as Agents,
	ALICE,
	BOB,
	created,
} from "./utils/engine-helpers.ts";

function chooseCopyAs(choice: ObjectId | null): SyncAgent {
	const fallback = new ScriptedAgent();
	return {
		choose(view, request) {
			if (request.kind === "copyAs") {
				return { optionId: choice === null ? "no-copy" : String(choice) };
			}
			return fallback.choose(view, request);
		},
	};
}

registerCard({
	id: "test-animate-artifacts-for-copy",
	name: "Test: Animate Artifacts for Copy",
	types: ["enchantment"],
	colors: [],
	manaCost: "zero",
	statics: [
		{
			layer: "4-type-changing",
			text: "Test: Artifacts are creatures in addition to their other types.",
			applies: (view) =>
				view.currentCharacteristics.types.includes("artifact") &&
				!view.currentCharacteristics.types.includes("creature"),
			modify: (view) => {
				view.types.push("creature");
			},
		},
	],
});

describe("destroy event success", () => {
	const agents: Agents = [new ScriptedAgent(), new ScriptedAgent()];

	test("ordinary destruction reports both the movement and successful destroy", () => {
		const state = newGame();
		const bears = spawnPermanent(state, "grizzly-bears", ALICE);

		const result = perform(
			state,
			{ kind: "destroy", object: bears.id, noRegen: false },
			agents,
		);

		expect(result.executed).toHaveLength(2);
		expect(result.executed[0]).toMatchObject({
			kind: "change zone",
			object: bears.id,
			from: "battlefield",
			to: "graveyard",
			cause: "destroy",
		});
		expect(result.executed[1]).toEqual({
			kind: "destroy",
			object: bears.id,
			noRegen: false,
		});
		expect(state.players[ALICE].graveyard).toEqual(result.created);
	});

	test("regeneration replaces destruction without reporting a destroy", () => {
		const state = newGame();
		const bears = spawnPermanent(state, "grizzly-bears", ALICE, {
			tapped: false,
		});
		permanent(state, bears.id).damage = 2;
		addFloating(
			state,
			ALICE,
			"regenerationShield",
			{ target: bears.id },
			{ data: { used: 0 } },
		);

		const result = perform(
			state,
			{ kind: "destroy", object: bears.id, noRegen: false },
			agents,
		);

		expect(result.executed).toEqual([{ kind: "regenerate", object: bears.id }]);
		expect(state.battlefield).toContain(bears.id);
		expect(state.players[ALICE].graveyard).toHaveLength(0);
		expect(permanent(state, bears.id)).toMatchObject({
			tapped: true,
			damage: 0,
		});
	});

	test("exile-instead movement executes without reporting a destroy", () => {
		const state = newGame();
		spawnPermanent(state, "baby-rest-in-peace", BOB);
		const bears = spawnPermanent(state, "grizzly-bears", ALICE);

		const result = perform(
			state,
			{ kind: "destroy", object: bears.id, noRegen: false },
			agents,
		);

		expect(result.executed).toHaveLength(1);
		expect(result.executed[0]).toMatchObject({
			kind: "change zone",
			object: bears.id,
			from: "battlefield",
			to: "exile",
			cause: "destroy",
		});
		expect(state.players[ALICE].graveyard).toHaveLength(0);
		expect(state.players[ALICE].exile).toEqual(result.created);
	});
});

describe("replacement effects that add counters as a permanent enters", () => {
	function enterWalkingBallista(preferences: string[]): {
		counters: number;
		state: GameState;
		entered: ObjectId;
	} {
		const state = newGame();
		const agents: Agents = [
			new ScriptedAgent(preferences),
			new ScriptedAgent(),
		];
		spawnPermanent(state, "hardened-scales", ALICE);
		spawnPermanent(state, "doubling-season", ALICE);
		const ballistaCard = spawnCard(state, "walking-ballista", ALICE, "hand");
		const result = perform(
			state,
			{
				kind: "change zone",
				object: ballistaCard.id,
				from: "hand",
				to: "battlefield",
				cause: "resolve",
				toController: ALICE,
			},
			agents,
		);
		return {
			counters: permanent(state, created(result)).counters["+1/+1"] ?? 0,
			state,
			entered: created(result),
		};
	}

	test("the permanent's own effect applies before its controller orders the remaining effects", () => {
		const scalesFirst = enterWalkingBallista(["hardened scales"]);
		// "enters with 2" is self-replacement and always applies first: 2 -> +1 -> x2
		expect(scalesFirst.counters, "Scales then Season").toBe(6);

		const seasonFirst = enterWalkingBallista(["doubling season"]);
		seasonFirst.state.log.length = 0;
		expect(seasonFirst.counters, "Season then Scales").toBe(5);
		expect(
			readObject(createReadContext(scalesFirst.state), scalesFirst.entered)
				.currentCharacteristics,
			"Ballista power with 6 counters",
		).toMatchObject({ power: 6 });
	});
});

describe("when two effects change where a destroyed creature goes", () => {
	function kalitasVsRip(p1Prefs: string[]): GameState {
		const state = newGame();
		const agents: Agents = [new ScriptedAgent(), new ScriptedAgent(p1Prefs)];
		spawnPermanent(state, "kalitas", ALICE);
		spawnPermanent(state, "baby-rest-in-peace", BOB);
		const bears = spawnPermanent(state, "grizzly-bears", BOB);
		perform(
			state,
			{ kind: "destroy", object: bears.id, noRegen: false },
			agents,
		);
		return state;
	}
	test("the creature's controller chooses which effect applies first", () => {
		const ripFirst = kalitasVsRip(["rest in peace"]);
		expect(
			ripFirst.battlefield.filter(
				(id) => permanent(ripFirst, id).representation.kind === "token",
			).length,
			"ALICE picks RiP: no Zombie for P0",
		).toBe(0);
		expect(ripFirst.players[BOB].exile.length, "bears exiled").toBe(1);

		const kalitasFirst = kalitasVsRip(["kalitas"]);
		kalitasFirst.log.length = 0;
		const tokens = kalitasFirst.battlefield.filter(
			(id) => permanent(kalitasFirst, id).representation.kind === "token",
		);
		expect(tokens.length, "ALICE picks Kalitas: P0 gets a Zombie").toBe(1);
		const tokenId = tokens[0];
		if (tokenId === undefined)
			throw new Error("Kalitas did not create a token");
		const token = readObject(createReadContext(kalitasFirst), tokenId);
		expect(token.currentCharacteristics).toMatchObject({
			name: "Zombie Token",
			subtypes: ["Zombie"],
			power: 2,
			toughness: 2,
		});
	});
});

describe("drawing with Chains of Mephistopheles on the battlefield", () => {
	test("a player with a card in hand discards before drawing", () => {
		const state = newGame();
		const agents: Agents = [new ScriptedAgent(), new ScriptedAgent()];
		spawnPermanent(state, "chains-of-mephistopheles", ALICE);
		spawnCard(state, "forest", ALICE, "library");
		spawnCard(state, "forest", ALICE, "library");
		spawnCard(state, "grizzly-bears", ALICE, "hand");

		perform(state, { kind: "draw", player: ALICE }, agents);

		expect(
			state.players[ALICE].hand.length,
			"hand still 1 (discarded one, drew one)",
		).toBe(1);
		expect(
			state.players[ALICE].graveyard.length,
			"graveyard has the discarded card",
		).toBe(1);
		expect(state.players[ALICE].library.length, "library down by one").toBe(1);
	});

	test("a player with an empty hand mills instead of drawing", () => {
		const state = newGame();
		const agents: Agents = [new ScriptedAgent(), new ScriptedAgent()];
		spawnPermanent(state, "chains-of-mephistopheles", ALICE);
		spawnCard(state, "forest", ALICE, "library");

		perform(state, { kind: "draw", player: ALICE }, agents);
		expect(state.players[ALICE].hand.length, "no cards drawn").toBe(0);
		expect(state.players[ALICE].library.length, "library down by one").toBe(0);
		expect(state.players[ALICE].graveyard.length, "top card was milled").toBe(
			1,
		);
	});
});

describe("choosing between damage replacement and prevention effects", () => {
	function dealDamage(preferences: string[]): GameState {
		const state = newGame();
		const agents: Agents = [
			new ScriptedAgent(),
			new ScriptedAgent(preferences),
		];
		spawnPermanent(state, "furnace-of-rath", ALICE);
		const source = spawnPermanent(state, "eager-cadet", ALICE);
		addFloating(
			state,
			BOB,
			"preventNextDamage",
			{ targetType: "player", targetPlayer: BOB, amount: 3 },
			{ data: { remaining: 3 } },
		);
		perform(
			state,
			{
				kind: "damage",
				source: source.id,
				sourceController: ALICE,
				sourceColors: ["r"],
				target: { type: "player", player: BOB },
				amount: 2,
				combat: false,
				deathtouch: false,
				lifelink: false,
				unpreventable: false,
			},
			agents,
		);
		return state;
	}

	test("the damaged player chooses which applicable effect happens first", () => {
		const preventFirst = dealDamage(["prevent"]);
		// Preventing 2 of 2 replaces the damage with nothing, so Furnace never applies.
		expect(preventFirst.players[1].life, "shield first: ALICE takes 0").toBe(
			20,
		);

		const furnaceFirst = dealDamage(["furnace"]);
		furnaceFirst.log.length = 0;
		// 2 -> 4, shield eats 3, 1 gets through.
		expect(furnaceFirst.players[1].life, "furnace first: ALICE takes 1").toBe(
			19,
		);
	});

	test("unpreventable damage can still be doubled", () => {
		const state = newGame();
		const agents: Agents = [
			new ScriptedAgent(),
			new ScriptedAgent(["prevent"]),
		];
		spawnPermanent(state, "furnace-of-rath", ALICE);
		const pyro = spawnPermanent(state, "eager-cadet", 0);
		addFloating(
			state,
			BOB,
			"preventNextDamage",
			{ targetType: "player", targetPlayer: BOB, amount: 3 },
			{
				data: { remaining: 3 },
			},
		);
		perform(
			state,
			{
				kind: "damage",
				source: pyro.id,
				sourceController: ALICE,
				sourceColors: ["r"],
				target: { type: "player", player: BOB },
				amount: 2,
				combat: false,
				deathtouch: false,
				lifelink: false,
				unpreventable: true,
			},
			agents,
		);
		expect(state.players[1].life, "ALICE takes the doubled 4").toBe(16);
	});

	test("redirected damage can still be prevented", () => {
		const state = newGame();
		const agents: Agents = [new ScriptedAgent(), new ScriptedAgent()];
		const giant = spawnPermanent(state, "palisade-giant", 1);
		const pyro = spawnPermanent(state, "eager-cadet", 0);
		perform(
			state,
			{
				kind: "damage",
				source: pyro.id,
				sourceController: ALICE,
				sourceColors: ["r"],
				target: { type: "player", player: BOB },
				amount: 3,
				combat: false,
				deathtouch: false,
				lifelink: false,
				unpreventable: false,
			},
			agents,
		);
		expect(permanent(state, giant.id).damage, "damage went to the Giant").toBe(
			3,
		);
		expect(state.players[1].life, "ALICE life untouched").toBe(20);

		addFloating(state, 1, "prismaticStrands", { color: "r" });
		perform(
			state,
			{
				kind: "damage",
				source: pyro.id,
				sourceController: ALICE,
				sourceColors: ["r"],
				target: { type: "player", player: BOB },
				amount: 3,
				combat: false,
				deathtouch: false,
				lifelink: false,
				unpreventable: false,
			},
			agents,
		);
		expect(
			permanent(state, giant.id).damage,
			"second hit fully prevented",
		).toBe(3);
	});
});

describe("effects that inspect a permanent as it enters", () => {
	test("Root Maze sees a creature that Baby Mycosynth Lattice makes an artifact", () => {
		const state = newGame();
		const agents: Agents = [new ScriptedAgent(), new ScriptedAgent()];
		spawnPermanent(state, "root-maze", 0);
		const bearsCard = spawnCard(state, "grizzly-bears", 0, "hand");
		const r1 = perform(
			state,
			{
				kind: "change zone",
				object: bearsCard.id,
				from: "hand",
				to: "battlefield",
				cause: "resolve",
				toController: ALICE,
			},
			agents,
		);
		expect(
			permanent(state, created(r1)).tapped,
			"no Lattice: bear enters untapped",
		).toBe(false);

		spawnPermanent(state, "baby-mycosynth-lattice", 0);
		const bears2 = spawnCard(state, "grizzly-bears", 0, "hand");
		const r2 = perform(
			state,
			{
				kind: "change zone",
				object: bears2.id,
				from: "hand",
				to: "battlefield",
				cause: "resolve",
				toController: ALICE,
			},
			agents,
		);
		expect(
			permanent(state, created(r2)).tapped,
			"with Lattice: bear enters tapped",
		).toBe(true);
	});
});

describe("interacting effects as permanents enter", () => {
	test("a control-changing effect applies before Root Maze checks the permanent", () => {
		const state = newGame();
		const agents: Agents = [new ScriptedAgent(), new ScriptedAgent()];
		spawnPermanent(state, "root-maze", 0);
		spawnPermanent(state, "baby-mycosynth-lattice", 0);
		addFloating(state, 0, "gatherSpecimens", { you: 0 });
		const bears = spawnCard(state, "grizzly-bears", 1, "hand");

		const r = perform(
			state,
			{
				kind: "change zone",
				object: bears.id,
				from: "hand",
				to: "battlefield",
				cause: "resolve",
				toController: BOB,
			},
			agents,
		);
		const entered = permanent(state, created(r));
		expect(entered.controller, "P0 stole it").toBe(0);
		expect(entered.tapped, "and it still entered tapped").toBe(true);
		expect(entered.owner, "ALICE still owns it").toBe(1);
	});

	test("test forced-copy fixture chooses what to copy before that card's own entry effect applies", () => {
		const state = newGame();
		const agents: Agents = [new ScriptedAgent(), new ScriptedAgent()];
		spawnPermanent(state, "walking-ballista", 1, {
			counters: { "+1/+1": 2 },
		});
		const clone = spawnCard(state, "test-forced-copy", 0, "hand");
		const r = perform(
			state,
			{
				kind: "change zone",
				object: clone.id,
				from: "hand",
				to: "battlefield",
				cause: "resolve",
				toController: ALICE,
			},
			agents,
		);
		const entered = created(r);
		const copied = permanent(state, entered);
		expect(
			copied.representation,
			"physical test forced-copy fixture card is retained",
		).toEqual({
			kind: "card",
			cardId: "test-forced-copy",
		});
		expect(
			readObject(createReadContext(state), entered).currentCharacteristics.name,
			"entered as a copy of Ballista",
		).toBe("Walking Ballista");
		// The copy picks up the copied card's printed ETB self-replacement, which is
		// the generally correct behavior. KNOWN DIVERGENCE: real Walking Ballista
		// enters with X counters and a copy has X=0, so real Magic gives 0 here. The
		// fix is modeling X as a value chosen on resolution and stored on the event,
		// not baked into the card definition — see notes.
		expect(
			permanent(state, entered).counters["+1/+1"] ?? 0,
			"copy inherits the copied card's printed ETB modifier",
		).toBe(2);
	});
});

describe("Clone's optional copy replacement", () => {
	function cloneEvent(object: ObjectId) {
		return {
			kind: "change zone" as const,
			object,
			from: "hand" as const,
			to: "battlefield" as const,
			cause: "resolve" as const,
			toController: ALICE,
		};
	}

	test("chooses any battlefield creature without targeting", () => {
		const state = newGame();
		const first = spawnPermanent(state, "grizzly-bears", BOB);
		const selected = spawnPermanent(state, "eager-cadet", BOB);
		const clone = spawnCard(state, "clone", ALICE, "hand");
		const recorder = ChoiceController.record([
			chooseCopyAs(selected.id),
			new ScriptedAgent(),
		]);

		const result = perform(state, cloneEvent(clone.id), recorder);
		const entered = created(result);
		expect(
			readObject(createReadContext(state), entered).currentCharacteristics.name,
		).toBe("Eager Cadet");
		expect(permanent(state, entered).representation).toEqual({
			kind: "card",
			cardId: "clone",
		});

		const request = recorder.transcript().choices[0]?.request;
		expect(request?.kind).toBe("copyAs");
		expect(request?.options.map((option) => option.id)).toEqual([
			String(first.id),
			String(selected.id),
			"no-copy",
		]);
	});

	test("the entering permanent's would-be controller makes the choice", () => {
		const state = newGame();
		const selected = spawnPermanent(state, "grizzly-bears", BOB);
		const clone = spawnCard(state, "clone", ALICE, "hand");
		const aliceFallback = new ScriptedAgent();
		const alice: SyncAgent = {
			choose(view, request) {
				if (request.kind === "copyAs") {
					throw new Error("Clone's owner was incorrectly asked");
				}
				return aliceFallback.choose(view, request);
			},
		};
		const recorder = ChoiceController.record([
			alice,
			chooseCopyAs(selected.id),
		]);
		const result = perform(
			state,
			{ ...cloneEvent(clone.id), toController: BOB },
			recorder,
		);

		const entered = created(result);
		expect(permanent(state, entered).controller).toBe(BOB);
		expect(
			readObject(createReadContext(state), entered).currentCharacteristics.name,
		).toBe("Grizzly Bears");
		expect(recorder.transcript().choices[0]?.request.player).toBe(BOB);
	});

	test("may decline and enter as Clone", () => {
		const state = newGame();
		spawnPermanent(state, "grizzly-bears", BOB);
		const clone = spawnCard(state, "clone", ALICE, "hand");

		const entered = created(
			perform(state, cloneEvent(clone.id), [
				chooseCopyAs(null),
				new ScriptedAgent(),
			]),
		);
		const snapshot = readObject(createReadContext(state), entered);
		expect(snapshot.currentCharacteristics.name).toBe("Clone");
		expect(snapshot.currentCharacteristics).toMatchObject({
			kind: "creature",
			power: 0,
			toughness: 0,
		});
	});

	test("can choose a permanent that is currently a creature but copies only its copiable values", () => {
		const state = newGame();
		spawnPermanent(state, "test-animate-artifacts-for-copy", ALICE);
		const relic = spawnPermanent(state, "darksteel-relic", BOB);
		const clone = spawnCard(state, "clone", ALICE, "hand");

		const entered = created(
			perform(state, cloneEvent(clone.id), [
				chooseCopyAs(relic.id),
				new ScriptedAgent(),
			]),
		);
		const snapshot = readObject(createReadContext(state), entered);
		expect(snapshot.copiableValues.name).toBe("Darksteel Relic");
		expect(snapshot.copiableValues.types).toEqual(["artifact"]);
		expect(snapshot.currentCharacteristics.types).toEqual([
			"artifact",
			"creature",
		]);
	});

	test("acquires and applies the chosen creature's own entry replacement in the same event", () => {
		const state = newGame();
		const watchdog = spawnPermanent(state, "faithful-watchdog", BOB);
		const clone = spawnCard(state, "clone", ALICE, "hand");

		const entered = created(
			perform(state, cloneEvent(clone.id), [
				chooseCopyAs(watchdog.id),
				new ScriptedAgent(),
			]),
		);
		const snapshot = readObject(createReadContext(state), entered);
		expect(snapshot.currentCharacteristics.name).toBe("Faithful Watchdog");
		expect(permanent(state, entered).counters).toEqual({ "+1/+1": 3 });
	});

	test("with no legal creature, enters as Clone without asking", () => {
		const state = newGame();
		const clone = spawnCard(state, "clone", ALICE, "hand");
		const recorder = ChoiceController.record([
			new ScriptedAgent(),
			new ScriptedAgent(),
		]);

		const entered = created(perform(state, cloneEvent(clone.id), recorder));
		expect(
			readObject(createReadContext(state), entered).currentCharacteristics.name,
		).toBe("Clone");
		expect(recorder.transcript().choices).toHaveLength(0);
	});

	test("records, serializes, and exactly replays the selection", () => {
		const checkpoint = newGame();
		spawnPermanent(checkpoint, "grizzly-bears", BOB);
		const selected = spawnPermanent(checkpoint, "eager-cadet", BOB);
		const clone = spawnCard(checkpoint, "clone", ALICE, "hand");

		const recordedState = structuredClone(checkpoint);
		const recorder = ChoiceController.record([
			chooseCopyAs(selected.id),
			new ScriptedAgent(),
		]);
		perform(recordedState, cloneEvent(clone.id), recorder);
		const transcript = JSON.parse(JSON.stringify(recorder.transcript()));

		const replayedState = structuredClone(checkpoint);
		const replay = ChoiceController.replay(transcript);
		perform(replayedState, cloneEvent(clone.id), replay);
		replay.assertComplete();
		expect(replayedState).toEqual(recordedState);
	});

	test("an asynchronous selection unwinds and replays from the checkpoint", async () => {
		const checkpoint = newGame();
		const selected = spawnPermanent(checkpoint, "grizzly-bears", BOB);
		const clone = spawnCard(checkpoint, "clone", ALICE, "hand");
		const checkpointSnapshot = structuredClone(checkpoint);
		const fallback = new ScriptedAgent();
		const asyncAgent: Agent = {
			choose(view, request) {
				if (request.kind === "copyAs") {
					return Promise.resolve({ optionId: String(selected.id) });
				}
				return fallback.choose(view, request);
			},
		};
		const choices = ChoiceController.suspending([
			asyncAgent,
			new ScriptedAgent(),
		]);
		let pending: ChoicePendingError | undefined;
		try {
			choices.chooseCopyAs(checkpoint, ALICE, cloneEvent(clone.id), clone.id, [
				selected.id,
			]);
		} catch (error) {
			if (!(error instanceof ChoicePendingError)) throw error;
			pending = error;
		}
		if (!pending) throw new Error("expected copy-as choice to suspend");
		expect(pending.request.kind).toBe("copyAs");
		choices.recordAnswer(pending.request, await pending.answer);

		choices.rewind();
		expect(
			choices.chooseCopyAs(checkpoint, ALICE, cloneEvent(clone.id), clone.id, [
				selected.id,
			]),
		).toBe(selected.id);
		choices.assertComplete();
		expect(checkpoint).toEqual(checkpointSnapshot);
	});
});

describe("choosing who applies a replacement effect", () => {
	test("a permanent's controller chooses, not its owner", () => {
		const state = newGame();
		const bears = spawnPermanent(state, "grizzly-bears", ALICE);
		permanent(state, bears.id).controller = BOB;

		expect(
			affectedPlayer(state, {
				kind: "destroy",
				object: bears.id,
				noRegen: true,
			}),
		).toBe(BOB);
	});

	test("an object with no controller falls back to its owner", () => {
		const state = newGame();
		const card = spawnCard(state, "grizzly-bears", BOB, "graveyard");

		expect(
			affectedPlayer(state, {
				kind: "add counters",
				target: { type: "permanent", id: card.id },
				counter: "+1/+1",
				amount: 1,
			}),
		).toBe(BOB);
	});

	test("an event naming no object has no chooser at all", () => {
		const state = newGame();
		const missing = 9999 as ObjectId;

		// Answering P0 here would hand a real choice to a player the event
		// never affected.
		expect(() =>
			affectedPlayer(state, {
				kind: "destroy",
				object: missing,
				noRegen: true,
			}),
		).toThrow("no object 9999 to choose a replacement for");
	});
});
