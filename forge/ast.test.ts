import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	buildForgeCardAst,
	buildForgeReferenceGraph,
	countForgeDiagnostics,
	FORGE_AMOUNT_PARAMS,
	FORGE_KEYWORD_SPECS,
	FORGE_REFERENCE_PARAMS,
	FORGE_RUNTIME_WRITE_PARAMS,
	type ForgeDiagnostic,
	type ForgeParseResult,
	type ForgeScriptDocument,
	findUnmodeledReferenceCandidates,
	getForgeParam,
	isKnownForgeEffectName,
	isKnownForgeReplacementEvent,
	isKnownForgeStaticMode,
	isKnownForgeTriggerMode,
	KNOWN_FORGE_EFFECT_NAMES,
	KNOWN_FORGE_REPLACEMENT_EVENTS,
	KNOWN_FORGE_STATIC_MODES,
	KNOWN_FORGE_TRIGGER_MODES,
	lookupForgeAmountParam,
	lookupForgeKeywordSpec,
	lookupForgeReferenceParam,
	lookupForgeRuntimeWrite,
	lookupForgeSVar,
	parseForgeCardScript,
	parseForgeCountExpression,
	parseForgeParams,
	parseForgeScalarSVarExpression,
	printForgeCardScript,
	projectForgeDocument,
} from "./ast.ts";

/* ------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* ------------------------------------------------------------------------- */

const CORPUS_ROOT = join(import.meta.dir, "..", "cards", "cardsfolder");

function card(name: string): string {
	const first = name[0] ?? "_";
	return readFileSync(join(CORPUS_ROOT, first, `${name}.txt`), "utf8");
}

function face(result: ForgeParseResult, state: string) {
	const found = result.card.faces.find((f) => f.state === state);
	if (found === undefined) throw new Error(`no ${state} face`);
	return found;
}

function codes(diagnostics: readonly ForgeDiagnostic[]): string[] {
	return diagnostics.map((d) => String(d.code));
}

/**
 * The round-trip contract: parse -> print -> parse must preserve the ordered,
 * duplicate-sensitive meaningful structure. Line numbers, generated ids,
 * diagnostics, comments and blank lines are intentionally out of scope.
 */
function expectRoundTrip(source: string): ForgeScriptDocument {
	const first = parseForgeCardScript(source);
	const printed = printForgeCardScript(first.document);
	const second = parseForgeCardScript(printed);
	expect(projectForgeDocument(second.document)).toEqual(
		projectForgeDocument(first.document),
	);
	return first.document;
}

/* ------------------------------------------------------------------------- */
/* Registries                                                                 */
/* ------------------------------------------------------------------------- */

describe("known-name registries", () => {
	// Spot-checks at the start, middle and end of each enum, taken from Forge
	// revision 1b900c62af9340f4f73109012083d179f8a48ff6, so that a registry
	// transcribed in the wrong order or with the wrong contents cannot slip
	// through.
	test("effect names sample start, middle and end of ApiType", () => {
		expect(KNOWN_FORGE_EFFECT_NAMES[0]).toBe("Abandon");
		expect(KNOWN_FORGE_EFFECT_NAMES[1]).toBe("ActivateAbility");
		expect(KNOWN_FORGE_EFFECT_NAMES[100]).toBe("Intensify");
		// ApiType is mostly alphabetical but ends with a block of internal APIs,
		// so the final entry is InternalRadiation rather than a "W" name.
		expect(KNOWN_FORGE_EFFECT_NAMES[193]).toBe("WinsGame");
		expect(KNOWN_FORGE_EFFECT_NAMES[200]).toBe("InternalRadiation");
		for (const name of ["DealDamage", "ChangeZone", "Charm", "RollDice"]) {
			expect(isKnownForgeEffectName(name)).toBe(true);
		}
	});

	test("trigger modes sample start, middle and end of TriggerType", () => {
		expect(KNOWN_FORGE_TRIGGER_MODES[0]).toBe("Abandoned");
		expect(KNOWN_FORGE_TRIGGER_MODES[73]).toBe("Explores");
		expect(KNOWN_FORGE_TRIGGER_MODES[145]).toBe("Waterbend");
		for (const mode of ["ChangesZone", "Phase", "Attacks", "SpellCast"]) {
			expect(isKnownForgeTriggerMode(mode)).toBe(true);
		}
	});

	test("replacement events sample start, middle and end of ReplacementType", () => {
		expect(KNOWN_FORGE_REPLACEMENT_EVENTS[0]).toBe("AddCounter");
		expect(KNOWN_FORGE_REPLACEMENT_EVENTS[20]).toBe("GameWin");
		expect(KNOWN_FORGE_REPLACEMENT_EVENTS[39]).toBe("Untap");
		for (const event of ["Moved", "DamageDone", "Untap", "Draw"]) {
			expect(isKnownForgeReplacementEvent(event)).toBe(true);
		}
	});

	test("static modes sample start, middle and end of StaticAbilityMode", () => {
		expect(KNOWN_FORGE_STATIC_MODES[0]).toBe("Continuous");
		expect(KNOWN_FORGE_STATIC_MODES[41]).toBe("CantBeCopied");
		expect(KNOWN_FORGE_STATIC_MODES[82]).toBe("CountersRemain");
		for (const mode of ["Continuous", "CantAttack", "CantBeCast"]) {
			expect(isKnownForgeStaticMode(mode)).toBe(true);
		}
	});

	test("lookups are case-insensitive, matching Forge's smartValueOf", () => {
		expect(isKnownForgeEffectName("dealdamage")).toBe(true);
		expect(isKnownForgeTriggerMode("changeszone")).toBe(true);
		expect(isKnownForgeReplacementEvent("MOVED")).toBe(true);
		// The corpus writes `IgnoreLandWalk`; Java spells it `IgnoreLandwalk`.
		expect(isKnownForgeStaticMode("IgnoreLandWalk")).toBe(true);
	});

	test("unknown names are simply unknown, never fatal", () => {
		expect(isKnownForgeEffectName("TotallyNewForgeApi")).toBe(false);
		expect(isKnownForgeTriggerMode("SomeFutureTrigger")).toBe(false);
	});

	test("reference-parameter registry covers the required entries", () => {
		const params = new Set(
			FORGE_REFERENCE_PARAMS.map((spec) => spec.param.toLowerCase()),
		);
		for (const required of [
			"SubAbility",
			"Execute",
			"ReplaceWith",
			"Choices",
			"ResultSubAbilities",
			// AbilityFactory.additionalAbilityKeys
			"WinSubAbility",
			"OtherwiseSubAbility",
			"BidSubAbility",
			"ChooseNumberSubAbility",
			"Lowest",
			"Highest",
			"NotLowest",
			"GuessCorrect",
			"GuessWrong",
			"MatchedAbility",
			"UnmatchedAbility",
			"HeadsSubAbility",
			"TailsSubAbility",
			"LoseSubAbility",
			"TrueSubAbility",
			"FalseSubAbility",
			"ChosenPile",
			"UnchosenPile",
			"RepeatSubAbility",
			"FallbackAbility",
			"ChooseSubAbility",
			"CantChooseSubAbility",
			"RegenerationAbility",
			"ReturnAbility",
			"GiftAbility",
			"VoteSubAbility",
			"VoteTiedAbility",
			// Continuous-effect family (" & " delimited) and condition checks.
			"AddAbility",
			"AddTrigger",
			"AddStaticAbility",
			"AddReplacementEffect",
			"AddSVar",
			"StaticEffect",
			"TriggersWhenSpent",
			"CheckSVar",
			"CheckSecondSVar",
			"ConditionCheckSVar",
			"BranchConditionSVar",
			"RepeatCheckSVar",
		]) {
			expect(params.has(required.toLowerCase())).toBe(true);
		}
	});

	test("the continuous-effect family uses the ' & ' delimiter", () => {
		for (const name of [
			"AddAbility",
			"AddTrigger",
			"AddStaticAbility",
			"AddReplacementEffect",
			"AddSVar",
		]) {
			expect(lookupForgeReferenceParam(name)?.form).toBe("amp-list");
		}
		// The AbilityFactory family stays comma-delimited.
		expect(lookupForgeReferenceParam("Choices")?.form).toBe("comma-list");
		expect(lookupForgeReferenceParam("SubAbility")?.form).toBe("single");
	});

	test("condition checks are optional references", () => {
		for (const name of [
			"CheckSVar",
			"ConditionCheckSVar",
			"BranchConditionSVar",
			"RepeatCheckSVar",
			"AICheckSVar",
		]) {
			expect(lookupForgeReferenceParam(name)?.optional).toBe(true);
		}
		expect(lookupForgeReferenceParam("SubAbility")?.optional).toBeUndefined();
	});

	test("write-only SVar params are deliberately absent", () => {
		// RollDiceEffect.setSVar / StoreSVarEffect define an SVar rather than
		// reading one; this module has no write-edge concept.
		expect(lookupForgeReferenceParam("ResultSVar")).toBeUndefined();
		expect(lookupForgeReferenceParam("SVar")).toBeUndefined();
	});

	test("keyword registry covers the SVar-bearing keyword forms", () => {
		const kws = new Set(
			FORGE_KEYWORD_SPECS.map((spec) => spec.keyword.toLowerCase()),
		);
		for (const k of [
			"ETBReplacement",
			"Chapter",
			"Backup",
			"Haunt",
			"Visit",
			"Prize",
			"MayEffectFromOpeningHand",
			"MayEffectFromOpeningDeck",
			"etbCounter",
			"Class",
		]) {
			expect(kws.has(k.toLowerCase())).toBe(true);
		}
		expect(lookupForgeKeywordSpec("etbcounter")).toBeDefined();
		expect(lookupForgeKeywordSpec("Flying")).toBeUndefined();
	});
});

/* ------------------------------------------------------------------------- */
/* Continuous-effect and condition references                                 */
/* ------------------------------------------------------------------------- */

