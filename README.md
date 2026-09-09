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

Forge card text and its AST (`forge-ast.ts`) are external, Forge-owned input.
`forge-import.ts` is the one strict bridge from that input to engine-owned,
executable `CardDef`s:

```text
external Forge text
  -> parseForgeCardScript(text).card       Forge-owned syntax and references
  -> lowerForgeCard(ast, { id })           supported semantic subset
  -> CardDefInput -> defineCard(input)     engine-owned definitions
  -> registerCard(definition)              explicit caller action
```

- `importForgeCard(text, { id })` composes parsing and lowering.
- `lowerForgeCard(ast, { id })` lowers an already-parsed `ForgeCardAst`.

Both return an `ImportResult`: either `{ ok: true, card, diagnostics }` or
`{ ok: false, diagnostics }`. Neither function registers a card or touches game
state, and a rejected card exposes no partially-usable `CardDef` — `ok: false`
carries only diagnostics (stable codes such as `UNSUPPORTED_FACE`,
`UNSUPPORTED_PARAMETER`, `UNSUPPORTED_COST`, `UNSUPPORTED_TARGET`,
`UNSUPPORTED_EFFECT`, `UNSUPPORTED_KEYWORD`, `UNSUPPORTED_REFERENCE`). The
caller supplies the registry id explicitly; the bridge never guesses identity
from a card's display name.

`CardDef` is a runtime registry object whose statics/replacements close over
validated, normalized data (selectors, constants) rather than the source AST
or a live game object — see `test/forge-import.test.ts` for a callback
independence check. It is not a serializable persistence format: reconstruct
the same registry when restoring a game, and preserve card ids, definition
ordering, and importer/corpus revision together with any external snapshot.

Forge is an external superset of what this engine implements. A successful
import means every gameplay instruction on that card is accounted for within
this engine's declared rules subset — not full Magic rules compliance, and not
a claim that every Forge card, construct, or syntactically valid input is
accepted. A recognized keyword is never silently dropped: every root `A`, `T`,
`R`, `S`, and `K` rule on a card either lowers or the whole card is rejected.

