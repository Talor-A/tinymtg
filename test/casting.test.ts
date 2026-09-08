import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "../agents.ts";
import "../cards.ts";
import type {
	CastAction,
	GameState,
	ObjectId,
	PlayerId,
	PriorityAction,
} from "../index.ts";
import {
	abilityId,
	advance,
	executeAbilityAction,
	executeCastAction,
	getObservableActions,
	IllegalCastError,
	newGame,
	registerCard,
	settlePriority,
	spawnCard,
	spawnPermanent,
	turnLocation,
} from "../index.ts";
import {
	ALICE,
	advanceUntil,
	BOB,
	expectScriptConsumed,
	passingAgents,
} from "./utils/engine-helpers.ts";

/**
 * Forest is the only basic in the card set, so a white source is defined here
 * rather than registering a Plains as a side effect of writing tests.
 */
registerCard({
	id: "test-white-source",
	name: "Test White Source",
	types: ["land"],
	colors: [],
	manaCost: "none",
	activatedAbilities: [
		{
			kind: "mana",
			id: "intrinsic-mana-w",
			text: "Add {W}.",
			cost: { mana: "zero", tapSelf: true },
			effects: [
				{
					kind: "add-mana",
					player: "you",
					mana: { w: 1, u: 0, b: 0, r: 0, g: 0 },
				},
			],
		},
	],
});

const forestMana = abilityId("activated", "forest", 0);
const whiteMana = abilityId("activated", "test-white-source", 0);

function castAction(card: ObjectId): CastAction {
	return { kind: "cast", card };
}

function seedLibraries(state: GameState): void {
	for (let i = 0; i < 3; i++) {
		spawnCard(state, "forest", ALICE, "library");
		spawnCard(state, "forest", BOB, "library");
	}
}

/** A game advanced through the real scheduler to its first precombat main. */
function setupMain(): GameState {
	const state = newGame();
	seedLibraries(state);
	advanceUntil(state, passingAgents(), (next) => {
		const location = turnLocation(next);
		return location?.kind === "mainPhase" && location.role === "precombat";
	});
	return state;
}

/**
 * Taps each source for mana through the ordinary activation entry point, the
 * same one the priority loop calls. Nothing writes to `manaPool` directly:
 * a pool a real player could not have produced would not test pool-only
 * affordability at all.
 */
function tapForMana(
	state: GameState,
	player: PlayerId,
	sources: { id: ObjectId; ability: typeof forestMana }[],
): void {
	for (const { id, ability } of sources) {
		executeAbilityAction(
			state,
			player,
			{ kind: "activate ability", source: id, ability },
			passingAgents(),
		);
	}
}

function castActionsFor(state: GameState, player: PlayerId): CastAction[] {
	return getObservableActions(state, player).flatMap((action) =>
		action.kind === "cast" ? [action] : [],
	);
}