describe("continuous-effect reference family", () => {
	// StaticAbilityContinuous.java:333-367 splits these on " & ", never on ",".
	test("splits AddAbility / AddTrigger / AddStaticAbility on ' & '", () => {
		const result = parseForgeCardScript(
			[
				"Name:Granter",
				"S:Mode$ Continuous | Affected$ Creature | AddAbility$ ABOne & ABTwo | AddTrigger$ TROne & TROne | AddStaticAbility$ STOne",
				"SVar:ABOne:AB$ Draw | Cost$ T",
				"SVar:ABTwo:AB$ Draw | Cost$ T",
				"SVar:TROne:Mode$ Attacks | Execute$ ABOne",
				"SVar:STOne:Mode$ Continuous | Affected$ You",
			].join("\n"),
		);
		const roles = result.card.graph.edges.map((e) => [
			e.role,
			e.rawReference,
			e.status,
		]);
		expect(roles).toEqual([
			["granted-ability", "ABOne", "resolved"],
			["granted-ability", "ABTwo", "resolved"],
			["granted-trigger", "TROne", "resolved"],
			// A repeated name is two independent edges to one shared definition.
			["granted-trigger", "TROne", "resolved"],
			["granted-static", "STOne", "resolved"],
			["execute", "ABOne", "resolved"],
		]);
		expect(result.diagnostics).toEqual([]);
	});

	test("does NOT split the continuous family on commas", () => {
		// Forge would look up the whole comma string as one name and find nothing.
		// Two shipped cards really do this; reproducing the failure is correct.
		const result = parseForgeCardScript(
			[
				"Name:Comma Bug",
				"S:Mode$ Continuous | AddSVar$ AAA,BBB",
				"SVar:AAA:1",
				"SVar:BBB:2",
			].join("\n"),
		);
		expect(result.card.graph.edges).toHaveLength(1);
		expect(result.card.graph.edges[0]?.rawReference).toBe("AAA,BBB");
		expect(result.card.graph.edges[0]?.status).toBe("unresolved");
	});

	test("StaticEffect and TriggersWhenSpent are single names", () => {
		const result = parseForgeCardScript(
			[
				"Name:Singles",
				"A:SP$ ChangeZone | StaticEffect$ STOne",
				"A:AB$ Mana | Cost$ T | Produced$ G | TriggersWhenSpent$ TrigSpent",
				"SVar:STOne:Mode$ Continuous | Affected$ You",
				"SVar:TrigSpent:Mode$ Always | Execute$ STOne",
			].join("\n"),
		);
		const roles = result.card.graph.edges.map((e) => e.role);
		expect(roles).toContain("static-effect");
		expect(roles).toContain("mana-spent-trigger");
	});

	test("delayed-trigger params name a single SVar, typo included", () => {
		const result = parseForgeCardScript(
			[
				"Name:Delayer",
				"A:SP$ AddTurn | ExtraTurnDelayedTriggerExecute$ TrigTurn | SubAbility$ DBPhase",
				"SVar:DBPhase:DB$ AddPhase | ExtraPhaseDelayedTrigger$ TrigPhase | ExtraPhaseDelayedTriggerExcute$ TrigExec",
				"SVar:TrigTurn:DB$ Draw",
				"SVar:TrigPhase:Mode$ Always | Execute$ TrigExec",
				"SVar:TrigExec:DB$ Draw",
			].join("\n"),
		);
		const roles = result.card.graph.edges.map(
			(e) => `${e.role}:${e.rawReference}`,
		);
		expect(roles).toContain("extra-turn-trigger:TrigTurn");
		expect(roles).toContain("extra-phase-trigger:TrigPhase");
		// AddPhaseEffect really does spell it "Excute"; the registry matches Forge.
		expect(roles).toContain("extra-phase-trigger:TrigExec");
		expect(result.diagnostics).toEqual([]);
	});

	test("note names and defined-object selectors are not SVar references", () => {
		// PumpEffect's NoteCardsFor is an arbitrary label, and AnimateEffect's
		// RememberObjects names game objects, not SVars.
		expect(lookupForgeReferenceParam("NoteCardsFor")).toBeUndefined();
		expect(lookupForgeReferenceParam("ClearNotedCardsFor")).toBeUndefined();
		expect(lookupForgeReferenceParam("RememberObjects")).toBeUndefined();
	});

	test("real corpus card: Lobe Lobber grants an ability and a dangling SVar", () => {
		const result = parseForgeCardScript(card("lobe_lobber"));
		const edges = result.card.graph.edges;
		expect(edges.find((e) => e.role === "granted-ability")?.rawReference).toBe(
			"WandDamage",
		);
		// AddSVar$ DBWandDmg names an SVar the script never defines.
		const dangling = edges.find((e) => e.role === "granted-svar");
		expect(dangling?.status).toBe("unresolved");
		expect(codes(result.diagnostics)).toContain("UNRESOLVED_SVAR_REFERENCE");
	});
});

describe("condition references", () => {
	// AbilityUtils.calculateAmount accepts a literal, an expression OR an SVar
	// name, so a non-matching value must not be reported as a dangling name.
	test("resolve when the value names an SVar", () => {
		const result = parseForgeCardScript(
			[
				"Name:Checker",
				"T:Mode$ Phase | Phase$ Upkeep | CheckSVar$ X | Execute$ TrigDraw",
				"SVar:TrigDraw:DB$ Draw",
				"SVar:X:Count$YourLifeTotal",
			].join("\n"),
		);
		const cond = result.card.graph.edges.find((e) => e.role === "condition");
		expect(cond?.rawReference).toBe("X");
		expect(cond?.status).toBe("resolved");
		// The condition points at a *scalar* SVar, which is a legitimate destination.
		const destination = result.card.graph.nodes.find((n) => n.id === cond?.to);
		expect(destination?.kind).toBe("svar");
		expect(destination?.name).toBe("X");
	});

	test("emit nothing at all for a literal amount", () => {
		const result = parseForgeCardScript(
			[
				"Name:Literal",
				"T:Mode$ Phase | Phase$ Upkeep | CheckSVar$ 3 | ConditionCheckSVar$ 0 | Execute$ TrigDraw",
				"SVar:TrigDraw:DB$ Draw",
			].join("\n"),
		);
		expect(
			result.card.graph.edges.filter((e) => e.role === "condition"),
		).toHaveLength(0);
		expect(codes(result.diagnostics)).not.toContain(
			"UNRESOLVED_SVAR_REFERENCE",
		);
		expect(result.diagnostics).toEqual([]);
	});

	test("BranchConditionSVar links a Branch to its scalar test", () => {
		const result = parseForgeCardScript(
			[
				"Name:Brancher",
				"A:SP$ Branch | BranchConditionSVar$ WasCast | TrueSubAbility$ DBYes | FalseSubAbility$ DBNo",
				"SVar:WasCast:Remembered$Valid Card",
				"SVar:DBYes:DB$ Draw",
				"SVar:DBNo:DB$ LoseLife | LifeAmount$ 1",
			].join("\n"),
		);
		const roles = result.card.graph.edges.map(
			(e) => `${e.role}:${e.rawReference}`,
		);
		expect(roles).toEqual(["condition:WasCast", "branch:DBYes", "branch:DBNo"]);
	});

	test("write-destination params produce typed write edges, not reads", () => {
		const result = parseForgeCardScript(
			[
				"Name:Writer",
				"A:SP$ RollDice | ResultSVar$ Rolled | SubAbility$ DBStore",
				"SVar:DBStore:DB$ StoreSVar | SVar$ Stored | Type$ Count | Expression$ 1",
				"SVar:Rolled:0",
				"SVar:Stored:0",
			].join("\n"),
		);
		expect(
			result.card.graph.edges.map((e) => [
				e.role,
				e.rawReference,
				e.provenance,
			]),
		).toEqual([
			["writes", "Rolled", "runtime-write"],
			["writes", "Stored", "runtime-write"],
			["sub-ability", "DBStore", "ability-factory"],
		]);
	});
});

/* ------------------------------------------------------------------------- */
/* Structured keywords                                                        */
/* ------------------------------------------------------------------------- */

