import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { name, newGame, spawnCard } from "../index.ts";
import { parseForgeCardScript } from "./ast.ts";
import { importForgeCard, lowerForgeCard } from "./import.ts";

const CORPUS_ROOT = join(import.meta.dir, "..", "cards", "cardsfolder");

function cardText(path: string): string {
	return readFileSync(join(CORPUS_ROOT, `${path}.txt`), "utf8");
}

function idFor(path: string): string {
	const filename = path.split("/").at(-1);
	if (!filename) throw new Error(`bad path ${path}`);
	return filename.replaceAll("_", "-");
}

function importFixture(path: string) {
	return importForgeCard(cardText(path), { id: idFor(path) });
}

/* ------------------------------------------------------------------------- */
/* The required positive matrix (plan "Concrete acceptance matrix")          */
/* ------------------------------------------------------------------------- */

const POSITIVE_FIXTURES = [
	"g/grizzly_bears",
	"f/forest",
	"s/swamp",
	"l/llanowar_elves",
	"d/darksteel_relic",
	"d/darksteel_myr",
	"r/rhox_war_monk",
	"l/lightning_bolt",
	"m/murder",
	"r/revitalize",
	"p/preordain",
	"s/sorins_thirst",
	"a/arashin_cleric",
	"a/ajanis_mantra",
	"n/necrogen_mists",
	"s/seizan_perverter_of_truth",
	"h/herald_of_faith",
	"g/glorious_anthem",
	"e/exploration",
	"a/azusa_lost_but_seeking",
	"a/aesthir_glider",
	"r/root_maze",
	"c/charcoal_diamond",
	"d/diregraf_ghoul",
	"r/raging_goblin",
	"f/faithful_watchdog",
	"s/soulmender",
	"m/merfolk_looter",
	"d/doom_blade",
	"p/prodigal_sorcerer",
	"r/rod_of_ruin",
	"f/flametongue_kavu",
	"m/manic_vandal",
	"t/timeless_lotus",
	"w/wastes",
	"v/viscera_seer",
	"b/blazing_hellhound",
	"a/acolyte_of_aclazotz",
];