describe("cast actions offered at priority", () => {
	test("a spell is offered only once the pool can pay for it", () => {
		const state = setupMain();
		const bears = spawnCard(state, "grizzly-bears", ALICE, "hand");
		const first = spawnPermanent(state, "forest", ALICE);
		const second = spawnPermanent(state, "forest", ALICE);

		expect(castActionsFor(state, ALICE)).toEqual([]);

		// {1}{G} needs two mana; one Forest is not enough.
		tapForMana(state, ALICE, [{ id: first.id, ability: forestMana }]);
		expect(castActionsFor(state, ALICE)).toEqual([]);

		tapForMana(state, ALICE, [{ id: second.id, ability: forestMana }]);
		expect(castActionsFor(state, ALICE)).toEqual([castAction(bears.id)]);
	});

	test("colored requirements are not payable by the wrong color", () => {
		const state = setupMain();
		spawnCard(state, "faithful-watchdog", ALICE, "hand");
		const first = spawnPermanent(state, "forest", ALICE);
		const second = spawnPermanent(state, "forest", ALICE);

		// {G}{W} against two green: enough mana, wrong colors.
		tapForMana(state, ALICE, [
			{ id: first.id, ability: forestMana },
			{ id: second.id, ability: forestMana },
		]);
		expect(state.players[ALICE].manaPool.g).toBe(2);
		expect(castActionsFor(state, ALICE)).toEqual([]);
	});

	test("a zero-cost spell is offered with an empty pool", () => {
		const state = setupMain();
		const relic = spawnCard(state, "darksteel-relic", ALICE, "hand");

		expect(state.players[ALICE].manaPool).toMatchObject({ g: 0, c: 0 });
		expect(castActionsFor(state, ALICE)).toEqual([castAction(relic.id)]);
	});

	test("a land is played, never cast, even though it is in hand", () => {
		const state = setupMain();
		const forest = spawnCard(state, "forest", ALICE, "hand");

		expect(castActionsFor(state, ALICE)).toEqual([]);
		expect(getObservableActions(state, ALICE)).toContainEqual({
			kind: "play land",
			card: forest.id,
		});
	});

	test("a card in the opponent's hand is never offered to the caster", () => {
		const state = setupMain();
		const bobsRelic = spawnCard(state, "darksteel-relic", BOB, "hand");
		const alicesRelic = spawnCard(state, "darksteel-relic", ALICE, "hand");

		// Alice is the active player, so only she is at sorcery speed here; the
		// point is that Bob's card is absent from her menu, not that Bob has one.
		expect(castActionsFor(state, ALICE)).toEqual([castAction(alicesRelic.id)]);
		expect(castActionsFor(state, ALICE)).not.toContainEqual(
			castAction(bobsRelic.id),
		);
		// Bob is not the active player, so sorcery timing offers him nothing.
		expect(castActionsFor(state, BOB)).toEqual([]);
	});

	test("sorcery timing is enforced outside a main phase", () => {
		const state = setupMain();
		const relic = spawnCard(state, "darksteel-relic", ALICE, "hand");
		expect(castActionsFor(state, ALICE)).toEqual([castAction(relic.id)]);

		// Leaving the main phase closes the sorcery-speed window (CR 307.1).
		advanceUntil(state, passingAgents(), (next) => {
			const location = turnLocation(next);
			return location?.kind === "step" && location.step.kind === "begin combat";
		});
		expect(castActionsFor(state, ALICE)).toEqual([]);
	});

	test("two copies of a card produce two distinguishable actions", () => {
		const state = setupMain();
		const first = spawnCard(state, "darksteel-relic", ALICE, "hand");
		const second = spawnCard(state, "darksteel-relic", ALICE, "hand");

		const actions = castActionsFor(state, ALICE);
		expect(actions).toEqual([castAction(first.id), castAction(second.id)]);
		expect(first.id).not.toBe(second.id);
	});
});

describe("authoritative cast rejection", () => {
	/** Every rejection must leave canonical state byte-identical. */
	function expectAtomicRejection(
		state: GameState,
		player: PlayerId,
		action: CastAction,
	): void {
		const before = structuredClone(state);
		expect(() =>
			executeCastAction(state, player, action, passingAgents()),
		).toThrow(IllegalCastError);
		expect(state).toEqual(before);
	}

	test("an unaffordable spell leaves the pool and hand untouched", () => {
		const state = setupMain();
		const bears = spawnCard(state, "grizzly-bears", ALICE, "hand");
		const forest = spawnPermanent(state, "forest", ALICE);
		tapForMana(state, ALICE, [{ id: forest.id, ability: forestMana }]);

		expectAtomicRejection(state, ALICE, castAction(bears.id));
		// The single green mana is still floating: nothing was partially paid.
		expect(state.players[ALICE].manaPool.g).toBe(1);
		expect(state.players[ALICE].hand).toContain(bears.id);
	});

	test("rejects lands, no-cost cards, and cards outside the caster's hand", () => {
		const land = setupMain();
		const forest = spawnCard(land, "forest", ALICE, "hand");
		expectAtomicRejection(land, ALICE, castAction(forest.id));

		const opposing = setupMain();
		const bobsRelic = spawnCard(opposing, "darksteel-relic", BOB, "hand");
		expectAtomicRejection(opposing, ALICE, castAction(bobsRelic.id));

		const absent = setupMain();
		expectAtomicRejection(absent, ALICE, castAction(999 as ObjectId));

		const onBattlefield = setupMain();
		const relic = spawnPermanent(onBattlefield, "darksteel-relic", ALICE);
		expectAtomicRejection(onBattlefield, ALICE, castAction(relic.id));
	});

	test("rejects a sorcery-speed cast outside a turn", () => {
		const state = newGame();
		const relic = spawnCard(state, "darksteel-relic", ALICE, "hand");
		expectAtomicRejection(state, ALICE, castAction(relic.id));
	});
});

