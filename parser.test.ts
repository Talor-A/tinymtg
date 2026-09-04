import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	createReadContext,
	newGame,
	readObject,
	registerCard,
	resolveStaticAbility,
	spawnPermanent,
	staticAbilityId,
	view,
} from "./index.ts";
import {
	compileForgeCard,
	parseCard,
	parseCardDetailed,
	parseForgeCard,
	validateForgeCardIR,
} from "./parser.ts";

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
			manaCost: {
				g: 1,
				c: 1,
			},
			power: 2,
			toughness: 2,
			abilityDefinitions: {
				static: [],
				activated: [],
				triggered: [],
				replacement: [],
				prohibition: [],
			},
			printedAbilities: {
				static: [],
				activated: [],
				triggered: [],
				replacement: [],
				prohibition: [],
			},
		});

		const forest = parseCard(`
Name:Forest
ManaCost:no cost
Types:Basic Land Forest
Oracle:({T}: Add {G}.)
`);
		expect(forest).toMatchObject({
			id: "forest",
			name: "Forest",
			supertypes: ["basic"],
			types: ["land"],
			subtypes: ["Forest"],
			colors: [],
			manaCost: "none",
		});
		expect(forest?.abilityDefinitions.activated).toEqual([
			{
				kind: "mana",
				id: "intrinsic-mana-g",
				text: "Add {G}.",
				costs: [{ kind: "tap-self" }],
				effects: [
					{
						kind: "add-mana",
						player: "you",
						mana: { w: 0, u: 0, b: 0, r: 0, g: 1 },
					},
				],
			},
		]);
	});

	test("parses colored, generic, zero, and absent mana costs", () => {
		const cardWithCost = (manaCost: string) =>
			parseCard(vanilla.replace("ManaCost:1 G", `ManaCost:${manaCost}`));

		expect(cardWithCost("2 W W")?.manaCost).toEqual({ c: 2, w: 2 });
		expect(cardWithCost("W U")?.manaCost).toEqual({ w: 1, u: 1 });
		expect(cardWithCost("3")?.manaCost).toEqual({ c: 3 });
		expect(cardWithCost("0")?.manaCost).toBe("zero");
		expect(cardWithCost("no cost")?.manaCost).toBe("none");
	});

	test("rejects mana symbols the engine cannot represent faithfully", () => {
		for (const manaCost of ["X G", "WU", "2/W", "WP", "C", "S"]) {
			expect(
				parseCard(vanilla.replace("ManaCost:1 G", `ManaCost:${manaCost}`)),
				manaCost,
			).toBeNull();
		}
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
`)?.abilityDefinitions.triggered,
		).toEqual([
			{
				id: "TrigGainLife",
				text: "At the beginning of your upkeep, you may gain 1 life.",
				condition: {
					kind: "begin step",
					step: "upkeep",
					player: "you",
				},
				effects: [
					{
						kind: "may",
						decider: "you",
						effects: [{ kind: "gain-life", player: "you", amount: 1 }],
					},
				],
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
`)?.abilityDefinitions.triggered,
		).toEqual([
			{
				id: "TrigGainLife",
				text: "When CARDNAME enters, you gain 3 life.",
				condition: {
					kind: "change zone",
					from: "any",
					to: "battlefield",
					selector: "self",
				},
				effects: [{ kind: "gain-life", player: "you", amount: 3 }],
			},
		]);
	});

	test("models one optional choice around a simple effect sequence", () => {
		const parsed = parseCard(`
Name:Optional Sequence
ManaCost:1 W
Types:Enchantment
T:Mode$ Phase | Phase$ Upkeep | ValidPlayer$ You | TriggerZones$ Battlefield | Execute$ TrigLife | OptionalDecider$ You | TriggerDescription$ At the beginning of your upkeep, you may gain 2 life and draw a card.
SVar:TrigLife:DB$ GainLife | Defined$ You | LifeAmount$ 2 | SubAbility$ DBDraw
SVar:DBDraw:DB$ Draw | Defined$ You | NumCards$ 1
Oracle:At the beginning of your upkeep, you may gain 2 life and draw a card.
`);
		expect(parsed?.abilityDefinitions.triggered?.[0]?.effects).toEqual([
			{
				kind: "may",
				decider: "you",
				effects: [
					{ kind: "gain-life", player: "you", amount: 2 },
					{ kind: "draw", player: "you", amount: 1 },
				],
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
		expect(herald.manaCost).toEqual({ w: 2, c: 3 });
		expect(herald.power).toBe(4);
		expect(herald.toughness).toBe(3);
		expect(herald.keywords).toEqual(["flying"]);
		expect(herald.abilityDefinitions.triggered).toEqual([
			{
				id: "TrigGainLife",
				text: "Whenever CARDNAME attacks, you gain 2 life.",
				condition: { kind: "declare attackers", selector: "self" },
				effects: [{ kind: "gain-life", player: "you", amount: 2 }],
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
		expect(parseCard(herald)?.abilityDefinitions.triggered).toEqual([
			{
				id: "TrigGainLife",
				text: "Whenever CARDNAME attacks, you gain 2 life.",
				condition: { kind: "declare attackers", selector: "self" },
				effects: [{ kind: "gain-life", player: "you", amount: 2 }],
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

describe("structured Forge pipeline", () => {
	const fixture = (name: string) =>
		readFileSync(`./cards/cardsfolder/${name[0]}/${name}.txt`, "utf-8");

	test("emits a rigid JSON-round-trippable representation", () => {
		const parsed = parseForgeCard(vanilla);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value).toEqual({
			schemaVersion: 2,
			id: "grizzly-bears",
			name: "Grizzly Bears",
			supertypes: [],
			types: ["creature"],
			subtypes: ["Bear"],
			colors: ["g"],
			manaCost: {
				kind: "symbols",
				generic: 1,
				w: 0,
				u: 0,
				b: 0,
				r: 0,
				g: 1,
			},
			power: 2,
			toughness: 2,
			keywords: [],
			rules: [],
		});
		const json = JSON.parse(JSON.stringify(parsed.value));
		expect(validateForgeCardIR(json)).toEqual({
			ok: true,
			value: parsed.value,
			diagnostics: [],
		});
	});

	test("separates normalized target definitions from compiled cards", () => {
		const cases = [
			["murder", "destroy", "permanent"],
			["giant_growth", "modify-pt", "permanent"],
			["lightning_bolt", "damage", "any-target"],
		] as const;
		for (const [name, effectKind, targetKind] of cases) {
			const detailed = parseCardDetailed(fixture(name));
			expect(detailed.ok, name).toBe(true);
			if (!detailed.ok) continue;
			const spell = detailed.value.ir.rules.find(
				(rule) => rule.kind === "spell",
			);
			expect(spell?.targets[0]?.legal.kind).toBe(targetKind);
			expect(spell?.effects[0]?.kind).toBe(effectKind);
			expect(detailed.value.card.spell).toEqual(
				spell && {
					id: spell.id,
					text: spell.text,
					targets: spell.targets,
					effects: spell.effects,
				},
			);
		}
	});

	test("parses targeted tap abilities and explicit mana abilities", () => {
		const prodigal = parseCard(fixture("prodigal_sorcerer"));
		expect(prodigal?.abilityDefinitions.activated?.[0]).toMatchObject({
			kind: "activated",
			costs: [{ kind: "tap-self" }],
			targets: [{ id: "target-1", legal: { kind: "any-target" } }],
			effects: [{ kind: "damage", target: "target-1", amount: 1 }],
		});
		const elves = parseCard(fixture("llanowar_elves"));
		expect(elves?.abilityDefinitions.activated?.[0]).toMatchObject({
			kind: "mana",
			costs: [{ kind: "tap-self" }],
			effects: [
				{
					kind: "add-mana",
					mana: { w: 0, u: 0, b: 0, r: 0, g: 1 },
				},
			],
		});
	});

	test("compiles simple permanent statics into callbacks", () => {
		const parsed = parseForgeCard(fixture("glorious_anthem"));
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const compiled = compileForgeCard(parsed.value);
		expect(compiled.ok).toBe(true);
		if (!compiled.ok) return;
		expect(compiled.value.abilityDefinitions.static).toHaveLength(1);
		registerCard(compiled.value);
		expect(String(staticAbilityId("glorious-anthem", 0))).toBe(
			"glorious-anthem:0",
		);
		const compiledStatic = compiled.value.abilityDefinitions.static?.[0];
		expect(compiledStatic).toBeDefined();
		if (!compiledStatic) return;
		expect(resolveStaticAbility(staticAbilityId("glorious-anthem", 0))).toBe(
			compiledStatic,
		);
		const game = newGame();
		spawnPermanent(game, "glorious-anthem", 0);
		const yourCreature = spawnPermanent(game, "grizzly-bears", 0);
		const opposingCreature = spawnPermanent(game, "grizzly-bears", 1);
		const creatureSnapshot = readObject(
			createReadContext(game),
			yourCreature.id,
		);
		expect(creatureSnapshot.kind).toBe("permanent");
		expect(view(game, yourCreature.id).power).toBe(3);
		expect(view(game, yourCreature.id).toughness).toBe(3);
		expect(view(game, opposingCreature.id).power).toBe(2);
		expect(view(game, opposingCreature.id).toughness).toBe(2);
		expect(parsed.value.rules[0]).toEqual({
			kind: "static",
			id: "static-1",
			text: "Creatures you control get +1/+1.",
			selector: {
				kind: "all",
				selectors: [
					{ kind: "type", type: "creature" },
					{ kind: "controller", player: "you" },
				],
			},
			modification: { kind: "modify-pt", power: 1, toughness: 1 },
		});
	});

	test("uses the canonical effect model for targetless spells", () => {
		const revitalize = parseCard(fixture("revitalize"));
		expect(revitalize?.spell).toMatchObject({
			targets: [],
			effects: [
				{ kind: "gain-life", player: "you", amount: 3 },
				{ kind: "draw", player: "you", amount: 1 },
			],
		});
		expect("effects" in (revitalize ?? {})).toBe(false);
	});

	test("grants intrinsic mana abilities for nonbasic lands with basic land types", () => {
		const dryadArbor = parseCard(
			readFileSync("./cards/cardsfolder/d/dryad_arbor.txt", "utf-8"),
		);
		expect(dryadArbor?.abilityDefinitions.activated).toContainEqual({
			kind: "mana",
			id: "intrinsic-mana-g",
			text: "Add {G}.",
			costs: [{ kind: "tap-self" }],
			effects: [
				{
					kind: "add-mana",
					player: "you",
					mana: { w: 0, u: 0, b: 0, r: 0, g: 1 },
				},
			],
		});
	});

	test("rejects syntax that would otherwise lose costs or independent targets", () => {
		for (const path of [
			"./cards/cardsfolder/i/into_the_maw_of_hell.txt",
			"./cards/cardsfolder/e/eye_of_vecna.txt",
			"./cards/cardsfolder/r/reckless_abandon.txt",
		]) {
			expect(parseCard(readFileSync(path, "utf-8")), path).toBeNull();
		}
	});

	test("rejects target unions that cannot be represented faithfully", () => {
		expect(
			parseCard(`
Name:Bad Target
ManaCost:R
Types:Instant
A:SP$ DealDamage | ValidTgts$ Player,Planeswalker | NumDmg$ 1 | SpellDescription$ Deal 1 damage to target player or planeswalker.
Oracle:Deal 1 damage to target player or planeswalker.
`),
		).toBeNull();
	});

	test("strict validation rejects unknown JSON properties", () => {
		const parsed = parseForgeCard(vanilla);
		if (!parsed.ok) throw new Error("fixture did not parse");
		const invalid = { ...parsed.value, extra: true };
		const validated = validateForgeCardIR(invalid);
		expect(validated.ok).toBe(false);
		if (!validated.ok) expect(validated.diagnostics[0]?.path).toBe("$.extra");
	});

	test("strict validation rejects targets on mana abilities", () => {
		const parsed = parseForgeCard(fixture("llanowar_elves"));
		if (!parsed.ok) throw new Error("fixture did not parse");
		const invalid = structuredClone(parsed.value) as unknown as {
			rules: Record<string, unknown>[];
		};
		const mana = invalid.rules.find((rule) => rule.kind === "mana");
		if (!mana) throw new Error("fixture has no mana ability");
		mana.targets = [
			{
				id: "illegal-target",
				min: 1,
				max: 1,
				legal: { kind: "player" },
			},
		];

		const validated = validateForgeCardIR(invalid);
		expect(validated.ok).toBe(false);
		if (!validated.ok)
			expect(validated.diagnostics).toContainEqual(
				expect.objectContaining({
					path: expect.stringMatching(/\.targets$/),
					message: "unknown property",
				}),
			);
	});
});

test("checks every card and accepts only the engine-supported subset", () => {
	const accepted: string[] = [];

	for (const path of walkCards("./cards")) {
		const text = readFileSync(path, "utf-8");
		const card = parseCard(text);
		if (card === null) continue;

		accepted.push(card.name);
		expect(card.id).not.toBe("");
		expect(card.name).not.toBe("");
		expect(card.types.length).toBeGreaterThan(0);
	}
	expect(accepted.sort((a, b) => a.localeCompare(b))).toMatchSnapshot();
});