describe("lowerForgeCard: positive acceptance matrix", () => {
	for (const fixture of POSITIVE_FIXTURES) {
		test(`imports ${fixture}`, () => {
			const result = importFixture(fixture);
			expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(
				true,
			);
			if (!result.ok) return;
			expect(result.card.id).toBe(idFor(fixture));
		});
	}

	test("Grizzly Bears has literal characteristics and no rules", () => {
		const result = importFixture("g/grizzly_bears");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card).toMatchObject({
			name: "Grizzly Bears",
			types: ["creature"],
			subtypes: ["Bear"],
			manaCost: { n: 1, g: 1 },
			power: 2,
			toughness: 2,
		});
		expect(result.card.abilityDefinitions.activated).toHaveLength(0);
		expect(result.card.abilityDefinitions.triggered).toHaveLength(0);
	});

	test("{C} in a mana cost is colorless, not generic", () => {
		// Reality Smasher costs {4}{C}: four generic plus one true colorless.
		const result = importForgeCard(
			"Name:Test Eldrazi\nManaCost:4 C\nTypes:Creature Eldrazi\nPT:5/5\nOracle:\n",
			{ id: "test-eldrazi" },
		);
		if (!result.ok) throw new Error("expected ok");
		expect(result.card.manaCost).toEqual({ c: 1, n: 4 });
		// A colorless requirement is not a color: the card is still colorless.
		expect(result.card.colors).toEqual([]);
	});

	test("hybrid colorless symbols are still rejected", () => {
		const result = importForgeCard(
			"Name:Test Hybrid\nManaCost:CW\nTypes:Creature Eldrazi\nPT:1/1\nOracle:\n",
			{ id: "test-hybrid" },
		);
		expect(result.ok).toBe(false);
	});

	test("Produced$ W U is one ability with one fixed W/U effect", () => {
		const result = importText(
			"Name:Fixed WU Probe\nManaCost:2\nTypes:Artifact\nA:AB$ Mana | Cost$ T | Produced$ W U | SpellDescription$ Add {W}{U}.\nOracle:\n",
		);
		if (!result.ok) throw new Error("expected ok");
		expect(result.card.abilityDefinitions.activated).toEqual([
			{
				kind: "mana",
				id: "activated-1",
				text: "Add {W}{U}.",
				cost: { mana: "zero", tapSelf: true },
				effects: [
					{
						kind: "add-mana",
						player: "you",
						mana: { w: 1, u: 1, b: 0, r: 0, g: 0, c: 0 },
					},
				],
			},
		]);
	});

	test("imports the checked-in Timeless Lotus fixed list without modal choices", () => {
		// Timeless Lotus's checked-in definition says `Produced$ W U B R G`.
		const result = importFixture("t/timeless_lotus");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card.abilityDefinitions.activated).toEqual([
			{
				kind: "mana",
				id: "activated-1",
				text: "Add {W}{U}{B}{R}{G}.",
				cost: { mana: "zero", tapSelf: true },
				effects: [
					{
						kind: "add-mana",
						player: "you",
						mana: { w: 1, u: 1, b: 1, r: 1, g: 1, c: 0 },
					},
				],
			},
		]);
	});

	test("Produced$ C lowers to colorless mana", () => {
		const result = importFixture("w/wastes");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card.colors).toEqual([]);
		expect(result.card.abilityDefinitions.activated).toEqual([
			{
				kind: "mana",
				id: "activated-1",
				text: "Add {C}.",
				cost: { mana: "zero", tapSelf: true },
				effects: [
					{
						kind: "add-mana",
						player: "you",
						mana: { w: 0, u: 0, b: 0, r: 0, g: 0, c: 1 },
					},
				],
			},
		]);
	});

	test("Forest and Swamp synthesize their basic-land mana ability", () => {
		for (const [fixture, color] of [
			["f/forest", "g"],
			["s/swamp", "b"],
		] as const) {
			const result = importFixture(fixture);
			if (!result.ok) throw new Error("expected ok");
			expect(result.card.manaCost).toBe("none");
			expect(result.card.abilityDefinitions.activated).toEqual([
				{
					kind: "mana",
					id: expect.stringContaining("intrinsic-mana"),
					text: expect.any(String),
					cost: { mana: "zero", tapSelf: true },
					effects: [
						{
							kind: "add-mana",
							player: "you",
							mana: expect.objectContaining({ [color]: 1 }),
						},
					],
				},
			]);
		}
	});

	test("Llanowar Elves lowers to an immediate tap-for-G mana ability", () => {
		const result = importFixture("l/llanowar_elves");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card.abilityDefinitions.activated).toEqual([
			{
				kind: "mana",
				id: "activated-1",
				text: expect.any(String),
				cost: { mana: "zero", tapSelf: true },
				effects: [
					{
						kind: "add-mana",
						player: "you",
						mana: expect.objectContaining({ g: 1 }),
					},
				],
			},
		]);
	});

	test("Lightning Bolt and Murder lower a single required target slot", () => {
		const bolt = importFixture("l/lightning_bolt");
		if (!bolt.ok) throw new Error("expected ok");
		expect(bolt.card.spell).toMatchObject({
			targets: [
				{ id: "target-1", min: 1, max: 1, legal: { kind: "any-target" } },
			],
			effects: [{ kind: "damage", targetSlot: "target-1", amount: 3 }],
		});

		const murder = importFixture("m/murder");
		if (!murder.ok) throw new Error("expected ok");
		expect(murder.card.spell).toMatchObject({
			targets: [
				{
					id: "target-1",
					min: 1,
					max: 1,
					legal: {
						kind: "permanent",
						selector: { kind: "type", type: "creature" },
					},
				},
			],
			effects: [{ kind: "destroy", targetSlot: "target-1" }],
		});
	});

	test("Doom Blade lowers its nonblack restriction as a selector", () => {
		const result = importFixture("d/doom_blade");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card.spell?.targets).toEqual([
			{
				id: "target-1",
				min: 1,
				max: 1,
				legal: {
					kind: "permanent",
					selector: {
						kind: "all",
						selectors: [
							{ kind: "type", type: "creature" },
							{ kind: "not", selector: { kind: "color", color: "b" } },
						],
					},
				},
			},
		]);
	});

	test("activation costs preserve mana-only, tap-only, and mana-plus-tap components", () => {
		const manaOnly = importForgeCard(
			"Name:Mana Cost Probe\nManaCost:2\nTypes:Artifact\nA:AB$ GainLife | Cost$ 2 U U 3 | Defined$ You | LifeAmount$ 1 | SpellDescription$ You gain 1 life.\nOracle:\n",
			{ id: "mana-cost-probe" },
		);
		if (!manaOnly.ok) throw new Error("expected ok");
		expect(manaOnly.card.abilityDefinitions.activated[0]?.cost).toEqual({
			mana: { n: 5, u: 2 },
			tapSelf: false,
		});

		const tapOnly = importFixture("p/prodigal_sorcerer");
		if (!tapOnly.ok) throw new Error("expected ok");
		expect(tapOnly.card.abilityDefinitions.activated).toEqual([
			{
				kind: "activated",
				id: "activated-1",
				text: "CARDNAME deals 1 damage to any target.",
				cost: { mana: "zero", tapSelf: true },
				targets: [
					{ id: "target-1", min: 1, max: 1, legal: { kind: "any-target" } },
				],
				effects: [{ kind: "damage", targetSlot: "target-1", amount: 1 }],
			},
		]);

		const combined = importFixture("r/rod_of_ruin");
		if (!combined.ok) throw new Error("expected ok");
		expect(combined.card.abilityDefinitions.activated[0]?.cost).toEqual({
			mana: { n: 3 },
			tapSelf: true,
		});
	});

	test("targeted triggers carry their target declaration, not the T: line", () => {
		const kavu = importFixture("f/flametongue_kavu");
		if (!kavu.ok) throw new Error("expected ok");
		expect(kavu.card.abilityDefinitions.triggered[0]).toMatchObject({
			condition: { kind: "change zone", to: "battlefield", selector: "self" },
			targets: [
				{
					id: "target-1",
					legal: {
						kind: "permanent",
						selector: { kind: "type", type: "creature" },
					},
				},
			],
			effects: [{ kind: "damage", targetSlot: "target-1", amount: 4 }],
		});

		const vandal = importFixture("m/manic_vandal");
		if (!vandal.ok) throw new Error("expected ok");
		expect(vandal.card.abilityDefinitions.triggered[0]).toMatchObject({
			targets: [
				{
					id: "target-1",
					legal: {
						kind: "permanent",
						selector: { kind: "type", type: "artifact" },
					},
				},
			],
			effects: [{ kind: "destroy", targetSlot: "target-1" }],
		});
	});

	test("Revitalize sequences gain-life then draw, defaulting the missing draw count to one", () => {
		const result = importFixture("r/revitalize");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card.spell?.effects).toEqual([
			{ kind: "gain-life", player: "you", amount: 3 },
			{ kind: "draw", player: "you", amount: 1 },
		]);
	});

	test("Preordain sequences scry then draw", () => {
		const result = importFixture("p/preordain");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card.spell?.effects).toEqual([
			{ kind: "scry", player: "you", amount: 2 },
			{ kind: "draw", player: "you", amount: 1 },
		]);
	});

	test("Scry defaults to one and rejects dynamic amounts", () => {
		const defaulted = importText(
			"Name:Default Scry\nManaCost:U\nTypes:Instant\nA:SP$ Scry | SpellDescription$ Scry 1.\nOracle:Scry 1.\n",
		);
		expect(defaulted.ok).toBe(true);
		if (!defaulted.ok) return;
		expect(defaulted.card.spell?.effects).toEqual([
			{ kind: "scry", player: "you", amount: 1 },
		]);

		const dynamic = importText(
			"Name:Dynamic Scry\nManaCost:U\nTypes:Instant\nA:SP$ Scry | ScryNum$ X | SpellDescription$ Scry X.\nOracle:Scry X.\n",
		);
		expect(dynamic.ok).toBe(false);
		if (dynamic.ok) return;
		expect(dynamic.diagnostics[0]).toMatchObject({
			code: "UNSUPPORTED_PARAMETER",
			message: "unsupported scry amount/player",
		});
	});

	test("Sorin's Thirst sequences damage then life gain in one target slot", () => {
		const result = importFixture("s/sorins_thirst");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card.spell?.targets).toHaveLength(1);
		expect(result.card.spell?.effects).toEqual([
			{ kind: "damage", targetSlot: "target-1", amount: 2 },
			{ kind: "gain-life", player: "you", amount: 2 },
		]);
	});

	test("Arashin Cleric's self-entry trigger implicitly targets you", () => {
		const result = importFixture("a/arashin_cleric");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card.abilityDefinitions.triggered).toEqual([
			{
				id: "TrigGainLife",
				text: expect.any(String),
				condition: {
					kind: "change zone",
					from: "any",
					to: "battlefield",
					selector: "self",
				},
				targets: [],
				effects: [{ kind: "gain-life", player: "you", amount: 3 }],
			},
		]);
	});

	test("Ajani's Mantra wraps its whole effect sequence in one optional choice", () => {
		const result = importFixture("a/ajanis_mantra");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card.abilityDefinitions.triggered).toEqual([
			{
				id: "TrigGainLife",
				text: expect.any(String),
				condition: { kind: "begin step", player: "you", step: "upkeep" },
				targets: [],
				effects: [
					{
						kind: "may",
						decider: "you",
						effects: [{ kind: "gain-life", player: "you", amount: 1 }],
					},
				],
			},
		]);
	});

	test("Necrogen Mists keeps the player whose upkeep triggered its effect", () => {
		const result = importFixture("n/necrogen_mists");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card.abilityDefinitions.triggered).toEqual([
			{
				id: "TrigDiscard",
				text: expect.any(String),
				condition: { kind: "begin step", player: "either", step: "upkeep" },
				targets: [],
				effects: [
					{
						kind: "discard",
						selector: "any",
						amount: 1,
						player: "triggering-player",
					},
				],
			},
		]);
	});

	test("Seizan keeps TriggeredPlayer through its SubAbility chain", () => {
		const result = importFixture("s/seizan_perverter_of_truth");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card.abilityDefinitions.triggered[0]?.effects).toEqual([
			{ kind: "lose-life", player: "triggering-player", amount: 2 },
			{ kind: "draw", player: "triggering-player", amount: 2 },
		]);
	});

	test("TriggeredPlayer is rejected outside a triggered ability", () => {
		for (const [types, ability] of [
			[
				"Instant",
				"A:SP$ Discard | Defined$ TriggeredPlayer | Mode$ TgtChoose | NumCards$ 1 | SpellDescription$ Discard a card.",
			],
			[
				"Artifact",
				"A:AB$ Discard | Cost$ T | Defined$ TriggeredPlayer | Mode$ TgtChoose | NumCards$ 1 | SpellDescription$ Discard a card.",
			],
		] as const) {
			const result = importText(
				`Name:Invalid TriggeredPlayer\nManaCost:1\nTypes:${types}\n${ability}\nOracle:\n`,
			);
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.diagnostics[0]?.message).toBe(
				"only discarding exactly one chosen card is supported",
			);
		}
	});

	test("ValidPlayer$ lowers the three unqualified words, and only those", () => {
		const card = (validPlayer: string) =>
			[
				"Name:Watcher",
				"ManaCost:1 W",
				"Types:Enchantment",
				`T:Mode$ Phase | Phase$ Upkeep | ValidPlayer$ ${validPlayer} | TriggerZones$ Battlefield | Execute$ Trig | TriggerDescription$ x`,
				"SVar:Trig:DB$ GainLife | Defined$ You | LifeAmount$ 1",
				"Oracle:",
				"",
			].join("\n");

		// `Player.Opponent` is Forge's long spelling of `Opponent`.
		const expected: Record<string, "you" | "opponent" | "either"> = {
			You: "you",
			Opponent: "opponent",
			"Player.Opponent": "opponent",
			Player: "either",
		};
		for (const [written, lowered] of Object.entries(expected)) {
			const result = importText(card(written));
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.card.abilityDefinitions.triggered[0]?.condition).toEqual({
				kind: "begin step",
				player: lowered,
				step: "upkeep",
			});
		}

		// Dotted forms restrict the player set by game state the engine has no
		// relative-player equivalent for, so they must reject rather than widen.
		for (const written of [
			"Player.EnchantedController",
			"You.lifeGE1",
			"Player.IsRemembered",
			"Player.Active",
		]) {
			const result = importText(card(written));
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_PARAMETER");
		}
	});

	test("Herald of Faith keeps Flying and its attack trigger", () => {
		const result = importFixture("h/herald_of_faith");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card.keywords).toEqual(["flying"]);
		expect(result.card.abilityDefinitions.triggered).toEqual([
			{
				id: "TrigGainLife",
				text: expect.any(String),
				condition: { kind: "declare attackers", selector: "self" },
				targets: [],
				effects: [{ kind: "gain-life", player: "you", amount: 2 }],
			},
		]);
	});

	test("Raging Goblin keeps Haste", () => {
		const result = importFixture("r/raging_goblin");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card.keywords).toEqual(["haste"]);
	});

	test("Glorious Anthem is a controlled-creature +1/+1 static", () => {
		const result = importFixture("g/glorious_anthem");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card.abilityDefinitions.static).toHaveLength(1);
		const ability = result.card.abilityDefinitions.static[0];
		if (!ability || "kind" in ability)
			throw new Error("expected a characteristic static ability");
		expect(ability.layer).toBe("7c-modify-power-toughness");
	});

	test("Exploration and Azusa lower finite positive land-play adjustments", () => {
		for (const [fixture, amount] of [
			["e/exploration", 1],
			["a/azusa_lost_but_seeking", 2],
		] as const) {
			const result = importFixture(fixture);
			if (!result.ok) throw new Error(`expected ${fixture} to import`);
			expect(result.card.abilityDefinitions.static).toEqual([
				{
					kind: "adjust-land-plays",
					text: expect.any(String),
					affects: "you",
					amount,
				},
			]);
		}
	});

	test("Aesthir Glider lowers only its unconditional self block restriction", () => {
		const result = importFixture("a/aesthir_glider");
		if (!result.ok) throw new Error("expected Aesthir Glider to import");
		expect(result.card.abilityDefinitions.static).toEqual([
			{
				kind: "cant-block-self",
				text: "CARDNAME can't block.",
			},
		]);
	});

	test("Root Maze lowers an artifact/land enters-tapped replacement", () => {
		const result = importFixture("r/root_maze");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card.abilityDefinitions.replacement).toHaveLength(1);
		expect(result.card.abilityDefinitions.replacement[0]?.layer).toBe("other");
	});

	test("Charcoal Diamond and Diregraf Ghoul lower the canonical self-entry form to entersTapped", () => {
		for (const fixture of ["c/charcoal_diamond", "d/diregraf_ghoul"]) {
			const result = importFixture(fixture);
			if (!result.ok) throw new Error(`expected ${fixture} to import`);
			expect(result.card.entersTapped).toBe(true);
			// `defineCard` synthesizes the one entry replacement from `entersTapped`
			// itself (see `printedEntryReplacements`); the bridge does not also
			// register a second, separately-authored replacement definition.
			expect(result.card.abilityDefinitions.replacement).toHaveLength(1);
			expect(result.card.abilityDefinitions.replacement[0]?.label).toContain(
				"enters-tapped",
			);
		}
	});

	test("Faithful Watchdog keeps Vigilance and literal entry counters", () => {
		const result = importFixture("f/faithful_watchdog");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card.keywords).toEqual(["vigilance"]);
		expect(result.card.entersWith).toEqual({ "+1/+1": 3 });
	});

	test("Soulmender lowers to a targetless tap-for-life-gain activated ability", () => {
		const result = importFixture("s/soulmender");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card.abilityDefinitions.activated).toEqual([
			{
				kind: "activated",
				id: "activated-1",
				text: expect.any(String),
				cost: { mana: "zero", tapSelf: true },
				targets: [],
				effects: [{ kind: "gain-life", player: "you", amount: 1 }],
			},
		]);
	});

	test("Viscera Seer lowers a creature sacrifice cost and scry effect", () => {
		const result = importFixture("v/viscera_seer");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card.abilityDefinitions.activated).toEqual([
			{
				kind: "activated",
				id: "activated-1",
				text: expect.any(String),
				cost: {
					mana: "zero",
					tapSelf: false,
					sacrifice: {
						selector: { kind: "type", type: "creature" },
						amount: 1,
					},
				},
				targets: [],
				effects: [{ kind: "scry", player: "you", amount: 1 }],
			},
		]);
	});

	test("Blazing Hellhound excludes itself from its creature sacrifice cost", () => {
		const result = importFixture("b/blazing_hellhound");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card.abilityDefinitions.activated[0]?.cost).toEqual({
			mana: { n: 1 },
			tapSelf: false,
			sacrifice: {
				selector: {
					kind: "all",
					selectors: [
						{ kind: "type", type: "creature" },
						{ kind: "not", selector: { kind: "self" } },
					],
				},
				amount: 1,
			},
		});
	});

	test("Acolyte of Aclazotz lowers its other-creature-or-artifact cost", () => {
		const result = importFixture("a/acolyte_of_aclazotz");
		if (!result.ok) throw new Error("expected ok");
		expect(
			result.card.abilityDefinitions.activated[0]?.cost.sacrifice?.selector,
		).toEqual({
			kind: "any",
			selectors: [
				{
					kind: "all",
					selectors: [
						{ kind: "type", type: "creature" },
						{ kind: "not", selector: { kind: "self" } },
					],
				},
				{
					kind: "all",
					selectors: [
						{ kind: "type", type: "artifact" },
						{ kind: "not", selector: { kind: "self" } },
					],
				},
			],
		});
	});

	test("a CARDNAME sacrifice selector lowers to the source, not a subtype", () => {
		const result = importFixture("upcoming/disruptor_pistol");
		if (!result.ok) throw new Error("expected ok");
		expect(
			result.card.abilityDefinitions.activated[0]?.cost.sacrifice?.selector,
		).toEqual({ kind: "self" });
	});

	test("Merfolk Looter lowers to draw-then-discard-one, targetless", () => {
		const result = importFixture("m/merfolk_looter");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card.abilityDefinitions.activated).toEqual([
			{
				kind: "activated",
				id: "activated-1",
				text: expect.any(String),
				cost: { mana: "zero", tapSelf: true },
				targets: [],
				effects: [
					{ kind: "draw", player: "you", amount: 1 },
					{ kind: "discard", selector: "any", amount: 1, player: "you" },
				],
			},
		]);
	});
});

