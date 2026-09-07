/**
 * forge-ast.ts — a standalone AST for Forge card scripts.
 *
 * This module is a Forge-to-TypeScript *interface*. It describes and classifies
 * card scripts; it does not execute them, does not evaluate Forge selectors,
 * amount expressions or costs, and does not depend on the tinymtg engine.
 *
 * It deliberately contains ZERO imports (including type-only imports) so that it
 * can be lifted out of this repository as-is.
 *
 * Two layers are exposed:
 *
 *     Forge text
 *         |
 *         v
 *     ForgeScriptDocument   open, source-oriented records (layer 1)
 *         |
 *         v
 *     ForgeCardAst          faces, records, SVars, classifications, graph (layer 2)
 *
 * Open vocabulary is mandatory: unknown directives, operations, parameters,
 * keywords, costs, selectors, mana symbols and card types are *data*, never
 * errors. The known-name registries below document one Forge revision and exist
 * for editor autocomplete; they are not acceptance gates.
 *
 * What "parses cleanly" does and does not mean. The guarantees here are about
 * PRESERVATION: parsing never throws, every meaningful line becomes exactly one
 * source node, and print/reparse is structurally stable. They are not a claim
 * that a card was fully INTERPRETED. In particular the reference graph is
 * knowingly incomplete - most amount parameters (`NumDmg$ X`) read SVars through
 * `AbilityUtils.calculateAmount` and are not drawn as edges. A card relying only
 * on those still parses, round-trips and emits zero diagnostics. Use
 * {@link findUnmodeledReferenceCandidates} to measure that gap per card rather
 * than inferring completeness from a silent diagnostic list.
 *
 * Java lookup reference (read-only, at authoring time; never required at runtime):
 *   Forge revision 1b900c62af9340f4f73109012083d179f8a48ff6
 *     forge.card.CardRules$Reader          - line/face/directive dispatch
 *     forge.card.CardFace                  - per-face storage, case-insensitive SVars
 *     forge.card.CardSplitType             - AlternateMode vocabulary
 *     forge.card.CardStateName             - face slot naming
 *     forge.util.FileSection#parseToMap    - the "|" / "$" embedded DSL tokenizer
 *     forge.game.ability.AbilityFactory    - AB/SP/ST/DB records, additionalAbilityKeys
 *     forge.game.ability.ApiType           - effect API names
 *     forge.game.trigger.TriggerType       - trigger modes
 *     forge.game.replacement.ReplacementType - replacement events
 *     forge.game.staticability.StaticAbilityMode - static modes
 *
 * Conformance input: the checked-out card corpus under cards/cardsfolder.
 */

/* ------------------------------------------------------------------------- */
/* Known-name registries                                                      */
/*                                                                            */
/* Complete for the reference revision. Unknown names remain legal everywhere. */
/* ------------------------------------------------------------------------- */
/**
 * Effect API names, from `forge.game.ability.ApiType` (201 values).
 * Forge looks these up case-insensitively (`ApiType.smartValueOf`).
 */
export const KNOWN_FORGE_EFFECT_NAMES = [
	"Abandon",
	"ActivateAbility",
	"AddOrRemoveCounter",
	"AddPhase",
	"AddTurn",
	"AdvanceCrank",
	"Airbend",
	"AlterAttribute",
	"Amass",
	"Animate",
	"AnimateAll",
	"Attach",
	"Ascend",
	"AssembleContraption",
	"AssignGroup",
	"Balance",
	"BecomeMonarch",
	"BecomesBlocked",
	"BidLife",
	"Blight",
	"Block",
	"Bond",
	"Branch",
	"Camouflage",
	"ChangeCombatants",
	"ChangeSpeed",
	"ChangeTargets",
	"ChangeText",
	"ChangeX",
	"ChangeZone",
	"ChangeZoneAll",
	"ChaosEnsues",
	"Charm",
	"ChooseCard",
	"ChooseColor",
	"ChooseDirection",
	"ChooseEvenOdd",
	"ChooseNumber",
	"ChoosePlayer",
	"ChooseSector",
	"ChooseSource",
	"ChooseType",
	"ClaimThePrize",
	"Clash",
	"ClassLevelUp",
	"Cleanup",
	"Cloak",
	"Clone",
	"Connive",
	"CopyPermanent",
	"CopySpellAbility",
	"ControlSpell",
	"ControlPlayer",
	"Counter",
	"DamageAll",
	"DealDamage",
	"Detain",
	"DayTime",
	"Debuff",
	"DelayedTrigger",
	"Destroy",
	"DestroyAll",
	"Dig",
	"DigMultiple",
	"DigUntil",
	"Discard",
	"Discover",
	"DrainMana",
	"Draft",
	"Draw",
	"EachDamage",
	"Earthbend",
	"Effect",
	"Encode",
	"EndCombatPhase",
	"EndTurn",
	"Endure",
	"ExchangeLife",
	"ExchangeLifeVariant",
	"ExchangeControl",
	"ExchangeControlVariant",
	"ExchangePower",
	"ExchangeZone",
	"ExchangeTextBox",
	"Explore",
	"Fight",
	"FlipCoin",
	"FlipOntoBattlefield",
	"Fog",
	"GainControl",
	"GainControlVariant",
	"GainLife",
	"GainOwnership",
	"GameDrawn",
	"GenericChoice",
	"Goad",
	"Haunt",
	"HealDamage",
	"Heist",
	"Investigate",
	"Intensify",
	"ImmediateTrigger",
	"Incubate",
	"Learn",
	"LookAt",
	"LoseLife",
	"LosePerpetual",
	"LosesGame",
	"MakeCard",
	"Mana",
	"ManaReflected",
	"Manifest",
	"ManifestDread",
	"Meld",
	"Mill",
	"MoveCounter",
	"MultiplePiles",
	"MultiplyCounter",
	"MustBlock",
	"Mutate",
	"NameCard",
	"OpenAttraction",
	"PeekAndReveal",
	"PermanentCreature",
	"PermanentNoncreature",
	"Phases",
	"Planeswalk",
	"Play",
	"PlayLandVariant",
	"Poison",
	"PreventDamage",
	"Proliferate",
	"Protection",
	"ProtectionAll",
	"Pump",
	"PumpAll",
	"PutCounter",
	"PutCounterAll",
	"Radiation",
	"RearrangeTopOfLibrary",
	"Regenerate",
	"Regeneration",
	"RemoveCounter",
	"RemoveCounterAll",
	"RemoveFromCombat",
	"RemoveFromGame",
	"RemoveFromMatch",
	"ReorderZone",
	"Repeat",
	"RepeatEach",
	"ReplaceCounter",
	"ReplaceEffect",
	"ReplaceMana",
	"ReplaceDamage",
	"ReplaceToken",
	"ReplaceSplitDamage",
	"RestartGame",
	"Reveal",
	"RevealHand",
	"ReverseTurnOrder",
	"RingTemptsYou",
	"RollDice",
	"RollPlanarDice",
	"RunChaos",
	"Sacrifice",
	"SacrificeAll",
	"Scry",
	"Seek",
	"SetInMotion",
	"SetLife",
	"SetState",
	"Shuffle",
	"SkipPhase",
	"SkipTurn",
	"StoreSVar",
	"Subgame",
	"Surveil",
	"SwitchBlock",
	"TakeInitiative",
	"Tap",
	"TapAll",
	"TapOrUntap",
	"TapOrUntapAll",
	"TimeTravel",
	"Token",
	"TwoPiles",
	"Unattach",
	"UnlockDoor",
	"Untap",
	"UntapAll",
	"Venture",
	"VillainousChoice",
	"Vote",
	"WinsGame",
	"BlankLine",
	"DamageResolve",
	"ChangeZoneResolve",
	"CompanionChoose",
	"InternalLegendaryRule",
	"InternalIgnoreEffect",
	"InternalRadiation",
] as const;

/**
 * Trigger modes, from `forge.game.trigger.TriggerType` (146 values).
 * Forge looks these up case-insensitively (`TriggerType.smartValueOf`).
 */
export const KNOWN_FORGE_TRIGGER_MODES = [
	"Abandoned",
	"AbilityCast",
	"AbilityResolves",
	"AbilityTriggered",
	"Adapt",
	"Airbend",
	"Always",
	"Attached",
	"AttackerBlocked",
	"AttackerBlockedOnce",
	"AttackerBlockedByCreature",
	"AttackersDeclared",
	"AttackersDeclaredOneTarget",
	"AttackerUnblocked",
	"AttackerUnblockedOnce",
	"Attacks",
	"BecomeMonarch",
	"BecomeMonstrous",
	"BecomeRenowned",
	"BecomesCrewed",
	"BecomesPlotted",
	"BecomesSaddled",
	"BecomesTarget",
	"BecomesTargetOnce",
	"BlockersDeclared",
	"Blocks",
	"CaseSolved",
	"Championed",
	"ChangesController",
	"ChangesZone",
	"ChangesZoneAll",
	"ChaosEnsues",
	"ClaimPrize",
	"Clashed",
	"ClassLevelGained",
	"CommitCrime",
	"Connives",
	"ConjureAll",
	"CollectEvidence",
	"CounterAdded",
	"CounterAddedOnce",
	"CounterPlayerAddedAll",
	"CounterTypeAddedAll",
	"CounterAddedAll",
	"Countered",
	"CounterRemoved",
	"CounterRemovedOnce",
	"CrankContraption",
	"Crewed",
	"Cycled",
	"DamageAll",
	"DamageDealtOnce",
	"DamageDone",
	"DamageDoneOnce",
	"DamageDoneOnceByController",
	"DamagePreventedOnce",
	"DayTimeChanges",
	"Destroyed",
	"Devoured",
	"Discarded",
	"DiscardedAll",
	"Discover",
	"Drawn",
	"DungeonCompleted",
	"Earthbend",
	"Evolved",
	"ExcessDamage",
	"ExcessDamageAll",
	"ElementalBend",
	"Enlisted",
	"Exerted",
	"Exiled",
	"Exploited",
	"Explores",
	"Fight",
	"FightOnce",
	"Firebend",
	"FlippedCoin",
	"Forage",
	"Foretell",
	"FullyUnlock",
	"GiveGift",
	"Immediate",
	"Investigated",
	"LandPlayed",
	"LifeGained",
	"LifeLost",
	"LifeLostAll",
	"LosesGame",
	"ManaAdded",
	"ManaExpend",
	"ManifestDread",
	"Mentored",
	"Milled",
	"MilledOnce",
	"MilledAll",
	"Mutates",
	"NewGame",
	"PayCumulativeUpkeep",
	"PayEcho",
	"PayLife",
	"Phase",
	"PhaseIn",
	"PhaseOut",
	"PhaseOutAll",
	"PlanarDice",
	"PlaneswalkedFrom",
	"PlaneswalkedTo",
	"Proliferate",
	"RingTemptsYou",
	"RolledDie",
	"RolledDieOnce",
	"RoomEntered",
	"Saddled",
	"Sacrificed",
	"SacrificedOnce",
	"Scry",
	"SearchedLibrary",
	"SeekAll",
	"SetInMotion",
	"Shuffled",
	"Specializes",
	"SpellAbilityCast",
	"SpellAbilityCopy",
	"SpellCast",
	"SpellCastOrCopy",
	"SpellCopy",
	"Stationed",
	"Surveil",
	"TakesInitiative",
	"TapAll",
	"Taps",
	"TapsForMana",
	"TokenCreated",
	"TokenCreatedOnce",
	"Trains",
	"Transformed",
	"TurnBegin",
	"TurnFaceUp",
	"Unattached",
	"UnlockDoor",
	"UntapAll",
	"Untaps",
	"VisitAttraction",
	"Vote",
	"Waterbend",
] as const;

/**
 * Replacement events, from `forge.game.replacement.ReplacementType` (40 values).
 * Forge looks these up case-insensitively (`ReplacementType.smartValueOf`).
 */
export const KNOWN_FORGE_REPLACEMENT_EVENTS = [
	"AddCounter",
	"AssembleContraption",
	"AssignDealDamage",
	"Attached",
	"BeginPhase",
	"BeginTurn",
	"Cascade",
	"Connive",
	"Counter",
	"CopySpell",
	"CreateToken",
	"DamageDone",
	"DealtDamage",
	"DeclareBlocker",
	"Destroy",
	"Draw",
	"DrawCards",
	"Explore",
	"GainLife",
	"GameLoss",
	"GameWin",
	"Learn",
	"LifeReduced",
	"LoseMana",
	"Mill",
	"Moved",
	"PayLife",
	"PlanarDiceResult",
	"Planeswalk",
	"ProduceMana",
	"Proliferate",
	"RemoveCounter",
	"RollDice",
	"RollPlanarDice",
	"Scry",
	"SetInMotion",
	"Tap",
	"Transform",
	"TurnFaceUp",
	"Untap",
] as const;

/**
 * Static ability modes, from `forge.game.staticability.StaticAbilityMode` (83
 * values). A single `Mode$` value may name several of these separated by commas
 * and/or spaces (`StaticAbilityMode.setValueOf` splits on `[, ]+`), and lookup is
 * case-insensitive (`StaticAbilityMode.smartValueOf`).
 */
export const KNOWN_FORGE_STATIC_MODES = [
	"Continuous",
	"CantAttackUnless",
	"CantBlockUnless",
	"OptionalAttackCost",
	"OptionalCost",
	"AlternativeCost",
	"CantBeCast",
	"CantBeActivated",
	"CantPlayLand",
	"DisableTriggers",
	"Panharmonicon",
	"MustTarget",
	"CantAttack",
	"CanAttackDefender",
	"CantBlock",
	"CantBlockBy",
	"CanAttackIfHaste",
	"CanBlockIfReach",
	"MinMaxBlocker",
	"BlockTapped",
	"AttackVigilance",
	"MustAttack",
	"PlayerMustAttack",
	"MustBlock",
	"AssignCombatDamageAsUnblocked",
	"CombatDamageToughness",
	"ColorlessDamageSource",
	"NoCleanupDamage",
	"BlockRestrict",
	"CantGainLife",
	"CantLoseLife",
	"CantChangeLife",
	"CantPayLife",
	"RaiseCost",
	"ReduceCost",
	"SetCost",
	"IgnoreHexproof",
	"IgnoreShroud",
	"AttackRestrict",
	"AssignNoCombatDamage",
	"CanAdapt",
	"CantBeCopied",
	"CantBeSuspected",
	"CantBecomeMonarch",
	"CantAttach",
	"CantCrew",
	"CantDraw",
	"CantDiscard",
	"CantExile",
	"CantPhaseIn",
	"CantPhaseOut",
	"CantPreventDamage",
	"CantPutCounter",
	"CantRegenerate",
	"CantSacrifice",
	"CantTarget",
	"CantTransform",
	"CantVenture",
	"CantChangeDayTime",
	"ActivateAbilityAsIfHaste",
	"CastWithFlash",
	"IgnoreLandwalk",
	"IgnoreLegendRule",
	"MaxCounter",
	"InfectDamage",
	"WitherDamage",
	"FlipCoinMod",
	"FlipCoinDoubler",
	"PlotZone",
	"NumLoyaltyAct",
	"Activations",
	"Devotion",
	"GainLifeRadiation",
	"SurveilNum",
	"TapPowerValue",
	"UnspentMana",
	"ManaBurn",
	"ManaConvert",
	"UntapOtherPlayer",
	"TurnReversed",
	"PhaseReversed",
	"AttackRequirement",
	"CountersRemain",
] as const;

