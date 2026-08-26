import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCard } from "./parser.ts";

function* walkCards(dir: string): Generator<string> {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			yield* walkCards(path);
		} else if (entry.isFile() && entry.name.endsWith(".txt")) {
			yield path;
		}
	}
}

const vanilla = `
Name:Grizzly Bears
ManaCost:1 G
Types:Creature Bear
PT:2/2
Oracle:
`;

describe("parseCard", () => {
	test("parses characteristics used by the engine", () => {
		expect(parseCard(vanilla)).toEqual({
			id: "grizzly-bears",
			name: "Grizzly Bears",
			types: ["creature"],
			subtypes: ["Bear"],
			colors: ["g"],
			mv: 2,
			power: 2,
			toughness: 2,
		});

		expect(
			parseCard(`
Name:Forest
ManaCost:no cost
Types:Basic Land Forest
Oracle:({T}: Add {G}.)
`),
		).toEqual({
			id: "forest",
			name: "Forest",
			supertypes: ["basic"],
			types: ["land"],
			subtypes: ["Forest"],
			colors: [],
			mv: 0,
		});
	});

	test("parses the supported printed keywords", () => {
		expect(
			parseCard(`
Name:Platinum Angel
ManaCost:7
Types:Artifact Creature Angel
PT:4/4
K:Flying
Oracle:Flying
`)?.keywords,
		).toEqual(["flying"]);
	});

	test("parses fixed enters-with counters", () => {
		expect(
			parseCard(`
Name:Glen Elendra Guardian
ManaCost:2 U
Types:Creature Faerie Wizard
PT:3/4
K:Flash
K:Flying
K:etbCounter:M1M1:1
Oracle:Flash\\nFlying\\nThis creature enters with a -1/-1 counter on it.
`),
		).toBeNull();

		expect(
			parseCard(`
Name:Counter Bear
ManaCost:1 G
Types:Creature Bear
PT:2/2
K:etbCounter:P1P1:2
Oracle:This creature enters with two +1/+1 counters on it.
`)?.entersWith,
		).toEqual({ "+1/+1": 2 });
	});

	test("parses only the unconditional enters-tapped replacement", () => {
		expect(
			parseCard(`
Name:Slow Land
ManaCost:no cost
Types:Land
R:Event$ Moved | ValidCard$ Card.Self | Destination$ Battlefield | ReplacementResult$ Updated | ReplaceWith$ ETBTapped | Description$ CARDNAME enters tapped.
SVar:ETBTapped:DB$ Tap | Defined$ Self | ETB$ True
Oracle:Slow Land enters tapped.
`)?.entersTapped,
		).toBe(true);

		expect(
			parseCard(`
Name:Conditional Land
ManaCost:no cost
Types:Land
R:Event$ Moved | ValidCard$ Card.Self | Destination$ Battlefield | ReplacementResult$ Updated | ReplaceWith$ LandTapped | Description$ Conditional Land enters tapped unless you control a Forest.
SVar:LandTapped:DB$ Tap | Defined$ Self | ETB$ True | ConditionPresent$ Forest.YouCtrl
Oracle:Conditional Land enters tapped unless you control a Forest.
`),
		).toBeNull();
	});

	test("parses the supported upkeep and enters-the-battlefield triggers", () => {
		expect(
			parseCard(`
Name:Ajani's Mantra
ManaCost:1 W
Types:Enchantment
T:Mode$ Phase | Phase$ Upkeep | ValidPlayer$ You | TriggerZones$ Battlefield | Execute$ TrigGainLife | OptionalDecider$ You | TriggerDescription$ At the beginning of your upkeep, you may gain 1 life.
SVar:TrigGainLife:DB$ GainLife | Defined$ You | LifeAmount$ 1
Oracle:At the beginning of your upkeep, you may gain 1 life.
`)?.triggers,
		).toEqual([
			{
				id: "TrigGainLife",
				text: "At the beginning of your upkeep, you may gain 1 life.",
				condition: {
					kind: "beginStep",
					step: "upkeep",
					player: "controller",
				},
				optional: true,
				effects: [{ kind: "gainLife", player: "controller", amount: 1 }],
			},
		]);

		expect(
			parseCard(`
Name:Arashin Cleric
ManaCost:1 W
Types:Creature Human Cleric
PT:1/3
T:Mode$ ChangesZone | Origin$ Any | Destination$ Battlefield | ValidCard$ Card.Self | Execute$ TrigGainLife | TriggerDescription$ When CARDNAME enters, you gain 3 life.
SVar:TrigGainLife:DB$ GainLife | LifeAmount$ 3
Oracle:When Arashin Cleric enters, you gain 3 life.
`)?.triggers,
		).toEqual([
			{
				id: "TrigGainLife",
				text: "When CARDNAME enters, you gain 3 life.",
				condition: { kind: "entersBattlefield", object: "self" },
				effects: [{ kind: "gainLife", player: "controller", amount: 3 }],
			},
		]);
	});

	test("rejects unsupported rules instead of partially parsing the card", () => {
		const unsupported = [
			"K:Vigilance",
			"K:etbCounter:P1P1:X",
			"A:AB$ Draw | Cost$ 2",
			"T:Mode$ ChangesZone | Destination$ Graveyard | Execute$ TrigDraw",
			"S:Mode$ Continuous | AddPower$ 1",
			"K:Plot:1 U",
		];

		for (const rule of unsupported) {
			expect(
				parseCard(vanilla.replace("Oracle:", `${rule}\nOracle:`)),
			).toBeNull();
		}
	});

	test("rejects malformed or incomplete cards", () => {
		expect(parseCard("")).toBeNull();
		expect(parseCard(vanilla.replace("PT:2/2", "PT:*/2"))).toBeNull();
		expect(
			parseCard(vanilla.replace("ManaCost:1 G", "ManaCost:one G")),
		).toBeNull();
		expect(parseCard(vanilla.replace("Name:Grizzly Bears\n", ""))).toBeNull();
		expect(parseCard(`${vanilla}\nName:Other Bears`)).toBeNull();
	});
});

test("checks every card and accepts only the engine-supported subset", () => {
	const accepted: string[] = [];
	const EXPECTED_LEN = 574;

	for (const path of walkCards("./cards")) {
		const text = readFileSync(path, "utf-8");
		const card = parseCard(text);
		if (card === null) continue;

		accepted.push(card.name);
		expect(card.id).not.toBe("");
		expect(card.name).not.toBe("");
		expect(card.types.length).toBeGreaterThan(0);
	}
	if (accepted.length !== EXPECTED_LEN) console.log(accepted.join("\n"));
	// Locks the parser to the deliberately minimal subset. Increasing this count
	// requires adding engine support and a focused parser test first.
	expect(accepted).toHaveLength(EXPECTED_LEN);
});
