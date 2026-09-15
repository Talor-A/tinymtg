import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "../agents.ts";
import {
	CARDS,
	gatherSpecimens,
	preventNextDamageShield,
	prismaticStrands,
	regenerationShield,
} from "../cards.ts";
import type { Agent, GameState, ObjectId, SyncAgent } from "../index.ts";
import {
	addTemporaryEffect,
	affectedPlayer,
	ChoiceController,
	ChoicePendingError,
	createEngine,
	defineCard,
	getSnapshot,
	permanent,
} from "../index.ts";
import {
	type SyncAgents as Agents,
	ALICE,
	BOB,
	created,
} from "./utils/engine-helpers.ts";

function chooseCopiedObject(choice: ObjectId | null): SyncAgent {
	const fallback = new ScriptedAgent();
	return {
		choose(view, request) {
			if (request.kind === "object" && request.context.reason.kind === "copy") {
				return { optionId: choice === null ? "decline" : String(choice) };
			}
			return fallback.choose(view, request);
		},
	};
}

const TEST_CARD_1 = defineCard({
	id: "test-animate-artifacts-for-copy",
	name: "Test: Animate Artifacts for Copy",
	types: ["enchantment"],
	colors: [],
	manaCost: "zero",
	statics: [
		{
			kind: "characteristic",
			text: "Test: Artifacts are creatures in addition to their other types.",
			applies: (view) =>
				view.currentCharacteristics.types.includes("artifact") &&
				!view.currentCharacteristics.types.includes("creature"),
			effects: [
				{
					layer: "4-type-changing",
					modify: (view) => {
						view.types.push("creature");
					},
				},
			],
		},
	],
});

const engine = createEngine([...CARDS, TEST_CARD_1]);