The current subset covers: literal characteristics (name, mana cost, types,
colors, P/T); the keywords Deathtouch, Flying, Reach, Defender, Lifelink,
Indestructible, Vigilance, and Trample, plus `Bushido:N`, which the engine
compiles into a blocks-or-becomes-blocked trigger the way it already does
Prowess;
literal entry-counter shorthand and both canonical enters-tapped `R:` forms —
the self form (`ValidCard$ Card.Self`, e.g. Charcoal Diamond) lowers directly
to `CardDefInput.entersTapped`, and the global form (a supported selector
scoped by `ActiveZones$ Battlefield`, e.g. Root Maze) lowers to a registered
replacement, honoring CR 614.12's own-entry guard; the graveyard-to-exile `R:` form (`Origin$ Battlefield |
Destination$ Graveyard` with a `ReplaceWith$` body that moves `ReplacedCard`
to exile, e.g. Samurai of the Pale Curtain), which does apply to its own
source; the exact optional Clone
form (`K:ETBReplacement:Copy:DBCopy:Optional` with `DB$ Clone | Choices$
Creature.Other`) lowers to a replay-safe, non-targeting choice; basic-land mana abilities
are synthesized from subtype (Forge omits explicit `A:` lines for those); mana
abilities producing fixed mana, including colorless (`Produced$ C`, e.g.
Wastes), modal one-mana choices between two or more distinct fixed symbols
(`Produced$ Combo U R`, e.g. Temple of Epiphany), and the five colored choices
encoded by `Produced$ Any`; token scripts with supported activated
abilities, mana (Treasure) or not (Food, Blood), are rehosted on the importing card
so created tokens retain executable abilities without mutating the registry
during import; activated abilities whose
costs contain fixed generic/WUBRG mana,
optional tap-self (`Cost$ 3 T`, e.g. Rod of Ruin), an optional discard of one
card of any kind (`Discard<1/Card>`, e.g. Rummaging Goblin and the Blood
token), whose card is chosen while the ability is announced and which cannot
be paid from an empty hand, and an optional
single-permanent sacrifice, including `Creature.Other` to exclude the source,
semicolon-separated alternatives, and `CARDNAME` for the source itself (e.g.
Viscera Seer, Blazing Hellhound, and Acolyte of Aclazotz), with
life/draw/discard-one-chosen-card, scry, surveil, and fixed hidden `Dig` forms
such as Sleight of Hand, Impulse, and Stock Up, which put a card-defined
number into hand (defaulting Forge's omitted `ChangeNum$` to one) and order the
rest on the bottom; the unmodified `Investigate` effect, which creates one
canonical Clue token for the ability's controller; damage, destroy, counter,
one-permanent sacrifice for a relative or targeted player, targeted or
self-directed fixed counter placement (including Forge's omitted `Defined$`
default for a nontargeted permanent ability), and return-to-hand effects; spells,
activated abilities, and triggered abilities with at most one required target
(`Any`, `Player`, `Opponent`, a spell (`ValidTgts$ Card | TargetType$ Spell`), or a
`ValidTgts$` selector whose base is a card type, a subtype, `Card`, or
`Permanent`, followed by `YouCtrl`, `OppCtrl`, or a color, card type, or
supertype word that may carry Forge's `non` prefix; the exact target form
`Creature.Other+YouCtrl` is also supported — so it and `Creature.nonBlack` lower, while
`Creature.attacking` does not); simple self-entry,
upkeep, self-attack, card-drawn, and bushido's blocks-or-becomes-blocked
triggers, including one optional (`may`) wrapper around
a trigger's whole (possibly multi-step) effect sequence; fixed temporary P/T
changes; temporary `KW$ Indestructible` grants; and fixed controlled-creature
P/T statics. See the acceptance matrix in `forge/import.test.ts` for the exact
fixtures this is checked against, and
the "Deferred / explicitly unsupported" list at the top of `forge-import.ts`
for what is intentionally out of scope (other `Dig` forms, including dynamic
amounts and non-bottom dispositions; `Investigate` with an explicit count or
player; random/multi-card discard, alternate costs, hexproof/shroud/protection,
and more).

The engine's own selector vocabulary is wider than the spellings the bridge
accepts: `ObjectSelectorDef` covers the source itself, card type, supertype,
subtype, color, and controller, combined with all/any/not to any depth. A
hand-written card definition can use all of it.

`forge/accepted-cards.test.ts` snapshots the display name of every card in
`cards/cardsfolder` that the bridge currently lowers — 2,708 of 33,664 — so the
diff on `forge/__snapshots__/accepted-cards.test.ts.snap` is how a change to the
supported subset reports what it bought or lost. Regenerate it with
`bun test --update-snapshots forge/accepted-cards.test.ts`.

`test/utils/engine-helpers.ts`'s `registerCardFixture(cardsfolderPath)` reads
a real card from `cards/cardsfolder`, imports it through this bridge, and
registers the result — so a card whose printed definition no longer lowers
fails the tests that depend on it, rather than silently drifting.

## Current gameplay boundary

Normal progression through `advance()` currently supports:

- turn, phase, and step scheduling;
- untapping, the normal draw, and cleanup discarding;
- priority passing and one ordinary land play from the active player's hand during either main phase while the stack is empty;
- fixed tap-for-mana abilities and mana pools;
- casting from hand with mana already in the pool, including supported single-target instants and sorceries;
- activated abilities with fixed generic/WUBRG mana, optional tap-self, and optional single-permanent sacrifice costs, with or without a target;
- relative-player and targeted-player sacrifice effects in which that player chooses one matching permanent;
- the supported gain-life triggers, including parsed self-attack triggers (e.g. Herald of Faith), and targeted triggers (e.g. Flametongue Kavu, Manic Vandal);
- declaring attackers, blockers, and two-player combat damage, including trample; and
- replacement, prohibition, and state-based effects encountered by those events.

### Declaring attackers

The declare-attackers step asks the active player once for a replayable subset
of eligible creatures and commits it atomically:

- this is deliberately a two-player-only engine, so the defending player is
  always the other player — there is no `AttackTarget` or defending-player
  state;
- an untapped creature the active player controls is eligible if it does not
  have defender and either began its controller's turn under their control or
  has haste;
- selected attackers become tapped and `attacking` until end of combat, when
  `attacking` (and `blocking`) is cleared on every permanent;
- an illegal declaration (wrong step, wrong player, duplicate IDs, or an
  ineligible ID) throws `IllegalAttackDeclarationError` and changes nothing.

Other attack restrictions, requirements, and costs, and non-player defenders
(e.g. planeswalkers and battles) are not implemented. The defending player may
assign each untapped creature they control to at most one attacker, with multiple
blockers allowed on one attacker. Aesthir Glider's unconditional self
restriction changes blocker eligibility. A creature with flying can be blocked
only by a creature with flying or reach. Other blocking requirements, costs,
and evasion abilities are not implemented.

### Combat damage

At the combat damage turn-based action, each unblocked attacker deals its
current derived power to the opposing player. A blocked attacker assigns lethal
damage to its remaining blockers in declaration order. Without trample, it
assigns any remainder to the final blocker; with trample, it assigns that
remainder to the defending player. Each blocker
deals its power to the attacker it blocks. Damage is snapshotted before any of
it is dealt (approximating CR 510.2's simultaneous assignment), and then each
instance flows through the normal per-source event pipeline, so
replacement effects (e.g. Furnace of Rath doubling it), prevention,
redirection, and lifelink all apply exactly as they do for any other damage
event. A permanent that stops attacking or leaves the battlefield before this
turn-based action (destroyed, regenerated, etc.) deals no damage; tapped
status at damage time does not prevent it. Zero or negative power deals no
damage.

Interactive damage-assignment choices, first/double strike, infect, attacking a
specific target (planeswalkers, battles, or any non-player
defender), and multiple combat damage steps are not implemented.

### Playing a land

During either precombat or postcombat main phase, the active player's priority choices include each land in their hand while the stack is empty and their current land-play allowance is not exhausted. Selecting one is a special action: it moves the identified card through the normal zone-change replacement and trigger pipeline, increments `landsPlayed`, and leaves priority with that player. The usage count resets when that player's next turn begins.

The allowance starts at one and includes finite positive additions from battlefield static abilities affecting their source's current controller, such as Exploration and Azusa, Lost but Seeking. These additions are derived from current ability possession and source control rather than stored on the player. Temporary adjustments such as Explore and Summer Bloom, unlimited allowances such as Fastbond, conditional or negative adjustments, playing from alternate zones, and effects granting special timing are not implemented. Invalid or stale land actions are rejected before action-specific state changes.

Sacrifice effects and costs currently support one permanent at a time. Multiple
and optional sacrifices are not implemented. A spell can have one additional
cost that sacrifices a creature. Deck construction, opening hands, mulligans,
and alternative activation costs are also not implemented yet.

### Targeting

Spells, activated abilities, and triggered abilities may each declare at most
one required target. A target is a player, a spell, or a permanent matching a
restriction built from card type, supertype, subtype, color, controller, and
the source itself, combined with all/any/not. `any-target` accepts a player, a
creature, or a planeswalker. Restrictions are always evaluated against current
characteristics, so a permanent that changes color, type, or controller can
stop being a legal target.

A spell or activated ability with no legal target is absent from the priority
options, and executing one directly is rejected. The agent answers a separate
`target` request whose context says whether a spell, an activated ability, or a
triggered ability is being announced. The engine rechecks the answer, and the
whole announcement fails before any cost is paid if it is not legal.

A triggered ability's targets are chosen when it is put on the stack, not when
the event that triggered it happened (CR 603.3d). The active player's triggers
go on the stack first, so the non-active player orders and targets with those
items and their targets already visible. A trigger with no legal target is
removed instead of being put on the stack.

The stack entry stores the target slot and chosen reference, and both players
can see the binding. Before resolution, the engine rechecks the target. If it
is illegal, nothing the spell or ability would do happens, including its
untargeted effects (CR 608.2b); a spell also moves to its owner's graveyard. A
permanent that leaves and returns has a new object ID and does not remain the
target.

An ability's source leaving does not invalidate the ability (CR 113.7a).
**Last known information is currently an approximation:** waiting abilities
retain only the source's controller, colors, and lifelink at departure.
Damage effects use the live source when present and this limited snapshot
otherwise. This is not a full implementation of CR 608.2h. A follow-up should
use the engine's characteristic snapshot types before adding effects that
need other information about a departed source.

Damage and destruction use the existing event pipeline, including replacement
effects and indestructible. Planeswalker damage raises an assertion because the
engine does not support planeswalkers yet. Battles are outside the card-type
model. Mana abilities must run before casting, and payment still precedes the
move to the stack.

Multiple or optional targets, non-spell stack targets, and graveyard targets
remain deferred, as do hexproof, shroud, and protection: those are not in the
`Keyword` union, so no target is ever illegal because of them and the importer
rejects cards that have them. Unsupported target declarations raise assertions
before payment. Target-choice requests use the same replay protocol as other
agent choices.

`perform()` injects a rules event directly, and `settlePriority()` resolves the current priority window directly. They are useful for focused rules tests and integrations, but do not represent player actions supported by the normal gameplay loop.