export type KnownForgeEffectName = (typeof KNOWN_FORGE_EFFECT_NAMES)[number];
export type KnownForgeTriggerMode = (typeof KNOWN_FORGE_TRIGGER_MODES)[number];
export type KnownForgeReplacementEvent =
	(typeof KNOWN_FORGE_REPLACEMENT_EVENTS)[number];
export type KnownForgeStaticMode = (typeof KNOWN_FORGE_STATIC_MODES)[number];

/**
 * Open vocabularies. `(string & {})` keeps autocomplete for the known values
 * while still accepting any future Forge name.
 */
export type ForgeEffectName = KnownForgeEffectName | (string & {});
export type ForgeTriggerMode = KnownForgeTriggerMode | (string & {});
export type ForgeReplacementEvent = KnownForgeReplacementEvent | (string & {});
export type ForgeStaticMode = KnownForgeStaticMode | (string & {});

function lowerSet(values: readonly string[]): ReadonlySet<string> {
	return new Set(values.map((value) => value.toLowerCase()));
}

const EFFECT_NAME_LOOKUP = lowerSet(KNOWN_FORGE_EFFECT_NAMES);
const TRIGGER_MODE_LOOKUP = lowerSet(KNOWN_FORGE_TRIGGER_MODES);
const REPLACEMENT_EVENT_LOOKUP = lowerSet(KNOWN_FORGE_REPLACEMENT_EVENTS);
const STATIC_MODE_LOOKUP = lowerSet(KNOWN_FORGE_STATIC_MODES);

export function isKnownForgeEffectName(
	value: string,
): value is KnownForgeEffectName {
	return EFFECT_NAME_LOOKUP.has(value.trim().toLowerCase());
}

export function isKnownForgeTriggerMode(
	value: string,
): value is KnownForgeTriggerMode {
	return TRIGGER_MODE_LOOKUP.has(value.trim().toLowerCase());
}

export function isKnownForgeReplacementEvent(
	value: string,
): value is KnownForgeReplacementEvent {
	return REPLACEMENT_EVENT_LOOKUP.has(value.trim().toLowerCase());
}

export function isKnownForgeStaticMode(
	value: string,
): value is KnownForgeStaticMode {
	return STATIC_MODE_LOOKUP.has(value.trim().toLowerCase());
}

/**
 * `AlternateMode:` vocabulary, from `forge.card.CardSplitType`. `DoubleFaced` is
 * an extra alias accepted by `CardSplitType.smartValueOf` and is by far the most
 * common spelling in the corpus. Unknown modes stay representable.
 */
export const KNOWN_FORGE_ALTERNATE_MODES = [
	"None",
	"Transform",
	"Meld",
	"Split",
	"Flip",
	"Adventure",
	"Omen",
	"Modal",
	"Prepare",
	"Specialize",
	"DoubleFaced",
] as const;

export type KnownForgeAlternateMode =
	(typeof KNOWN_FORGE_ALTERNATE_MODES)[number];
export type ForgeAlternateMode = KnownForgeAlternateMode | (string & {});

const ALTERNATE_MODE_LOOKUP = lowerSet(KNOWN_FORGE_ALTERNATE_MODES);

export function isKnownForgeAlternateMode(
	value: string,
): value is KnownForgeAlternateMode {
	return ALTERNATE_MODE_LOOKUP.has(value.trim().toLowerCase());
}

/* ------------------------------------------------------------------------- */
/* Diagnostics                                                                */
/* ------------------------------------------------------------------------- */

export type ForgeDiagnosticSeverity = "error" | "warning" | "info";

export type ForgeDiagnosticStage =
	| "source"
	| "index"
	| "classify"
	| "reference"
	| "print";

export const FORGE_DIAGNOSTIC_CODES = [
	"MALFORMED_LINE",
	"MALFORMED_PARAM",
	"MALFORMED_SVAR",
	"MALFORMED_VARIANT",
	"MISSING_DISCRIMINATOR",
	"CONFLICTING_DISCRIMINATORS",
	"UNKNOWN_EFFECT",
	"UNKNOWN_TRIGGER_MODE",
	"UNKNOWN_REPLACEMENT_EVENT",
	"UNKNOWN_STATIC_MODE",
	"UNKNOWN_FACE_MARKER",
	"DUPLICATE_SVAR",
	"UNRESOLVED_SVAR_REFERENCE",
	"AMBIGUOUS_SVAR_REFERENCE",
	"CYCLIC_SVAR_REFERENCE",
	"EXTERNAL_FACE_REFERENCE",
] as const;

export type KnownForgeDiagnosticCode = (typeof FORGE_DIAGNOSTIC_CODES)[number];
export type ForgeDiagnosticCode = KnownForgeDiagnosticCode | (string & {});

export interface ForgeDiagnostic {
	severity: ForgeDiagnosticSeverity;
	stage: ForgeDiagnosticStage;
	code: ForgeDiagnosticCode;
	message: string;
	line?: number;
	nodeId?: string;
	paramId?: string;
}

/* ------------------------------------------------------------------------- */
/* Layer 1: source / script AST                                               */
/* ------------------------------------------------------------------------- */

export interface ForgeDirectiveNode {
	kind: "directive";
	id: string;
	line: number;
	/** Verbatim text before the first `:` (the line is whitespace-trimmed first). */
	key: string;
	/** Verbatim text after the first `:`, trimmed, exactly as Forge does. */
	value: string;
}

export interface ForgeFaceMarkerNode {
	kind: "face-marker";
	id: string;
	line: number;
	marker: "ALTERNATE" | "SPECIALIZE" | (string & {});
	argument?: string;
	raw: string;
}

export interface ForgeMalformedNode {
	kind: "malformed";
	id: string;
	line: number;
	raw: string;
	reason: string;
}

export type ForgeSourceNode =
	| ForgeDirectiveNode
	| ForgeFaceMarkerNode
	| ForgeMalformedNode;

export interface ForgeScriptDocument {
	schema: "forge-card-script";
	schemaVersion: 1;
	nodes: ForgeSourceNode[];
}

/* ------------------------------------------------------------------------- */
/* Embedded DSL parameters                                                    */
/* ------------------------------------------------------------------------- */

export interface ForgeParamEntry {
	id: string;
	index: number;
	/** The `|`-delimited fragment, verbatim. */
	raw: string;
	keyRaw: string;
	valueRaw: string;
	key: string;
	value: string;
	/** True when the fragment had no `$` separator at all. */
	malformed: boolean;
}

export interface ForgeParamList {
	raw: string;
	entries: ForgeParamEntry[];
	/**
	 * Last-write-wins projection. Keys keep the casing of their *first*
	 * occurrence, matching Forge's `TreeMap(String.CASE_INSENSITIVE_ORDER)`.
	 * Prefer {@link getForgeParam} or {@link ForgeParamList.effectiveLower} for
	 * case-insensitive reads; `entries` remains authoritative.
	 */
	effective: Record<string, string>;
	/** The same last-write-wins projection, keyed by lowercased parameter name. */
	effectiveLower: Record<string, string>;
}

/* ------------------------------------------------------------------------- */
/* Classified records                                                         */
/* ------------------------------------------------------------------------- */

export interface ForgeDirectiveRef {
	nodeId: string;
	line: number;
	key: string;
	value: string;
}

/** Where a classified record was found. */
export type ForgeRecordOrigin = "directive" | "svar" | "variant";

export type ForgeAbilityKind =
	| "activated"
	| "spell"
	| "static"
	| "sub-ability"
	| "unknown";

export interface ForgeAbilityRecord {
	kind: "ability";
	id: string;
	origin: ForgeRecordOrigin;
	source: ForgeDirectiveRef;
	params: ForgeParamList;
	abilityKind: ForgeAbilityKind;
	/** The `AB`/`SP`/`ST`/`DB` parameter key that decided `abilityKind`. */
	discriminator?: string;
	effectName?: ForgeEffectName;
	effectKnown: boolean;
}

export interface ForgeTriggerRecord {
	kind: "trigger";
	id: string;
	origin: ForgeRecordOrigin;
	source: ForgeDirectiveRef;
	params: ForgeParamList;
	mode?: ForgeTriggerMode;
	modeKnown: boolean;
}

export interface ForgeReplacementRecord {
	kind: "replacement";
	id: string;
	origin: ForgeRecordOrigin;
	source: ForgeDirectiveRef;
	params: ForgeParamList;
	event?: ForgeReplacementEvent;
	eventKnown: boolean;
}

export interface ForgeStaticRecord {
	kind: "static";
	id: string;
	origin: ForgeRecordOrigin;
	source: ForgeDirectiveRef;
	params: ForgeParamList;
	/** The raw `Mode$` value, which may name several modes. */
	mode?: ForgeStaticMode;
	/** `mode` split on `[, ]+`, per `StaticAbilityMode.setValueOf`. */
	modes: ForgeStaticMode[];
	modeKnown: boolean;
}

export type ForgeClassifiedRecord =
	| ForgeAbilityRecord
	| ForgeTriggerRecord
	| ForgeReplacementRecord
	| ForgeStaticRecord;

/**
 * A `K:` line, split on `:` into ordered segments. Every keyword keeps its
 * verbatim segments; only the ones in {@link FORGE_KEYWORD_SPECS} additionally
 * expose an interpreted parameter tail. Unknown keywords are ordinary data.
 */
export interface ForgeKeywordRecord {
	id: string;
	source: ForgeDirectiveRef;
	/** The whole `K:` value, verbatim. */
	raw: string;
	/** Segment 0, the keyword name. */
	keyword: string;
	/** All `:`-delimited segments, verbatim. */
	segments: string[];
	/** True when the keyword has a structural spec in this module. */
	known: boolean;
	/** Present when the keyword form carries an embedded `|`/`$` parameter list. */
	params?: ForgeParamList;
}

export interface ForgeSVarRecord {
	id: string;
	name: string;
	nameRaw: string;
	value: string;
	source: ForgeDirectiveRef;
	parsed:
		| { kind: "params"; params: ForgeParamList }
		| { kind: "scalar"; value: string };
	/**
	 * Present only when `parsed.kind === "params"`. Scalar, expression, AI-hint
	 * and flag SVars are intentionally left uninterpreted.
	 */
	classified?: ForgeClassifiedRecord;
}

/* ------------------------------------------------------------------------- */
/* Faces                                                                      */
/* ------------------------------------------------------------------------- */

/**
 * Script-level face slots, mirroring the seven `CardFace` slots that
 * `CardRules.Reader` fills (index 0 original, 1 alternate, 2..6 specialize).
 * The runtime `CardStateName` a slot maps to depends on `AlternateMode` and is
 * deliberately not materialized here.
 */
export type ForgeFaceState =
	| "original"
	| "alternate"
	| "specialize-white"
	| "specialize-blue"
	| "specialize-black"
	| "specialize-red"
	| "specialize-green";

export const FORGE_FACE_STATES = [
	"original",
	"alternate",
	"specialize-white",
	"specialize-blue",
	"specialize-black",
	"specialize-red",
	"specialize-green",
] as const;

export interface ForgeCharacteristics {
	name?: ForgeDirectiveRef;
	manaCost?: ForgeDirectiveRef;
	types?: ForgeDirectiveRef;
	colors?: ForgeDirectiveRef;
	pt?: ForgeDirectiveRef;
	loyalty?: ForgeDirectiveRef;
	defense?: ForgeDirectiveRef;
	/** `Lights:` in the corpus; `CardFace.setAttractionLights` in Java. */
	attractionLights?: ForgeDirectiveRef;
	oracle?: ForgeDirectiveRef;
	text?: ForgeDirectiveRef;
	flavorName?: ForgeDirectiveRef;
	/** An unresolved reference to another card's face. Never inlined here. */
	copyFaceFrom?: ForgeDirectiveRef;
	/** Every characteristic directive in source order, duplicates included. */
	all: ForgeDirectiveRef[];
}

/**
 * A `Variant:<name>:<directive>` patch. The nested directive is kept as its own
 * record and is *not* merged into the face's own lists.
 */
export interface ForgeVariantPatch {
	id: string;
	name: string;
	nameRaw: string;
	source: ForgeDirectiveRef;
	/** The nested directive, e.g. `FlavorName:Zora, Spider Fancier`. */
	patch: ForgeDirectiveRef;
	/** Present when the nested directive is an `A:`/`T:`/`R:`/`S:` record. */
	classified?: ForgeClassifiedRecord;
	/** Present when the nested directive is `SVar:<name>:<value>`. */
	svar?: ForgeSVarRecord;
}

export interface ForgeFaceAst {
	id: string;
	state: ForgeFaceState;
	/** Slot index in `CardRules.Reader`'s seven-element face array. */
	slot: number;
	sourceNodeIds: string[];

	characteristics: ForgeCharacteristics;
	keywords: ForgeDirectiveRef[];
	/** The same `K:` lines, split into segments and selectively interpreted. */
	keywordRecords: ForgeKeywordRecord[];
	abilities: ForgeAbilityRecord[];
	triggers: ForgeTriggerRecord[];
	replacements: ForgeReplacementRecord[];
	statics: ForgeStaticRecord[];
	svars: ForgeSVarRecord[];
	draftActions: ForgeDirectiveRef[];
	variants: ForgeVariantPatch[];
	otherDirectives: ForgeDirectiveRef[];
	/**
	 * Case-insensitive SVar lookup. Values are *all* definitions in source order,
	 * so duplicates and case variants survive; Forge itself keeps only the last.
	 */
	svarIndex: Record<string, ForgeSVarRecord[]>;
}

/* ------------------------------------------------------------------------- */
/* Reference graph                                                            */
/* ------------------------------------------------------------------------- */

export type ForgeReferenceNodeKind =
	| "face"
	| "ability"
	| "trigger"
	| "replacement"
	| "static"
	| "svar"
	| "keyword"
	/** A synthetic node for an SVar that only exists while an ability resolves. */
	| "runtime-value";

export interface ForgeReferenceNode {
	id: string;
	kind: ForgeReferenceNodeKind;
	faceId: string;
	/** SVar name for `svar` nodes; face state for `face` nodes. */
	name?: string;
	/** Variant name when the node came from a `Variant:` patch. */
	variant?: string;
	sourceNodeId: string;
}

/**
 * Why an edge exists - which Forge mechanism the reference was read out of.
 * Lets a consumer tell a verified sub-ability link from an amount-parameter
 * link without re-deriving it from the role.
 */
export type ForgeReferenceProvenance =
	/** AbilityFactory sub-ability / additional-ability wiring. */
	| "ability-factory"
	/** The continuous-effect `" & "` family. */
	| "continuous-effect"
	/** A condition check resolved via AbilityUtils.calculateAmount. */
	| "condition"
	/** An amount parameter resolved via AbilityUtils.calculateAmount. */
	| "amount"
	/** A structured `K:` keyword segment. */
	| "keyword"
	/** `SVar$Name/Op.Operand` inside a scalar SVar value. */
	| "scalar-expression"
	/** An operand of a `Count$` mini-expression. */
	| "count-expression"
	/** A parameter that CREATES an SVar at runtime. */
	| "runtime-write"
	/** `CopyFaceFrom`, which names another card. */
	| "face";

