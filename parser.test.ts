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

	test("parses the real Herald of Faith fixture, including its attack trigger", () => {
		// Validates the parser against the real Forge fixture, not a hand-written
		// stand-in. Do not edit cards/cardsfolder/h/herald_of_faith.txt for this.
		const text = readFileSync(
			"./cards/cardsfolder/h/herald_of_faith.txt",
			"utf-8",
		);
		const herald = parseCard(text);
		if (!herald) {
			throw new Error("Failed to parse herald_of_faith.txt fixture");
		}
		expect(herald.id).toBe("herald-of-faith");
		expect(herald.name).toBe("Herald of Faith");
		expect(herald.types).toEqual(["creature"]);
		expect(herald.subtypes).toEqual(["Angel"]);
		expect(herald.colors).toEqual(["w"]);
		expect(herald.mv).toBe(5);
		expect(herald.power).toBe(4);
		expect(herald.toughness).toBe(3);
		expect(herald.keywords).toEqual(["flying"]);
		expect(herald.triggers).toEqual([
			{
				id: "TrigGainLife",
				text: "Whenever CARDNAME attacks, you gain 2 life.",
				condition: { kind: "declaredAttacker", object: "self" },
				effects: [{ kind: "gainLife", player: "controller", amount: 2 }],
			},
		]);
	});

	test("rejects an Attacks trigger that isn't Card.Self or has unknown fields", () => {
		const herald = `
Name:Test Herald
ManaCost:3 W W
Types:Creature Angel
PT:4/3
K:Flying
T:Mode$ Attacks | ValidCard$ Card.Self | Execute$ TrigGainLife | TriggerDescription$ Whenever CARDNAME attacks, you gain 2 life.
SVar:TrigGainLife:DB$ GainLife | Defined$ You | LifeAmount$ 2
Oracle:Flying\\nWhenever Test Herald attacks, you gain 2 life.
`;
		expect(parseCard(herald)?.triggers).toEqual([
			{
				id: "TrigGainLife",
				text: "Whenever CARDNAME attacks, you gain 2 life.",
				condition: { kind: "declaredAttacker", object: "self" },
				effects: [{ kind: "gainLife", player: "controller", amount: 2 }],
			},
		]);

		expect(
			parseCard(
				herald.replace("ValidCard$ Card.Self", "ValidCard$ Creature.Other"),
			),
			"non-self ValidCard is out of scope (no attacker/defender tracking)",
		).toBeNull();

		expect(
			parseCard(
				herald.replace(
					"TriggerDescription$",
					"TriggerZones$ Battlefield | TriggerDescription$",
				),
			),
			"unknown fields on an Attacks trigger are rejected, not ignored",
		).toBeNull();
	});

	test("SVar:HasAttackEffect:TRUE alone does not make a card parse", () => {
		// This UI-only metadata is only ever accepted alongside a real self
		// declared-attacker trigger it actually describes; on its own, an unused
		// SVar still rejects the card like any other unexplained SVar.
		const withoutAttackTrigger = `
Name:Test Herald
ManaCost:3 W W
Types:Creature Angel
PT:4/3
K:Flying
SVar:HasAttackEffect:TRUE
Oracle:Flying
`;
		expect(parseCard(withoutAttackTrigger)).toBeNull();
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
	// 574 (baseline) + Herald of Faith (the parsed Attacks/gainLife fixture this
	// slice targets) + Moonrise Cleric (an unrelated card the same narrow shape
	// happens to fully cover: Creature, Flying, one self-attack gain-life
	// trigger with no other rules text).
	const EXPECTED_LEN = 576;

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