/* ------------------------------------------------------------------------- */
/* The required negative matrix                                              */
/* ------------------------------------------------------------------------- */

const NEGATIVE_FIXTURES = [
	"g/giant_growth",
	"b/blind_obedience",
	"w/walking_ballista",
	"r/rest_in_peace",
	"c/clone",
	"i/into_the_maw_of_hell",
	"e/eye_of_vecna",
	"r/reckless_abandon",
];

describe("lowerForgeCard: required negative fixtures", () => {
	for (const fixture of NEGATIVE_FIXTURES) {
		test(`rejects ${fixture}`, () => {
			const result = importFixture(fixture);
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.diagnostics.length).toBeGreaterThan(0);
		});
	}
});

/* ------------------------------------------------------------------------- */
/* Mutation-based negative tests (implementation order, step 1 gate)         */
/* ------------------------------------------------------------------------- */

const BOLT = `Name:Lightning Bolt
ManaCost:R
Types:Instant
A:SP$ DealDamage | ValidTgts$ Any | NumDmg$ 3 | SpellDescription$ CARDNAME deals 3 damage to any target.
Oracle:Lightning Bolt deals 3 damage to any target.
`;

const REVITALIZE = `Name:Revitalize
ManaCost:1 W
Types:Instant
A:SP$ GainLife | Defined$ You | LifeAmount$ 3 | SubAbility$ DBDraw | SpellDescription$ You gain 3 life.
SVar:DBDraw:DB$ Draw | Defined$ You | SpellDescription$ Draw a card.
Oracle:You gain 3 life. Draw a card.
`;