describe("keyword records", () => {
	test("every K: line keeps its verbatim segments, known or not", () => {
		const result = parseForgeCardScript(
			["Name:Keys", "K:Flying", "K:Ward:2", "K:TotallyNewKeyword:a:b:c"].join(
				"\n",
			),
		);
		const recs = face(result, "original").keywordRecords;
		expect(recs.map((r) => [r.keyword, r.known, r.segments.length])).toEqual([
			["Flying", false, 1],
			["Ward", false, 2],
			["TotallyNewKeyword", false, 4],
		]);
		expect(recs[2]?.segments).toEqual(["TotallyNewKeyword", "a", "b", "c"]);
		// keywords[] keeps its original shape alongside the richer records.
		expect(face(result, "original").keywords.map((k) => k.value)).toEqual([
			"Flying",
			"Ward:2",
			"TotallyNewKeyword:a:b:c",
		]);
	});

	test("ETBReplacement names an SVar at segment 2", () => {
		const result = parseForgeCardScript(
			card("infirmary_healer_stream_of_life"),
		);
		const edge = result.card.graph.edges.find(
			(e) => e.role === "etb-replacement",
		);
		expect(edge?.rawReference).toBe("DBPrepare");
		expect(edge?.status).toBe("resolved");
		const from = result.card.graph.nodes.find((n) => n.id === edge?.from);
		expect(from?.kind).toBe("keyword");
		expect(from?.name).toBe("ETBReplacement");
	});

	test("Chapter is a comma list, one entry per chapter, sharing allowed", () => {
		// roar_of_endless_song: K:Chapter:3:DBToken,DBToken,DBDouble
		const result = parseForgeCardScript(card("roar_of_endless_song"));
		const chapters = result.card.graph.edges.filter(
			(e) => e.role === "chapter",
		);
		expect(chapters.map((e) => e.rawReference)).toEqual([
			"DBToken",
			"DBToken",
			"DBDouble",
		]);
		// Chapters 1 and 2 are two edges into one shared definition.
		expect(new Set(chapters.slice(0, 2).map((e) => e.to)).size).toBe(1);
		for (const e of chapters) expect(e.status).toBe("resolved");
	});

	test("Class carries an embedded parameter tail after the cost segment", () => {
		// ranger_class has both a single AddTrigger$ and an ' & ' AddStaticAbility$.
		const result = parseForgeCardScript(card("ranger_class"));
		const recs = face(result, "original").keywordRecords.filter(
			(r) => r.keyword === "Class",
		);
		expect(recs).toHaveLength(2);
		expect(recs[0]?.segments).toEqual([
			"Class",
			"2",
			"1 G",
			"AddTrigger$ TriggerAttackersDeclared",
		]);
		expect(recs[0]?.params?.entries.map((e) => e.key)).toEqual(["AddTrigger"]);
		const granted = result.card.graph.edges.filter((e) =>
			e.role.startsWith("granted-"),
		);
		expect(granted.map((e) => e.rawReference)).toEqual([
			"TriggerAttackersDeclared",
			"SMayLook",
			"SMayPlay",
		]);
		for (const e of granted) expect(e.status).toBe("resolved");
	});

	test("Haunt, Visit, Prize and opening-hand effects name an SVar at segment 1", () => {
		const result = parseForgeCardScript(
			[
				"Name:Segment One",
				"K:Haunt:TrigA",
				"K:Visit:TrigB",
				"K:Prize:TrigC",
				"K:MayEffectFromOpeningHand:TrigD:!PlayFirst",
				"SVar:TrigA:DB$ Draw",
				"SVar:TrigB:DB$ Draw",
				"SVar:TrigC:DB$ Draw",
				"SVar:TrigD:DB$ Draw",
			].join("\n"),
		);
		expect(
			result.card.graph.edges.map((e) => `${e.role}:${e.rawReference}`),
		).toEqual([
			"haunt:TrigA",
			"visit:TrigB",
			"prize:TrigC",
			"opening-hand-effect:TrigD",
		]);
		expect(result.diagnostics).toEqual([]);
	});

	test("etbCounter treats its amount as an optional reference", () => {
		const literal = parseForgeCardScript(
			["Name:Lit", "K:etbCounter:P1P1:2:no Condition:enters with two."].join(
				"\n",
			),
		);
		expect(literal.card.graph.edges).toHaveLength(0);
		expect(literal.diagnostics).toEqual([]);

		const named = parseForgeCardScript(
			[
				"Name:Named",
				"K:etbCounter:P1P1:X:no Condition:enters with X.",
				"SVar:X:Count$YourLifeTotal",
			].join("\n"),
		);
		const edge = named.card.graph.edges[0];
		expect(edge?.role).toBe("etb-counter-amount");
		expect(edge?.rawReference).toBe("X");
		expect(edge?.status).toBe("resolved");
	});

	test("etbCounter parses a condition parameter list in segment 3", () => {
		const result = parseForgeCardScript(
			[
				"Name:Cond",
				"K:etbCounter:DIVINITY:1:CheckSVar$ FromHand:desc",
				"SVar:FromHand:Count$ThisTurnCast",
			].join("\n"),
		);
		const rec = face(result, "original").keywordRecords[0];
		expect(rec?.params?.entries.map((e) => e.key)).toEqual(["CheckSVar"]);
		expect(result.card.graph.edges[0]?.role).toBe("condition");
		// `no Condition` is the explicit "nothing here" marker and is skipped.
		const none = parseForgeCardScript(
			"Name:N\nK:etbCounter:P1P1:1:no Condition:d",
		);
		expect(face(none, "original").keywordRecords[0]?.params).toBeUndefined();
	});

	// Both of these are genuine defects in shipped card scripts: Forge's
	// makeEtbCounter only skips the literal "no Condition", so a lowercase
	// variant or a description in the condition slot is fed to the param parser.
	test("real corpus etbCounter defects are surfaced, not hidden", () => {
		for (const [name, fragment] of [
			["bringer_of_green_zeniths_twilight", "no condition"],
			["sautekh_immortal", "Elite Troops"],
		] as const) {
			const result = parseForgeCardScript(card(name));
			const bad = result.diagnostics.filter(
				(d) => d.code === "MALFORMED_PARAM",
			);
			expect(bad).toHaveLength(1);
			expect(bad[0]?.message).toContain(fragment);
			expectRoundTrip(card(name));
		}
	});

	test("an unknown keyword never becomes a graph node", () => {
		const result = parseForgeCardScript(
			["Name:Plain", "K:Flying", "K:Ward:2", "SVar:Unused:DB$ Draw"].join("\n"),
		);
		expect(
			result.card.graph.nodes.filter((n) => n.kind === "keyword"),
		).toHaveLength(0);
	});
});

/* ------------------------------------------------------------------------- */
/* 1. Ordinary one-face card                                                  */
/* ------------------------------------------------------------------------- */

describe("ordinary one-face card", () => {
	const source = card("into_the_maw_of_hell");
	const result = parseForgeCardScript(source);

	test("produces a single original face with indexed characteristics", () => {
		expect(result.card.faces).toHaveLength(1);
		const original = face(result, "original");
		expect(original.slot).toBe(0);
		expect(original.characteristics.name?.value).toBe("Into the Maw of Hell");
		expect(original.characteristics.manaCost?.value).toBe("4 R R");
		expect(original.characteristics.types?.value).toBe("Sorcery");
		expect(original.characteristics.oracle?.value).toContain(
			"Destroy target land",
		);
	});

	test("emits no diagnostics for a clean card", () => {
		expect(result.diagnostics).toEqual([]);
	});

	test("every meaningful line becomes exactly one source node", () => {
		const meaningful = source
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line !== "" && !line.startsWith("#"));
		expect(result.document.nodes).toHaveLength(meaningful.length);
	});
});

/* ------------------------------------------------------------------------- */
/* 2. Spell ability with a known API                                          */
/* ------------------------------------------------------------------------- */

describe("spell ability with a known API", () => {
	test("classifies SP$ as a spell and recognises the effect name", () => {
		const result = parseForgeCardScript(card("dismember"));
		const ability = face(result, "original").abilities[0];
		expect(ability?.abilityKind).toBe("spell");
		expect(ability?.discriminator).toBe("SP");
		expect(ability?.effectName).toBe("Pump");
		expect(ability?.effectKnown).toBe(true);
	});

	test("classifies AB$ as activated and DB$ as a sub-ability", () => {
		const result = parseForgeCardScript(card("eye_of_vecna"));
		const original = face(result, "original");
		const upkeep = lookupForgeSVar(original, "TrigDrawUpkeep");
		expect(upkeep?.classified?.kind).toBe("ability");
		expect(
			upkeep?.classified?.kind === "ability"
				? upkeep.classified.abilityKind
				: undefined,
		).toBe("activated");

		const loseLife = lookupForgeSVar(original, "DBLoseLife");
		expect(
			loseLife?.classified?.kind === "ability"
				? loseLife.classified.abilityKind
				: undefined,
		).toBe("sub-ability");
	});

	test("classifies triggers, replacements and statics by discriminator", () => {
		const vecna = parseForgeCardScript(card("eye_of_vecna"));
		const triggers = face(vecna, "original").triggers;
		expect(triggers).toHaveLength(2);
		expect(triggers[0]?.mode).toBe("ChangesZone");
		expect(triggers[0]?.modeKnown).toBe(true);

		const goyf = parseForgeCardScript(card("tarmogoyf"));
		const statics = face(goyf, "original").statics;
		expect(statics[0]?.mode).toBe("Continuous");
		expect(statics[0]?.modes).toEqual(["Continuous"]);
		expect(statics[0]?.modeKnown).toBe(true);
	});

	test("splits a comma/space separated static Mode$ into several modes", () => {
		// StaticAbilityMode.setValueOf splits on [, ]+ and unions the results.
		const result = parseForgeCardScript(
			[
				"Name:Multi Mode",
				"S:Mode$ CantAttack,CantBlock | ValidCard$ Creature",
			].join("\n"),
		);
		const record = face(result, "original").statics[0];
		expect(record?.modes).toEqual(["CantAttack", "CantBlock"]);
		expect(record?.modeKnown).toBe(true);
	});
});

/* ------------------------------------------------------------------------- */
/* 3. Unknown directive, operation and parameter                              */
/* ------------------------------------------------------------------------- */

describe("unknown vocabulary is preserved, never rejected", () => {
	const source = [
		"Name:Future Card",
		"ManaCost:1 U",
		"Types:Instant Hypothetical",
		"TotallyNewDirective:some future value",
		"A:SP$ WarpRealitySideways | BrandNewParam$ 7 | ValidTgts$ Chronomancer",
		"Oracle:Nothing yet.",
	].join("\n");
	const result = parseForgeCardScript(source);

	test("keeps an unknown directive with no diagnostic noise", () => {
		const other = face(result, "original").otherDirectives;
		expect(other.map((ref) => ref.key)).toContain("TotallyNewDirective");
		expect(other[0]?.value).toBe("some future value");
		expect(codes(result.diagnostics)).not.toContain("MALFORMED_LINE");
	});

	test("keeps an unknown effect name and only reports it informationally", () => {
		const ability = face(result, "original").abilities[0];
		expect(ability?.abilityKind).toBe("spell");
		expect(ability?.effectName).toBe("WarpRealitySideways");
		expect(ability?.effectKnown).toBe(false);
		const unknown = result.diagnostics.filter(
			(d) => d.code === "UNKNOWN_EFFECT",
		);
		expect(unknown).toHaveLength(1);
		expect(unknown[0]?.severity).toBe("info");
	});

	test("keeps an unknown parameter as ordinary data", () => {
		const ability = face(result, "original").abilities[0];
		expect(getForgeParam(ability?.params as never, "BrandNewParam")).toBe("7");
		expect(ability?.params.entries.map((e) => e.key)).toEqual([
			"SP",
			"BrandNewParam",
			"ValidTgts",
		]);
	});

	test("round-trips", () => {
		expectRoundTrip(source);
	});

	// Real corpus/Java divergences at the reference revision: these names appear
	// in shipped card scripts but not in the Java enums. They stay representable.
	test("real corpus names missing from the Java enums stay representable", () => {
		const recruit = parseForgeCardScript(card("sound_the_trumpets"));
		const svar = lookupForgeSVar(face(recruit, "original"), "DBRecruit");
		expect(
			svar?.classified?.kind === "ability" ? svar.classified.effectName : "",
		).toBe("Recruit");
		expect(isKnownForgeEffectName("Recruit")).toBe(false);

		const dilemma = parseForgeCardScript(card("seven_of_nine"));
		expect(face(dilemma, "original").triggers[0]?.mode).toBe("FacesDilemma");
		expect(isKnownForgeTriggerMode("FacesDilemma")).toBe(false);
	});
});

