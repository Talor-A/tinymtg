/**
 * accepted-cards.test.ts — pins which Forge cards the importer accepts today.
 *
 * The snapshot in `__snapshots__/accepted-cards.test.ts.snap` is the display
 * name of every card in `cards/cardsfolder` that `importForgeCard` lowers
 * successfully. It is a progress marker, not a specification: widening the
 * supported subset is expected to add lines, and the diff on the snapshot is
 * the review-visible record of exactly which cards a change bought or lost.
 *
 * A name here says the card imported, and nothing about what it imported as:
 * a card whose ability lowered to something that can never do anything still
 * appears. `lowered-cards.test.ts` snapshots whole definitions for a handful
 * of cards to cover that, and the two files are meant to be read together.
 *
 * Regenerate after a deliberate change:
 *
 *     bun test --update-snapshots forge/accepted-cards.test.ts
 */

import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { importForgeCard } from "./import.ts";

const CORPUS_ROOT = join(import.meta.dir, "..", "cards", "cardsfolder");

function corpusFiles(): string[] {
	const files: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir).sort()) {
			const path = join(dir, entry);
			if (statSync(path).isDirectory()) walk(path);
			else if (path.endsWith(".txt")) files.push(path);
		}
	};
	walk(CORPUS_ROOT);
	return files;
}

/**
 * Imports every corpus card under the same id convention `corpus.ts` uses, and
 * returns the accepted cards' names sorted by code unit, so the list order does
 * not depend on the corpus directory layout.
 */
function acceptedCardNames(): string[] {
	const names: string[] = [];
	for (const path of corpusFiles()) {
		const filename = path.split("/").at(-1);
		if (filename === undefined) throw new Error(`bad corpus path ${path}`);
		const id = filename.replace(/\.txt$/, "").replaceAll("_", "-");
		const result = importForgeCard(readFileSync(path, "utf8"), { id });
		if (result.ok) names.push(result.card.name);
	}
	return names.sort();
}

test("the accepted-card list matches its snapshot", () => {
	const files = corpusFiles();
	expect(files.length).toBeGreaterThan(1000);

	const accepted = acceptedCardNames();
	// Names, not ids: two corpus files sharing a display name would make the
	// snapshot ambiguous, so pin that they do not.
	expect(new Set(accepted).size).toBe(accepted.length);

	// One newline-joined string rather than an array, so the snapshot file is
	// a plain list of card names instead of a quoted, comma-separated dump.
	expect(accepted.join("\n")).toMatchSnapshot("accepted card names");
	expect(accepted.length).toMatchSnapshot("accepted card count");
}, 120_000);
