import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createEngine } from "../index.ts";
import { CLUE_TOKEN } from "../tokens.ts";
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

describe("lowerForgeCard: accepted card lowering", () => {
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

	test.each([
		["s/soul_warden", "Soul Warden", "w", "Human", "Cleric"],
		["e/essence_warden", "Essence Warden", "g", "Elf", "Shaman"],
	] as const)(
		"%s imports its printed another-creature trigger",
		(path, cardName, color, firstSubtype, secondSubtype) => {
			const result = importFixture(path);
			if (!result.ok) throw new Error("expected ok");
			expect(result.card).toMatchObject({
				name: cardName,
				types: ["creature"],
				subtypes: [firstSubtype, secondSubtype],
				manaCost: { [color]: 1 },
				power: 1,
				toughness: 1,
			});
			expect(result.card.abilityDefinitions.triggered).toEqual([
				{
					id: "TrigGainLife",
					text: "Whenever another creature enters, you gain 1 life.",
					condition: {
						kind: "change zone",
						from: "any",
						to: "battlefield",
						predicate: {
							kind: "and",
							predicates: [
								{ kind: "type", type: "creature" },
								{
									kind: "not",
									predicate: { kind: "self" },
								},
							],
						},
					},
					targets: [],
					effects: [
						{
							kind: "gain-life",
							subject: { kind: "relative-player", player: "you" },
							amount: 1,
						},
					],
				},
			]);
		},
	);

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
						subject: "you",
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
						subject: "you",
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
						subject: "you",
						mana: { w: 0, u: 0, b: 0, r: 0, g: 0, c: 1 },
					},
				],
			},
		]);
	});

	test("Temple of Epiphany lowers Combo U R as one modal mana ability", () => {
		const result = importFixture("t/temple_of_epiphany");
		if (!result.ok) throw new Error("expected Temple of Epiphany to import");
		expect(result.card.entersTapped).toBe(true);
		expect(result.card.abilityDefinitions.triggered[0]?.effects).toEqual([
			{
				kind: "scry",
				subject: { kind: "relative-player", player: "you" },
				amount: 1,
			},
		]);
		expect(result.card.abilityDefinitions.activated).toEqual([
			{
				kind: "mana",
				id: "activated-1",
				text: "Add {U} or {R}.",
				cost: { mana: "zero", tapSelf: true },
				manaOptions: [
					{ w: 0, u: 1, b: 0, r: 0, g: 0, c: 0 },
					{ w: 0, u: 0, b: 0, r: 1, g: 0, c: 0 },
				],
			},
		]);
	});

	test("Golgari Rot Farm lowers its mandatory non-targeted land return", () => {
		const result = importFixture("g/golgari_rot_farm");
		if (!result.ok) throw new Error("expected Golgari Rot Farm to import");
		expect(result.card).toMatchObject({
			name: "Golgari Rot Farm",
			types: ["land"],
			manaCost: "none",
			entersTapped: true,
		});
		expect(result.card.abilityDefinitions.triggered).toEqual([
			{
				id: "TrigReturn",
				text: "When CARDNAME enters, return a land you control to its owner's hand.",
				condition: {
					kind: "change zone",
					from: "any",
					to: "battlefield",
					predicate: { kind: "self" },
				},
				targets: [],
				effects: [
					{
						kind: "change-zone",
						subject: {
							kind: "chosen-permanent",
							player: "you",
							predicate: {
								kind: "and",
								predicates: [
									{ kind: "type", type: "land" },
									{ kind: "controller", player: "you" },
								],
							},
							prompt: "Return a land you control to its owner's hand.",
						},
						from: "battlefield",
						destination: { zone: "hand" },
					},
				],
			},
		]);
		expect(result.card.abilityDefinitions.activated).toEqual([
			{
				kind: "mana",
				id: "activated-1",
				text: "Add {B}{G}.",
				cost: { mana: "zero", tapSelf: true },
				effects: [
					{
						kind: "add-mana",
						subject: "you",
						mana: { w: 0, u: 0, b: 1, r: 0, g: 1, c: 0 },
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
							subject: "you",
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
						subject: "you",
						mana: expect.objectContaining({ g: 1 }),
					},
				],
			},
		]);
	});

	test("Firebrand Archer and Kessig Flamebreather lower opponent damage recipients", () => {
		for (const fixture of ["f/firebrand_archer", "k/kessig_flamebreather"]) {
			const result = importFixture(fixture);
			if (!result.ok) throw new Error(`expected ${fixture} to import`);
			expect(result.card.abilityDefinitions.triggered[0]?.effects).toEqual([
				{
					kind: "damage",
					subject: { kind: "relative-player", player: "opponent" },
					amount: 1,
				},
			]);
		}
	});

	test("Cindervines remains unsupported", () => {
		const result = importFixture("c/cindervines");
		expect(result.ok).toBe(false);
	});

	test("Lightning Bolt and Murder lower a single required target slot", () => {
		const bolt = importFixture("l/lightning_bolt");
		if (!bolt.ok) throw new Error("expected ok");
		expect(bolt.card.spell).toMatchObject({
			targets: [
				{ id: "target-1", min: 1, max: 1, legal: { kind: "any-target" } },
			],
			effects: [
				{
					kind: "damage",
					subject: { kind: "target", slot: "target-1" },
					amount: 3,
				},
			],
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
						predicate: { kind: "type", type: "creature" },
					},
				},
			],
			effects: [
				{ kind: "destroy", subject: { kind: "target", slot: "target-1" } },
			],
		});
	});

	test("Arcanis lowers its nontargeted self-bounce ability", () => {
		const result = importFixture("a/arcanis_the_omnipotent");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card.abilityDefinitions.activated[1]).toMatchObject({
			cost: { mana: { n: 2, u: 2 }, tapSelf: false },
			targets: [],
			effects: [
				{
					kind: "change-zone",
					subject: { kind: "source" },
					from: "battlefield",
					destination: { zone: "hand" },
				},
			],
		});
	});

	test("Counterspell lowers a spell target and counter effect", () => {
		const result = importFixture("c/counterspell");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card).toMatchObject({
			name: "Counterspell",
			types: ["instant"],
			manaCost: { u: 2 },
			spell: {
				targets: [
					{
						id: "target-1",
						min: 1,
						max: 1,
						legal: { kind: "spell" },
					},
				],
				effects: [
					{ kind: "counter", subject: { kind: "target", slot: "target-1" } },
				],
			},
		});
	});

	test("Negate lowers its noncreature spell restriction", () => {
		const result = importFixture("n/negate");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card.spell).toMatchObject({
			targets: [
				{
					legal: {
						kind: "spell",
						predicate: {
							kind: "not",
							predicate: { kind: "type", type: "creature" },
						},
					},
				},
			],
			effects: [
				{
					kind: "counter",
					subject: { kind: "target", slot: "target-1" },
				},
			],
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
					predicate: {
						kind: "and",
						predicates: [
							{ kind: "type", type: "creature" },
							{ kind: "not", predicate: { kind: "color", color: "b" } },
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
				effects: [
					{
						kind: "damage",
						subject: { kind: "target", slot: "target-1" },
						amount: 1,
					},
				],
			},
		]);

		const combined = importFixture("r/rod_of_ruin");
		if (!combined.ok) throw new Error("expected ok");
		expect(combined.card.abilityDefinitions.activated[0]?.cost).toEqual({
			mana: { n: 3 },
			tapSelf: true,
		});
	});

	test("Icy Manipulator lowers its paid tap ability and permanent target union", () => {
		const result = importFixture("i/icy_manipulator");
		if (!result.ok) throw new Error("expected Icy Manipulator to import");
		expect(result.card.abilityDefinitions.activated).toEqual([
			{
				kind: "activated",
				id: "activated-1",
				text: "Tap target artifact, creature, or land.",
				cost: { mana: { n: 1 }, tapSelf: true },
				targets: [
					{
						id: "target-1",
						min: 1,
						max: 1,
						legal: {
							kind: "permanent",
							predicate: {
								kind: "or",
								predicates: [
									{ kind: "type", type: "artifact" },
									{ kind: "type", type: "creature" },
									{ kind: "type", type: "land" },
								],
							},
						},
					},
				],
				effects: [
					{ kind: "tap", subject: { kind: "target", slot: "target-1" } },
				],
			},
		]);
	});

	test("Wirewood Lodge lowers its targeted untap ability", () => {
		const result = importFixture("w/wirewood_lodge");
		if (!result.ok) throw new Error("expected Wirewood Lodge to import");
		expect(result.card.abilityDefinitions.activated[1]).toEqual({
			kind: "activated",
			id: "activated-2",
			text: "Untap target Elf.",
			cost: { mana: { g: 1 }, tapSelf: true },
			targets: [
				{
					id: "target-1",
					min: 1,
					max: 1,
					legal: {
						kind: "permanent",
						predicate: { kind: "subtype", subtype: "Elf" },
					},
				},
			],
			effects: [
				{ kind: "untap", subject: { kind: "target", slot: "target-1" } },
			],
		});
	});

	test("Network Disruptor lowers its unrestricted permanent target", () => {
		const result = importFixture("n/network_disruptor");
		if (!result.ok) throw new Error("expected Network Disruptor to import");
		expect(result.card).toMatchObject({
			name: "Network Disruptor",
			manaCost: { u: 1 },
			types: ["artifact", "creature"],
			subtypes: ["Moonfolk", "Rogue"],
			power: 1,
			toughness: 1,
			keywords: ["flying"],
		});
		expect(result.card.abilityDefinitions.triggered).toEqual([
			{
				id: "TrigTap",
				text: "When CARDNAME enters, tap target permanent.",
				condition: {
					kind: "change zone",
					from: "any",
					to: "battlefield",
					predicate: { kind: "self" },
				},
				targets: [
					{
						id: "target-1",
						min: 1,
						max: 1,
						legal: { kind: "permanent" },
					},
				],
				effects: [
					{ kind: "tap", subject: { kind: "target", slot: "target-1" } },
				],
			},
		]);
	});

	test("targeted triggers carry their target declaration, not the T: line", () => {
		const kavu = importFixture("f/flametongue_kavu");
		if (!kavu.ok) throw new Error("expected ok");
		expect(kavu.card.abilityDefinitions.triggered[0]).toMatchObject({
			condition: {
				kind: "change zone",
				to: "battlefield",
				predicate: { kind: "self" },
			},
			targets: [
				{
					id: "target-1",
					legal: {
						kind: "permanent",
						predicate: { kind: "type", type: "creature" },
					},
				},
			],
			effects: [
				{
					kind: "damage",
					subject: { kind: "target", slot: "target-1" },
					amount: 4,
				},
			],
		});

		const vandal = importFixture("m/manic_vandal");
		if (!vandal.ok) throw new Error("expected ok");
		expect(vandal.card.abilityDefinitions.triggered[0]).toMatchObject({
			targets: [
				{
					id: "target-1",
					legal: {
						kind: "permanent",
						predicate: { kind: "type", type: "artifact" },
					},
				},
			],
			effects: [
				{ kind: "destroy", subject: { kind: "target", slot: "target-1" } },
			],
		});
	});

	test("Revitalize sequences gain-life then draw, defaulting the missing draw count to one", () => {
		const result = importFixture("r/revitalize");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card.spell?.effects).toEqual([
			{
				kind: "gain-life",
				subject: { kind: "relative-player", player: "you" },
				amount: 3,
			},
			{
				kind: "draw",
				subject: { kind: "relative-player", player: "you" },
				amount: 1,
			},
		]);
	});

	test("Vision Skeins preserves Defined$ Player as one plural effect", () => {
		const result = importFixture("v/vision_skeins");
		if (!result.ok) throw new Error("expected ok");
		// Forge's `Defined$ Player` names every player at once; the engine's
		// player field holds one, so the lowering spells the instruction once
		// for each side of the table.
		expect(result.card.spell?.effects).toEqual([
			{ kind: "each player draw", subjects: "each-player", amount: 2 },
		]);
	});

	test("Preordain sequences scry then draw", () => {
		const result = importFixture("p/preordain");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card.spell?.effects).toEqual([
			{
				kind: "scry",
				subject: { kind: "relative-player", player: "you" },
				amount: 2,
			},
			{
				kind: "draw",
				subject: { kind: "relative-player", player: "you" },
				amount: 1,
			},
		]);
	});

	test("Dig defaults an omitted ChangeNum to one and preserves explicit counts", () => {
		const cases = [
			{
				fixture: "s/sleight_of_hand",
				name: "Sleight of Hand",
				manaCost: { u: 1 },
				types: ["sorcery"],
				amount: 2,
				keep: 1,
			},
			{
				fixture: "i/impulse",
				name: "Impulse",
				manaCost: { n: 1, u: 1 },
				types: ["instant"],
				amount: 4,
				keep: 1,
			},
			{
				fixture: "s/stock_up",
				name: "Stock Up",
				manaCost: { n: 2, u: 1 },
				types: ["sorcery"],
				amount: 5,
				keep: 2,
			},
		] as const;
		for (const expected of cases) {
			const result = importFixture(expected.fixture);
			if (!result.ok) throw new Error(`expected ${expected.name} to import`);
			expect(result.card).toMatchObject({
				name: expected.name,
				manaCost: expected.manaCost,
				types: expected.types,
			});
			expect(result.card.spell?.effects).toEqual([
				{
					kind: "choose-from-top",
					subject: "you",
					amount: expected.amount,
					keep: expected.keep,
				},
			]);
		}
	});

	test("Wrenn's Resolve lowers its complete remembered-exile may-play chain", () => {
		const result = importFixture("w/wrenns_resolve");
		if (!result.ok) throw new Error("expected Wrenn's Resolve to import");
		expect(result.card).toMatchObject({
			id: "wrenns-resolve",
			name: "Wrenn's Resolve",
			types: ["sorcery"],
			colors: ["r"],
			manaCost: { n: 1, r: 1 },
		});
		expect(result.card.spell).toEqual({
			id: "spell-1",
			text: "Exile the top two cards of your library. Until the end of your next turn, you may play those cards.",
			targets: [],
			effects: [
				{
					kind: "exile-top",
					subject: { kind: "relative-player", player: "you" },
					amount: 2,
					resultSlot: "remembered-exile-cards",
				},
				{
					kind: "may-play",
					subject: {
						kind: "effect-result",
						slot: "remembered-exile-cards",
					},
					from: "exile",
					duration: "until-end-of-your-next-turn",
				},
			],
		});
	});

	test("the remembered-exile may-play chain rejects semantic mutations", () => {
		const definition = cardText("w/wrenns_resolve");
		const mutations = [
			["DestinationZone$ Exile", "DestinationZone$ Hand"],
			["RememberChanged$ True", "RememberChanged$ False"],
			["RememberObjects$ RememberedCard", "RememberObjects$ Remembered"],
			["ForgetOnMoved$ Exile", "ForgetOnMoved$ Battlefield"],
			["Duration$ UntilTheEndOfYourNextTurn", "Duration$ UntilEndOfTurn"],
			["MayPlay$ True", "MayPlay$ False"],
			["Affected$ Card.IsRemembered", "Affected$ Card"],
			["AffectedZone$ Exile", "AffectedZone$ Graveyard"],
			["ClearRemembered$ True", "ClearRemembered$ False"],
		] as const;
		for (const [from, to] of mutations) {
			const mutated = definition.replace(from, to);
			expect(mutated, `mutation source ${from}`).not.toBe(definition);
			const result = importForgeCard(mutated, { id: "mutated-wrenns-resolve" });
			expect(result.ok, `${from} -> ${to}`).toBe(false);
		}
	});

	test("a remembered exile Dig without its DB$ Effect consumer rejects", () => {
		const result = importText(
			[
				"Name:Orphaned Remembered Dig",
				"ManaCost:1 R",
				"Types:Sorcery",
				"A:SP$ Dig | Defined$ You | DigNum$ 2 | ChangeNum$ All | DestinationZone$ Exile | RememberChanged$ True | SpellDescription$ x.",
				"Oracle:",
				"",
			].join("\n"),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]).toMatchObject({
			code: "UNSUPPORTED_EFFECT",
			message:
				"remembered exile Dig must be followed immediately by DB$ Effect",
		});
	});

	test("Cloudshift lowers its remembered target through the new exile object", () => {
		const result = importFixture("c/cloudshift");
		if (!result.ok) throw new Error("expected Cloudshift to import");
		expect(result.card).toMatchObject({
			id: "cloudshift",
			name: "Cloudshift",
			types: ["instant"],
			colors: ["w"],
			manaCost: { w: 1 },
		});
		expect(result.card.spell).toEqual({
			id: "spell-1",
			text: "Exile target creature you control, then return that card to the battlefield under your control.",
			targets: [
				{
					id: "target-1",
					min: 1,
					max: 1,
					legal: {
						kind: "permanent",
						predicate: {
							kind: "and",
							predicates: [
								{ kind: "type", type: "creature" },
								{ kind: "controller", player: "you" },
							],
						},
					},
				},
			],
			effects: [
				{
					kind: "change-zone",
					subject: { kind: "target", slot: "target-1" },
					from: "battlefield",
					destination: { zone: "exile" },
					resultSlot: "remembered-zone-change-object",
				},
				{
					kind: "change-zone",
					subject: {
						kind: "effect-result",
						slot: "remembered-zone-change-object",
					},
					from: "exile",
					destination: { zone: "battlefield", controller: "you" },
				},
			],
		});
	});

	test("Cloudshift's remembered target-return chain rejects semantic mutations", () => {
		const definition = cardText("c/cloudshift");
		const mutations = [
			["RememberTargets$ True", "RememberTargets$ False"],
			["RememberTargets$ True", "RememberChanged$ True"],
			["Defined$ Remembered", "Defined$ Targeted"],
			["Origin$ All", "Origin$ Graveyard"],
			["Destination$ Battlefield", "Destination$ Graveyard"],
			["GainControl$ True", "GainControl$ False"],
			["ClearRemembered$ True", "ClearRemembered$ False"],
		] as const;
		for (const [from, to] of mutations) {
			const mutated = definition.replace(from, to);
			expect(mutated, `mutation source ${from}`).not.toBe(definition);
			const result = importForgeCard(mutated, { id: "mutated-cloudshift" });
			expect(result.ok, `${from} -> ${to}`).toBe(false);
		}
	});

	test("a remembered targeted ChangeZone without its return consumer rejects", () => {
		const result = importText(
			[
				"Name:Orphaned Remembered Change",
				"ManaCost:W",
				"Types:Instant",
				"A:SP$ ChangeZone | ValidTgts$ Creature.YouCtrl | Origin$ Battlefield | Destination$ Exile | RememberTargets$ True | SpellDescription$ x.",
				"Oracle:",
				"",
			].join("\n"),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]).toMatchObject({
			code: "UNSUPPORTED_EFFECT",
			message:
				"remembered ChangeZone must be followed immediately by its DB$ ChangeZone return",
		});
	});

	test("Ghostly Flicker stays rejected while multiple targets are unsupported", () => {
		const result = importFixture("g/ghostly_flicker");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]).toMatchObject({
			code: "UNSUPPORTED_PARAMETER",
			message: "unsupported parameter TargetMin",
		});
	});

	test("Dig rejects dynamic, public, random-order, and impossible forms", () => {
		for (const changed of [
			"DigNum$ X | ChangeNum$ 1 | NoReveal$ True",
			"DigNum$ 4 | ChangeNum$ X | NoReveal$ True",
			"DigNum$ 1 | ChangeNum$ 2 | NoReveal$ True",
			"DigNum$ 4 | ChangeNum$ 1 | NoReveal$ False",
			"DigNum$ 4 | ChangeNum$ 1 | Reveal$ True",
			"DigNum$ 4 | ChangeNum$ 1 | NoReveal$ True | RestRandomOrder$ True",
		]) {
			const result = importText(
				`Name:Unsupported Dig\nManaCost:1 U\nTypes:Instant\nA:SP$ Dig | ${changed} | SpellDescription$ x\nOracle:\n`,
			);
			expect(result.ok).toBe(false);
		}
	});

	test("Scry defaults to one and rejects dynamic amounts", () => {
		const defaulted = importText(
			"Name:Default Scry\nManaCost:U\nTypes:Instant\nA:SP$ Scry | SpellDescription$ Scry 1.\nOracle:Scry 1.\n",
		);
		expect(defaulted.ok).toBe(true);
		if (!defaulted.ok) return;
		expect(defaulted.card.spell?.effects).toEqual([
			{
				kind: "scry",
				subject: { kind: "relative-player", player: "you" },
				amount: 1,
			},
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

	test("Surveil mirrors scry and reads Forge's Amount parameter", () => {
		const result = importText(
			"Name:Imported Surveil\nManaCost:U\nTypes:Instant\nA:SP$ Surveil | Amount$ 2 | SpellDescription$ Surveil 2.\nOracle:Surveil 2.\n",
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.card.spell?.effects).toEqual([
			{
				kind: "surveil",
				subject: { kind: "relative-player", player: "you" },
				amount: 2,
			},
		]);

		const defaulted = importText(
			"Name:Default Surveil\nManaCost:U\nTypes:Instant\nA:SP$ Surveil | SpellDescription$ Surveil 1.\nOracle:Surveil 1.\n",
		);
		expect(defaulted.ok).toBe(true);
		if (!defaulted.ok) return;
		expect(defaulted.card.spell?.effects).toEqual([
			{
				kind: "surveil",
				subject: { kind: "relative-player", player: "you" },
				amount: 1,
			},
		]);
	});

	test("Flayed One's ETB mill reads Forge's NumCards parameter", () => {
		const result = importFixture("f/flayed_one");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card.abilityDefinitions.triggered[0]?.effects).toEqual([
			{
				kind: "mill",
				subject: { kind: "relative-player", player: "you" },
				amount: 3,
			},
		]);

		const defaulted = importText(
			"Name:Default Mill\nManaCost:B\nTypes:Instant\nA:SP$ Mill | Defined$ Opponent | SpellDescription$ Target opponent mills a card.\nOracle:x\n",
		);
		expect(defaulted.ok).toBe(true);
		if (!defaulted.ok) return;
		expect(defaulted.card.spell?.effects).toEqual([
			{
				kind: "mill",
				subject: { kind: "relative-player", player: "opponent" },
				amount: 1,
			},
		]);
	});

	test("Mire Triton keeps deathtouch and sequences its complete ETB trigger", () => {
		const result = importFixture("m/mire_triton");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card.keywords).toEqual(["deathtouch"]);
		expect(result.card.abilityDefinitions.triggered).toEqual([
			{
				id: "TrigMill",
				text: expect.any(String),
				condition: {
					kind: "change zone",
					from: "any",
					to: "battlefield",
					predicate: { kind: "self" },
				},
				targets: [],
				effects: [
					{
						kind: "mill",
						subject: { kind: "relative-player", player: "you" },
						amount: 2,
					},
					{
						kind: "gain-life",
						subject: { kind: "relative-player", player: "you" },
						amount: 2,
					},
				],
			},
		]);
	});

	test("Baleful Strix keeps every characteristic and its complete ETB trigger", () => {
		const result = importFixture("b/baleful_strix");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card).toMatchObject({
			name: "Baleful Strix",
			types: ["artifact", "creature"],
			subtypes: ["Bird"],
			colors: ["u", "b"],
			manaCost: { u: 1, b: 1 },
			power: 1,
			toughness: 1,
			keywords: ["flying", "deathtouch"],
		});
		expect(result.card.abilityDefinitions.triggered).toEqual([
			{
				id: "TrigDraw",
				text: "When CARDNAME enters, draw a card.",
				condition: {
					kind: "change zone",
					from: "any",
					to: "battlefield",
					predicate: { kind: "self" },
				},
				targets: [],
				effects: [
					{
						kind: "draw",
						subject: { kind: "relative-player", player: "you" },
						amount: 1,
					},
				],
			},
		]);
	});

	test("Pierce Strider keeps its characteristics and targeted ETB life loss", () => {
		const result = importFixture("p/pierce_strider");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card).toMatchObject({
			name: "Pierce Strider",
			types: ["artifact", "creature"],
			subtypes: ["Phyrexian", "Construct"],
			colors: [],
			manaCost: { n: 4 },
			power: 3,
			toughness: 3,
		});
		expect(result.card.abilityDefinitions.triggered).toEqual([
			{
				id: "TrigLoseLife",
				text: "When CARDNAME enters, target opponent loses 3 life.",
				condition: {
					kind: "change zone",
					from: "any",
					to: "battlefield",
					predicate: { kind: "self" },
				},
				targets: [
					{
						id: "target-1",
						min: 1,
						max: 1,
						legal: { kind: "player", player: "opponent" },
					},
				],
				effects: [
					{
						kind: "lose-life",
						subject: { kind: "target-player", slot: "target-1" },
						amount: 3,
					},
				],
			},
		]);
	});

	test("Etched Familiar keeps its characteristics and complete dies trigger", () => {
		const result = importFixture("e/etched_familiar");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card).toMatchObject({
			name: "Etched Familiar",
			types: ["artifact", "creature"],
			subtypes: ["Phyrexian", "Fox"],
			colors: ["b"],
			manaCost: { n: 2, b: 1 },
			power: 3,
			toughness: 2,
		});
		expect(result.card.abilityDefinitions.triggered).toEqual([
			{
				id: "TrigLoseLife",
				text: "When CARDNAME dies, each opponent loses 2 life and you gain 2 life.",
				condition: {
					kind: "change zone",
					from: "battlefield",
					to: "graveyard",
					predicate: { kind: "self" },
				},
				targets: [],
				effects: [
					{
						kind: "lose-life",
						subject: { kind: "relative-player", player: "opponent" },
						amount: 2,
					},
					{
						kind: "gain-life",
						subject: { kind: "relative-player", player: "you" },
						amount: 2,
					},
				],
			},
		]);
	});

	test("Sorin's Thirst sequences damage then life gain in one target slot", () => {
		const result = importFixture("s/sorins_thirst");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card.spell?.targets).toHaveLength(1);
		expect(result.card.spell?.effects).toEqual([
			{
				kind: "damage",
				subject: { kind: "target", slot: "target-1" },
				amount: 2,
			},
			{
				kind: "gain-life",
				subject: { kind: "relative-player", player: "you" },
				amount: 2,
			},
		]);
	});

	test("Thraben Inspector keeps its characteristics and investigates when it enters", () => {
		const result = importFixture("t/thraben_inspector");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card).toMatchObject({
			name: "Thraben Inspector",
			types: ["creature"],
			subtypes: ["Human", "Soldier"],
			colors: ["w"],
			manaCost: { w: 1 },
			power: 1,
			toughness: 2,
		});
		const trigger = result.card.abilityDefinitions.triggered[0];
		expect(trigger).toEqual({
			id: "TrigInvestigate",
			text: 'When CARDNAME enters, investigate. (Create a Clue token. It\'s an artifact with "{2}, Sacrifice this token: Draw a card.")',
			condition: {
				kind: "change zone",
				from: "any",
				to: "battlefield",
				predicate: { kind: "self" },
			},
			targets: [],
			effects: [
				{
					kind: "create-token",
					controller: "you",
					characteristics: CLUE_TOKEN,
					amount: 1,
				},
			],
		});
		if (trigger?.effects[0]?.kind !== "create-token") {
			throw new Error("expected a create-token effect");
		}
		expect(trigger.effects[0].characteristics).not.toBe(CLUE_TOKEN);
	});

	test("Investigate rejects parameters outside the supported one-Clue form", () => {
		for (const parameter of ["Num$ 2", "Defined$ Opponent"]) {
			const result = importText(
				[
					"Name:Decorated Investigator",
					"ManaCost:W",
					"Types:Creature Human Soldier",
					"PT:1/2",
					"T:Mode$ ChangesZone | Origin$ Any | Destination$ Battlefield | ValidCard$ Card.Self | Execute$ TrigInvestigate | TriggerDescription$ x",
					`SVar:TrigInvestigate:DB$ Investigate | ${parameter}`,
					"Oracle:",
					"",
				].join("\n"),
			);
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.diagnostics[0]).toMatchObject({
				code: "UNSUPPORTED_PARAMETER",
			});
		}
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
					predicate: { kind: "self" },
				},
				targets: [],
				effects: [
					{
						kind: "gain-life",
						subject: { kind: "relative-player", player: "you" },
						amount: 3,
					},
				],
			},
		]);
	});

	test("Priest of Ancient Lore defaults an omitted ChangesZone origin to any", () => {
		const result = importFixture("p/priest_of_ancient_lore");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card.abilityDefinitions.triggered).toEqual([
			{
				id: "TrigLife",
				text: expect.any(String),
				condition: {
					kind: "change zone",
					from: "any",
					to: "battlefield",
					predicate: { kind: "self" },
				},
				targets: [],
				effects: [
					{
						kind: "gain-life",
						subject: { kind: "relative-player", player: "you" },
						amount: 1,
					},
					{
						kind: "draw",
						subject: { kind: "relative-player", player: "you" },
						amount: 1,
					},
				],
			},
		]);

		const unsupportedOrigin = importForgeCard(
			cardText("p/priest_of_ancient_lore").replace(
				"Mode$ ChangesZone |",
				"Mode$ ChangesZone | Origin$ Graveyard |",
			),
			{ id: "priest-with-graveyard-origin" },
		);
		expect(unsupportedOrigin.ok).toBe(false);
		if (unsupportedOrigin.ok) return;
		expect(unsupportedOrigin.diagnostics[0]).toMatchObject({
			code: "UNSUPPORTED_EFFECT",
			message: "unsupported ChangesZone trigger shape",
		});
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
						effects: [
							{
								kind: "gain-life",
								subject: { kind: "relative-player", player: "you" },
								amount: 1,
							},
						],
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
						subject: "triggering-player",
					},
				],
			},
		]);
	});

	test("Seizan keeps TriggeredPlayer through its SubAbility chain", () => {
		const result = importFixture("s/seizan_perverter_of_truth");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card.abilityDefinitions.triggered[0]?.effects).toEqual([
			{
				kind: "lose-life",
				subject: { kind: "relative-player", player: "triggering-player" },
				amount: 2,
			},
			{
				kind: "draw",
				subject: { kind: "relative-player", player: "triggering-player" },
				amount: 2,
			},
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
				condition: { kind: "declare attackers", predicate: { kind: "self" } },
				targets: [],
				effects: [
					{
						kind: "gain-life",
						subject: { kind: "relative-player", player: "you" },
						amount: 2,
					},
				],
			},
		]);
	});

	test("Pegasus Courser targets another attacking creature", () => {
		const result = importFixture("p/pegasus_courser");
		if (!result.ok) throw new Error("expected Pegasus Courser to import");
		expect(result.card).toMatchObject({
			name: "Pegasus Courser",
			manaCost: { n: 2, w: 1 },
			power: 1,
			toughness: 3,
			keywords: ["flying"],
		});
		expect(result.card.abilityDefinitions.triggered).toEqual([
			{
				id: "TrigPump",
				text: expect.any(String),
				condition: { kind: "declare attackers", predicate: { kind: "self" } },
				targets: [
					{
						id: "target-1",
						min: 1,
						max: 1,
						legal: {
							kind: "permanent",
							predicate: {
								kind: "and",
								predicates: [
									{ kind: "type", type: "creature" },
									{ kind: "not", predicate: { kind: "self" } },
									{ kind: "attacking" },
								],
							},
						},
					},
				],
				effects: [
					{
						kind: "grant-keyword",
						subject: { kind: "target", slot: "target-1" },
						keyword: "flying",
						duration: "until-end-of-turn",
					},
				],
			},
		]);
	});

	test("Stealer of Secrets keeps its self combat-damage trigger", () => {
		const result = importFixture("s/stealer_of_secrets");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card.abilityDefinitions.triggered).toEqual([
			{
				id: "TrigDraw",
				text: expect.any(String),
				condition: {
					kind: "damage",
					source: "self",
					recipient: "player",
					combat: true,
				},
				targets: [],
				effects: [
					{
						kind: "draw",
						subject: { kind: "relative-player", player: "you" },
						amount: 1,
					},
				],
			},
		]);
	});

	test("Giant Spider keeps Reach", () => {
		const result = importFixture("g/giant_spider");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card.keywords).toEqual(["reach"]);
	});

	test("Beast Whisperer lowers only the supported typed cast trigger", () => {
		const result = importFixture("b/beast_whisperer");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card.abilityDefinitions.triggered).toEqual([
			{
				id: "TrigDraw",
				text: expect.any(String),
				condition: {
					kind: "cast",
					player: "you",
					predicate: { kind: "type", type: "creature" },
				},
				targets: [],
				effects: [
					{
						kind: "draw",
						subject: { kind: "relative-player", player: "you" },
						amount: 1,
					},
				],
			},
		]);
	});

	test("self PutCounter lowers to a source-counter effect", () => {
		const result = importFixture("d/deeproot_champion");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card.abilityDefinitions.triggered).toEqual([
			{
				id: "TrigPutCounter",
				text: expect.any(String),
				condition: {
					kind: "cast",
					player: "you",
					predicate: {
						kind: "not",
						predicate: { kind: "type", type: "creature" },
					},
				},
				targets: [],
				effects: [
					{
						kind: "add counters",
						subject: { kind: "source" },
						counter: "+1/+1",
						amount: 1,
					},
				],
			},
		]);
	});

	test("Timberland Guide lowers its targeted PutCounter ETB trigger", () => {
		const result = importFixture("t/timberland_guide");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card.abilityDefinitions.triggered).toEqual([
			{
				id: "GoodWood",
				text: expect.any(String),
				condition: {
					kind: "change zone",
					from: "any",
					to: "battlefield",
					predicate: { kind: "self" },
				},
				targets: [
					{
						id: "target-1",
						min: 1,
						max: 1,
						legal: {
							kind: "permanent",
							predicate: { kind: "type", type: "creature" },
						},
					},
				],
				effects: [
					{
						kind: "add counters",
						subject: { kind: "target", slot: "target-1" },
						counter: "+1/+1",
						amount: 1,
					},
				],
			},
		]);
	});

	test("PutCounter rejects ambiguous targeted and Defined subjects", () => {
		const result = importText(
			`Name:Ambiguous Counter\nManaCost:G\nTypes:Instant\nA:SP$ PutCounter | ValidTgts$ Creature | Defined$ Self | CounterType$ P1P1 | CounterNum$ 1 | SpellDescription$ x\nOracle:\n`,
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]?.message).toBe(
			"targeted PutCounter cannot also use Defined$",
		);
	});

	test("PutCounter's omitted subject default is not applied to a spell", () => {
		const result = importText(
			`Name:Subjectless Counter\nManaCost:G\nTypes:Instant\nA:SP$ PutCounter | CounterType$ P1P1 | CounterNum$ 1 | SpellDescription$ x\nOracle:\n`,
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]?.message).toBe(
			"unsupported non-targeted PutCounter subject",
		);
	});

	test("Student of Ojutai lowers its noncreature cast trigger", () => {
		const result = importFixture("s/student_of_ojutai");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card.abilityDefinitions.triggered).toEqual([
			{
				id: "TrigGainLife",
				text: expect.any(String),
				condition: {
					kind: "cast",
					player: "you",
					predicate: {
						kind: "not",
						predicate: { kind: "type", type: "creature" },
					},
				},
				targets: [],
				effects: [
					{
						kind: "gain-life",
						subject: { kind: "relative-player", player: "you" },
						amount: 2,
					},
				],
			},
		]);
	});

	test("Lorescale Coatl lowers its Drawn trigger to the drawing player", () => {
		const result = importFixture("l/lorescale_coatl");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card.abilityDefinitions.triggered).toEqual([
			{
				id: "TrigPutCounter",
				text: expect.any(String),
				condition: { kind: "draw", player: "you" },
				targets: [],
				effects: [
					{
						kind: "add counters",
						subject: { kind: "source" },
						counter: "+1/+1",
						amount: 1,
					},
				],
			},
		]);
	});

	test("a graveyard Drawn trigger can only reanimate its source", () => {
		const result = importText(
			`Name:Cellar Coatl\nManaCost:1 G U\nTypes:Creature Snake\nPT:2/2\nT:Mode$ Drawn | ValidCard$ Card.YouCtrl | TriggerZones$ Graveyard | Execute$ TrigPutCounter | TriggerDescription$ x\nSVar:TrigPutCounter:DB$ PutCounter | Defined$ Self | CounterType$ P1P1 | CounterNum$ 1\nOracle:\n`,
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]?.message).toBe(
			"a graveyard Drawn trigger can only reanimate its source",
		);
	});

	test("a Drawn trigger outside the battlefield and graveyard is rejected", () => {
		const result = importText(
			`Name:Sky Coatl\nManaCost:1 G U\nTypes:Creature Snake\nPT:2/2\nT:Mode$ Drawn | ValidCard$ Card.YouCtrl | TriggerZones$ Exile | Execute$ TrigPutCounter | TriggerDescription$ x\nSVar:TrigPutCounter:DB$ PutCounter | Defined$ Self | CounterType$ P1P1 | CounterNum$ 1\nOracle:\n`,
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]?.message).toBe(
			"only battlefield and graveyard Drawn triggers are supported",
		);
	});

	test("Sneaky Snacker lowers a graveyard Drawn trigger to a self reanimation", () => {
		const result = importFixture("s/sneaky_snacker");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card.abilityDefinitions.triggered).toEqual([
			{
				id: "TrigChange",
				text: expect.any(String),
				condition: { kind: "draw", player: "you", qualifier: { nth: 3 } },
				functionsFrom: ["graveyard"],
				targets: [],
				effects: [
					{
						kind: "change-zone",
						subject: { kind: "source" },
						from: "graveyard",
						destination: {
							zone: "battlefield",
							controller: "owner",
							tapped: true,
						},
					},
				],
			},
		]);
	});

	test("a Drawn FirstCardInDrawStep$ False trigger lowers to the draw-step qualifier", () => {
		const result = importText(
			`Name:Fang Coatl\nManaCost:1 G U\nTypes:Creature Snake\nPT:2/2\nT:Mode$ Drawn | ValidCard$ Card.OppOwn | FirstCardInDrawStep$ False | TriggerZones$ Battlefield | Execute$ TrigDraw | TriggerDescription$ x\nSVar:TrigDraw:DB$ Draw | Defined$ You | NumCards$ 1\nOracle:\n`,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.card.abilityDefinitions.triggered).toEqual([
			{
				id: "TrigDraw",
				text: expect.any(String),
				condition: {
					kind: "draw",
					player: "opponent",
					qualifier: "except-first-in-draw-step",
				},
				targets: [],
				effects: [
					{
						kind: "draw",
						subject: { kind: "relative-player", player: "you" },
						amount: 1,
					},
				],
			},
		]);
	});

	test("a Drawn FirstCardInDrawStep$ True trigger is rejected", () => {
		const result = importText(
			`Name:First Coatl\nManaCost:1 G U\nTypes:Creature Snake\nPT:2/2\nT:Mode$ Drawn | ValidCard$ Card.OppOwn | FirstCardInDrawStep$ True | TriggerZones$ Battlefield | Execute$ TrigDraw | TriggerDescription$ x\nSVar:TrigDraw:DB$ Draw | Defined$ You | NumCards$ 1\nOracle:\n`,
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]?.message).toBe(
			"only FirstCardInDrawStep$ False is supported",
		);
	});

	test("a Drawn trigger cannot combine Number$ and FirstCardInDrawStep$", () => {
		const result = importText(
			`Name:Greedy Coatl\nManaCost:1 G U\nTypes:Creature Snake\nPT:2/2\nT:Mode$ Drawn | ValidCard$ Card.OppOwn | Number$ 2 | FirstCardInDrawStep$ False | TriggerZones$ Battlefield | Execute$ TrigDraw | TriggerDescription$ x\nSVar:TrigDraw:DB$ Draw | Defined$ You | NumCards$ 1\nOracle:\n`,
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]?.message).toBe(
			"a Drawn trigger cannot combine Number$ and FirstCardInDrawStep$",
		);
	});

	test("a Drawn trigger's unsupported ValidCard$ is rejected", () => {
		const result = importText(
			`Name:Picky Coatl\nManaCost:1 G U\nTypes:Creature Snake\nPT:2/2\nT:Mode$ Drawn | ValidCard$ Card.Land | TriggerZones$ Battlefield | Execute$ TrigPutCounter | TriggerDescription$ x\nSVar:TrigPutCounter:DB$ PutCounter | Defined$ Self | CounterType$ P1P1 | CounterNum$ 1\nOracle:\n`,
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]?.message).toBe(
			"unsupported Drawn ValidCard$ Card.Land",
		);
	});

	test("Kambal maps SpellCast TriggeredActivator to the casting player", () => {
		const result = importFixture("k/kambal_consul_of_allocation");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card.abilityDefinitions.triggered).toEqual([
			{
				id: "TrigDrain",
				text: expect.any(String),
				condition: {
					kind: "cast",
					player: "opponent",
					predicate: {
						kind: "not",
						predicate: { kind: "type", type: "creature" },
					},
				},
				targets: [],
				effects: [
					{
						kind: "lose-life",
						subject: { kind: "relative-player", player: "triggering-player" },
						amount: 2,
					},
					{
						kind: "gain-life",
						subject: { kind: "relative-player", player: "you" },
						amount: 2,
					},
				],
			},
		]);
	});

	test("Forced Fruition watches every spell an opponent casts", () => {
		const result = importFixture("f/forced_fruition");
		if (!result.ok) throw new Error("expected ok");
		// `ValidCard$ Card` names no restriction, so the condition carries no
		// selector: any spell cast by an opponent matches.
		expect(result.card.abilityDefinitions.triggered).toEqual([
			{
				id: "TrigDraw",
				text: expect.any(String),
				condition: { kind: "cast", player: "opponent" },
				targets: [],
				effects: [
					{
						kind: "draw",
						subject: { kind: "relative-player", player: "triggering-player" },
						amount: 7,
					},
				],
			},
		]);
	});

	test("SpellCast lowers an omitted or bare-Card ValidCard$ to an unrestricted condition", () => {
		const card = (validCard: string) =>
			[
				"Name:Cast Watcher",
				"ManaCost:1 U",
				"Types:Enchantment",
				`T:Mode$ SpellCast ${validCard} | ValidActivatingPlayer$ You | TriggerZones$ Battlefield | Execute$ Trig | TriggerDescription$ x`,
				"SVar:Trig:DB$ Draw | Defined$ You | NumCards$ 1",
				"Oracle:",
				"",
			].join("\n");

		// Both an omitted `ValidCard$` and the bare `Card` spelling watch every
		// spell cast, so neither lowers a selector onto the condition.
		for (const validCard of ["", "| ValidCard$ Card"]) {
			const result = importText(card(validCard));
			if (!result.ok) throw new Error(`expected ${validCard} to import`);
			expect(result.card.abilityDefinitions.triggered[0]?.condition).toEqual({
				kind: "cast",
				player: "you",
			});
		}
	});

	test("Staff of the Death Magus lowers both object-selected triggers", () => {
		const result = importFixture("s/staff_of_the_death_magus");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card.abilityDefinitions.triggered).toEqual([
			{
				id: "TrigGainLife",
				text: expect.any(String),
				condition: {
					kind: "cast",
					player: "you",
					predicate: { kind: "color", color: "b" },
				},
				targets: [],
				effects: [
					{
						kind: "gain-life",
						subject: { kind: "relative-player", player: "you" },
						amount: 1,
					},
				],
			},
			{
				id: "TrigGainLife",
				text: expect.any(String),
				condition: {
					kind: "change zone",
					from: "any",
					to: "battlefield",
					predicate: {
						kind: "and",
						predicates: [
							{ kind: "subtype", subtype: "Swamp" },
							{ kind: "controller", player: "you" },
						],
					},
				},
				targets: [],
				effects: [
					{
						kind: "gain-life",
						subject: { kind: "relative-player", player: "you" },
						amount: 1,
					},
				],
			},
		]);
	});

	test("SpellCast lowers supported object selectors", () => {
		const card = (selector: string) =>
			[
				"Name:Cast Watcher",
				"ManaCost:1 U",
				"Types:Enchantment",
				`T:Mode$ SpellCast | ValidCard$ ${selector} | ValidActivatingPlayer$ You | TriggerZones$ Battlefield | Execute$ Trig | TriggerDescription$ x`,
				"SVar:Trig:DB$ Draw | Defined$ You | NumCards$ 1",
				"Oracle:",
				"",
			].join("\n");

		for (const [forgeSelector, selector] of [
			[
				"Instant,Sorcery",
				{
					kind: "or",
					predicates: [
						{ kind: "type", type: "instant" },
						{ kind: "type", type: "sorcery" },
					],
				},
			],
			[
				"Artifact.Creature",
				{
					kind: "and",
					predicates: [
						{ kind: "type", type: "artifact" },
						{ kind: "type", type: "creature" },
					],
				},
			],
			[
				"Card.nonCreature",
				{
					kind: "not",
					predicate: { kind: "type", type: "creature" },
				},
			],
			["Card.Black", { kind: "color", color: "b" }],
		] as const) {
			const result = importText(card(forgeSelector));
			if (!result.ok) throw new Error(`expected ${forgeSelector} to import`);
			expect<unknown>(
				result.card.abilityDefinitions.triggered[0]?.condition,
			).toEqual({
				kind: "cast",
				player: "you",
				predicate: selector,
			});
		}
	});

	test("SpellCast rejects broad and decorated Forge selectors", () => {
		const card = (selector: string) =>
			[
				"Name:Cast Watcher",
				"ManaCost:1 U",
				"Types:Enchantment",
				`T:Mode$ SpellCast | ValidCard$ ${selector} | ValidActivatingPlayer$ You | TriggerZones$ Battlefield | Execute$ Trig | TriggerDescription$ x`,
				"SVar:Trig:DB$ Draw | Defined$ You | NumCards$ 1",
				"Oracle:",
				"",
			].join("\n");

		for (const selector of ["Permanent", "Creature.cmcGE5"]) {
			const result = importText(card(selector));
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.diagnostics[0]?.message).toBe(
				"SpellCast requires a supported ValidCard$ selector",
			);
		}
	});

	test("Third Path Iconoclast embeds characteristics from its token script", () => {
		const result = importFixture("t/third_path_iconoclast");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card.abilityDefinitions.triggered[0]?.effects).toEqual([
			{
				kind: "create-token",
				controller: "you",
				amount: 1,
				characteristics: {
					kind: "creature",
					name: "Soldier Token",
					manaCost: "none",
					colors: [],
					supertypes: [],
					types: ["artifact", "creature"],
					subtypes: ["Soldier"],
					keywords: [],
					abilities: {
						static: [],
						activated: [],
						triggered: [],
						replacement: [],
						prohibition: [],
					},
					power: 1,
					toughness: 1,
				},
			},
		]);
	});

	test("a missing TokenScript$ reference is an invariant failure", () => {
		const text = [
			"Name:Missing Token Maker",
			"ManaCost:1 W",
			"Types:Sorcery",
			"A:SP$ Token | TokenScript$ token_script_that_is_not_vendored",
			"Oracle:",
			"",
		].join("\n");
		expect(() => importForgeCard(text, { id: "missing-token-maker" })).toThrow(
			"missing Forge token script token_script_that_is_not_vendored",
		);
	});

	test("Wall of Omens keeps Defender and its entry trigger", () => {
		const result = importFixture("w/wall_of_omens");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card.keywords).toEqual(["defender"]);
		expect(result.card.abilityDefinitions.triggered).toEqual([
			{
				id: "TrigDraw",
				text: "When CARDNAME enters, draw a card.",
				condition: {
					kind: "change zone",
					from: "any",
					to: "battlefield",
					predicate: { kind: "self" },
				},
				targets: [],
				effects: [
					{
						kind: "draw",
						subject: { kind: "relative-player", player: "you" },
						amount: 1,
					},
				],
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

	test("Samurai of the Pale Curtain lowers bushido and its exile replacement", () => {
		const result = importFixture("s/samurai_of_the_pale_curtain");
		if (!result.ok) throw new Error("expected the Samurai to import");
		expect(result.card.keywords).toEqual(["bushido 1"]);
		// The keyword is authoring shorthand: `defineCard` turns it into a real
		// registered trigger, which is what the card actually prints.
		expect(result.card.abilityDefinitions.triggered).toEqual([
			{
				id: "bushido 1",
				text: "Whenever this creature blocks or becomes blocked, it gets +1/+1 until end of turn.",
				condition: {
					kind: "declare blockers",
					subject: "self blocks or becomes blocked",
				},
				targets: [],
				effects: [
					{
						kind: "modify-pt",
						subject: { kind: "source" },
						power: 1,
						toughness: 1,
						duration: "until-end-of-turn",
					},
				],
			},
		]);
		expect(result.card.abilityDefinitions.replacement).toHaveLength(1);
		expect(result.card.abilityDefinitions.replacement[0]).toMatchObject({
			layer: "other",
			functionsFrom: "any",
			text: "If a permanent would be put into a graveyard, exile it instead.",
		});
	});

	test("Bushido without exactly one positive amount is rejected", () => {
		for (const keyword of [
			"Bushido",
			"Bushido:0",
			"Bushido:1:2",
			"Bushido:x",
		]) {
			const result = importText(
				`Name:Ronin\nManaCost:1 W\nTypes:Creature Human Samurai\nPT:2/2\nK:${keyword}\nOracle:\n`,
			);
			expect(result.ok, keyword).toBe(false);
			if (result.ok) return;
			expect(result.diagnostics[0]).toMatchObject({
				code: "UNSUPPORTED_KEYWORD",
				message: `unsupported keyword: ${keyword}`,
			});
		}
	});

	test("a graveyard replacement that does not exile from the battlefield is rejected", () => {
		const CURTAIN = [
			"Name:Pale Curtain",
			"ManaCost:W W",
			"Types:Creature Fox",
			"PT:2/2",
			"R:Event$ Moved | ActiveZones$ Battlefield | Origin$ Battlefield | Destination$ Graveyard | ValidCard$ Permanent | ReplaceWith$ Exile | Description$ x",
			"SVar:Exile:DB$ ChangeZone | Origin$ Battlefield | Destination$ Exile | Defined$ ReplacedCard",
			"Oracle:",
			"",
		].join("\n");
		expect(importText(CURTAIN).ok, "the canonical form imports").toBe(true);

		for (const [what, mutated] of [
			[
				"a non-battlefield origin",
				CURTAIN.replace("Origin$ Battlefield |", "Origin$ Hand |"),
			],
			[
				"a body sending it elsewhere",
				CURTAIN.replace("Destination$ Exile", "Destination$ Hand"),
			],
			[
				"a body moving something else",
				CURTAIN.replace("Defined$ ReplacedCard", "Defined$ Self"),
			],
			[
				"a replacement outside the battlefield",
				CURTAIN.replace("ActiveZones$ Battlefield | ", ""),
			],
		] as const) {
			const result = importText(mutated);
			expect(result.ok, what).toBe(false);
			if (result.ok) return;
			expect(result.diagnostics[0]?.code, what).toBe("UNSUPPORTED_EFFECT");
		}
	});

	test("Clone lowers its exact optional creature-copy entry replacement", () => {
		const result = importFixture("c/clone");
		if (!result.ok) throw new Error("expected Clone to lower");
		expect(result.card.abilityDefinitions.replacement).toHaveLength(1);
		expect(result.card.abilityDefinitions.replacement[0]).toMatchObject({
			layer: "copy",
			functionsFrom: "any",
			text: "You may have CARDNAME enter as a copy of any creature on the battlefield.",
		});
	});

	test("Copy Artifact lowers its artifact selector and enchantment exception", () => {
		const result = importFixture("c/copy_artifact");
		if (!result.ok) throw new Error("expected Copy Artifact to lower");
		expect(result.card.abilityDefinitions.replacement).toHaveLength(1);
		expect(result.card.abilityDefinitions.replacement[0]).toMatchObject({
			layer: "copy",
			functionsFrom: "any",
			text: "You may have CARDNAME enter as a copy of any artifact on the battlefield, except it's an enchantment in addition to its other types.",
		});
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

	test("Jewel Thief lowers trample and its ability-bearing Treasure token", () => {
		const result = importFixture("j/jewel_thief");
		if (!result.ok) throw new Error("expected Jewel Thief to import");

		expect(result.card).toMatchObject({
			name: "Jewel Thief",
			manaCost: { n: 2, g: 1 },
			types: ["creature"],
			subtypes: ["Cat", "Rogue"],
			colors: ["g"],
			power: 3,
			toughness: 3,
			keywords: ["vigilance", "trample"],
			printedAbilities: {
				activated: [],
				triggered: ["jewel-thief:0"],
			},
		});
		expect(result.card.abilityDefinitions.activated).toEqual([
			{
				kind: "mana",
				id: "activated-1",
				text: "Add one mana of any color.",
				cost: {
					mana: "zero",
					tapSelf: true,
					sacrifice: { predicate: { kind: "self" }, amount: 1 },
				},
				manaOptions: [
					{ w: 1, u: 0, b: 0, r: 0, g: 0, c: 0 },
					{ w: 0, u: 1, b: 0, r: 0, g: 0, c: 0 },
					{ w: 0, u: 0, b: 1, r: 0, g: 0, c: 0 },
					{ w: 0, u: 0, b: 0, r: 1, g: 0, c: 0 },
					{ w: 0, u: 0, b: 0, r: 0, g: 1, c: 0 },
				],
			},
		]);
		expect(result.card.abilityDefinitions.triggered).toEqual([
			expect.objectContaining({
				condition: {
					kind: "change zone",
					from: "any",
					to: "battlefield",
					predicate: { kind: "self" },
				},
				effects: [
					expect.objectContaining({
						kind: "create-token",
						controller: "you",
						amount: 1,
						characteristics: expect.objectContaining({
							name: "Treasure Token",
							types: ["artifact"],
							subtypes: ["Treasure"],
							abilities: expect.objectContaining({
								activated: ["jewel-thief:0"],
							}),
						}),
					}),
				],
			}),
		]);
	});

	test("Blood Servitor hosts its Blood token's discard-cost ability", () => {
		const result = importFixture("b/blood_servitor");
		if (!result.ok) throw new Error("expected Blood Servitor to import");

		expect(result.card.printedAbilities.activated.map(String)).toEqual([]);
		expect(result.card.abilityDefinitions.activated).toEqual([
			{
				kind: "activated",
				id: "activated-1",
				text: "Draw a card.",
				cost: {
					mana: { n: 1 },
					tapSelf: true,
					sacrifice: { predicate: { kind: "self" }, amount: 1 },
					discard: { amount: 1 },
				},
				targets: [],
				effects: [
					{
						kind: "draw",
						subject: { kind: "relative-player", player: "you" },
						amount: 1,
					},
				],
			},
		]);
	});

	test("a discard cost's optional trailing description is ignored", () => {
		const result = importText(
			"Name:Pitcher\nManaCost:1 U\nTypes:Artifact\nA:AB$ Draw | Cost$ 1 Discard<1/Card/card> | NumCards$ 1 | SpellDescription$ x\nOracle:\n",
		);
		if (!result.ok) throw new Error("expected ok");
		expect(result.card.abilityDefinitions.activated[0]?.cost).toEqual({
			mana: { n: 1 },
			tapSelf: false,
			discard: { amount: 1 },
		});
	});

	test("only Forge's one-card-of-any-kind discard cost is supported", () => {
		for (const cost of [
			"Discard<2/Card>",
			"Discard<1/Creature>",
			"Discard<1/CARDNAME>",
			"Discard<1/Random>",
			"Discard<1>",
			"Discard<1/Card> Discard<1/Card>",
		]) {
			const result = importText(
				`Name:Pitcher\nManaCost:1 U\nTypes:Artifact\nA:AB$ Draw | Cost$ 1 ${cost} | NumCards$ 1 | SpellDescription$ x\nOracle:\n`,
			);
			expect(result.ok, cost).toBe(false);
			if (result.ok) return;
			expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_COST");
		}
	});

	test("Sweettooth Witch hosts its Food token's non-mana ability", () => {
		const result = importFixture("s/sweettooth_witch");
		if (!result.ok) throw new Error("expected Sweettooth Witch to import");

		// Index 0 is the Food's hosted ability and index 1 the Witch's own, so
		// only the latter is printed on the Witch itself.
		expect(result.card.printedAbilities.activated.map(String)).toEqual([
			"sweettooth-witch:1",
		]);
		expect(result.card.abilityDefinitions.activated[0]).toEqual({
			kind: "activated",
			id: "activated-1",
			text: "You gain 3 life.",
			cost: {
				mana: { n: 2 },
				tapSelf: true,
				sacrifice: { predicate: { kind: "self" }, amount: 1 },
			},
			targets: [],
			effects: [
				{
					kind: "gain-life",
					subject: { kind: "relative-player", player: "you" },
					amount: 3,
				},
			],
		});
		expect(result.card.abilityDefinitions.triggered[0]?.effects).toEqual([
			{
				kind: "create-token",
				controller: "you",
				amount: 1,
				characteristics: expect.objectContaining({
					name: "Food Token",
					types: ["artifact"],
					subtypes: ["Food"],
					abilities: expect.objectContaining({
						activated: ["sweettooth-witch:0"],
					}),
				}),
			},
		]);
	});

	test("a token script's triggered ability still has no host to lower onto", () => {
		const result = importText(
			[
				"Name:Bad Token Maker",
				"ManaCost:1 G",
				"Types:Creature Human",
				"PT:1/1",
				"T:Mode$ ChangesZone | Origin$ Any | Destination$ Battlefield | ValidCard$ Card.Self | Execute$ TrigToken | TriggerDescription$ x",
				"SVar:TrigToken:DB$ Token | TokenScript$ bg_1_1_pest_lifegain | TokenOwner$ You",
				"Oracle:",
				"",
			].join("\n"),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]?.message).toBe(
			"Forge token script bg_1_1_pest_lifegain has unsupported abilities",
		);
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
				effects: [
					{
						kind: "gain-life",
						subject: { kind: "relative-player", player: "you" },
						amount: 1,
					},
				],
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
						predicate: { kind: "type", type: "creature" },
						amount: 1,
					},
				},
				targets: [],
				effects: [
					{
						kind: "scry",
						subject: { kind: "relative-player", player: "you" },
						amount: 1,
					},
				],
			},
		]);
	});

	test("Thrashing Brontodon lowers its complete sacrifice-to-destroy ability", () => {
		const result = importFixture("t/thrashing_brontodon");
		if (!result.ok) throw new Error("expected Thrashing Brontodon to import");
		expect(result.card).toMatchObject({
			name: "Thrashing Brontodon",
			manaCost: { n: 1, g: 2 },
			types: ["creature"],
			subtypes: ["Dinosaur"],
			power: 3,
			toughness: 4,
		});
		expect(result.card.abilityDefinitions.activated).toEqual([
			{
				kind: "activated",
				id: "activated-1",
				text: "Destroy target artifact or enchantment.",
				cost: {
					mana: { n: 1 },
					tapSelf: false,
					sacrifice: { predicate: { kind: "self" }, amount: 1 },
				},
				targets: [
					{
						id: "target-1",
						min: 1,
						max: 1,
						legal: {
							kind: "permanent",
							predicate: {
								kind: "or",
								predicates: [
									{ kind: "type", type: "artifact" },
									{ kind: "type", type: "enchantment" },
								],
							},
						},
					},
				],
				effects: [
					{ kind: "destroy", subject: { kind: "target", slot: "target-1" } },
				],
			},
		]);
	});

	test("Cathar Commando lowers Flash and its complete sacrifice-to-destroy ability", () => {
		const result = importFixture("c/cathar_commando");
		if (!result.ok) throw new Error("expected Cathar Commando to import");
		expect(result.card).toMatchObject({
			name: "Cathar Commando",
			manaCost: { n: 1, w: 1 },
			types: ["creature"],
			subtypes: ["Human", "Soldier"],
			keywords: ["flash"],
			power: 3,
			toughness: 1,
		});
		expect(result.card.abilityDefinitions.activated).toEqual([
			{
				kind: "activated",
				id: "activated-1",
				text: "Destroy target artifact or enchantment.",
				cost: {
					mana: { n: 1 },
					tapSelf: false,
					sacrifice: { predicate: { kind: "self" }, amount: 1 },
				},
				targets: [
					{
						id: "target-1",
						min: 1,
						max: 1,
						legal: {
							kind: "permanent",
							predicate: {
								kind: "or",
								predicates: [
									{ kind: "type", type: "artifact" },
									{ kind: "type", type: "enchantment" },
								],
							},
						},
					},
				],
				effects: [
					{ kind: "destroy", subject: { kind: "target", slot: "target-1" } },
				],
			},
		]);
	});

	test("Resolute Reinforcements lowers Flash and its complete token trigger", () => {
		const result = importFixture("r/resolute_reinforcements");
		if (!result.ok)
			throw new Error("expected Resolute Reinforcements to import");
		expect(result.card).toMatchObject({
			name: "Resolute Reinforcements",
			manaCost: { n: 1, w: 1 },
			types: ["creature"],
			subtypes: ["Human", "Soldier"],
			keywords: ["flash"],
			power: 1,
			toughness: 1,
		});
		expect(result.card.abilityDefinitions.triggered).toEqual([
			{
				id: "TrigToken",
				text: "When CARDNAME enters, create a 1/1 white Soldier creature token.",
				condition: {
					kind: "change zone",
					from: "any",
					to: "battlefield",
					predicate: { kind: "self" },
				},
				targets: [],
				effects: [
					{
						kind: "create-token",
						controller: "you",
						amount: 1,
						characteristics: {
							kind: "creature",
							name: "Soldier Token",
							manaCost: "none",
							colors: ["w"],
							supertypes: [],
							types: ["creature"],
							subtypes: ["Soldier"],
							keywords: [],
							abilities: {
								static: [],
								activated: [],
								triggered: [],
								replacement: [],
								prohibition: [],
							},
							power: 1,
							toughness: 1,
						},
					},
				],
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
				predicate: {
					kind: "and",
					predicates: [
						{ kind: "type", type: "creature" },
						{ kind: "not", predicate: { kind: "self" } },
					],
				},
				amount: 1,
			},
		});
	});

	test("Bartolomé defaults its PutCounter recipient to itself", () => {
		const result = importFixture("b/bartolome_del_presidio");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card).toMatchObject({
			name: "Bartolomé del Presidio",
			supertypes: ["legendary"],
			types: ["creature"],
			subtypes: ["Vampire", "Knight"],
			manaCost: { w: 1, b: 1 },
			power: 2,
			toughness: 1,
		});
		expect(result.card.abilityDefinitions.activated).toEqual([
			{
				kind: "activated",
				id: "activated-1",
				text: "Put a +1/+1 counter on CARDNAME.",
				cost: {
					mana: "zero",
					tapSelf: false,
					sacrifice: {
						predicate: {
							kind: "or",
							predicates: [
								{
									kind: "and",
									predicates: [
										{ kind: "type", type: "creature" },
										{ kind: "not", predicate: { kind: "self" } },
									],
								},
								{
									kind: "and",
									predicates: [
										{ kind: "type", type: "artifact" },
										{ kind: "not", predicate: { kind: "self" } },
									],
								},
							],
						},
						amount: 1,
					},
				},
				targets: [],
				effects: [
					{
						kind: "add counters",
						subject: { kind: "source" },
						counter: "+1/+1",
						amount: 1,
					},
				],
			},
		]);
	});

	test("Acolyte of Aclazotz lowers its other-creature-or-artifact cost", () => {
		const result = importFixture("a/acolyte_of_aclazotz");
		if (!result.ok) throw new Error("expected ok");
		expect(
			result.card.abilityDefinitions.activated[0]?.cost.sacrifice?.predicate,
		).toEqual({
			kind: "or",
			predicates: [
				{
					kind: "and",
					predicates: [
						{ kind: "type", type: "creature" },
						{ kind: "not", predicate: { kind: "self" } },
					],
				},
				{
					kind: "and",
					predicates: [
						{ kind: "type", type: "artifact" },
						{ kind: "not", predicate: { kind: "self" } },
					],
				},
			],
		});
	});

	test("a CARDNAME sacrifice selector lowers to the source, not a subtype", () => {
		const result = importFixture("upcoming/disruptor_pistol");
		if (!result.ok) throw new Error("expected ok");
		expect(
			result.card.abilityDefinitions.activated[0]?.cost.sacrifice?.predicate,
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
					{
						kind: "draw",
						subject: { kind: "relative-player", player: "you" },
						amount: 1,
					},
					{ kind: "discard", selector: "any", amount: 1, subject: "you" },
				],
			},
		]);
	});

	test("Village Rites lowers its additional sacrifice cost", () => {
		const result = importFixture("v/village_rites");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card.spell).toEqual({
			id: "spell-1",
			text: "Draw two cards.",
			additionalCost: {
				kind: "sacrifice",
				predicate: { kind: "type", type: "creature" },
				amount: 1,
			},
			targets: [],
			effects: [
				{
					kind: "draw",
					subject: { kind: "relative-player", player: "you" },
					amount: 2,
				},
			],
		});
	});

	test("additional sacrifice costs retain their full permanent predicate", () => {
		const deadlyDispute = importFixture("d/deadly_dispute");
		if (!deadlyDispute.ok) throw new Error("expected Deadly Dispute to import");
		expect(deadlyDispute.card.spell?.additionalCost).toEqual({
			kind: "sacrifice",
			predicate: {
				kind: "or",
				predicates: [
					{ kind: "type", type: "artifact" },
					{ kind: "type", type: "creature" },
				],
			},
			amount: 1,
		});

		const abjure = importFixture("a/abjure");
		if (!abjure.ok) throw new Error("expected Abjure to import");
		expect(abjure.card.spell?.additionalCost).toEqual({
			kind: "sacrifice",
			predicate: { kind: "color", color: "u" },
			amount: 1,
		});
	});

	test("Diabolic Edict lowers its sacrifice instruction as serializable data", () => {
		const result = importFixture("d/diabolic_edict");
		if (!result.ok) throw new Error("expected Diabolic Edict to import");
		expect(result.card.spell).toEqual({
			id: "spell-1",
			text: "Target player sacrifices a creature.",
			targets: [
				{
					id: "target-1",
					min: 1,
					max: 1,
					legal: { kind: "player", player: "either" },
				},
			],
			effects: [
				{
					kind: "sacrifice",
					subject: { kind: "target-player", slot: "target-1" },
					predicate: { kind: "type", type: "creature" },
					amount: 1,
				},
			],
		});
		expect(structuredClone(result.card.spell?.effects)).toEqual(
			result.card.spell?.effects,
		);
	});

	test("Sacrifice rejects unsupported mutations of Diabolic Edict", () => {
		const definition = cardText("d/diabolic_edict");
		for (const mutated of [
			definition.replace("SacValid$ Creature", "SacValid$ Creature.phasedOut"),
			definition.replace(
				"SacValid$ Creature",
				"SacValid$ Creature | Amount$ 2",
			),
			definition.replace("SacValid$ Creature |", ""),
			definition.replace(
				"ValidTgts$ Player",
				"ValidTgts$ Player | Defined$ You",
			),
		]) {
			const result = importForgeCard(mutated, { id: "mutated-diabolic-edict" });
			expect(result.ok).toBe(false);
		}
	});

	test("an additional cost does not double-charge the printed mana cost", () => {
		// `Cost$ R Sac<1/Creature>` restates the {R} from `ManaCost:`. The {R} must
		// land on the card once, and only the sacrifice may reach the spell.
		const result = importFixture("r/reckless_abandon");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card.manaCost).toEqual({ r: 1 });
		expect(result.card.spell?.additionalCost).toEqual({
			kind: "sacrifice",
			predicate: { kind: "type", type: "creature" },
			amount: 1,
		});
	});

	test("Giant Growth lowers to a temporary P/T instruction", () => {
		const result = importFixture("g/giant_growth");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card.spell).toMatchObject({
			targets: [
				{
					id: "target-1",
					legal: {
						kind: "permanent",
						predicate: { kind: "type", type: "creature" },
					},
				},
			],
			effects: [
				{
					kind: "modify-pt",
					subject: { kind: "target", slot: "target-1" },
					power: 3,
					toughness: 3,
					duration: "until-end-of-turn",
				},
			],
		});
	});

	test("Bull Rush lowers NumAtt$ alone as +2/+0", () => {
		// Forge leaves out the side that doesn't change. A missing NumDef$ is a
		// toughness delta of zero, not a reason to drop the P/T change.
		const result = importFixture("b/bull_rush");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card.spell?.effects).toEqual([
			{
				kind: "modify-pt",
				subject: { kind: "target", slot: "target-1" },
				power: 2,
				toughness: 0,
				duration: "until-end-of-turn",
			},
		]);
	});

	test("Honor Guard lowers NumDef$ alone as +0/+1", () => {
		const result = importFixture("h/honor_guard");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card.abilityDefinitions.activated[0]?.effects).toEqual([
			{
				kind: "modify-pt",
				subject: { kind: "source" },
				power: 0,
				toughness: 1,
				duration: "until-end-of-turn",
			},
		]);
	});

	test("Selfless Savior lowers its self-sacrifice and temporary indestructible grant", () => {
		const result = importFixture("s/selfless_savior");
		if (!result.ok) throw new Error("expected ok");
		expect(result.card.abilityDefinitions.activated).toEqual([
			{
				kind: "activated",
				id: "activated-1",
				text: "Another target creature you control gains indestructible until end of turn.",
				cost: {
					mana: "zero",
					tapSelf: false,
					sacrifice: { predicate: { kind: "self" }, amount: 1 },
				},
				targets: [
					{
						id: "target-1",
						min: 1,
						max: 1,
						legal: {
							kind: "permanent",
							predicate: {
								kind: "and",
								predicates: [
									{ kind: "type", type: "creature" },
									{ kind: "not", predicate: { kind: "self" } },
									{ kind: "controller", player: "you" },
								],
							},
						},
					},
				],
				effects: [
					{
						kind: "grant-keyword",
						keyword: "indestructible",
						subject: { kind: "target", slot: "target-1" },
						duration: "until-end-of-turn",
					},
				],
			},
		]);
	});
});