describe("casting onto the stack", () => {
	test("pays from the pool, moves to the stack, and keeps the card off the battlefield", () => {
		const state = setupMain();
		const bears = spawnCard(state, "grizzly-bears", ALICE, "hand");
		const first = spawnPermanent(state, "forest", ALICE);
		const second = spawnPermanent(state, "forest", ALICE);
		tapForMana(state, ALICE, [
			{ id: first.id, ability: forestMana },
			{ id: second.id, ability: forestMana },
		]);

		executeCastAction(state, ALICE, castAction(bears.id), passingAgents());

		expect(state.players[ALICE].manaPool.g).toBe(0);
		expect(state.players[ALICE].hand).not.toContain(bears.id);
		expect(state.stack).toHaveLength(1);

		// CR 400.7: the spell on the stack is a new object.
		const entry = state.stack[0];
		expect(entry?.kind).toBe("spell");
		if (entry?.kind !== "spell") throw new Error("expected a spell entry");
		expect(entry.objectId).not.toBe(bears.id);
		expect(state.objects.get(entry.objectId)).toMatchObject({
			kind: "spell",
			controller: ALICE,
		});
	});

	test("a permanent spell resolves onto the battlefield", () => {
		const state = setupMain();
		const relic = spawnCard(state, "darksteel-relic", ALICE, "hand");
		const caster = new ScriptedAgent([], [], [castAction(relic.id)]);

		settlePriority(state, [caster, new ScriptedAgent()]);

		expectScriptConsumed(caster);
		expect(state.stack).toHaveLength(0);
		const permanents = state.battlefield.map((id) => state.objects.get(id));
		expect(permanents).toHaveLength(1);
		expect(permanents[0]).toMatchObject({
			kind: "permanent",
			controller: ALICE,
		});
	});

	test("entry replacements apply through resolution", () => {
		const state = setupMain();
		const watchdog = spawnCard(state, "faithful-watchdog", ALICE, "hand");
		const forest = spawnPermanent(state, "forest", ALICE);
		const white = spawnPermanent(state, "test-white-source", ALICE);
		tapForMana(state, ALICE, [
			{ id: forest.id, ability: forestMana },
			{ id: white.id, ability: whiteMana },
		]);

		const caster = new ScriptedAgent([], [], [castAction(watchdog.id)]);
		settlePriority(state, [caster, new ScriptedAgent()]);
		expectScriptConsumed(caster);

		// Faithful Watchdog is a 0/0; without its three +1/+1 counters the
		// toughness SBA would have put it straight into the graveyard. Finding it
		// alive proves the entry replacement ran on the resolution path.
		const dog = state.battlefield
			.map((id) => state.objects.get(id))
			.find(
				(object) =>
					object?.kind === "permanent" &&
					object.representation.kind === "card" &&
					object.representation.cardId === "faithful-watchdog",
			);
		expect(dog).toMatchObject({ counters: { "+1/+1": 3 } });
		expect(state.players[ALICE].graveyard).toHaveLength(0);
	});

	test("the whole sequence runs through one priority window", () => {
		const state = setupMain();
		const bears = spawnCard(state, "grizzly-bears", ALICE, "hand");
		const first = spawnPermanent(state, "forest", ALICE);
		const second = spawnPermanent(state, "forest", ALICE);

		// Tapping and casting are all ordinary priority actions, so a single
		// scripted sequence drives the real loop end to end.
		const actions: PriorityAction[] = [
			{ kind: "activate ability", source: first.id, ability: forestMana },
			{ kind: "activate ability", source: second.id, ability: forestMana },
			castAction(bears.id),
		];
		const caster = new ScriptedAgent([], [], actions);

		settlePriority(state, [caster, new ScriptedAgent()]);

		expectScriptConsumed(caster);
		expect(state.players[ALICE].manaPool.g).toBe(0);
		expect(state.stack).toHaveLength(0);
		expect(state.objects.get(first.id)).toMatchObject({ tapped: true });
		expect(state.objects.get(second.id)).toMatchObject({ tapped: true });

		const bearsOnBattlefield = state.battlefield
			.map((id) => state.objects.get(id))
			.filter(
				(object) =>
					object?.kind === "permanent" &&
					object.representation.kind === "card" &&
					object.representation.cardId === "grizzly-bears",
			);
		expect(bearsOnBattlefield).toHaveLength(1);
	});

	test("mana left floating after casting empties as the phase ends", () => {
		const state = setupMain();
		const relic = spawnCard(state, "darksteel-relic", ALICE, "hand");
		const forest = spawnPermanent(state, "forest", ALICE);
		tapForMana(state, ALICE, [{ id: forest.id, ability: forestMana }]);

		// A zero-cost spell spends nothing, so the green mana survives the cast
		// and is emptied by the ordinary phase boundary instead (CR 500.4).
		executeCastAction(state, ALICE, castAction(relic.id), passingAgents());
		expect(state.players[ALICE].manaPool.g).toBe(1);

		advance(state, passingAgents());
		expect(state.players[ALICE].manaPool.g).toBe(0);
	});
});

