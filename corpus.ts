/**
 * corpus.ts — loads cards straight out of the vendored Forge corpus.
 *
 * The card database is being migrated off hand-authored definitions and onto
 * `cards/cardsfolder`, so every card that the importer already lowers is
 * loaded from its real Forge script rather than transcribed by hand. A card
 * loaded this way is exactly what `forge/import.ts` produces; there
 * is no engine-side patching of the result.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { importForgeCard } from "./forge/import.ts";
import type { CardDef } from "./index.ts";

const CORPUS_ROOT = join(import.meta.dir, "cards", "cardsfolder");

/**
 * Loads `cards/cardsfolder/<cardsfolderPath>.txt`. The card id is the
 * corpus filename with underscores turned into dashes, so `g/grizzly_bears`
 * registers as `grizzly-bears`.
 *
 * Throws on a card the importer rejects: a caller asking for a card by path
 * wants that card, and a silently missing registration would surface much
 * later as an `unknown card` at spawn time.
 */
export function loadCardFixture(cardsfolderPath: string): CardDef {
	const text = readFileSync(
		join(CORPUS_ROOT, `${cardsfolderPath}.txt`),
		"utf8",
	);
	const filename = cardsfolderPath.split("/").at(-1);
	if (!filename)
		throw new Error(`invalid card fixture path ${cardsfolderPath}`);
	const id = filename.replaceAll("_", "-");
	const result = importForgeCard(text, { id });
	if (!result.ok)
		throw new Error(
			`unsupported card fixture ${cardsfolderPath}: ${result.diagnostics
				.map((d) => `${d.code}: ${d.message}`)
				.join("; ")}`,
		);
	return result.card;
}