export type ForgeReferenceStatus =
	| "resolved"
	| "unresolved"
	| "ambiguous"
	| "external";

export interface ForgeReferenceEdge {
	from: string;
	paramId: string;
	role: string;
	rawReference: string;
	to?: string;
	status: ForgeReferenceStatus;
	provenance: ForgeReferenceProvenance;
	/** All candidate targets; length > 1 means `status === "ambiguous"`. */
	candidates: string[];
	/** Extra label for `ResultSubAbilities` entries such as `1:DBFoo`. */
	label?: string;
}

export interface ForgeReferenceGraph {
	nodes: ForgeReferenceNode[];
	edges: ForgeReferenceEdge[];
	/** One entry per distinct reference cycle, each a list of node ids. */
	cycles: string[][];
}

/* ------------------------------------------------------------------------- */
/* Card AST                                                                   */
/* ------------------------------------------------------------------------- */

export interface ForgeCardAst {
	schema: "forge-card-ast";
	schemaVersion: 1;
	document: ForgeScriptDocument;
	/** Directives Forge stores on the card rather than a face. */
	cardDirectives: ForgeDirectiveRef[];
	faces: ForgeFaceAst[];
	graph: ForgeReferenceGraph;
	diagnostics: ForgeDiagnostic[];
}

export interface ForgeParseResult {
	document: ForgeScriptDocument;
	card: ForgeCardAst;
	diagnostics: ForgeDiagnostic[];
}

/* ------------------------------------------------------------------------- */
/* Directive-key registry                                                     */
/*                                                                            */
/* Derived from the `switch (key.charAt(0))` dispatch in CardRules.Reader.     */
/* Unknown keys are NOT listed here and are NOT errors: they fall through to   */
/* the current face's `otherDirectives`.                                       */
/* ------------------------------------------------------------------------- */

export type ForgeDirectiveCategory =
	| "characteristic"
	| "keyword"
	| "ability"
	| "trigger"
	| "replacement"
	| "static"
	| "svar"
	| "draft"
	| "variant"
	| "card"
	| "other";

interface ForgeDirectiveSpec {
	category: ForgeDirectiveCategory;
	/** Which `ForgeCharacteristics` slot the directive fills, when applicable. */
	characteristic?: keyof Omit<ForgeCharacteristics, "all">;
}

/**
 * Keys are compared case-sensitively, exactly as `CardRules.Reader` does.
 */
const FORGE_DIRECTIVE_SPECS: Readonly<Record<string, ForgeDirectiveSpec>> = {
	Name: { category: "characteristic", characteristic: "name" },
	ManaCost: { category: "characteristic", characteristic: "manaCost" },
	Types: { category: "characteristic", characteristic: "types" },
	Colors: { category: "characteristic", characteristic: "colors" },
	PT: { category: "characteristic", characteristic: "pt" },
	Loyalty: { category: "characteristic", characteristic: "loyalty" },
	Defense: { category: "characteristic", characteristic: "defense" },
	Lights: { category: "characteristic", characteristic: "attractionLights" },
	Oracle: { category: "characteristic", characteristic: "oracle" },
	Text: { category: "characteristic", characteristic: "text" },
	FlavorName: { category: "characteristic", characteristic: "flavorName" },
	CopyFaceFrom: { category: "characteristic", characteristic: "copyFaceFrom" },
	K: { category: "keyword" },
	A: { category: "ability" },
	T: { category: "trigger" },
	R: { category: "replacement" },
	S: { category: "static" },
	SVar: { category: "svar" },
	Draft: { category: "draft" },
	Variant: { category: "variant" },
	// Reader-level (whole-card) state rather than per-face state.
	AlternateMode: { category: "card" },
	MeldPair: { category: "card" },
	SETCOLORID: { category: "card" },
	HandLifeModifier: { category: "card" },
	AI: { category: "card" },
	DeckHints: { category: "card" },
	DeckNeeds: { category: "card" },
	DeckHas: { category: "card" },
};

function directiveSpec(key: string): ForgeDirectiveSpec {
	return FORGE_DIRECTIVE_SPECS[key.trim()] ?? { category: "other" };
}

/* ------------------------------------------------------------------------- */
/* Reference-parameter registry                                               */
/* ------------------------------------------------------------------------- */

export type ForgeReferenceForm =
	/** A single SVar name. */
	| "single"
	/** A comma-separated list of SVar names. */
	| "comma-list"
	/** A `" & "`-separated list of SVar names (the continuous-effect family). */
	| "amp-list"
	/** A comma-separated list of `label:svarName` pairs. */
	| "labeled-comma-list";

export interface ForgeReferenceParamSpec {
	/** Canonical spelling; matching is case-insensitive, like Forge's param map. */
	param: string;
	form: ForgeReferenceForm;
	role: string;
	/**
	 * When present, the parameter only names SVars for these effect APIs. Some
	 * parameter names are overloaded: `Choices$` is an ability list for `Charm`
	 * but an ordinary player/card selector for `ChoosePlayer`.
	 */
	apis?: readonly ForgeEffectName[];
	/**
	 * When true the value is only *sometimes* an SVar name. Forge resolves these
	 * through `AbilityUtils.calculateAmount`, which accepts a plain number or an
	 * expression just as happily as an SVar name, so a value matching no SVar is
	 * ordinary data rather than a dangling reference: no edge, no diagnostic.
	 */
	optional?: boolean;
	/** Where this behaviour was read out of the Forge sources. */
	note: string;
}

/**
 * Whether a reference-bearing parameter applies to a record with this effect
 * API. An unknown or absent API keeps ungated parameters and rejects gated ones,
 * because a gated parameter has no reference meaning without its API.
 */
export function forgeReferenceParamApplies(
	spec: ForgeReferenceParamSpec,
	api: string | undefined,
): boolean {
	if (spec.apis === undefined) return true;
	if (api === undefined) return false;
	const wanted = api.trim().toLowerCase();
	return spec.apis.some((name) => name.toLowerCase() === wanted);
}

/**
 * Parameters whose values name SVars. Interpretation is data-driven so that new
 * reference-bearing parameters are a one-line addition.
 *
 * Three families live here:
 *   1. `AbilityFactory` sub-ability wiring - comma lists and single names;
 *   2. the continuous-effect family, which splits on `" & "`, not on commas;
 *   3. condition checks, which are `optional` because Forge resolves them through
 *      `AbilityUtils.calculateAmount`, where a literal number is equally valid.
 *
 * Still *not* modelled, with reasons:
 *   - `ResultSVar` (`RollDiceEffect.setSVar`) and `SVar` (`StoreSVarEffect`)
 *     WRITE an SVar rather than read one. They are definitions, not references,
 *     and this module has no write-edge concept.
 *   - scalar-to-scalar arithmetic such as `SVar:Y:SVar$X/Plus.1`: scalar SVar
 *     values are never tokenized into parameters, so there is nothing to point
 *     at without evaluating amount expressions, which is out of scope.
 */
export const FORGE_REFERENCE_PARAMS: readonly ForgeReferenceParamSpec[] = [
	{
		param: "SubAbility",
		form: "single",
		role: "sub-ability",
		note: "AbilityFactory.getAbility -> setSubAbility",
	},
	{
		param: "PreventionSubAbility",
		form: "single",
		role: "prevention-sub-ability",
		note: "AbilityFactory.getAbility -> setSVar(PreventionSubAbility)",
	},
	{
		param: "ReplaceWith",
		form: "single",
		role: "replace-with",
		note: "ReplacementHandler / R: records",
	},
	{
		param: "Choices",
		form: "comma-list",
		role: "choice",
		apis: ["Charm", "GenericChoice", "AssignGroup", "VillainousChoice", "Vote"],
		note: 'AbilityFactory.getAbility -> setAdditionalAbilityList(Choices), split(","), guarded by those five ApiTypes',
	},
	{
		param: "ResultSubAbilities",
		form: "labeled-comma-list",
		role: "roll-result",
		apis: ["RollDice"],
		note: 'AbilityFactory.getAbility -> RollDice only, split(",") then split(":")',
	},
	{
		param: "Triggers",
		form: "comma-list",
		role: "granted-trigger",
		note: 'EffectEffect / AnimateEffect, split(",")',
	},
	{
		param: "StaticAbilities",
		form: "comma-list",
		role: "granted-static",
		note: 'EffectEffect / AnimateEffect (`staticAbilities`), split(",")',
	},
	{
		param: "ReplacementEffects",
		form: "comma-list",
		role: "granted-replacement",
		note: 'EffectEffect, split(",")',
	},
	{
		param: "Abilities",
		form: "comma-list",
		role: "granted-ability",
		note: 'EffectEffect / AnimateEffect, split(",")',
	},

	// Continuous-effect family. These split on " & ", NOT on commas -- see
	// StaticAbilityContinuous.java:333-367 and CardFactoryUtil.java:3814-3840.
	// Reading them as comma lists would mis-split every multi-valued use.
	{
		param: "AddAbility",
		form: "amp-list",
		role: "granted-ability",
		note: 'StaticAbilityContinuous, split(" & ") then AbilityUtils.getSVar',
	},
	{
		param: "AddTrigger",
		form: "amp-list",
		role: "granted-trigger",
		note: 'StaticAbilityContinuous / CardFactoryUtil, split(" & ")',
	},
	{
		param: "AddStaticAbility",
		form: "amp-list",
		role: "granted-static",
		note: 'StaticAbilityContinuous / CardFactoryUtil, split(" & ")',
	},
	{
		param: "AddReplacementEffect",
		form: "amp-list",
		role: "granted-replacement",
		note: 'StaticAbilityContinuous / CardFactoryUtil, split(" & ")',
	},
	{
		param: "AddSVar",
		form: "amp-list",
		role: "granted-svar",
		note: 'StaticAbilityContinuous, split(" & "); target may be scalar or ability',
	},
	{
		// Forge ships the "Excute" typo in AddPhaseEffect; card scripts spell it
		// that way too, so the registry must match Forge, not English.
		param: "ExtraTurnDelayedTriggerExecute",
		form: "single",
		role: "extra-turn-trigger",
		note: "AddTurnEffect, sa.getSVar(param)",
	},
	{
		param: "ExtraPhaseDelayedTrigger",
		form: "single",
		role: "extra-phase-trigger",
		note: "AddPhaseEffect, sa.getSVar(param)",
	},
	{
		param: "ExtraPhaseDelayedTriggerExcute",
		form: "single",
		role: "extra-phase-trigger",
		note: "AddPhaseEffect, sa.getSVar(param) - Forge's own spelling",
	},
	// Clone / animate variants. CardFactory and AnimateEffect split these on
	// commas, unlike the singular Add* family's " & ".
	{
		param: "AddSVars",
		form: "comma-list",
		role: "granted-svar",
		note: 'CardFactory:622 clone SVars, split(",")',
	},
	{
		param: "AddTriggers",
		form: "comma-list",
		role: "granted-trigger",
		note: 'CardFactory:632 clone triggers, split(",")',
	},
	{
		param: "AddAbilities",
		form: "comma-list",
		role: "granted-ability",
		note: 'CardFactory:644 clone abilities, split(",")',
	},
	{
		param: "GainTextAbilities",
		form: "comma-list",
		role: "granted-ability",
		note: "CardFactory:645, same slot as AddAbilities",
	},
	{
		param: "Replacements",
		form: "comma-list",
		role: "granted-replacement",
		note: 'AnimateEffect:124, split(",")',
	},
	{
		param: "sVars",
		form: "comma-list",
		role: "granted-svar",
		note: 'AnimateEffect:142, split(","); Forge spells it lower-case',
	},
	{
		param: "ExtraTurnDelayedTrigger",
		form: "single",
		role: "extra-turn-trigger",
		note: "AddTurnEffect:48, sa.getSVar(param)",
	},
	{
		param: "StaticEffect",
		form: "single",
		role: "static-effect",
		note: "GameAction.changeZone -> AbilityUtils.getSVar(cause, StaticEffect)",
	},
	{
		param: "TriggersWhenSpent",
		form: "single",
		role: "mana-spent-trigger",
		note: "AbilityManaPart.triggersWhenSpent",
	},

	// Condition checks. Forge resolves these with AbilityUtils.calculateAmount,
	// which returns a literal for a plain number, so a value matching no SVar is
	// data rather than a dangling name. Hence `optional`.
	...(
		[
			["CheckSVar", "CardTraitBase.meetsCommonRequirements"],
			["CheckSecondSVar", "CardTraitBase.meetsCommonRequirements"],
			["CheckThirdSVar", "CardTraitBase / StaticAbility"],
			["CheckFourthSVar", "CardTraitBase / StaticAbility"],
			["ConditionCheckSVar", "SpellAbilityCondition.setSvarToCheck"],
			["BranchConditionSVar", "BranchEffect.resolve"],
			["RepeatCheckSVar", "RepeatEffect.resolve"],
			["StaticCommandCheckSVar", "ControlGainEffect, sa.getSVar(param)"],
			["AICheckSVar", "AiController (forge-ai), AI-only condition"],
		] as const
	).map(
		([param, note]): ForgeReferenceParamSpec => ({
			param,
			form: "single",
			role: "condition",
			optional: true,
			note,
		}),
	),

	// AbilityFactory.additionalAbilityKeys, verbatim and in source order.
	// `Execute` is a member of that list (DelayedTrigger) and is also the
	// reference parameter used by every `T:` record.
	...(
		[
			["WinSubAbility", "clash"],
			["OtherwiseSubAbility", "clash"],
			["BidSubAbility", "bid-life"],
			["ChooseNumberSubAbility", "choose-number"],
			["Lowest", "choose-number"],
			["Highest", "choose-number"],
			["NotLowest", "choose-number"],
			["GuessCorrect", "choose-number"],
			["GuessWrong", "choose-number"],
			["MatchedAbility", "choose-number"],
			["UnmatchedAbility", "choose-number"],
			["HeadsSubAbility", "flip-coin"],
			["TailsSubAbility", "flip-coin"],
			["LoseSubAbility", "flip-coin"],
			["TrueSubAbility", "branch"],
			["FalseSubAbility", "branch"],
			["ChosenPile", "piles"],
			["UnchosenPile", "piles"],
			["RepeatSubAbility", "repeat"],
			["Execute", "execute"],
			["FallbackAbility", "unless-cost-fallback"],
			["ChooseSubAbility", "choose-player"],
			["CantChooseSubAbility", "choose-player"],
			["RegenerationAbility", "regeneration"],
			["ReturnAbility", "delayed-return"],
			["GiftAbility", "gift"],
			["VoteSubAbility", "vote"],
			["VoteTiedAbility", "vote"],
		] as const
	).map(
		([param, role]): ForgeReferenceParamSpec => ({
			param,
			form: "single",
			role,
			note: "AbilityFactory.additionalAbilityKeys",
		}),
	),
];

const REFERENCE_PARAM_LOOKUP: ReadonlyMap<string, ForgeReferenceParamSpec> =
	new Map(
		FORGE_REFERENCE_PARAMS.map((spec) => [spec.param.toLowerCase(), spec]),
	);

export function lookupForgeReferenceParam(
	key: string,
): ForgeReferenceParamSpec | undefined {
	return REFERENCE_PARAM_LOOKUP.get(key.trim().toLowerCase());
}

