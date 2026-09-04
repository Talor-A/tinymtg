import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "./agents.ts";
import "./cards.ts"; // side effect: registers the card database
import type {
	SyncAgent as Agent,
	ChoiceRequest,
	GameState,
	ObjectId,
	PlayerId,
} from "./index.ts";
import {
	activePlayer,
	addFloating,
	advance,
	affectedPlayer,
	ChoiceController,
	checkStateBasedActions,
	gameOver,
	IllegalAttackDeclarationError,
	IllegalBlockDeclarationError,
	isTurnStep,
	newGame,
	perform,
	permanent,
	physicalCardId,
	settlePriority,
	spawnCard,
	spawnPermanent,
	triggeredAbilityId,
	view,
	winner,
} from "./index.ts";
import {
	advanceUntil,
	beginFirstTurn,
	passingAgents,
} from "./test/engine-helpers.ts";

const P1 = 0 as PlayerId;
const P2 = 1 as PlayerId;

function dump(state: GameState): void {
	if (!process.env.VERBOSE) return;
	if (state.log.length === 0) return;
	console.log(state.log.map((l) => `    ${l}`).join("\n"));
	state.log.length = 0;
}

function created(result: { created: ObjectId[] }): ObjectId {
	if (result.created.length === 0) throw new Error("nothing created");
	return result.created[0]!;
}