/* ------------------------------------------------------------------------- */
/* 4. Compound activated cost                                                 */
/* ------------------------------------------------------------------------- */

describe("compound activated cost", () => {
	test("keeps a Cost$ string verbatim without evaluating it", () => {
		const result = parseForgeCardScript(card("reckless_abandon"));
		const ability = face(result, "original").abilities[0];
		// `Sac<1/Creature>` contains no `|` or `$`, so the naive tokenizer is safe.
		expect(getForgeParam(ability?.params as never, "Cost")).toBe(
			"R Sac<1/Creature>",
		);
	});

	test("keeps costs containing colons and slashes", () => {
		const params = parseForgeParams(
			"AB$ Draw | Cost$ 2 W tapXType<2/Creature.untapped/untapped creature> T Discard<1/Card> | NumCards$ 1",
		);
		expect(params.entries[1]?.value).toBe(
			"2 W tapXType<2/Creature.untapped/untapped creature> T Discard<1/Card>",
		);
	});
});

/* ------------------------------------------------------------------------- */
/* 5 + 6 + 7. SVar chains, branches, independent targets                      */
/* ------------------------------------------------------------------------- */

describe("reference graph", () => {
	test("links a linear SubAbility chain instead of inlining it", () => {
		const result = parseForgeCardScript(card("into_the_maw_of_hell"));
		const graph = result.card.graph;
		const edge = graph.edges.find((e) => e.role === "sub-ability");
		expect(edge?.status).toBe("resolved");
		expect(edge?.rawReference).toBe("DBDamage");
		const destination = graph.nodes.find((n) => n.id === edge?.to);
		expect(destination?.kind).toBe("svar");
		expect(destination?.name).toBe("DBDamage");
	});

	test("shares one SVar definition between two referencing records", () => {
		// Eye of Vecna: TrigDraw and TrigDrawUpkeep both chain into DBLoseLife.
		const result = parseForgeCardScript(card("eye_of_vecna"));
		const shared = result.card.graph.edges.filter(
			(e) => e.rawReference === "DBLoseLife",
		);
		expect(shared).toHaveLength(2);
		expect(new Set(shared.map((e) => e.from)).size).toBe(2);
		expect(new Set(shared.map((e) => e.to)).size).toBe(1);
	});

	test("branches through Charm Choices$ into several sub-abilities", () => {
		const result = parseForgeCardScript(card("casey_raph_hotheads"));
		const choices = result.card.graph.edges.filter((e) => e.role === "choice");
		expect(choices.map((e) => e.rawReference)).toEqual(["DBExile", "DBToken"]);
		for (const edge of choices) expect(edge.status).toBe("resolved");
	});

	test("does not treat Choices$ as a reference for non-choice APIs", () => {
		// AbilityFactory only reads Choices$ as an ability list for Charm,
		// GenericChoice, AssignGroup, VillainousChoice and Vote. For
		// ChoosePlayer it is a plain selector.
		const result = parseForgeCardScript(
			[
				"Name:Gate Check",
				"A:SP$ ChoosePlayer | Defined$ You | Choices$ Player.Opponent",
			].join("\n"),
		);
		expect(result.card.graph.edges).toHaveLength(0);
		expect(codes(result.diagnostics)).not.toContain(
			"UNRESOLVED_SVAR_REFERENCE",
		);
	});

	test("expands labelled ResultSubAbilities entries for RollDice", () => {
		const result = parseForgeCardScript(
			[
				"Name:Dice Roller",
				"A:SP$ RollDice | ResultSubAbilities$ 1-3:DBLow,4-6:DBHigh",
				"SVar:DBLow:DB$ Draw | NumCards$ 1",
				"SVar:DBHigh:DB$ Draw | NumCards$ 2",
			].join("\n"),
		);
		const edges = result.card.graph.edges.filter(
			(e) => e.role === "roll-result",
		);
		expect(edges.map((e) => [e.label, e.rawReference, e.status])).toEqual([
			["1-3", "DBLow", "resolved"],
			["4-6", "DBHigh", "resolved"],
		]);
	});

	test("keeps independent targets declared on a sub-ability", () => {
		// Into the Maw of Hell targets a land, then its sub-ability independently
		// targets a creature. Both ValidTgts$ survive on their own records.
		const result = parseForgeCardScript(card("into_the_maw_of_hell"));
		const original = face(result, "original");
		expect(
			getForgeParam(original.abilities[0]?.params as never, "ValidTgts"),
		).toBe("Land");
		const sub = lookupForgeSVar(original, "DBDamage");
		const subParams =
			sub?.parsed.kind === "params" ? sub.parsed.params : undefined;
		expect(getForgeParam(subParams as never, "ValidTgts")).toBe("Creature");
		expect(getForgeParam(subParams as never, "NumDmg")).toBe("13");
	});

	test("buildForgeReferenceGraph rebuilds the same graph standalone", () => {
		const result = parseForgeCardScript(card("eye_of_vecna"));
		expect(buildForgeReferenceGraph(result.card)).toEqual(result.card.graph);
	});
});

/* ------------------------------------------------------------------------- */
/* 8 + 9 + 10 + 11 + 12. Faces                                                */
/* ------------------------------------------------------------------------- */

describe("faces", () => {
	test("splits a split card at the bare ALTERNATE marker", () => {
		const source = card("fire_ice");
		const result = parseForgeCardScript(source);
		expect(result.card.faces.map((f) => f.state)).toEqual([
			"original",
			"alternate",
		]);
		expect(face(result, "original").characteristics.name?.value).toBe("Fire");
		expect(face(result, "alternate").characteristics.name?.value).toBe("Ice");

		const marker = result.document.nodes.find((n) => n.kind === "face-marker");
		expect(marker?.kind === "face-marker" ? marker.marker : "").toBe(
			"ALTERNATE",
		);
		expect(
			marker?.kind === "face-marker" ? marker.argument : "x",
		).toBeUndefined();

		// AlternateMode is Reader-level state in Forge, not a face characteristic.
		expect(result.card.cardDirectives.map((d) => [d.key, d.value])).toEqual([
			["AlternateMode", "Split"],
		]);
		expectRoundTrip(source);
	});

	test("each face keeps its own SVars and reference scope", () => {
		const result = parseForgeCardScript(card("fire_ice"));
		expect(lookupForgeSVar(face(result, "original"), "DBDraw")).toBeUndefined();
		expect(lookupForgeSVar(face(result, "alternate"), "DBDraw")).toBeDefined();
		const edge = result.card.graph.edges.find(
			(e) => e.rawReference === "DBDraw",
		);
		expect(edge?.status).toBe("resolved");
	});

	test("represents transform / adventure / modal alternate faces", () => {
		for (const [name, mode] of [
			// Forge spells transform as `DoubleFaced`; CardSplitType.smartValueOf
			// maps that alias onto Transform. The source spelling is preserved.
			["fable_of_the_mirror_breaker_reflection_of_kiki_jiki", "DoubleFaced"],
			["bonecrusher_giant_stomp", "Adventure"],
		] as const) {
			const source = card(name);
			const result = parseForgeCardScript(source);
			expect(result.card.faces.map((f) => f.state)).toEqual([
				"original",
				"alternate",
			]);
			expect(
				result.card.cardDirectives.find((d) => d.key === "AlternateMode")
					?.value,
			).toBe(mode);
			expectRoundTrip(source);
		}
	});

	test("represents all five specialize faces", () => {
		const source = card("karlach_raging_tiefling");
		const result = parseForgeCardScript(source);
		expect(result.card.faces.map((f) => f.state)).toEqual([
			"original",
			"specialize-white",
			"specialize-blue",
			"specialize-black",
			"specialize-red",
			"specialize-green",
		]);
		const markers = result.document.nodes.filter(
			(n) => n.kind === "face-marker",
		);
		expect(markers).toHaveLength(5);
		expect(
			markers.map((m) => (m.kind === "face-marker" ? m.argument : undefined)),
		).toEqual(["WHITE", "BLUE", "BLACK", "RED", "GREEN"]);
		expectRoundTrip(source);
	});

	test("an unrecognised specialize colour keeps the current face and warns", () => {
		const result = parseForgeCardScript(
			["Name:Odd Card", "SPECIALIZE:MAUVE", "Oracle:Still on face 0."].join(
				"\n",
			),
		);
		expect(result.card.faces.map((f) => f.state)).toEqual(["original"]);
		expect(codes(result.diagnostics)).toContain("UNKNOWN_FACE_MARKER");
		expect(face(result, "original").characteristics.oracle?.value).toBe(
			"Still on face 0.",
		);
	});

	test("keeps functional Variant: patches beside the face, not merged into it", () => {
		const source = card("zangief_the_red_cyclone");
		const result = parseForgeCardScript(source);
		const original = face(result, "original");
		expect(original.variants.length).toBeGreaterThan(0);
		const variant = original.variants[0];
		expect(variant?.name).toBe("UniversesWithin");
		expect(variant?.patch.key).toBe("FlavorName");
		expect(variant?.patch.value).toBe("Maarika, Brutal Gladiator");
		// The patched FlavorName must NOT overwrite the base face.
		expect(original.characteristics.flavorName).toBeUndefined();
		expectRoundTrip(source);
	});

	test("keeps a Variant: patch carrying a nested record", () => {
		const result = parseForgeCardScript(
			[
				"Name:Patched",
				"Types:Creature Human",
				"PT:1/1",
				"Variant:B:SVar:DBDraw:DB$ Draw | NumCards$ 1",
				"Variant:B:A:AB$ Draw | Cost$ T | SubAbility$ DBDraw",
			].join("\n"),
		);
		const variants = face(result, "original").variants;
		expect(variants).toHaveLength(2);
		expect(variants[0]?.svar?.name).toBe("DBDraw");
		expect(variants[1]?.classified?.kind).toBe("ability");
		// The face itself gains neither the SVar nor the ability.
		expect(face(result, "original").abilities).toHaveLength(0);
		expect(face(result, "original").svars).toHaveLength(0);
		// The variant's own reference still resolves inside the variant's scope.
		const edge = result.card.graph.edges.find((e) => e.role === "sub-ability");
		expect(edge?.status).toBe("resolved");
	});

	test("keeps CopyFaceFrom as an unresolved external reference", () => {
		const source = card("infirmary_healer_stream_of_life");
		const result = parseForgeCardScript(source);
		const alternate = face(result, "alternate");
		expect(alternate.characteristics.copyFaceFrom?.value).toBe(
			"Stream of Life",
		);
		// The referenced face must not be materialized or merged.
		expect(alternate.characteristics.name).toBeUndefined();
		expect(alternate.abilities).toHaveLength(0);

		const edge = result.card.graph.edges.find(
			(e) => e.role === "copy-face-from",
		);
		expect(edge?.status).toBe("external");
		expect(edge?.rawReference).toBe("Stream of Life");
		expect(codes(result.diagnostics)).toContain("EXTERNAL_FACE_REFERENCE");
		expectRoundTrip(source);
	});
});