describe("destroy event success", () => {
	const agents: Agents = [new ScriptedAgent(), new ScriptedAgent()];

	test("ordinary destruction reports both the movement and successful destroy", () => {
		const state = engine.newGame();
		const bears = engine.spawnPermanent(state, "grizzly-bears", ALICE);

		const result = engine.perform(
			state,
			{ kind: "destroy", object: bears.id, noRegen: false },
			agents,
		);

		expect(result.executed).toHaveLength(2);
		expect(result.executed[0]).toMatchObject({
			kind: "change zone",
			object: bears.id,
			from: "battlefield",
			destination: { zone: "graveyard" },
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
		const state = engine.newGame();
		const bears = engine.spawnPermanent(state, "grizzly-bears", ALICE, {
			tapped: false,
		});
		permanent(state, bears.id).damage = 2;
		addTemporaryEffect(state, ALICE, regenerationShield(bears.id));

		const result = engine.perform(
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
		const state = engine.newGame();
		engine.spawnPermanent(state, "samurai-of-the-pale-curtain", BOB);
		const bears = engine.spawnPermanent(state, "grizzly-bears", ALICE);

		const result = engine.perform(
			state,
			{ kind: "destroy", object: bears.id, noRegen: false },
			agents,
		);

		expect(result.executed).toHaveLength(1);
		expect(result.executed[0]).toMatchObject({
			kind: "change zone",
			object: bears.id,
			from: "battlefield",
			destination: { zone: "exile" },
			cause: "destroy",
		});
		expect(state.players[ALICE].graveyard).toHaveLength(0);
		expect(state.players[ALICE].exile).toEqual(result.created);
	});
});

describe("replacement effects that add counters as a permanent enters", () => {
	function enterCountersFixture(preferences: string[]): {
		counters: number;
		state: GameState;
		entered: ObjectId;
	} {
		const state = engine.newGame();
		const agents: Agents = [
			new ScriptedAgent(preferences),
			new ScriptedAgent(),
		];
		engine.spawnPermanent(state, "hardened-scales", ALICE);
		engine.spawnPermanent(state, "doubling-season", ALICE);
		const fixtureCard = engine.spawnCard(
			state,
			"test-enters-with-counters",
			ALICE,
			"hand",
		);
		const result = engine.perform(
			state,
			{
				kind: "change zone",
				object: fixtureCard.id,
				from: "hand",
				destination: { zone: "battlefield", controller: ALICE },
				cause: "resolve",
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
		const scalesFirst = enterCountersFixture(["hardened scales"]);
		// "enters with 2" is self-replacement and always applies first: 2 -> +1 -> x2
		expect(scalesFirst.counters, "Scales then Season").toBe(6);

		const seasonFirst = enterCountersFixture(["doubling season"]);
		seasonFirst.state.log.length = 0;
		expect(seasonFirst.counters, "Season then Scales").toBe(5);
		expect(
			getSnapshot(
				engine.createReadContext(scalesFirst.state),
				scalesFirst.entered,
			).currentCharacteristics,
			"fixture power with 6 counters",
		).toMatchObject({ power: 6 });
	});
});

describe("when two effects change where a destroyed creature goes", () => {
	function kalitasFixtureVsSamurai(p1Prefs: string[]): GameState {
		const state = engine.newGame();
		const agents: Agents = [new ScriptedAgent(), new ScriptedAgent(p1Prefs)];
		engine.spawnPermanent(state, "test-kalitas-replacement", ALICE);
		engine.spawnPermanent(state, "samurai-of-the-pale-curtain", BOB);
		const bears = engine.spawnPermanent(state, "grizzly-bears", BOB);
		engine.perform(
			state,
			{ kind: "destroy", object: bears.id, noRegen: false },
			agents,
		);
		return state;
	}
	test("the creature's controller chooses which effect applies first", () => {
		const samuraiFirst = kalitasFixtureVsSamurai(["samurai"]);
		expect(
			samuraiFirst.battlefield.filter(
				(id) => permanent(samuraiFirst, id).representation.kind === "token",
			).length,
			"ALICE picks the Samurai: no Zombie for P0",
		).toBe(0);
		expect(samuraiFirst.players[BOB].exile.length, "bears exiled").toBe(1);

		const kalitasFixtureFirst = kalitasFixtureVsSamurai(["kalitas-style"]);
		kalitasFixtureFirst.log.length = 0;
		const tokens = kalitasFixtureFirst.battlefield.filter(
			(id) =>
				permanent(kalitasFixtureFirst, id).representation.kind === "token",
		);
		expect(
			tokens.length,
			"ALICE picks the Kalitas-style fixture: P0 gets a Zombie",
		).toBe(1);
		const tokenId = tokens[0];
		if (tokenId === undefined)
			throw new Error("fixture did not create a token");
		const token = getSnapshot(
			engine.createReadContext(kalitasFixtureFirst),
			tokenId,
		);
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
		const state = engine.newGame();
		const agents: Agents = [new ScriptedAgent(), new ScriptedAgent()];
		engine.spawnPermanent(state, "chains-of-mephistopheles", ALICE);
		engine.spawnCard(state, "forest", ALICE, "library");
		engine.spawnCard(state, "forest", ALICE, "library");
		engine.spawnCard(state, "grizzly-bears", ALICE, "hand");

		engine.perform(state, { kind: "draw", player: ALICE }, agents);

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
		const state = engine.newGame();
		const agents: Agents = [new ScriptedAgent(), new ScriptedAgent()];
		engine.spawnPermanent(state, "chains-of-mephistopheles", ALICE);
		engine.spawnCard(state, "forest", ALICE, "library");

		engine.perform(state, { kind: "draw", player: ALICE }, agents);
		expect(state.players[ALICE].hand.length, "no cards drawn").toBe(0);
		expect(state.players[ALICE].library.length, "library down by one").toBe(0);
		expect(state.players[ALICE].graveyard.length, "top card was milled").toBe(
			1,
		);
	});
});

describe("choosing between damage replacement and prevention effects", () => {
	function dealDamage(preferences: string[]): GameState {
		const state = engine.newGame();
		const agents: Agents = [
			new ScriptedAgent(),
			new ScriptedAgent(preferences),
		];
		engine.spawnPermanent(state, "furnace-of-rath", ALICE);
		const source = engine.spawnPermanent(state, "eager-cadet", ALICE);
		addTemporaryEffect(
			state,
			BOB,
			preventNextDamageShield({ type: "player", player: BOB }, 3),
		);
		engine.perform(
			state,
			{
				kind: "damage",
				source: source.id,
				sourceController: ALICE,
				sourceColors: ["r"],
				recipient: { type: "player", player: BOB },
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
		const state = engine.newGame();
		const agents: Agents = [
			new ScriptedAgent(),
			new ScriptedAgent(["prevent"]),
		];
		engine.spawnPermanent(state, "furnace-of-rath", ALICE);
		const pyro = engine.spawnPermanent(state, "eager-cadet", 0);
		addTemporaryEffect(
			state,
			BOB,
			preventNextDamageShield({ type: "player", player: BOB }, 3),
		);
		engine.perform(
			state,
			{
				kind: "damage",
				source: pyro.id,
				sourceController: ALICE,
				sourceColors: ["r"],
				recipient: { type: "player", player: BOB },
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
		const state = engine.newGame();
		const agents: Agents = [new ScriptedAgent(), new ScriptedAgent()];
		const giant = engine.spawnPermanent(state, "palisade-giant", 1);
		const pyro = engine.spawnPermanent(state, "eager-cadet", 0);
		engine.perform(
			state,
			{
				kind: "damage",
				source: pyro.id,
				sourceController: ALICE,
				sourceColors: ["r"],
				recipient: { type: "player", player: BOB },
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

		addTemporaryEffect(state, 1, prismaticStrands("r"));
		engine.perform(
			state,
			{
				kind: "damage",
				source: pyro.id,
				sourceController: ALICE,
				sourceColors: ["r"],
				recipient: { type: "player", player: BOB },
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
		const state = engine.newGame();
		const agents: Agents = [new ScriptedAgent(), new ScriptedAgent()];
		engine.spawnPermanent(state, "root-maze", 0);
		const bearsCard = engine.spawnCard(state, "grizzly-bears", 0, "hand");
		const r1 = engine.perform(
			state,
			{
				kind: "change zone",
				object: bearsCard.id,
				from: "hand",
				destination: { zone: "battlefield", controller: ALICE },
				cause: "resolve",
			},
			agents,
		);
		expect(
			permanent(state, created(r1)).tapped,
			"no Lattice: bear enters untapped",
		).toBe(false);

		engine.spawnPermanent(state, "baby-mycosynth-lattice", 0);
		const bears2 = engine.spawnCard(state, "grizzly-bears", 0, "hand");
		const r2 = engine.perform(
			state,
			{
				kind: "change zone",
				object: bears2.id,
				from: "hand",
				destination: { zone: "battlefield", controller: ALICE },
				cause: "resolve",
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
		const state = engine.newGame();
		const agents: Agents = [new ScriptedAgent(), new ScriptedAgent()];
		engine.spawnPermanent(state, "root-maze", 0);
		engine.spawnPermanent(state, "baby-mycosynth-lattice", 0);
		addTemporaryEffect(state, 0, gatherSpecimens());
		const bears = engine.spawnCard(state, "grizzly-bears", 1, "hand");

		const r = engine.perform(
			state,
			{
				kind: "change zone",
				object: bears.id,
				from: "hand",
				destination: { zone: "battlefield", controller: BOB },
				cause: "resolve",
			},
			agents,
		);
		const entered = permanent(state, created(r));
		expect(entered.controller, "P0 stole it").toBe(0);
		expect(entered.tapped, "and it still entered tapped").toBe(true);
		expect(entered.owner, "ALICE still owns it").toBe(1);
	});

	test("the forced-copy fixture chooses what to copy before that card's own entry effect applies", () => {
		const state = engine.newGame();
		const agents: Agents = [new ScriptedAgent(), new ScriptedAgent()];
		engine.spawnPermanent(state, "test-enters-with-counters", 1, {
			counters: { "+1/+1": 2 },
		});
		const clone = engine.spawnCard(state, "test-forced-copy", 0, "hand");
		const r = engine.perform(
			state,
			{
				kind: "change zone",
				object: clone.id,
				from: "hand",
				destination: { zone: "battlefield", controller: ALICE },
				cause: "resolve",
			},
			agents,
		);
		const entered = created(r);
		const copied = permanent(state, entered);
		expect(
			copied.representation,
			"physical test fixture card is retained",
		).toEqual({
			kind: "card",
			cardId: "test-forced-copy",
		});
		expect(
			getSnapshot(engine.createReadContext(state), entered)
				.currentCharacteristics.name,
			"entered as a copy of the counters fixture",
		).toBe("TEST ONLY — Enters With Counters");
		// The copy picks up the copied card's printed ETB self-replacement, which is
		// the generally correct behavior for a fixed entersWith count. This would not
		// generalize to the real Walking Ballista: its X is chosen on resolution
		// (mana paid), so a copy should see X=0, not the caster's X. Modeling that
		// would mean storing the chosen X on the event rather than baking it into the
		// card definition — out of scope for this fixture.
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
			destination: { zone: "battlefield" as const, controller: ALICE },
			cause: "resolve" as const,
		};
	}

	test("chooses any battlefield creature without targeting", () => {
		const state = engine.newGame();
		const first = engine.spawnPermanent(state, "grizzly-bears", BOB);
		const selected = engine.spawnPermanent(state, "eager-cadet", BOB);
		const clone = engine.spawnCard(state, "clone", ALICE, "hand");
		const recorder = ChoiceController.record(engine, [
			chooseCopiedObject(selected.id),
			new ScriptedAgent(),
		]);

		const result = engine.perform(state, cloneEvent(clone.id), recorder);
		const entered = created(result);
		expect(
			getSnapshot(engine.createReadContext(state), entered)
				.currentCharacteristics.name,
		).toBe("Eager Cadet");
		expect(permanent(state, entered).representation).toEqual({
			kind: "card",
			cardId: "clone",
		});

		const request = recorder.transcript().choices[0]?.request;
		expect(request?.kind).toBe("object");
		expect(request?.options.map((option) => option.id)).toEqual([
			String(first.id),
			String(selected.id),
			"decline",
		]);
	});

	test("the entering permanent's would-be controller makes the choice", () => {
		const state = engine.newGame();
		const selected = engine.spawnPermanent(state, "grizzly-bears", BOB);
		const clone = engine.spawnCard(state, "clone", ALICE, "hand");
		const aliceFallback = new ScriptedAgent();
		const alice: SyncAgent = {
			choose(view, request) {
				if (
					request.kind === "object" &&
					request.context.reason.kind === "copy"
				) {
					throw new Error("Clone's owner was incorrectly asked");
				}
				return aliceFallback.choose(view, request);
			},
		};
		const recorder = ChoiceController.record(engine, [
			alice,
			chooseCopiedObject(selected.id),
		]);
		const event = cloneEvent(clone.id);
		const result = engine.perform(
			state,
			{
				...event,
				destination: { ...event.destination, controller: BOB },
			},
			recorder,
		);

		const entered = created(result);
		expect(permanent(state, entered).controller).toBe(BOB);
		expect(
			getSnapshot(engine.createReadContext(state), entered)
				.currentCharacteristics.name,
		).toBe("Grizzly Bears");
		expect(recorder.transcript().choices[0]?.request.player).toBe(BOB);
	});

	test("may decline and enter as Clone", () => {
		const state = engine.newGame();
		engine.spawnPermanent(state, "grizzly-bears", BOB);
		const clone = engine.spawnCard(state, "clone", ALICE, "hand");

		const entered = created(
			engine.perform(state, cloneEvent(clone.id), [
				chooseCopiedObject(null),
				new ScriptedAgent(),
			]),
		);
		const snapshot = getSnapshot(engine.createReadContext(state), entered);
		expect(snapshot.currentCharacteristics.name).toBe("Clone");
		expect(snapshot.currentCharacteristics).toMatchObject({
			kind: "creature",
			power: 0,
			toughness: 0,
		});
	});

	test("can choose a permanent that is currently a creature but copies only its copiable values", () => {
		const state = engine.newGame();
		engine.spawnPermanent(state, "test-animate-artifacts-for-copy", ALICE);
		const relic = engine.spawnPermanent(state, "darksteel-relic", BOB);
		const clone = engine.spawnCard(state, "clone", ALICE, "hand");

		const entered = created(
			engine.perform(state, cloneEvent(clone.id), [
				chooseCopiedObject(relic.id),
				new ScriptedAgent(),
			]),
		);
		const snapshot = getSnapshot(engine.createReadContext(state), entered);
		expect(snapshot.copiableValues.name).toBe("Darksteel Relic");
		expect(snapshot.copiableValues.types).toEqual(["artifact"]);
		expect(snapshot.currentCharacteristics.types).toEqual([
			"artifact",
			"creature",
		]);
	});

	test("acquires and applies the chosen creature's own entry replacement in the same event", () => {
		const state = engine.newGame();
		const watchdog = engine.spawnPermanent(state, "faithful-watchdog", BOB);
		const clone = engine.spawnCard(state, "clone", ALICE, "hand");

		const entered = created(
			engine.perform(state, cloneEvent(clone.id), [
				chooseCopiedObject(watchdog.id),
				new ScriptedAgent(),
			]),
		);
		const snapshot = getSnapshot(engine.createReadContext(state), entered);
		expect(snapshot.currentCharacteristics.name).toBe("Faithful Watchdog");
		expect(permanent(state, entered).counters).toEqual({ "+1/+1": 3 });
	});

	test("with no legal creature, enters as Clone without asking", () => {
		const state = engine.newGame();
		const clone = engine.spawnCard(state, "clone", ALICE, "hand");
		const recorder = ChoiceController.record(engine, [
			new ScriptedAgent(),
			new ScriptedAgent(),
		]);

		const entered = created(
			engine.perform(state, cloneEvent(clone.id), recorder),
		);
		expect(
			getSnapshot(engine.createReadContext(state), entered)
				.currentCharacteristics.name,
		).toBe("Clone");
		expect(recorder.transcript().choices).toHaveLength(0);
	});

	test("records, serializes, and exactly replays the selection", () => {
		const checkpoint = engine.newGame();
		engine.spawnPermanent(checkpoint, "grizzly-bears", BOB);
		const selected = engine.spawnPermanent(checkpoint, "eager-cadet", BOB);
		const clone = engine.spawnCard(checkpoint, "clone", ALICE, "hand");

		const recordedState = structuredClone(checkpoint);
		const recorder = ChoiceController.record(engine, [
			chooseCopiedObject(selected.id),
			new ScriptedAgent(),
		]);
		engine.perform(recordedState, cloneEvent(clone.id), recorder);
		const transcript = JSON.parse(JSON.stringify(recorder.transcript()));

		const replayedState = structuredClone(checkpoint);
		const replay = ChoiceController.replay(engine, transcript);
		engine.perform(replayedState, cloneEvent(clone.id), replay);
		replay.assertComplete();
		expect(replayedState).toEqual(recordedState);
	});

	test("an asynchronous selection unwinds and replays from the checkpoint", async () => {
		const checkpoint = engine.newGame();
		const selected = engine.spawnPermanent(checkpoint, "grizzly-bears", BOB);
		const clone = engine.spawnCard(checkpoint, "clone", ALICE, "hand");
		const checkpointSnapshot = structuredClone(checkpoint);
		const fallback = new ScriptedAgent();
		const asyncAgent: Agent = {
			choose(view, request) {
				if (
					request.kind === "object" &&
					request.context.reason.kind === "copy"
				) {
					return Promise.resolve({ optionId: String(selected.id) });
				}
				return fallback.choose(view, request);
			},
		};
		const choices = ChoiceController.suspending(engine, [
			asyncAgent,
			new ScriptedAgent(),
		]);
		let pending: ChoicePendingError | undefined;
		try {
			choices.chooseObject(checkpoint, ALICE, {
				reason: { kind: "copy", event: cloneEvent(clone.id), source: clone.id },
				objects: [selected.id],
				optional: { label: "Don't copy" },
			});
		} catch (error) {
			if (!(error instanceof ChoicePendingError)) throw error;
			pending = error;
		}
		if (!pending) throw new Error("expected copy-as choice to suspend");
		expect(pending.request.kind).toBe("object");
		choices.recordAnswer(pending.request, await pending.answer);

		choices.rewind();
		expect(
			choices.chooseObject(checkpoint, ALICE, {
				reason: { kind: "copy", event: cloneEvent(clone.id), source: clone.id },
				objects: [selected.id],
				optional: { label: "Don't copy" },
			}),
		).toBe(selected.id);
		choices.assertComplete();
		expect(checkpoint).toEqual(checkpointSnapshot);
	});
});

describe("choosing who applies a replacement effect", () => {
	test("a permanent's controller chooses, not its owner", () => {
		const state = engine.newGame();
		const bears = engine.spawnPermanent(state, "grizzly-bears", ALICE);
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
		const state = engine.newGame();
		const card = engine.spawnCard(state, "grizzly-bears", BOB, "graveyard");

		expect(
			affectedPlayer(state, {
				kind: "add counters",
				permanent: { type: "permanent", id: card.id },
				counter: "+1/+1",
				amount: 1,
			}),
		).toBe(BOB);
	});

	test("an event naming no object has no chooser at all", () => {
		const state = engine.newGame();
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
