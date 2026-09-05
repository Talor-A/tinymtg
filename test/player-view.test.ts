import { describe, expect, test } from "bun:test";
import { ScriptedAgent } from "../agents.ts";
import "../cards.ts";
import {
  abilityId,
  buildPlayerView,
  newGame,
  type PlayerBattlefieldObjectView,
  type PlayerExileObjectView,
  type PlayerGraveyardObjectView,
  type PlayerHandObjectView,
  type PlayerObjectView,
  type PlayerStackView,
  perform,
  type StackItemId,
  spawnCard,
  spawnPermanent,
} from "../index.ts";

function assertExactPlayerViewTypes(
  hand: PlayerHandObjectView,
  battlefield: PlayerBattlefieldObjectView,
  graveyard: PlayerGraveyardObjectView,
  exile: PlayerExileObjectView,
  object: PlayerObjectView,
): void {
  const handZone: "hand" = hand.zone;
  const battlefieldKind: "permanent" = battlefield.kind;
  const graveyardZone: "graveyard" = graveyard.zone;
  const exileZone: "exile" = exile.zone;
  void [handZone, battlefieldKind, graveyardZone, exileZone];

  // @ts-expect-error Permanents cannot be stack entries.
  const invalidStack: PlayerStackView = battlefield;
  // @ts-expect-error Graveyard objects cannot appear in hand.
  const invalidHand: PlayerHandObjectView = graveyard;
  // @ts-expect-error The broad object union is not an exact stack view.
  const invalidBroadStack: PlayerStackView = object;
  void [invalidStack, invalidHand, invalidBroadStack];
}

void assertExactPlayerViewTypes;

function collectObjectIds(
  value: unknown,
  ids = new Set<number>(),
): Set<number> {
  if (Array.isArray(value)) {
    for (const entry of value) collectObjectIds(entry, ids);
    return ids;
  }
  if (!value || typeof value !== "object") return ids;
  for (const [key, entry] of Object.entries(value)) {
    if (key === "objectId" && typeof entry === "number") ids.add(entry);
    collectObjectIds(entry, ids);
  }
  return ids;
}

function expectJsonSafe(value: unknown): void {
  expect(value).not.toBeInstanceOf(Map);
  expect(value).not.toBeInstanceOf(Set);
  expect(typeof value).not.toBe("function");
  expect(typeof value).not.toBe("bigint");
  if (Array.isArray(value)) {
    for (const entry of value) expectJsonSafe(entry);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const entry of Object.values(value)) expectJsonSafe(entry);
}