/* ------------------------------------------------------------------------- */
/* 13. Dynamic mana costs and dynamic P/T                                     */
/* ------------------------------------------------------------------------- */

describe("open characteristic vocabulary", () => {
	test("keeps dynamic P/T expressions verbatim", () => {
		const result = parseForgeCardScript(card("tarmogoyf"));
		expect(face(result, "original").characteristics.pt?.value).toBe("*/1+*");
	});

	test("keeps Phyrexian, hybrid, snow and X mana symbols verbatim", () => {
		expect(
			face(parseForgeCardScript(card("dismember")), "original").characteristics
				.manaCost?.value,
		).toBe("1 BP BP");
		const exotic = parseForgeCardScript(
			[
				"Name:Exotic",
				"ManaCost:X X S 2/W U/B GP",
				"Types:Snow Artifact Weirdcard",
				"PT:*/*+1",
				"Colors:white,blue,mauve",
				"Loyalty:X",
				"Defense:*",
			].join("\n"),
		);
		const c = face(exotic, "original").characteristics;
		expect(c.manaCost?.value).toBe("X X S 2/W U/B GP");
		expect(c.types?.value).toBe("Snow Artifact Weirdcard");
		expect(c.pt?.value).toBe("*/*+1");
		expect(c.colors?.value).toBe("white,blue,mauve");
		expect(c.loyalty?.value).toBe("X");
		expect(c.defense?.value).toBe("*");
		expect(exotic.diagnostics).toEqual([]);
	});

	test("indexes attraction lights under the corpus spelling `Lights`", () => {
		const result = parseForgeCardScript(
			["Name:Attraction", "Types:Artifact Attraction", "Lights:2 6"].join("\n"),
		);
		expect(
			face(result, "original").characteristics.attractionLights?.value,
		).toBe("2 6");
	});
});

/* ------------------------------------------------------------------------- */
/* 14. Duplicates                                                             */
/* ------------------------------------------------------------------------- */

describe("duplicates survive", () => {
	const source = [
		"Name:Duplicated",
		"Types:Instant",
		"K:Flying",
		"K:Flying",
		"A:SP$ Draw | NumCards$ 1 | NumCards$ 2 | numcards$ 3",
		"SVar:Dup:DB$ Draw | NumCards$ 1",
		"SVar:dup:DB$ Draw | NumCards$ 2",
		"Oracle:x",
		"Oracle:y",
	].join("\n");
	const result = parseForgeCardScript(source);

	test("keeps duplicate directives in order", () => {
		expect(face(result, "original").keywords.map((k) => k.value)).toEqual([
			"Flying",
			"Flying",
		]);
		expect(
			face(result, "original")
				.characteristics.all.filter((d) => d.key === "Oracle")
				.map((d) => d.value),
		).toEqual(["x", "y"]);
		// The named slot holds the last occurrence, like Forge.
		expect(face(result, "original").characteristics.oracle?.value).toBe("y");
	});

	test("keeps duplicate parameters in entries and last-write-wins in effective", () => {
		const params = face(result, "original").abilities[0]?.params;
		expect(params?.entries.map((e) => e.key)).toEqual([
			"SP",
			"NumCards",
			"NumCards",
			"numcards",
		]);
		// FileSection.parseToMap uses a case-insensitive, last-write-wins TreeMap.
		expect(getForgeParam(params as never, "NumCards")).toBe("3");
		expect(params?.effective.get("NumCards")).toBe("3");
		expect([...(params?.effective.keys() ?? [])]).toEqual(["SP", "NumCards"]);
	});

	test("keeps duplicate and case-variant SVar definitions", () => {
		const original = face(result, "original");
		expect(original.svars).toHaveLength(2);
		expect(original.svarIndex.get("dup")).toHaveLength(2);
		// CardFace.addSVar is case-insensitive; Forge would keep only the last.
		expect(lookupForgeSVar(original, "DUP")?.value).toBe(
			"DB$ Draw | NumCards$ 2",
		);
		const duplicate = result.diagnostics.filter(
			(d) => d.code === "DUPLICATE_SVAR",
		);
		expect(duplicate).toHaveLength(1);
	});

	test("round-trips without collapsing anything", () => {
		const document = expectRoundTrip(source);
		expect(document.nodes).toHaveLength(9);
	});
});

/* ------------------------------------------------------------------------- */
/* 15 + 16. Unresolved, ambiguous and cyclic references                       */
/* ------------------------------------------------------------------------- */

describe("difficult references never crash parsing", () => {
	test("reports an unresolved reference and keeps the record", () => {
		const result = parseForgeCardScript(
			["Name:Dangling", "A:SP$ Draw | SubAbility$ NoSuchSVar"].join("\n"),
		);
		const edge = result.card.graph.edges[0];
		expect(edge?.status).toBe("unresolved");
		expect(edge?.to).toBeUndefined();
		expect(edge?.candidates).toEqual([]);
		expect(codes(result.diagnostics)).toContain("UNRESOLVED_SVAR_REFERENCE");
		expect(face(result, "original").abilities).toHaveLength(1);
	});

	test("real corpus card with a dangling SubAbility still parses", () => {
		// casey_raph_hotheads references SVar `DBCleanup`, which the script never
		// defines. Forge logs and continues; so do we.
		const result = parseForgeCardScript(card("casey_raph_hotheads"));
		expect(
			result.diagnostics.filter((d) => d.code === "UNRESOLVED_SVAR_REFERENCE"),
		).toHaveLength(1);
		expect(result.card.faces).toHaveLength(1);
	});

	test("reports an ambiguous reference and picks Forge's last definition", () => {
		const result = parseForgeCardScript(
			[
				"Name:Ambiguous",
				"A:SP$ Draw | SubAbility$ DBThing",
				"SVar:DBThing:DB$ Draw | NumCards$ 1",
				"SVar:dbthing:DB$ Draw | NumCards$ 2",
			].join("\n"),
		);
		const edge = result.card.graph.edges[0];
		expect(edge?.status).toBe("ambiguous");
		expect(edge?.candidates).toEqual(["line:3", "line:4"]);
		expect(edge?.to).toBe("line:4");
		expect(codes(result.diagnostics)).toContain("AMBIGUOUS_SVAR_REFERENCE");
	});

	test("a synthetic reference cycle is reported, not recursed into", () => {
		const result = parseForgeCardScript(
			[
				"Name:Ouroboros",
				"A:SP$ Draw | SubAbility$ DBA",
				"SVar:DBA:DB$ Draw | SubAbility$ DBB",
				"SVar:DBB:DB$ Draw | SubAbility$ DBA",
			].join("\n"),
		);
		expect(result.card.graph.cycles).toHaveLength(1);
		expect(result.card.graph.cycles[0]?.sort()).toEqual(["line:3", "line:4"]);
		expect(codes(result.diagnostics)).toContain("CYCLIC_SVAR_REFERENCE");
	});

	test("a self-referencing SVar is a cycle of one", () => {
		const result = parseForgeCardScript(
			["Name:Self", "SVar:DBLoop:DB$ Draw | SubAbility$ DBLoop"].join("\n"),
		);
		expect(result.card.graph.cycles).toEqual([["line:2"]]);
	});

	test("a real corpus cycle parses without recursion", () => {
		// Sibsig's Artisan: DBArtisanAnimate grants ABArtisanRenew, whose
		// SubAbility$ points back at DBArtisanAnimate.
		const result = parseForgeCardScript(card("sibsigs_artisan"));
		expect(result.card.graph.cycles).toHaveLength(1);
		expect(codes(result.diagnostics)).toContain("CYCLIC_SVAR_REFERENCE");
	});

	test("a very deep SubAbility chain does not overflow the stack", () => {
		const depth = 5000;
		const lines = ["Name:Deep", "A:SP$ Draw | SubAbility$ S0"];
		for (let i = 0; i < depth; i++) {
			lines.push(`SVar:S${i}:DB$ Draw | SubAbility$ S${i + 1}`);
		}
		lines.push(`SVar:S${depth}:DB$ Draw`);
		const result = parseForgeCardScript(lines.join("\n"));
		expect(result.card.graph.cycles).toEqual([]);
		expect(result.card.graph.edges).toHaveLength(depth + 1);
	});
});

/* ------------------------------------------------------------------------- */
/* 17. Malformed recovery                                                     */
/* ------------------------------------------------------------------------- */