describe("lowerForgeCard: one-object ChangeZone", () => {
	const unsummon = cardText("u/unsummon");

	test("keeps a graveyard target distinct from a source object", () => {
		const disentomb = importFixture("d/disentomb");
		if (!disentomb.ok) throw new Error("expected Disentomb to import");
		expect(disentomb.card.spell).toMatchObject({
			targets: [
				{
					legal: {
						kind: "card",
						zone: "graveyard",
						predicate: {
							kind: "and",
							predicates: [
								{ kind: "type", type: "creature" },
								{ kind: "owner", player: "you" },
							],
						},
					},
				},
			],
			effects: [
				{
					kind: "change-zone",
					subject: { kind: "target", slot: "target-1" },
					from: "graveyard",
					destination: { zone: "hand" },
				},
			],
		});

		const arcanis = importFixture("a/arcanis_the_omnipotent");
		if (!arcanis.ok) throw new Error("expected Arcanis to import");
		expect(arcanis.card.abilityDefinitions.activated[1]).toMatchObject({
			targets: [],
			effects: [{ kind: "change-zone", subject: { kind: "source" } }],
		});
	});

	test("lowers public card targets and each symbolic destination shape", () => {
		for (const [fixture, destination] of [
			["c/cremate", { zone: "exile" }],
			["r/reclaim", { zone: "library", position: "top" }],
			["j/jade_cast_sentinel", { zone: "library", position: "bottom" }],
			["r/rise_again", { zone: "battlefield", controller: "owner" }],
		] as const) {
			const result = importFixture(fixture);
			if (!result.ok) throw new Error(`expected ${fixture} to import`);
			const effects =
				result.card.spell?.effects ??
				result.card.abilityDefinitions.activated[0]?.effects;
			expect(effects?.[0]).toMatchObject({
				kind: "change-zone",
				from: "graveyard",
				destination,
			});
		}

		const toGraveyard = importForgeCard(
			unsummon.replace("Destination$ Hand", "Destination$ Graveyard"),
			{ id: "put-in-graveyard" },
		);
		if (!toGraveyard.ok) throw new Error("expected graveyard destination");
		expect(toGraveyard.card.spell?.effects[0]).toMatchObject({
			kind: "change-zone",
			from: "battlefield",
			destination: { zone: "graveyard" },
		});

		const controlled = importFixture("h/hymn_of_rebirth");
		if (!controlled.ok) throw new Error("expected controlled return");
		expect(controlled.card.spell?.effects[0]).toMatchObject({
			destination: { zone: "battlefield", controller: "you" },
		});
	});

	test("lowers a graveyard activation and tapped battlefield arrival", () => {
		const result = importFixture("p/persistent_specimen");
		if (!result.ok) throw new Error("expected Persistent Specimen to import");
		expect(result.card.abilityDefinitions.activated[0]).toMatchObject({
			functionsFrom: ["graveyard"],
			targets: [],
			effects: [
				{
					kind: "change-zone",
					subject: { kind: "source" },
					from: "graveyard",
					destination: {
						zone: "battlefield",
						controller: "owner",
						tapped: true,
					},
				},
			],
		});
	});

	test("rejects a spell bounce with no declared target", () => {
		const result = importForgeCard(
			unsummon.replace(" | ValidTgts$ Creature", ""),
			{ id: "mutated-unsummon" },
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_PARAMETER");
	});

	test("rejects an unsupported defined bounce subject", () => {
		const result = importForgeCard(
			unsummon.replace("ValidTgts$ Creature", "Defined$ Remembered"),
			{ id: "mutated-unsummon" },
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_PARAMETER");
	});

	test("rejects a target with a different defined subject", () => {
		const result = importForgeCard(
			unsummon.replace(
				"ValidTgts$ Creature",
				"ValidTgts$ Creature | Defined$ Self",
			),
			{ id: "mutated-unsummon" },
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_PARAMETER");
	});

	for (const [name, mutation] of [
		["a hidden origin", ["Origin$ Battlefield", "Origin$ Hand"]],
		[
			"the same origin and destination",
			["Destination$ Hand", "Destination$ Battlefield"],
		],
		[
			"multiple objects",
			["SpellDescription$", "ChangeNum$ 2 | SpellDescription$"],
		],
		["a search selector", ["ValidTgts$ Creature", "ChangeType$ Creature"]],
		["a shuffle", ["SpellDescription$", "Shuffle$ True | SpellDescription$"]],
	] as const) {
		test(`rejects ${name}`, () => {
			const result = importForgeCard(
				unsummon.replace(mutation[0], mutation[1]),
				{ id: "mutated-unsummon" },
			);
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_PARAMETER");
		});
	}
});

describe("lowerForgeCard: `+` selector combination and negated subtypes", () => {
	test("Restoration Angel targets a non-Angel creature its controller owns", () => {
		const result = importFixture("r/restoration_angel");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.card.abilityDefinitions.triggered[0]).toMatchObject({
			condition: {
				kind: "change zone",
				from: "any",
				to: "battlefield",
				predicate: { kind: "self" },
			},
			targets: [
				{
					id: "target-1",
					legal: {
						kind: "permanent",
						predicate: {
							kind: "and",
							predicates: [
								{ kind: "type", type: "creature" },
								{
									kind: "not",
									predicate: { kind: "subtype", subtype: "Angel" },
								},
								{ kind: "controller", player: "you" },
							],
						},
					},
				},
			],
			effects: [
				{
					kind: "may",
					decider: "you",
					effects: [
						{
							kind: "change-zone",
							subject: { kind: "target", slot: "target-1" },
							from: "battlefield",
							destination: { zone: "exile" },
						},
						{
							kind: "change-zone",
							subject: {
								kind: "effect-result",
								slot: "remembered-zone-change-object",
							},
							from: "exile",
							destination: { zone: "battlefield", controller: "you" },
						},
					],
				},
			],
		});
	});

	test("`+` AND-combines a dotted restriction with bare modifiers", () => {
		// Deputy of Acquittals spells the mirror of Restoration Angel's
		// restriction: `Creature.YouCtrl+Other` instead of
		// `Creature.Other+YouCtrl`. Both orders lower to the same three
		// selectors, and neither took a hardcoded spelling to get there.
		const result = importFixture("d/deputy_of_acquittals");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.card.abilityDefinitions.triggered[0]).toMatchObject({
			targets: [
				{
					legal: {
						kind: "permanent",
						predicate: {
							kind: "and",
							predicates: [
								{ kind: "type", type: "creature" },
								{ kind: "controller", player: "you" },
								{ kind: "not", predicate: { kind: "self" } },
							],
						},
					},
				},
			],
		});
	});

	const hostile = [
		"Name:Hostile Witness",
		"ManaCost:B",
		"Types:Instant",
		"A:SP$ ChangeZone | ValidTgts$ %TARGET% | Origin$ Battlefield | Destination$ Exile | SpellDescription$ Exile target %TARGET%.",
		"Oracle:Exile target %TARGET%.",
		"",
	].join("\n");

	test("a non subtype from Forge's pseudo-restriction vocabulary rejects", () => {
		const result = importForgeCard(
			hostile.replaceAll("%TARGET%", "Creature.nonChosenCard"),
			{ id: "hostile-witness" },
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]).toMatchObject({ code: "UNSUPPORTED_TARGET" });
	});

	test("a subtype missing from the surveyed list rejects", () => {
		// Goblin is as real a subtype as Angel; it simply is not in the list,
		// because no corpus card negates it. Rejecting keeps a typo from
		// lowering to a restriction no card can satisfy.
		const result = importForgeCard(
			hostile.replaceAll("%TARGET%", "Creature.nonGoblin"),
			{ id: "hostile-witness" },
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]).toMatchObject({ code: "UNSUPPORTED_TARGET" });
	});

	test("a bare `+` segment outside the modifier vocabulary rejects", () => {
		const result = importForgeCard(
			hostile.replaceAll("%TARGET%", "Creature.YouCtrl+haunted"),
			{ id: "hostile-witness" },
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]).toMatchObject({ code: "UNSUPPORTED_TARGET" });
	});

	test("ForgetOtherTargets without the RememberTargets chain rejects", () => {
		// Restoration Angel's script minus its RememberTargets: the remaining
		// ForgetOtherTargets would clear a cross-ability remembered set the
		// engine does not model.
		const text = cardText("r/restoration_angel")
			.replace(" | RememberTargets$ True", "")
			.replace(" | SubAbility$ RestorationReturn", "");
		const result = importForgeCard(text, { id: "restoration-angel-mutant" });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]).toMatchObject({
			code: "UNSUPPORTED_PARAMETER",
			message: "ForgetOtherTargets requires the RememberTargets chain",
		});
	});
});