/* ------------------------------------------------------------------------- */
/* Amount-parameter registry                                                  */
/* ------------------------------------------------------------------------- */

export interface ForgeAmountParamSpec {
	param: string;
	/** Effect APIs whose Java passes this parameter to `calculateAmount`. */
	apis?: readonly ForgeEffectName[];
	/** Static ability modes whose Java passes it to `calculateAmount`. */
	staticModes?: readonly ForgeStaticMode[];
	/** Read by spell-ability base machinery, so any ability record qualifies. */
	anyAbility?: boolean;
	note: string;
}

/**
 * Parameters Forge resolves through `AbilityUtils.calculateAmount`, which
 * accepts a literal, an expression, or an SVar name. Every row was derived by
 * walking `calculateAmount` call sites in the Forge sources and mapping the
 * owning class back to its `ApiType`; nothing here is inferred from a name
 * collision.
 *
 * The gating is what makes this safe. `NumDmg$ X` reads SVar `X` only because
 * `DamageDealEffect` passes `NumDmg` to `calculateAmount`; the same parameter
 * name on an unrelated API is not a reference. An ungated name-match registry
 * would invent edges.
 */
export const FORGE_AMOUNT_PARAMS: readonly ForgeAmountParamSpec[] = [
	{
		param: "TokenPower",
		apis: ["Token"],
		note: "TokenInfo:279 calculateAmount, reached from TokenEffect",
	},
	{
		param: "TokenToughness",
		apis: ["Token"],
		note: "TokenInfo:285 calculateAmount, reached from TokenEffect",
	},
	{
		param: "UnlessCost",
		anyAbility: true,
		note: "AbilityUtils unless-cost handling",
	},
	{
		param: "ReduceCost",
		anyAbility: true,
		note: "CostAdjustment:217, used as the amount when ReduceAmount is absent",
	},
	{
		param: "ReduceAmount",
		anyAbility: true,
		note: "CostAdjustment:216 getParamOrDefault -> calculateAmount",
	},
	{
		param: "RaiseCost",
		anyAbility: true,
		note: "CostAdjustment/GameActionUtil calculateAmount",
	},
	{
		param: "ActivationLimit",
		apis: [
			"Charm",
			"CompanionChoose",
			"InternalIgnoreEffect",
			"InternalLegendaryRule",
		],
		note: "4 effect class call site(s)",
	},
	{
		param: "AddPower",
		staticModes: ["Continuous"],
		note: "StaticAbilityContinuous",
	},
	{
		param: "AddToughness",
		staticModes: ["Continuous"],
		note: "StaticAbilityContinuous",
	},
	{
		param: "AdditionalVillainousChoice",
		staticModes: ["Continuous"],
		note: "StaticAbilityContinuous",
	},
	{
		param: "Amount",
		anyAbility: true,
		staticModes: ["ReduceCost", "RaiseCost"],
		apis: [
			"AssembleContraption",
			"ChooseCard",
			"ChooseSource",
			"CopySpellAbility",
			"DigUntil",
			"FlipCoin",
			"Incubate",
			"Intensify",
			"MakeCard",
			"Mana",
			"ManaReflected",
			"OpenAttraction",
			"Play",
			"PreventDamage",
			"Proliferate",
			"ReplaceCounter",
			"ReplaceDamage",
			"ReplaceToken",
			"RollDice",
			"Sacrifice",
			"SetState",
			"Surveil",
			"TimeTravel",
			"Untap",
		],
		note: "SpellAbility/SpellAbilityEffect/TargetRestrictions base machinery; 24 effect class call site(s)",
	},
	{
		param: "Announce",
		anyAbility: true,
		note: "SpellAbility/SpellAbilityEffect/TargetRestrictions base machinery",
	},
	{
		param: "CalcKeywordN",
		staticModes: ["Continuous"],
		note: "StaticAbilityContinuous",
	},
	{
		param: "CanBlockAmount",
		staticModes: ["Continuous"],
		apis: ["Pump"],
		note: "StaticAbilityContinuous; 1 effect class call site(s)",
	},
	{
		param: "ChangeNum",
		apis: ["ChangeZone", "Dig"],
		note: "2 effect class call site(s)",
	},
	{
		param: "CharmNum",
		apis: [
			"Charm",
			"CompanionChoose",
			"InternalIgnoreEffect",
			"InternalLegendaryRule",
		],
		note: "4 effect class call site(s)",
	},
	{
		param: "ChoiceAmount",
		apis: ["DealDamage", "GenericChoice", "PutCounter", "SetLife", "Tap"],
		note: "5 effect class call site(s)",
	},
	{
		param: "ChoiceNum",
		apis: ["Play", "RemoveCounter"],
		note: "2 effect class call site(s)",
	},
	{
		param: "ChooseAmount",
		apis: ["DigMultiple"],
		note: "1 effect class call site(s)",
	},
	{
		param: "ConniveNum",
		apis: ["Connive"],
		note: "1 effect class call site(s)",
	},
	{
		param: "CounterNum",
		apis: [
			"AddOrRemoveCounter",
			"MoveCounter",
			"PutCounter",
			"PutCounterAll",
			"RemoveCounter",
			"RemoveCounterAll",
		],
		note: "6 effect class call site(s)",
	},
	{
		param: "CounterNum2",
		apis: ["PutCounterAll"],
		note: "1 effect class call site(s)",
	},
	{
		param: "CounterNumPerDefined",
		apis: ["PutCounter"],
		note: "1 effect class call site(s)",
	},
	{
		param: "DestAltSVar",
		apis: ["ChangeZone"],
		note: "1 effect class call site(s)",
	},
	{
		param: "DigNum",
		apis: ["Dig", "DigMultiple"],
		note: "2 effect class call site(s)",
	},
	{
		param: "DividedAsYouChoose",
		anyAbility: true,
		note: "SpellAbility/SpellAbilityEffect/TargetRestrictions base machinery",
	},
	{
		param: "DraftNum",
		apis: ["Draft"],
		note: "1 effect class call site(s)",
	},
	{
		param: "Each",
		apis: ["Mana"],
		note: "1 effect class call site(s)",
	},
	{
		param: "Expression",
		apis: ["StoreSVar"],
		note: "1 effect class call site(s)",
	},
	{
		param: "FoundLibraryPosition",
		apis: ["DigUntil"],
		note: "1 effect class call site(s)",
	},
	{
		param: "GameActivationLimit",
		apis: [
			"Charm",
			"CompanionChoose",
			"InternalIgnoreEffect",
			"InternalLegendaryRule",
		],
		note: "4 effect class call site(s)",
	},
	{
		param: "IgnoreLower",
		apis: ["RollDice"],
		note: "1 effect class call site(s)",
	},
	{
		param: "LibraryPosition",
		apis: ["ChangeZone", "MakeCard"],
		note: "2 effect class call site(s)",
	},
	{
		param: "LifeAmount",
		apis: ["GainLife", "LoseLife", "SetLife"],
		note: "3 effect class call site(s)",
	},
	{
		param: "Max",
		apis: ["ChooseNumber"],
		note: "1 effect class call site(s)",
	},
	{
		param: "MaxRepeat",
		apis: ["Repeat"],
		note: "1 effect class call site(s)",
	},
	{
		param: "MaxRevealed",
		apis: ["DigUntil"],
		note: "1 effect class call site(s)",
	},
	{
		param: "Min",
		apis: ["ChooseNumber"],
		note: "1 effect class call site(s)",
	},
	{
		param: "MinCharmNum",
		apis: [
			"Charm",
			"CompanionChoose",
			"InternalIgnoreEffect",
			"InternalLegendaryRule",
		],
		note: "4 effect class call site(s)",
	},
	{
		param: "MinChoiceAmount",
		apis: ["PutCounter"],
		note: "1 effect class call site(s)",
	},
	{
		param: "MinTotalCMC",
		apis: ["DigUntil"],
		note: "1 effect class call site(s)",
	},
	{
		param: "Modifier",
		apis: ["RollDice"],
		note: "1 effect class call site(s)",
	},
	{
		param: "NoneFoundLibraryPosition",
		apis: ["DigUntil"],
		note: "1 effect class call site(s)",
	},
	{
		param: "NoteNumber",
		apis: ["Pump"],
		note: "1 effect class call site(s)",
	},
	{
		param: "Num",
		apis: [
			"Amass",
			"Blight",
			"Discover",
			"Earthbend",
			"Endure",
			"Explore",
			"Heist",
			"Investigate",
			"Poison",
			"Radiation",
			"Seek",
		],
		note: "11 effect class call site(s)",
	},
	{
		param: "NumAtt",
		apis: ["Pump", "PumpAll"],
		note: "2 effect class call site(s)",
	},
	{
		param: "NumCards",
		apis: ["Discard", "Draw", "Mill", "RearrangeTopOfLibrary", "Reveal"],
		note: "5 effect class call site(s)",
	},
	{
		param: "NumCopies",
		apis: ["CopyPermanent"],
		note: "1 effect class call site(s)",
	},
	{
		param: "NumDef",
		apis: ["Pump", "PumpAll"],
		note: "2 effect class call site(s)",
	},
	{
		param: "NumDmg",
		apis: ["DamageAll", "DealDamage", "EachDamage"],
		note: "3 effect class call site(s)",
	},
	{
		param: "NumPhases",
		apis: ["AddPhase"],
		note: "1 effect class call site(s)",
	},
	{
		param: "NumRandomChoices",
		apis: ["GenericChoice"],
		note: "1 effect class call site(s)",
	},
	{
		param: "NumTurns",
		apis: ["AddTurn", "SkipTurn"],
		note: "2 effect class call site(s)",
	},
	{
		param: "PeekAmount",
		apis: ["PeekAndReveal"],
		note: "1 effect class call site(s)",
	},
	{
		param: "Power",
		apis: ["Animate", "AnimateAll"],
		note: "2 effect class call site(s)",
	},
	{
		param: "RaiseMaxHandSize",
		staticModes: ["Continuous"],
		note: "StaticAbilityContinuous",
	},
	{
		param: "RandomCompareSVar",
		apis: [
			"Charm",
			"CompanionChoose",
			"InternalIgnoreEffect",
			"InternalLegendaryRule",
		],
		note: "4 effect class call site(s)",
	},
	{
		param: "RandomNum",
		apis: ["CopyPermanent", "Play"],
		note: "2 effect class call site(s)",
	},
	{
		param: "RememberSVarAmount",
		apis: ["DelayedTrigger", "ImmediateTrigger"],
		note: "2 effect class call site(s)",
	},
	{
		param: "RemoveConditionSVar",
		apis: ["AddOrRemoveCounter"],
		note: "1 effect class call site(s)",
	},
	{
		param: "RepeatNum",
		apis: ["SetInMotion"],
		note: "1 effect class call site(s)",
	},
	{
		param: "RepeatSVarCompare",
		apis: ["Repeat"],
		note: "1 effect class call site(s)",
	},
	{
		param: "RevealNumber",
		apis: ["Discard"],
		note: "1 effect class call site(s)",
	},
	{
		param: "RevealedLibraryPosition",
		apis: ["DigUntil"],
		note: "1 effect class call site(s)",
	},
	{
		param: "ScryNum",
		apis: ["Scry"],
		note: "1 effect class call site(s)",
	},
	{
		param: "SetChosenNumber",
		apis: ["Effect"],
		note: "1 effect class call site(s)",
	},
	{
		param: "SetPower",
		staticModes: ["Continuous"],
		note: "StaticAbilityContinuous",
	},
	{
		param: "SetToughness",
		staticModes: ["Continuous"],
		note: "StaticAbilityContinuous",
	},
	{
		param: "Sides",
		apis: ["RollDice"],
		note: "1 effect class call site(s)",
	},
	{
		param: "SpellbookAmount",
		apis: ["MakeCard"],
		note: "1 effect class call site(s)",
	},
	{
		param: "StartBidding",
		apis: ["BidLife"],
		note: "1 effect class call site(s)",
	},
	{
		param: "TargetMax",
		anyAbility: true,
		note: "SpellAbility/SpellAbilityEffect/TargetRestrictions base machinery",
	},
	{
		param: "TargetMin",
		anyAbility: true,
		note: "SpellAbility/SpellAbilityEffect/TargetRestrictions base machinery",
	},
	{
		param: "Times",
		apis: ["Incubate"],
		note: "1 effect class call site(s)",
	},
	{
		param: "TokenAmount",
		apis: ["Token"],
		note: "1 effect class call site(s)",
	},
	{
		param: "Toughness",
		apis: ["Animate", "AnimateAll"],
		note: "2 effect class call site(s)",
	},
	{
		param: "TriggerAmount",
		apis: ["ImmediateTrigger"],
		note: "1 effect class call site(s)",
	},
	{
		param: "TypeLimit",
		apis: ["ChangeZoneAll"],
		note: "1 effect class call site(s)",
	},
	{
		param: "UpToMin",
		apis: ["PutCounter"],
		note: "1 effect class call site(s)",
	},
	{
		param: "VarName",
		apis: ["ReplaceSplitDamage"],
		note: "1 effect class call site(s)",
	},
	{
		param: "VarValue",
		apis: ["ReplaceEffect"],
		note: "1 effect class call site(s)",
	},
	{
		param: "WithCounterNum",
		apis: ["MakeCard"],
		note: "1 effect class call site(s)",
	},
	{
		param: "WithCountersAmount",
		apis: ["ChangeZone", "ChangeZoneAll", "Dig"],
		note: "3 effect class call site(s)",
	},
	{
		param: "WithTotalCMC",
		apis: ["ChangeZone", "Dig", "Play"],
		note: "3 effect class call site(s)",
	},
	{
		param: "WithTotalCardTypes",
		apis: ["ChangeZone"],
		note: "1 effect class call site(s)",
	},
	{
		param: "WithTotalPower",
		apis: ["ChangeZone", "ChooseCard"],
		note: "2 effect class call site(s)",
	},
];

const AMOUNT_PARAM_LOOKUP: ReadonlyMap<string, ForgeAmountParamSpec> = new Map(
	FORGE_AMOUNT_PARAMS.map((spec) => [spec.param.toLowerCase(), spec]),
);

/** The record context an amount parameter is being read in. */
export interface ForgeAmountContext {
	/** Effect API for an ability record. */
	api?: string;
	/** Static modes for a static record. */
	staticModes?: readonly string[];
	/** True when the holder is an ability record (`AB`/`SP`/`ST`/`DB`). */
	isAbility: boolean;
}

/**
 * Whether `key` names an SVar in this context. Returns the matching spec so a
 * caller can cite the Java that justifies the edge.
 */
export function lookupForgeAmountParam(
	key: string,
	context: ForgeAmountContext,
): ForgeAmountParamSpec | undefined {
	const spec = AMOUNT_PARAM_LOOKUP.get(key.trim().toLowerCase());
	if (spec === undefined) return undefined;
	if (spec.anyAbility === true && context.isAbility) return spec;
	if (spec.apis !== undefined && context.api !== undefined) {
		const api = context.api.trim().toLowerCase();
		if (spec.apis.some((name) => name.toLowerCase() === api)) return spec;
	}
	if (spec.staticModes !== undefined && context.staticModes !== undefined) {
		const modes = context.staticModes.map((m) => m.trim().toLowerCase());
		if (spec.staticModes.some((m) => modes.includes(m.toLowerCase())))
			return spec;
	}
	return undefined;
}