describe("malformed input recovery", () => {
	test("retains an unclassifiable line and keeps parsing", () => {
		const source = [
			"Name:Broken",
			"this line has no colon",
			":leading colon",
			"Oracle:still parsed",
		].join("\n");
		const result = parseForgeCardScript(source);
		const malformed = result.document.nodes.filter(
			(n) => n.kind === "malformed",
		);
		expect(malformed.map((n) => (n.kind === "malformed" ? n.raw : ""))).toEqual(
			["this line has no colon", ":leading colon"],
		);
		expect(
			codes(result.diagnostics).filter((c) => c === "MALFORMED_LINE"),
		).toHaveLength(2);
		expect(face(result, "original").characteristics.oracle?.value).toBe(
			"still parsed",
		);
		expectRoundTrip(source);
	});

	test("retains a malformed parameter fragment", () => {
		const result = parseForgeCardScript(
			["Name:Broken Param", "A:SP$ Draw | NoDollarHere | NumCards$ 1"].join(
				"\n",
			),
		);
		const entries = face(result, "original").abilities[0]?.params.entries;
		expect(entries).toHaveLength(3);
		expect(entries?.[1]?.malformed).toBe(true);
		expect(entries?.[1]?.raw).toBe(" NoDollarHere ");
		expect(entries?.[1]?.key).toBe("NoDollarHere");
		expect(entries?.[1]?.value).toBe("");
		expect(codes(result.diagnostics)).toContain("MALFORMED_PARAM");
		// The record still classifies normally.
		expect(face(result, "original").abilities[0]?.effectName).toBe("Draw");
	});

	// Two shipped cards genuinely have this defect; they are the regression cases.
	test("the two real malformed-parameter corpus cards parse and are flagged", () => {
		for (const name of ["criminal_past", "volatile_rift"]) {
			const result = parseForgeCardScript(card(name));
			expect(
				result.diagnostics.filter((d) => d.code === "MALFORMED_PARAM"),
			).toHaveLength(1);
			expectRoundTrip(card(name));
		}
	});

	test("reports a missing ability discriminator without dropping the record", () => {
		const result = parseForgeCardScript(
			["Name:No Discriminator", "A:ValidTgts$ Creature | NumDmg$ 3"].join("\n"),
		);
		const ability = face(result, "original").abilities[0];
		expect(ability?.abilityKind).toBe("unknown");
		expect(ability?.effectName).toBeUndefined();
		expect(ability?.params.entries).toHaveLength(2);
		expect(codes(result.diagnostics)).toContain("MISSING_DISCRIMINATOR");
	});

	test("reports conflicting discriminators and keeps every parameter", () => {
		const result = parseForgeCardScript(
			["Name:Conflicted", "A:SP$ Draw | DB$ DealDamage | NumCards$ 1"].join(
				"\n",
			),
		);
		const ability = face(result, "original").abilities[0];
		// AbilityRecordType.getRecordType checks AB, then SP, then ST, then DB.
		expect(ability?.abilityKind).toBe("spell");
		expect(ability?.effectName).toBe("Draw");
		expect(ability?.params.entries).toHaveLength(3);
		expect(codes(result.diagnostics)).toContain("CONFLICTING_DISCRIMINATORS");
	});

	test("reports a malformed SVar and keeps its text", () => {
		const result = parseForgeCardScript(
			["Name:Bad SVar", "SVar:NoValueSeparator"].join("\n"),
		);
		const svar = face(result, "original").svars[0];
		expect(svar?.name).toBe("NoValueSeparator");
		expect(svar?.parsed.kind).toBe("scalar");
		expect(codes(result.diagnostics)).toContain("MALFORMED_SVAR");
		expectRoundTrip("Name:Bad SVar\nSVar:NoValueSeparator");
	});

	test("reports a malformed Variant and keeps the directive", () => {
		const result = parseForgeCardScript(
			["Name:Bad Variant", "Variant:NoInnerDirective"].join("\n"),
		);
		expect(face(result, "original").variants).toHaveLength(0);
		expect(face(result, "original").otherDirectives.map((d) => d.key)).toEqual([
			"Variant",
		]);
		expect(codes(result.diagnostics)).toContain("MALFORMED_VARIANT");
	});

	test("an empty script is a valid, empty document", () => {
		const result = parseForgeCardScript("");
		expect(result.document.nodes).toEqual([]);
		expect(result.diagnostics).toEqual([]);
		expect(printForgeCardScript(result.document)).toBe("");
	});
});

/* ------------------------------------------------------------------------- */
/* Parameter parser specifics                                                 */
/* ------------------------------------------------------------------------- */

describe("parseForgeParams", () => {
	test("splits on | and at the first $ only", () => {
		// Count$ValidGraveyard Card$CardTypes contains a second $ that belongs to
		// the value; FileSection splits with limit 2.
		const params = parseForgeParams("Count$ValidGraveyard Card$CardTypes");
		expect(params.entries).toHaveLength(1);
		expect(params.entries[0]?.key).toBe("Count");
		expect(params.entries[0]?.value).toBe("ValidGraveyard Card$CardTypes");
	});

	test("preserves raw text while trimming key and value", () => {
		const params = parseForgeParams("  KW $  Ward:1  ");
		expect(params.entries[0]?.raw).toBe("  KW $  Ward:1  ");
		expect(params.entries[0]?.keyRaw).toBe("  KW ");
		expect(params.entries[0]?.valueRaw).toBe("  Ward:1  ");
		expect(params.entries[0]?.key).toBe("KW");
		expect(params.entries[0]?.value).toBe("Ward:1");
	});

	test("has no delimiter escape syntax, matching Forge", () => {
		// FileSection quotes both "|" and "$" as literal patterns and offers no
		// escape. A search of the whole corpus finds zero `\|` sequences, zero
		// empty `||` fragments and zero trailing `|`, so naive splitting is the
		// faithful reading. A backslash is therefore just an ordinary character.
		const params = parseForgeParams("A$ one \\| two | B$ three");
		expect(params.entries.map((e) => e.key)).toEqual(["A", "two", "B"]);
		expect(params.entries[1]?.malformed).toBe(true);
	});

	test("an empty body yields no entries", () => {
		expect(parseForgeParams("").entries).toEqual([]);
		expect(parseForgeParams("").effective).toEqual(new Map());
	});

	test("generates deterministic, prefix-scoped parameter ids", () => {
		const params = parseForgeParams("A$ 1 | B$ 2", "line:7");
		expect(params.entries.map((e) => e.id)).toEqual([
			"line:7/param:0",
			"line:7/param:1",
		]);
	});

	test("treats object-prototype names as ordinary parameter names", () => {
		const params = parseForgeParams(
			"constructor$ first | __proto__$ second | prototype$ third",
		);
		expect(getForgeParam(params, "constructor")).toBe("first");
		expect(getForgeParam(params, "__proto__")).toBe("second");
		expect(getForgeParam(params, "prototype")).toBe("third");
		expect(getForgeParam(params, "toString")).toBeUndefined();
	});
});

describe("adversarial open-vocabulary names", () => {
	for (const name of ["constructor", "prototype", "__proto__", "toString"]) {
		test(`parses SVar name ${name} without throwing`, () => {
			const result = parseForgeCardScript(
				`Name:Test\nManaCost:0\nTypes:Artifact\nSVar:${name}:1\n`,
			);
			const original = face(result, "original");
			expect(original.svars.map((svar) => svar.name)).toEqual([name]);
			expect(lookupForgeSVar(original, name)?.value).toBe("1");
		});
	}
});

/* ------------------------------------------------------------------------- */
/* SVar forms                                                                 */
/* ------------------------------------------------------------------------- */

describe("SVar forms", () => {
	test("keeps scalar, expression, flag and AI SVars uninterpreted", () => {
		const result = parseForgeCardScript(
			[
				"Name:SVar Zoo",
				"SVar:X:Count$ValidGraveyard Card$CardTypes",
				"SVar:Y:SVar$X/Plus.1",
				"SVar:PlayMain1:TRUE",
				"SVar:BuffedBy:Creature",
				"SVar:NeedsToPlay:5",
				"SVar:AIPrefs:ThisTurn$ True | MaxControlled$ 1",
			].join("\n"),
		);
		const svars = face(result, "original").svars;
		expect(svars).toHaveLength(6);
		for (const svar of svars) expect(svar.parsed.kind).toBe("scalar");
		expect(svars[0]?.value).toBe("Count$ValidGraveyard Card$CardTypes");
		expect(svars[1]?.value).toBe("SVar$X/Plus.1");
		// An AI-hint SVar may even contain `|` and still is not an ability record.
		expect(svars[5]?.value).toBe("ThisTurn$ True | MaxControlled$ 1");
	});

	test("keeps extra colons inside an SVar value", () => {
		const result = parseForgeCardScript(
			[
				"Name:Colons",
				"SVar:TrigPump:DB$ Pump | KW$ Blitz:CardManaCost:Spell.Creature",
			].join("\n"),
		);
		const svar = face(result, "original").svars[0];
		expect(svar?.name).toBe("TrigPump");
		expect(svar?.value).toBe(
			"DB$ Pump | KW$ Blitz:CardManaCost:Spell.Creature",
		);
	});

	test("classifies ability, trigger, replacement and static SVars", () => {
		const result = parseForgeCardScript(
			[
				"Name:Classified",
				"SVar:AbSVar:DB$ Draw | NumCards$ 1",
				"SVar:TrigSVar:Mode$ AttackersDeclared | AttackingPlayer$ You",
				"SVar:StSVar:Mode$ Continuous | Affected$ You",
				"SVar:RepSVar:Event$ DamageDone | ValidTarget$ You",
			].join("\n"),
		);
		const original = face(result, "original");
		expect(lookupForgeSVar(original, "AbSVar")?.classified?.kind).toBe(
			"ability",
		);
		expect(lookupForgeSVar(original, "TrigSVar")?.classified?.kind).toBe(
			"trigger",
		);
		expect(lookupForgeSVar(original, "StSVar")?.classified?.kind).toBe(
			"static",
		);
		expect(lookupForgeSVar(original, "RepSVar")?.classified?.kind).toBe(
			"replacement",
		);
	});

	test("an AB/SP/ST/DB discriminator wins over a Mode$ effect parameter", () => {
		// `DB$ Discard | Mode$ TgtChoose` is an ability whose Mode$ is an ordinary
		// effect parameter, not a static ability mode.
		const result = parseForgeCardScript(
			["Name:Modey", "SVar:DBDiscard:DB$ Discard | Mode$ TgtChoose"].join("\n"),
		);
		const svar = face(result, "original").svars[0];
		expect(svar?.classified?.kind).toBe("ability");
		expect(
			svar?.classified?.kind === "ability" ? svar.classified.effectName : "",
		).toBe("Discard");
		expect(codes(result.diagnostics)).not.toContain("UNKNOWN_STATIC_MODE");
	});

	// Observed corpus/Java ambiguity, documented rather than guessed at: a bare
	// `Mode$` SVar with no discriminator is indistinguishable from a static
	// ability by structure alone. `astral_arena` uses one purely as an AI hint,
	// so it is classified as a static with an unknown mode and flagged.
	test("a bare Mode$ AI-hint SVar is flagged rather than silently reinterpreted", () => {
		const result = parseForgeCardScript(card("astral_arena"));
		const svar = lookupForgeSVar(
			face(result, "original"),
			"AIRollPlanarDieParams",
		);
		expect(svar?.value).toBe("Mode$ Random | MinTurn$ 5");
		expect(svar?.classified?.kind).toBe("static");
		expect(codes(result.diagnostics)).toContain("UNKNOWN_STATIC_MODE");
	});

	test("unused SVars are retained", () => {
		const result = parseForgeCardScript(
			["Name:Unused", "SVar:NeverReferenced:DB$ Draw | NumCards$ 9"].join("\n"),
		);
		expect(face(result, "original").svars).toHaveLength(1);
		expect(
			result.card.graph.nodes.some((n) => n.name === "NeverReferenced"),
		).toBe(true);
	});
});

