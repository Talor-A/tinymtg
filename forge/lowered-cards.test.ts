/**
 * lowered-cards.test.ts — pins what the importer lowers a card INTO.
 *
 * `accepted-cards.test.ts` snapshots the names of every card the importer
 * accepts, which answers "did this card import?" and nothing else. That is not
 * enough on its own: the importer used to lower any word it did not recognise
 * into a predicate no object could satisfy, so a card could sit in the
 * accepted list for years with an ability that could never do anything. Reki,
 * the History of Kamigawa read `ValidCard$ Legendary` as a subtype named
 * "Legendary", so "whenever you cast a legendary spell" compiled to a trigger
 * that could not fire, and the name-only snapshot said it was fine.
 *
 * This snapshot is the whole lowered definition of a handful of cards, one per
 * construct the importer supports. A change to any lowering path shows up as a
 * diff here, with the before and after side by side, so a reviewer sees what
 * the cards now mean rather than only which ones still parse.
 *
 * Each card is here for a reason, written next to it. Add a card when a
 * construct has no coverage, not to raise the count: the value of this file is
 * that a diff in it is worth reading.
 *
 * One blind spot to know about: a static ability's selector and a continuous
 * effect's modification both lower to closures, so they serialize as nothing
 * but their layer. A snapshot here cannot show which objects a static
 * affects. `test/static-selector-alternatives.test.ts` covers that by asking
 * the engine what a static actually did.
 *
 * Regenerate after a deliberate change:
 *
 *     bun test --update-snapshots forge/lowered-cards.test.ts
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { importForgeCard } from "./import.ts";

const CORPUS_ROOT = join(import.meta.dir, "..", "cards", "cardsfolder");

/**
 * One fixture per construct. The comment is the construct, so a reviewer
 * reading a diff knows which lowering path it belongs to.
 */
const FIXTURES: readonly (readonly [path: string, construct: string])[] = [
	// A vanilla creature: types, mana cost, and power/toughness alone.
	["g/grizzly_bears", "printed characteristics only"],
	// A targeted damage spell, the most common spell shape in the corpus.
	["l/lightning_bolt", "spell with an any-target"],
	// Counterspell targets a spell rather than a permanent or player.
	["c/counterspell", "spell targeting a spell on the stack"],
	// Wrath of God destroys every creature, with no target at all.
	["w/wrath_of_god", "untargeted mass effect"],
	// Day of Judgment is Wrath of God without regeneration, so the pair pins
	// that two near-identical scripts stay distinguishable.
	["d/day_of_judgment", "untargeted mass effect, no regeneration clause"],
	// A subtype restriction on a target: `ValidTgts$ Creature.Human`. This is
	// the positive direction of the selector vocabulary.
	["h/human_frailty", "target restricted by subtype"],
	// A supertype restriction reached through Forge's `!` negation:
	// `ChangeType$ Card.!Legendary`, searching for a nonlegendary card.
	["u/unmarked_grave", "library search, negated supertype"],
	// The card whose trigger silently could not fire: `ValidCard$ Legendary`
	// is a supertype, and reading it as a subtype made the ability inert.
	["r/reki_the_history_of_kamigawa", "spell-cast trigger, supertype filter"],
	// A repeatable activated ability with a tap cost and a discard.
	["m/merfolk_looter", "activated ability, tap cost"],
	// Pinger: an activated ability that deals damage to a chosen target.
	["p/prodigal_sorcerer", "activated ability with a target"],
	// A dies trigger whose selector negates the token property with `!token`.
	["j/judith_the_scourge_diva", "zone-change trigger, negated modifier"],
	// A creature-type search driven by a keyword operand, `TypeCycling:Wizard`.
	["v/vedalken_aethermage", "typecycling, subtype search"],
	// Basic landcycling: the same keyword with Forge's `Basic` spelling, which
	// means a supertype-and-type pair rather than a subtype.
	["a/ash_barrens", "basic landcycling, plus a mana ability"],
	// A fetch land: an activated ability that sacrifices its own source and
	// puts a searched card onto the battlefield tapped.
	["w/wooded_foothills", "sacrifice-self search, enters tapped"],
	// A token-property target, the unnegated form of Judith's restriction.
	["d/dogged_hunter", "target restricted to tokens"],
	// A tapped-state restriction: `ValidTgts$ Creature.tapped`.
	["a/assassinate", "target restricted by tapped state"],
	// Both numeric predicates at once: `Creature.powerEQ1+toughnessEQ1` is
	// Forge's spelling of "target 1/1 creature".
	["a/aegis_of_the_meek", "target restricted by power and toughness"],
	// A selector whose alternatives span creature and noncreature types, so
	// the power comparison is asked of objects that have no power (CR 208.3).
	["e/exorcise", "mixed-type target with a power comparison"],
	// A continuous static gated on a board count: "as long as you control
	// seven or more lands". The condition itself is a closure and so invisible
	// here -- see `test/static-presence-condition.test.ts` -- but the layers
	// and the text are not.
	["g/gigantoad", "continuous static with a presence condition"],
];

for (const [path, construct] of FIXTURES) {
	test(`${path} lowers as ${construct}`, () => {
		const filename = path.split("/").at(-1);
		if (filename === undefined) throw new Error(`bad fixture path ${path}`);
		const result = importForgeCard(
			readFileSync(join(CORPUS_ROOT, `${path}.txt`), "utf8"),
			{ id: filename.replaceAll("_", "-") },
		);
		// A fixture is chosen because it lowers; a rejection is a regression in
		// itself, and reports better here than as an unreadable snapshot diff.
		if (!result.ok)
			throw new Error(
				`expected ${path} to import, got ${result.diagnostics
					.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
					.join("; ")}`,
			);
		expect(result.card).toMatchSnapshot(path);
	});
}