const BEARS = `Name:Grizzly Bears
ManaCost:1 G
Types:Creature Bear
PT:2/2
Oracle:
`;

function importText(text: string) {
	return importForgeCard(text, { id: "mutation-test" });
}

describe("lowerForgeCard: required negative mutations", () => {
	test("accepts the unmodified baseline (control)", () => {
		expect(importText(BOLT).ok).toBe(true);
		expect(importText(REVITALIZE).ok).toBe(true);
		expect(importText(BEARS).ok).toBe(true);
	});

	test("rejects unlimited, nonpositive, and non-You land-play adjustments", () => {
		for (const staticLine of [
			"S:Mode$ Continuous | Affected$ You | AdjustLandPlays$ Unlimited | Description$ x",
			"S:Mode$ Continuous | Affected$ You | AdjustLandPlays$ 0 | Description$ x",
			"S:Mode$ Continuous | Affected$ Opponent | AdjustLandPlays$ 1 | Description$ x",
		]) {
			const result = importText(`${BEARS}${staticLine}\n`);
			expect(result.ok).toBe(false);
			if (!result.ok)
				expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_EFFECT");
		}
	});

	test("rejects CantBlock shapes other than unconditional Card.Self", () => {
		for (const staticLine of [
			"S:Mode$ CantBlock | ValidCard$ Creature | Description$ x",
			"S:Mode$ CantBlock | ValidCard$ Card.Self | Affected$ You | Description$ x",
		]) {
			const result = importText(`${BEARS}${staticLine}\n`);
			expect(result.ok).toBe(false);
			if (!result.ok)
				expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_EFFECT");
		}
	});

	test("rejects a supported spell plus an unknown keyword", () => {
		const result = importText(`${BOLT}K:Foobar\n`);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_KEYWORD");
	});

	test("rejects an unknown semantic parameter", () => {
		const result = importText(
			BOLT.replace("SpellDescription$", "Foo$ Bar | SpellDescription$"),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_PARAMETER");
	});

	test("rejects a duplicate semantic parameter", () => {
		const result = importText(
			BOLT.replace("NumDmg$ 3 |", "NumDmg$ 3 | NumDmg$ 3 |"),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_PARAMETER");
	});

	test("rejects a malformed parameter fragment", () => {
		const result = importText(
			BOLT.replace("ValidTgts$ Any |", "ValidTgts$ Any | Weird |"),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_PARAMETER");
	});

	test("rejects a selector restriction outside the supported vocabulary", () => {
		const result = importText(
			BOLT.replace("ValidTgts$ Any", "ValidTgts$ Creature.attacking"),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_TARGET");
	});

	test("rejects a new target declaration on a sub-ability continuation", () => {
		const result = importText(
			REVITALIZE.replace("DB$ Draw", "DB$ Draw | ValidTgts$ Creature"),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_EFFECT");
	});

	test("rejects an effect that targets a slot its ability never declared", () => {
		const result = importText(BOLT.replace("ValidTgts$ Any | ", ""));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_TARGET");
	});

	test("rejects an unsupported mana symbol", () => {
		const result = importText(BOLT.replace("ManaCost:R", "ManaCost:1 R X"));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_COST");
	});

	test("rejects unsupported activation cost terms without dropping them", () => {
		for (const term of ["C", "X", "W/U", "W/P", "PayLife<2>", "Discard<1>"]) {
			const result = importText(
				`${BEARS}A:AB$ GainLife | Cost$ ${term} | Defined$ You | LifeAmount$ 1 | SpellDescription$ You gain 1 life.\n`,
			);
			expect(result.ok, term).toBe(false);
			if (!result.ok) {
				expect(result.diagnostics).toEqual([
					expect.objectContaining({
						code: "UNSUPPORTED_COST",
						message: `unsupported activation cost term ${term}`,
					}),
				]);
			}
		}
	});

	test("rejects an unsafe activation mana quantity precisely", () => {
		const term = "9007199254740992";
		const result = importText(
			`${BEARS}A:AB$ GainLife | Cost$ ${term} | Defined$ You | LifeAmount$ 1 | SpellDescription$ You gain 1 life.\n`,
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.diagnostics[0]).toMatchObject({
				code: "UNSUPPORTED_COST",
				message: `unsupported generic activation cost term ${term}: quantity is not a safe integer`,
			});
		}
	});

	test("rejects malformed activation cost strings precisely", () => {
		for (const [costParameter, message] of [
			["", "malformed activation cost: expected mana and/or T"],
			["Cost$", "malformed activation cost: expected mana and/or T"],
			["Cost$ T T", "malformed activation cost: duplicate T term"],
			["Cost$ 2  T", "malformed activation cost: empty term"],
			["Cost$ 02", "malformed generic activation cost term 02"],
			[
				"Cost$ 0 U",
				"malformed activation cost: 0 cannot be combined with other mana terms",
			],
		] as const) {
			const cost = costParameter === "" ? "" : `${costParameter} | `;
			const result = importText(
				`${BEARS}A:AB$ GainLife | ${cost}Defined$ You | LifeAmount$ 1 | SpellDescription$ You gain 1 life.\n`,
			);
			expect(result.ok, costParameter || "missing Cost$").toBe(false);
			if (!result.ok) {
				expect(result.diagnostics[0]).toMatchObject({
					code: "UNSUPPORTED_COST",
					message,
				});
			}
		}
	});

	test("rejects an extra face", () => {
		const result = importText(
			`${BOLT}ALTERNATE\nName:Other\nManaCost:R\nTypes:Instant\n`,
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_FACE");
	});

	test("rejects an unknown directive", () => {
		const result = importText(`${BOLT}Foo:Bar\n`);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_KEYWORD");
	});

	test("rejects a sub-ability that declares its own cost or target", () => {
		const cost = importText(
			REVITALIZE.replace(
				"DB$ Draw | Defined$ You |",
				"DB$ Draw | Defined$ You | Cost$ 2 |",
			),
		);
		expect(cost.ok).toBe(false);
		if (!cost.ok) expect(cost.diagnostics[0]?.code).toBe("UNSUPPORTED_EFFECT");

		const target = importText(
			REVITALIZE.replace(
				"DB$ Draw | Defined$ You |",
				"DB$ Draw | Defined$ You | ValidTgts$ Any |",
			),
		);
		expect(target.ok).toBe(false);
		if (!target.ok)
			expect(target.diagnostics[0]?.code).toBe("UNSUPPORTED_EFFECT");
	});

	test("rejects a dynamic (non-literal) amount", () => {
		const result = importText(BOLT.replace("NumDmg$ 3", "NumDmg$ X"));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_PARAMETER");
	});

	test("rejects the whole card when a later rule is unsupported, after an otherwise-supported first rule", () => {
		const result = importText(
			`${BEARS}A:AB$ Foo | Cost$ T | SpellDescription$ x.\n`,
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_EFFECT");
	});

	test("rejects a spell ability on a permanent card (never resolved by the engine)", () => {
		const result = importText(
			`${BEARS}A:SP$ GainLife | Defined$ You | LifeAmount$ 1 | SpellDescription$ x.\n`,
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_EFFECT");
	});

	test("rejects an instant with no spell ability", () => {
		const result = importText(
			`Name:Empty Instant\nManaCost:R\nTypes:Instant\nOracle:\n`,
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_EFFECT");
	});

	test("rejects Destroy targeting a non-permanent slot", () => {
		const result = importText(
			`Name:Bad Destroy\nManaCost:1 B\nTypes:Instant\nA:SP$ Destroy | ValidTgts$ Player | SpellDescription$ x.\n`,
		);
		expect(result.ok).toBe(false);
	});

	test("rejects an unused SVar", () => {
		const result = importText(`${BEARS}SVar:Unused:TRUE\n`);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_REFERENCE");
	});

	test("rejects a planeswalker (Loyalty is unsupported)", () => {
		const result = importText(
			`Name:Test Walker\nManaCost:2 W\nTypes:Planeswalker\nLoyalty:3\nOracle:\n`,
		);
		expect(result.ok).toBe(false);
	});

	test("rejects a target union that cannot be represented faithfully (Player,Planeswalker)", () => {
		const result = importText(
			"Name:Bad Target\nManaCost:R\nTypes:Instant\nA:SP$ DealDamage | ValidTgts$ Player,Planeswalker | NumDmg$ 1 | SpellDescription$ x.\nOracle:\n",
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_TARGET");
	});

	test("Dryad Arbor grants its intrinsic mana ability despite not being a basic land", () => {
		const result = importFixture("d/dryad_arbor");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.card.abilityDefinitions.activated).toContainEqual({
			kind: "mana",
			id: "intrinsic-mana-g",
			text: "Add {G}.",
			cost: { mana: "zero", tapSelf: true },
			effects: [
				{
					kind: "add-mana",
					player: "you",
					mana: { w: 0, u: 0, b: 0, r: 0, g: 1, c: 0 },
				},
			],
		});
	});
});

/* ------------------------------------------------------------------------- */
/* Regressions for specific reviewed defects                                 */
/* ------------------------------------------------------------------------- */

describe("lowerForgeCard: hardening regressions", () => {
	const artifactProbe = `Name:Probe\nManaCost:1\nTypes:Artifact\nOracle:\n`;

	test("a keyword literally named 'constructor' is data, not Object.prototype.constructor", () => {
		const result = importText(`${artifactProbe}K:constructor\n`);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_KEYWORD");
	});

	test("a Colors$ value literally named 'constructor' is data, not Object.prototype.constructor", () => {
		const result = importText(`${artifactProbe}Colors:constructor\n`);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_PARAMETER");
	});

	test("rejects mixed permanent and spell card types", () => {
		const result = importText(
			`Name:Probe\nManaCost:1\nTypes:Artifact Instant\nA:SP$ GainLife | Defined$ You | LifeAmount$ 2 | SpellDescription$ gain\nOracle:\n`,
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_PARAMETER");
	});

	test("rejects two spell types together (Instant Sorcery)", () => {
		const result = importText(
			`Name:Probe\nManaCost:1\nTypes:Instant Sorcery\nA:SP$ GainLife | Defined$ You | LifeAmount$ 2 | SpellDescription$ gain\nOracle:\n`,
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_PARAMETER");
	});

	test("rejects a summed entry-counter count that overflows safe-integer range", () => {
		const result = importText(
			`Name:Probe\nManaCost:1\nTypes:Creature\nPT:0/0\nK:etbCounter:P1P1:9007199254740991\nK:etbCounter:P1P1:1\nOracle:\n`,
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_KEYWORD");
	});

	test("rejects a Card.Self-containing selector in a global (ActiveZones$) replacement", () => {
		const result = importText(
			[
				"Name:Bad",
				"ManaCost:1",
				"Types:Enchantment",
				"R:Event$ Moved | ValidCard$ Card.Self,Artifact | Destination$ Battlefield | ReplacementResult$ Updated | ReplaceWith$ ETBTapped | ActiveZones$ Battlefield",
				"SVar:ETBTapped:DB$ Tap | ETB$ True | Defined$ ReplacedCard",
				"Oracle:",
				"",
			].join("\n"),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_TARGET");
	});

	test("rejects multi-card and random discard on a spell", () => {
		const multi = importText(
			"Name:Bad\nManaCost:1 U\nTypes:Sorcery\nA:SP$ Discard | Defined$ You | Mode$ TgtChoose | NumCards$ 2 | SpellDescription$ x.\nOracle:\n",
		);
		expect(multi.ok).toBe(false);
		if (!multi.ok)
			expect(multi.diagnostics[0]?.code).toBe("UNSUPPORTED_EFFECT");

		const random = importText(
			"Name:Bad\nManaCost:1 U\nTypes:Sorcery\nA:SP$ Discard | Defined$ You | Mode$ Random | NumCards$ 1 | SpellDescription$ x.\nOracle:\n",
		);
		expect(random.ok).toBe(false);
		if (!random.ok)
			expect(random.diagnostics[0]?.code).toBe("UNSUPPORTED_EFFECT");
	});

	test("rejects multi-card and random discard on a trigger", () => {
		const multi = importText(
			[
				"Name:Bad",
				"ManaCost:1 U",
				"Types:Enchantment",
				"T:Mode$ Phase | Phase$ Upkeep | ValidPlayer$ You | TriggerZones$ Battlefield | Execute$ Trig | TriggerDescription$ x",
				"SVar:Trig:DB$ Discard | Defined$ You | Mode$ TgtChoose | NumCards$ 2",
				"Oracle:",
				"",
			].join("\n"),
		);
		expect(multi.ok).toBe(false);
		if (!multi.ok)
			expect(multi.diagnostics[0]?.code).toBe("UNSUPPORTED_EFFECT");

		const random = importText(
			[
				"Name:Bad",
				"ManaCost:1 U",
				"Types:Enchantment",
				"T:Mode$ Phase | Phase$ Upkeep | ValidPlayer$ You | TriggerZones$ Battlefield | Execute$ Trig | TriggerDescription$ x",
				"SVar:Trig:DB$ Discard | Defined$ You | Mode$ Random | NumCards$ 1",
				"Oracle:",
				"",
			].join("\n"),
		);
		expect(random.ok).toBe(false);
		if (!random.ok)
			expect(random.diagnostics[0]?.code).toBe("UNSUPPORTED_EFFECT");
	});

	test("rejects choice, variable, malformed, and unsupported Produced$ forms with diagnostics", () => {
		for (const produced of [
			"Any", // choice
			"Combo W U", // modal choice
			"Chosen", // variable
			"W  U", // malformed fixed-list separator
			"WU", // unsupported compact form
		]) {
			const result = importText(
				`Name:Bad Land\nManaCost:no cost\nTypes:Land\nA:AB$ Mana | Cost$ T | Produced$ ${produced} | SpellDescription$ x.\nOracle:\n`,
			);
			expect(result.ok, `Produced$ ${produced}`).toBe(false);
			if (result.ok) return;
			expect(result.diagnostics[0]).toMatchObject({
				code: "UNSUPPORTED_EFFECT",
				message: `unsupported produced mana ${produced}`,
			});
			expect(result.diagnostics[0]?.nodeId).toBeDefined();
			expect(result.diagnostics[0]?.line).toBeDefined();
		}
	});

	test("rejects an Amount$ on a fixed Produced$ list as an unsupported quantity", () => {
		const result = importText(
			"Name:Bad Land\nManaCost:no cost\nTypes:Land\nA:AB$ Mana | Cost$ T | Produced$ W U | Amount$ 2 | SpellDescription$ x.\nOracle:\n",
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]).toMatchObject({
			code: "UNSUPPORTED_EFFECT",
			message: "unsupported mana amount 2",
		});
	});

	test("a dynamic mana amount rejects on the amount, not the symbol", () => {
		// Urza's Tower: {C}, or {C}{C}{C} with the other two Urza lands out.
		const result = importText(
			"Name:Test Tower\nManaCost:no cost\nTypes:Land\nA:AB$ Mana | Cost$ T | Produced$ C | Amount$ UrzaAmount | SpellDescription$ x.\nSVar:UrzaAmount:Count$UrzaLands.3.1\nOracle:\n",
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]?.message).toContain("mana amount");
	});

	test("rejects an unresolved SubAbility reference", () => {
		const result = importText(
			"Name:Bad\nManaCost:1 W\nTypes:Instant\nA:SP$ GainLife | Defined$ You | LifeAmount$ 3 | SubAbility$ NoSuchThing | SpellDescription$ x.\nOracle:\n",
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_REFERENCE");
	});

	test("an explicit multi-mana ability does not suppress the intrinsic one-mana basic-land grant", () => {
		const result = importText(
			"Name:Test Land\nManaCost:no cost\nTypes:Basic Land Forest\nA:AB$ Mana | Cost$ T | Produced$ G | Amount$ 2 | SpellDescription$ Add GG.\nOracle:\n",
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.card.abilityDefinitions.activated).toEqual([
			expect.objectContaining({
				id: "activated-1",
				effects: [
					{
						kind: "add-mana",
						player: "you",
						mana: expect.objectContaining({ g: 2 }),
					},
				],
			}),
			expect.objectContaining({
				id: "intrinsic-mana-g",
				effects: [
					{
						kind: "add-mana",
						player: "you",
						mana: expect.objectContaining({ g: 1 }),
					},
				],
			}),
		]);
	});
});

/* ------------------------------------------------------------------------- */
/* SubAbility/Execute chain traversal: cycles, sharing, and depth            */
/* ------------------------------------------------------------------------- */

describe("lowerForgeCard: chain traversal", () => {
	test("rejects a cyclic SubAbility chain", () => {
		const result = importText(
			[
				"Name:Cyclic",
				"ManaCost:1",
				"Types:Artifact",
				"A:AB$ GainLife | Cost$ T | Defined$ You | LifeAmount$ 1 | SubAbility$ Loop1 | SpellDescription$ x.",
				"SVar:Loop1:DB$ GainLife | Defined$ You | LifeAmount$ 1 | SubAbility$ Loop2",
				"SVar:Loop2:DB$ GainLife | Defined$ You | LifeAmount$ 1 | SubAbility$ Loop1",
				"Oracle:",
				"",
			].join("\n"),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_REFERENCE");
	});

	test("rejects ambiguous case-variant duplicate SVar names", () => {
		const result = importText(
			[
				"Name:Dup",
				"ManaCost:1",
				"Types:Artifact",
				"A:AB$ GainLife | Cost$ T | Defined$ You | LifeAmount$ 1 | SubAbility$ Foo | SpellDescription$ x.",
				"SVar:Foo:DB$ GainLife | Defined$ You | LifeAmount$ 1",
				"SVar:foo:DB$ GainLife | Defined$ You | LifeAmount$ 2",
				"Oracle:",
				"",
			].join("\n"),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_REFERENCE");
	});

	test("rejects a SubAbility chain deeper than the supported bound", () => {
		const lines = [
			"Name:Deep",
			"ManaCost:1",
			"Types:Artifact",
			"A:AB$ GainLife | Cost$ T | Defined$ You | LifeAmount$ 1 | SubAbility$ L0 | SpellDescription$ x.",
		];
		for (let i = 0; i < 35; i++) {
			const next = i < 34 ? ` | SubAbility$ L${i + 1}` : "";
			lines.push(
				`SVar:L${i}:DB$ GainLife | Defined$ You | LifeAmount$ 1${next}`,
			);
		}
		lines.push("Oracle:", "");
		const result = importText(lines.join("\n"));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_REFERENCE");
	});

	test("a sub-ability shared by two different triggers lowers separately in each caller context", () => {
		const result = importText(
			[
				"Name:Shared",
				"ManaCost:1",
				"Types:Enchantment",
				"T:Mode$ Phase | Phase$ Upkeep | ValidPlayer$ You | TriggerZones$ Battlefield | Execute$ TrigA | TriggerDescription$ a",
				"T:Mode$ ChangesZone | Origin$ Any | Destination$ Battlefield | ValidCard$ Card.Self | Execute$ TrigB | TriggerDescription$ b",
				"SVar:TrigA:DB$ GainLife | Defined$ You | LifeAmount$ 1 | SubAbility$ Shared",
				"SVar:TrigB:DB$ GainLife | Defined$ You | LifeAmount$ 2 | SubAbility$ Shared",
				"SVar:Shared:DB$ Draw | Defined$ You | NumCards$ 1",
				"Oracle:",
				"",
			].join("\n"),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.card.abilityDefinitions.triggered).toEqual([
			{
				id: "TrigA",
				text: "a",
				condition: { kind: "begin step", player: "you", step: "upkeep" },
				targets: [],
				effects: [
					{ kind: "gain-life", player: "you", amount: 1 },
					{ kind: "draw", player: "you", amount: 1 },
				],
			},
			{
				id: "TrigB",
				text: "b",
				condition: {
					kind: "change zone",
					from: "any",
					to: "battlefield",
					selector: "self",
				},
				targets: [],
				effects: [
					{ kind: "gain-life", player: "you", amount: 2 },
					{ kind: "draw", player: "you", amount: 1 },
				],
			},
		]);
	});
});

/* ------------------------------------------------------------------------- */
/* Bridge contract properties                                                */
/* ------------------------------------------------------------------------- */

describe("lowerForgeCard: bridge contract", () => {
	test("never returns a partially-usable card on rejection", () => {
		const result = importText(`${BOLT}K:Foobar\n`);
		expect(result.ok).toBe(false);
		expect(Object.keys(result)).toEqual(["ok", "diagnostics"]);
	});

	test("mutating the source AST after lowering does not affect the already-built card", () => {
		const { card: ast } = parseForgeCardScript(BEARS);
		const first = lowerForgeCard(ast, { id: "bears-1" });
		if (!first.ok) throw new Error("expected ok");
		const originalName = first.card.name;

		const face = ast.faces[0];
		if (!face?.characteristics.name) throw new Error("expected a name node");
		face.characteristics.name.value = "MUTATED";

		expect(first.card.name).toBe(originalName);
	});

	test("a static's callback closes over its own validated constant, not the mutable AST", () => {
		const anthemText = cardText("g/glorious_anthem");
		const { card: ast } = parseForgeCardScript(anthemText);
		const first = lowerForgeCard(ast, { id: "anthem-1" });
		if (!first.ok) throw new Error("expected ok");
		const effect = first.card.abilityDefinitions.static[0];
		if (!effect || "kind" in effect)
			throw new Error("expected a characteristic static effect");

		// Find and mutate the AddPower$/AddToughness$ param entries in the AST
		// after lowering: if `modify` closed over the AST node instead of a
		// validated copy, this would change the already-built callback's output.
		const face = ast.faces[0];
		const staticRecord = face?.statics[0];
		if (!staticRecord) throw new Error("expected a static record");
		for (const entry of staticRecord.params.entries) {
			if (entry.key === "AddPower" || entry.key === "AddToughness") {
				entry.value = "999";
			}
		}

		const rawView = { power: 2, toughness: 2 };
		const view = rawView as unknown as Parameters<typeof effect.modify>[0];
		effect.modify(view, {} as never, {} as never);
		expect(rawView).toEqual({ power: 3, toughness: 3 });
	});

	test("importing the same source under two distinct ids yields independent registry entries", () => {
		const a = importText(BEARS);
		const b = importForgeCard(BEARS, { id: "mutation-test-2" });
		if (!a.ok || !b.ok) throw new Error("expected both to succeed");
		expect(a.card.id).not.toBe(b.card.id);
		expect(a.card).not.toBe(b.card);
	});

	test("importing never registers the card: it stays unknown to the engine", () => {
		const result = importForgeCard(BEARS, { id: "unregistered-bears-probe" });
		expect(result.ok).toBe(true);
		const state = newGame();
		const obj = spawnCard(state, "unregistered-bears-probe", 0, "hand");
		expect(() => name(state, obj.id)).toThrow(/unknown card/);
	});
});