/* ------------------------------------------------------------------------- */
/* 18. Canonical printing                                                     */
/* ------------------------------------------------------------------------- */

describe("canonical printer", () => {
	test("drops comments and blank lines, normalizes CRLF, ends with one newline", () => {
		const printed = printForgeCardScript(
			parseForgeCardScript(
				"# a comment\r\nName:Printed\r\n\r\n   Types:Instant   \r\n",
			).document,
		);
		expect(printed).toBe("Name:Printed\nTypes:Instant\n");
	});

	test("prints from source nodes so duplicates and unknowns cannot be lost", () => {
		const source = [
			"Name:Everything",
			"UnknownKey:unknown value",
			"K:Flying",
			"K:Flying",
			"no colon here",
			"ALTERNATE",
			"Name:Other Side",
			"SPECIALIZE:WHITE",
			"Name:White Side",
		].join("\n");
		expect(printForgeCardScript(parseForgeCardScript(source).document)).toBe(
			`${source}\n`,
		);
		expectRoundTrip(source);
	});

	test("buildForgeCardAst rebuilds the same faces from a printed document", () => {
		const first = parseForgeCardScript(card("karlach_raging_tiefling"));
		const reparsed = parseForgeCardScript(printForgeCardScript(first.document));
		const rebuilt = buildForgeCardAst(reparsed.document);
		expect(rebuilt.faces.map((f) => f.state)).toEqual(
			first.card.faces.map((f) => f.state),
		);
		expect(rebuilt.graph.edges.length).toBe(first.card.graph.edges.length);
	});
});

/* ------------------------------------------------------------------------- */
/* Amount parameters, runtime writes and expression operands                  */
/* ------------------------------------------------------------------------- */

describe("amount-parameter registry", () => {
	test("is API-gated, never a bare name match", () => {
		// DamageDealEffect passes NumDmg to calculateAmount, so it is a reference
		// for DealDamage - and for nothing else.
		expect(
			lookupForgeAmountParam("NumDmg", { isAbility: true, api: "DealDamage" }),
		).toBeDefined();
		expect(
			lookupForgeAmountParam("NumDmg", { isAbility: true, api: "Draw" }),
		).toBeUndefined();
		expect(
			lookupForgeAmountParam("NumDmg", { isAbility: false }),
		).toBeUndefined();
		expect(
			lookupForgeAmountParam("NotAParam", { isAbility: true, api: "Draw" }),
		).toBeUndefined();
	});

	test("static-mode gating is separate from API gating", () => {
		// StaticAbilityContinuous reads SetPower; an ability never does.
		expect(
			lookupForgeAmountParam("SetPower", {
				isAbility: false,
				staticModes: ["Continuous"],
			}),
		).toBeDefined();
		expect(
			lookupForgeAmountParam("SetPower", {
				isAbility: false,
				staticModes: ["CantAttack"],
			}),
		).toBeUndefined();
		expect(
			lookupForgeAmountParam("SetPower", { isAbility: true, api: "Pump" }),
		).toBeUndefined();
	});

	test("base-class parameters apply to any ability record", () => {
		// TargetRestrictions and SpellAbility read these for every ability.
		for (const p of [
			"Amount",
			"TargetMin",
			"TargetMax",
			"DividedAsYouChoose",
		]) {
			expect(
				lookupForgeAmountParam(p, { isAbility: true, api: "Whatever" }),
			).toBeDefined();
		}
		expect(
			lookupForgeAmountParam("Amount", { isAbility: false }),
		).toBeUndefined();
	});

	test("every row cites the Java it was derived from", () => {
		expect(FORGE_AMOUNT_PARAMS.length).toBeGreaterThan(50);
		for (const spec of FORGE_AMOUNT_PARAMS) {
			expect(spec.note.length).toBeGreaterThan(0);
			// A row with no scope at all would behave as a bare name match.
			expect(
				spec.apis !== undefined ||
					spec.staticModes !== undefined ||
					spec.anyAbility === true,
			).toBe(true);
		}
	});

	test("an amount value that names no SVar produces no edge and no diagnostic", () => {
		const result = parseForgeCardScript(
			[
				"Name:Literal Damage",
				"A:SP$ DealDamage | NumDmg$ 3 | ValidTgts$ Any",
			].join("\n"),
		);
		expect(result.card.graph.edges).toEqual([]);
		expect(result.diagnostics).toEqual([]);
	});
});

describe("runtime writes", () => {
	test("registry is API-gated", () => {
		expect(lookupForgeRuntimeWrite("ResultSVar", "RollDice")).toBeDefined();
		expect(lookupForgeRuntimeWrite("ResultSVar", "Draw")).toBeUndefined();
		expect(lookupForgeRuntimeWrite("SVar", "StoreSVar")).toBeDefined();
		expect(FORGE_RUNTIME_WRITE_PARAMS.length).toBe(2);
	});

	test("Adorable Kitten links the die roll to the life gain", () => {
		// SVar:TrigRoll:DB$ RollDice | ResultSVar$ Result | SubAbility$ DBLife
		// SVar:DBLife:DB$ GainLife | LifeAmount$ Result
		// `Result` has no SVar: line; it exists only while the ability resolves.
		const result = parseForgeCardScript(card("adorable_kitten"));
		const g = result.card.graph;

		const runtime = g.nodes.find((n) => n.kind === "runtime-value");
		expect(runtime?.name).toBe("Result");
		expect(result.card.faces[0]?.svars.some((v) => v.name === "Result")).toBe(
			false,
		);

		const write = g.edges.find((e) => e.provenance === "runtime-write");
		expect(write?.role).toBe("writes");
		expect(write?.to).toBe(runtime?.id);

		const read = g.edges.find((e) => e.provenance === "amount");
		expect(read?.rawReference).toBe("Result");
		expect(read?.to).toBe(runtime?.id);
		// The writer and the reader are different records, joined by the value.
		expect(write?.from).not.toBe(read?.from);
		expect(result.diagnostics).toEqual([]);
	});

	test("a declared SVar is written in place, not shadowed", () => {
		// Many cards declare a placeholder and overwrite it at runtime. That is one
		// variable, so no synthetic node and no false ambiguity.
		const result = parseForgeCardScript(
			[
				"Name:Placeholder",
				"A:SP$ RollDice | ResultSVar$ X | SubAbility$ DBDamage",
				"SVar:X:0",
				"SVar:DBDamage:DB$ DealDamage | NumDmg$ X | ValidTgts$ Any",
			].join("\n"),
		);
		expect(
			result.card.graph.nodes.filter((n) => n.kind === "runtime-value"),
		).toEqual([]);
		const write = result.card.graph.edges.find((e) => e.role === "writes");
		expect(write?.to).toBe("line:3");
		const read = result.card.graph.edges.find((e) => e.provenance === "amount");
		expect(read?.status).toBe("resolved");
		expect(codes(result.diagnostics)).not.toContain("AMBIGUOUS_SVAR_REFERENCE");
	});
});

describe("expression operands", () => {
	test("parses the narrow scalar SVar$ form", () => {
		expect(parseForgeScalarSVarExpression("SVar$X/Plus.1")).toEqual([
			{ name: "X", position: "base" },
		]);
		// doXMath integer-parses the operand and falls back to calculateAmount.
		expect(parseForgeScalarSVarExpression("SVar$Z1/Plus.Z2")).toEqual([
			{ name: "Z1", position: "base" },
			{ name: "Z2", position: "operand" },
		]);
		expect(
			parseForgeScalarSVarExpression("Count$ValidGraveyard Card$CardTypes"),
		).toEqual([]);
	});

	test("parses Count$Compare and Count$IsPrime operands", () => {
		// Count$Compare <lhs> <OP><rhs>.<ifTrue>.<ifFalse>
		expect(parseForgeCountExpression("Count$Compare Y GE1.2.1")).toEqual([
			{ name: "Y", position: "lhs" },
		]);
		expect(parseForgeCountExpression("Count$Compare A GEB.C.D")).toEqual([
			{ name: "A", position: "lhs" },
			{ name: "B", position: "rhs" },
			{ name: "C", position: "if-true" },
			{ name: "D", position: "if-false" },
		]);
		expect(parseForgeCountExpression("Count$IsPrime X.A.B")).toEqual([
			{ name: "X", position: "lhs" },
			{ name: "A", position: "if-true" },
			{ name: "B", position: "if-false" },
		]);
		// Ordinary Count verbs take selectors, not SVar names.
		expect(parseForgeCountExpression("Count$Valid Creature.YouCtrl")).toEqual(
			[],
		);
		expect(parseForgeCountExpression("Count$xPaid")).toEqual([]);
		// A bare SVar$ value is the scalar form, not a Count expression.
		expect(parseForgeCountExpression("SVar$X/Plus.1")).toEqual([]);
		expect(parseForgeCountExpression("Count$SVar$X")).toEqual([
			{ name: "X", position: "svar" },
		]);
	});

	test("Tarmogoyf links its static ability and its scalar arithmetic", () => {
		// S:Mode$ Continuous | SetPower$ X | SetToughness$ Y
		// SVar:X:Count$ValidGraveyard Card$CardTypes
		// SVar:Y:SVar$X/Plus.1
		const result = parseForgeCardScript(card("tarmogoyf"));
		expect(
			result.card.graph.edges.map((e) => [
				e.provenance,
				e.role,
				e.rawReference,
				e.status,
			]),
		).toEqual([
			["amount", "amount", "X", "resolved"],
			["amount", "amount", "Y", "resolved"],
			["scalar-expression", "scalar-base", "X", "resolved"],
		]);
		expect(result.diagnostics).toEqual([]);
	});

	test("Raucous Audience links the mana amount through a Count comparison", () => {
		// A:AB$ Mana | Amount$ X   ->   SVar:X:Count$Compare Y GE1.2.1   ->   SVar:Y
		const result = parseForgeCardScript(card("raucous_audience"));
		expect(
			result.card.graph.edges.map((e) => [
				e.provenance,
				e.rawReference,
				e.status,
			]),
		).toEqual([
			["amount", "X", "resolved"],
			["count-expression", "Y", "resolved"],
		]);
		expect(result.diagnostics).toEqual([]);
	});
});