describe("instant and sorcery resolution", () => {
	test("effects happen and the card is put into its owner's graveyard", () => {
		const state = setupMain();
		const revitalize = spawnCard(state, "revitalize", ALICE, "hand");
		const forest = spawnPermanent(state, "forest", ALICE);
		const white = spawnPermanent(state, "test-white-source", ALICE);
		tapForMana(state, ALICE, [
			{ id: forest.id, ability: forestMana },
			{ id: white.id, ability: whiteMana },
		]);
		const startingLife = state.players[ALICE].life;
		const startingHand = state.players[ALICE].hand.length;
		const startingLibrary = state.players[ALICE].library.length;

		const caster = new ScriptedAgent([], [], [castAction(revitalize.id)]);
		settlePriority(state, [caster, new ScriptedAgent()]);
		expectScriptConsumed(caster);

		// Revitalize: "You gain 3 life. Draw a card."
		expect(state.players[ALICE].life).toBe(startingLife + 3);
		expect(state.players[ALICE].library).toHaveLength(startingLibrary - 1);
		// The spell left hand and the draw replaced it, so the count is unchanged.
		expect(state.players[ALICE].hand).toHaveLength(startingHand);

		// CR 608.2m: the card goes to its owner's graveyard, not the battlefield.
		expect(state.stack).toHaveLength(0);
		expect(state.battlefield.map((id) => state.objects.get(id))).toHaveLength(
			2,
		);
		const graveyard = state.players[ALICE].graveyard.map((id) =>
			state.objects.get(id),
		);
		expect(graveyard).toHaveLength(1);
		expect(graveyard[0]).toMatchObject({
			kind: "card",
			zone: "graveyard",
			owner: ALICE,
		});
	});

	test("the spell is still on the stack while its own effects resolve", () => {
		const state = setupMain();
		spawnPermanent(state, "chains-of-mephistopheles", ALICE);
		const revitalize = spawnCard(state, "revitalize", ALICE, "hand");
		const forest = spawnPermanent(state, "forest", ALICE);
		const white = spawnPermanent(state, "test-white-source", ALICE);
		tapForMana(state, ALICE, [
			{ id: forest.id, ability: forestMana },
			{ id: white.id, ability: whiteMana },
		]);

		/**
		 * Chains of Mephistopheles replaces Revitalize's draw with a discard,
		 * which asks the caster to pick a card. That question is asked partway
		 * through Revitalize's own effects, so the view handed to the agent is a
		 * direct observation of the game mid-resolution.
		 */
		const stackDuringOwnEffects: number[] = [];
		class ObservingAgent extends ScriptedAgent {
			override choose(
				view: Parameters<ScriptedAgent["choose"]>[0],
				request: Parameters<ScriptedAgent["choose"]>[1],
			) {
				if (request.kind === "ownHand")
					stackDuringOwnEffects.push(view.stack.length);
				return super.choose(view, request);
			}
		}
		const caster = new ObservingAgent([], [], [castAction(revitalize.id)]);
		settlePriority(state, [caster, new ScriptedAgent()]);
		expectScriptConsumed(caster);

		// CR 608.2m: the card is put into the graveyard only as the last step of
		// resolution, so it is still on the stack while its instructions run.
		expect(stackDuringOwnEffects).toEqual([1]);
		expect(state.stack).toHaveLength(0);
		expect(state.players[ALICE].graveyard).not.toHaveLength(0);
	});

	test("an instant resolves during the opponent's turn", () => {
		const state = newGame();
		seedLibraries(state);
		advanceUntil(state, passingAgents(), (next) => {
			const location = turnLocation(next);
			return location?.kind === "mainPhase" && location.role === "precombat";
		});
		// Alice is active on turn one, so Bob casting here proves an instant is
		// not bound by sorcery timing (CR 601.3).
		const revitalize = spawnCard(state, "revitalize", BOB, "hand");
		const forest = spawnPermanent(state, "forest", BOB);
		const white = spawnPermanent(state, "test-white-source", BOB);
		tapForMana(state, BOB, [
			{ id: forest.id, ability: forestMana },
			{ id: white.id, ability: whiteMana },
		]);
		const startingLife = state.players[BOB].life;

		const caster = new ScriptedAgent([], [], [castAction(revitalize.id)]);
		settlePriority(state, [new ScriptedAgent(), caster]);
		expectScriptConsumed(caster);

		expect(state.players[BOB].life).toBe(startingLife + 3);
		expect(state.players[BOB].graveyard).toHaveLength(1);
	});
});