/* ------------------------------------------------------------------------- */
/* Runtime-write registry                                                     */
/* ------------------------------------------------------------------------- */

export interface ForgeRuntimeWriteSpec {
	param: string;
	apis: readonly ForgeEffectName[];
	note: string;
}

/**
 * Parameters that CREATE an SVar while an ability resolves, rather than reading
 * one. The named SVar has no `SVar:` definition line anywhere in the script, so
 * reads of it are modelled against a synthetic runtime-value node.
 */
export const FORGE_RUNTIME_WRITE_PARAMS: readonly ForgeRuntimeWriteSpec[] = [
	{
		param: "ResultSVar",
		apis: ["RollDice"],
		note: "RollDiceEffect: sa.setSVar(param, total)",
	},
	{
		param: "SVar",
		apis: ["StoreSVar"],
		note: "StoreSVarEffect: writes the computed value under this name",
	},
];

export function lookupForgeRuntimeWrite(
	key: string,
	api: string | undefined,
): ForgeRuntimeWriteSpec | undefined {
	if (api === undefined) return undefined;
	const wanted = key.trim().toLowerCase();
	const forApi = api.trim().toLowerCase();
	return FORGE_RUNTIME_WRITE_PARAMS.find(
		(spec) =>
			spec.param.toLowerCase() === wanted &&
			spec.apis.some((a) => a.toLowerCase() === forApi),
	);
}

/* ------------------------------------------------------------------------- */
/* Keyword-form registry                                                      */
/* ------------------------------------------------------------------------- */

export interface ForgeKeywordRefSpec {
	/** Index into the `:`-split segments of the `K:` value. */
	segment: number;
	form: "single" | "comma-list";
	/** See `ForgeReferenceParamSpec.optional`. */
	optional?: boolean;
	role: string;
}

export interface ForgeKeywordSpec {
	keyword: string;
	refs: readonly ForgeKeywordRefSpec[];
	/** Exactly this one segment is an embedded `|`/`$` parameter list. */
	paramSegment?: number;
	/** This segment and everything after it, rejoined with `:`, is a param list. */
	paramTailFrom?: number;
	/** Segment values that explicitly mean "no parameters here". */
	paramSkip?: readonly string[];
	note: string;
}

/**
 * Keywords whose segments name SVars, from `CardFactoryUtil.addReplacementEffect
 * / addTriggerAbility / addSpellAbility` and `GameAction`. Every entry below was
 * read off the Java that splits the keyword string.
 *
 * A corpus sweep confirms this set covers every `K:` line whose segments name a
 * defined SVar; keywords outside it carry costs, types or counters rather than
 * references and are kept as verbatim segments only.
 */
export const FORGE_KEYWORD_SPECS: readonly ForgeKeywordSpec[] = [
	{
		keyword: "ETBReplacement",
		refs: [{ segment: 2, form: "single", role: "etb-replacement" }],
		note: "CardFactoryUtil:2579, card.getSVar(splitkw[2])",
	},
	{
		keyword: "Chapter",
		refs: [{ segment: 2, form: "comma-list", role: "chapter" }],
		note: 'CardFactoryUtil:803, k[2].split(",") with one entry per chapter',
	},
	{
		keyword: "Backup",
		refs: [{ segment: 2, form: "single", role: "backup" }],
		note: "CardFactoryUtil:643, card.getSVar(k[2])",
	},
	{
		keyword: "Haunt",
		refs: [{ segment: 1, form: "single", role: "haunt" }],
		note: "CardFactoryUtil:3053, card.getSVar(k[1])",
	},
	{
		keyword: "Visit",
		refs: [{ segment: 1, form: "single", role: "visit" }],
		note: "CardFactoryUtil:1898, AbilityFactory.getAbility(card, k[1])",
	},
	{
		keyword: "Prize",
		refs: [{ segment: 1, form: "single", role: "prize" }],
		note: "CardFactoryUtil:1910, AbilityFactory.getAbility(card, k[1])",
	},
	{
		keyword: "MayEffectFromOpeningHand",
		refs: [{ segment: 1, form: "single", role: "opening-hand-effect" }],
		note: "GameAction:2491, c.getSVar(split[1])",
	},
	{
		keyword: "MayEffectFromOpeningDeck",
		refs: [{ segment: 1, form: "single", role: "opening-deck-effect" }],
		note: "GameAction, same shape as MayEffectFromOpeningHand",
	},
	{
		// etbCounter:<type>:<amount>[:<condition params>|no Condition][:<desc>]
		keyword: "etbCounter",
		refs: [
			{
				segment: 2,
				form: "single",
				optional: true,
				role: "etb-counter-amount",
			},
		],
		paramSegment: 3,
		paramSkip: ["no Condition"],
		note: "CardFactoryUtil.makeEtbCounter:544; splitkw[3] is a condition param list",
	},
	{
		// Class:<level>:<cost>:<params...> - the tail may itself contain ':'
		keyword: "Class",
		refs: [],
		paramTailFrom: 3,
		note: "CardFactoryUtil:2705; k[2] is a Cost, the tail carries Add* params",
	},
];

const KEYWORD_SPEC_LOOKUP: ReadonlyMap<string, ForgeKeywordSpec> = new Map(
	FORGE_KEYWORD_SPECS.map((spec) => [spec.keyword.toLowerCase(), spec]),
);

/**
 * Forge dispatches keywords with `keyword.startsWith(...)`. This module matches
 * the first `:` segment exactly instead, which is equivalent for every observed
 * form and avoids a hypothetical `ChapterTwo:` being read as `Chapter`.
 */
export function lookupForgeKeywordSpec(
	keyword: string,
): ForgeKeywordSpec | undefined {
	return KEYWORD_SPEC_LOOKUP.get(keyword.trim().toLowerCase());
}

/* ------------------------------------------------------------------------- */
/* Layer 1: scanner                                                           */
/* ------------------------------------------------------------------------- */

const FACE_MARKER_ALTERNATE = "ALTERNATE";
const FACE_MARKER_SPECIALIZE = "SPECIALIZE";

/**
 * `CardRules.Reader.parseLine` treats `ALTERNATE` and any key starting with
 * `SPECIALIZE` as face switches. The `startsWith` behaviour is reproduced here
 * so that a hypothetical `SPECIALIZEX:` line is classified the way Forge would.
 */
function isFaceMarkerKey(key: string): boolean {
	return (
		key === FACE_MARKER_ALTERNATE || key.startsWith(FACE_MARKER_SPECIALIZE)
	);
}

function scanForgeSource(
	source: string,
	diagnostics: ForgeDiagnostic[],
): ForgeScriptDocument {
	const nodes: ForgeSourceNode[] = [];
	const rawLines = source.split(/\r\n|\n|\r/);

	for (let index = 0; index < rawLines.length; index++) {
		const line = index + 1;
		const text = (rawLines[index] ?? "").trim();

		// Blank lines and comments carry no meaning and are dropped outright.
		if (text === "" || text.startsWith("#")) continue;

		const colon = text.indexOf(":");
		const key = colon > 0 ? text.slice(0, colon) : text;
		const id = `line:${line}`;

		if (isFaceMarkerKey(key)) {
			const node: ForgeFaceMarkerNode = {
				kind: "face-marker",
				id,
				line,
				marker: key,
				raw: text,
			};
			if (colon > 0) node.argument = text.slice(colon + 1).trim();
			nodes.push(node);
			continue;
		}

		// Forge only splits when `indexOf(':') > 0`; anything else has no key.
		if (colon <= 0) {
			const reason =
				colon === 0
					? "line starts with ':' and therefore has no directive key"
					: "line has no ':' separator and is not a face marker";
			nodes.push({ kind: "malformed", id, line, raw: text, reason });
			diagnostics.push({
				severity: "warning",
				stage: "source",
				code: "MALFORMED_LINE",
				message: `Unclassifiable card script line (${reason}): ${text}`,
				line,
				nodeId: id,
			});
			continue;
		}

		nodes.push({
			kind: "directive",
			id,
			line,
			key,
			value: text.slice(colon + 1).trim(),
		});
	}

	return { schema: "forge-card-script", schemaVersion: 1, nodes };
}

/* ------------------------------------------------------------------------- */
/* Layer 1: canonical printer                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Prints source nodes directly, in order, so duplicates and unknown records
 * cannot be lost. Comments, blank lines and CRLF are intentionally not restored;
 * the guaranteed invariant is that reparsing the output yields an equivalent
 * meaningful document (see {@link projectForgeDocument}).
 */