describe("edge provenance", () => {
	test("every edge records which Forge mechanism produced it", () => {
		const result = parseForgeCardScript(
			[
				"Name:Mixed",
				"K:ETBReplacement:Other:DBPrepare",
				"A:SP$ DealDamage | NumDmg$ X | SubAbility$ DBNext | ValidTgts$ Any",
				"S:Mode$ Continuous | AddAbility$ ABGrant",
				"SVar:DBPrepare:DB$ Draw",
				"SVar:DBNext:DB$ Draw",
				"SVar:ABGrant:AB$ Draw | Cost$ T",
				"SVar:X:Count$YourLifeTotal",
			].join("\n"),
		);
		const seen = new Set(result.card.graph.edges.map((e) => e.provenance));
		expect(seen).toContain("keyword");
		expect(seen).toContain("amount");
		expect(seen).toContain("ability-factory");
		expect(seen).toContain("continuous-effect");
		for (const e of result.card.graph.edges) expect(e.provenance).toBeTruthy();
	});
});

/* ------------------------------------------------------------------------- */
/* Known limits of the reference graph                                        */
/* ------------------------------------------------------------------------- */

describe("unmodeled reference detection", () => {
	test("reports a parameter no registry covers", () => {
		// Ahn-Crop Champion: `Trigger$ TrigUntapAll` on an OptionalAttackCost
		// static. No verified calculateAmount or wiring call site covers it, so it
		// is detected and reported rather than guessed into an edge.
		const result = parseForgeCardScript(card("ahn_crop_champion"));
		const found = findUnmodeledReferenceCandidates(result.card);
		expect(found.map((u) => [u.kind, u.key, u.name])).toEqual([
			["parameter", "Trigger", "TrigUntapAll"],
		]);
		expect(found[0]?.candidates).toHaveLength(1);
	});

	test("reports nothing for cards whose references are all modelled", () => {
		// Tarmogoyf and Raucous Audience were the motivating examples for the
		// amount, scalar and Count work; both are now fully linked.
		for (const name of ["tarmogoyf", "raucous_audience", "adorable_kitten"]) {
			const result = parseForgeCardScript(card(name));
			expect(findUnmodeledReferenceCandidates(result.card)).toEqual([]);
			expect(result.card.graph.edges.length).toBeGreaterThan(0);
		}
	});

	test("does not report references the graph already models", () => {
		const result = parseForgeCardScript(card("into_the_maw_of_hell"));
		expect(result.card.graph.edges).toHaveLength(1);
		expect(findUnmodeledReferenceCandidates(result.card)).toEqual([]);
	});

	test("detection is a name match, so it can still false-positive", () => {
		// An uncovered parameter whose literal value collides with an SVar name is
		// reported. That is exactly why detections are never auto-promoted into
		// edges: only registry rows with a Java call site become links.
		const result = parseForgeCardScript(
			[
				"Name:Collide",
				"A:SP$ Draw | SomeFutureParam$ Foo",
				"SVar:Foo:Count$YourLifeTotal",
			].join("\n"),
		);
		const found = findUnmodeledReferenceCandidates(result.card);
		expect(found.map((u) => u.key)).toEqual(["SomeFutureParam"]);
		expect(result.card.graph.edges).toEqual([]);
	});

	test("verified non-reference keys are excluded, not counted as gaps", () => {
		// `Destination$` is a ZoneType and `SpellDescription$` is display text;
		// a value colliding with an SVar name there is not a missing edge.
		const result = parseForgeCardScript(
			[
				"Name:Excluded",
				"A:SP$ ChangeZone | Origin$ Battlefield | Destination$ Exile | SpellDescription$ Food",
				"SVar:Exile:DB$ ChangeZone",
				"SVar:Food:DB$ Token",
			].join("\n"),
		);
		expect(findUnmodeledReferenceCandidates(result.card)).toEqual([]);
	});

	test("cannot see Count$ expressions or runtime write destinations", () => {
		// Count$Compare embeds an SVar name inside a mini-expression grammar, and
		// ResultSVar$ names an SVar that has no definition line at all. Neither is
		// detectable by name matching, so neither is counted.
		const counting = parseForgeCardScript(
			[
				"Name:Counter",
				"SVar:X:Count$Compare Y GE1.2.1",
				"SVar:Y:Count$Valid Creature",
			].join("\n"),
		);
		expect(findUnmodeledReferenceCandidates(counting.card)).toEqual([]);

		const writing = parseForgeCardScript(card("adorable_kitten"));
		// `ResultSVar$ Result` writes an SVar; `LifeAmount$ Result` reads it back.
		// Neither shows up, because no `SVar:Result:` definition exists to match.
		expect(findUnmodeledReferenceCandidates(writing.card)).toEqual([]);
		expect(writing.card.faces[0]?.svars.some((v) => v.name === "Result")).toBe(
			false,
		);
	});
});

/* ------------------------------------------------------------------------- */
/* Corpus conformance                                                         */
/* ------------------------------------------------------------------------- */

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

describe("corpus conformance", () => {
	/**
	 * What this test asserts is preservation, not interpretation: that no card
	 * throws, that no meaningful line is dropped, that print/reparse is stable,
	 * and that the diagnostics we do emit stay at their known counts.
	 *
	 * It deliberately does NOT assert that the reference graph is complete. A
	 * card whose only SVar links run through unmodelled amount parameters passes
	 * every check here and still emits zero diagnostics. "Zero diagnostics" means
	 * nothing this module knows how to doubt fired - it is not a statement that
	 * the card was fully understood. The coverage test below pins that gap.
	 */
	test("every card parses, keeps every meaningful line, and round-trips", () => {
		const files = corpusFiles();
		expect(files.length).toBeGreaterThan(1000);

		const aggregate: ForgeDiagnostic[] = [];
		const lineLoss: string[] = [];
		const roundTripFailures: string[] = [];

		for (const path of files) {
			const source = readFileSync(path, "utf8");

			// 1. Parsing must never throw, whatever the card contains.
			const first = parseForgeCardScript(source);
			aggregate.push(...first.diagnostics);

			// 2. Every meaningful non-comment line must survive as one node.
			//    Face markers are structural but are still their own nodes.
			const meaningful = source
				.split(/\r\n|\n|\r/)
				.map((line) => line.trim())
				.filter((line) => line !== "" && !line.startsWith("#")).length;
			if (first.document.nodes.length !== meaningful) lineLoss.push(path);

			// 3. Printing and reparsing must preserve meaningful structure.
			const second = parseForgeCardScript(printForgeCardScript(first.document));
			const before = JSON.stringify(projectForgeDocument(first.document));
			const after = JSON.stringify(projectForgeDocument(second.document));
			if (before !== after) roundTripFailures.push(path);
		}

		expect(lineLoss).toEqual([]);
		expect(roundTripFailures).toEqual([]);

		// Aggregate counts only: no per-card snapshot. 4. Unknown constructs are
		// reported informationally at most and never fail the run.
		const counts = countForgeDiagnostics(aggregate);
		const unknown = [
			"UNKNOWN_EFFECT",
			"UNKNOWN_TRIGGER_MODE",
			"UNKNOWN_REPLACEMENT_EVENT",
			"UNKNOWN_STATIC_MODE",
		];
		for (const code of unknown) {
			for (const diagnostic of aggregate) {
				if (diagnostic.code === code) expect(diagnostic.severity).toBe("info");
			}
		}
		expect(counts.MALFORMED_LINE ?? 0).toBe(0);
		expect(counts.MISSING_DISCRIMINATOR ?? 0).toBe(0);
		expect(counts.CONFLICTING_DISCRIMINATORS ?? 0).toBe(0);
		// Real defects in shipped card scripts, pinned so regressions show up.
		expect(counts.MALFORMED_PARAM ?? 0).toBe(4);
		expect(counts.UNRESOLVED_SVAR_REFERENCE ?? 0).toBe(14);
		expect(counts.CYCLIC_SVAR_REFERENCE ?? 0).toBe(12);
	}, 120_000);

	/**
	 * Pins how much of the corpus's reference structure the graph models and how
	 * much it knowingly does not, so the gap cannot drift unnoticed. Adding a
	 * registry entry should move numbers between these two buckets, and this test
	 * is what forces that to be a deliberate, reviewed change.
	 */
	test("reference-graph coverage stays at its known level", () => {
		let modeled = 0;
		let unmodeledParameter = 0;
		let unmodeledScalar = 0;
		const affected = new Set<string>();

		for (const path of corpusFiles()) {
			const { card: parsed } = parseForgeCardScript(readFileSync(path, "utf8"));
			modeled += parsed.graph.edges.length;
			const gaps = findUnmodeledReferenceCandidates(parsed);
			if (gaps.length > 0) affected.add(path);
			for (const gap of gaps) {
				if (gap.kind === "parameter") unmodeledParameter += 1;
				else unmodeledScalar += 1;
			}
		}

		expect(modeled).toBe(53_366);
		// Whatever no verified Java call site covers. Was 7,047 before the
		// calculateAmount / runtime-write / expression work landed.
		expect(unmodeledParameter).toBe(123);
		// Scalar `SVar$Name` operands are now modelled outright.
		expect(unmodeledScalar).toBe(0);
		expect(affected.size).toBe(108);
	}, 120_000);
});
