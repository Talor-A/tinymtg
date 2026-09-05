# tinymtg

A small Magic: The Gathering rules engine.

## Setup

```bash
bun install
bun run index.ts
```

## Verify

```bash
bun run check       # typecheck and test
bun run fix         # autofix all files
```

## Advancing a game

`advance()` executes one synchronous scheduler transition and mutates the supplied state. It accepts only synchronous agents:

```ts
advance(state, [new ScriptedAgent(), new RandomAgent()]);
```

`advanceWithReplay()` is the safe entry point for agents that may return promises. It treats the supplied state as an immutable checkpoint, runs each attempt against a clone, and returns the authoritative advanced state:

```ts
const result = await advanceWithReplay(checkpoint, agents);
checkpoint = result.state;
```

If an answer is not immediately available, the engine unwinds, awaits it outside the synchronous rules engine, records it, and replays that single scheduler transition. Earlier choices are read from the transcript instead of invoking their agents again.

A `ChoiceTranscript` belongs to one checkpoint and one call to `advanceWithReplay()`. It is JSON-serializable, but replay verifies fingerprints and may reject transcripts after engine or request-schema changes. `attempts` is diagnostic: it is one plus the number of suspended choices encountered while completing the transition.

Low-level callers handling `ChoicePendingError` themselves must discard the speculative state before replay. Prefer `advanceWithReplay()` unless implementing durable scheduling or persistence.

## Forge card import

Card import is deliberately split into two boundaries:

```text
raw Forge .txt -> ForgeCardIR v2 (static JSON) -> OracleCardDef / CardDef
```

- `parseForgeCard(text)` parses and normalizes Forge syntax into a versioned,
  callback-free representation with rigid discriminated unions.
- `validateForgeCardIR(value)` strictly validates data read back from JSON,
  including unknown properties.
- `compileForgeCard(ir)` lowers validated data into engine definitions and
  creates callbacks for supported continuous and replacement effects.
- `parseCardDetailed(text)` returns both representations and structured
  diagnostics; `parseCard(text)` remains the compatibility API and returns
  `null` for unsupported input.

The initial subset covers characteristics, the existing keywords and triggers,
fixed enters-tapped/counter rules, fixed P/T continuous effects, simple
life/draw effects, single-target damage/destroy/P/T effects, tap abilities, and
fixed colored tap-for-mana abilities. Card definitions, imported IR, stack
items, and resolution share one canonical serializable effect model; optional
simple sequences are represented by one `may` effect containing its children. Basic-land mana abilities are synthesized
from their subtype because Forge omits explicit `A:` lines for them.

Card definitions retain targeted spells, activated abilities, and mana production.
Runtime support covers fixed tap-for-mana abilities, casting from hand, and the
single-target spell subset described below. Other imported definitions can
require runtime features that the engine does not support.
The importer rejects unsupported or dynamic Forge syntax.

## Current gameplay boundary

Normal progression through `advance()` currently supports:

- turn, phase, and step scheduling;
- untapping, the normal draw, and cleanup discarding;
- priority passing and one ordinary land play from the active player's hand during either main phase while the stack is empty;
- fixed tap-for-mana abilities and mana pools;
- casting from hand with mana already in the pool, including supported single-target instants and sorceries;
- the supported gain-life triggers, including parsed self-attack triggers (e.g. Herald of Faith);
- declaring attackers, and unblocked two-player combat damage; and
- replacement, prohibition, and state-based effects encountered by those events.

### Declaring attackers

The declare-attackers step asks the active player once for a replayable subset
of eligible creatures and commits it atomically:

- this is deliberately a two-player-only engine, so the defending player is
  always the other player — there is no `AttackTarget` or defending-player
  state;
- every creature the active player controls is treated as if it had haste, so
  any untapped controlled creature is eligible regardless of how long it has
  been under that control (no summoning-sickness or continuous-control
  tracking);
- selected attackers become tapped and `attacking` until end of combat, when
  `attacking` (and `blocking`) is cleared on every permanent;
- an illegal declaration (wrong step, wrong player, duplicate IDs, or an
  ineligible ID) throws `IllegalAttackDeclarationError` and changes nothing.

Attack restrictions, requirements, and costs, vigilance and other keyword
interactions, blockers, and non-player defenders (e.g. planeswalkers,
battles) are not implemented.

### Combat damage

At the combat damage turn-based action, every permanent still on the
battlefield with `attacking === true` deals damage equal to its current
`view()` power to the opposing player — this is a two-player-only engine, so
the attacker's controller's opponent is always the recipient. Damage is
snapshotted for all still-attacking permanents in battlefield order before
any of it is dealt (approximating CR 510.2's simultaneous assignment) and
then each instance flows through the normal per-source event pipeline, so
replacement effects (e.g. Furnace of Rath doubling it), prevention,
redirection, and lifelink all apply exactly as they do for any other damage
event. A permanent that stops attacking or leaves the battlefield before this
turn-based action (destroyed, regenerated, etc.) deals no damage; tapped
status at damage time does not prevent it. Zero or negative power deals no
damage.

Blockers, damage assignment order and choices, first/double strike, trample,
infect, deathtouch, attacking a specific target (planeswalkers, battles, or
any non-player defender), and multiple combat damage steps are not
implemented — every still-attacking creature is unconditionally treated as
unblocked and hits the defending player once.

### Playing a land

During either precombat or postcombat main phase, the active player's priority choices include each land in their hand while the stack is empty and they have not already played a land that turn. Selecting one is a special action: it moves the identified card through the normal zone-change replacement and trigger pipeline, increments `landsPlayed`, and leaves priority with that player. The ordinary allowance resets when that player's next turn begins.

This slice intentionally supports only one ordinary land from hand per turn. Modified allowances, playing from alternate zones, and effects granting special timing are not implemented. Invalid or stale land actions are rejected before action-specific state changes.

Deck construction, opening hands, mulligans, and non-mana activated abilities are not implemented yet.

### Targeted spells

The agent first chooses a spell, then answers a separate `target` request.
The engine checks that choice before payment or zone movement. A spell with
no legal required target is absent from the priority options.

The runtime supports one required target: a creature, a player, or an
`any-target` recipient. Murder and Lightning Bolt exercise the creature and
`any-target` paths. Planeswalker damage raises an assertion because the engine
does not support planeswalkers yet. Battles are outside the card-type model.

The stack entry stores the target slot and chosen reference. Both players can
see this binding. Before resolution, the engine checks the target against its
current characteristics. If the target is illegal, the spell does nothing and
moves to its owner's graveyard. A permanent that leaves and returns has a new
object ID and does not remain the target.

Damage and destruction use the existing event pipeline, including replacement
effects and indestructible. Mana abilities must run before casting. Payment
still precedes the move to the stack.

Additional target restrictions, including Doom Blade's color restriction and
hexproof, remain deferred. Multiple or optional targets, ability targets,
stack/graveyard targets, and temporary P/T effects also remain deferred.
Unsupported target selectors and temporary P/T spell effects raise assertions
before payment. Target-choice requests use the same replay protocol as other
agent choices.

`perform()` injects a rules event directly, and `settlePriority()` resolves the current priority window directly. They are useful for focused rules tests and integrations, but do not represent player actions supported by the normal gameplay loop.