describe("lowerForgeCard: strict Clone shape", () => {
	const clone = cardText("c/clone");
	const mutations = [
		["mandatory replacement", ":Optional", ":Mandatory"],
		["non-copy ETB tier", ":Copy:DBCopy", ":Other:DBCopy"],
		["extra keyword segment", ":DBCopy:Optional", ":DBCopy:Optional:Extra"],
		["different effect API", "DB$ Clone", "DB$ CopyPermanent"],
		[
			"extra copy-body parameter",
			" | SpellDescription$",
			" | Defined$ Self | SpellDescription$",
		],
	] as const;

	for (const [name, from, to] of mutations) {
		test(`rejects ${name}`, () => {
			expect(clone).toContain(from);
			const result = importForgeCard(clone.replace(from, to), {
				id: "mutated-clone",
			});
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.diagnostics[0]?.code).toMatch(
				/^UNSUPPORTED_(KEYWORD|EFFECT|PARAMETER)$/,
			);
		});
	}

	test("rejects a missing copy body", () => {
		const result = importForgeCard(clone.replace("DBCopy", "DBMissing"), {
			id: "mutated-clone",
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_REFERENCE");
	});

	test("rejects a copy body without its choice description", () => {
		const result = importForgeCard(
			clone.replace(/ \| SpellDescription\$[^\n]*/, ""),
			{ id: "mutated-clone" },
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_EFFECT");
	});
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

const BLOOD_PACT = `Name:Blood Pact
ManaCost:2 B
Types:Instant
A:SP$ Draw | NumCards$ 2 | ValidTgts$ Player | SubAbility$ DBLoseLife | StackDescription$ {p:Targeted} draws two cards and loses 2 life. | SpellDescription$ Target player draws two cards and loses 2 life.
SVar:DBLoseLife:DB$ LoseLife | LifeAmount$ 2 | Defined$ Targeted | StackDescription$ None
Oracle:Target player draws two cards and loses 2 life.
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

	test("rejects a spell Cost$ whose mana disagrees with ManaCost:", () => {
		// Forge restates the mana cost inside Cost$. If the importer's two parses
		// disagree, one of them is wrong, and accepting the card would price the
		// spell at whichever line happened to win.
		for (const cost of [
			"Sac<1/Creature>",
			"1 R Sac<1/Creature>",
			"B Sac<1/Creature>",
		]) {
			const result = importText(
				BOLT.replace("SP$ DealDamage |", `SP$ DealDamage | Cost$ ${cost} |`),
			);
			expect(result.ok).toBe(false);
			if (!result.ok)
				expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_COST");
		}
	});

	test("accepts a spell Cost$ that restates ManaCost: and adds a sacrifice", () => {
		const result = importText(
			BOLT.replace(
				"SP$ DealDamage |",
				"SP$ DealDamage | Cost$ R Sac<1/Creature> |",
			),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.card.manaCost).toEqual({ r: 1 });
		expect(result.card.spell?.additionalCost).toEqual({
			kind: "sacrifice",
			predicate: { kind: "type", type: "creature" },
			amount: 1,
		});
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
			BOLT.replace("ValidTgts$ Any", "ValidTgts$ Creature.haunted"),
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

	test("lowers a targeted player operand on both halves of a chain", () => {
		const result = importText(BLOOD_PACT);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.card.spell?.targets).toEqual([
			{
				id: "target-1",
				min: 1,
				max: 1,
				legal: { kind: "player", player: "either" },
			},
		]);
		// The head reads its operand from the ability's own ValidTgts$ and the
		// continuation from Defined$ Targeted; both name the same slot.
		expect(result.card.spell?.effects).toEqual([
			{
				kind: "draw",
				subject: { kind: "target-player", slot: "target-1" },
				amount: 2,
			},
			{
				kind: "lose-life",
				subject: { kind: "target-player", slot: "target-1" },
				amount: 2,
			},
		]);
	});

	test("an omitted Defined$ without ValidTgts$ is still the controller", () => {
		const result = importText(REVITALIZE.replace("Defined$ You | ", ""));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.card.spell?.effects[0]).toEqual({
			kind: "gain-life",
			subject: { kind: "relative-player", player: "you" },
			amount: 3,
		});
	});

	test("rejects a targeted player operand whose ValidTgts$ is not a player", () => {
		const result = importText(
			BLOOD_PACT.replace("ValidTgts$ Player", "ValidTgts$ Creature"),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_TARGET");
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
		for (const term of ["C", "X", "W/U", "W/P", "PayLife<2>"]) {
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
			[
				"Cost$ U 0",
				"malformed activation cost: 0 cannot be combined with other mana terms",
			],
			[
				"Cost$ 0 0",
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

	test("rejects Tap targeting a non-permanent slot", () => {
		const result = importText(
			`Name:Bad Tap\nManaCost:1 U\nTypes:Instant\nA:SP$ Tap | ValidTgts$ Player | SpellDescription$ x.\n`,
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_TARGET");
	});

	test("rejects Untap targeting a non-permanent slot", () => {
		const result = importText(
			`Name:Bad Untap\nManaCost:1 U\nTypes:Instant\nA:SP$ Untap | ValidTgts$ Player | SpellDescription$ x.\n`,
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_TARGET");
	});

	test("rejects an unused SVar", () => {
		const result = importText(`${BEARS}SVar:Unused:TRUE\n`);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_REFERENCE");
	});

	test.each([
		"AIPreference",
		"AIPriorityModifier",
		"AmbushAI",
		"AntiBuffedBy",
		"BuffedBy",
		"DonateMe",
		"NeedsToPlay",
		"NeedsToPlayVar",
		"NonCombatPriority",
		"NonStackingEffect",
		"PlayMain1",
	])("ignores the %s AI/deck-building SVar", (name) => {
		const result = importText(`${BEARS}SVar:${name}:TRUE\n`);
		expect(result.ok).toBe(true);
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
					subject: "you",
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

	test("Produced$ Any lowers to one option for each color", () => {
		const result = importText(
			"Name:Test Treasure\nManaCost:no cost\nTypes:Artifact Treasure\nA:AB$ Mana | Cost$ T Sac<1/CARDNAME/this token> | Produced$ Any | Amount$ 1 | SpellDescription$ Add one mana of any color.\nOracle:\n",
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.card.abilityDefinitions.activated).toEqual([
			{
				kind: "mana",
				id: "activated-1",
				text: "Add one mana of any color.",
				cost: {
					mana: "zero",
					tapSelf: true,
					sacrifice: { predicate: { kind: "self" }, amount: 1 },
				},
				manaOptions: [
					{ w: 1, u: 0, b: 0, r: 0, g: 0, c: 0 },
					{ w: 0, u: 1, b: 0, r: 0, g: 0, c: 0 },
					{ w: 0, u: 0, b: 1, r: 0, g: 0, c: 0 },
					{ w: 0, u: 0, b: 0, r: 1, g: 0, c: 0 },
					{ w: 0, u: 0, b: 0, r: 0, g: 1, c: 0 },
				],
			},
		]);
	});

	test("Amount$ on a modal Produced$ is per chosen symbol, not split across them", () => {
		// Black Lotus: three mana of the one colour chosen, not three mana
		// spread over the five choices.
		const result = importText(
			"Name:Black Lotus\nManaCost:0\nTypes:Artifact\nA:AB$ Mana | Cost$ T Sac<1/CARDNAME> | Produced$ Any | Amount$ 3 | SpellDescription$ Add three mana of any one color.\nOracle:\n",
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.card.abilityDefinitions.activated).toEqual([
			{
				kind: "mana",
				id: "activated-1",
				text: "Add three mana of any one color.",
				cost: {
					mana: "zero",
					tapSelf: true,
					sacrifice: { predicate: { kind: "self" }, amount: 1 },
				},
				manaOptions: [
					{ w: 3, u: 0, b: 0, r: 0, g: 0, c: 0 },
					{ w: 0, u: 3, b: 0, r: 0, g: 0, c: 0 },
					{ w: 0, u: 0, b: 3, r: 0, g: 0, c: 0 },
					{ w: 0, u: 0, b: 0, r: 3, g: 0, c: 0 },
					{ w: 0, u: 0, b: 0, r: 0, g: 3, c: 0 },
				],
			},
		]);
	});

	test("describes a modal Amount$ without a SpellDescription by repeating the symbol", () => {
		const result = importText(
			"Name:Test Lotus\nManaCost:0\nTypes:Artifact\nA:AB$ Mana | Cost$ T | Produced$ Any | Amount$ 2\nOracle:\n",
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.card.abilityDefinitions.activated[0]?.text).toBe(
			"Add {W}{W} or {U}{U} or {B}{B} or {R}{R} or {G}{G}.",
		);
	});

	test("rejects a Combo Amount$ above one, which mixes symbols rather than choosing one", () => {
		// Orcish Lumberjack: "add three mana in any combination of {R} and/or
		// {G}" is three independent choices, so {R}{R}{G} is legal and no fixed
		// option list covers it. Accepting it as [{r: 3}, {g: 3}] would silently
		// drop the mixed outcomes.
		const result = importText(
			"Name:Orcish Lumberjack\nManaCost:R\nTypes:Creature Orc\nPT:1/1\nA:AB$ Mana | Cost$ T Sac<1/Forest> | Produced$ Combo R G | Amount$ 3 | SpellDescription$ Add three mana in any combination of {R} and/or {G}.\nOracle:\n",
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]).toMatchObject({
			code: "UNSUPPORTED_EFFECT",
			message: "unsupported mana amount 3",
		});
	});

	test("rejects a dynamic amount on a modal Produced$ on the amount, not the symbol", () => {
		const result = importText(
			"Name:Bad Lotus\nManaCost:0\nTypes:Artifact\nA:AB$ Mana | Cost$ T | Produced$ Any | Amount$ LotusAmount | SpellDescription$ x.\nSVar:LotusAmount:Count$UrzaLands.3.1\nOracle:\n",
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]).toMatchObject({
			code: "UNSUPPORTED_EFFECT",
			message: "unsupported mana amount LotusAmount",
		});
	});

	test("rejects open-ended, variable, malformed, and unsupported Produced$ forms with diagnostics", () => {
		for (const produced of [
			"Combo Any", // open-ended modal choice
			"Combo W", // a modal choice needs at least two outcomes
			"Combo W W", // outcomes must be distinct
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
						subject: "you",
						mana: expect.objectContaining({ g: 2 }),
					},
				],
			}),
			expect.objectContaining({
				id: "intrinsic-mana-g",
				effects: [
					{
						kind: "add-mana",
						subject: "you",
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
					{
						kind: "gain-life",
						subject: { kind: "relative-player", player: "you" },
						amount: 1,
					},
					{
						kind: "draw",
						subject: { kind: "relative-player", player: "you" },
						amount: 1,
					},
				],
			},
			{
				id: "TrigB",
				text: "b",
				condition: {
					kind: "change zone",
					from: "any",
					to: "battlefield",
					predicate: { kind: "self" },
				},
				targets: [],
				effects: [
					{
						kind: "gain-life",
						subject: { kind: "relative-player", player: "you" },
						amount: 2,
					},
					{
						kind: "draw",
						subject: { kind: "relative-player", player: "you" },
						amount: 1,
					},
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
		const engine = createEngine([]);
		const state = engine.newGame();
		const obj = engine.spawnCard(state, "unregistered-bears-probe", 0, "hand");
		expect(() => engine.name(state, obj.id)).toThrow(/unknown card/);
	});
});

describe("lowerForgeCard: ChangesZone dies triggers", () => {
	/** A dies trigger whose executed ability is a plain, already-supported effect. */
	function diesCard(lines: {
		origin: string;
		destination: string;
		validCard: string;
		extra?: string;
	}): string {
		return [
			"Name:Probe",
			"ManaCost:1 B",
			"Types:Creature Human",
			"PT:1/1",
			`T:Mode$ ChangesZone | Origin$ ${lines.origin} | Destination$ ${lines.destination} | ValidCard$ ${lines.validCard} | Execute$ TrigGain | TriggerDescription$ d`,
			"SVar:TrigGain:DB$ GainLife | Defined$ You | LifeAmount$ 1",
			...(lines.extra ? [lines.extra] : []),
			"Oracle:",
			"",
		].join("\n");
	}

	test("Battlefield to Graveyard lowers to a self dies condition", () => {
		const result = importText(
			diesCard({
				origin: "Battlefield",
				destination: "Graveyard",
				validCard: "Card.Self",
			}),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.card.abilityDefinitions.triggered[0]?.condition).toEqual({
			kind: "change zone",
			from: "battlefield",
			to: "graveyard",
			predicate: { kind: "self" },
		});
	});

	test("TriggeredCardController is not approximated for a different entering permanent", () => {
		const result = importText(
			[
				"Name:Watcher",
				"ManaCost:1 B",
				"Types:Enchantment",
				"T:Mode$ ChangesZone | Origin$ Any | Destination$ Battlefield | ValidCard$ Creature.Other | TriggerZones$ Battlefield | Execute$ TrigGain | TriggerDescription$ d",
				"SVar:TrigGain:DB$ GainLife | Defined$ TriggeredCardController | LifeAmount$ 1",
				"Oracle:",
				"",
			].join("\n"),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]).toMatchObject({
			code: "UNSUPPORTED_PARAMETER",
			message: "unsupported or missing LifeAmount$/player for gainlife",
		});
	});

	test("rejects a dies trigger that watches other creatures", () => {
		const result = importText(
			diesCard({
				origin: "Battlefield",
				destination: "Graveyard",
				validCard: "Creature.Other",
			}),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_PARAMETER");
	});

	test("rejects battlefield departures to zones other than the graveyard", () => {
		for (const destination of ["Exile", "Hand", "Any"]) {
			const result = importText(
				diesCard({
					origin: "Battlefield",
					destination,
					validCard: "Card.Self",
				}),
			);
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_EFFECT");
		}
	});

	test("SacMe is retained as an AI hint on a card that has a dies trigger", () => {
		const result = importText(
			diesCard({
				origin: "Battlefield",
				destination: "Graveyard",
				validCard: "Card.Self",
				extra: "SVar:SacMe:2",
			}),
		);
		expect(result.ok).toBe(true);
	});

	test("SacMe on a card with no dies trigger is still an unused SVar", () => {
		const result = importText(
			diesCard({
				origin: "Any",
				destination: "Battlefield",
				validCard: "Card.Self",
				extra: "SVar:SacMe:2",
			}),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_REFERENCE");
	});
});