export function printForgeCardScript(document: ForgeScriptDocument): string {
	const lines: string[] = [];
	for (const node of document.nodes) {
		switch (node.kind) {
			case "directive":
				lines.push(`${node.key}:${node.value}`);
				break;
			case "face-marker":
				lines.push(
					node.argument === undefined
						? node.marker
						: `${node.marker}:${node.argument}`,
				);
				break;
			case "malformed":
				lines.push(node.raw);
				break;
		}
	}
	return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/* ------------------------------------------------------------------------- */
/* Structural projection (round-trip comparison)                              */
/* ------------------------------------------------------------------------- */

export type ForgeProjectedNode =
	| ["directive", string, string]
	| ["face-marker", string, string | null]
	| ["malformed", string];

/**
 * A normalized view of a document that ignores line numbers, generated ids,
 * diagnostics, comments and blank lines, while preserving node order, node
 * kinds, marker arguments, directive keys/values and every duplicate.
 */
export function projectForgeDocument(
	document: ForgeScriptDocument,
): ForgeProjectedNode[] {
	return document.nodes.map((node): ForgeProjectedNode => {
		if (node.kind === "directive") {
			return ["directive", node.key, node.value];
		}
		if (node.kind === "face-marker") {
			return ["face-marker", node.marker, node.argument ?? null];
		}
		return ["malformed", node.raw];
	});
}

/* ------------------------------------------------------------------------- */
/* Layer 2: parameter parsing                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Splits a Forge embedded-DSL body into ordered parameters.
 *
 * Mirrors `FileSection.parseToMap(line, DOLLAR_SIGN_KV_SEPARATOR)`:
 *   - split the body on `|`;
 *   - split each fragment at the FIRST `$` only;
 *   - trim key and value;
 *   - a fragment with no `$` yields an empty value.
 *
 * No escape syntax exists. `FileSection` quotes both delimiters as literals and
 * the corpus contains zero `\|` sequences, zero empty `||` fragments and zero
 * trailing `|`, so naive splitting is the correct reading. (Java's `String.split`
 * additionally drops *trailing* empty fragments; this parser keeps them, because
 * preserving the source record matters more than reproducing that quirk.)
 *
 * Unknown parameter names are ordinary data. Duplicates are preserved in
 * `entries`; `effective` is the derived last-write-wins view.
 */
export function parseForgeParams(
	body: string,
	idPrefix = "params",
	diagnostics?: ForgeDiagnostic[],
	line?: number,
): ForgeParamList {
	const entries: ForgeParamEntry[] = [];
	const effective: Record<string, string> = {};
	const effectiveLower: Record<string, string> = {};
	const canonicalCase = new Map<string, string>();

	if (body !== "") {
		const fragments = body.split("|");
		for (let index = 0; index < fragments.length; index++) {
			const raw = fragments[index] ?? "";
			const dollar = raw.indexOf("$");
			const keyRaw = dollar >= 0 ? raw.slice(0, dollar) : raw;
			const valueRaw = dollar >= 0 ? raw.slice(dollar + 1) : "";
			const key = keyRaw.trim();
			const value = valueRaw.trim();
			const malformed = dollar < 0 && raw.trim() !== "";
			const id = `${idPrefix}/param:${index}`;

			entries.push({
				id,
				index,
				raw,
				keyRaw,
				valueRaw,
				key,
				value,
				malformed,
			});

			if (malformed && diagnostics) {
				diagnostics.push({
					severity: "warning",
					stage: "classify",
					code: "MALFORMED_PARAM",
					message: `Parameter fragment has no '$' separator: ${raw.trim()}`,
					...(line === undefined ? {} : { line }),
					paramId: id,
				});
			}

			const lower = key.toLowerCase();
			const canonical = canonicalCase.get(lower) ?? key;
			canonicalCase.set(lower, canonical);
			effective[canonical] = value;
			effectiveLower[lower] = value;
		}
	}

	return { raw: body, entries, effective, effectiveLower };
}

/** Case-insensitive, last-write-wins parameter lookup. */
export function getForgeParam(
	params: ForgeParamList,
	key: string,
): string | undefined {
	return params.effectiveLower[key.trim().toLowerCase()];
}

/* ------------------------------------------------------------------------- */
/* Layer 2: record classification                                             */
/* ------------------------------------------------------------------------- */

/**
 * Ability record discriminators, in `AbilityFactory.AbilityRecordType
 * .getRecordType` precedence order. Lookup goes through the case-insensitive
 * parameter map, so `ab$`/`AB$` behave identically.
 */
const ABILITY_DISCRIMINATORS = [
	["AB", "activated"],
	["SP", "spell"],
	["ST", "static"],
	["DB", "sub-ability"],
] as const;

function toDirectiveRef(node: ForgeDirectiveNode): ForgeDirectiveRef {
	return {
		nodeId: node.id,
		line: node.line,
		key: node.key,
		value: node.value,
	};
}

function classifyAbility(
	id: string,
	origin: ForgeRecordOrigin,
	source: ForgeDirectiveRef,
	params: ForgeParamList,
	diagnostics: ForgeDiagnostic[],
): ForgeAbilityRecord {
	const present = ABILITY_DISCRIMINATORS.filter(
		([token]) => params.effectiveLower[token.toLowerCase()] !== undefined,
	);

	if (present.length === 0) {
		diagnostics.push({
			severity: "warning",
			stage: "classify",
			code: "MISSING_DISCRIMINATOR",
			message: `Ability record has no AB/SP/ST/DB discriminator: ${source.value}`,
			line: source.line,
			nodeId: source.nodeId,
		});
		return {
			kind: "ability",
			id,
			origin,
			source,
			params,
			abilityKind: "unknown",
			effectKnown: false,
		};
	}

	if (present.length > 1) {
		diagnostics.push({
			severity: "warning",
			stage: "classify",
			code: "CONFLICTING_DISCRIMINATORS",
			message: `Ability record declares several discriminators (${present
				.map(([token]) => token)
				.join(", ")}); keeping all parameters and using Forge's ${
				present[0]?.[0]
			} precedence.`,
			line: source.line,
			nodeId: source.nodeId,
		});
	}

	// present is already in Forge's AB > SP > ST > DB precedence order.
	const winner = present[0] as (typeof ABILITY_DISCRIMINATORS)[number];
	const [token, abilityKind] = winner;
	const effectName = params.effectiveLower[token.toLowerCase()] ?? "";
	const effectKnown = isKnownForgeEffectName(effectName);

	if (effectName !== "" && !effectKnown) {
		diagnostics.push({
			severity: "info",
			stage: "classify",
			code: "UNKNOWN_EFFECT",
			message: `Unknown effect API name "${effectName}" (preserved).`,
			line: source.line,
			nodeId: source.nodeId,
		});
	}

	return {
		kind: "ability",
		id,
		origin,
		source,
		params,
		abilityKind,
		discriminator: token,
		effectName,
		effectKnown,
	};
}

function classifyTrigger(
	id: string,
	origin: ForgeRecordOrigin,
	source: ForgeDirectiveRef,
	params: ForgeParamList,
	diagnostics: ForgeDiagnostic[],
): ForgeTriggerRecord {
	const mode = params.effectiveLower.mode;
	if (mode === undefined) {
		diagnostics.push({
			severity: "warning",
			stage: "classify",
			code: "MISSING_DISCRIMINATOR",
			message: `Trigger record has no Mode$ parameter: ${source.value}`,
			line: source.line,
			nodeId: source.nodeId,
		});
		return { kind: "trigger", id, origin, source, params, modeKnown: false };
	}

	const modeKnown = isKnownForgeTriggerMode(mode);
	if (!modeKnown) {
		diagnostics.push({
			severity: "info",
			stage: "classify",
			code: "UNKNOWN_TRIGGER_MODE",
			message: `Unknown trigger mode "${mode}" (preserved).`,
			line: source.line,
			nodeId: source.nodeId,
		});
	}
	return { kind: "trigger", id, origin, source, params, mode, modeKnown };
}

function classifyReplacement(
	id: string,
	origin: ForgeRecordOrigin,
	source: ForgeDirectiveRef,
	params: ForgeParamList,
	diagnostics: ForgeDiagnostic[],
): ForgeReplacementRecord {
	const event = params.effectiveLower.event;
	if (event === undefined) {
		diagnostics.push({
			severity: "warning",
			stage: "classify",
			code: "MISSING_DISCRIMINATOR",
			message: `Replacement record has no Event$ parameter: ${source.value}`,
			line: source.line,
			nodeId: source.nodeId,
		});
		return {
			kind: "replacement",
			id,
			origin,
			source,
			params,
			eventKnown: false,
		};
	}

	const eventKnown = isKnownForgeReplacementEvent(event);
	if (!eventKnown) {
		diagnostics.push({
			severity: "info",
			stage: "classify",
			code: "UNKNOWN_REPLACEMENT_EVENT",
			message: `Unknown replacement event "${event}" (preserved).`,
			line: source.line,
			nodeId: source.nodeId,
		});
	}
	return { kind: "replacement", id, origin, source, params, event, eventKnown };
}

function classifyStatic(
	id: string,
	origin: ForgeRecordOrigin,
	source: ForgeDirectiveRef,
	params: ForgeParamList,
	diagnostics: ForgeDiagnostic[],
): ForgeStaticRecord {
	const mode = params.effectiveLower.mode;
	if (mode === undefined) {
		diagnostics.push({
			severity: "warning",
			stage: "classify",
			code: "MISSING_DISCRIMINATOR",
			message: `Static ability record has no Mode$ parameter: ${source.value}`,
			line: source.line,
			nodeId: source.nodeId,
		});
		return {
			kind: "static",
			id,
			origin,
			source,
			params,
			modes: [],
			modeKnown: false,
		};
	}

	// StaticAbilityMode.setValueOf splits on [, ]+ and unions the results.
	const modes = mode.split(/[, ]+/).filter((part) => part !== "");
	const unknown = modes.filter((part) => !isKnownForgeStaticMode(part));
	const modeKnown = modes.length > 0 && unknown.length === 0;

	for (const part of unknown) {
		diagnostics.push({
			severity: "info",
			stage: "classify",
			code: "UNKNOWN_STATIC_MODE",
			message: `Unknown static ability mode "${part}" (preserved).`,
			line: source.line,
			nodeId: source.nodeId,
		});
	}

	return { kind: "static", id, origin, source, params, mode, modes, modeKnown };
}

/* ------------------------------------------------------------------------- */
/* Layer 2: SVars                                                             */
/* ------------------------------------------------------------------------- */

/**
 * First-parameter keys that make an SVar value structurally an ability, trigger,
 * replacement or static record. Everything else — `Count$...`, `SVar$X/Plus.1`,
 * `TRUE`, bare numbers, AI hints — stays a scalar and is never evaluated.
 */
const SVAR_RECORD_KEYS: ReadonlySet<string> = new Set([
	"ab",
	"sp",
	"st",
	"db",
	"mode",
	"event",
]);

function svarLooksLikeRecord(value: string): boolean {
	const firstFragment = value.split("|")[0] ?? "";
	const dollar = firstFragment.indexOf("$");
	if (dollar < 0) return false;
	return SVAR_RECORD_KEYS.has(
		firstFragment.slice(0, dollar).trim().toLowerCase(),
	);
}

function classifySVarRecord(
	id: string,
	source: ForgeDirectiveRef,
	params: ForgeParamList,
	diagnostics: ForgeDiagnostic[],
): ForgeClassifiedRecord {
	// `AbilityFactory.AbilityRecordType.getRecordType` inspects AB/SP/ST/DB
	// first, so those win outright. This matters: plenty of ability SVars carry
	// an ordinary `Mode$` *effect parameter* (`DB$ Discard | Mode$ TgtChoose`,
	// `DB$ SetState | Mode$ Transform`) whose value is not a static mode at all.
	const hasDiscriminator = ABILITY_DISCRIMINATORS.some(
		([token]) => params.effectiveLower[token.toLowerCase()] !== undefined,
	);
	if (hasDiscriminator) {
		return classifyAbility(id, "svar", source, params, diagnostics);
	}
	if (params.effectiveLower.event !== undefined) {
		return classifyReplacement(id, "svar", source, params, diagnostics);
	}
	const mode = params.effectiveLower.mode;
	if (mode !== undefined) {
		// TriggerType and StaticAbilityMode share no names in the reference
		// revision, so a Mode$ value picks exactly one of the two categories.
		if (isKnownForgeTriggerMode(mode)) {
			return classifyTrigger(id, "svar", source, params, diagnostics);
		}
		return classifyStatic(id, "svar", source, params, diagnostics);
	}
	return classifyAbility(id, "svar", source, params, diagnostics);
}

function parseSVarDirective(
	node: ForgeDirectiveNode,
	idPrefix: string,
	diagnostics: ForgeDiagnostic[],
): ForgeSVarRecord {
	const source = toDirectiveRef(node);
	// CardRules.Reader splits `SVar:<name>:<value>` at the FIRST ':' of the value
	// only, so any further ':' belongs to the value (e.g. `KW$ Ward:1`).
	const colon = node.value.indexOf(":");
	if (colon <= 0) {
		diagnostics.push({
			severity: "warning",
			stage: "index",
			code: "MALFORMED_SVAR",
			message: `SVar directive has no '<name>:<value>' separator: ${node.value}`,
			line: node.line,
			nodeId: node.id,
		});
		const nameRaw = node.value;
		return {
			id: idPrefix,
			name: nameRaw.trim(),
			nameRaw,
			value: "",
			source,
			parsed: { kind: "scalar", value: "" },
		};
	}

	const nameRaw = node.value.slice(0, colon);
	const value = node.value.slice(colon + 1);

	if (!svarLooksLikeRecord(value)) {
		return {
			id: idPrefix,
			name: nameRaw.trim(),
			nameRaw,
			value,
			source,
			parsed: { kind: "scalar", value },
		};
	}

	const params = parseForgeParams(value, idPrefix, diagnostics, node.line);
	return {
		id: idPrefix,
		name: nameRaw.trim(),
		nameRaw,
		value,
		source,
		parsed: { kind: "params", params },
		classified: classifySVarRecord(idPrefix, source, params, diagnostics),
	};
}

/* ------------------------------------------------------------------------- */
/* Layer 2: faces                                                             */
/* ------------------------------------------------------------------------- */

const SPECIALIZE_SLOTS: Readonly<Record<string, number>> = {
	WHITE: 2,
	BLUE: 3,
	BLACK: 4,
	RED: 5,
	GREEN: 6,
};

function emptyFace(slot: number): ForgeFaceAst {
	const state = FORGE_FACE_STATES[slot] ?? "original";
	return {
		id: `face:${state}`,
		state,
		slot,
		sourceNodeIds: [],
		characteristics: { all: [] },
		keywords: [],
		keywordRecords: [],
		abilities: [],
		triggers: [],
		replacements: [],
		statics: [],
		svars: [],
		draftActions: [],
		variants: [],
		otherDirectives: [],
		svarIndex: {},
	};
}

function indexSVar(face: ForgeFaceAst, record: ForgeSVarRecord): void {
	face.svars.push(record);
	const key = record.name.toLowerCase();
	const bucket = face.svarIndex[key];
	if (bucket === undefined) {
		face.svarIndex[key] = [record];
	} else {
		bucket.push(record);
	}
}

/**
 * Splits a `K:` value into ordered segments and, for the forms in
 * {@link FORGE_KEYWORD_SPECS}, tokenizes the embedded parameter tail. Segments
 * are always preserved verbatim, so an unknown keyword loses nothing.
 */
function parseForgeKeyword(
	node: ForgeDirectiveNode,
	id: string,
	diagnostics: ForgeDiagnostic[],
): ForgeKeywordRecord {
	const raw = node.value;
	const segments = raw.split(":");
	const keyword = (segments[0] ?? "").trim();
	const spec = lookupForgeKeywordSpec(keyword);
	const record: ForgeKeywordRecord = {
		id,
		source: toDirectiveRef(node),
		raw,
		keyword,
		segments,
		known: spec !== undefined,
	};
	if (spec === undefined) return record;

	let body: string | undefined;
	if (
		spec.paramTailFrom !== undefined &&
		segments.length > spec.paramTailFrom
	) {
		body = segments.slice(spec.paramTailFrom).join(":");
	} else if (spec.paramSegment !== undefined) {
		body = segments[spec.paramSegment];
	}
	if (
		body !== undefined &&
		body !== "" &&
		!(spec.paramSkip ?? []).includes(body)
	) {
		record.params = parseForgeParams(body, id, diagnostics, node.line);
	}
	return record;
}

/**
 * Parses the directive nested inside a `Variant:<name>:<directive>` line.
 * The patch is kept beside the face; it is never merged into the face's own
 * lists, so `Variant:` never destructively rewrites the base face.
 */
function parseVariantPatch(
	node: ForgeDirectiveNode,
	diagnostics: ForgeDiagnostic[],
): ForgeVariantPatch | undefined {
	const colon = node.value.indexOf(":");
	if (colon <= 0) {
		diagnostics.push({
			severity: "warning",
			stage: "index",
			code: "MALFORMED_VARIANT",
			message: `Variant directive has no '<name>:<directive>' separator: ${node.value}`,
			line: node.line,
			nodeId: node.id,
		});
		return undefined;
	}

	const nameRaw = node.value.slice(0, colon);
	const inner = node.value.slice(colon + 1);
	const innerColon = inner.indexOf(":");
	const innerKey = innerColon > 0 ? inner.slice(0, innerColon) : inner;
	const innerValue = innerColon > 0 ? inner.slice(innerColon + 1).trim() : "";

	const id = `${node.id}/variant`;
	const patch: ForgeDirectiveRef = {
		nodeId: id,
		line: node.line,
		key: innerKey,
		value: innerValue,
	};

	const result: ForgeVariantPatch = {
		id,
		name: nameRaw.trim(),
		nameRaw,
		source: toDirectiveRef(node),
		patch,
	};

	const innerNode: ForgeDirectiveNode = {
		kind: "directive",
		id,
		line: node.line,
		key: innerKey,
		value: innerValue,
	};

	switch (directiveSpec(innerKey).category) {
		case "ability":
			result.classified = classifyAbility(
				id,
				"variant",
				patch,
				parseForgeParams(innerValue, id, diagnostics, node.line),
				diagnostics,
			);
			break;
		case "trigger":
			result.classified = classifyTrigger(
				id,
				"variant",
				patch,
				parseForgeParams(innerValue, id, diagnostics, node.line),
				diagnostics,
			);
			break;
		case "replacement":
			result.classified = classifyReplacement(
				id,
				"variant",
				patch,
				parseForgeParams(innerValue, id, diagnostics, node.line),
				diagnostics,
			);
			break;
		case "static":
			result.classified = classifyStatic(
				id,
				"variant",
				patch,
				parseForgeParams(innerValue, id, diagnostics, node.line),
				diagnostics,
			);
			break;
		case "svar":
			result.svar = parseSVarDirective(innerNode, id, diagnostics);
			break;
		default:
			break;
	}

	return result;
}

function buildFaces(
	document: ForgeScriptDocument,
	diagnostics: ForgeDiagnostic[],
): { faces: ForgeFaceAst[]; cardDirectives: ForgeDirectiveRef[] } {
	const slots = new Map<number, ForgeFaceAst>();
	const cardDirectives: ForgeDirectiveRef[] = [];
	let slot = 0;

	const faceFor = (index: number): ForgeFaceAst => {
		let face = slots.get(index);
		if (face === undefined) {
			face = emptyFace(index);
			slots.set(index, face);
		}
		return face;
	};

	// Slot 0 always exists, even for a script that only contains `CopyFaceFrom`.
	faceFor(0);

	for (const node of document.nodes) {
		if (node.kind === "malformed") continue;

		if (node.kind === "face-marker") {
			if (node.marker === FACE_MARKER_ALTERNATE) {
				slot = 1;
				faceFor(1).sourceNodeIds.push(node.id);
				continue;
			}
			// SPECIALIZE: the colour argument selects slots 2..6. Forge silently
			// ignores an unrecognised colour and leaves the current face alone.
			const target = SPECIALIZE_SLOTS[(node.argument ?? "").trim()];
			if (target === undefined) {
				diagnostics.push({
					severity: "warning",
					stage: "index",
					code: "UNKNOWN_FACE_MARKER",
					message: `Unrecognised specialize face marker "${node.raw}"; keeping the current face.`,
					line: node.line,
					nodeId: node.id,
				});
				faceFor(slot).sourceNodeIds.push(node.id);
				continue;
			}
			slot = target;
			faceFor(target).sourceNodeIds.push(node.id);
			continue;
		}

		const spec = directiveSpec(node.key);
		if (spec.category === "card") {
			cardDirectives.push(toDirectiveRef(node));
			continue;
		}

		const face = faceFor(slot);
		face.sourceNodeIds.push(node.id);
		const ref = toDirectiveRef(node);

		switch (spec.category) {
			case "characteristic": {
				face.characteristics.all.push(ref);
				const key = spec.characteristic;
				if (key !== undefined) face.characteristics[key] = ref;
				break;
			}
			case "keyword":
				face.keywords.push(ref);
				face.keywordRecords.push(parseForgeKeyword(node, node.id, diagnostics));
				break;
			case "ability":
				face.abilities.push(
					classifyAbility(
						node.id,
						"directive",
						ref,
						parseForgeParams(node.value, node.id, diagnostics, node.line),
						diagnostics,
					),
				);
				break;
			case "trigger":
				face.triggers.push(
					classifyTrigger(
						node.id,
						"directive",
						ref,
						parseForgeParams(node.value, node.id, diagnostics, node.line),
						diagnostics,
					),
				);
				break;
			case "replacement":
				face.replacements.push(
					classifyReplacement(
						node.id,
						"directive",
						ref,
						parseForgeParams(node.value, node.id, diagnostics, node.line),
						diagnostics,
					),
				);
				break;
			case "static":
				face.statics.push(
					classifyStatic(
						node.id,
						"directive",
						ref,
						parseForgeParams(node.value, node.id, diagnostics, node.line),
						diagnostics,
					),
				);
				break;
			case "svar":
				indexSVar(face, parseSVarDirective(node, node.id, diagnostics));
				break;
			case "draft":
				face.draftActions.push(ref);
				break;
			case "variant": {
				const patch = parseVariantPatch(node, diagnostics);
				if (patch !== undefined) face.variants.push(patch);
				else face.otherDirectives.push(ref);
				break;
			}
			default:
				// Unknown top-level metadata is preserved without a diagnostic; the
				// Forge vocabulary grows and noise here would be useless.
				face.otherDirectives.push(ref);
				break;
		}
	}

	for (const face of slots.values()) {
		for (const [name, bucket] of Object.entries(face.svarIndex)) {
			if (bucket.length > 1) {
				const last = bucket[bucket.length - 1];
				diagnostics.push({
					severity: "info",
					stage: "index",
					code: "DUPLICATE_SVAR",
					message: `SVar "${name}" is defined ${bucket.length} times on face ${face.state}; all definitions are kept, Forge would use the last.`,
					...(last === undefined ? {} : { line: last.source.line }),
					...(last === undefined ? {} : { nodeId: last.source.nodeId }),
				});
			}
		}
	}

	const faces = [...slots.values()].sort((a, b) => a.slot - b.slot);
	return { faces, cardDirectives };
}

/* ------------------------------------------------------------------------- */
/* Layer 2: reference graph                                                   */
/* ------------------------------------------------------------------------- */

/**
 * A name position inside a scalar SVar value or a `Count$` expression.
 * The raw string stays authoritative: these helpers locate names, they never
 * evaluate arithmetic or comparisons.
 */
export interface ForgeExpressionReference {
	name: string;
	/** Which part of the grammar the name sits in. */
	position: string;
}

/**
 * Extracts SVar names from the narrow `SVar$<name>[/<Op>.<operand>]` scalar
 * form, per `AbilityUtils.calculateAmount`'s `calcX[0].startsWith("SVar")`
 * branch: the base name goes to `calculateAmount`, and `doXMath` falls back to
 * `calculateAmount` for a non-numeric operand.
 */
export function parseForgeScalarSVarExpression(
	value: string,
): ForgeExpressionReference[] {
	const trimmed = value.trim();
	if (!trimmed.startsWith("SVar$")) return [];
	const rest = trimmed.slice(5);
	if (rest === "") return [];
	const slash = rest.indexOf("/");
	const base = (slash < 0 ? rest : rest.slice(0, slash)).trim();
	const out: ForgeExpressionReference[] = [];
	if (/^[A-Za-z0-9_]+$/.test(base)) out.push({ name: base, position: "base" });
	if (slash >= 0) {
		// doXMath splits the operator on "." and integer-parses the operand;
		// anything non-numeric falls through to calculateAmount.
		const parts = rest.slice(slash + 1).split(".");
		const operand = (parts[1] ?? "").trim();
		if (
			operand !== "" &&
			!/^\d+$/.test(operand) &&
			/^[A-Za-z0-9_]+$/.test(operand)
		) {
			out.push({ name: operand, position: "operand" });
		}
	}
	return out;
}

/**
 * Extracts SVar names from the two `Count$` operations whose operands Forge
 * passes to `calculateAmount` (`AbilityUtils.xCount`):
 *
 *   Count$Compare <lhs> <OP><rhs>.<ifTrue>.<ifFalse>
 *   Count$IsPrime <lhs>.<ifTrue>.<ifFalse>
 *
 * plus a leading `SVar$<name>`, which `xCount` resolves directly. Every other
 * `Count$` verb takes a selector rather than an SVar name and is left alone.
 */
export function parseForgeCountExpression(
	value: string,
): ForgeExpressionReference[] {
	let body = value.trim();
	if (body.startsWith("PlayerCount$")) return [];
	const counted = body.startsWith("Count$");
	if (counted) body = body.slice(6);
	// A bare `SVar$...` value is the scalar form, handled by
	// parseForgeScalarSVarExpression; only `Count$SVar$...` belongs here.
	if (counted && body.startsWith("SVar$")) {
		const name = body.slice(5).split("/")[0]?.trim() ?? "";
		return /^[A-Za-z0-9_]+$/.test(name) ? [{ name, position: "svar" }] : [];
	}
	const dotted = body.split(".");
	const head = dotted[0] ?? "";
	const isCompare = head.startsWith("Compare");
	const isPrime = head.startsWith("IsPrime");
	if (!isCompare && !isPrime) return [];
	const words = head.split(" ").filter((w) => w !== "");
	const out: ForgeExpressionReference[] = [];
	const push = (raw: string | undefined, position: string): void => {
		const name = (raw ?? "").trim();
		if (name !== "" && !/^\d+$/.test(name) && /^[A-Za-z0-9_]+$/.test(name)) {
			out.push({ name, position });
		}
	};
	push(words[1], "lhs");
	// Compare's third word is a two-character operator followed by the operand.
	if (isCompare) push((words[2] ?? "").slice(2), "rhs");
	push(dotted[1], "if-true");
	push(dotted[2], "if-false");
	return out;
}

interface ReferenceTarget {
	raw: string;
	label?: string;
}

function expandReference(
	spec: ForgeReferenceParamSpec,
	value: string,
): ReferenceTarget[] {
	switch (spec.form) {
		case "single":
			return value.trim() === "" ? [] : [{ raw: value.trim() }];
		case "amp-list":
			return value
				.split(" & ")
				.map((part) => part.trim())
				.filter((part) => part !== "")
				.map((part) => ({ raw: part }));
		case "comma-list":
			return value
				.split(",")
				.map((part) => part.trim())
				.filter((part) => part !== "")
				.map((part) => ({ raw: part }));
		case "labeled-comma-list":
			// RollDice `ResultSubAbilities$ 1:DBFoo,2:DBBar`.
			return value
				.split(",")
				.map((part) => part.trim())
				.filter((part) => part !== "")
				.map((part) => {
					const colon = part.indexOf(":");
					return colon < 0
						? { raw: part }
						: {
								raw: part.slice(colon + 1).trim(),
								label: part.slice(0, colon),
							};
				});
	}
}

interface FaceScope {
	face: ForgeFaceAst;
	/** Lowercased SVar name -> node ids, in definition order. */
	lookup: Map<string, string[]>;
}

function scopeFor(face: ForgeFaceAst): FaceScope {
	const lookup = new Map<string, string[]>();
	const add = (name: string, id: string): void => {
		const key = name.toLowerCase();
		const bucket = lookup.get(key);
		if (bucket === undefined) lookup.set(key, [id]);
		else bucket.push(id);
	};
	for (const svar of face.svars) add(svar.name, svar.id);
	return { face, lookup };
}

function contextOf(
	record: ForgeClassifiedRecord | undefined,
): ForgeAmountContext {
	if (record === undefined) return { isAbility: false };
	if (record.kind === "ability") {
		return { isAbility: true, api: record.effectName };
	}
	if (record.kind === "static") {
		return { isAbility: false, staticModes: record.modes };
	}
	return { isAbility: false };
}

function recordsOf(face: ForgeFaceAst): ForgeClassifiedRecord[] {
	return [
		...face.abilities,
		...face.triggers,
		...face.replacements,
		...face.statics,
	];
}

/**
 * Builds the SVar reference graph for a card. SVar-referenced abilities are
 * never inlined: definitions are nodes and references are edges, so branches,
 * sharing, duplicates, unresolved names and cycles are all representable.
 */
export function buildForgeReferenceGraph(
	card: ForgeCardAst,
): ForgeReferenceGraph {
	return buildGraph(card.faces, []);
}

function buildGraph(
	faces: ForgeFaceAst[],
	diagnostics: ForgeDiagnostic[],
): ForgeReferenceGraph {
	const nodes: ForgeReferenceNode[] = [];
	const edges: ForgeReferenceEdge[] = [];

	for (const face of faces) {
		const baseScope = scopeFor(face);

		// Pre-pass: some parameters CREATE an SVar while the ability resolves
		// (RollDice's ResultSVar$, StoreSVar's SVar$). Those names have no
		// definition line, so give each one a synthetic node that later reads can
		// resolve against. Writes are collected before any read is linked.
		const runtimeWrites: {
			holderId: string;
			paramId: string;
			name: string;
			nodeId: string;
			line: number;
		}[] = [];
		const noteWrites = (
			holderId: string,
			record: ForgeClassifiedRecord,
			line: number,
		): void => {
			if (record.kind !== "ability") return;
			for (const entry of record.params.entries) {
				const spec = lookupForgeRuntimeWrite(entry.key, record.effectName);
				if (spec === undefined || entry.value === "") continue;
				const nodeId = `runtime:${face.id}/${entry.value.toLowerCase()}`;
				runtimeWrites.push({
					holderId,
					paramId: entry.id,
					name: entry.value,
					nodeId,
					line,
				});
			}
		};
		for (const record of recordsOf(face)) {
			noteWrites(record.id, record, record.source.line);
		}
		for (const svar of face.svars) {
			if (svar.classified !== undefined) {
				noteWrites(svar.id, svar.classified, svar.source.line);
			}
		}
		for (const variant of face.variants) {
			if (variant.classified !== undefined) {
				noteWrites(
					variant.classified.id,
					variant.classified,
					variant.source.line,
				);
			}
			if (variant.svar?.classified !== undefined) {
				noteWrites(
					variant.svar.id,
					variant.svar.classified,
					variant.svar.source.line,
				);
			}
		}

		// A synthetic node is only needed when the name has no `SVar:` line. Many
		// cards declare a placeholder (`SVar:X:0`) and then overwrite it at
		// runtime; that is one variable, so the write points at the declared node
		// rather than competing with it.
		for (const write of runtimeWrites) {
			const key = write.name.toLowerCase();
			const declared = baseScope.lookup.get(key);
			const target =
				declared !== undefined && declared.length > 0
					? (declared[declared.length - 1] as string)
					: write.nodeId;

			if (target === write.nodeId) {
				if (!nodes.some((n) => n.id === write.nodeId)) {
					nodes.push({
						id: write.nodeId,
						kind: "runtime-value",
						faceId: face.id,
						name: write.name,
						sourceNodeId: write.nodeId,
					});
				}
				baseScope.lookup.set(key, [write.nodeId]);
			}

			edges.push({
				from: write.holderId,
				paramId: write.paramId,
				role: "writes",
				rawReference: write.name,
				to: target,
				status: "resolved",
				provenance: "runtime-write",
				candidates: [target],
			});
		}

		nodes.push({
			id: face.id,
			kind: "face",
			faceId: face.id,
			name: face.state,
			sourceNodeId: face.sourceNodeIds[0] ?? face.id,
		});

		// CopyFaceFrom names another card entirely; it can never be resolved from
		// a single script and is reported as an external reference.
		const copyFrom = face.characteristics.copyFaceFrom;
		if (copyFrom !== undefined) {
			edges.push({
				from: face.id,
				paramId: copyFrom.nodeId,
				role: "copy-face-from",
				rawReference: copyFrom.value,
				provenance: "face",
				status: "external",
				candidates: [],
			});
			diagnostics.push({
				severity: "info",
				stage: "reference",
				code: "EXTERNAL_FACE_REFERENCE",
				message: `Face ${face.state} copies from external card face "${copyFrom.value}"; not resolved.`,
				line: copyFrom.line,
				nodeId: copyFrom.nodeId,
			});
		}

		const link = (
			holderId: string,
			paramId: string,
			role: string,
			rawRef: string,
			scope: FaceScope,
			line: number,
			optional: boolean,
			provenance: ForgeReferenceProvenance,
			label?: string,
		): void => {
			const candidates = scope.lookup.get(rawRef.toLowerCase()) ?? [];
			// An optional reference matching no SVar is a literal or an amount
			// expression, not a dangling name. Emit nothing at all.
			if (optional && candidates.length === 0) return;
			const edge: ForgeReferenceEdge = {
				from: holderId,
				paramId,
				role,
				rawReference: rawRef,
				provenance,
				status:
					candidates.length === 0
						? "unresolved"
						: candidates.length === 1
							? "resolved"
							: "ambiguous",
				candidates,
			};
			// Forge's SVar map is last-write-wins, so the final definition is the
			// one it would actually use.
			const chosen = candidates[candidates.length - 1];
			if (chosen !== undefined) edge.to = chosen;
			if (label !== undefined) edge.label = label;
			edges.push(edge);

			if (candidates.length === 0) {
				diagnostics.push({
					severity: "warning",
					stage: "reference",
					code: "UNRESOLVED_SVAR_REFERENCE",
					message: `${role} reference "${rawRef}" does not name an SVar on face ${scope.face.state}.`,
					line,
					paramId,
				});
			} else if (candidates.length > 1) {
				diagnostics.push({
					severity: "warning",
					stage: "reference",
					code: "AMBIGUOUS_SVAR_REFERENCE",
					message: `${role} reference "${rawRef}" matches ${candidates.length} SVar definitions on face ${scope.face.state}.`,
					line,
					paramId,
				});
			}
		};

		const emit = (
			holderId: string,
			params: ForgeParamList,
			scope: FaceScope,
			context: ForgeAmountContext,
			line: number,
		): void => {
			const api = context.api;
			for (const entry of params.entries) {
				const spec = lookupForgeReferenceParam(entry.key);
				if (spec === undefined) {
					// Not a wiring parameter. It may still be an amount parameter
					// this API resolves through calculateAmount.
					const amount = lookupForgeAmountParam(entry.key, context);
					if (amount === undefined || entry.value === "") continue;
					link(
						holderId,
						entry.id,
						"amount",
						entry.value,
						scope,
						line,
						// A literal or expression is equally valid here, so a miss is
						// not a dangling name.
						true,
						"amount",
					);
					continue;
				}
				if (!forgeReferenceParamApplies(spec, api)) continue;
				for (const target of expandReference(spec, entry.value)) {
					link(
						holderId,
						entry.id,
						spec.role,
						target.raw,
						scope,
						line,
						spec.optional === true,
						spec.optional === true
							? "condition"
							: spec.form === "amp-list"
								? "continuous-effect"
								: "ability-factory",
						target.label,
					);
				}
			}
		};

		for (const record of recordsOf(face)) {
			nodes.push({
				id: record.id,
				kind: record.kind,
				faceId: face.id,
				sourceNodeId: record.source.nodeId,
			});
			emit(
				record.id,
				record.params,
				baseScope,
				contextOf(record),
				record.source.line,
			);
		}

		// Structured keywords reference SVars by segment position, e.g.
		// `K:ETBReplacement:Other:DBPrepare`. Only keywords with a known form
		// become graph nodes; a plain `K:Flying` has nothing to point at.
		for (const keyword of face.keywordRecords) {
			const spec = lookupForgeKeywordSpec(keyword.keyword);
			if (spec === undefined) continue;
			nodes.push({
				id: keyword.id,
				kind: "keyword",
				faceId: face.id,
				name: keyword.keyword,
				sourceNodeId: keyword.source.nodeId,
			});
			for (const ref of spec.refs) {
				const segment = keyword.segments[ref.segment];
				if (segment === undefined) continue;
				const parts =
					ref.form === "comma-list"
						? segment.split(",").map((part) => part.trim())
						: [segment.trim()];
				for (const part of parts) {
					if (part === "") continue;
					link(
						keyword.id,
						`${keyword.id}/segment:${ref.segment}`,
						ref.role,
						part,
						baseScope,
						keyword.source.line,
						ref.optional === true,
						"keyword",
					);
				}
			}
			if (keyword.params !== undefined) {
				emit(
					keyword.id,
					keyword.params,
					baseScope,
					{ isAbility: false },
					keyword.source.line,
				);
			}
		}

		for (const svar of face.svars) {
			nodes.push({
				id: svar.id,
				kind: "svar",
				faceId: face.id,
				name: svar.name,
				sourceNodeId: svar.source.nodeId,
			});
			if (svar.parsed.kind === "params") {
				emit(
					svar.id,
					svar.parsed.params,
					baseScope,
					contextOf(svar.classified),
					svar.source.line,
				);
			} else {
				// Scalar values are not tokenized into parameters, but two narrow
				// forms name SVars outright. Both are located by shape, never
				// evaluated; the raw value stays authoritative.
				for (const ref of parseForgeScalarSVarExpression(svar.parsed.value)) {
					link(
						svar.id,
						`${svar.id}/expr:${ref.position}`,
						`scalar-${ref.position}`,
						ref.name,
						baseScope,
						svar.source.line,
						true,
						"scalar-expression",
					);
				}
				for (const ref of parseForgeCountExpression(svar.parsed.value)) {
					link(
						svar.id,
						`${svar.id}/count:${ref.position}`,
						`count-${ref.position}`,
						ref.name,
						baseScope,
						svar.source.line,
						true,
						"count-expression",
					);
				}
			}
		}

		// Variant patches resolve against the base face overlaid with the SVars
		// contributed by that same variant name.
		const variantScopes = new Map<string, FaceScope>();
		for (const variant of face.variants) {
			let scope = variantScopes.get(variant.name);
			if (scope === undefined) {
				scope = { face, lookup: new Map(baseScope.lookup) };
				variantScopes.set(variant.name, scope);
			}
			const svar = variant.svar;
			if (svar !== undefined) {
				const key = svar.name.toLowerCase();
				scope.lookup.set(key, [...(scope.lookup.get(key) ?? []), svar.id]);
			}
		}
		for (const variant of face.variants) {
			const scope = variantScopes.get(variant.name) ?? baseScope;
			const svar = variant.svar;
			if (svar !== undefined) {
				nodes.push({
					id: svar.id,
					kind: "svar",
					faceId: face.id,
					name: svar.name,
					variant: variant.name,
					sourceNodeId: variant.source.nodeId,
				});
				if (svar.parsed.kind === "params") {
					emit(
						svar.id,
						svar.parsed.params,
						scope,
						contextOf(svar.classified),
						svar.source.line,
					);
				}
			}
			const classified = variant.classified;
			if (classified !== undefined) {
				nodes.push({
					id: classified.id,
					kind: classified.kind,
					faceId: face.id,
					variant: variant.name,
					sourceNodeId: variant.source.nodeId,
				});
				emit(
					classified.id,
					classified.params,
					scope,
					contextOf(classified),
					variant.source.line,
				);
			}
		}
	}

	const cycles = findCycles(nodes, edges);
	for (const cycle of cycles) {
		diagnostics.push({
			severity: "warning",
			stage: "reference",
			code: "CYCLIC_SVAR_REFERENCE",
			message: `Cyclic SVar reference: ${cycle.join(" -> ")} -> ${cycle[0]}`,
			nodeId: cycle[0],
		});
	}

	return { nodes, edges, cycles };
}

/**
 * Iterative Tarjan-style cycle detection. Cycles are legal input here: they are
 * reported and returned, never thrown and never recursed into.
 */
function findCycles(
	nodes: ForgeReferenceNode[],
	edges: ForgeReferenceEdge[],
): string[][] {
	const adjacency = new Map<string, string[]>();
	for (const node of nodes) adjacency.set(node.id, []);
	for (const edge of edges) {
		if (edge.to === undefined) continue;
		const bucket = adjacency.get(edge.from);
		if (bucket !== undefined && !bucket.includes(edge.to)) bucket.push(edge.to);
	}

	const index = new Map<string, number>();
	const low = new Map<string, number>();
	const onStack = new Set<string>();
	const stack: string[] = [];
	const selfLoops = new Set<string>();
	const cycles: string[][] = [];
	let counter = 0;

	for (const edge of edges) {
		if (edge.to !== undefined && edge.to === edge.from)
			selfLoops.add(edge.from);
	}

	for (const root of adjacency.keys()) {
		if (index.has(root)) continue;
		// Explicit work stack; deep SubAbility chains must not blow the JS stack.
		const work: { id: string; next: number }[] = [{ id: root, next: 0 }];
		index.set(root, counter);
		low.set(root, counter);
		counter += 1;
		stack.push(root);
		onStack.add(root);

		while (work.length > 0) {
			const frame = work[work.length - 1] as { id: string; next: number };
			const neighbours = adjacency.get(frame.id) ?? [];
			if (frame.next < neighbours.length) {
				const next = neighbours[frame.next] as string;
				frame.next += 1;
				if (!index.has(next)) {
					index.set(next, counter);
					low.set(next, counter);
					counter += 1;
					stack.push(next);
					onStack.add(next);
					work.push({ id: next, next: 0 });
				} else if (onStack.has(next)) {
					low.set(
						frame.id,
						Math.min(low.get(frame.id) ?? 0, index.get(next) ?? 0),
					);
				}
				continue;
			}

			work.pop();
			const parent = work[work.length - 1];
			if (parent !== undefined) {
				low.set(
					parent.id,
					Math.min(low.get(parent.id) ?? 0, low.get(frame.id) ?? 0),
				);
			}
			if (low.get(frame.id) === index.get(frame.id)) {
				const component: string[] = [];
				for (;;) {
					const popped = stack.pop();
					if (popped === undefined) break;
					onStack.delete(popped);
					component.push(popped);
					if (popped === frame.id) break;
				}
				if (component.length > 1 || selfLoops.has(frame.id)) {
					cycles.push(component.reverse());
				}
			}
		}
	}

	return cycles;
}

/* ------------------------------------------------------------------------- */
/* Public entry points                                                        */
/* ------------------------------------------------------------------------- */

function buildCardInternal(
	document: ForgeScriptDocument,
	diagnostics: ForgeDiagnostic[],
): ForgeCardAst {
	const { faces, cardDirectives } = buildFaces(document, diagnostics);
	const graph = buildGraph(faces, diagnostics);
	return {
		schema: "forge-card-ast",
		schemaVersion: 1,
		document,
		cardDirectives,
		faces,
		graph,
		diagnostics,
	};
}

/**
 * Derives the semantic AST from an already-scanned document. Source-stage
 * diagnostics are not reproduced here because scanning already happened; use
 * {@link parseForgeCardScript} to get both stages in one array.
 */
export function buildForgeCardAst(document: ForgeScriptDocument): ForgeCardAst {
	return buildCardInternal(document, []);
}

/**
 * Parses a Forge card script into both representations.
 *
 * Malformed or unknown card input never throws and never produces an
 * `ok: false` branch; it produces a document plus diagnostics.
 */
export function parseForgeCardScript(source: string): ForgeParseResult {
	const diagnostics: ForgeDiagnostic[] = [];
	const document = scanForgeSource(source, diagnostics);
	const card = buildCardInternal(document, diagnostics);
	return { document, card, diagnostics };
}

/* ------------------------------------------------------------------------- */
/* Convenience helpers (derived; source records stay authoritative)           */
/* ------------------------------------------------------------------------- */

/** The face Forge would fill first, i.e. slot 0. */
export function primaryForgeFace(card: ForgeCardAst): ForgeFaceAst | undefined {
	return card.faces.find((face) => face.slot === 0);
}

/** Card-level `AlternateMode:` value, if the script declares one. */
export function forgeAlternateMode(
	card: ForgeCardAst,
): ForgeAlternateMode | undefined {
	let mode: string | undefined;
	for (const directive of card.cardDirectives) {
		if (directive.key.trim() === "AlternateMode") mode = directive.value;
	}
	return mode;
}

/**
 * Case-insensitive SVar lookup within a face, matching
 * `CardFace.addSVar`'s `TreeMap(String.CASE_INSENSITIVE_ORDER)`. Returns the
 * last definition, as Forge would, while `face.svarIndex` keeps them all.
 *
 * Note: the *runtime* `CardState.sVars` map is a plain case-SENSITIVE TreeMap.
 * The script layer modelled here follows `CardFace`.
 */
export function lookupForgeSVar(
	face: ForgeFaceAst,
	name: string,
): ForgeSVarRecord | undefined {
	const bucket = face.svarIndex[name.trim().toLowerCase()];
	return bucket === undefined ? undefined : bucket[bucket.length - 1];
}

/**
 * A place where this module can see that something references an SVar but does
 * not draw a graph edge for it. Reporting these is how the graph's known limits
 * stay measurable instead of anecdotal.
 */
export type ForgeUnmodeledReferenceKind = "parameter" | "scalar-expression";

export interface ForgeUnmodeledReference {
	kind: ForgeUnmodeledReferenceKind;
	faceId: string;
	/** The record or SVar whose text contains the reference. */
	holderId: string;
	/** Param id for `parameter`, SVar node id for `scalar-expression`. */
	locationId: string;
	/** Parameter key, or `"SVar$"` for a scalar expression. */
	key: string;
	/** The referencing text, verbatim. */
	value: string;
	/** The SVar name being referenced. */
	name: string;
	/** Node ids of the SVar definitions this name matches. */
	candidates: string[];
}

/**
 * Parameter keys verified NOT to name an SVar, so a value colliding with an SVar
 * name is a false positive rather than an unmodelled reference. Each was read
 * from the Java that consumes it.
 */
const NON_REFERENCE_KEYS: ReadonlySet<string> = new Set([
	"destination", // ZoneType.listValueOf
	"origin", // ZoneType.listValueOf
	"spelldescription", // display text
	"stackdescription", // display text
	"description", // display text
	"triggerdescription", // display text
	"notecardsfor", // Player.addNoteForName, an arbitrary label
	"clearnotedcardsfor", // same
	"rememberobjects", // AbilityUtils defined-object selector
	"ailogic", // AI strategy name
	"countertype", // CounterType.getType
	"tokenscript", // token script file name
	"validtgts", // selector string
	"validcard", // selector string
	"cost", // AbilityFactory.parseAbilityCost -> new Cost(...), a cost string
]);

/** Keys that select a record type rather than reference an SVar. */
const DISCRIMINATOR_KEYS: ReadonlySet<string> = new Set([
	"ab",
	"sp",
	"st",
	"db",
	"mode",
	"event",
]);

/** `SVar$Name` inside a scalar value, e.g. `SVar:Y:SVar$X/Plus.1`. */
const SCALAR_SVAR_REFERENCE = /(?:^|[^A-Za-z0-9_])SVar\$([A-Za-z0-9_]+)/g;

/**
 * Finds references this module can *detect* but deliberately does not model as
 * graph edges. Two kinds:
 *
 *   - `parameter`: a parameter outside {@link FORGE_REFERENCE_PARAMS} whose
 *     value exactly names an SVar on the same face. Forge resolves most amount
 *     parameters through `AbilityUtils.calculateAmount`, so `NumDmg$ X` reads
 *     SVar `X` exactly the way the modelled `CheckSVar$ X` does. There is no
 *     list of amount parameters in Forge - each effect's Java decides - so
 *     modelling them faithfully means walking every effect class, and modelling
 *     them by name-match alone would be a heuristic rather than a lookup.
 *
 *   - `scalar-expression`: a scalar SVar value containing `SVar$<name>`, e.g.
 *     `SVar:Y:SVar$X/Plus.1`. Scalar values are never tokenized into
 *     parameters, so there is no parameter entry to hang an edge on.
 *
 * This detection is a name match, NOT semantic proof: a parameter whose literal
 * value happens to collide with an SVar name is reported too. It exists to keep
 * the graph's coverage honest and measurable, not to be silently promoted into
 * edges.
 *
 * Not detectable here at all, and therefore not counted: SVar names embedded in
 * `Count$` mini-expressions (`Count$Compare Y GE1.2.1`), and runtime write
 * targets such as `ResultSVar$ Result`, whose SVar has no definition line to
 * match against.
 */
export function findUnmodeledReferenceCandidates(
	card: ForgeCardAst,
): ForgeUnmodeledReference[] {
	const found: ForgeUnmodeledReference[] = [];

	for (const face of card.faces) {
		const scope = scopeFor(face);

		const scanParams = (
			holderId: string,
			params: ForgeParamList,
			context: ForgeAmountContext,
		): void => {
			for (const entry of params.entries) {
				const key = entry.key.toLowerCase();
				if (key === "" || DISCRIMINATOR_KEYS.has(key)) continue;
				if (NON_REFERENCE_KEYS.has(key)) continue;
				if (lookupForgeReferenceParam(entry.key) !== undefined) continue;
				// Now modelled: verified amount parameters and runtime writes.
				if (lookupForgeAmountParam(entry.key, context) !== undefined) continue;
				if (lookupForgeRuntimeWrite(entry.key, context.api) !== undefined)
					continue;
				const candidates = scope.lookup.get(entry.value.toLowerCase());
				if (candidates === undefined || candidates.length === 0) continue;
				found.push({
					kind: "parameter",
					faceId: face.id,
					holderId,
					locationId: entry.id,
					key: entry.key,
					value: entry.value,
					name: entry.value,
					candidates: [...candidates],
				});
			}
		};

		for (const record of recordsOf(face)) {
			scanParams(record.id, record.params, contextOf(record));
		}
		for (const keyword of face.keywordRecords) {
			if (keyword.params !== undefined) {
				scanParams(keyword.id, keyword.params, { isAbility: false });
			}
		}
		for (const svar of face.svars) {
			if (svar.parsed.kind === "params") {
				scanParams(svar.id, svar.parsed.params, contextOf(svar.classified));
				continue;
			}
			// Names the scalar and Count grammars already reach are modelled.
			const modeled = new Set(
				[
					...parseForgeScalarSVarExpression(svar.parsed.value),
					...parseForgeCountExpression(svar.parsed.value),
				].map((r) => r.name.toLowerCase()),
			);
			SCALAR_SVAR_REFERENCE.lastIndex = 0;
			for (;;) {
				const match = SCALAR_SVAR_REFERENCE.exec(svar.parsed.value);
				if (match === null) break;
				const name = match[1] ?? "";
				if (modeled.has(name.toLowerCase())) continue;
				const candidates = scope.lookup.get(name.toLowerCase());
				if (candidates === undefined || candidates.length === 0) continue;
				found.push({
					kind: "scalar-expression",
					faceId: face.id,
					holderId: svar.id,
					locationId: svar.id,
					key: "SVar$",
					value: svar.parsed.value,
					name,
					candidates: [...candidates],
				});
			}
		}
	}

	return found;
}

/** Aggregate diagnostics by code; handy for corpus reporting. */
export function countForgeDiagnostics(
	diagnostics: readonly ForgeDiagnostic[],
): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const diagnostic of diagnostics) {
		const code = String(diagnostic.code);
		counts[code] = (counts[code] ?? 0) + 1;
	}
	return counts;
}