describe("player views", () => {
  test("show each viewer only their hand and no library identities", () => {
    const state = newGame();
    const p0Hand = spawnCard(state, "forest", 0, "hand");
    const p1Hand = spawnCard(state, "clone", 1, "hand");
    const p0Library = spawnCard(state, "doubling-season", 0, "library");
    const p1Library = spawnCard(state, "hardened-scales", 1, "library");

    const p0 = buildPlayerView(state, 0);
    const p1 = buildPlayerView(state, 1);

    expect(p0.hand.map((object) => object.objectId)).toEqual([p0Hand.id]);
    expect(p1.hand.map((object) => object.objectId)).toEqual([p1Hand.id]);
    expect(p0.players.map((player) => player.handCount)).toEqual([1, 1]);
    expect(p0.players.map((player) => player.libraryCount)).toEqual([1, 1]);

    const p0VisibleIds = collectObjectIds(p0);
    expect(p0VisibleIds.has(p1Hand.id)).toBe(false);
    expect(p0VisibleIds.has(p0Library.id)).toBe(false);
    expect(p0VisibleIds.has(p1Library.id)).toBe(false);
    const p1VisibleIds = collectObjectIds(p1);
    expect(p1VisibleIds.has(p0Hand.id)).toBe(false);
    expect(p1VisibleIds.has(p0Library.id)).toBe(false);
    expect(p1VisibleIds.has(p1Library.id)).toBe(false);

    expect(JSON.stringify(p0)).not.toContain("clone");
    expect(JSON.stringify(p0)).not.toContain("doubling-season");
    expect(JSON.stringify(p0)).not.toContain("hardened-scales");
    expect(JSON.stringify(p1)).not.toContain("forest");
  });

  test("includes both boards and every public zone with derived values", () => {
    const state = newGame();
    state.players[0].manaPool.g = 2;
    state.players[0].manaPool.c = 3;
    state.players[1].manaPool.u = 1;
    const mine = spawnPermanent(state, "grizzly-bears", 0, {
      counters: { "+1/+1": 1 },
    });
    const theirs = spawnPermanent(state, "eager-cadet", 1);
    const graveyard = spawnCard(state, "clone", 0, "graveyard");
    const exile = spawnCard(state, "forest", 1, "exile");
    const stackId = state.nextStackItemId++ as StackItemId;
    state.stack.push({
      id: stackId,
      kind: "triggered ability",
      source: mine.id,
      triggerId: abilityId("triggered", "ajanis-mantra", 0),
      controller: 0,
      text: "gain 1 life",
      effects: [{ kind: "gain-life", player: "you", amount: 1 }],
    });
    state.revision++;

    const view = buildPlayerView(state, 0);

    expect(view.battlefield.map((object) => object.objectId)).toEqual([
      mine.id,
      theirs.id,
    ]);
    const mineView = view.battlefield[0];
    expect(mineView?.kind).toBe("permanent");
    if (mineView?.kind !== "permanent") throw new Error("expected permanent");
    expect(mineView.currentCharacteristics).toMatchObject({
      kind: "creature",
      power: 3,
      toughness: 3,
    });
    expect(view.players[0].graveyard[0]?.objectId).toBe(graveyard.id);
    expect(view.players[1].exile[0]?.objectId).toBe(exile.id);
    expect(view.players.map((player) => player.manaPool)).toEqual([
      { w: 0, u: 0, b: 0, r: 0, g: 2, c: 3 },
      { w: 0, u: 1, b: 0, r: 0, g: 0, c: 0 },
    ]);
    expect(view.stack).toEqual([
      expect.objectContaining({ id: stackId, kind: "ability" }),
    ]);
  });

  test("is JSON-safe and detached from state and later views", () => {
    const state = newGame();
    const card = spawnCard(state, "forest", 0, "hand");
    const view = buildPlayerView(state, 0);

    expectJsonSafe(view);
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);

    const mutable = view as unknown as {
      hand: { currentCharacteristics: { name: string } }[];
      players: [
        { life: number; manaPool: { g: number } },
        { life: number; manaPool: { g: number } },
      ];
    };
    const mutableCard = mutable.hand[0];
    if (!mutableCard) throw new Error("expected a card in hand");
    expect(() => {
      mutableCard.currentCharacteristics.name = "tampered";
    }).toThrow(TypeError);
    expect(() => {
      mutable.players[0].life = 1;
    }).toThrow(TypeError);
    expect(() => {
      mutable.players[0].manaPool.g = 1;
    }).toThrow(TypeError);
    expect(buildPlayerView(state, 0)).toBe(view);
    spawnCard(state, "clone", 0, "hand");

    const fresh = buildPlayerView(state, 0);
    expect(view.hand).toHaveLength(1);
    expect(fresh.hand).toHaveLength(2);
    expect(fresh.players[0].life).toBe(20);
    expect(
      fresh.hand.find((object) => object.objectId === card.id)
        ?.currentCharacteristics.name,
    ).toBe("Forest");
  });

  test("projects the exact spell-or-ability stack union", () => {
    const state = newGame();
    const spellCard = spawnCard(state, "grizzly-bears", 0, "hand");
    perform(
      state,
      {
        kind: "change zone",
        object: spellCard.id,
        from: "hand",
        to: "stack",
        cause: "cast",
        toController: 0,
      },
      [new ScriptedAgent(), new ScriptedAgent()],
    );
    const source = spawnPermanent(state, "ajanis-mantra", 0);
    state.stack.push({
      id: state.nextStackItemId++ as StackItemId,
      kind: "triggered ability",
      source: source.id,
      triggerId: abilityId("triggered", "ajanis-mantra", 0),
      controller: 0,
      text: "gain 1 life",
      effects: [{ kind: "gain-life", player: "you", amount: 1 }],
    });
    state.revision++;

    const view = buildPlayerView(state, 0);
    expect(view.stack.map((entry) => entry.kind)).toEqual([
      "spell",
      "triggered ability",
    ]);
    const spell = view.stack[0];
    expect(spell?.kind).toBe("spell");
    if (spell?.kind !== "spell") throw new Error("expected spell stack view");
    expect(typeof spell.objectId).toBe("number");
    expect(spell.zone).toBe("stack");
    expect(() => structuredClone(state)).not.toThrow();
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);
  });
});