describe("destroy event success", () => {
	const agents: [Agent, Agent] = [new ScriptedAgent(), new ScriptedAgent()];

	test("ordinary destruction reports both the movement and successful destroy", () => {
		const state = newGame();
		const bears = spawnPermanent(state, "grizzly-bears", P1);

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
		expect(state.players[P1].graveyard).toEqual(result.created);
	});

	test("regeneration replaces destruction without reporting a destroy", () => {
		const state = newGame();
		const bears = spawnPermanent(state, "grizzly-bears", P1, {
			tapped: false,
		});
		permanent(state, bears.id).damage = 2;
		addFloating(
			state,
			P1,
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
		expect(state.players[P1].graveyard).toHaveLength(0);
		expect(permanent(state, bears.id)).toMatchObject({
			tapped: true,
			damage: 0,
		});
	});

	test("exile-instead movement executes without reporting a destroy", () => {
		const state = newGame();
		spawnPermanent(state, "rest-in-peace", P2);
		const bears = spawnPermanent(state, "grizzly-bears", P1);

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
		expect(state.players[P1].graveyard).toHaveLength(0);
		expect(state.players[P1].exile).toEqual(result.created);
	});
});

describe("replacement effects that add counters as a permanent enters", () => {
	function enterWalkingBallista(preferences: string[]): {
		counters: number;
		state: GameState;
		entered: ObjectId;
	} {
		const state = newGame();
		const agents: [Agent, Agent] = [
			new ScriptedAgent(preferences),
			new ScriptedAgent(),
		];
		spawnPermanent(state, "hardened-scales", P1);
		spawnPermanent(state, "doubling-season", P1);
		const ballistaCard = spawnCard(state, "walking-ballista", P1, "hand");
		const result = perform(
			state,
			{
				kind: "change zone",
				object: ballistaCard.id,
				from: "hand",
				to: "battlefield",
				cause: "resolve",
				toController: P1,
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
		dump(scalesFirst.state);
		// "enters with 2" is self-replacement and always applies first: 2 -> +1 -> x2
		expect(scalesFirst.counters, "Scales then Season").toBe(6);

		const seasonFirst = enterWalkingBallista(["doubling season"]);
		seasonFirst.state.log.length = 0;
		expect(seasonFirst.counters, "Season then Scales").toBe(5);
		expect(
			view(scalesFirst.state, scalesFirst.entered).power,
			"Ballista power with 6 counters",
		).toBe(6);
	});
});

describe("when two effects change where a destroyed creature goes", () => {
	function kalitasVsRip(p1Prefs: string[]): GameState {
		const state = newGame();
		const agents: [Agent, Agent] = [
			new ScriptedAgent(),
			new ScriptedAgent(p1Prefs),
		];
		spawnPermanent(state, "kalitas", P1);
		spawnPermanent(state, "rest-in-peace", P2);
		const bears = spawnPermanent(state, "grizzly-bears", P2);
		perform(
			state,
			{ kind: "destroy", object: bears.id, noRegen: false },
			agents,
		);
		return state;
	}
	test("the creature's controller chooses which effect applies first", () => {
		const ripFirst = kalitasVsRip(["rest in peace"]);
		dump(ripFirst);
		expect(
			ripFirst.battlefield.filter(
				(id) => permanent(ripFirst, id).representation.kind === "token",
			).length,
			"P1 picks RiP: no Zombie for P0",
		).toBe(0);
		expect(ripFirst.players[P2].exile.length, "bears exiled").toBe(1);

		const kalitasFirst = kalitasVsRip(["kalitas"]);
		kalitasFirst.log.length = 0;
		expect(
			kalitasFirst.battlefield.filter(
				(id) => permanent(kalitasFirst, id).representation.kind === "token",
			).length,
			"P1 picks Kalitas: P0 gets a Zombie",
		).toBe(1);
	});
});

describe("drawing with Chains of Mephistopheles on the battlefield", () => {
	test("a player with a card in hand discards before drawing", () => {
		const state = newGame();
		const agents: [Agent, Agent] = [new ScriptedAgent(), new ScriptedAgent()];
		spawnPermanent(state, "chains-of-mephistopheles", P1);
		spawnCard(state, "forest", P1, "library");
		spawnCard(state, "forest", P1, "library");
		spawnCard(state, "grizzly-bears", P1, "hand");

		perform(state, { kind: "draw", player: P1 }, agents);
		dump(state);

		expect(
			state.players[P1].hand.length,
			"hand still 1 (discarded one, drew one)",
		).toBe(1);
		expect(
			state.players[P1].graveyard.length,
			"graveyard has the discarded card",
		).toBe(1);
		expect(state.players[P1].library.length, "library down by one").toBe(1);
	});

	test("a player with an empty hand mills instead of drawing", () => {
		const state = newGame();
		const agents: [Agent, Agent] = [new ScriptedAgent(), new ScriptedAgent()];
		spawnPermanent(state, "chains-of-mephistopheles", P1);
		spawnCard(state, "forest", P1, "library");

		perform(state, { kind: "draw", player: P1 }, agents);
		dump(state);
		expect(state.players[P1].hand.length, "no cards drawn").toBe(0);
		expect(state.players[P1].library.length, "library down by one").toBe(0);
		expect(state.players[P1].graveyard.length, "top card was milled").toBe(1);
	});
});

describe("choosing between damage replacement and prevention effects", () => {
	function dealDamage(preferences: string[]): GameState {
		const state = newGame();
		const agents: [Agent, Agent] = [
			new ScriptedAgent(),
			new ScriptedAgent(preferences),
		];
		spawnPermanent(state, "furnace-of-rath", P1);
		const source = spawnPermanent(state, "eager-cadet", P1);
		addFloating(
			state,
			P2,
			"preventNextDamage",
			{ targetType: "player", targetPlayer: P2, amount: 3 },
			{ data: { remaining: 3 } },
		);
		perform(
			state,
			{
				kind: "damage",
				source: source.id,
				sourceController: P1,
				sourceColors: ["r"],
				target: { type: "player", player: P2 },
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
		dump(preventFirst);
		// Preventing 2 of 2 replaces the damage with nothing, so Furnace never applies.
		expect(preventFirst.players[1].life, "shield first: P1 takes 0").toBe(20);

		const furnaceFirst = dealDamage(["furnace"]);
		furnaceFirst.log.length = 0;
		// 2 -> 4, shield eats 3, 1 gets through.
		expect(furnaceFirst.players[1].life, "furnace first: P1 takes 1").toBe(19);
	});

	test("unpreventable damage can still be doubled", () => {
		const state = newGame();
		const agents: [Agent, Agent] = [
			new ScriptedAgent(),
			new ScriptedAgent(["prevent"]),
		];
		spawnPermanent(state, "furnace-of-rath", P1);
		const pyro = spawnPermanent(state, "eager-cadet", 0);
		addFloating(
			state,
			P2,
			"preventNextDamage",
			{ targetType: "player", targetPlayer: P2, amount: 3 },
			{
				data: { remaining: 3 },
			},
		);
		perform(
			state,
			{
				kind: "damage",
				source: pyro.id,
				sourceController: P1,
				sourceColors: ["r"],
				target: { type: "player", player: P2 },
				amount: 2,
				combat: false,
				deathtouch: false,
				lifelink: false,
				unpreventable: true,
			},
			agents,
		);
		dump(state);
		expect(state.players[1].life, "P1 takes the doubled 4").toBe(16);
	});

	test("redirected damage can still be prevented", () => {
		const state = newGame();
		const agents: [Agent, Agent] = [new ScriptedAgent(), new ScriptedAgent()];
		const giant = spawnPermanent(state, "palisade-giant", 1);
		const pyro = spawnPermanent(state, "eager-cadet", 0);
		perform(
			state,
			{
				kind: "damage",
				source: pyro.id,
				sourceController: P1,
				sourceColors: ["r"],
				target: { type: "player", player: P2 },
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
		expect(state.players[1].life, "P1 life untouched").toBe(20);

		addFloating(state, 1, "prismaticStrands", { color: "r" });
		perform(
			state,
			{
				kind: "damage",
				source: pyro.id,
				sourceController: P1,
				sourceColors: ["r"],
				target: { type: "player", player: P2 },
				amount: 3,
				combat: false,
				deathtouch: false,
				lifelink: false,
				unpreventable: false,
			},
			agents,
		);
		dump(state);
		expect(
			permanent(state, giant.id).damage,
			"second hit fully prevented",
		).toBe(3);
	});
});

describe("indestructible permanents", () => {
	test("a failed destruction attempt doesn't consume a regeneration shield", () => {
		const state = newGame();
		const agents: [Agent, Agent] = [new ScriptedAgent(), new ScriptedAgent()];
		const myr = spawnPermanent(state, "darksteel-myr", P1);
		addFloating(
			state,
			P1,
			"regenerationShield",
			{ target: myr.id },
			{ data: { used: 0 } },
		);

		const result = perform(
			state,
			{ kind: "destroy", object: myr.id, noRegen: false },
			agents,
		);
		dump(state);

		expect(result.executed, "the prohibited event didn't execute").toEqual([]);
		expect(state.battlefield.includes(myr.id), "Myr survived").toBe(true);
		expect(
			state.floating[0]?.data.used,
			"a non-self replacement can't apply to a prohibited event (CR 614.17c)",
		).toBe(0);
	});

	test("lethal damage and deathtouch don't destroy them", () => {
		const state = newGame();
		const agents: [Agent, Agent] = [new ScriptedAgent(), new ScriptedAgent()];
		const lethal = spawnPermanent(state, "darksteel-myr", P1);
		const deathtouched = spawnPermanent(state, "darksteel-myr", P1, {
			counters: { "+1/+1": 1 },
		});
		permanent(state, lethal.id).damage = 1;
		permanent(state, deathtouched.id).damage = 1;
		permanent(state, deathtouched.id).attributes.deathtouched = true;

		checkStateBasedActions(state, agents);
		dump(state);

		expect(state.battlefield.includes(lethal.id)).toBe(true);
		expect(state.battlefield.includes(deathtouched.id)).toBe(true);
	});

	test("zero toughness still puts them into the graveyard", () => {
		const state = newGame();
		const agents: [Agent, Agent] = [new ScriptedAgent(), new ScriptedAgent()];
		const myr = spawnPermanent(state, "darksteel-myr", P1, {
			counters: { "-1/-1": 1 },
		});

		checkStateBasedActions(state, agents);
		dump(state);

		expect(state.battlefield.includes(myr.id)).toBe(false);
	});
});

describe("tokens leaving the battlefield", () => {
	test("a token on the battlefield has no physical card ID", () => {
		const state = newGame();
		const token = spawnPermanent(state, "zombie-token", P1, {
			token: true,
		});

		expect(physicalCardId(token)).toBe(null);
	});

	test("the zone change happens before the token ceases to exist as an SBA", () => {
		const state = newGame();
		const agents: [Agent, Agent] = [new ScriptedAgent(), new ScriptedAgent()];
		const token = spawnPermanent(state, "zombie-token", P1, {
			token: true,
		});

		const result = perform(
			state,
			{
				kind: "change zone",
				object: token.id,
				from: "battlefield",
				to: "graveyard",
				cause: "sacrifice",
				toController: P1,
			},
			agents,
		);

		expect(result.executed).toHaveLength(1);
		expect(result.created).toHaveLength(1);
		const movedId = created(result);
		const moved = state.objects.get(movedId);
		expect(moved?.kind).toBe("nonbattlefield-token");
		expect(moved?.zone).toBe("graveyard");
		if (!moved) return;
		expect(physicalCardId(moved)).toBe(null);
		if (moved.kind !== "nonbattlefield-token") return;
		expect(moved.createdValues.name).toBe("Zombie");

		checkStateBasedActions(state, agents);
		expect(state.objects.has(movedId)).toBe(false);
		expect(state.players[P1].graveyard.includes(movedId)).toBe(false);
	});
});

describe("regenerating a creature", () => {
	test("regeneration saves it from lethal damage but not zero toughness", () => {
		const state = newGame();
		const agents: [Agent, Agent] = [new ScriptedAgent(), new ScriptedAgent()];
		const bears = spawnPermanent(state, "grizzly-bears", 0);
		const pyro = spawnPermanent(state, "eager-cadet", 1);
		addFloating(
			state,
			0,
			"regenerationShield",
			{ target: bears.id },
			{ data: { used: 0 } },
		);

		perform(
			state,
			{
				kind: "damage",
				source: pyro.id,
				sourceController: P2,
				sourceColors: ["r"],
				target: { type: "permanent", id: bears.id },
				amount: 2,
				combat: false,
				deathtouch: false,
				lifelink: false,
				unpreventable: false,
			},
			agents,
		);
		checkStateBasedActions(state, agents);
		dump(state);
		expect(state.battlefield.includes(bears.id), "bears survived").toBe(true);
		expect(
			permanent(state, bears.id).tapped,
			"bears tapped by regeneration",
		).toBe(true);
		expect(permanent(state, bears.id).damage, "damage removed").toBe(0);

		// Shrink it to 0 toughness: no destroy event, so no shield to hook.
		perform(
			state,
			{
				kind: "add counters",
				target: { type: "permanent", id: bears.id },
				counter: "-1/-1",
				amount: 2,
			},
			agents,
		);
		checkStateBasedActions(state, agents);
		dump(state);
		expect(state.battlefield.includes(bears.id), "bears died to SBA").toBe(
			false,
		);
	});
});

describe("effects that inspect a permanent as it enters", () => {
	test("Root Maze sees a creature that Baby Mycosynth Lattice makes an artifact", () => {
		const state = newGame();
		const agents: [Agent, Agent] = [new ScriptedAgent(), new ScriptedAgent()];
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
				toController: P1,
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
				toController: P1,
			},
			agents,
		);
		dump(state);
		expect(
			permanent(state, created(r2)).tapped,
			"with Lattice: bear enters tapped",
		).toBe(true);
	});
});

describe("interacting effects as permanents enter", () => {
	test("a control-changing effect applies before Root Maze checks the permanent", () => {
		const state = newGame();
		const agents: [Agent, Agent] = [new ScriptedAgent(), new ScriptedAgent()];
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
				toController: P2,
			},
			agents,
		);
		dump(state);
		const entered = permanent(state, created(r));
		expect(entered.controller, "P0 stole it").toBe(0);
		expect(entered.tapped, "and it still entered tapped").toBe(true);
		expect(entered.owner, "P1 still owns it").toBe(1);
	});

	test("Clone chooses what to copy before that card's own entry effect applies", () => {
		const state = newGame();
		const agents: [Agent, Agent] = [new ScriptedAgent(), new ScriptedAgent()];
		spawnPermanent(state, "walking-ballista", 1, {
			counters: { "+1/+1": 2 },
		});
		const clone = spawnCard(state, "clone", 0, "hand");
		const r = perform(
			state,
			{
				kind: "change zone",
				object: clone.id,
				from: "hand",
				to: "battlefield",
				cause: "resolve",
				toController: P1,
			},
			agents,
		);
		dump(state);
		const entered = created(r);
		const copied = permanent(state, entered);
		expect(copied.representation, "physical Clone card is retained").toEqual({
			kind: "card",
			cardId: "clone",
		});
		expect(view(state, entered).name, "entered as a copy of Ballista").toBe(
			"Walking Ballista",
		);
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

describe("effects that change how players win or lose", () => {
	test("Laboratory Maniac wins when drawing from an empty library", () => {
		const state = newGame();
		const agents: [Agent, Agent] = [new ScriptedAgent(), new ScriptedAgent()];
		spawnPermanent(state, "laboratory-maniac", P1);

		perform(state, { kind: "draw", player: P1 }, agents);
		checkStateBasedActions(state, agents);
		dump(state);

		expect(state.players[P1].won, "P1 wins via Laboratory Maniac").toBe(true);
		expect(state.players[P1].lost, "P1 did not also lose").toBe(false);
		expect(gameOver(state), "game is over").toBe(true);
		expect(winner(state), "P1 is the winner").toBe(P1);
	});

	test("Platinum Angel prevents losing from drawing an empty library", () => {
		const state = newGame();
		const agents: [Agent, Agent] = [new ScriptedAgent(), new ScriptedAgent()];
		spawnPermanent(state, "platinum-angel", P1);

		perform(state, { kind: "draw", player: P1 }, agents);
		checkStateBasedActions(state, agents);
		dump(state);

		expect(state.players[P1].lost, "P1 did not lose").toBe(false);
		expect(state.players[P1].won, "P1 did not win").toBe(false);
		expect(gameOver(state), "game continues").toBe(false);
		expect(winner(state), "no winner yet").toBe(null);
	});

	test("without Platinum Angel, drawing an empty library loses the game", () => {
		const state = newGame();
		const agents: [Agent, Agent] = [new ScriptedAgent(), new ScriptedAgent()];

		perform(state, { kind: "draw", player: P1 }, agents);
		checkStateBasedActions(state, agents);
		dump(state);

		expect(state.players[P1].lost, "P1 loses").toBe(true);
		expect(state.players[P1].won, "P1 did not win").toBe(false);
		expect(gameOver(state), "game is over").toBe(true);
		expect(winner(state), "P2 wins by default").toBe(P2);
	});
});

describe("choosing who applies a replacement effect", () => {
	test("a permanent's controller chooses, not its owner", () => {
		const state = newGame();
		const bears = spawnPermanent(state, "grizzly-bears", P1);
		permanent(state, bears.id).controller = P2;

		expect(
			affectedPlayer(state, {
				kind: "destroy",
				object: bears.id,
				noRegen: true,
			}),
		).toBe(P2);
	});

	test("an object with no controller falls back to its owner", () => {
		const state = newGame();
		const card = spawnCard(state, "grizzly-bears", P2, "graveyard");

		expect(
			affectedPlayer(state, {
				kind: "add counters",
				target: { type: "permanent", id: card.id },
				counter: "+1/+1",
				amount: 1,
			}),
		).toBe(P2);
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

describe("triggered abilities", () => {
	function queueTestTrigger(
		state: GameState,
		source: ObjectId,
		controller: PlayerId,
		text: string,
	): void {
		state.pendingTriggers.push({
			source,
			triggerId: triggeredAbilityId("test-trigger", 0),
			controller,
			text,
			effects: [],
		});
	}

	test("puts active-player triggers below nonactive-player triggers", () => {
		const state = newGame();
		const agents: [Agent, Agent] = [new ScriptedAgent(), new ScriptedAgent()];
		// APNAP is meaningless without an active player, so run a real turn.
		beginFirstTurn(state, agents);
		expect(activePlayer(state)).toBe(P1);

		const activeSource = spawnPermanent(state, "grizzly-bears", P1);
		const nonactiveSource = spawnPermanent(state, "grizzly-bears", P2);

		// Deliberately enqueue in the opposite order from APNAP placement.
		queueTestTrigger(state, nonactiveSource.id, P2, "nonactive trigger");
		queueTestTrigger(state, activeSource.id, P1, "active trigger");
		settlePriority(state, agents);

		expect(state.log.filter((line) => line.includes("[stack]"))).toEqual([
			"  [stack] active trigger",
			"  [stack] nonactive trigger",
		]);
		expect(state.log.filter((line) => line.includes("[resolve]"))).toEqual([
			"  [resolve] nonactive trigger",
			"  [resolve] active trigger",
		]);
	});

	test("records and replays a controller's chosen trigger order", () => {
		const checkpoint = newGame();
		beginFirstTurn(checkpoint, passingAgents());
		const first = spawnPermanent(checkpoint, "grizzly-bears", P1);
		const second = spawnPermanent(checkpoint, "eager-cadet", P1);
		queueTestTrigger(checkpoint, first.id, P1, "first trigger");
		queueTestTrigger(checkpoint, second.id, P1, "second trigger");

		let orderRequest:
			| Extract<ChoiceRequest, { kind: "triggerOrder" }>
			| undefined;
		const orderingAgent: Agent = {
			choose(_state, request) {
				if (request.kind === "triggerOrder") {
					orderRequest = request;
					return {
						optionIds: request.options.map((option) => option.id).reverse(),
					};
				}
				const firstOption = request.options[0];
				if (!firstOption) throw new Error("expected a choice option");
				return { optionId: firstOption.id };
			},
		};
		const recordedState = structuredClone(checkpoint);
		const recorder = ChoiceController.record([
			orderingAgent,
			new ScriptedAgent(),
		]);
		settlePriority(recordedState, recorder);

		const transcript = JSON.parse(
			JSON.stringify(recorder.transcript()),
		) as ReturnType<ChoiceController["transcript"]>;
		expect(orderRequest?.player).toBe(P1);
		expect(
			orderRequest?.context.triggers.map((trigger) => trigger.text),
		).toEqual(["first trigger", "second trigger"]);
		expect(transcript.choices[0]?.request.kind).toBe("triggerOrder");
		expect(
			recordedState.log.filter((line) => line.includes("[stack]")),
		).toEqual(["  [stack] second trigger", "  [stack] first trigger"]);

		const replayedState = structuredClone(checkpoint);
		const replay = ChoiceController.replay(transcript);
		settlePriority(replayedState, replay);
		replay.assertComplete();
		expect(replayedState).toEqual(recordedState);
	});

	test("Clone queues and resolves a copied ETB trigger from its characteristics", () => {
		const state = newGame();
		const agents: [Agent, Agent] = [new ScriptedAgent(), new ScriptedAgent()];
		beginFirstTurn(state, agents);
		spawnPermanent(state, "arashin-cleric", P1);
		const clone = spawnCard(state, "clone", P1, "hand");

		const result = perform(
			state,
			{
				kind: "change zone",
				object: clone.id,
				from: "hand",
				to: "battlefield",
				cause: "resolve",
				toController: P1,
			},
			agents,
		);

		const entered = created(result);
		expect(view(state, entered).name).toBe("Arashin Cleric");
		expect(state.pendingTriggers).toHaveLength(1);
		expect(state.pendingTriggers[0]).toMatchObject({
			source: entered,
			triggerId: "arashin-cleric:0",
		});
		expect(() => structuredClone(state)).not.toThrow();

		settlePriority(state, agents);
		expect(state.players[P1].life).toBe(23);
	});

	test("Arashin Cleric queues its ETB trigger and gains life on resolution", () => {
		const state = newGame();
		const agents: [Agent, Agent] = [new ScriptedAgent(), new ScriptedAgent()];
		beginFirstTurn(state, agents);
		const cleric = spawnCard(state, "arashin-cleric", P1, "hand");

		perform(
			state,
			{
				kind: "change zone",
				object: cleric.id,
				from: "hand",
				to: "battlefield",
				cause: "resolve",
				toController: P1,
			},
			agents,
		);

		expect(state.players[P1].life, "trigger has not resolved yet").toBe(20);
		expect(state.pendingTriggers).toHaveLength(1);
		expect(state.pendingTriggers[0]?.source).not.toBe(cleric.id);

		settlePriority(state, agents);
		dump(state);
		expect(state.players[P1].life).toBe(23);
		expect(state.pendingTriggers).toHaveLength(0);
		expect(state.stack).toHaveLength(0);
	});

	/** Enough library for both players to survive the turns a test advances. */
	function stockLibraries(state: GameState): void {
		for (const player of [P1, P2]) {
			for (let i = 0; i < 3; i++) spawnCard(state, "forest", player, "library");
		}
	}

	function atUpkeepOf(state: GameState, player: PlayerId): boolean {
		return isTurnStep(state, "upkeep") && activePlayer(state) === player;
	}

	test("Ajani's Mantra triggers only on its controller's upkeep", () => {
		const state = newGame();
		const agents: [Agent, Agent] = [new ScriptedAgent(), new ScriptedAgent()];
		spawnPermanent(state, "ajanis-mantra", P1);
		stockLibraries(state);

		// The scheduler emits the upkeep itself: no hand-built begin-step event.
		advanceUntil(state, agents, (next) => atUpkeepOf(next, P1));
		expect(state.players[P1].life, "gains life on its own upkeep").toBe(21);

		advanceUntil(state, agents, (next) => atUpkeepOf(next, P2));
		expect(state.players[P1].life, "opponent's upkeep does nothing").toBe(21);
		expect(state.pendingTriggers).toHaveLength(0);
	});

	test("Ajani's Mantra's controller may decline", () => {
		const state = newGame();
		const agents: [Agent, Agent] = [
			new ScriptedAgent([], [false]),
			new ScriptedAgent(),
		];
		spawnPermanent(state, "ajanis-mantra", P1);
		stockLibraries(state);

		advanceUntil(state, agents, (next) => atUpkeepOf(next, P1));

		expect(state.players[P1].life).toBe(20);
	});

	test("a trigger resolves after its source leaves", () => {
		const state = newGame();
		const agents: [Agent, Agent] = [new ScriptedAgent(), new ScriptedAgent()];
		beginFirstTurn(state, agents);
		const cleric = spawnCard(state, "arashin-cleric", P1, "hand");
		const result = perform(
			state,
			{
				kind: "change zone",
				object: cleric.id,
				from: "hand",
				to: "battlefield",
				cause: "resolve",
				toController: P1,
			},
			agents,
		);
		perform(
			state,
			{ kind: "destroy", object: created(result), noRegen: true },
			agents,
		);
		settlePriority(state, agents);
		expect(state.players[P1].life).toBe(23);
	});
});

describe("declaring attackers", () => {
	function declareAttackersSetup(): {
		state: GameState;
		agents: [Agent, Agent];
	} {
		const state = newGame();
		const agents: [Agent, Agent] = [new ScriptedAgent(), new ScriptedAgent()];
		// Enough library cards that the normal draw step along the way doesn't
		// lose either player the game before combat is reached.
		spawnCard(state, "forest", P1, "library");
		spawnCard(state, "forest", P2, "library");
		// Establish a real declare-attackers scheduler boundary via advance(): the
		// battlefield is still empty here, so the step's own turn-based action
		// declares no attackers, and advance() returns at that occurrence.
		while (!isTurnStep(state, "declare attackers")) {
			advance(state, agents);
		}
		return { state, agents };
	}

	test("an empty declaration is legal and changes nothing", () => {
		const { state, agents } = declareAttackersSetup();
		const bears = spawnPermanent(state, "grizzly-bears", P1);

		const result = perform(
			state,
			{ kind: "declare attackers", player: P1, attackers: [] },
			agents,
		);

		expect(result.executed).toHaveLength(1);
		expect(permanent(state, bears.id).attacking).toBe(false);
		expect(permanent(state, bears.id).tapped).toBe(false);
	});

	test("a partial subset of eligible creatures taps and marks only those selected", () => {
		const { state, agents } = declareAttackersSetup();
		const attacker = spawnPermanent(state, "grizzly-bears", P1);
		const stayHome = spawnPermanent(state, "eager-cadet", P1);

		perform(
			state,
			{ kind: "declare attackers", player: P1, attackers: [attacker.id] },
			agents,
		);

		expect(permanent(state, attacker.id).attacking, "declared: attacking").toBe(
			true,
		);
		expect(permanent(state, attacker.id).tapped, "declared: tapped").toBe(true);
		expect(
			permanent(state, stayHome.id).attacking,
			"not declared: untouched",
		).toBe(false);
		expect(
			permanent(state, stayHome.id).tapped,
			"not declared: untouched",
		).toBe(false);
	});

	test("rejects a tapped creature", () => {
		const { state, agents } = declareAttackersSetup();
		const tapped = spawnPermanent(state, "grizzly-bears", P1, {
			tapped: true,
		});

		expect(() =>
			perform(
				state,
				{ kind: "declare attackers", player: P1, attackers: [tapped.id] },
				agents,
			),
		).toThrow(IllegalAttackDeclarationError);
		expect(permanent(state, tapped.id).attacking).toBe(false);
	});

	test("rejects a creature controlled by the opponent", () => {
		const { state, agents } = declareAttackersSetup();
		const opposing = spawnPermanent(state, "grizzly-bears", P2);

		expect(() =>
			perform(
				state,
				{ kind: "declare attackers", player: P1, attackers: [opposing.id] },
				agents,
			),
		).toThrow(IllegalAttackDeclarationError);
		expect(permanent(state, opposing.id).attacking).toBe(false);
	});

	test("rejects a noncreature permanent", () => {
		const { state, agents } = declareAttackersSetup();
		const mantra = spawnPermanent(state, "ajanis-mantra", P1);

		expect(() =>
			perform(
				state,
				{ kind: "declare attackers", player: P1, attackers: [mantra.id] },
				agents,
			),
		).toThrow(IllegalAttackDeclarationError);
	});

	test("rejects duplicate IDs atomically, even with only one eligible creature", () => {
		const { state, agents } = declareAttackersSetup();
		const bears = spawnPermanent(state, "grizzly-bears", P1);

		expect(() =>
			perform(
				state,
				{
					kind: "declare attackers",
					player: P1,
					attackers: [bears.id, bears.id],
				},
				agents,
			),
		).toThrow(IllegalAttackDeclarationError);
		expect(permanent(state, bears.id).attacking, "no partial commit").toBe(
			false,
		);
		expect(permanent(state, bears.id).tapped, "no partial commit").toBe(false);
	});

	test("rejects the whole declaration atomically when a valid ID precedes an ineligible one", () => {
		const { state, agents } = declareAttackersSetup();
		const eligible = spawnPermanent(state, "grizzly-bears", P1);
		const tapped = spawnPermanent(state, "eager-cadet", P1, {
			tapped: true,
		});

		expect(() =>
			perform(
				state,
				{
					kind: "declare attackers",
					player: P1,
					attackers: [eligible.id, tapped.id],
				},
				agents,
			),
		).toThrow(IllegalAttackDeclarationError);
		expect(
			permanent(state, eligible.id).attacking,
			"the eligible creature ahead of the bad ID stayed unaffected",
		).toBe(false);
		expect(permanent(state, eligible.id).tapped).toBe(false);
	});

	test("rejects declaring attackers outside the declare attackers step", () => {
		const state = newGame();
		const agents: [Agent, Agent] = [new ScriptedAgent(), new ScriptedAgent()];
		const bears = spawnPermanent(state, "grizzly-bears", P1);

		expect(() =>
			perform(
				state,
				{ kind: "declare attackers", player: P1, attackers: [bears.id] },
				agents,
			),
		).toThrow(IllegalAttackDeclarationError);
	});

	test("rejects a declaration from a player who isn't the active player", () => {
		const { state, agents } = declareAttackersSetup();
		const bears = spawnPermanent(state, "grizzly-bears", P2);
		// default activePlayer is P1; P2 tries to declare attackers.
		expect(() =>
			perform(
				state,
				{ kind: "declare attackers", player: P2, attackers: [bears.id] },
				agents,
			),
		).toThrow(IllegalAttackDeclarationError);
	});

	test("regeneration still clears attacking (and blocking), not just damage and tapped state", () => {
		const { state, agents } = declareAttackersSetup();
		const bears = spawnPermanent(state, "grizzly-bears", P1);
		perform(
			state,
			{ kind: "declare attackers", player: P1, attackers: [bears.id] },
			agents,
		);
		expect(permanent(state, bears.id).attacking).toBe(true);

		perform(state, { kind: "regenerate", object: bears.id }, agents);

		expect(
			permanent(state, bears.id).attacking,
			"regeneration clears attacking too",
		).toBe(false);
		expect(
			permanent(state, bears.id).tapped,
			"regeneration re-taps as part of its effect, not a cost",
		).toBe(true);
	});
});

describe("declaring blockers", () => {
	function declareBlockersSetup(): {
		state: GameState;
		agents: [Agent, Agent];
		attacker: ReturnType<typeof spawnPermanent>;
	} {
		const state = newGame();
		const attackerAgent = new ScriptedAgent();
		const agents: [Agent, Agent] = [attackerAgent, new ScriptedAgent()];
		spawnCard(state, "forest", P1, "library");
		spawnCard(state, "forest", P2, "library");
		const attacker = spawnPermanent(state, "grizzly-bears", P1);
		attackerAgent.attackerChoices.push([attacker.id]);
		while (!isTurnStep(state, "declare blockers")) {
			advance(state, agents);
		}
		return { state, agents, attacker };
	}

	test("an empty declaration is legal and changes nothing", () => {
		const { state, agents, attacker } = declareBlockersSetup();
		const blocker = spawnPermanent(state, "grizzly-bears", P2);

		const result = perform(
			state,
			{ kind: "declare blockers", player: P2, blockers: [] },
			agents,
		);

		expect(result.executed).toHaveLength(1);
		expect(permanent(state, blocker.id).blocking).toBe(false);
		expect(permanent(state, blocker.id).tapped).toBe(false);
		expect(permanent(state, attacker.id).attacking).toBe(true);
	});

	test("a blocker assignment marks the blocker but does not tap it", () => {
		const { state, agents, attacker } = declareBlockersSetup();
		const blocker = spawnPermanent(state, "grizzly-bears", P2);

		perform(
			state,
			{
				kind: "declare blockers",
				player: P2,
				blockers: [{ blocker: blocker.id, attacker: attacker.id }],
			},
			agents,
		);

		expect(permanent(state, blocker.id).blocking, "declared: blocking").toBe(
			true,
		);
		expect(permanent(state, blocker.id).tapped, "blocking does not tap").toBe(
			false,
		);
		expect(permanent(state, attacker.id).attacking).toBe(true);
	});

	test("multiple blockers can block the same attacker", () => {
		const { state, agents, attacker } = declareBlockersSetup();
		const alpha = spawnPermanent(state, "grizzly-bears", P2);
		const beta = spawnPermanent(state, "eager-cadet", P2);

		perform(
			state,
			{
				kind: "declare blockers",
				player: P2,
				blockers: [
					{ blocker: alpha.id, attacker: attacker.id },
					{ blocker: beta.id, attacker: attacker.id },
				],
			},
			agents,
		);

		expect(permanent(state, alpha.id).blocking).toBe(true);
		expect(permanent(state, beta.id).blocking).toBe(true);
	});

	test("rejects a tapped creature as a blocker", () => {
		const { state, agents, attacker } = declareBlockersSetup();
		const tapped = spawnPermanent(state, "grizzly-bears", P2, {
			tapped: true,
		});

		expect(() =>
			perform(
				state,
				{
					kind: "declare blockers",
					player: P2,
					blockers: [{ blocker: tapped.id, attacker: attacker.id }],
				},
				agents,
			),
		).toThrow(IllegalBlockDeclarationError);
		expect(permanent(state, tapped.id).blocking).toBe(false);
	});

	test("rejects a creature controlled by the active player as a blocker", () => {
		const { state, agents, attacker } = declareBlockersSetup();
		const activeBlocker = spawnPermanent(state, "grizzly-bears", P1);

		expect(() =>
			perform(
				state,
				{
					kind: "declare blockers",
					player: P2,
					blockers: [{ blocker: activeBlocker.id, attacker: attacker.id }],
				},
				agents,
			),
		).toThrow(IllegalBlockDeclarationError);
		expect(permanent(state, activeBlocker.id).blocking).toBe(false);
	});

	test("rejects a noncreature permanent as a blocker", () => {
		const { state, agents, attacker } = declareBlockersSetup();
		const mantra = spawnPermanent(state, "ajanis-mantra", P2);

		expect(() =>
			perform(
				state,
				{
					kind: "declare blockers",
					player: P2,
					blockers: [{ blocker: mantra.id, attacker: attacker.id }],
				},
				agents,
			),
		).toThrow(IllegalBlockDeclarationError);
	});

	test("rejects a blocker assigned to multiple attackers atomically", () => {
		const { state, agents } = declareBlockersSetup();
		const alpha = spawnPermanent(state, "grizzly-bears", P1);
		const beta = spawnPermanent(state, "eager-cadet", P1);
		alpha.attacking = true;
		beta.attacking = true;
		const blocker = spawnPermanent(state, "grizzly-bears", P2);

		expect(() =>
			perform(
				state,
				{
					kind: "declare blockers",
					player: P2,
					blockers: [
						{ blocker: blocker.id, attacker: alpha.id },
						{ blocker: blocker.id, attacker: beta.id },
					],
				},
				agents,
			),
		).toThrow(IllegalBlockDeclarationError);
		expect(permanent(state, blocker.id).blocking, "no partial commit").toBe(
			false,
		);
	});

	test("rejects a blocker assigned to a creature that is not attacking", () => {
		const { state, agents } = declareBlockersSetup();
		const nonAttacker = spawnPermanent(state, "eager-cadet", P1);
		const blocker = spawnPermanent(state, "grizzly-bears", P2);

		expect(() =>
			perform(
				state,
				{
					kind: "declare blockers",
					player: P2,
					blockers: [{ blocker: blocker.id, attacker: nonAttacker.id }],
				},
				agents,
			),
		).toThrow(IllegalBlockDeclarationError);
	});

	test("rejects declaring blockers outside the declare blockers step", () => {
		const state = newGame();
		const agents: [Agent, Agent] = [new ScriptedAgent(), new ScriptedAgent()];
		const attacker = spawnPermanent(state, "grizzly-bears", P1);
		const blocker = spawnPermanent(state, "grizzly-bears", P2);

		expect(() =>
			perform(
				state,
				{
					kind: "declare blockers",
					player: P2,
					blockers: [{ blocker: blocker.id, attacker: attacker.id }],
				},
				agents,
			),
		).toThrow(IllegalBlockDeclarationError);
	});

	test("rejects a declaration from a player who isn't the defending player", () => {
		const { state, agents, attacker } = declareBlockersSetup();
		const blocker = spawnPermanent(state, "grizzly-bears", P2);

		expect(() =>
			perform(
				state,
				{
					kind: "declare blockers",
					player: P1,
					blockers: [{ blocker: blocker.id, attacker: attacker.id }],
				},
				agents,
			),
		).toThrow(IllegalBlockDeclarationError);
	});

	test("blocking clears at end combat", () => {
		const { state, agents, attacker } = declareBlockersSetup();
		const blocker = spawnPermanent(state, "grizzly-bears", P2, {
			counters: { "+1/+1": 1 },
		});
		perform(
			state,
			{
				kind: "declare blockers",
				player: P2,
				blockers: [{ blocker: blocker.id, attacker: attacker.id }],
			},
			agents,
		);
		expect(permanent(state, blocker.id).blocking).toBe(true);

		while (!isTurnStep(state, "end combat")) {
			advance(state, agents);
		}

		expect(
			permanent(state, blocker.id).blocking,
			"end combat clears blocking",
		).toBe(false);
		expect(permanent(state, blocker.id).tapped, "blocking never tapped").toBe(
			false,
		);
		expect(
			state.blockAssignments,
			"end combat clears block assignments",
		).toEqual([]);
	});
});
