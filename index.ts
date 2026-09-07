import {
	type AgentPair,
	type AnyChoiceController,
	asChoiceController,
	ChoiceController,
	ChoicePendingError,
	type ChoiceSource,
	type ChoiceTranscript,
} from "./choices.ts";
import * as EFFECTS from "./effects";
import { includes } from "./lib/array.ts";

export {
	type Agent,
	type AgentPair,
	type ChoiceAnswer,
	ChoiceController,
	ChoicePendingError,
	ChoiceReplayMismatchError,
	type ChoiceRequest,
	type ChoiceSource,
	type ChoiceTranscript,
	InvalidChoiceAnswerError,
	type RecordedChoice,
	type SyncAgent,
	type SyncAgentPair,
} from "./choices.ts";

import { assert, assertDefined, assertNever } from "./lib/assert";

/** helper type to prevent accidentally assigning one type of ID to another */
declare const BRAND: unique symbol;
type Brand<T, K extends string> = T & { readonly [BRAND]: K };

/* ------------------------------------------------------------------ *
 * Game Concepts
 * ------------------------------------------------------------------ */

/** we only support two player games. */
export type PlayerId = 0 | 1;

/** no command zone or sideboard yet. */

const ALL_ZONES = [
	"library",
	"hand",
	"battlefield",
	"graveyard",
	"exile",
	"stack",
] as const;

export type Zone = (typeof ALL_ZONES)[number];

export type Color = "w" | "u" | "b" | "r" | "g";

const COLORS: readonly Color[] = ["w", "u", "b", "r", "g"];

/** A kind of mana that can exist in a player's pool. */
export type ManaType = Color | "c";

const MANA_TYPES: readonly ManaType[] = [...COLORS, "c"];

/** Mana currently available to a player, including colorless mana. */
export type ManaPool = Record<ManaType, number>;

/** A quantity of one or more kinds of mana. Missing kinds mean zero. */
type ManaAmount = Partial<ManaPool>;

export type Supertype = "legendary" | "basic" | "snow";

/**
 * CR 110.4a: the permanent card types. A resolving spell of one of these
 * becomes a permanent; anything else finishes resolving and is put into its
 * owner's graveyard.
 */
const PERMANENT_CARD_TYPES = [
	"artifact",
	"creature",
	"enchantment",
	"land",
	"planeswalker",
] as const;

const SPELL_CARD_TYPES = ["instant", "sorcery"] as const;

export type CardType =
	| (typeof PERMANENT_CARD_TYPES)[number]
	| (typeof SPELL_CARD_TYPES)[number];

/* ------------------------------------------------------------------ *
 * Turns
 * ------------------------------------------------------------------ */
export type TurnId = Brand<number, "TurnId">;
export type PhaseId = Brand<number, "PhaseId">;
export type StepId = Brand<number, "StepId">;

type PhaseKind = "beginning" | "main" | "combat" | "ending";
export type MainPhaseRole = "precombat" | "postcombat";
export type StepKind =
	| "untap"
	| "upkeep"
	| "draw"
	| "begin combat"
	| "declare attackers"
	| "declare blockers"
	| "combat damage"
	| "end combat"
	| "end"
	| "cleanup";

interface PhaseOccurrence {
	id: PhaseId;
	turnId: TurnId;
	kind: PhaseKind;
}

interface StepOccurrence {
	id: StepId;
	turnId: TurnId;
	phaseId: PhaseId;
	kind: StepKind;
}

const PRE_GAME_STEPS = [
	"shuffle",
	"opening hand",
	"mulligan",
	"opening hand actions",
] as const;

type PreGameStepKind = (typeof PRE_GAME_STEPS)[number];

interface TurnOccurrence {
	id: TurnId;
	player: PlayerId;
	isExtra: boolean;
	mainPhasesBegun: number;
	remainingPhases: PhaseOccurrence[];
}

export type TurnLocation =
	| {
			kind: "mainPhase";
			phase: PhaseOccurrence;
			role: MainPhaseRole;
	  }
	| {
			kind: "step";
			phase: PhaseOccurrence;
			step: StepOccurrence;
	  };

export type GameProgress =
	| { kind: "notStarted" }
	| { kind: "pregame"; step: PreGameStepKind }
	| {
			kind: "inTurn";
			turn: TurnOccurrence;
			/**
			 * Null between the moment a turn begins and the moment its first
			 * phase begins: the turn is current, but no rules-defined location
			 * inside it is yet.
			 */
			location: TurnLocation | null;
	  };

type SchedulerCommand =
	| { kind: "advancePreGameStep" }
	| { kind: "finishPreGameStep" }
	| { kind: "advanceTurn" }
	| { kind: "advancePhase"; turn: TurnOccurrence }
	| {
			kind: "advanceStep";
			turn: TurnOccurrence;
			phase: PhaseOccurrence;
	  }
	| { kind: "finishStep" }
	| { kind: "finishPhase" };

interface TurnScheduler {
	/**
	 * what the turn scheduler should do next.
	 */
	nextAction: SchedulerCommand;
	/** The only externally observable turn locations. */
	progress: GameProgress;
	/** Only exceptional turns are queued. The front is taken next. */
	pendingTurns: TurnOccurrence[];
	/** Used to lazily create the next ordinary turn when the queue is empty. */
	nextRegularPlayer: PlayerId;
	remainingSteps: StepOccurrence[];
	// TODO: I think we could do some better type structuring vs jamming
	// this guy in at the end.
	remainingPregameSteps: PreGameStepKind[];
	nextId: number;
}

/** The current rules-defined turn location, or null before the game starts. */
export function turnLocation(state: ReadonlyGameState): TurnLocation | null {
	const progress = state.turnScheduler.progress;
	return progress.kind === "inTurn" ? progress.location : null;
}

/**
 * Whose turn it is, or null before the first turn of the game begins.
 * TODO: support pregame active player.
 */
export function activePlayer(state: ReadonlyGameState): PlayerId | null {
	const progress = state.turnScheduler.progress;
	return progress.kind === "inTurn" ? progress.turn.player : null;
}

export function isTurnStep(state: GameState, step: StepKind): boolean {
	const location = turnLocation(state);
	return location?.kind === "step" && location.step.kind === step;
}

function currentStepKind(state: ReadonlyGameState): StepKind | null {
	const location = turnLocation(state);
	return location?.kind === "step" ? location.step.kind : null;
}

function nextScheduleId(state: GameState): number {
	return state.turnScheduler.nextId++;
}

function makePhase(
	state: GameState,
	turnId: TurnId,
	kind: PhaseKind,
): PhaseOccurrence {
	return { id: nextScheduleId(state) as PhaseId, turnId, kind };
}

function makeTurn(
	state: GameState,
	player: PlayerId,
	isExtra: boolean,
): TurnOccurrence {
	const id = nextScheduleId(state) as TurnId;
	return {
		id,
		player,
		isExtra,
		mainPhasesBegun: 0,
		remainingPhases: [
			makePhase(state, id, "beginning"),
			makePhase(state, id, "main"),
			makePhase(state, id, "combat"),
			makePhase(state, id, "main"),
			makePhase(state, id, "ending"),
		],
	};
}

/** Exceptional turns are queued; ordinary turn order is generated lazily. */
function takeNextTurn(state: GameState): TurnOccurrence {
	const queued = state.turnScheduler.pendingTurns.shift();
	if (queued) return queued;

	const player = state.turnScheduler.nextRegularPlayer;
	state.turnScheduler.nextRegularPlayer = (1 - player) as PlayerId;
	return makeTurn(state, player, false);
}

function makeSteps(state: GameState, phase: PhaseOccurrence): StepOccurrence[] {
	let kinds: StepKind[];
	switch (phase.kind) {
		case "beginning":
			kinds = ["untap", "upkeep", "draw"];
			break;
		case "main":
			kinds = [];
			break;
		case "combat":
			kinds = [
				"begin combat",
				"declare attackers",
				"declare blockers",
				"combat damage",
				"end combat",
			];
			break;
		case "ending":
			kinds = ["end", "cleanup"];
			break;
		default:
			assertNever(phase.kind);
	}
	return kinds.map((kind) => ({
		id: nextScheduleId(state) as StepId,
		turnId: phase.turnId,
		phaseId: phase.id,
		kind,
	}));
}

/* ------------------------------------------------------------------ *
 * Game Objects
 * ------------------------------------------------------------------ */

export type ObjectId = Brand<number, "ObjectId">;
export type StackItemId = Brand<number, "StackItemId">;

export type CounterNames = "+1/+1" | "-1/-1" | "charge" | "poison";
export type CounterBag = Partial<Record<CounterNames, number>>;

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */
/**
 * Used for referencing entities in events.
 * TODO: this might be insufficient
 */
export type EntityRef =
	| { type: "player"; player: PlayerId }
	| { type: "permanent"; id: ObjectId };

interface EventCommon {
	/**
	 * Conditional execution ("if you do..."). The event only executes if this fact
	 * was recorded earlier in the same bundle.
	 */
	guard?: string;
	/**
	 * Inverse of `guard`: the event only executes if this fact was not recorded
	 * earlier in the same bundle.
	 */
	unless?: string;
	/**
	 * the id that matches to `guard` / `unless`.
	 * TODO: can we use a generic event id here or something
	 */
	fact?: string;
}

interface DeclareAttackersEvent extends EventCommon {
	kind: "declare attackers";
	player: PlayerId;
	/**
	 * The opponent is implicit: this is deliberately a two-player-only engine.
	 *
	 * TODO: support attacking planeswalkers
	 */
	attackers: ObjectId[];
}

/**
 * One blocker-to-attacker assignment.
 */
export interface BlockAssignment {
	blocker: ObjectId;
	attacker: ObjectId;
}

interface DeclareBlockersEvent extends EventCommon {
	kind: "declare blockers";
	player: PlayerId;
	/** Each pair names one blocker and the attacker it blocks. Multiple
	 *  blockers may be assigned to the same attacker (multi-blocking); a single
	 *  blocker may not be assigned to multiple attackers. */
	blockers: BlockAssignment[];
}
interface DrawCardsEvent extends EventCommon {
	kind: "draw cards";
	player: PlayerId;
	amount: number;
}
interface DrawEvent extends EventCommon {
	kind: "draw";
	player: PlayerId;
}

interface MillEvent extends EventCommon {
	kind: "mill";
	player: PlayerId;
	amount: number;
}

interface DiscardEvent extends EventCommon {
	kind: "discard";
	player: PlayerId;
	cards:
		| {
				/** an instruction to discard to the player's max hand size. */
				kind: "hand-size";
		  }
		| {
				/**
				 * the player must discard the specified card.
				 * TODO: support card: ObjectId[]
				 */
				kind: "specific";
				card: ObjectId;
		  }
		| {
				/**
				 * the player can choose any card to discard.
				 * TODO: support discarding multiple cards
				 */
				kind: "any";
		  };
}

interface DamageEvent extends EventCommon {
	kind: "damage";
	source: ObjectId;
	sourceController: PlayerId;
	sourceColors: Color[];
	target: EntityRef;
	amount: number;
	combat: boolean;
	deathtouch: boolean;
	lifelink: boolean;
	/**
	 * CR 615.12
	 * "can't be prevented" skips prevention effects but not other replacements.
	 */
	unpreventable: boolean;
}

/**
 * 701.8a. To destroy a permanent, move it from the battlefield to its owner's graveyard.
 *
 * 701.8b. The only ways a permanent can be destroyed are as a result of an
 * effect that uses the word "destroy" or as a result of the state-based actions
 * that check for lethal damage (see rule 704.5g) or damage from a source with
 * deathtouch (see rule 704.5h). If a permanent is put into its owner's
 * graveyard for any other reason, it hasn't been "destroyed."
 *
 * The child zone-change event carries `cause: "destroy"`. The parent destroy
 * succeeds only when that exact battlefield-to-graveyard movement executes
 * after replacements.
 */
interface DestroyEvent extends EventCommon {
	kind: "destroy";
	object: ObjectId;
	noRegen: boolean;
	source?: ObjectId;
}

/** The compound "instead" half of a regeneration shield (CR 701.19). */
interface RegenerateEvent extends EventCommon {
	kind: "regenerate";
	object: ObjectId;
}

interface ZoneChangeEvent extends EventCommon {
	/** Choices installed atomically when this movement creates a spell. */
	spellTargets?: TargetBindings;
	kind: "change zone";
	object: ObjectId;
	from: Zone;
	to: Zone;
	cause: MoveCause;
	/** Who it will be controlled by if `to === 'battlefield'`. Drives CR 616.1's chooser. */
	toController: PlayerId;
	// --- fields only meaningful when entering the battlefield (CR 614.1c-d) ---
	entersTapped?: boolean;
	entersWithCounters?: CounterBag;
	/**
	 * Serializable copiable-values override set by copy-tier replacements
	 * (CR 616.1c). It carries the copied object's ability *references*, which is
	 * all the rest of the event needs: nothing has to look up "which card was
	 * this a copy of" to find the copied abilities' implementations.
	 */
	copiableOverride?: CharacteristicsSnapshot;
	toBottom?: boolean;
}

type MoveCause =
	| "cast"
	| "draw"
	| "play land"
	| "discard"
	| "mill"
	| "destroy"
	| "sacrifice"
	| "sba"
	| "cast"
	| "illegal target"
	| "resolve"
	| "effect"
	| "return"
	| "put";

interface AddCountersEvent extends EventCommon {
	kind: "add counters";
	target: EntityRef;
	counter: CounterNames;
	amount: number;
	source?: ObjectId;
}

interface RemoveCountersEvent extends EventCommon {
	kind: "remove counters";
	target: EntityRef;
	counters: "all" | Partial<Record<CounterNames, number | "all">>;
	source?: ObjectId;
}

interface GainLifeEvent extends EventCommon {
	kind: "gain life";
	player: PlayerId;
	amount: number;
	source?: ObjectId;
}
interface LoseLifeEvent extends EventCommon {
	kind: "lose life";
	player: PlayerId;
	amount: number;
	source?: ObjectId;
}

interface AddManaEvent extends EventCommon {
	kind: "add mana";
	player: PlayerId;
	source: ObjectId;
	mana: ManaAmount;
}

interface TapEvent extends EventCommon {
	kind: "tap" | "untap";
	ref:
		| {
				kind: "object";
				object: ObjectId;
		  }
		| {
				kind: "all";
				player: PlayerId;
		  };
}

interface BeginTurnEvent extends EventCommon {
	kind: "begin turn";
	turnId: TurnId;
	player: PlayerId;
	isExtra: boolean;
}

interface BeginPhaseEvent extends EventCommon {
	kind: "begin phase";
	turnId: TurnId;
	phaseId: PhaseId;
	player: PlayerId;
	phase: PhaseKind;
	mainRole?: MainPhaseRole;
}

interface BeginStepEvent extends EventCommon {
	kind: "begin step";
	turnId: TurnId;
	phaseId: PhaseId;
	stepId: StepId;
	player: PlayerId;
	step: StepKind;
}

interface CreateTokenEvent extends EventCommon {
	kind: "create token";
	controller: PlayerId;
	/** Registry definition used to construct the token's characteristic snapshot. */
	tokenDefinitionId: string;
	amount: number;
}

interface LoseGameEvent extends EventCommon {
	kind: "lose game";
	player: PlayerId;
	reason: string;
}

interface WinGameEvent extends EventCommon {
	kind: "win game";
	player: PlayerId;
	reason: string;
}

export type GameEvent =
	| DeclareAttackersEvent
	| DeclareBlockersEvent
	| DrawCardsEvent
	| DrawEvent
	| MillEvent
	| DiscardEvent
	| DamageEvent
	| DestroyEvent
	| RegenerateEvent
	| ZoneChangeEvent
	| AddCountersEvent
	| RemoveCountersEvent
	| GainLifeEvent
	| LoseLifeEvent
	| AddManaEvent
	| TapEvent
	| BeginTurnEvent
	| BeginStepEvent
	| CreateTokenEvent
	| LoseGameEvent
	| WinGameEvent
	| BeginPhaseEvent;

/* ------------------------------------------------------------------ *
 * Game state
 * ------------------------------------------------------------------ */
/**
 * The kinds of abilities a card can carry.
 *
 * Each kind exists in two forms. The *definition* is the executable
 * implementation, owned by the card registry ({@link AbilityDefinitions}).
 * *Possession* is a separate, serializable `cardId:index` reference
 * ({@link AbilityReferences}). Splitting the two is what lets a card define an
 * ability it does not itself have — for instance a lord whose layer-6 effect
 * grants an activated ability to other creatures.
 */
export const ABILITY_CATEGORIES = [
	"static",
	"activated",
	"triggered",
	"replacement",
	"prohibition",
] as const;
export type AbilityCategory = (typeof ABILITY_CATEGORIES)[number];

/**
 * Serializable `cardId:index` registry reference to an ability of category `C`.
 *
 * The category is part of the brand, so a `AbilityId<"static">` is never
 * assignable to a `AbilityId<"activated">` even though both erase to `string`.
 */
export type AbilityId<C extends AbilityCategory> = Brand<
	string,
	`${C}AbilityId`
>;

export type StaticAbilityId = AbilityId<"static">;
export type ActivatedAbilityId = AbilityId<"activated">;
export type TriggeredAbilityId = AbilityId<"triggered">;
export type ReplacementAbilityId = AbilityId<"replacement">;
export type ProhibitionAbilityId = AbilityId<"prohibition">;

/**
 * The definition a given category resolves to. {@link AbilityDefinitions} is
 * the registry's category-keyed store, so its element types are exactly the
 * return types {@link getAbilityDefinition} owes each category.
 */
type AbilityDef<C extends AbilityCategory> = AbilityDefinitions[C][number];

export function abilityId<C extends AbilityCategory>(
	category: C,
	cardId: string,
	index: number,
): AbilityId<C> {
	assert(
		Number.isSafeInteger(index) && index >= 0,
		`invalid ${category} ability index`,
	);
	return `${cardId}:${index}` as AbilityId<C>;
}

export function getAbilityDefinition<C extends AbilityCategory>(
	category: C,
	id: AbilityId<C>,
): AbilityDef<C> {
	/**
	 * Card ids may themselves contain colons (`card:id:with:colons`), so the index
	 * is always the segment after the *last* colon.
	 */
	const separator = id.lastIndexOf(":");
	assert(separator > 0, `invalid ${category} ability id: ${id}`);
	const indexText = id.slice(separator + 1);
	assert(/^\d+$/.test(indexText), `invalid ${category} ability id: ${id}`);
	const cardId = id.slice(0, separator);
	const index = Number(indexText);

	const definitions: AbilityDef<C>[] =
		card(cardId).abilityDefinitions[category];
	const definition = definitions[index];
	assertDefined(definition, `unknown ${category} ability: ${id}`);
	return definition;
}

/**
 * What an object currently *has*. Purely references, so this survives
 * `structuredClone` and can be copied, granted, or removed without touching the
 * executable definitions behind it.
 */
export interface AbilityReferences {
	static: StaticAbilityId[];
	activated: ActivatedAbilityId[];
	triggered: TriggeredAbilityId[];
	replacement: ReplacementAbilityId[];
	prohibition: ProhibitionAbilityId[];
}

/**
 * A complete set of an object's characteristics (CR 109.3).
 *
 * Copiable characteristics and fully evaluated characteristics are different
 * stages of the layer pipeline, but they have the same shape. Runtime state
 * such as zone, controller, tapped status, damage, and counters lives on the
 * containing object snapshot rather than here.
 */
interface BaseCharacteristicsSnapshot {
	name: string;
	manaCost: CardDefManaCost;
	colors: Color[];
	supertypes: Supertype[];
	types: CardType[];
	subtypes: string[];
	keywords: Keyword[];
	/** Current possession, as registry references. Never executable definitions. */
	abilities: AbilityReferences;
}

interface CreatureCharacteristicsSnapshot extends BaseCharacteristicsSnapshot {
	kind: "creature";
	power: number;
	toughness: number;
}

interface NonCreatureCharacteristicsSnapshot
	extends BaseCharacteristicsSnapshot {
	kind: "non-creature";
}

export type CharacteristicsSnapshot =
	| NonCreatureCharacteristicsSnapshot
	| CreatureCharacteristicsSnapshot;

interface SnapshotBase {
	objectId: ObjectId;
	owner: PlayerId;
}

interface CardSnapshot extends SnapshotBase {
	kind: "card";
	zone: "library" | "hand" | "graveyard" | "exile";
	/** Stable printed identity; characteristics remain exclusively derived below. */
	cardId: string;

	copiableValues: CharacteristicsSnapshot;
	currentCharacteristics: CharacteristicsSnapshot;

	/**
	 * cards in these zones have no controller.
	 * owner is implicit based on whose zone we're in.
	 */
	controller: null;
}

interface SpellSnapshot extends SnapshotBase {
	targets: TargetBindings;
	kind: "spell";
	zone: "stack";
	controller: PlayerId;

	copiableValues: CharacteristicsSnapshot;
	currentCharacteristics: CharacteristicsSnapshot;

	representation:
		| {
				kind: "card";
				cardId: string;
		  }
		| {
				kind: "copy";
				copyEffect: CharacteristicsSnapshot;
		  };
}

interface PermanentSnapshot extends SnapshotBase {
	kind: "permanent";
	zone: "battlefield";
	controller: PlayerId;

	copiableValues: CharacteristicsSnapshot;
	currentCharacteristics: CharacteristicsSnapshot;

	representation:
		| {
				kind: "card";
				cardId: string;
		  }
		| {
				kind: "token";
		  };

	tapped: boolean;
	attacking: boolean;
	blocking: boolean;
	damage: number;
	counters: CounterBag;
	attributes: {
		deathtouched?: boolean;
	};
}

interface NonbattlefieldTokenSnapshot extends SnapshotBase {
	kind: "nonbattlefield-token";
	zone: "library" | "hand" | "graveyard" | "exile";
	controller: null;

	copiableValues: CharacteristicsSnapshot;
	currentCharacteristics: CharacteristicsSnapshot;
}

export type GameObjectSnapshot =
	| CardSnapshot
	| SpellSnapshot
	| PermanentSnapshot
	| NonbattlefieldTokenSnapshot;

/** A detached, serializable object exposed to one player. */
export type PlayerObjectView = DeepReadOnly<GameObjectSnapshot>;

type PlayerNonbattlefieldObjectView<
	ZoneName extends "hand" | "graveyard" | "exile",
> =
	| (DeepReadOnly<CardSnapshot> & { readonly zone: ZoneName })
	| (DeepReadOnly<NonbattlefieldTokenSnapshot> & { readonly zone: ZoneName });

export type PlayerHandObjectView = PlayerNonbattlefieldObjectView<"hand">;
export type PlayerGraveyardObjectView =
	PlayerNonbattlefieldObjectView<"graveyard">;
export type PlayerExileObjectView = PlayerNonbattlefieldObjectView<"exile">;
export type PlayerBattlefieldObjectView = DeepReadOnly<PermanentSnapshot>;

/** Stack entries are either spell snapshots or declarative ability items. */
export type PlayerStackView = DeepReadOnly<
	SpellSnapshot | TriggeredAbilityStackItem | ActivatedAbilityStackItem
>;

function cloneAbilityReferences(
	refs: DeepReadOnly<AbilityReferences>,
): AbilityReferences {
	return {
		static: [...refs.static],
		activated: [...refs.activated],
		triggered: [...refs.triggered],
		replacement: [...refs.replacement],
		prohibition: [...refs.prohibition],
	};
}

const PRINTED_CHARACTERISTICS = new WeakMap<CardDef, CharacteristicsSnapshot>();

/**
 * The card's printed characteristics, cached and *shared*. Callers must treat
 * the result as immutable; use {@link characteristicsFromCardDef} for a copy.
 */
function printedCharacteristics(
	def: CardDef,
): DeepReadOnly<CharacteristicsSnapshot> {
	const cached = PRINTED_CHARACTERISTICS.get(def);
	if (cached) return cached;
	const base = {
		name: def.name,
		manaCost: def.manaCost,
		colors: [...def.colors],
		supertypes: [...(def.supertypes ?? [])],
		types: [...def.types],
		subtypes: [...(def.subtypes ?? [])],
		keywords: [...(def.keywords ?? [])],
		abilities: cloneAbilityReferences(def.printedAbilities),
	};

	const values: CharacteristicsSnapshot = def.types.includes("creature")
		? {
				...base,
				kind: "creature",
				power: def.power ?? 0,
				toughness: def.toughness ?? 0,
			}
		: { ...base, kind: "non-creature" };
	PRINTED_CHARACTERISTICS.set(def, values);
	return values;
}

function characteristicsFromCardDef(def: CardDef): CharacteristicsSnapshot {
	return cloneCharacteristics(printedCharacteristics(def));
}

/**
 * An object's copiable-values source, without the defensive clone.
 *
 * Cheap enough to call in a prefilter over every object in the game, which is
 * why the collectors that only need to ask "does anything here possess an
 * ability of kind X?" read this rather than reaching for a card definition.
 * The result is shared: never mutate it.
 */
function baseCharacteristics(
	object: DeepReadOnly<GameObject>,
): DeepReadOnly<CharacteristicsSnapshot> {
	switch (object.kind) {
		case "card":
			return printedCharacteristics(card(object.cardId));

		case "spell":
			return object.representation.kind === "copy"
				? object.representation.copyEffect
				: printedCharacteristics(card(object.representation.cardId));

		case "permanent":
			if (object.copiableOverride) return object.copiableOverride;
			return object.representation.kind === "token"
				? object.representation.createdValues
				: printedCharacteristics(card(object.representation.cardId));

		case "nonbattlefield-token":
			return object.createdValues;

		default:
			return assertNever(object);
	}
}

function initialCharacteristics(
	object: DeepReadOnly<GameObject>,
): CharacteristicsSnapshot {
	return cloneCharacteristics(baseCharacteristics(object));
}

export function cloneCharacteristics(
	values: DeepReadOnly<CharacteristicsSnapshot>,
): CharacteristicsSnapshot {
	const base = {
		name: values.name,
		manaCost:
			typeof values.manaCost === "object"
				? { ...values.manaCost }
				: values.manaCost,
		colors: [...values.colors],
		supertypes: [...values.supertypes],
		types: [...values.types],
		subtypes: [...values.subtypes],
		keywords: [...values.keywords],
		abilities: cloneAbilityReferences(values.abilities),
	};
	return values.kind === "creature"
		? {
				...base,
				kind: "creature",
				power: values.power,
				toughness: values.toughness,
			}
		: { ...base, kind: "non-creature" };
}

export interface GameView {
	readonly objects: ReadonlyMap<ObjectId, GameObjectSnapshot>;
}

export interface PlayerPublicView {
	readonly id: PlayerId;
	readonly life: number;
	readonly counters: DeepReadOnly<CounterBag>;
	readonly manaPool: DeepReadOnly<ManaPool>;
	readonly handCount: number;
	readonly libraryCount: number;
	readonly graveyard: readonly PlayerGraveyardObjectView[];
	readonly exile: readonly PlayerExileObjectView[];
	readonly landsPlayed: number;
	readonly lost: boolean;
	readonly won: boolean;
}

/**
 * The complete JSON-safe game projection delivered to one agent.
 *
 * Hidden zones are deliberately asymmetric: `hand` contains only the
 * viewer's cards, while both libraries and the opponent's hand are counts.
 */
export interface PlayerView {
	readonly version: 1;
	readonly revision: number;
	readonly viewer: PlayerId;
	readonly turn: {
		readonly completedTurns: number;
		readonly activePlayer: PlayerId | null;
		readonly location: DeepReadOnly<TurnLocation> | null;
	};
	readonly players: readonly [PlayerPublicView, PlayerPublicView];
	readonly hand: readonly PlayerHandObjectView[];
	readonly battlefield: readonly PlayerBattlefieldObjectView[];
	readonly stack: readonly PlayerStackView[];
}

export interface ReadContext {
	readonly state: ReadonlyGameState;
	readonly revision: number;
	readonly view: GameView;
}

/**
 * Build all derived object information for one mutation-free rules window.
 * Callers must discard this view as soon as they mutate `state`.
 */
export function buildGameView(state: ReadonlyGameState): GameView {
	return buildFilteredGameView(state);
}

/**
 * CR 613.4: apply the P/T change from +1/+1 and -1/-1 counters. Part of layer
 * 7c, so `buildFilteredGameView` calls this from within the layer walk.
 */
function applyCounters(
	state: ReadonlyGameState,
	characteristics: Map<ObjectId, CharacteristicsSnapshot>,
): void {
	for (const object of state.objects.values()) {
		if (object.kind !== "permanent") continue;
		const current = characteristics.get(object.id);
		if (!current) continue;
		if (current.kind !== "creature") continue;
		const delta =
			(object.counters["+1/+1"] ?? 0) - (object.counters["-1/-1"] ?? 0);
		current.power += delta;
		current.toughness += delta;
	}
}

function buildFilteredGameView(
	state: ReadonlyGameState,
	included?: ReadonlySet<ObjectId>,
): GameView {
	const copiable = new Map<ObjectId, CharacteristicsSnapshot>();
	const characteristics = new Map<ObjectId, CharacteristicsSnapshot>();
	const abilities: Partial<
		Record<
			ContinuousEffectLayer,
			[effect: ContinuousEffect, source: DeepReadOnly<GameObject>][]
		>
	> = {};

	for (const object of state.objects.values()) {
		const initial = initialCharacteristics(object);
		if (!included || included.has(object.id)) {
			// `initial` is already a fresh clone, and layer 1a replaces rather than
			// mutates its map entry, so it can serve as the copiable values directly.
			copiable.set(object.id, initial);
			characteristics.set(object.id, cloneCharacteristics(initial));
		}

		for (const id of initial.abilities.static) {
			const ability = getAbilityDefinition("static", id);
			if (!functionsHere(ability.functionsFrom, object.zone)) continue;
			let layerAbilities = abilities[ability.layer];
			if (!layerAbilities) {
				layerAbilities = [];
				abilities[ability.layer] = layerAbilities;
			}
			layerAbilities.push([ability, object]);
		}
	}

	for (const layer of CONTINUOUS_EFFECT_LAYERS) {
		for (const [ability, source] of abilities[layer] ?? []) {
			const zones: readonly Zone[] =
				ability.affects === "any"
					? ALL_ZONES
					: (ability.affects ?? ["battlefield"]);

			for (const zone of zones) {
				for (const objectId of zoneList(state, zone, "any")) {
					if (!characteristics.has(objectId)) continue;
					const subject = state.objects.get(objectId);
					assertDefined(subject, "subject object not found");
					if (layer === "1a-copiable-values") {
						const current = copiable.get(objectId);
						assertDefined(current, "copiable values not found");
						if (
							!ability.applies(evaluationView(subject, current), state, source)
						)
							continue;
						const next = cloneCharacteristics(current);
						ability.modify(next, state, source);
						copiable.set(objectId, next);
						characteristics.set(objectId, cloneCharacteristics(next));
						continue;
					}

					const current = characteristics.get(objectId);
					assertDefined(current, "characteristics not found");
					if (!ability.applies(evaluationView(subject, current), state, source))
						continue;
					const next = cloneCharacteristics(current);
					ability.modify(next, state, source);
					characteristics.set(objectId, next);
				}
			}
		}

		// CR 613.4: +1/+1 and -1/-1 counters apply in layer 7c, so they are
		// scheduled by the layer list like everything else -- notably before the
		// 7d swap.
		if (layer === "7c-modify-power-toughness")
			applyCounters(state, characteristics);
	}

	const snapshots = new Map<ObjectId, GameObjectSnapshot>();
	for (const object of state.objects.values()) {
		const copy = copiable.get(object.id);
		const current = characteristics.get(object.id);
		if (!copy || !current) continue;

		switch (object.kind) {
			case "card":
				snapshots.set(object.id, {
					kind: "card",
					objectId: object.id,
					owner: object.owner,
					controller: null,
					zone: object.zone,
					cardId: object.cardId,
					copiableValues: copy,
					currentCharacteristics: current,
				});
				break;
			case "spell": {
				const entry = state.stack.find(
					(entry) => entry.kind === "spell" && entry.objectId === object.id,
				);
				assert(entry?.kind === "spell", "spell has no stack entry");
				snapshots.set(object.id, {
					targets: structuredClone(entry.targets) as TargetBindings,
					kind: "spell",
					objectId: object.id,
					owner: object.owner,
					controller: object.controller,
					zone: "stack",
					representation:
						object.representation.kind === "card"
							? { ...object.representation }
							: {
									kind: "copy",
									copyEffect: cloneCharacteristics(
										object.representation.copyEffect,
									),
								},
					copiableValues: copy,
					currentCharacteristics: current,
				});
				break;
			}
			case "permanent":
				snapshots.set(object.id, {
					kind: "permanent",
					objectId: object.id,
					owner: object.owner,
					controller: object.controller,
					zone: "battlefield",
					representation:
						object.representation.kind === "card"
							? { ...object.representation }
							: { kind: "token" },
					copiableValues: copy,
					currentCharacteristics: current,
					tapped: object.tapped,
					attacking: object.attacking,
					blocking: object.blocking,
					damage: object.damage,
					counters: { ...object.counters },
					attributes: { ...object.attributes },
				});
				break;
			case "nonbattlefield-token":
				snapshots.set(object.id, {
					kind: "nonbattlefield-token",
					objectId: object.id,
					owner: object.owner,
					controller: null,
					zone: object.zone,
					copiableValues: copy,
					currentCharacteristics: current,
				});
				break;
			default:
				assertNever(object);
		}
	}

	return { objects: snapshots };
}

/**
 * ------------------------------------------------
 *
 */

type EffectId = Brand<string, "EffectId">;

function eid(id: string): EffectId {
	return id as EffectId;
}

/**
 * What a resolving ability still needs to know about its own source once the
 * source may be gone (CR 113.7a, CR 608.2h). Only the fields the supported
 * effects actually read are kept; this is not general last known information.
 */
export interface SourceLastKnown {
	name: string;
	controller: PlayerId;
	colors: Color[];
	lifelink: boolean;
}

/**
 * A trigger that has triggered but has not yet been put on the stack. It has
 * no targets yet: those are chosen when it goes on the stack (CR 603.3d).
 */
export interface PendingTrigger {
	source: ObjectId;
	triggerId: TriggeredAbilityId;
	controller: PlayerId;
	text: string;
	/** Copied off the trigger definition, so a later text change cannot reach it. */
	targetDefinitions: TargetDef[];
	effects: EffectDef[];
	sourceLastKnown: SourceLastKnown | null;
}

interface PlayerState {
	id: PlayerId;
	life: number;
	library: ObjectId[];
	hand: ObjectId[];
	graveyard: ObjectId[];
	exile: ObjectId[];
	counters: CounterBag;
	/** Turn-scoped counters, e.g. cards drawn in the draw step (Chains of Mephistopheles). */
	drawnInDrawStep: number;
	/** Set when the player has attempted to draw from an empty library since the last SBA check (CR 704.5b). */
	drewFromEmptyLibrary: boolean;
	manaPool: ManaPool;
	landsPlayed: number;
	lost: boolean;
	won: boolean;
}

export interface PassAction {
	kind: "pass";
}
/** Casts one identified card from the caster's hand. */
export interface CastAction {
	kind: "cast";
	card: ObjectId;
}
/** Activates one currently possessed ability on a concrete source. */
export interface ActivateAbilityAction {
	kind: "activate ability";
	source: ObjectId;
	ability: ActivatedAbilityId;
}
/** The ordinary special action of playing one identified land from hand. */
export interface PlayLandAction {
	kind: "play land";
	card: ObjectId;
}
export type PriorityAction =
	| PassAction
	| CastAction
	| ActivateAbilityAction
	| PlayLandAction;

/**
 * An ability on the stack carries everything its resolution needs: the target
 * restrictions it was announced under, the targets chosen then, and its own
 * instructions. Nothing here is looked up again from the source object or the
 * card registry, because CR 113.7a lets the source leave in the meantime.
 */
interface AbilityStackItemBase {
	id: StackItemId;
	source: ObjectId;
	controller: PlayerId;
	text: string;
	targetDefinitions: TargetDef[];
	targets: TargetBindings;
	effects: EffectDef[];
	sourceLastKnown: SourceLastKnown | null;
}

export interface TriggeredAbilityStackItem extends AbilityStackItemBase {
	kind: "triggered ability";
	triggerId: TriggeredAbilityId;
}

export interface ActivatedAbilityStackItem extends AbilityStackItemBase {
	kind: "activated ability";
	abilityId: ActivatedAbilityId;
}

/** One target slot's chosen target. */
export interface TargetBinding {
	slot: string;
	target: EntityRef;
}

/** The runtime supports either no targets or one required target slot. */
export type TargetBindings = [] | [TargetBinding];

export interface SpellStackEntry {
	targets: TargetBindings;
	kind: "spell";
	objectId: ObjectId;
}

/** Canonical, serializable ordering of spells and abilities on the stack. */
export type StackEntry =
	| SpellStackEntry
	| TriggeredAbilityStackItem
	| ActivatedAbilityStackItem;

export interface GameState {
	/** Incremented whenever canonical state changes and used to reject stale views. */
	revision: number;
	objects: Map<ObjectId, GameObject>;
	players: [PlayerState, PlayerState];
	battlefield: ObjectId[];
	stack: StackEntry[];
	/** Trigger occurrences waiting for the next time a player would receive priority. */
	pendingTriggers: PendingTrigger[];
	floating: FloatingEffect[];
	/** Block declarations for the current combat, in damage-assignment order. */
	blockAssignments: BlockAssignment[];
	/** Turns whose phases have all been consumed; 0 during the first turn. */
	completedTurns: number;
	turnScheduler: TurnScheduler;
	nextObjectId: number;
	nextStackItemId: number;
	/** Monotonic tag source for guard facts (e.g. Chains of Mephistopheles). */
	nextTag: number;
	log: string[];
	rngState: RngState;
}
export type ReadonlyGameState = DeepReadOnly<GameState>;

export type DeepReadOnly<T> = T extends
	| string
	| number
	| boolean
	| bigint
	| symbol
	| null
	| undefined
	? T
	: T extends (...args: never[]) => unknown
		? T
		: T extends Map<infer MapKey, infer MapValue>
			? ReadonlyMap<DeepReadOnly<MapKey>, DeepReadOnly<MapValue>>
			: T extends Set<infer SetValue>
				? ReadonlySet<DeepReadOnly<SetValue>>
				: T extends readonly [unknown, ...unknown[]]
					? { readonly [Index in keyof T]: DeepReadOnly<T[Index]> }
					: T extends ReadonlyArray<infer ArrayValue>
						? ReadonlyArray<DeepReadOnly<ArrayValue>>
						: T extends object
							? { readonly [Key in keyof T]: DeepReadOnly<T[Key]> }
							: T;

/* ------------------------------------------------------------------ *
 * Game Objects
 * ------------------------------------------------------------------ */

export type GameObject =
	| CardObject
	| SpellObject
	| PermanentObject
	| NonbattlefieldTokenObject;

interface ObjectBase {
	id: ObjectId;
	owner: PlayerId;
	effectData: Record<string, Record<string, number>>;
}

interface CardObject extends ObjectBase {
	kind: "card";
	zone: "library" | "hand" | "graveyard" | "exile";
	controller?: never;

	/** The card's underlying definition, unaffected by temporary copying.
	 */
	cardId: string;
}

interface SpellObject extends ObjectBase {
	kind: "spell";
	zone: "stack";
	controller: PlayerId;

	representation:
		| { kind: "card"; cardId: string }
		| {
				kind: "copy";
				copyEffect: CharacteristicsSnapshot;
		  };
}

export interface PermanentObject extends ObjectBase {
	kind: "permanent";
	zone: "battlefield";
	controller: PlayerId;

	representation:
		| { kind: "card"; cardId: string }
		| {
				kind: "token";
				createdValues: CharacteristicsSnapshot;
		  };

	/** Owned layer-1 override captured by a copy effect. */
	copiableOverride?: CharacteristicsSnapshot;

	tapped: boolean;
	counters: CounterBag;
	damage: number;
	attacking: boolean;
	blocking: boolean;
	/** Compatibility discriminator; representation is canonical. */
	readonly token: boolean;
	attributes: {
		deathtouched?: boolean;
	};
}

interface NonbattlefieldTokenObject extends ObjectBase {
	kind: "nonbattlefield-token";
	zone: "hand" | "graveyard" | "library" | "exile";

	createdValues: CharacteristicsSnapshot;
}

/* ------------------------------------------------------------------ *
 * Replacement effects
 * ------------------------------------------------------------------ */

/**
 *
 * 616.1.
 *
 * If two or more replacement and/or prevention effects are attempting to modify
 * the way an event affects an object or player, the affected object's
 * controller (or its owner if it has no controller) or the affected player
 * chooses one to apply, following the steps listed below. If two or more
 * players have to make these choices at the same time, choices are made in
 * APNAP order (see rule 101.4).
 *
 * @example
 * ```
 * Two permanents are on the battlefield. One is an enchantment that reads
 * "If a card would be put into a graveyard from anywhere, instead exile it,"
 * and the other is a creature that reads "If this creature would die, instead
 * shuffle it into its owner's library." If the creature is destroyed, its
 * controller decides which replacement to apply first; the other does nothing.
 *```
 *
 * @example
 * ```
 * Essence of the Wild reads "Creatures you control enter as a copy of this
 * creature." A player who controls Essence of the Wild casts Rusted Sentinel,
 * which normally enters the battlefield tapped. As it enters the battlefield,
 * the copy effect from Essence of the Wild is applied first. As a result, it
 * no longer has the ability that causes it to enter the battlefield tapped.
 * Rusted Sentinel will enter the battlefield as an untapped copy of Essence of
 * the Wild.
 * ```
 *
 */

const REPLACEMENT_EFFECT_ORDER = [
	/**
	 * 616.1a. If any of the replacement and/or prevention effects are
	 * self-replacement effects (see rule 614.15), one of them must be chosen.
	 * If not, proceed to rule 616.1b.
	 *
	 * 614.15. Some replacement effects are not continuous effects. Rather, they
	 * are an effect of a resolving spell or ability that replace part or all of
	 * that spell or ability's own effect(s). Such effects are called
	 * self-replacement effects. The text creating a self-replacement effect is
	 * usually part of the ability whose effect is being replaced, but the text
	 * can be a separate ability, particularly when preceded by an ability word.
	 *
	 * When applying replacement effects to an event, self-replacement effects
	 * are applied before other replacement effects.
	 * @example
	 * ```
	 * Remand: {1}{u}
	 * Counter target spell. If that spell is countered this way, put it into its
	 * owner's hand instead of into that player's graveyard. Draw a card.
	 * ```
	 * "If that spell is countered, do X" is a self-replacement effect.
	 *
	 * @example
	 * ```
	 * This land enters the battlefield tapped.
	 * ```
	 * This is NOT a self-replacement effect. It applies in `other` order.
	 */
	"self",
	/**
	 * 616.1b. If any of the replacement and/or prevention effects would modify
	 * under whose control an object would enter the battlefield, one of them must
	 * be chosen. If not, proceed to rule 616.1c.
	 */
	"control",
	/**
	 * 616.1c. If any of the replacement and/or prevention effects would cause an
	 * object to become a copy of another object as it enters the battlefield, one
	 * of them must be chosen. If not, proceed to rule 616.1d.
	 */
	"copy",
	/**
	 * 616.1d. If any of the replacement and/or prevention effects would cause a
	 * card to enter the battlefield with its back face up, one of them must be
	 * chosen (See rule 701.27, "Transform," and rule 701.28, "Convert."). If not,
	 * proceed to 616.1e.
	 *
	 * we don't support tranformed cards yet.
	 */
	// "transform-face",
	/**
	 * 616.1e. Any of the applicable replacement and/or prevention effects may be
	 * chosen.
	 */
	"other",
] as const;

export type ReplacementLayer = (typeof REPLACEMENT_EFFECT_ORDER)[number];

export interface EffectCtx {
	state: ReadonlyGameState;
	/** Stable derived view for this replacement-evaluation window. */
	read: ReadContext;
	/** The readonly object generating the effect; null for floating/rule effects. */
	self: DeepReadOnly<GameObject> | null;
	controller: PlayerId;
	/** Mutable per-effect scratch (floating shields). */
	data: Record<string, number>;
	rc: ReplacementRun;
}

/** A set of zones. 'any' == every zone (CR 113.6). */
type ZoneScope = Zone[] | "any";
function functionsHere(
	scopes: ZoneScope = ["battlefield"],
	zone: Zone,
): boolean {
	if (scopes === "any") return true;
	return scopes.includes(zone);
}

export interface ReplacementDef {
	/** Stable label used to identify this effect on its source. */
	label: string;
	text: string;
	layer: ReplacementLayer;
	/** is this an effect that prevents something from happening? */
	isPreventionEffect?: boolean;
	/**
	 * pre-filter applies, based on where the source of the event is located.
	 * most effects apply on the battlefield.
	 * @default ['battlefield']. */
	functionsFrom?: ZoneScope;
	/** further scope the rule, after applying functionsFrom above. */
	applies(ev: GameEvent, ctx: EffectCtx): boolean;
	replace(ev: GameEvent, ctx: EffectCtx): GameEvent[];
	/**
	 * Consume shields / decrement counters here.
	 *
	 * TODO: is this an antipattern/smell?
	 */
	onApplied?(ev: GameEvent, ctx: EffectCtx): void;
}

/** A ReplacementDef bound to a concrete source. This is what the loop sees. */
export interface BoundReplacement {
	id: EffectId;
	def: ReplacementDef;
	source: DeepReadOnly<GameObject> | null;
	controller: PlayerId;
	data: Record<string, number>;
	label: string;
}

/**
 *
 * CR 614.5:
 * A replacement effect doesn't invoke itself repeatedly; it gets only one
 * opportunity to affect an event or any modified events that may replace
 * that event.
 *
 * Example: A player controls two permanents, each with an ability that reads
 * "If a creature you control would deal damage to a permanent or player, it
 * deals double that damage to that permanent or player instead." A creature
 * that normally deals 2 damage will deal 8 damage--not just 4, and not an
 * infinite amount.
 *
 * ReplacementRun records that a replacement effect has been applied.
 */
export interface ReplacementRun {
	applied: Set<EffectId>;
	/** implementation detail. we use this to keep track of recursion depth. */
	depth: number;
}

/* ------------------------------------------------------------------ *
 * Prohibition effects
 * 614.17.
 * Some effects state that something can't happen. These effects aren't
 * replacement effects, but follow similar rules.
 * These are also not Prevention Effects, which prevent damage.
 * ------------------------------------------------------------------ */

interface ProhibitionCtx {
	state: ReadonlyGameState;
	read: ReadContext;
	/** The object generating the effect; null for rule effects. */
	self: DeepReadOnly<GameObject> | null;
	controller: PlayerId;
}

/**
 * A static effect saying an event can't happen. Prohibitions aren't replacement
 * effects: in particular, they don't compete with or consume replacement
 * effects.
 */
export interface ProhibitionDef {
	label: string;
	text: string;
	/** @default ['battlefield'] */
	functionsFrom?: ZoneScope;
	applies(ev: GameEvent, ctx: ProhibitionCtx): boolean;
}

/**
 * @see {ReplacementDef}.
 */
export interface BoundProhibition {
	id: EffectId;
	def: ProhibitionDef;
	source: DeepReadOnly<GameObject> | null;
	controller: PlayerId;
	label: string;
}

/* ------------------------------------------------------------------ *
 * Floating Effects
 *
 * These are effects that are not attached to a specific object. Generally,
 * they are something like: "prevent the next N damage", or "until end of turn,
 * replace X with Y".
 *
 * TODO: specific rules reference.
 * ------------------------------------------------------------------ */

interface FloatingEffect {
	id: EffectId;
	controller: PlayerId;
	expires: "endOfTurn" | "never";
	/** Consumed shields set this; expired effects are swept out of the registry. */
	expired: boolean;
	factory: keyof typeof EFFECTS;
	params: Record<string, number | string>;
	/** Mutable scratch space for shields ("prevent the next N damage"). */
	data: Record<string, number>;
}

export function addFloating(
	state: GameState,
	controller: PlayerId,
	factory: keyof typeof EFFECTS,
	params: Record<string, number | string> = {},
	opts: { expires?: "endOfTurn" | "never"; data?: Record<string, number> } = {},
): void {
	state.revision++;
	state.floating.push({
		id: eid(`floating:${state.nextObjectId++}`),
		controller,
		expires: opts.expires ?? "endOfTurn",
		expired: false,
		factory,
		params,
		data: opts.data ?? {},
	});
}

/* ------------------------------------------------------------------ *
 * Effects
 *
 * One serializable effect language is shared by card definitions, imported IR,
 * stack items, and the resolver. An effect never carries a chosen target: it
 * names a target slot its own ability declared, and the resolver looks the
 * binding up. Temporary P/T effects remain definition-only.
 * ------------------------------------------------------------------ */

export type EffectDef =
	| {
			kind: "gain-life" | "lose-life" | "draw";
			player: "you" | "opponent";
			amount: number;
	  }
	| {
			kind: "discard";
			selector: "any" | "random";
			amount: number;
			player: "you" | "opponent";
	  }
	| { kind: "damage"; targetSlot: string; amount: number }
	| { kind: "destroy"; targetSlot: string }
	| {
			kind: "modify-pt";
			targetSlot: string;
			power: number;
			toughness: number;
			duration: "until-end-of-turn";
	  }
	| {
			kind: "add-mana";
			player: "you";
			mana: ManaAmount;
	  }
	| {
			kind: "may";
			decider: "you" | "opponent";
			effects: EffectDef[];
	  };

/* ------------------------------------------------------------------ *
 * Triggers
 *
 * When an event happens, trigger conditions are checked. If the
 * condition is met, the trigger's abilities are put on the stack.
 * ------------------------------------------------------------------ */

type ValidPlayer = "you" | "opponent" | "either";

type TriggerSelector =
	| "self"
	| { non?: true; type: CardType }
	| { non?: true; subtype: string }
	| { non?: true; supertype: string }
	| { controller: "you" | "opponent" }
	| { owner: "you" | "opponent" }
	| { non?: true; color: Color };

interface GainLifeTriggerCondition {
	kind: "gain life" | "lose life";
	/** Which player gained or lost life. */
	player: ValidPlayer;
}

interface DrawTriggerCondition {
	kind: "draw";
	player: ValidPlayer;
}

/** Matches the player declaring attackers and/or each matching attacker. */
interface DeclareAttackersTriggerCondition {
	kind: "declare attackers";
	attacker?: ValidPlayer;
	selector?: TriggerSelector | TriggerSelector[];
}

interface BeginStepTriggerCondition {
	kind: "begin step";
	player: ValidPlayer;
	step: StepKind | "postcombat main" | "precombat main";
}

// TODO: this needs a way to refer to last known info.
interface ZoneChangeTriggerCondition {
	kind: "change zone";
	from: Zone | "any";
	to: Zone | "any";
	/** If array, the object must match every selector. */
	selector: TriggerSelector | TriggerSelector[];
}

/** Matches a permanent becoming tapped or untapped. */
interface TapTriggerCondition {
	kind: "untap" | "tap";
	selector: TriggerSelector | TriggerSelector[];
}

type TriggerCondition =
	| GainLifeTriggerCondition
	| DrawTriggerCondition
	| DeclareAttackersTriggerCondition
	| BeginStepTriggerCondition
	| ZoneChangeTriggerCondition
	| TapTriggerCondition;

export interface TriggerDef {
	id: string;
	text: string;
	condition: TriggerCondition;
	/**
	 * Zones the source must be in for this trigger to function.
	 *
	 * Defaults to `["battlefield"]`.
	 */
	functionsFrom?: [Zone];
	/** Chosen when the ability is put on the stack, not when it triggers. */
	targets: TargetDef[];
	effects: EffectDef[];
}

/* ------------------------------------------------------------------ *
 * Cards
 * ------------------------------------------------------------------ */

export type Keyword = "indestructible" | "lifelink" | "flying" | "vigilance";

/**
 * Object restrictions shared by targeting and by imported continuous effects.
 * Every case is evaluated against an object's *current* characteristics, so a
 * restriction that stopped matching is what makes a target illegal later.
 */
export type TargetSelectorDef =
	| { kind: "self" }
	| { kind: "type"; type: CardType }
	| { kind: "supertype"; supertype: Supertype }
	| { kind: "subtype"; subtype: string }
	| { kind: "color"; color: Color }
	| { kind: "controller"; player: "you" | "opponent" }
	| { kind: "all" | "any"; selectors: TargetSelectorDef[] }
	| { kind: "not"; selector: TargetSelectorDef };

/** Declarative targeting; the runtime supports one required target slot. */
export interface TargetDef {
	id: string;
	min: number;
	max: number;
	legal:
		| { kind: "player" }
		| { kind: "permanent"; selector: TargetSelectorDef }
		| { kind: "any-target" };
}

/**
 * What a target restriction is read relative to. `controller` is the
 * controller of the spell or ability, which is what "you" means in a
 * restriction — never the source's current controller, which a control-change
 * effect can move independently (CR 109.5).
 */
export interface TargetContext {
	controller: PlayerId;
	source: ObjectId;
}

/**
 * Whether one object satisfies a selector. `source` carries the id the `self`
 * case compares against, or null where there is no source object.
 */
export function selectorMatches(
	selector: TargetSelectorDef,
	object: PermanentView,
	source: { controller: PlayerId; id: ObjectId | null },
): boolean {
	switch (selector.kind) {
		case "self":
			return source.id !== null && object.id === source.id;
		case "type":
			return object.types.includes(selector.type);
		case "supertype":
			return object.supertypes.includes(selector.supertype);
		case "subtype":
			return object.subtypes.includes(selector.subtype);
		case "color":
			return object.colors.includes(selector.color);
		case "controller":
			// An object with no controller matches neither "you" nor "opponent".
			if (object.controller === null) return false;
			return selector.player === "you"
				? object.controller === source.controller
				: object.controller !== source.controller;
		case "all":
			return selector.selectors.every((part) =>
				selectorMatches(part, object, source),
			);
		case "any":
			return selector.selectors.some((part) =>
				selectorMatches(part, object, source),
			);
		case "not":
			return !selectorMatches(selector.selector, object, source);
	}
}

export interface SpellAbilityDef {
	id: string;
	text: string;
	targets: TargetDef[];
	effects: EffectDef[];
}

interface ActivatedAbilityDefBase {
	id: string;
	text: string;
	costs: { kind: "tap-self" }[];
	effects: EffectDef[];
}

export interface ActivatedAbilityDef extends ActivatedAbilityDefBase {
	kind: "activated";
	targets: TargetDef[];
}

/** CR 605.1a mana abilities cannot require targets. */
export interface ManaAbilityDef extends ActivatedAbilityDefBase {
	kind: "mana";
}

/** Every ability definition possessed through an activated-ability reference. */
export type AnyActivatedAbilityDef = ActivatedAbilityDef | ManaAbilityDef;

export type CardDefManaCost =
	| {
			w?: number;
			u?: number;
			b?: number;
			r?: number;
			g?: number;
			/** generic */
			c?: number;
	  }
	/**
	 * Some cards have zero mana cost.
	 *
	 * @example
	 * darksteel relic costs 0, and can be cast from hand like any
	 * other spell. It resolves via the stack.
	 */
	| "zero"
	/**
	 * Some cards have no mana cost.  These cannot be cast from hand.
	 *
	 * @example
	 * generic tokens have no mana cost, and their mana value is zero.
	 *
	 * @example
	 * crashing footfalls is a sorcery with no mana cost, and cannot be cast
	 * from the hand. it must be suspended, which later causes a triggered
	 * ability allowing it to be cast from exile.
	 *
	 * token copies of a card *do* have a mana cost, equal to that of the
	 * original card.
	 */
	| "none";

/**
 * Executable ability implementations owned by the registry.
 *
 * A definition living here does *not* mean the card has that ability. It means
 * the card is where the implementation is stored, and that
 * `abilityId("static", cardId, index)` and friends resolve to it. What the card
 * actually has is {@link CardDef.printedAbilities}.
 */
export interface AbilityDefinitions {
	static: ContinuousEffect[];
	activated: AnyActivatedAbilityDef[];
	triggered: TriggerDef[];
	replacement: ReplacementDef[];
	prohibition: ProhibitionDef[];
}

/**
 * The abilities printed on the card, as registry references (CR 109.3). These
 * seed an object's copiable values; continuous effects add to or remove from
 * the derived copy without ever touching the card.
 */
export type PrintedAbilities = AbilityReferences;

interface CardDefBase {
	id: string;
	name: string;
	supertypes?: Supertype[];
	types: CardType[];
	subtypes?: string[];
	colors: Color[];
	manaCost: CardDefManaCost;
	power?: number;
	toughness?: number;
	keywords?: Keyword[];
	/** Printed "enters tapped" — compiled into a replacement. */
	entersTapped?: boolean;
	/** Printed "enters with N counters" — also a replacement. */
	entersWith?: CounterBag;
	/** Canonical declarative spell definition, including targets. */
	spell?: SpellAbilityDef;
}

export interface CardDef extends CardDefBase {
	/** Registry-owned implementations. Not a statement of possession. */
	abilityDefinitions: AbilityDefinitions;
	/** Intrinsic possession, as `cardId:index` references. */
	printedAbilities: PrintedAbilities;
}

/**
 * Authoring shape for cards, the compiler, and tests. The per-kind arrays are
 * the card's definitions; by default the card prints all of them.
 */
export interface CardDefInput extends CardDefBase {
	statics?: ContinuousEffect[];
	activatedAbilities?: AnyActivatedAbilityDef[];
	triggers?: TriggerDef[];
	replacements?: ReplacementDef[];
	prohibitions?: ProhibitionDef[];
	/**
	 * Which definition *indices* the card actually prints, per kind. Omit a kind
	 * to print all of its definitions (the normal case). Supply `[]` for a card
	 * that only hosts an implementation — e.g. an anthem whose layer-6 effect
	 * grants an ability the anthem itself doesn't have.
	 */
	printed?: Partial<Record<AbilityCategory, readonly number[]>>;
}

function printedRefsFor(
	id: string,
	definitions: AbilityDefinitions,
	printed: CardDefInput["printed"],
): PrintedAbilities {
	const refs = {} as Record<AbilityCategory, string[]>;
	for (const category of ABILITY_CATEGORIES) {
		const count = definitions[category].length;
		const indices =
			printed?.[category] ?? definitions[category].map((_, i) => i);
		refs[category] = indices.map((index) => {
			assert(
				Number.isSafeInteger(index) && index >= 0 && index < count,
				`${id}: printed ${category} ability index ${index} has no definition`,
			);
			return abilityId(category, id, index);
		});
	}
	return refs as PrintedAbilities;
}

/**
 * `entersTapped` / `entersWith` are authoring shorthand for two very ordinary
 * replacement abilities (CR 614.1c), so that is what they compile to.
 *
 * Making them real registered abilities — rather than defs synthesized at
 * collection time from whatever card the object "is" — is what makes them
 * copiable. Walking Ballista's copiable values carry
 * `walking-ballista:<n>` in `abilities.replacement`; a Clone that enters as a
 * copy carries that same reference on the event's copy snapshot, and the
 * reference *is* the provenance. Nothing at execution time has to ask which
 * card an object was copied from.
 *
 * They function from anywhere, because the object is still in the zone it is
 * leaving when they apply, and they are self-scoped to the object entering.
 */
function printedEntryReplacements(def: CardDefBase): ReplacementDef[] {
	const out: ReplacementDef[] = [];
	const entersSelf = (ev: GameEvent, ctx: EffectCtx): boolean =>
		ev.kind === "change zone" &&
		ev.to === "battlefield" &&
		ctx.self !== null &&
		ev.object === ctx.self.id;

	if (def.entersTapped) {
		out.push({
			label: `${def.id}:enters-tapped`,
			text: `${def.name} enters tapped.`,
			layer: "other",
			functionsFrom: "any",
			applies: (ev, ctx) =>
				entersSelf(ev, ctx) && ev.kind === "change zone" && !ev.entersTapped,
			replace: (ev) =>
				ev.kind === "change zone" ? [{ ...ev, entersTapped: true }] : [ev],
		});
	}

	const entersWith = def.entersWith;
	if (entersWith && Object.keys(entersWith).length > 0) {
		out.push({
			label: `${def.id}:enters-with`,
			text: `${def.name} enters with counters.`,
			layer: "other",
			functionsFrom: "any",
			applies: (ev, ctx) =>
				entersSelf(ev, ctx) &&
				ev.kind === "change zone" &&
				ev.entersWithCounters === undefined,
			replace: (ev) =>
				ev.kind === "change zone"
					? [{ ...ev, entersWithCounters: { ...entersWith } }]
					: [ev],
		});
	}
	return out;
}

/**
 * Normalizes the authoring shape into the engine shape. Idempotent, so an
 * already-normalized def (from the compiler, or a round trip) passes through
 * with its definition object identities intact.
 */
export function defineCard(input: CardDefInput | CardDef): CardDef {
	if ("abilityDefinitions" in input) return input;
	const {
		statics,
		activatedAbilities,
		triggers,
		replacements,
		prohibitions,
		printed,
		...base
	} = input;
	const abilityDefinitions: AbilityDefinitions = {
		static: statics ?? [],
		activated: activatedAbilities ?? [],
		triggered: triggers ?? [],
		replacement: [...(replacements ?? [])],
		prohibition: prohibitions ?? [],
	};
	// Author-declared indices are resolved first so that an explicit `printed`
	// list keeps meaning what it said; the entry shorthands are appended after,
	// and are always printed.
	const printedAbilities = printedRefsFor(
		input.id,
		abilityDefinitions,
		printed,
	);
	for (const entry of printedEntryReplacements(input)) {
		printedAbilities.replacement.push(
			abilityId("replacement", input.id, abilityDefinitions.replacement.length),
		);
		abilityDefinitions.replacement.push(entry);
	}
	return {
		...base,
		abilityDefinitions,
		printedAbilities,
	};
}

/** Name used at the source/compiler boundary; identical to the engine CardDef. */
export type OracleCardDef = CardDef;

/**
 * Registry indirection so engine code can read card definitions without
 * importing `cards.ts`, which itself imports engine types and helpers. Card data
 * is populated when `cards.ts` is imported.
 */
const DB: Record<string, CardDef> = {};

export function registerCard(input: CardDefInput | CardDef): CardDef {
	const def = defineCard(input);
	DB[def.id] = def;
	return def;
}

function card(id: string): CardDef {
	const def = DB[id];
	if (!def) throw new Error(`unknown card: ${id}`);
	return def;
}

/* ------------------------------------------------------------------ *
 * Randomness
 *
 * Every random decision the rules require — currently only shuffling — is
 * driven from state that lives on `GameState`, never from `Math.random()`.
 * That is not a preference: `advanceWithReplay` re-runs a transition against a
 * clone of its checkpoint, so a shuffle reading ambient randomness would
 * produce a different library on replay and the checkpoint model would break.
 *
 * The generator is sfc32 ("Small Fast Counter", Doty-Humphrey), transcribed
 * from the reference implementation. Javascript has no seeded generator in its
 * standard library, and `crypto` is deliberately non-reproducible, so this is
 * hand-written by necessity rather than by preference.
 * ------------------------------------------------------------------ */

/**
 * sfc32's four 32-bit words, held as plain int32s.
 *
 * `d` is a pure counter and the other three are the chaotic part. That split
 * is the reason to prefer sfc32 over the shorter generators: incrementing `d`
 * every round guarantees a minimum period of 2^32 no matter what the mixing
 * does, so there is no seed that falls into a short cycle and no absorbing
 * all-zero state to special-case.
 */
type RngState = [a: number, b: number, c: number, d: number];

/**
 * Advances the generator one round and returns its raw 32-bit output.
 *
 * Mutates `rng` in place. The `| 0` casts are not decoration: they force
 * Javascript's doubles back into wrapping int32 arithmetic, which is what the
 * algorithm is defined over. The final `>>> 0` is needed because Javascript's
 * bitwise operators produce *signed* int32, and callers want 0..2^32-1.
 */
function advanceRng(rng: RngState): number {
	let [a, b, c, d] = rng;
	const output = (((a + b) | 0) + d) | 0;
	d = (d + 1) | 0; // the counter: the sole guarantor of the minimum period
	a = b ^ (b >>> 9); // xorshift: folds b's high bits down into its low bits
	b = (c + (c << 3)) | 0; // c * 9, cheaply: spreads low bits upward
	c = (c << 21) | (c >>> 11); // barrel rotate: no bit is lost, unlike a shift
	c = (c + output) | 0; // feed the output back so the three words stay coupled
	rng[0] = a;
	rng[1] = b;
	rng[2] = c;
	rng[3] = d;
	return output >>> 0;
}

/**
 * Expands one seed into a full generator state.
 *
 * sfc32 has no defined key schedule, so this follows the usual convention:
 * place the seed in the chaotic words, use a nonzero constant for the rest so
 * that seed 0 is still a live state, then discard early output until the words
 * have avalanched. Without the discard, nearby seeds produce correlated first
 * outputs — which would show up here as similar opening shuffles.
 */
function seedRng(seed: number): RngState {
	const rng: RngState = [0x9e3779b9, seed | 0, seed | 0, 1];
	for (let round = 0; round < 15; round++) advanceRng(rng);
	return rng;
}

const RNG_RANGE = 0x100000000; // 2^32, the size of the generator's output space

/**
 * A uniformly distributed integer in `[0, bound)`.
 *
 * Rejection sampling rather than `output % bound`: 2^32 does not divide evenly
 * by an arbitrary bound, so the modulo alone would make the first
 * `2^32 % bound` values fractionally more likely. Discarding the unbalanced
 * tail of the range costs, for any realistic deck size, far less than one
 * extra round on average.
 */
function randomBelow(state: GameState, bound: number): number {
	assert(
		Number.isSafeInteger(bound) && bound > 0,
		`random bound must be a positive integer, got ${bound}`,
	);
	const unbiasedLimit = Math.floor(RNG_RANGE / bound) * bound;
	// A runaway guard, not a rules limit: for any plausible bound the loop
	// exits on its first round with probability better than 1 - 1e-7.
	for (let attempt = 0; attempt < 64; attempt++) {
		const value = advanceRng(state.rngState);
		if (value < unbiasedLimit) return value % bound;
	}
	throw new Error("rejection sampling failed to terminate");
}

/**
 * CR 103.2. Fisher-Yates, which visits every permutation with equal
 * probability given an unbiased `randomBelow`.
 *
 * The *last* element of `library` is the top of the deck, because that is
 * where `draw` reads from; the shuffle is uniform either way, but the
 * convention matters to anything that inspects the result.
 */
function shuffleLibrary(state: GameState, player: PlayerId): void {
	const library = state.players[player].library;
	for (let i = library.length - 1; i > 0; i--) {
		const j = randomBelow(state, i + 1);
		const chosen = library[j];
		const displaced = library[i];
		assertDefined(chosen, "shuffle read past the end of the library");
		assertDefined(displaced, "shuffle read past the end of the library");
		library[i] = chosen;
		library[j] = displaced;
	}
	state.revision++;
	log(state, `  P${player} shuffles their library`);
}

/* ------------------------------------------------------------------ *
 * Game creation
 * ------------------------------------------------------------------ */

const newPlayerState = (id: PlayerId): PlayerState => ({
	id,
	life: 20,
	library: [],
	hand: [],
	graveyard: [],
	exile: [],
	drawnInDrawStep: 0,
	drewFromEmptyLibrary: false,
	manaPool: { w: 0, u: 0, b: 0, r: 0, g: 0, c: 0 },
	landsPlayed: 0,
	lost: false,
	won: false,
	counters: {},
});

function emptyManaPools(state: GameState): void {
	let changed = false;
	for (const player of state.players) {
		for (const type of MANA_TYPES) {
			if (player.manaPool[type] === 0) continue;
			player.manaPool[type] = 0;
			changed = true;
		}
	}
	if (changed) {
		state.revision++;
		log(state, "  mana pools empty");
	}
}

/**
 * A fresh game.
 *
 * `seed` fixes every shuffle, so the same seed and the same choices reproduce
 * a game exactly. It defaults to a constant rather than to ambient randomness
 * on purpose: tests and the fuzzer depend on `newGame()` being reproducible.
 * Callers that want a different game each run pass their own seed.
 */
export function newGame(seed = 0): GameState {
	return {
		revision: 0,
		objects: new Map(),
		players: [newPlayerState(0), newPlayerState(1)],
		battlefield: [],
		stack: [],
		pendingTriggers: [],
		floating: [],
		blockAssignments: [],
		completedTurns: 0,
		turnScheduler: {
			nextAction: { kind: "advancePreGameStep" },
			progress: { kind: "notStarted" },
			pendingTurns: [],
			nextRegularPlayer: 0 as PlayerId,
			remainingSteps: [],
			remainingPregameSteps: [...PRE_GAME_STEPS],
			nextId: 0,
		},
		nextObjectId: 0,
		nextStackItemId: 0,
		nextTag: 0,
		log: [],
		rngState: seedRng(seed),
	};
}

/* ------------------------------------------------------------------ *
 * Object creation
 * ------------------------------------------------------------------ */

function _defaultVisibility(
	zone: Zone,
	to: PlayerId,
	owner: PlayerId,
): boolean {
	switch (zone) {
		case "stack":
		case "battlefield":
		case "graveyard":
		case "exile":
			return true;
		case "hand":
			return to === owner;
		case "library":
			return false;
		default:
			assertNever(zone);
	}
}

export function spawnCard(
	state: GameState,
	cardId: string,
	owner: PlayerId,
	zone: "library" | "hand" | "graveyard" | "exile",
): CardObject {
	const obj: CardObject = {
		kind: "card",
		id: state.nextObjectId++ as ObjectId,
		cardId,
		owner,

		zone,
		effectData: {},
	};
	state.objects.set(obj.id, obj);
	mutableZoneList(state, zone, owner).push(obj.id);
	state.revision++;
	return obj;
}

function spawnOnBattlefield(
	state: GameState,
	owner: PlayerId,
	representation: PermanentObject["representation"],
	opts: { tapped?: boolean; counters?: CounterBag; token?: boolean } = {},
): PermanentObject {
	const obj: PermanentObject = {
		kind: "permanent",
		representation,
		zone: "battlefield",
		id: state.nextObjectId++ as ObjectId,

		owner,
		controller: owner,

		tapped: opts.tapped ?? false,
		counters: { ...opts.counters },
		effectData: {},
		damage: 0,
		attacking: false,
		blocking: false,
		token: opts.token ?? representation.kind === "token",
		attributes: {},
	};
	state.objects.set(obj.id, obj);
	mutableZoneList(state, "battlefield", owner).push(obj.id);
	state.revision++;
	return obj;
}

export function spawnPermanent(
	state: GameState,
	cardId: string,
	owner: PlayerId,
	opts: { tapped?: boolean; counters?: CounterBag; token?: boolean } = {},
): PermanentObject {
	const representation: PermanentObject["representation"] = opts.token
		? { kind: "token", createdValues: characteristicsFromCardDef(card(cardId)) }
		: { kind: "card", cardId };
	return spawnOnBattlefield(state, owner, representation, opts);
}

export function spawnToken(
	state: GameState,
	owner: PlayerId,
	attributes: CharacteristicsSnapshot,
): PermanentObject {
	return spawnOnBattlefield(state, owner, {
		kind: "token",
		createdValues: attributes,
	});
}

/* ------------------------------------------------------------------ *
 * Lookups
 * ------------------------------------------------------------------ */

export function permanent(state: GameState, id: ObjectId): PermanentObject;
export function permanent(
	state: ReadonlyGameState,
	id: ObjectId,
): DeepReadOnly<PermanentObject>;
export function permanent(
	state: ReadonlyGameState,
	id: ObjectId,
): DeepReadOnly<PermanentObject> {
	const o = maybeObject(state, id);
	if (!o) throw new Error(`no object ${id}`);
	assert(o.kind === "permanent");
	return o;
}

export function maybePermanent(
	state: GameState,
	id: ObjectId,
): PermanentObject | null;
export function maybePermanent(
	state: ReadonlyGameState,
	id: ObjectId,
): DeepReadOnly<PermanentObject> | null;
export function maybePermanent(
	state: ReadonlyGameState,
	id: ObjectId,
): DeepReadOnly<PermanentObject> | null {
	const o = maybeObject(state, id);
	if (!o) return null;
	assert(o.kind === "permanent");
	return o;
}

export function maybeObject(state: GameState, id: ObjectId): GameObject | null;
export function maybeObject(
	state: ReadonlyGameState,
	id: ObjectId,
): DeepReadOnly<GameObject> | null;
export function maybeObject(
	state: ReadonlyGameState,
	id: ObjectId,
): DeepReadOnly<GameObject> | null {
	return state.objects.get(id) ?? null;
}

/** The physical card represented by an object, unaffected by copy effects. */
export function physicalCardId(
	object: DeepReadOnly<GameObject>,
): string | null {
	switch (object.kind) {
		case "card":
			return object.cardId;
		case "spell":
			return object.representation.kind === "card"
				? object.representation.cardId
				: null;
		case "permanent":
			return object.representation.kind === "card"
				? object.representation.cardId
				: null;
		case "nonbattlefield-token":
			return null;
		default:
			return assertNever(object);
	}
}

export function controllerOf(
	object: DeepReadOnly<GameObject>,
): PlayerId | null {
	return object.kind === "spell" || object.kind === "permanent"
		? object.controller
		: null;
}

export function isTokenObject(
	object: DeepReadOnly<GameObject>,
): object is DeepReadOnly<
	| NonbattlefieldTokenObject
	| (PermanentObject & {
			representation: { kind: "token"; createdValues: CharacteristicsSnapshot };
	  })
> {
	return (
		object.kind === "nonbattlefield-token" ||
		(object.kind === "permanent" && object.representation.kind === "token")
	);
}

function creaturesControlledBy(
	read: ReadContext,
	player: PlayerId,
): DeepReadOnly<PermanentObject>[] {
	return read.state.battlefield.flatMap((id) => {
		const object = read.state.objects.get(id);
		const snapshot = read.view.objects.get(id);
		return object?.kind === "permanent" &&
			object.controller === player &&
			snapshot?.kind === "permanent" &&
			snapshot.currentCharacteristics.types.includes("creature")
			? [object]
			: [];
	});
}

function stackObjectIds(state: ReadonlyGameState): ObjectId[] {
	return state.stack.flatMap((entry) =>
		entry.kind === "spell" ? [entry.objectId] : [],
	);
}

export function zoneList(
	state: ReadonlyGameState,
	zone: Zone,
	owner: PlayerId | "any",
): readonly ObjectId[] {
	if (
		owner === "any" &&
		(zone === "library" ||
			zone === "hand" ||
			zone === "graveyard" ||
			zone === "exile")
	) {
		return [...state.players[0][zone], ...state.players[1][zone]];
	}
	switch (zone) {
		case "battlefield":
			return state.battlefield;
		case "stack":
			return stackObjectIds(state);
		case "library":
			assert(owner !== "any");
			return state.players[owner].library;
		case "hand":
			assert(owner !== "any");

			return state.players[owner].hand;
		case "graveyard":
			assert(owner !== "any");

			return state.players[owner].graveyard;
		case "exile":
			assert(owner !== "any");

			return state.players[owner].exile;
	}
}

function mutableZoneList(
	state: GameState,
	zone: Exclude<Zone, "stack">,
	owner: PlayerId,
): ObjectId[] {
	switch (zone) {
		case "battlefield":
			return state.battlefield;
		case "library":
		case "hand":
		case "graveyard":
		case "exile":
			return state.players[owner][zone];
		default:
			return assertNever(zone);
	}
}

export function permanentsInPlay(state: GameState): PermanentObject[];
export function permanentsInPlay(
	state: ReadonlyGameState,
): DeepReadOnly<PermanentObject>[];
export function permanentsInPlay(
	state: ReadonlyGameState,
): DeepReadOnly<PermanentObject>[] {
	return state.battlefield.map((id) => permanent(state, id));
}

/**
 * The single source of truth for who may be declared as an attacker (CR 508.1a,
 * deliberately simplified): a creature controlled by the declaring player,
 * untapped, currently on the battlefield. All creatures are treated as if they
 * have haste, so control duration and summoning sickness are not checked.
 * Battlefield order is preserved.
 */
export function eligibleAttackers(
	state: ReadonlyGameState,
	player: PlayerId,
): ObjectId[] {
	const read = createReadContext(state);
	return state.battlefield.filter((id) => {
		const object = state.objects.get(id);
		const snapshot = read.view.objects.get(id);
		return (
			object?.kind === "permanent" &&
			object.controller === player &&
			!object.tapped &&
			snapshot?.kind === "permanent" &&
			snapshot.currentCharacteristics.types.includes("creature")
		);
	});
}

/** Thrown when a "declare attackers" event fails validation. Nothing is
 * mutated: the whole event is rejected atomically. */
export class IllegalAttackDeclarationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "IllegalAttackDeclarationError";
	}
}

/**
 * The single source of truth for who may be declared as a blocker (CR 509.1a,
 * deliberately simplified): a creature controlled by the defending player,
 * untapped, currently on the battlefield. Blocking does not tap the blocker.
 * Battlefield order is preserved.
 */
export function eligibleBlockers(
	state: ReadonlyGameState,
	player: PlayerId,
): ObjectId[] {
	const read = createReadContext(state);
	return state.battlefield.filter((id) => {
		const object = state.objects.get(id);
		const snapshot = read.view.objects.get(id);
		return (
			object?.kind === "permanent" &&
			object.controller === player &&
			!object.tapped &&
			snapshot?.kind === "permanent" &&
			snapshot.currentCharacteristics.types.includes("creature")
		);
	});
}

/** Thrown when a "declare blockers" event fails validation. Nothing is
 * mutated: the whole event is rejected atomically. */
export class IllegalBlockDeclarationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "IllegalBlockDeclarationError";
	}
}

export class IllegalLandPlayError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "IllegalLandPlayError";
	}
}

export class IllegalAbilityActivationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "IllegalAbilityActivationError";
	}
}

export class IllegalCastError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "IllegalCastError";
	}
}

export function log(state: GameState, line: string): void {
	state.log.push(line);
}

export function name(state: ReadonlyGameState, id: ObjectId): string {
	const object = maybeObject(state, id);
	return object ? initialCharacteristics(object).name : `<gone#${id}>`;
}

/* ------------------------------------------------------------------ *
 * Continuous effects
 * ------------------------------------------------------------------ */
/**
 * Planned subset boundary: reject effects whose selection or calculation
 * reads properties that other effects can change in the same layer/sublayer.
 * Also exclude interactions that change another effect's text or existence
 * (CR 613.8a). Dependency ordering is deliberately deferred.
 *
 * These callbacks are opaque, so this boundary is not mechanically enforced
 * yet. Supported definitions must be reviewed against it. Independent effects
 * still require timestamp order unless their operations commute (CR 613.7);
 * absence of dependencies does not make arbitrary ordering correct.
 */
export interface ContinuousEffect {
	text: string;
	layer: ContinuousEffectLayer;
	/**
	 * Where the *source* must be for this effect to exist at all.
	 *
	 * @default ['battlefield']
	 */
	functionsFrom?: ZoneScope;
	/**
	 * Which objects this effect may modify. `applies()` still filters within
	 * this set; this only bounds which objects are offered to it. Independent of
	 * `functionsFrom`: a graveyard-sourced anthem functions from the graveyard
	 * but affects the battlefield.
	 *
	 * @default ['battlefield']
	 */
	affects?: ZoneScope;

	/** `source` is the concrete object granting the effect. */
	applies(
		view: PermanentView,
		state: ReadonlyGameState,
		source: DeepReadOnly<GameObject>,
	): boolean;
	modify(
		view: CharacteristicsSnapshot,
		state: ReadonlyGameState,
		source: DeepReadOnly<GameObject>,
	): void;
}

interface EvaluationContext {
	state: GameState;
}

interface ContinuousEffectInstance {
	id: EffectId;
	source: ObjectId | null;
	// timestamp: Timestamp;

	parts: ContinuousEffectPart[];
}

interface ContinuousEffectPart {
	layer: ContinuousEffectLayer;

	appliesTo(subject: ObjectId, ctx: EvaluationContext): boolean;

	apply(subject: ObjectId, ctx: EvaluationContext): void;
}
/**
 * 613. Interaction of Continuous Effects
 *  613.1. The values of an object's characteristics are determined by starting
 *  with the actual object. For a card, that means the values of the
 * characteristics printed on that card. For a token or a copy of a spell or
 * card, that means the values of the characteristics defined by the effect
 *  that created it. Then all applicable continuous effects are applied in a
 * series of layers in the following order:
 */
export const CONTINUOUS_EFFECT_LAYERS = [
	/**
	 * 613.1a.
	 * Layer 1: Rules and effects that modify copiable values are applied.
	 * after applying layer 1, the object's "copyable characteristics" are
	 * finalized.
	 *
	 */
	"1a-copiable-values",
	// "1b-facedown-characteristics",
	//
	/**
	 * 613.1b.
	 * Layer 2: Control-changing effects are applied.
	 */
	"2-control-changing",
	/**
	 * 613.1c.
	 * Layer 3: Text-changing effects are applied.
	 * See rule 612, "Text-Changing Effects."
	 */
	"3-text-changing",
	/**
	 * 613.1d.
	 * Layer 4: Type-changing effects are applied.
	 * These include effects that change an object's card type, subtype,
	 * and/or supertype.
	 */
	"4-type-changing",
	/**
	 * 613.1e.
	 * Layer 5: Color-changing effects are applied.
	 */
	"5-color-changing",
	/**
	 * 613.1f.
	 * Layer 6: Ability-adding effects, keyword counters, ability-removing
	 * effects, and effects that say an object can't have an ability are applied.
	 */
	"6-ability-changing",

	/**  613.1g. Layer 7: Power- and/or toughness-changing effects are applied. */

	"7a-power-toughness-defining",
	"7b-set-specific-power-toughness",
	"7c-modify-power-toughness",
	"7d-swap-power-toughness",
] as const;
export type ContinuousEffectLayer = (typeof CONTINUOUS_EFFECT_LAYERS)[number];

/**
 * CR 614.12: replacement effects that modify how a permanent enters check the
 * characteristics it *would have* on the battlefield, with continuous effects
 * already applied. So Root Maze ("artifacts and lands enter tapped") has to see
 * a card that Mycosynth Lattice has turned into an artifact.
 */
export function etbPreview(
	state: ReadonlyGameState,
	ev: ZoneChangeEvent,
): PermanentView {
	const source = maybeObject(state, ev.object);
	assertDefined(source);
	// Clone only mutable state containers; card definitions contain callbacks and
	// therefore cannot pass through structuredClone.
	const preview: GameState = {
		...(state as GameState),
		objects: new Map(
			[...state.objects].map(([id, object]) => [
				id,
				structuredClone(object) as GameObject,
			]),
		),
		players: state.players.map((player) => ({
			...player,
			library: [...player.library],
			hand: [...player.hand],
			graveyard: [...player.graveyard],
			exile: [...player.exile],
			counters: { ...player.counters },
			manaPool: { ...player.manaPool },
		})) as [PlayerState, PlayerState],
		battlefield: [...state.battlefield],
		stack: structuredClone(state.stack) as StackEntry[],
		pendingTriggers: state.pendingTriggers.map(
			(trigger) => structuredClone(trigger) as PendingTrigger,
		),
		floating: [...state.floating] as FloatingEffect[],
		log: [],
	};
	moveObject(preview, ev.object, ev.from, "battlefield", {
		toController: ev.toController,
		tapped: ev.entersTapped,
		counters: ev.entersWithCounters,
		copiableOverride: ev.copiableOverride,
	});
	const id = preview.battlefield[preview.battlefield.length - 1];
	assertDefined(id);
	const snapshot = readObject(createReadContext(preview), id);
	assert(snapshot.kind === "permanent");
	return flattenSnapshot(snapshot);
}

const GAME_VIEW_CACHE = new WeakMap<
	object,
	{ revision: number; view: GameView }
>();

function cachedGameView(state: ReadonlyGameState, revision: number): GameView {
	const cached = GAME_VIEW_CACHE.get(state);
	if (cached?.revision === revision) return cached.view;
	const view = buildGameView(state);
	GAME_VIEW_CACHE.set(state, { revision, view });
	return view;
}

export function createReadContext(state: ReadonlyGameState): ReadContext {
	let derived: GameView | undefined;
	const revision = state.revision;
	return {
		state,
		revision,
		get view() {
			if (state.revision !== revision)
				throw new Error("attempted to use a stale ReadContext");
			if (!derived) derived = cachedGameView(state, revision);
			return derived;
		},
	};
}

export function readObject(
	read: ReadContext,
	id: ObjectId,
): GameObjectSnapshot {
	if (read.state.revision !== read.revision)
		throw new Error("attempted to use a stale ReadContext");
	const snapshot = read.view.objects.get(id);
	if (!snapshot) throw new Error(`no derived view for object ${id}`);
	return snapshot;
}

const PLAYER_VIEW_CACHE = new WeakMap<
	object,
	{
		revision: number;
		views: [PlayerView | undefined, PlayerView | undefined];
	}
>();

const PLAYER_GAME_VIEW_CACHE = new WeakMap<
	object,
	{ revision: number; view: GameView }
>();

function cachedPlayerGameView(
	state: ReadonlyGameState,
	revision: number,
): GameView {
	const complete = GAME_VIEW_CACHE.get(state);
	if (complete?.revision === revision) return complete.view;
	const cached = PLAYER_GAME_VIEW_CACHE.get(state);
	if (cached?.revision === revision) return cached.view;

	// Libraries expose counts only, so deriving snapshots for every card there
	// would add substantial work to each agent decision without adding data.
	const visibleObjects = new Set<ObjectId>();
	for (const object of state.objects.values()) {
		if (object.zone !== "library") visibleObjects.add(object.id);
	}
	const view = buildFilteredGameView(state, visibleObjects);
	PLAYER_GAME_VIEW_CACHE.set(state, { revision, view });
	return view;
}

function deepFreeze<T>(value: T): DeepReadOnly<T> {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
		return value as DeepReadOnly<T>;
	}
	for (const nested of Object.values(value)) deepFreeze(nested);
	return Object.freeze(value) as DeepReadOnly<T>;
}

/** Build a detached player-specific projection from one stable read window. */
export function buildPlayerView(
	state: ReadonlyGameState,
	viewer: PlayerId,
): PlayerView {
	let cached = PLAYER_VIEW_CACHE.get(state);
	if (cached?.revision === state.revision) {
		const existing = cached.views[viewer];
		if (existing) return existing;
	} else {
		cached = { revision: state.revision, views: [undefined, undefined] };
		PLAYER_VIEW_CACHE.set(state, cached);
	}
	const revision = state.revision;
	const read: ReadContext = {
		state,
		revision,
		view: cachedPlayerGameView(state, revision),
	};
	const objectSnapshot = (id: ObjectId): PlayerObjectView => {
		const snapshot = read.view.objects.get(id);
		assertDefined(snapshot, `no derived view for object ${id}`);
		return snapshot;
	};
	const nonbattlefieldSnapshot = <
		ZoneName extends "hand" | "graveyard" | "exile",
	>(
		id: ObjectId,
		zone: ZoneName,
	): PlayerNonbattlefieldObjectView<ZoneName> => {
		const snapshot = objectSnapshot(id);
		assert(
			snapshot.kind === "card" || snapshot.kind === "nonbattlefield-token",
			`${zone} contains non-card object ${id}`,
		);
		assert(snapshot.zone === zone, `object ${id} is not in ${zone}`);
		return { ...snapshot, zone };
	};
	const battlefieldSnapshot = (id: ObjectId): PlayerBattlefieldObjectView => {
		const snapshot = objectSnapshot(id);
		assert(
			snapshot.kind === "permanent",
			`battlefield contains nonpermanent ${id}`,
		);
		return snapshot;
	};
	const publicPlayer = (id: PlayerId): PlayerPublicView => {
		const player = state.players[id];
		return {
			id,
			life: player.life,
			counters: { ...player.counters },
			manaPool: { ...player.manaPool },
			handCount: player.hand.length,
			libraryCount: player.library.length,
			graveyard: player.graveyard.map((objectId) =>
				nonbattlefieldSnapshot(objectId, "graveyard"),
			),
			exile: player.exile.map((objectId) =>
				nonbattlefieldSnapshot(objectId, "exile"),
			),
			landsPlayed: player.landsPlayed,
			lost: player.lost,
			won: player.won,
		};
	};
	const stack = state.stack.map((entry): PlayerStackView => {
		if (entry.kind === "triggered ability") return structuredClone(entry);
		if (entry.kind === "activated ability") return structuredClone(entry);
		const snapshot = read.view.objects.get(entry.objectId);
		assertDefined(snapshot, `no spell object ${entry.objectId}`);
		assert(
			snapshot.kind === "spell",
			`stack object ${entry.objectId} is not a spell`,
		);
		return snapshot;
	});
	const view: PlayerView = {
		version: 1,
		revision: read.revision,
		viewer,
		turn: {
			completedTurns: state.completedTurns,
			activePlayer: activePlayer(state),
			location: structuredClone(turnLocation(state)),
		},
		players: [publicPlayer(0), publicPlayer(1)],
		hand: state.players[viewer].hand.map((objectId) =>
			nonbattlefieldSnapshot(objectId, "hand"),
		),
		battlefield: state.battlefield.map(battlefieldSnapshot),
		stack,
	};

	// Selected GameView snapshots are detached from canonical state. Freezing
	// them makes sharing the revision cache safe for local agents as well as RPC.
	const frozen = deepFreeze(view) as PlayerView;
	cached.views[viewer] = frozen;
	return frozen;
}

/**
 * Fully evaluated characteristics for an object in this read window.
 *
 * This is intentionally distinct from `snapshot.copiableValues`: callers
 * making a copy must capture the latter so later-layer effects and counters do
 * not leak into the copy.
 */
export function effectiveCharacteristics(
	read: ReadContext,
	object: DeepReadOnly<GameObject>,
): DeepReadOnly<CharacteristicsSnapshot> {
	const snapshot = readObject(read, object.id);
	return snapshot.currentCharacteristics;
}

export interface PermanentView {
	readonly name: string;
	readonly manaCost: CardDefManaCost;
	readonly colors: readonly Color[];
	readonly supertypes: readonly Supertype[];
	readonly types: readonly CardType[];
	readonly subtypes: readonly string[];
	readonly keywords: readonly Keyword[];
	readonly abilities: DeepReadOnly<BaseCharacteristicsSnapshot["abilities"]>;
	readonly id: ObjectId;
	readonly cardId: string | null;
	readonly owner: PlayerId;
	readonly controller: PlayerId | null;
	readonly zone: Zone;
	readonly counters: CounterBag;
	readonly tapped: boolean;
	/** Noncreatures expose zero for compatibility; use types to narrow rules logic. */
	readonly power: number;
	readonly toughness: number;
}
export type ObjectView = PermanentView;

function evaluationView(
	object: DeepReadOnly<GameObject>,
	characteristics: DeepReadOnly<CharacteristicsSnapshot>,
): PermanentView {
	const cardId = physicalCardId(object);
	return {
		...characteristics,
		id: object.id,
		cardId,
		owner: object.owner,
		controller: controllerOf(object),
		zone: object.zone,
		counters: object.kind === "permanent" ? { ...object.counters } : {},
		tapped: object.kind === "permanent" ? object.tapped : false,
		power: "power" in characteristics ? characteristics.power : 0,
		toughness: "toughness" in characteristics ? characteristics.toughness : 0,
	};
}

function flattenSnapshot(snapshot: GameObjectSnapshot): PermanentView {
	const cardId =
		snapshot.kind === "card"
			? snapshot.cardId
			: snapshot.kind === "spell" && snapshot.representation.kind === "card"
				? snapshot.representation.cardId
				: snapshot.kind === "permanent" &&
						snapshot.representation.kind === "card"
					? snapshot.representation.cardId
					: null;
	const characteristics = snapshot.currentCharacteristics;
	return {
		...characteristics,
		id: snapshot.objectId,
		cardId,
		owner: snapshot.owner,
		controller: snapshot.controller,
		zone: snapshot.zone,
		counters: snapshot.kind === "permanent" ? { ...snapshot.counters } : {},
		tapped: snapshot.kind === "permanent" ? snapshot.tapped : false,
		power: characteristics.kind === "creature" ? characteristics.power : 0,
		toughness:
			characteristics.kind === "creature" ? characteristics.toughness : 0,
	};
}

export function lethalDamage(read: ReadContext, id: ObjectId): boolean;
export function lethalDamage(state: ReadonlyGameState, id: ObjectId): boolean;
export function lethalDamage(
	stateOrRead: ReadonlyGameState | ReadContext,
	id: ObjectId,
): boolean {
	const read =
		"view" in stateOrRead ? stateOrRead : createReadContext(stateOrRead);
	const o = read.state.objects.get(id);
	assertDefined(o);
	assert(o.kind === "permanent");
	const snapshot = readObject(read, id);
	assert(snapshot.kind === "permanent");
	const characteristics = snapshot.currentCharacteristics;
	if (characteristics.kind !== "creature") return false;
	return characteristics.toughness > 0 && o.damage >= characteristics.toughness;
}

/** Compatibility boundary: build a fresh explicit view for one read. */
export function view(state: ReadonlyGameState, id: ObjectId): ObjectView {
	return flattenSnapshot(readObject(createReadContext(state), id));
}

/* ------------------------------------------------------------------ *
 * Effect collection
 * ------------------------------------------------------------------ */

/**
 * Registry references an object currently has.
 *
 * Possession is read off the derived view, never off the card's definition
 * arrays: a token, a copy, or an object under a layer-6 grant has abilities its
 * own printed card may know nothing about.
 */
function abilityReferencesOf(
	view: GameView,
	object: DeepReadOnly<GameObject>,
): DeepReadOnly<AbilityReferences> {
	const snapshot = view.objects.get(object.id);
	assertDefined(snapshot, `no derived view for object ${object.id}`);
	return snapshot.currentCharacteristics.abilities;
}

/**
 * Layers whose effects can change the characteristics state-based actions care
 * about (types and power/toughness).
 */
const CHARACTERISTIC_CHANGING_LAYERS = [
	"1a-copiable-values",
	"4-type-changing",
	"7a-power-toughness-defining",
	"7b-set-specific-power-toughness",
	"7c-modify-power-toughness",
	"7d-swap-power-toughness",
] satisfies readonly ContinuousEffectLayer[];
/**
 * Cheap prefilter: does any object in the game *possess* a static ability
 * matching `predicate`?
 *
 * Possession, not definition: a token copy of a type-changer has the static on
 * its created values and no card of its own, and a card that merely hosts an
 * implementation it never prints must not count.
 */
function anyPossessedStatic(
	state: ReadonlyGameState,
	predicate: (effect: ContinuousEffect) => boolean,
): boolean {
	for (const object of state.objects.values()) {
		for (const id of baseCharacteristics(object).abilities.static) {
			if (predicate(getAbilityDefinition("static", id))) return true;
		}
	}
	return false;
}

/** Effect-label name for logs, taken from the view rather than re-derived. */
function viewName(view: GameView, id: ObjectId): string {
	const snapshot = view.objects.get(id);
	assertDefined(snapshot, `no derived view for object ${id}`);
	return snapshot.currentCharacteristics.name;
}

/**
 * Replacement effects an object has right now, as `(reference, definition)`
 * pairs. Purely reference-driven: everything an object *has* — printed, copied,
 * or granted in layer 6 — reaches this through `abilities.replacement`.
 *
 * The reference doubles as the effect's identity, so two definitions that
 * happen to share a human `label` never collide, and the same ability keeps one
 * identity across a copy.
 */
function replacementsOf(
	view: GameView,
	object: DeepReadOnly<GameObject>,
): { id: ReplacementAbilityId; def: ReplacementDef }[] {
	return abilityReferencesOf(view, object).replacement.map((id) => ({
		id,
		def: getAbilityDefinition("replacement", id),
	}));
}

/** Per-effect mutable scratch, addressed by the ability's registry reference. */
function effectDataFor(
	object: DeepReadOnly<GameObject>,
	key: string,
): Record<string, number> {
	const existing = object.effectData[key];
	if (existing) return existing as Record<string, number>;
	// `effectData` is never an input to a derived characteristic, so filling a
	// missing slot cannot invalidate a view or a live ReadContext. This is the
	// path an entering *copied* replacement takes: its reference only becomes
	// known once the copy tier has modified the event, long after
	// `prepareEffectData` ran, and the object it binds to is still a card in the
	// zone it is leaving — there is no permanent to hang scratch on yet.
	const fresh: Record<string, number> = {};
	(object as GameObject).effectData[key] = fresh;
	return fresh;
}

export function prepareEffectData(state: GameState): void {
	// Which replacements an object has is a derived fact, so the view has to be
	// built before anything is written back.
	const view = cachedGameView(state, state.revision);
	const pending: [object: GameObject, key: string][] = [];
	for (const object of state.objects.values()) {
		for (const { id } of replacementsOf(view, object)) {
			if (object.effectData[id] === undefined) pending.push([object, id]);
		}
	}
	if (pending.length === 0) return;
	for (const [object, key] of pending) object.effectData[key] = {};
	state.revision++;
	// `effectData` is per-effect mutable scratch and is not an input to any
	// derived characteristic, so the view stays accurate across this bump. Any
	// ReadContext taken before the bump still goes stale, as it must.
	GAME_VIEW_CACHE.set(state, { revision: state.revision, view });
}

/** The object this event is about to put onto the battlefield, if any. */
function enteringObject(ev: GameEvent | undefined): ObjectId | null {
	return ev?.kind === "change zone" && ev.to === "battlefield"
		? ev.object
		: null;
}

/**
 * The replacement abilities an entering object *would have* on the battlefield
 * (CR 614.12), which is what the rest of its own zone-change event must see.
 *
 * Once a copy-tier effect has run (CR 616.1c) the entering object's copiable
 * values live on the event, so its possession for the remainder of the event is
 * the copy's. That cuts both ways, and both are required:
 *
 *  - a copied "enters tapped" / "enters with counters" / other ETB replacement
 *    is acquired and gets to participate in this same event, and
 *  - the object's own printed ETB replacement stops applying, which is exactly
 *    the Rusted Sentinel / Essence of the Wild ruling quoted above.
 *
 * This is derived from the event and the existing view only. Canonical state is
 * never mutated to discover candidates.
 */
function incomingReplacementRefs(
	view: GameView,
	object: DeepReadOnly<GameObject>,
	ev: ZoneChangeEvent,
): readonly ReplacementAbilityId[] {
	return ev.copiableOverride
		? ev.copiableOverride.abilities.replacement
		: abilityReferencesOf(view, object).replacement;
}

/**
 * Every replacement effect currently in play, bound to its source.
 *
 * Pass the event being resolved to get the entering object's *would-be*
 * possession instead of its canonical possession; without it this is the plain
 * event-independent sweep.
 */
export function collectReplacements(
	state: ReadonlyGameState,
	ev?: GameEvent,
): BoundReplacement[] {
	const out: BoundReplacement[] = [];
	const view = cachedGameView(state, state.revision);
	const entering = enteringObject(ev);

	for (const zone of ALL_ZONES) {
		const ids =
			zone === "battlefield"
				? state.battlefield
				: zone === "stack"
					? stackObjectIds(state)
					: state.players.flatMap((p) => zoneList(state, zone, p.id));

		for (const id of ids) {
			// The object this event is putting onto the battlefield is collected
			// below instead, from what it would have rather than what it has.
			if (id === entering) continue;
			const o = maybeObject(state, id);
			if (!o) continue;
			for (const { id: abilityId, def } of replacementsOf(view, o)) {
				if (!functionsHere(def.functionsFrom, zone)) continue;
				const data: Record<string, number> | undefined =
					o.effectData[abilityId];
				assertDefined(data, `effect data was not prepared for ${abilityId}`);
				out.push({
					id: `${o.id}:${abilityId}` as EffectId,
					def,
					source: o,
					controller: controllerOf(o) ?? o.owner,
					data,
					label: `${viewName(view, o.id)}#${o.id} — ${def.text}`,
				});
			}
		}
	}

	if (entering !== null && ev?.kind === "change zone") {
		const o = maybeObject(state, entering);
		// The would-be permanent is evaluated in the zone it is entering, so an
		// ETB replacement written with the ordinary battlefield default works
		// whether the object gets there on its own or as a copy.
		if (o) {
			const displayName = ev.copiableOverride?.name ?? viewName(view, o.id);
			for (const id of incomingReplacementRefs(view, o, ev)) {
				const def = getAbilityDefinition("replacement", id);
				if (!functionsHere(def.functionsFrom, "battlefield")) continue;
				out.push({
					id: `${o.id}:${id}` as EffectId,
					def,
					source: o,
					// CR 616.1b has already settled who it enters under.
					controller: ev.toController,
					data: effectDataFor(o, id),
					label: `${displayName}#${o.id} — ${def.text}`,
				});
			}
		}
	}

	for (const fx of state.floating) {
		if (fx.expired) continue;
		const factory = EFFECTS[fx.factory];
		if (!factory)
			throw new Error(`unknown floating effect factory: ${fx.factory}`);
		const def = factory(fx.params);
		out.push({
			id: fx.id,
			def,
			source: null,
			controller: fx.controller,
			data: fx.data,
			label: `(floating) ${def.text}`,
		});
	}

	return out;
}

/* ------------------------------------------------------------------ *
 * Replacement application
 * ------------------------------------------------------------------ */

/**
 * CR 616.1's chooser for an affected object: its controller, or its owner if it
 * has none (a card in a graveyard, library or hand).
 *
 * An id that names no object has no chooser at all, so callers must not reach
 * here with one. Silently answering P0 would hand a real choice to a player the
 * event never affected.
 */
function affectedObjectPlayer(
	state: ReadonlyGameState,
	id: ObjectId,
): PlayerId {
	const object = maybeObject(state, id);
	assertDefined(object, `no object ${id} to choose a replacement for`);
	return controllerOf(object) ?? object.owner;
}

/**
 * "The affected object's controller (or its owner if it has no controller) or the
 * affected player chooses one to apply."
 */
export function affectedPlayer(
	state: ReadonlyGameState,
	ev: GameEvent,
): PlayerId {
	switch (ev.kind) {
		case "draw":
		case "draw cards":
		case "mill":
		case "discard":
		case "begin turn":
		case "begin step":
		case "begin phase":
		case "gain life":
		case "lose life":
		case "add mana":
			return ev.player;
		case "declare attackers":
		case "declare blockers":
			return ev.player;

		case "damage":
			return ev.target.type === "player"
				? ev.target.player
				: affectedObjectPlayer(state, ev.target.id);

		case "destroy":
		case "regenerate":
			return affectedObjectPlayer(state, ev.object);
		case "tap":
		case "untap":
			if (ev.ref.kind === "all") return ev.ref.player;
			return affectedObjectPlayer(state, ev.ref.object);

		case "add counters":
			return ev.target.type === "player"
				? ev.target.player
				: affectedObjectPlayer(state, ev.target.id);

		case "remove counters":
			return ev.target.type === "player"
				? ev.target.player
				: affectedObjectPlayer(state, ev.target.id);

		case "create token":
			return ev.controller;

		case "lose game":
		case "win game":
			return ev.player;

		case "change zone": {
			const o = maybeObject(state, ev.object);
			assertDefined(o);
			if (ev.from === "battlefield") return controllerOf(o) ?? o.owner;
			if (ev.to === "stack") return ev.toController;

			// Objects on the battlefield / stack have a controller; cards elsewhere
			// don't, so their owner chooses. For a card entering the battlefield we
			// use the would-be controller, which is what players expect at the table.

			return o.owner;
		}
		default:
			assertNever(ev);
	}
}

function ctxFor(
	read: ReadContext,
	r: BoundReplacement,
	run: ReplacementRun,
): EffectCtx {
	return {
		state: read.state,
		read,
		self: r.source,
		controller: r.controller,
		data: r.data,
		rc: run,
	};
}

function prohibitionsFor(read: ReadContext, ev: GameEvent): BoundProhibition[] {
	const out: BoundProhibition[] = [];
	const abilityCanChangeKeywords = anyPossessedStatic(
		read.state,
		(effect) => effect.layer === "6-ability-changing",
	);
	for (const object of read.state.objects.values()) {
		const mightBeIndestructible =
			object.kind === "permanent" &&
			(baseCharacteristics(object).keywords.includes("indestructible") ||
				abilityCanChangeKeywords);
		const snapshot = mightBeIndestructible
			? read.view.objects.get(object.id)
			: undefined;
		const indestructible =
			object.kind === "permanent" &&
			snapshot?.kind === "permanent" &&
			snapshot.currentCharacteristics.keywords.includes("indestructible");
		const definitions: ProhibitionDef[] = [
			...(indestructible
				? [
						{
							label: "keyword:indestructible",
							text: "This permanent can't be destroyed.",
							applies: (event: GameEvent, ctx: ProhibitionCtx) =>
								event.kind === "destroy" && event.object === ctx.self?.id,
						},
					]
				: []),
			...abilityReferencesOf(read.view, object).prohibition.map((id) =>
				getAbilityDefinition("prohibition", id),
			),
		];
		for (const def of definitions) {
			if (!functionsHere(def.functionsFrom, object.zone)) continue;
			const controller = controllerOf(object) ?? object.owner;
			if (
				!def.applies(ev, { state: read.state, read, self: object, controller })
			)
				continue;
			out.push({
				id: `${object.id}:${def.label}` as EffectId,
				def,
				source: object,
				controller,
				label: `${viewName(read.view, object.id)}#${object.id} — ${def.text}`,
			});
		}
	}
	return out;
}

function applicable(
	read: ReadContext,
	ev: GameEvent,
	run: ReplacementRun,
): BoundReplacement[] {
	return collectReplacements(read.state, ev).filter((r) => {
		// CR 614.5 — a replacement effect applies at most once to a given event.
		if (run.applied.has(r.id)) return false;
		/**
		 * 615.12
		 * Some effects state that damage "can't be prevented." If unpreventable
		 * damage would be dealt, any applicable prevention effects are still
		 * applied to it. Those effects won't prevent any damage, but any
		 * additional effects they have will take place. Existing damage prevention
		 *  shields won't be reduced by damage that can't be prevented.
		 */
		if (r.def.isPreventionEffect && ev.kind === "damage" && ev.unpreventable)
			return false;
		return r.def.applies(ev, ctxFor(read, r, run));
	});
}

export function newRun(): ReplacementRun {
	return { applied: new Set(), depth: 0 };
}

const MAX_REPLACEMENT_EFFECT_RECURSION_DEPTH = 64;
const MAX_REPLACEMENT_EFFECT_CHOICES = 64;

/**
 * Runs an event through the replacement pipeline and returns the event(s) that
 * actually happen. May return [] (fully replaced by nothing, e.g. "skip your
 * draw step" or full damage prevention).
 */
function resolveReplacements(
	read: ReadContext,
	event: GameEvent,
	choices: AnyChoiceController,
	run: ReplacementRun = newRun(),
): GameEvent[] {
	if (run.depth > MAX_REPLACEMENT_EFFECT_RECURSION_DEPTH) {
		throw new Error(
			`replacement recursion exceeded ${MAX_REPLACEMENT_EFFECT_RECURSION_DEPTH} — probable rules loop`,
		);
	}

	let current = event;

	for (let iter = 0; iter < MAX_REPLACEMENT_EFFECT_CHOICES; iter++) {
		const allCandidates = applicable(read, current, run);
		const selfCandidates = allCandidates.filter(
			(candidate) => candidate.def.layer === "self",
		);

		/**
		 * 614.17c. If an event can't happen, it can only be replaced by a
		 * self-replacement effect (see rule 614.15). Other replacement and/or
		 * prevention effects can't modify or replace it.
		 *
		 * Consequently, prohibition is a gate after the self-replacement tier,
		 * not itself a replacement-effect layer. Apply an available self-replacement
		 * first and restart the loop; only when none applies do we ask whether the
		 * resulting event can happen.
		 */
		const prohibitions = prohibitionsFor(read, current);
		if (selfCandidates.length === 0 && prohibitions.length > 0) {
			for (const prohibition of prohibitions) {
				log(read.state as GameState, `  [prohibit] ${prohibition.label}`);
			}
			return [];
		}

		const candidates =
			selfCandidates.length > 0 ? selfCandidates : allCandidates;
		if (candidates.length === 0) return [current];

		/** find the highest priority tier that has at least one candidate. */
		const tier = REPLACEMENT_EFFECT_ORDER.find((l) =>
			candidates.some((c) => c.def.layer === l),
		);
		assert(tier, "no tier found");

		const tiered = candidates.filter((c) => c.def.layer === tier);

		const chooser = affectedPlayer(read.state, current);

		const chosen =
			tiered.length === 1
				? tiered[0]
				: /**
					 * 616.1. If two or more replacement and/or prevention effects are attempting
					 * to modify the way an event affects an object or player, the affected
					 * object's controller (or its owner if it has no controller) or the affected
					 * player chooses one to apply, following the steps listed below. If two or
					 * more players have to make these choices at the same time, choices are made
					 * in APNAP order.
					 */
					choices.chooseReplacement(
						read.state as GameState,
						chooser,
						current,
						tiered,
					);

		assertDefined(chosen);
		run.applied.add(chosen.id);
		const ctx = ctxFor(read, chosen, run);
		const produced = chosen.def.replace(current, ctx);
		chosen.def.onApplied?.(current, ctx);

		log(
			read.state as GameState,
			`  [replace] ${chosen.label}` +
				(tiered.length > 1 ? ` (P${chooser} chose from ${tiered.length})` : ""),
		);

		// A single same-kind result is a *modification*: keep iterating on it so
		// further effects (and the once-only rule) see one continuous event.
		const onlyProduced = produced[0];
		if (produced.length === 1 && onlyProduced?.kind === current.kind) {
			current = onlyProduced;
			continue;
		}

		// Zero, several, or a different kind: each resulting event re-enters the
		// pipeline, inheriting the applied-set (CR 614.5 across the chain).
		return produced.flatMap((e) =>
			resolveReplacements(read, e, choices, {
				/**
				 * the applied-set is *inherited* by events produced from a
				 * replacement. That's what makes Chains of Mephistopheles terminate:
				 * the draw that Chains hands back can't be replaced by Chains again.
				 *
				 * TODO: is there a more clear example to use than chains?
				 */
				applied: new Set(run.applied),
				depth: run.depth + 1,
			}),
		);
	}

	throw new Error("replacement loop failed to converge");
}

/* ------------------------------------------------------------------ *
 * Zone movement — CR 400.7: an object that moves zones becomes a *new*
 * object.
 * ------------------------------------------------------------------ */

function moveObject(
	state: GameState,
	id: ObjectId,
	from: Zone,
	to: Zone,
	opts: {
		toController: PlayerId;
		tapped?: boolean;
		counters?: CounterBag;
		copiableOverride?: CharacteristicsSnapshot;
		toBottom?: boolean;
		spellTargets?: TargetBindings;
	},
): ObjectId {
	const old = maybeObject(state, id);
	assert(old, `cannot move missing object ${id}`);
	assert(
		old.zone === from,
		`cannot move object ${id} from ${from}: it is in ${old.zone}`,
	);
	if (from === "stack") {
		const index = state.stack.findIndex(
			(entry) => entry.kind === "spell" && entry.objectId === id,
		);
		assert(index !== -1, `spell ${id} is missing from the stack`);
		state.stack.splice(index, 1);
	} else {
		const src = mutableZoneList(state, from, old.owner);
		const index = src.indexOf(id);
		assert(index !== -1, `object ${id} is missing from its ${from} zone list`);
		src.splice(index, 1);
	}
	state.objects.delete(id);

	// The printed card identity survives copy effects and zone changes.
	const printedId = physicalCardId(old);
	const tokenValues =
		old.kind === "permanent" && old.representation.kind === "token"
			? cloneCharacteristics(old.representation.createdValues)
			: old.kind === "nonbattlefield-token"
				? cloneCharacteristics(old.createdValues)
				: null;
	const freshId = state.nextObjectId++ as ObjectId;
	let fresh: GameObject;
	if (to === "battlefield") {
		let representation: PermanentObject["representation"];
		if (tokenValues) {
			representation = { kind: "token", createdValues: tokenValues };
		} else {
			assert(printedId, "moved object has no card identity or token values");
			representation = { kind: "card", cardId: printedId };
		}
		fresh = {
			kind: "permanent",
			id: freshId,
			owner: old.owner,
			controller: opts.toController,
			zone: "battlefield",
			representation,
			...(opts.copiableOverride
				? {
						copiableOverride: cloneCharacteristics(opts.copiableOverride),
					}
				: {}),
			tapped: opts.tapped ?? false,
			counters: { ...opts.counters },
			effectData: {},
			damage: 0,
			attacking: false,
			blocking: false,
			token: tokenValues !== null,
			attributes: {},
		};
	} else if (to === "stack") {
		assert(printedId, "tokens cannot become spells");
		fresh = {
			kind: "spell",
			id: freshId,
			owner: old.owner,
			controller: opts.toController,
			zone: "stack",
			representation: { kind: "card", cardId: printedId },
			effectData: {},
		};
	} else if (tokenValues) {
		fresh = {
			kind: "nonbattlefield-token",
			id: freshId,
			owner: old.owner,
			zone: to,
			createdValues: tokenValues,
			effectData: {},
		};
	} else {
		assert(printedId, "card-backed object has no card identity");
		fresh = {
			kind: "card",
			id: freshId,
			owner: old.owner,
			zone: to,
			cardId: printedId,
			effectData: {},
		};
	}
	state.objects.set(fresh.id, fresh);
	if (to === "stack") {
		assert(
			fresh.kind === "spell",
			"only spells can enter the stack as objects",
		);
		state.stack.push({
			kind: "spell",
			objectId: fresh.id,
			targets: structuredClone(opts.spellTargets ?? []),
		});
	} else {
		const dst = mutableZoneList(state, to, fresh.owner);
		if (to === "library" && opts.toBottom) dst.unshift(fresh.id);
		else dst.push(fresh.id);
	}
	log(
		state,
		`  ${initialCharacteristics(fresh).name}#${fresh.id} is now in ${to}`,
	);
	return fresh.id;
}

/** Convenience for logs/tests. */
export function describeEvent(state: ReadonlyGameState, ev: GameEvent): string {
	switch (ev.kind) {
		case "draw cards":
			return `draw cards(P${ev.player}, ${ev.amount})`;
		case "draw":
			return `draw(P${ev.player})`;
		case "mill":
			return `mill(P${ev.player}, ${ev.amount})`;
		case "discard":
			if (ev.cards.kind === "hand-size")
				return `discard(P${ev.player}, to hand size)`;
			if (ev.cards.kind === "specific")
				return `discard(P${ev.player}, ${name(state, ev.cards.card)})`;
			assert(ev.cards.kind === "any");
			return `discard(P${ev.player})`;
		case "damage": {
			const tgt =
				ev.target.type === "player"
					? `P${ev.target.player}`
					: name(state, ev.target.id);
			return `damage(${ev.amount} from ${name(state, ev.source)} to ${tgt})`;
		}
		case "destroy":
			return `destroy(${name(state, ev.object)})`;
		case "regenerate":
			return `regenerate(${name(state, ev.object)})`;
		case "change zone": {
			const extras = [
				ev.entersTapped ? "tapped" : "",
				ev.entersWithCounters ? JSON.stringify(ev.entersWithCounters) : "",
				ev.copiableOverride
					? `copiableOverride=${ev.copiableOverride.name}`
					: "",
			]
				.filter(Boolean)
				.join(" ");
			return `move(${name(state, ev.object)}: ${ev.from}->${ev.to}${extras ? ` ${extras}` : ""})`;
		}
		case "add counters": {
			const tgt =
				ev.target.type === "player"
					? `P${ev.target.player}`
					: name(state, ev.target.id);
			return `counters(${ev.amount}x ${ev.counter} on ${tgt})`;
		}
		case "remove counters": {
			const tgt =
				ev.target.type === "player"
					? `P${ev.target.player}`
					: name(state, ev.target.id);
			if (ev.counters === "all") return `counters(rm all on ${tgt})`;
			return `counters(rm ${Object.entries(ev.counters)
				.map(([k, v]) => `${v}x ${k}`)
				.join(",")} on ${tgt})`;
		}
		case "gain life":
		case "lose life":
			return `life(P${ev.player} ${ev.amount >= 0 ? "+" : ""}${ev.amount})`;
		case "add mana":
			return `mana(P${ev.player} +${MANA_TYPES.map((type) =>
				ev.mana[type] ? `${ev.mana[type]}${type.toUpperCase()}` : "",
			)
				.filter(Boolean)
				.join(" ")})`;
		case "tap":
			if (ev.ref.kind === "all") return `tap(all P${ev.ref.player})`;
			return `tap(${name(state, ev.ref.object)})`;
		case "untap":
			if (ev.ref.kind === "all") return `untap(all P${ev.ref.player})`;
			return `untap(${name(state, ev.ref.object)})`;
		case "begin turn":
			return `beginTurn(P${ev.player}, #${ev.turnId}${ev.isExtra ? ", extra" : ""})`;
		case "begin step":
			return `beginStep(P${ev.player}, ${ev.step})`;
		case "begin phase":
			return `beginPhase(P${ev.player}, ${ev.phase})`;
		case "create token":
			return `token(${ev.amount}x ${ev.tokenDefinitionId} for P${ev.controller})`;
		case "lose game":
			return `loseGame(P${ev.player}: ${ev.reason})`;
		case "declare attackers":
			return ev.attackers.length === 0
				? `declareAttackers(P${ev.player}, none)`
				: `declareAttackers(P${ev.player}, ${ev.attackers.map((id) => name(state, id)).join(", ")})`;
		case "declare blockers":
			return ev.blockers.length === 0
				? `declareBlockers(P${ev.player}, none)`
				: `declareBlockers(P${ev.player}, ${ev.blockers
						.map(
							({ blocker, attacker }) =>
								`${name(state, blocker)} -> ${name(state, attacker)}`,
						)
						.join(", ")})`;
		case "win game":
			return `winGame(P${ev.player}: ${ev.reason})`;
	}
}

/* ------------------------------------------------------------------ *
 * State-based actions
 * ------------------------------------------------------------------ */

export function checkStateBasedActions(
	state: GameState,
	source: ChoiceSource,
): void {
	checkStateBasedActionsIn(state, asChoiceController(source));
}

function checkStateBasedActionsIn(
	state: GameState,
	choices: AnyChoiceController,
): void {
	for (let pass = 0; pass < 32; pass++) {
		let acted = false;

		for (const p of state.players) {
			//   704.5a. If a player has 0 or less life, that player loses the game.
			if (!p.lost && !p.won && p.life <= 0) {
				performIn(
					state,
					{ kind: "lose game", player: p.id, reason: "life" },
					choices,
					newScope(),
					0,
				);
				// A replacement effect such as Platinum Angel may prevent the loss.
				// Only signal that an SBA happened if the player actually lost.
				if (p.lost) acted = true;
			}
			//  704.5b. If a player attempted to draw a card from a library with no
			// cards in it since the last time state-based actions were checked, that
			// player loses the game.
			if (!p.lost && !p.won && p.drewFromEmptyLibrary) {
				performIn(
					state,
					{
						kind: "lose game",
						player: p.id,
						reason: "drewFromEmptyLibrary",
					},
					choices,
					newScope(),
					0,
				);
				p.drewFromEmptyLibrary = false;
				if (p.lost) acted = true;
			}
			// 704.5c. If a player has ten or more poison counters, that player loses
			// the game.
			if (p.counters.poison !== undefined && p.counters.poison >= 10) {
				performIn(
					state,
					{
						kind: "lose game",
						player: p.id,
						reason: "poison",
					},
					choices,
					newScope(),
					0,
				);
				if (p.lost) acted = true;
			}
		}

		// 704.5d. If a token is in a zone other than the battlefield, it ceases
		// to exist. The zone change itself still happened and can trigger abilities.
		for (const o of state.objects.values()) {
			if (o.kind !== "nonbattlefield-token") continue;
			const zone = mutableZoneList(state, o.zone, o.owner);
			const idx = zone.indexOf(o.id);
			assert(
				idx !== -1,
				`token ${o.id} is missing from its ${o.zone} zone list`,
			);
			zone.splice(idx, 1);
			state.objects.delete(o.id);
			state.revision++;
			log(
				state,
				`  SBA: ${initialCharacteristics(o).name}#${o.id} (token) ceases to exist`,
			);
			acted = true;
		}

		// 704.5e. If a copy of a spell is in a zone other than the stack, it ceases
		// to exist. If a copy of a card is in any zone other than the stack or the
		// battlefield, it ceases to exist.

		// 704.5h. If a creature has toughness greater than 0, and it's been dealt
		// damage by a source with deathtouch since the last time state-based
		// actions were checked, that creature is destroyed. Regeneration can
		// replace this event.

		// 704.5i. If a planeswalker has loyalty 0, it's put into its owner's
		// graveyard.

		// 704.5j. If two or more legendary permanents with the same name are
		// controlled by the same player, that player chooses one of them, and the
		// rest are put into their owners' graveyards. This is called the
		// "legend rule."

		// 704.5k. world permanents: don't support these.

		// 704.5m. If an Aura is attached to an illegal object or player, or is not
		// attached to an object or player, that Aura is put into its owner's
		// graveyard.

		// 704.5n. If an Equipment or Fortification is attached to an illegal
		// permanent or to a player, it becomes unattached from that permanent
		// or player. It remains on the battlefield.

		// 704.5p. If a battle or creature is attached to an object or player, it
		// becomes unattached and remains on the battlefield. Similarly, if any
		// nonbattle, noncreature permanent that's neither an Aura, an Equipment,
		// nor a Fortification is attached to an object or player, it becomes
		// unattached and remains on the battlefield.

		// 704.5r. If a permanent with an ability that says it can't have more than
		// N counters of a certain kind on it has more than N counters of that kind
		// on it, all but N of those counters are removed from it.

		// 704.5s. If the number of lore counters on a Saga permanent with one or
		// more chapter abilities is greater than or equal to its final chapter
		// number and it isn't the source of a chapter ability that has triggered
		// but not yet left the stack, that Saga's controller sacrifices it. See
		// rule 714, "Saga Cards."

		// 704.5t. If a player's venture marker is on the bottommost room of a
		// dungeon card, and that dungeon card isn't the source of a room ability
		// that has triggered but not yet left the stack, the dungeon card's owner
		// removes it from the game. See rule 309, "Dungeons."

		// 704.5u. Space beleren: we don't support this.

		// 704.5v-y. Battles: we don't support this.

		// 704.5z. If a permanent has more than one Role controlled by the same
		// player attached to it, each of those Roles except the one with the most
		// recent timestamp is put into its owner's graveyard.

		// 704.5aa. Speed: we don't support this.

		// Prefilter for the permanent SBAs below. Skipping the sweep is only sound
		// because every continuous effect in the engine comes from a *static
		// ability* possessed by some object: floating effects are `ReplacementDef`s
		// and cannot change characteristics. If a floating continuous effect ever
		// exists (say, "target creature gets -3/-3 until end of turn"), this
		// prefilter will silently stop noticing creatures that died to it, and
		// `hasCharacteristicChangingStatic` must grow to cover `state.floating`.
		const hasCharacteristicChangingStatic = anyPossessedStatic(
			state,
			(effect) => includes(CHARACTERISTIC_CHANGING_LAYERS, effect.layer),
		);

		const needsPermanentSbas =
			hasCharacteristicChangingStatic ||
			state.battlefield.some((id) => {
				const object = maybePermanent(state, id);
				if (!object) return false;
				if (object.damage > 0 || object.attributes.deathtouched) return true;
				if (object.counters["+1/+1"] || object.counters["-1/-1"]) return true;
				const initial = initialCharacteristics(object);
				return "toughness" in initial && initial.toughness <= 0;
			});
		if (!needsPermanentSbas) {
			if (!acted) return;
			continue;
		}

		let sbaRead = createReadContext(state);
		for (const id of [...state.battlefield]) {
			const o = maybePermanent(state, id);
			if (!o) continue;
			const snapshot = readObject(sbaRead, id);
			assert(snapshot.kind === "permanent");
			const characteristics = snapshot.currentCharacteristics;
			if (characteristics.kind !== "creature") continue;
			const v = flattenSnapshot(snapshot);

			// 704.5f. If a creature has toughness 0 or less, it's put into its
			// owner's graveyard. Regeneration can't replace this event.
			if (characteristics.toughness <= 0) {
				log(state, `  SBA: ${name(state, id)} has toughness ${v.toughness}`);
				performIn(
					state,
					{
						kind: "change zone",
						object: id,
						from: "battlefield",
						to: "graveyard",
						cause: "sba",
						toController: o.controller,
					},
					choices,
					newScope(),
					0,
				);
				acted = true;
				sbaRead = createReadContext(state);
				continue;
			}
			// 704.5g. If a creature has toughness greater than 0, it has damage marked
			// on it, and the total damage marked on it is greater than or equal to its
			// toughness, that creature has been dealt lethal damage and is destroyed.
			// Regeneration can replace this event.
			if (lethalDamage(sbaRead, id) || o.attributes.deathtouched) {
				const destroy: DestroyEvent = {
					kind: "destroy",
					object: id,
					noRegen: false,
				};
				// Always use the replacement pipeline here. Under CR 614.17c, even an
				// otherwise prohibited event must first get a chance to be changed by a
				// self-replacement effect. Only count the SBA as acting if something
				// actually happened, so an indestructible creature doesn't keep the SBA
				// loop running forever.
				const objectName = name(state, id);
				const result = performIn(state, destroy, choices, newScope(), 0);
				// Effect scratch preparation may mutate canonical state even when a
				// prohibition prevents the event.
				sbaRead = createReadContext(state);
				if (result.executed.length > 0) {
					log(state, `  SBA: ${objectName} has lethal damage`);
					acted = true;
					if (!state.objects.has(id)) continue;
				}
			}

			// 704.5q. If a permanent has both a +1/+1 counter and a -1/-1 counter on
			// it, N +1/+1 and N -1/-1 counters are removed from it, where N is the
			// smaller of the number of +1/+1 and -1/-1 counters on it.
			if (o.counters["+1/+1"] && o.counters["-1/-1"]) {
				const n = Math.min(o.counters["+1/+1"], o.counters["-1/-1"]);
				performIn(
					state,
					{
						kind: "remove counters",
						target: { type: "permanent", id: id },
						counters: { "+1/+1": n, "-1/-1": n },
					},
					choices,
					newScope(),
					0,
				);
				acted = true;
				sbaRead = createReadContext(state);
			}
		}

		if (!acted) return;
	}
	throw new Error("SBA loop did not stabilize");
}

/* ------------------------------------------------------------------ *
 * Event execution
 * ------------------------------------------------------------------ */

/**
 * A "bundle" is one player-visible happening plus everything it cascades into.
 * `facts` implements "if you do" clauses without putting closures in events —
 * an event carries `fact` (recorded on success) and `guard` (required to run).
 */
export interface Scope {
	facts: Set<string>;
}

export function newScope(): Scope {
	return { facts: new Set() };
}

/** Result of running one event through replacements and execution. */
export interface PerformResult {
	executed: GameEvent[];
	created: ObjectId[];
}

/** Public entry point. Replace, then execute. Callers must run SBAs separately. */
export function perform(
	state: GameState,
	event: GameEvent,
	source: ChoiceSource,
): PerformResult {
	return performIn(state, event, asChoiceController(source), newScope(), 0);
}

/** Applies event replacements and delegates to `executeIn` to apply changes. */
function performIn(
	state: GameState,
	event: GameEvent,
	choices: AnyChoiceController,
	scope: Scope,
	depth: number,
): PerformResult {
	log(state, `${"  ".repeat(depth)}> ${describeEvent(state, event)}`);
	// Mutable replacement scratch is installed before the mutation-free read window.
	prepareEffectData(state);
	const read = createReadContext(state);
	const finals = resolveReplacements(read, event, choices);
	if (finals.length === 0)
		log(state, `${"  ".repeat(depth + 1)}(replaced by nothing)`);
	const executed: GameEvent[] = [];
	const created: ObjectId[] = [];
	for (const ev of finals) {
		const before = createReadContext(state);
		const result = executeIn(state, before, ev, choices, scope, depth + 1);
		executed.push(...result.executed);
		created.push(...result.created);
	}
	return { executed, created };
}

/* ------------------------------------------------------------------ *
 * Trigger detection
 * ------------------------------------------------------------------ */

/** Adds a trigger to `state.pendingTriggers`. */
function enqueueTrigger(
	state: GameState,
	source: GameObject,
	triggerId: TriggeredAbilityId,
	trigger: TriggerDef,
): void {
	const controller = controllerOf(source);
	assertDefined(controller);
	state.pendingTriggers.push({
		source: source.id,
		triggerId,
		controller,
		text: trigger.text,
		effects: trigger.effects,
	});
	log(
		state,
		`  [trigger] ${name(state, source.id)}#${source.id} — ${trigger.text}`,
	);
}

function relativePlayerMatches(
	actual: PlayerId,
	expected: ValidPlayer,
	source: DeepReadOnly<GameObject>,
): boolean {
	if (expected === "either") return true;
	const controller = controllerOf(source);
	assertDefined(controller);
	return expected === "you" ? actual === controller : actual !== controller;
}

function triggerSubjectMatches(
	read: ReadContext,
	source: DeepReadOnly<GameObject>,
	subject: DeepReadOnly<GameObject>,
	selector: TriggerSelector,
): boolean {
	if (selector === "self") return subject.id === source.id;

	let matches: boolean;
	if ("controller" in selector) {
		const controller = controllerOf(subject);
		if (controller === null) return false;
		matches = relativePlayerMatches(controller, selector.controller, source);
	} else if ("owner" in selector) {
		matches = relativePlayerMatches(subject.owner, selector.owner, source);
	} else {
		const printedId = physicalCardId(subject);
		const subjectSnapshot =
			subject.kind === "permanent" && subject.zone === "battlefield"
				? readObject(read, subject.id)
				: null;
		if (subjectSnapshot !== null) assert(subjectSnapshot.kind === "permanent");
		const characteristics =
			subjectSnapshot?.kind === "permanent"
				? subjectSnapshot.currentCharacteristics
				: printedId
					? card(printedId)
					: initialCharacteristics(subject);
		if ("type" in selector) {
			matches = characteristics.types.includes(selector.type);
		} else if ("subtype" in selector) {
			matches = characteristics.subtypes?.includes(selector.subtype) ?? false;
		} else if ("supertype" in selector) {
			matches =
				characteristics.supertypes?.includes(selector.supertype as Supertype) ??
				false;
		} else {
			matches = characteristics.colors.includes(selector.color);
		}
	}

	return "non" in selector && selector.non ? !matches : matches;
}

function triggerSubjectsMatch(
	read: ReadContext,
	source: DeepReadOnly<GameObject>,
	subjects: DeepReadOnly<GameObject>[],
	_selectors: TriggerSelector | TriggerSelector[],
): boolean {
	const selectors = Array.isArray(_selectors) ? _selectors : [_selectors];
	return subjects.some((subject) =>
		selectors.every((selector) =>
			triggerSubjectMatches(read, source, subject, selector),
		),
	);
}

function triggerMatches(
	read: ReadContext,
	source: DeepReadOnly<GameObject>,
	condition: TriggerCondition,
	ev: GameEvent,
	created: ObjectId[],
	changed: ObjectId[],
): boolean {
	if (ev.kind !== condition.kind) return false;

	switch (condition.kind) {
		case "gain life":
		case "lose life":
		case "draw":
			assert(
				ev.kind === "gain life" ||
					ev.kind === "lose life" ||
					ev.kind === "draw",
			);
			return relativePlayerMatches(ev.player, condition.player, source);

		case "begin step":
			assert(ev.kind === "begin step");
			return (
				ev.step === condition.step &&
				relativePlayerMatches(ev.player, condition.player, source)
			);

		case "declare attackers": {
			assert(ev.kind === "declare attackers");
			if (
				condition.attacker &&
				!relativePlayerMatches(ev.player, condition.attacker, source)
			) {
				return false;
			}
			if (!condition.selector) return true;
			const attackers = ev.attackers.flatMap((id) => {
				const attacker = maybeObject(read.state, id);
				return attacker ? [attacker] : [];
			});
			return triggerSubjectsMatch(read, source, attackers, condition.selector);
		}

		case "change zone": {
			assert(ev.kind === "change zone");
			if (condition.from !== "any" && ev.from !== condition.from) return false;
			if (condition.to !== "any" && ev.to !== condition.to) return false;

			if (condition.from === "battlefield")
				throw new Error("leaves the battlefield triggers are not supported");
			// CR 400.7: ev.object names the old object, which no longer exists after
			// execution. Match against the new object(s) returned by moveObject instead.
			// Leaves-the-battlefield triggers will need last-known information here.
			const movedObjects = created.flatMap((id) => {
				const moved = maybeObject(read.state, id);
				return moved ? [moved] : [];
			});
			return triggerSubjectsMatch(
				read,
				source,
				movedObjects,
				condition.selector,
			);
		}

		case "tap":
		case "untap": {
			assert(ev.kind === "tap" || ev.kind === "untap");
			const subjects = changed.flatMap((id) => {
				const subject = maybeObject(read.state, id);
				return subject ? [subject] : [];
			});
			return triggerSubjectsMatch(read, source, subjects, condition.selector);
		}
	}
}

/** Observe events only after they successfully execute and all replacements are final. */
function detectTriggers(
	state: GameState,
	read: ReadContext,
	ev: GameEvent,
	created: ObjectId[],
	changed: ObjectId[],
): void {
	for (const abilitySource of state.objects.values()) {
		const snapshot = read.view.objects.get(abilitySource.id);
		assertDefined(snapshot, `no derived view for object ${abilitySource.id}`);
		for (const triggerId of snapshot.currentCharacteristics.abilities
			.triggered) {
			const trigger = getAbilityDefinition("triggered", triggerId);
			const functionsFrom = trigger.functionsFrom ?? ["battlefield"];
			if (!functionsFrom.includes(abilitySource.zone)) continue;
			if (
				triggerMatches(
					read,
					abilitySource,
					trigger.condition,
					ev,
					created,
					changed,
				)
			) {
				enqueueTrigger(state, abilitySource, triggerId, trigger);
			}
		}
	}
}

/**
 * Executes an event after replacements. New events are fed back through
 * `performIn` so they receive their own replacement pass.
 */
function executeIn(
	state: GameState,
	before: ReadContext,
	ev: GameEvent,
	choices: AnyChoiceController,
	scope: Scope,
	depth: number,
): PerformResult {
	if (ev.guard && !scope.facts.has(ev.guard)) {
		log(
			state,
			`${"  ".repeat(depth)}(skipped ${describeEvent(state, ev)} — guard "${ev.guard}" unmet)`,
		);
		return { executed: [], created: [] };
	}
	if (ev.unless && scope.facts.has(ev.unless)) {
		log(
			state,
			`${"  ".repeat(depth)}(skipped ${describeEvent(state, ev)} — fact "${ev.unless}" present)`,
		);
		return { executed: [], created: [] };
	}

	let happened = true;
	const created: ObjectId[] = [];
	const changed: ObjectId[] = [];
	const childResults: PerformResult[] = [];

	switch (ev.kind) {
		case "draw cards": {
			// Should this be >= 0? could a replacement effect alter this legally?
			assert(
				ev.amount >= 1,
				`draw cards amount must be at least 1, got ${ev.amount}`,
			);
			for (let i = 0; i < ev.amount; i++) {
				childResults.push(
					performIn(
						state,
						{
							kind: "draw",
							player: ev.player,
						},
						choices,
						scope,
						depth,
					),
				);
			}
			break;
		}

		case "draw": {
			const p = state.players[ev.player];
			const top = p.library[p.library.length - 1];
			if (top === undefined) {
				// CR 704.5b: queue a state-based loss, don't resolve it here.
				p.drewFromEmptyLibrary = true;
				log(
					state,
					`${"  ".repeat(depth)}P${ev.player} tried to draw from an empty library`,
				);
				happened = false;
				break;
			}
			if (
				currentStepKind(state) === "draw" &&
				activePlayer(state) === ev.player
			)
				p.drawnInDrawStep++;
			// Drawing *is* a zone change, so zone-change replacements get a look too.
			childResults.push(
				performIn(
					state,
					{
						kind: "change zone",
						object: top,
						from: "library",
						to: "hand",
						cause: "draw",
						toController: ev.player,
					},
					choices,
					scope,
					depth + 1,
				),
			);
			break;
		}

		case "mill": {
			const p = state.players[ev.player];
			if (ev.amount <= 0 || p.library.length === 0) {
				happened = false;
				break;
			}
			for (let i = 0; i < ev.amount; i++) {
				const top = p.library[p.library.length - 1];
				if (top === undefined) break;
				childResults.push(
					performIn(
						state,
						{
							kind: "change zone",
							object: top,
							from: "library",
							to: "graveyard",
							cause: "mill",
							toController: ev.player,
						},
						choices,
						scope,
						depth + 1,
					),
				);
			}
			break;
		}

		case "discard": {
			const p = state.players[ev.player];
			if (p.hand.length === 0) {
				happened = false;
				break;
			}
			if (ev.cards.kind === "hand-size") {
				const countToDiscard = p.hand.length - 7;
				if (countToDiscard <= 0) {
					happened = false;
					break;
				}
				const toDiscard: ObjectId[] = [];

				for (let i = 0; i < countToDiscard; i++) {
					const remaining = p.hand.filter((id) => !toDiscard.includes(id));
					const selected = choices.chooseFromOwnHand(
						state,
						ev.player,
						remaining,
					);

					assertDefined(selected);
					toDiscard.push(selected);
				}
				toDiscard.forEach((id) => {
					childResults.push(
						performIn(
							state,
							{
								kind: "change zone",
								object: id,
								from: "hand",
								to: "graveyard",
								cause: "discard",
								toController: ev.player,
							},
							choices,
							scope,
							depth + 1,
						),
					);
				});
				break;
			}

			const chosen =
				ev.cards.kind === "specific"
					? ev.cards.card
					: choices.chooseFromOwnHand(state, ev.player, p.hand);
			assertDefined(chosen);
			childResults.push(
				performIn(
					state,
					{
						kind: "change zone",
						object: chosen,
						from: "hand",
						to: "graveyard",
						cause: "discard",
						toController: ev.player,
					},
					choices,
					scope,
					depth + 1,
				),
			);
			break;
		}

		case "damage": {
			if (ev.amount <= 0) {
				happened = false;
				break;
			}
			if (ev.target.type === "player") {
				state.players[ev.target.player].life -= ev.amount;
				log(
					state,
					`${"  ".repeat(depth)}P${ev.target.player} -> ${state.players[ev.target.player].life} life`,
				);
			} else {
				const o = maybePermanent(state, ev.target.id);
				if (o?.zone !== "battlefield") {
					happened = false;
					break;
				}
				const characteristics = readObject(before, o.id);
				assert(characteristics.kind === "permanent");
				assert(
					!characteristics.currentCharacteristics.types.includes(
						"planeswalker",
					),
					"planeswalker damage is not implemented",
				);
				o.damage += ev.amount;
				if (ev.deathtouch) o.attributes.deathtouched = true;
				log(
					state,
					`${"  ".repeat(depth)}${name(state, o.id)} has ${o.damage} damage marked`,
				);
			}
			if (ev.lifelink) {
				childResults.push(
					performIn(
						state,
						{
							kind: "gain life",
							player: ev.sourceController,
							amount: ev.amount,
							source: ev.source,
						},
						choices,
						scope,
						depth + 1,
					),
				);
			}
			break;
		}

		case "destroy": {
			const o = maybePermanent(state, ev.object);
			if (o?.zone !== "battlefield") {
				happened = false;
				break;
			}
			const snapshot = readObject(before, o.id);
			assert(snapshot.kind === "permanent");
			const movement = performIn(
				state,
				{
					kind: "change zone",
					object: o.id,
					from: "battlefield",
					to: "graveyard",
					cause: "destroy",
					toController: snapshot.controller,
				},
				choices,
				scope,
				depth + 1,
			);
			childResults.push(movement);
			happened = movement.executed.some(
				(child) =>
					child.kind === "change zone" &&
					child.object === o.id &&
					child.from === "battlefield" &&
					child.to === "graveyard" &&
					child.cause === "destroy",
			);
			break;
		}

		case "regenerate": {
			const o = maybePermanent(state, ev.object);
			if (!o) {
				happened = false;
				break;
			}
			o.tapped = true;
			o.damage = 0;
			o.attacking = false;
			o.blocking = false;
			delete o.attributes.deathtouched;
			log(
				state,
				`${"  ".repeat(depth)}${name(state, o.id)} regenerates (tapped, damage removed, out of combat)`,
			);
			break;
		}

		case "change zone": {
			const newId = moveObject(state, ev.object, ev.from, ev.to, {
				toController: ev.toController,
				tapped: ev.entersTapped,
				counters: ev.entersWithCounters,
				copiableOverride: ev.copiableOverride,
				toBottom: ev.toBottom,
				spellTargets: ev.spellTargets,
			});
			created.push(newId);
			break;
		}

		case "add counters": {
			if (ev.amount <= 0) {
				throw new Error(
					"undefined behavior: tried to add non-natural quantity of counters.",
				);
				// happened = false;
				// break;
			}
			if (ev.target.type === "permanent") {
				const o = maybePermanent(state, ev.target.id);
				if (!o) {
					throw new Error(
						"undefined behavior: tried to add counters to a non-existent permanent.",
					);
				}
				// if (!o) {
				// 	happened = false;
				// 	break;
				// }
				o.counters[ev.counter] = (o.counters[ev.counter] ?? 0) + ev.amount;
				log(
					state,
					`${"  ".repeat(depth)}${name(state, o.id)} now has ${o.counters[ev.counter]} ${ev.counter}`,
				);
			} else {
				state.players[ev.target.player].counters[ev.counter] =
					(state.players[ev.target.player].counters[ev.counter] ?? 0) +
					ev.amount;
				log(
					state,
					`${"  ".repeat(depth)}${state.players[ev.target.player].id} now has ${state.players[ev.target.player].counters[ev.counter]} ${ev.counter}`,
				);
			}
			break;
		}
		case "remove counters": {
			if (ev.target.type === "player") {
				throw new Error("player counters not implemented");
			}
			const o = maybePermanent(state, ev.target.id);
			if (!o) {
				happened = false;
				break;
			}
			if (ev.counters === "all") {
				o.counters = {};
				break;
			}
			Object.entries(ev.counters).forEach(([_counter, amount]) => {
				const counter = _counter as CounterNames;
				if (amount === "all") {
					o.counters[counter] = 0;
					return;
				}
				if (o.counters[counter] === undefined)
					throw new Error(
						"undefined behavior: tried to remove a counter that wasn't present.",
					);
				if (o.counters[counter] < amount)
					throw new Error(
						"undefined behavior: tried to remove more counters than were present.",
					);
				o.counters[counter] -= amount;
			});
			break;
		}

		case "gain life": {
			if (ev.amount <= 0) {
				throw new Error(
					"undefined behavior: tried to gain non-natural quantity of life.",
				);
			}
			const p = state.players[ev.player];
			p.life += ev.amount;
			log(state, `${"  ".repeat(depth)}P${ev.player} -> ${p.life} life`);
			break;
		}
		case "lose life": {
			if (ev.amount <= 0) {
				throw new Error(
					"undefined behavior: tried to lose non-natural quantity of life.",
				);
			}
			const p = state.players[ev.player];
			p.life -= ev.amount;
			log(state, `${"  ".repeat(depth)}P${ev.player} -> ${p.life} life`);
			break;
		}

		case "add mana": {
			let total = 0;
			for (const type of MANA_TYPES) {
				const amount = ev.mana[type] ?? 0;
				if (!Number.isSafeInteger(amount) || amount < 0) {
					throw new Error(
						"undefined behavior: tried to add an invalid quantity of mana",
					);
				}
				total += amount;
			}
			if (total <= 0) {
				throw new Error("undefined behavior: tried to add no mana");
			}
			const pool = state.players[ev.player].manaPool;
			for (const type of MANA_TYPES) pool[type] += ev.mana[type] ?? 0;
			log(
				state,
				`${"  ".repeat(depth)}P${ev.player} mana pool -> ${MANA_TYPES.map((type) => `${pool[type]}${type.toUpperCase()}`).join(" ")}`,
			);
			break;
		}

		case "tap":
		case "untap": {
			const tapped = ev.kind === "tap";
			if (ev.ref.kind === "all") {
				const p = state.players[ev.ref.player];
				for (const o of permanentsInPlay(state).filter(
					(o) => o.controller === p.id,
				)) {
					if (o.tapped === tapped) continue;
					o.tapped = tapped;
					changed.push(o.id);
				}
				if (changed.length === 0) happened = false;
			} else {
				const o = maybePermanent(state, ev.ref.object);
				if (!o || o.tapped === tapped) {
					happened = false;
					break;
				}
				o.tapped = tapped;
				changed.push(o.id);
			}
			break;
		}
		case "begin turn":
		case "begin phase":
			// Structural continuation belongs to the turn scheduler. These events only
			// record that the replaceable boundary successfully happened.
			break;

		case "begin step":
			// Turn-based actions (untap, normal draw, combat declarations, etc.)
			// run only after the scheduler confirms this exact boundary executed.
			break;

		case "create token": {
			for (let i = 0; i < ev.amount; i++) {
				const t = spawnToken(
					state,
					ev.controller,
					characteristicsFromCardDef(card(ev.tokenDefinitionId)),
				);
				created.push(t.id);
				log(state, `${"  ".repeat(depth)}created ${name(state, t.id)}`);
			}
			break;
		}

		case "declare attackers": {
			// A declare-attackers occurrence must genuinely be in progress and belong
			// to the current turn.
			const progress = state.turnScheduler.progress;
			const location =
				progress.kind === "inTurn" ? progress.location : undefined;
			if (
				progress.kind !== "inTurn" ||
				location?.kind !== "step" ||
				location.step.kind !== "declare attackers"
			) {
				throw new IllegalAttackDeclarationError(
					`cannot declare attackers outside the declare attackers step (current step: "${location?.kind === "step" ? location.step.kind : "none"}")`,
				);
			}
			const currentTurn = progress.turn;
			if (ev.player !== currentTurn.player) {
				throw new IllegalAttackDeclarationError(
					`P${ev.player} declared attackers, but P${currentTurn.player} is the active player`,
				);
			}
			if (new Set(ev.attackers).size !== ev.attackers.length) {
				throw new IllegalAttackDeclarationError(
					"declared attackers must be unique",
				);
			}
			const eligible = new Set(eligibleAttackers(state, ev.player));
			for (const id of ev.attackers) {
				if (!eligible.has(id)) {
					throw new IllegalAttackDeclarationError(
						`${name(state, id)} is not an eligible attacker for P${ev.player}`,
					);
				}
			}
			// Validation above is exhaustive before any mutation, so this commits
			// atomically: either every selected attacker taps and attacks, or none do.
			for (const id of ev.attackers) {
				const o = permanent(state, id);
				o.attacking = true;
				// CR 508.1f / 702.20b: attacking taps the creature, unless it has
				// vigilance. Read the derived characteristics rather than the printed
				// card, so a granted or copied vigilance counts.
				const attackerSnapshot = readObject(before, id);
				assert(attackerSnapshot.kind === "permanent");
				if (
					!attackerSnapshot.currentCharacteristics.keywords.includes(
						"vigilance",
					)
				) {
					o.tapped = true;
				}
			}
			log(
				state,
				`${"  ".repeat(depth)}P${ev.player} declares ${ev.attackers.length} attacker(s)`,
			);
			break;
		}

		case "declare blockers": {
			// Mirror-image boundary check to "declare attackers", but keyed to the
			// declare blockers step and the defending (non-active) player.
			const progress = state.turnScheduler.progress;
			const location =
				progress.kind === "inTurn" ? progress.location : undefined;
			if (
				progress.kind !== "inTurn" ||
				location?.kind !== "step" ||
				location.step.kind !== "declare blockers"
			) {
				throw new IllegalBlockDeclarationError(
					`cannot declare blockers outside the declare blockers step (current step: "${location?.kind === "step" ? location.step.kind : "none"}")`,
				);
			}
			const currentTurn = progress.turn;
			const defender = (1 - currentTurn.player) as PlayerId;
			if (ev.player !== defender) {
				throw new IllegalBlockDeclarationError(
					`P${ev.player} declared blockers, but P${defender} is the defending player`,
				);
			}
			// A single blocker cannot be assigned to multiple attackers under the
			// base rules; multi-blockers (many blockers on one attacker) are allowed
			// and are represented by multiple distinct pairs.
			const usedBlockers = new Set<ObjectId>();
			const attackingIds = new Set(
				creaturesControlledBy(createReadContext(state), currentTurn.player)
					.filter((o) => o.attacking)
					.map((o) => o.id),
			);
			const eligible = new Set(eligibleBlockers(state, ev.player));
			for (const { blocker, attacker } of ev.blockers) {
				if (usedBlockers.has(blocker)) {
					throw new IllegalBlockDeclarationError(
						`${name(state, blocker)} cannot block multiple attackers`,
					);
				}
				usedBlockers.add(blocker);
				if (!eligible.has(blocker)) {
					throw new IllegalBlockDeclarationError(
						`${name(state, blocker)} is not an eligible blocker for P${ev.player}`,
					);
				}
				if (!attackingIds.has(attacker)) {
					throw new IllegalBlockDeclarationError(
						`${name(state, attacker)} is not a legal attacker to be blocked`,
					);
				}
			}
			// Atomic commit: either every assignment and blocker status is recorded,
			// or none is. Keep the pair order as the deterministic damage-assignment
			// order for the base engine's noninteractive combat model.
			state.blockAssignments = ev.blockers.map((assignment) => ({
				...assignment,
			}));
			for (const { blocker } of state.blockAssignments) {
				permanent(state, blocker).blocking = true;
			}
			log(
				state,
				`${"  ".repeat(depth)}P${ev.player} declares ${ev.blockers.length} blocker assignment(s)`,
			);
			break;
		}

		case "lose game": {
			const p = state.players[ev.player];
			if (!p.lost && !p.won) {
				p.lost = true;
				log(
					state,
					`${"  ".repeat(depth)}P${ev.player} loses the game (${ev.reason})`,
				);
			}
			break;
		}

		case "win game": {
			const p = state.players[ev.player];
			if (!p.lost && !p.won) {
				p.won = true;
				log(
					state,
					`${"  ".repeat(depth)}P${ev.player} wins the game (${ev.reason})`,
				);
			}
			break;
		}
		default:
			assertNever(ev);
	}

	const executed: GameEvent[] = [];
	for (const r of childResults) {
		executed.push(...r.executed);
		created.push(...r.created);
	}
	if (happened) {
		executed.push(ev);
		state.revision++;
		detectTriggers(state, createReadContext(state), ev, created, changed);
		if (ev.fact) scope.facts.add(ev.fact);
	}

	return { executed, created };
}

/* ------------------------------------------------------------------ *
 * Priority and the stack
 * ------------------------------------------------------------------ */

function putPendingTriggersOnStack(
	state: GameState,
	choices: AnyChoiceController,
	active: PlayerId,
): void {
	if (currentStepKind(state) === "untap") {
		/**
		 * 502.4:
		 * No player receives priority during the untap step, so no spells can be
		 * cast or resolve and no abilities can be activated or resolve. Any ability
		 * that triggers during this step will be held until the next time a player
		 * would receive priority, which is usually during the upkeep step.
		 *
		 * (See rule 503, "Upkeep Step.")
		 */
		return;
	}
	const nonactivePlayer = (1 - active) as PlayerId;
	const ordered: PendingTrigger[] = [];
	for (const controller of [active, nonactivePlayer] as const) {
		const controlled = state.pendingTriggers.filter(
			(pending) => pending.controller === controller,
		);
		ordered.push(...choices.chooseTriggerOrder(state, controller, controlled));
	}
	for (const pending of ordered) {
		const item: TriggeredAbilityStackItem = {
			id: state.nextStackItemId++ as StackItemId,
			kind: "triggered ability",
			...pending,
		};
		state.stack.push(item);
		log(state, `  [stack] ${item.text}`);
	}
	state.pendingTriggers.length = 0;
}

/**
 * Resolves the top object of a non-empty stack (CR 608). The caller decides
 * *whether* anything resolves — this only resolves what it is given.
 *
 * A spell and an ability leave the stack by different means, so each kind
 * resolves on its own terms below.
 */
function resolveTopOfStack(
	state: GameState,
	choices: AnyChoiceController,
): void {
	const entry = state.stack[state.stack.length - 1];
	assertDefined(entry, "nothing on the stack to resolve");
	if (entry.kind === "spell") {
		resolveSpell(state, choices, entry);
	} else {
		resolveStackAbility(state, choices, entry);
	}
}

/**
 * CR 608.3 / CR 608.2m for a spell.
 *
 * The entry is never popped: a spell leaves the stack by changing zones, and
 * moveObject removes its entry as part of that move. That is also what keeps
 * an instant or sorcery visible to its own effects while they resolve.
 */
function resolveSpell(
	state: GameState,
	choices: AnyChoiceController,
	entry: SpellStackEntry,
): void {
	const object = maybeObject(state, entry.objectId);
	assertDefined(object, `no spell object ${entry.objectId}`);
	assert(
		object.kind === "spell",
		`stack entry ${entry.objectId} is not a spell`,
	);

	// A copy of a spell has no card to read a spell ability from; its
	// instructions would have to come from the copy snapshot instead. Nothing
	// creates one yet, so this is unreachable rather than unimplemented.
	assert(
		object.representation.kind === "card",
		"resolving a copied spell is not supported",
	);

	const read = createReadContext(state);
	const snapshot = readObject(read, object.id);
	assert(snapshot.kind === "spell", "a spell object read back as another kind");
	const characteristics = snapshot.currentCharacteristics;

	log(state, `  [resolve] ${characteristics.name}#${object.id}`);

	// CR 608.3: a resolving permanent spell becomes a permanent, entering under
	// its controller.
	if (
		characteristics.types.some((type) => includes(PERMANENT_CARD_TYPES, type))
	) {
		performIn(
			state,
			{
				kind: "change zone",
				object: object.id,
				from: "stack",
				to: "battlefield",
				cause: "resolve",
				toController: object.controller,
			},
			choices,
			newScope(),
			0,
		);
		return;
	}

	// CR 608.2m: an instant or sorcery follows its own instructions and is then
	// put into its owner's graveyard as the last step of resolution.
	// TODO: "instants and sorceries you control have lifelink", which needs characteristics.
	const definition = card(object.representation.cardId).spell;
	assertDefined(
		definition,
		`${characteristics.name} has no spell ability to resolve`,
	);
	const target = requiredTargetDefinition(
		definition.targets,
		definition.effects,
	);
	assert(
		entry.targets.length === (target ? 1 : 0),
		"spell target binding count disagrees with its definition",
	);
	const binding = entry.targets[0];
	if (target)
		assert(binding?.slot === target.id, "spell has the wrong target slot");
	// CR 608.2b: with one required target, an illegal target stops every effect.
	const legal =
		!target ||
		(binding !== undefined &&
			isLegalTarget(read, target, binding.target, {
				controller: object.controller,
				source: object.id,
			}));
	if (legal) {
		/** Share a scope so facts can pass through the complete effect sequence. */
		resolveEffects(
			state,
			choices,
			{
				controller: object.controller,
				source: object.id,
				ability: null,
				targets: entry.targets,
			},
			definition.effects,
			newScope(),
		);
	} else {
		log(state, "  [illegal target] spell does not resolve");
	}
	performIn(
		state,
		{
			kind: "change zone",
			object: object.id,
			from: "stack",
			to: "graveyard",
			cause: legal ? "resolve" : "illegal target",
			toController: object.controller,
		},
		choices,
		newScope(),
		0,
	);
}

/**
 * CR 608.2m for an ability: unlike a spell it moves to no zone, it simply
 * ceases to exist. Nothing else will take it off the stack, so it is popped
 * here before its effects run.
 */
function resolveStackAbility(
	state: GameState,
	choices: AnyChoiceController,
	entry: TriggeredAbilityStackItem | ActivatedAbilityStackItem,
): void {
	const removed = state.stack.pop();
	assert(removed === entry, "the stack changed while resolving its top entry");

	log(state, `  [resolve] ${entry.text}`);

	/** Share a scope so facts can pass through the complete effect sequence. */
	resolveEffects(
		state,
		choices,
		{
			controller: entry.controller,
			source: entry.source,
			ability: entry,
			targets: [],
		},
		entry.effects,
		newScope(),
	);
}

/**
 * What a resolving object contributes to its own effects: the two fields every
 * effect reads, plus the stack item itself when the resolving object is an
 * ability. A resolving instant or sorcery has no stack item — it has no
 * ability id and no trigger — so `ability` is null for one.
 */
interface ResolutionSource {
	controller: PlayerId;
	source: ObjectId;
	ability: TriggeredAbilityStackItem | ActivatedAbilityStackItem | null;
	targets: TargetBindings;
}

function resolveEffects(
	state: GameState,
	choices: AnyChoiceController,
	item: ResolutionSource,
	effects: EffectDef[],
	scope: Scope,
): void {
	for (const effect of effects) {
		if (effect.kind === "may") {
			const decider =
				effect.decider === "you"
					? item.controller
					: ((1 - item.controller) as PlayerId);
			// chooseOptional puts the whole stack item in its choice request, so
			// only an ability can ask this today. No spell the compiler accepts
			// has an optional effect, making this unreachable rather than a
			// missing feature.
			assertDefined(
				item.ability,
				"optional effects on a resolving spell are not implemented",
			);
			if (choices.chooseOptional(state, item.ability, decider))
				resolveEffects(state, choices, item, effect.effects, scope);
			continue;
		}
		let bound = effect;
		if (
			(effect.kind === "damage" || effect.kind === "destroy") &&
			typeof effect.target === "string"
		) {
			const binding = item.targets[0];
			assert(
				binding?.slot === effect.target,
				"effect has no matching target binding",
			);
			bound = { ...effect, target: binding.target };
		}
		performIn(state, effectToEvent(state, item, bound), choices, scope, 0);
	}
}

function effectToEvent(
	state: GameState,
	item: Pick<TriggeredAbilityStackItem, "controller" | "source">,
	effect: Exclude<EffectDef, { kind: "may" }>,
): GameEvent {
	const player = (relative: "you" | "opponent") =>
		relative === "you" ? item.controller : ((1 - item.controller) as PlayerId);
	switch (effect.kind) {
		case "gain-life":
			return {
				kind: "gain life",
				player: player(effect.player),
				amount: effect.amount,
			};
		case "lose-life":
			return {
				kind: "lose life",
				player: player(effect.player),
				amount: effect.amount,
			};
		case "draw":
			return {
				kind: "draw cards",
				player: player(effect.player),
				amount: effect.amount,
			};
		case "discard": {
			assert(
				effect.amount === 1,
				"discarding multiple cards is not implemented",
			);
			if (effect.selector === "any") {
				return {
					kind: "discard",
					player: player(effect.player),
					cards: { kind: "any" },
				};
			}
			if (effect.selector === "random") {
				throw new Error("discard at random not implemented");
			}
			throw new Error("unexpected discard effect kind");
		}
		case "damage": {
			assert(typeof effect.target !== "string", "damage target is unbound");
			const source = readObject(createReadContext(state), item.source);
			assert(
				source.kind === "spell" || source.kind === "permanent",
				"damage source has no characteristics",
			);
			const characteristics = source.currentCharacteristics;
			return {
				kind: "damage",
				source: item.source,
				sourceController: item.controller,
				sourceColors: [...characteristics.colors],
				target: effect.target,
				amount: effect.amount,
				combat: false,
				deathtouch: false,
				lifelink: characteristics.keywords.includes("lifelink"),
				unpreventable: false,
			};
		}
		case "destroy":
			assert(
				typeof effect.target !== "string" && effect.target.type === "permanent",
				"destroy requires a bound permanent target",
			);
			return {
				kind: "destroy",
				object: effect.target.id,
				source: item.source,
				noRegen: false,
			};
		case "modify-pt":
			throw new Error("temporary P/T effects are not implemented");
		case "add-mana":
			return {
				kind: "add mana",
				player: player(effect.player),
				source: item.source,
				mana: effect.mana,
			};
	}
}

/**
 * CR 601.3 / CR 307.1: when a spell may be *begun*. The engine has no flash and
 * no "as though" effects, so the whole rule is: instants any time you have
 * priority, everything else only at sorcery speed.
 */
function doTimingRestrictionsAllowCast(
	pv: PermanentView,
	state: GameState,
	player: PlayerId,
): boolean {
	assert(
		state.turnScheduler.progress.kind === "inTurn",
		"tried to cast outside a game",
	);
	// TODO: "you may cast x as though it had flash"

	assert(pv.types.length > 0, "object has no types");

	if (pv.types.includes("instant")) {
		assert(pv.types.length === 1, "instant type must be the only type");
		return true;
	}

	// CR 307.1: sorcery timing. A main phase of your own turn, with the stack
	// empty. Every non-instant card type shares this restriction, so unlike the
	// instant case above there is nothing per-type left to check.
	if (turnLocation(state)?.kind !== "mainPhase") return false;
	if (activePlayer(state) !== player) return false;
	if (state.stack.length !== 0) return false;

	return true;
}

/**
 * The mana a cost demands, split into the colored part (which only that color
 * can pay) and the generic part (which anything can pay).
 *
 * `CardDefManaCost` spells generic as `c`, which is *not* the `c` of
 * {@link ManaType}: the former means "one mana of any type", the latter means
 * one colorless mana. Keeping them apart is the whole reason this returns a
 * split rather than a `ManaAmount`.
 */
interface ManaCostBreakdown {
	colored: Partial<Record<Color, number>>;
	generic: number;
}

function manaCostBreakdown(cost: CardDefManaCost): ManaCostBreakdown | null {
	if (cost === "none") return null;
	if (cost === "zero") return { colored: {}, generic: 0 };
	const colored: Partial<Record<Color, number>> = {};
	for (const color of COLORS) {
		const amount = cost[color] ?? 0;
		assert(
			Number.isSafeInteger(amount) && amount >= 0,
			`invalid ${color} quantity in mana cost`,
		);
		if (amount > 0) colored[color] = amount;
	}
	const generic = cost.c ?? 0;
	assert(
		Number.isSafeInteger(generic) && generic >= 0,
		"invalid generic quantity in mana cost",
	);
	return { colored, generic };
}

/**
 * The exact mana to spend from `pool` for `cost`, or null if the pool cannot
 * pay it. Pool-only: untapped sources are deliberately not considered, so a
 * player taps for mana first and then casts.
 *
 * Colored requirements are satisfied first, since only their own color can pay
 * them. Whatever generic remains is then paid in a fixed order — colorless
 * first, because nothing else can want it, then colors in WUBRG order. That is
 * a deterministic engine choice rather than a player decision: it can spend
 * mana the player was saving, but it never fails a payment that some other
 * assignment would have made, because after the colored requirements are met
 * every remaining unit of mana is interchangeable for generic.
 */
export function planManaPayment(
	pool: DeepReadOnly<ManaPool>,
	cost: CardDefManaCost,
): ManaAmount | null {
	const breakdown = manaCostBreakdown(cost);
	if (!breakdown) return null;

	const payment: ManaPool = { w: 0, u: 0, b: 0, r: 0, g: 0, c: 0 };
	const remaining: ManaPool = { ...pool };

	for (const color of COLORS) {
		const required = breakdown.colored[color] ?? 0;
		if (remaining[color] < required) return null;
		remaining[color] -= required;
		payment[color] += required;
	}

	let generic = breakdown.generic;
	// Colorless first: it is the only kind no colored requirement could have
	// wanted, so spending it can never make a later payment impossible.
	for (const type of ["c", ...COLORS] as const) {
		if (generic === 0) break;
		const spend = Math.min(generic, remaining[type]);
		remaining[type] -= spend;
		payment[type] += spend;
		generic -= spend;
	}
	if (generic > 0) return null;

	return payment;
}

/**
 * The single required target slot a spell or ability declares, or null, after
 * checking that its targets and instructions fall inside the executable
 * subset. Every announcement path runs this before it can spend a cost, so an
 * unsupported definition can never leave a half-paid cast behind.
 */
function requiredTargetDefinition(
	targets: TargetDef[],
	effects: EffectDef[],
): TargetDef | null {
	assert(targets.length <= 1, "multiple target slots are not implemented");
	const target = targets[0] ?? null;
	if (target) {
		assert(
			target.min === 1 && target.max === 1,
			"only one required target is implemented",
		);
	}
	const check = (effect: EffectDef): void => {
		if (effect.kind === "may") {
			for (const inner of effect.effects) check(inner);
			return;
		}
		assert(
			effect.kind !== "modify-pt",
			"temporary P/T effects are not implemented",
		);
		if (effect.kind !== "damage" && effect.kind !== "destroy") return;
		assert(
			target !== null && effect.targetSlot === target.id,
			"effect must reference its ability's target slot",
		);
		if (effect.kind === "destroy") {
			assert(
				target.legal.kind === "permanent",
				"destroy requires a permanent target",
			);
		}
	};
	for (const effect of effects) check(effect);
	return target;
}

/**
 * CR 115.4 / CR 608.2b: announcement and resolution ask exactly the same
 * question, of current characteristics. `ctx` supplies what a restriction
 * reads relative to the spell or ability itself.
 */
function isLegalTarget(
	read: ReadContext,
	definition: TargetDef,
	target: EntityRef,
	ctx: TargetContext,
): boolean {
	if (target.type === "player") {
		return (
			(definition.legal.kind === "player" ||
				definition.legal.kind === "any-target") &&
			!read.state.players[target.player].lost &&
			!read.state.players[target.player].won
		);
	}
	if (definition.legal.kind === "player") return false;
	const snapshot = read.view.objects.get(target.id);
	// CR 608.2b: a target that left the zone it was targeted in is illegal, and
	// the object that replaced it is a different object with a different id.
	if (snapshot?.kind !== "permanent") return false;
	const object = flattenSnapshot(snapshot);
	if (definition.legal.kind === "any-target") {
		// CR 115.4: "any target" is a creature, a planeswalker, a battle, or a
		// player; the engine has no battles.
		return (
			object.types.includes("creature") || object.types.includes("planeswalker")
		);
	}
	return selectorMatches(definition.legal.selector, object, {
		controller: ctx.controller,
		id: ctx.source,
	});
}

function legalTargets(
	read: ReadContext,
	definition: TargetDef,
	ctx: TargetContext,
): EntityRef[] {
	const candidates: EntityRef[] = [
		{ type: "player", player: 0 },
		{ type: "player", player: 1 },
		...read.state.battlefield.map(
			(id): EntityRef => ({ type: "permanent", id }),
		),
	];
	return candidates.filter((target) =>
		isLegalTarget(read, definition, target, ctx),
	);
}

/**
 * Whether `player` could begin casting `object` from hand right now, under the
 * engine's deliberate simplification that a spell never goes on the stack and
 * then fails payment (so affordability is decided here, before anything moves).
 */
function canCast(
	object: DeepReadOnly<CardObject>,
	state: GameState,
	read: ReadContext,
	player: PlayerId,
): boolean {
	// TODO: this is simplified, and only accounts for the basics of casting
	// from hand. it does not account for special cast actions.
	assert(object.kind === "card");
	assert(object.zone === "hand");
	assert(object.owner === player);

	const pv = flattenSnapshot(readObject(read, object.id));

	// CR 202.1: a card with no mana cost cannot be cast without an alternative
	// cost, and the engine has none.
	if (pv.manaCost === "none") return false;

	// CR 305.1: lands are played as a special action, never cast.
	if (pv.types.includes("land")) return false;

	if (!doTimingRestrictionsAllowCast(pv, state, player)) return false;

	if (planManaPayment(state.players[player].manaPool, pv.manaCost) === null)
		return false;
	const definition = card(object.cardId).spell;
	if (pv.types.some((type) => includes(SPELL_CARD_TYPES, type))) {
		assertDefined(definition, `${pv.name} has no spell definition`);
		const target = spellTargetDefinition(definition);
		if (target && legalSpellTargets(read, target).length === 0) return false;
	} else {
		assert(
			!definition?.targets.length,
			"targeted permanent spells are not implemented",
		);
	}
	return true;
}

function castableSpells(
	state: GameState,
	read: ReadContext,
	player: PlayerId,
): CastAction[] {
	const castable: CastAction[] = [];
	for (const objectId of state.players[player].hand) {
		const object = maybeObject(state, objectId);
		assertDefined(object, `hand contains missing object ${objectId}`);
		assert(
			object.kind === "card" || object.kind === "nonbattlefield-token",
			`hand contains unexpected object kind ${object.kind}`,
		);
		// CR 704.5d will remove a token in hand; it is never castable meanwhile.
		if (object.kind !== "card") continue;
		if (canCast(object, state, read, player)) {
			castable.push({ kind: "cast", card: objectId });
		}
	}
	return castable;
}

function canPlayOrdinaryLand(state: GameState, player: PlayerId): boolean {
	const location = turnLocation(state);
	return (
		player === activePlayer(state) &&
		location?.kind === "mainPhase" &&
		state.stack.length === 0 &&
		state.players[player].landsPlayed < 1
	);
}

function activatedAbilityActions(
	state: GameState,
	player: PlayerId,
	read: ReadContext,
): ActivateAbilityAction[] {
	if (state.turnScheduler.progress.kind !== "inTurn") return [];
	if (currentStepKind(state) === "untap") return [];
	if (currentStepKind(state) === "cleanup" && state.stack.length === 0)
		return [];
	return state.battlefield.flatMap((id) => {
		const object = maybeObject(state, id);
		if (
			object?.kind !== "permanent" ||
			object.controller !== player ||
			object.tapped
		)
			return [];
		const snapshot = readObject(read, id);
		if (snapshot.kind !== "permanent") return [];
		const actions: ActivateAbilityAction[] = [];
		for (const ability of snapshot.currentCharacteristics.abilities.activated) {
			const definition = getAbilityDefinition("activated", ability);
			if (
				definition.costs.length === 1 &&
				definition.costs[0]?.kind === "tap-self" &&
				(definition.kind === "mana" || definition.targets.length === 0)
			) {
				actions.push({ kind: "activate ability", source: id, ability });
			}
		}
		return actions;
	});
}

/** Actions currently offered to a player receiving priority. */
export function getObservableActions(
	state: GameState,
	player: PlayerId,
): PriorityAction[] {
	const actions: PriorityAction[] = [{ kind: "pass" }];
	const read = createReadContext(state);
	if (canPlayOrdinaryLand(state, player)) {
		for (const id of state.players[player].hand) {
			const object = maybeObject(state, id);
			if (object?.kind !== "card" || object.zone !== "hand") continue;
			const snapshot = readObject(read, id);
			if (
				snapshot.kind === "card" &&
				snapshot.currentCharacteristics.types.includes("land")
			) {
				actions.push({ kind: "play land", card: id });
			}
		}
	}
	actions.push(...activatedAbilityActions(state, player, read));
	actions.push(...castableSpells(state, read, player));
	return actions;
}

/**
 * Executes a currently possessed fixed-cost activated ability. The priority
 * holder is supplied by the scheduler and all legality is rechecked before the
 * tap cost mutates canonical state.
 */
export function executeAbilityAction(
	state: GameState,
	priorityPlayer: PlayerId,
	action: ActivateAbilityAction,
	source: ChoiceSource,
): void {
	activateAbilityIn(state, priorityPlayer, action, asChoiceController(source));
}

function activateAbilityIn(
	state: GameState,
	priorityPlayer: PlayerId,
	action: ActivateAbilityAction,
	choices: AnyChoiceController,
): void {
	if (state.turnScheduler.progress.kind !== "inTurn") {
		throw new IllegalAbilityActivationError(
			"an ability cannot be activated outside a turn",
		);
	}
	if (currentStepKind(state) === "untap") {
		throw new IllegalAbilityActivationError(
			"an ability cannot be activated during the untap step",
		);
	}
	if (currentStepKind(state) === "cleanup" && state.stack.length === 0) {
		throw new IllegalAbilityActivationError(
			"an ability cannot be activated during an ordinary cleanup step",
		);
	}

	const object = maybeObject(state, action.source);
	if (object?.kind !== "permanent" || object.zone !== "battlefield") {
		throw new IllegalAbilityActivationError(
			`object ${action.source} is not a permanent on the battlefield`,
		);
	}
	if (object.controller !== priorityPlayer) {
		throw new IllegalAbilityActivationError(
			`P${priorityPlayer} does not control object ${action.source}`,
		);
	}
	if (object.tapped) {
		throw new IllegalAbilityActivationError(
			`object ${action.source} is already tapped`,
		);
	}

	const snapshot = readObject(createReadContext(state), object.id);
	assert(snapshot.kind === "permanent");
	if (
		!snapshot.currentCharacteristics.abilities.activated.includes(
			action.ability,
		)
	) {
		throw new IllegalAbilityActivationError(
			`object ${action.source} does not have ability ${action.ability}`,
		);
	}
	const ability = getAbilityDefinition("activated", action.ability);
	if (ability.kind === "activated") {
		assert(
			ability.targets.length === 0,
			"targeted activated abilities are not implemented",
		);
	}
	if (ability.costs.length !== 1 || ability.costs[0]?.kind !== "tap-self") {
		throw new IllegalAbilityActivationError(
			`ability ${action.ability} does not have the supported tap-self cost`,
		);
	}

	const context = { source: object.id, controller: priorityPlayer };
	const events =
		ability.kind === "mana"
			? ability.effects.map((effect) => {
					if (effect.kind !== "add-mana") {
						throw new IllegalAbilityActivationError(
							"only fixed mana production is supported for mana abilities",
						);
					}
					let total = 0;
					for (const type of COLORS) {
						const amount = effect.mana[type] ?? 0;
						if (!Number.isSafeInteger(amount) || amount < 0) {
							throw new IllegalAbilityActivationError(
								`mana ability ${action.ability} produces an invalid quantity`,
							);
						}
						total += amount;
					}
					if (total <= 0) {
						throw new IllegalAbilityActivationError(
							`mana ability ${action.ability} produces no mana`,
						);
					}
					return effectToEvent(state, context, effect);
				})
			: [];
	if (ability.kind === "activated") {
		for (const effect of ability.effects) {
			if (
				effect.kind === "draw" ||
				effect.kind === "gain-life" ||
				effect.kind === "lose-life"
			) {
				continue;
			}
			if (effect.kind === "discard") {
				assert(
					effect.amount === 1,
					"discarding multiple cards is not implemented",
				);
				if (effect.selector === "any") continue;
				throw new IllegalAbilityActivationError(
					"discarding at random is not supported for activated abilities",
				);
			}
			throw new IllegalAbilityActivationError(
				`effect ${effect.kind} is not supported for activated abilities`,
			);
		}
	}
	const scope = newScope();
	const payment = performIn(
		state,
		{ kind: "tap", ref: { kind: "object", object: object.id } },
		choices,
		scope,
		0,
	);
	if (
		!payment.executed.some(
			(event) =>
				event.kind === "tap" &&
				event.ref.kind === "object" &&
				event.ref.object === object.id,
		)
	) {
		throw new IllegalAbilityActivationError(
			`the tap cost for ability ${action.ability} was not paid`,
		);
	}
	if (ability.kind === "mana") {
		log(state, `  [mana ability] ${ability.text}`);
		for (const event of events) performIn(state, event, choices, scope, 0);
	} else {
		const item: ActivatedAbilityStackItem = {
			id: state.nextStackItemId++ as StackItemId,
			kind: "activated ability",
			source: object.id,
			abilityId: action.ability,
			controller: priorityPlayer,
			text: ability.text,
			effects: structuredClone(ability.effects),
		};
		state.stack.push(item);
		state.revision++;
		log(state, `  [stack] ${item.text}`);
	}
}

/**
 * Casts a spell for the priority holder supplied by the scheduler, putting it
 * onto the stack (CR 601.2). Timing, actor, card, zone and affordability are
 * all rechecked before anything mutates.
 *
 * The engine deliberately simplifies CR 601.2: costs are locked in and paid
 * from the mana pool *before* the card moves, so a spell can never sit on the
 * stack with its payment unresolved. Mana abilities are therefore activated
 * beforehand at priority rather than during casting.
 */
export function executeCastAction(
	state: GameState,
	priorityPlayer: PlayerId,
	action: CastAction,
	source: ChoiceSource,
): void {
	castSpellIn(state, priorityPlayer, action, asChoiceController(source));
}

function castSpellIn(
	state: GameState,
	priorityPlayer: PlayerId,
	action: CastAction,
	choices: AnyChoiceController,
): void {
	if (state.turnScheduler.progress.kind !== "inTurn") {
		throw new IllegalCastError("a spell cannot be cast outside a turn");
	}

	const object = maybeObject(state, action.card);
	if (
		object?.kind !== "card" ||
		object.zone !== "hand" ||
		object.owner !== priorityPlayer ||
		!state.players[priorityPlayer].hand.includes(action.card)
	) {
		throw new IllegalCastError(
			`object ${action.card} is not a card in P${priorityPlayer}'s hand`,
		);
	}

	const read = createReadContext(state);
	const pv = flattenSnapshot(readObject(read, action.card));

	if (pv.manaCost === "none") {
		throw new IllegalCastError(
			`${pv.name} has no mana cost and cannot be cast`,
		);
	}
	if (pv.types.includes("land")) {
		throw new IllegalCastError(`${pv.name} is a land and is played, not cast`);
	}
	if (!doTimingRestrictionsAllowCast(pv, state, priorityPlayer)) {
		throw new IllegalCastError(
			`P${priorityPlayer} cannot cast ${pv.name} at this time`,
		);
	}

	const payment = planManaPayment(
		state.players[priorityPlayer].manaPool,
		pv.manaCost,
	);
	if (!payment) {
		throw new IllegalCastError(
			`P${priorityPlayer} cannot pay ${pv.name}'s mana cost from their mana pool`,
		);
	}

	const definition = card(object.cardId).spell;
	let targets: TargetBindings = [];
	if (pv.types.some((type) => includes(SPELL_CARD_TYPES, type))) {
		assertDefined(definition, `${pv.name} has no spell definition`);
		const target = spellTargetDefinition(definition);
		if (target) {
			const candidates = legalSpellTargets(read, target);
			if (candidates.length === 0)
				throw new IllegalCastError(`${pv.name} has no legal target`);
			const chosen = choices.chooseTarget(
				state,
				priorityPlayer,
				action.card,
				target,
				candidates,
			);
			if (!isLegalSpellTarget(createReadContext(state), target, chosen)) {
				throw new IllegalCastError(
					`${pv.name}'s chosen target is no longer legal`,
				);
			}
			targets = [{ slot: target.id, target: chosen }];
		}
	} else {
		assert(
			!definition?.targets.length,
			"targeted permanent spells are not implemented",
		);
	}

	// Payment is deducted directly rather than as an event: spending mana is a
	// cost, not something that happens to a player, so nothing may replace or
	// trigger off it. The move to the stack below is the replaceable part.
	const pool = state.players[priorityPlayer].manaPool;
	for (const type of MANA_TYPES) {
		const spent = payment[type] ?? 0;
		assert(
			pool[type] >= spent,
			`payment plan spends ${spent} ${type} from a pool holding ${pool[type]}`,
		);
		pool[type] -= spent;
	}
	state.revision++;
	log(
		state,
		`  [cast] P${priorityPlayer} pays ${
			MANA_TYPES.map((type) =>
				payment[type] ? `${payment[type]}${type.toUpperCase()}` : "",
			)
				.filter(Boolean)
				.join(" ") || "nothing"
		} for ${pv.name}`,
	);

	performIn(
		state,
		{
			kind: "change zone",
			object: action.card,
			from: "hand",
			to: "stack",
			cause: "cast",
			toController: priorityPlayer,
			spellTargets: targets,
		},
		choices,
		newScope(),
		0,
	);
}

/**
 * Executes a land action for the priority holder supplied by the scheduler.
 * Timing, actor, card, zone, and allowance are rechecked before mutation.
 */
export function executeLandAction(
	state: GameState,
	priorityPlayer: PlayerId,
	action: PlayLandAction,
	source: ChoiceSource,
): void {
	playLandIn(state, priorityPlayer, action, asChoiceController(source));
}

function playLandIn(
	state: GameState,
	priorityPlayer: PlayerId,
	action: PlayLandAction,
	choices: AnyChoiceController,
): void {
	const active = activePlayer(state);
	if (priorityPlayer !== active) {
		throw new IllegalLandPlayError(
			active === null
				? `P${priorityPlayer} cannot play a land outside a turn`
				: `P${priorityPlayer} cannot play a land while P${active} is active`,
		);
	}
	const location = turnLocation(state);
	if (location?.kind !== "mainPhase") {
		throw new IllegalLandPlayError(
			"a land can be played only during a main phase",
		);
	}
	if (state.stack.length !== 0) {
		throw new IllegalLandPlayError(
			"a land cannot be played while the stack is nonempty",
		);
	}
	if (state.players[priorityPlayer].landsPlayed >= 1) {
		throw new IllegalLandPlayError(
			"the ordinary one-land-per-turn limit is exhausted",
		);
	}

	const object = maybeObject(state, action.card);
	if (
		object?.kind !== "card" ||
		object.zone !== "hand" ||
		!state.players[priorityPlayer].hand.includes(action.card)
	) {
		throw new IllegalLandPlayError(
			`object ${action.card} is not in P${priorityPlayer}'s hand`,
		);
	}
	const read = createReadContext(state);
	const snapshot = readObject(read, action.card);
	if (
		snapshot.kind !== "card" ||
		!snapshot.currentCharacteristics.types.includes("land")
	) {
		throw new IllegalLandPlayError(`object ${action.card} is not a land`);
	}

	performIn(
		state,
		{
			kind: "change zone",
			object: action.card,
			from: "hand",
			to: "battlefield",
			cause: "play land",
			toController: priorityPlayer,
		},
		choices,
		newScope(),
		0,
	);
	state.players[priorityPlayer].landsPlayed++;
	state.revision++;
}

/**
 * Settle the engine's current priority window. Players currently auto-pass, so
 * every queued trigger is put on the stack and the stack resolves completely.
 *
 * priorityRound(state, agents):
   1. checkStateBasedActions        // ← moved out of perform()
   2. put pending triggers on the stack, APNAP, controller orders their own
   3. active player gets priority, then each in turn order
   4. all pass + stack non-empty  -> resolve top, goto 1
   5. all pass + stack empty      -> step ends
 */
export function settlePriority(state: GameState, source: ChoiceSource): void {
	settlePriorityIn(state, asChoiceController(source));
}

function settlePriorityIn(
	state: GameState,
	choices: AnyChoiceController,
): void {
	// Priority, and the APNAP order triggers follow onto the stack, are both
	// defined relative to the active player. Neither exists outside a turn.
	const active = activePlayer(state);
	assertDefined(active, "no player receives priority outside a turn");
	let lastWasPass = false;
	let priority: 0 | 1 = active;

	// Runaway guard, not a rules limit. Each resolution costs a full priority
	// round (both players pass again per CR 117.3b), so this must be at least
	// twice the deepest stack the engine can build.
	for (let pass = 0; pass < 256; pass++) {
		checkStateBasedActionsIn(state, choices);
		if (gameOver(state)) return;

		putPendingTriggersOnStack(state, choices, active);
		// players only get priority in the untap & cleanup steps
		// if something goes on the stack.
		const step = currentStepKind(state);
		if (step === "untap" && state.stack.length === 0) return;

		if (step === "cleanup") {
			if (state.stack.length === 0) return;

			assert(state.turnScheduler.remainingSteps.length === 0);
			const progress = state.turnScheduler.progress;
			assert(progress.kind === "inTurn");
			assert(progress.location?.kind === "step");

			state.turnScheduler.remainingSteps.push({
				id: nextScheduleId(state) as StepId,
				phaseId: progress.location.phase.id,
				turnId: progress.turn.id,
				kind: "cleanup",
			});
		}
		const action = choices.choosePriorityAction(
			state,
			priority,
			getObservableActions(state, priority),
		);

		if (action.kind === "play land") {
			playLandIn(state, priority, action, choices);
			// A special action neither passes nor changes who has priority.
			lastWasPass = false;
			continue;
		}
		if (action.kind === "activate ability") {
			activateAbilityIn(state, priority, action, choices);
			// CR 117.3c: the activating player receives priority again. Mana
			// abilities resolve immediately; other activated abilities are stacked.
			lastWasPass = false;
			continue;
		}
		if (action.kind === "cast") {
			castSpellIn(state, priority, action, choices);
			// CR 117.3c: the caster receives priority again after casting, and the
			// round re-opens, so a pass already made no longer stands.
			lastWasPass = false;
			continue;
		}
		if (action.kind !== "pass") {
			assertNever(action);
		}
		if (lastWasPass) {
			if (state.stack.length === 0) return;
			resolveTopOfStack(state, choices);
			// CR 117.3b. The active player receives priority after a resolution,
			// which re-opens the round: step 4's "goto 1" above.
			lastWasPass = false;
			priority = active;
		} else {
			lastWasPass = true;
			priority = priority === 0 ? 1 : 0;
		}
	}
	throw new Error("priority loop did not settle");
}

function priority(state: GameState, choices: AnyChoiceController) {
	settlePriorityIn(state, choices);
}

/* ------------------------------------------------------------------ *
 * Turn progression
 * ------------------------------------------------------------------ */
function performPreGameActions(
	state: GameState,
	choices: AnyChoiceController,
	step: PreGameStepKind,
): void {
	switch (step) {
		case "shuffle":
			// CR 103.2. Both libraries are shuffled before anything is drawn.
			for (const player of state.players) shuffleLibrary(state, player.id);
			break;
		case "opening hand": // increment 2: deal 7 through the draw path
		case "mulligan": // increment 7
		case "opening hand actions": // increment 8: Leyline
			break;
		default:
			assertNever(step);
	}
}
/** CR 703 actions, dispatched only after the corresponding step began. */
function performTurnBasedActions(
	state: GameState,
	choices: AnyChoiceController,
	step: StepOccurrence,
	active: PlayerId,
): void {
	switch (step.kind) {
		case "untap":
			performIn(
				state,
				{
					kind: "untap",
					ref: { kind: "all", player: active },
				},
				choices,
				newScope(),
				0,
			);
			break;
		case "draw":
			state.players[active].drawnInDrawStep = 0;
			performIn(
				state,
				{ kind: "draw", player: active },
				choices,
				newScope(),
				0,
			);
			break;
		case "cleanup":
			performIn(
				state,
				{
					kind: "discard",
					player: active,
					cards: { kind: "hand-size" },
				},
				choices,
				newScope(),
				0,
			);
			// This is only the noninteractive part of CR 514. Repeated cleanup
			// steps still need to be added when SBAs or triggers occur here.
			for (const id of state.battlefield) permanent(state, id).damage = 0;
			state.floating = state.floating.filter(
				(f) => !f.expired && f.expires !== "endOfTurn",
			);

			break;
		case "declare attackers": {
			// Ask once for a replayable subset, then commit it as one event. Battlefield
			// order is preserved so the offered options are stable and deterministic.
			const eligible = eligibleAttackers(state, active);
			const attackers = choices.chooseAttackers(state, active, eligible);
			performIn(
				state,
				{
					kind: "declare attackers",
					player: active,
					attackers,
				},
				choices,
				newScope(),
				0,
			);
			break;
		}
		case "end combat":
			// CR 506.4: attacking/blocking status doesn't persist past combat. Direct
			// mutation, not a replaceable event, matching the cleanup damage wipe below.
			for (const id of state.battlefield) {
				const o = permanent(state, id);
				o.attacking = false;
				o.blocking = false;
			}
			state.blockAssignments = [];
			break;
		case "combat damage": {
			// CR 510.2: all combat damage is assigned, then dealt, simultaneously.
			const defender = (1 - active) as PlayerId;
			const events: DamageEvent[] = [];
			const read = createReadContext(state);
			const blockedAttackers = new Set(
				state.blockAssignments.map(({ attacker }) => attacker),
			);
			const blockersByAttacker = new Map<ObjectId, ObjectId[]>();
			for (const { blocker, attacker } of state.blockAssignments) {
				const blockers = blockersByAttacker.get(attacker) ?? [];
				blockers.push(blocker);
				blockersByAttacker.set(attacker, blockers);
			}

			const damageEvent = (
				source: PermanentObject,
				characteristics: CreatureCharacteristicsSnapshot,
				target: EntityRef,
				amount: number,
			): DamageEvent => ({
				kind: "damage",
				source: source.id,
				sourceController: source.controller,
				sourceColors: characteristics.colors,
				target,
				amount,
				combat: true,
				// The engine has no deathtouch keyword yet; false is correct until
				// one is added.
				deathtouch: false,
				lifelink: characteristics.keywords.includes("lifelink"),
				unpreventable: false,
			});

			for (const id of state.battlefield) {
				const o = maybePermanent(state, id);
				if (!o?.attacking) continue;
				const snapshot = readObject(read, id);
				assert(snapshot.kind === "permanent");
				const characteristics = snapshot.currentCharacteristics;
				if (characteristics.kind !== "creature") continue;

				if (!blockedAttackers.has(id)) {
					if (characteristics.power > 0) {
						events.push(
							damageEvent(
								o,
								characteristics,
								{
									type: "player",
									player: defender,
								},
								characteristics.power,
							),
						);
					}
					continue;
				}

				// With no trample, a blocked attacker can assign damage only to the
				// creatures still blocking it. Assign lethal in declaration order,
				// putting any remainder on the final blocker.
				let remaining = Math.max(0, characteristics.power);
				const blockers = (blockersByAttacker.get(id) ?? []).filter(
					(blockerId) => maybePermanent(state, blockerId)?.blocking,
				);
				for (let index = 0; index < blockers.length && remaining > 0; index++) {
					const blockerId = blockers[index];
					assertDefined(blockerId);
					const blocker = maybePermanent(state, blockerId);
					assertDefined(blocker);
					const blockerSnapshot = readObject(read, blockerId);
					assert(blockerSnapshot.kind === "permanent");
					const blockerCharacteristics = blockerSnapshot.currentCharacteristics;
					if (blockerCharacteristics.kind !== "creature") continue;
					const amount =
						index === blockers.length - 1
							? remaining
							: Math.min(
									remaining,
									Math.max(
										0,
										blockerCharacteristics.toughness - blocker.damage,
									),
								);
					if (amount > 0) {
						events.push(
							damageEvent(
								o,
								characteristics,
								{
									type: "permanent",
									id: blockerId,
								},
								amount,
							),
						);
						remaining -= amount;
					}
				}
			}

			for (const { blocker, attacker } of state.blockAssignments) {
				const blockerObject = maybePermanent(state, blocker);
				const attackerObject = maybePermanent(state, attacker);
				if (!blockerObject?.blocking || !attackerObject?.attacking) continue;
				const blockerSnapshot = readObject(read, blocker);
				assert(blockerSnapshot.kind === "permanent");
				const characteristics = blockerSnapshot.currentCharacteristics;
				if (characteristics.kind !== "creature" || characteristics.power <= 0)
					continue;
				events.push(
					damageEvent(
						blockerObject,
						characteristics,
						{
							type: "permanent",
							id: attacker,
						},
						characteristics.power,
					),
				);
			}
			for (const ev of events) performIn(state, ev, choices, newScope(), 0);
			break;
		}
		case "upkeep":
		case "begin combat":
		case "end":
			// Their turn-based actions are not implemented yet.
			break;
		case "declare blockers": {
			// The defending player chooses which of their creatures block which
			// attackers. This deviates from the attacker model: blockers are
			// (blocker, attacker) pairs, not a plain list of IDs.
			const defender = (1 - active) as PlayerId;
			const attackers = creaturesControlledBy(createReadContext(state), active)
				.filter((o) => o.attacking)
				.map((o) => o.id);
			const eligible = eligibleBlockers(state, defender);
			const blockers = choices.chooseBlockers(
				state,
				defender,
				attackers,
				eligible,
			);
			performIn(
				state,
				{
					kind: "declare blockers",
					player: defender,
					blockers,
				},
				choices,
				newScope(),
				0,
			);
			break;
		}
		default:
			assertNever(step.kind);
	}
}

/**
 * Advances from one rules-defined turn location to the next. Structural
 * scheduler commands are consumed internally, so callers never observe a
 * partially installed turn, phase, or step.
 */
export interface AdvanceWithReplayResult {
	state: GameState;
	transcript: ChoiceTranscript;
	attempts: number;
}

/**
 * Runs one advance() against a disposable clone of the checkpoint. Pending
 * async choices unwind the synchronous engine; their answers are recorded and
 * the same advancement is replayed from the untouched checkpoint.
 */
export async function advanceWithReplay(
	checkpoint: GameState,
	agents: AgentPair,
	transcript: ChoiceTranscript = { version: 1, choices: [] },
): Promise<AdvanceWithReplayResult> {
	const baseline = structuredClone(checkpoint);
	const choices = ChoiceController.suspending(agents, transcript);

	for (let attempts = 1; ; attempts++) {
		const attempt = structuredClone(baseline);
		choices.rewind();

		try {
			advanceIn(attempt, choices);
			choices.assertComplete();
			return { state: attempt, transcript: choices.transcript(), attempts };
		} catch (error) {
			if (!(error instanceof ChoicePendingError)) throw error;
			choices.recordAnswer(error.request, await error.answer);
		}
	}
}

/**
 * Advances through the CR 103 pre-game and stops at the first rules-defined
 * location inside the first turn.
 *
 * Each pre-game step is its own scheduler transition, so reaching a turn takes
 * several calls to {@link advance}. No player receives priority before the
 * first turn begins, so nothing is decided by stopping in between: this
 * consumes every pre-game transition in one call.
 */
export function startGame(state: GameState, source: ChoiceSource): void {
	const choices = asChoiceController(source);
	// One transition per pre-game step, plus the one that installs the turn.
	for (let call = 0; call <= PRE_GAME_STEPS.length + 1; call++) {
		if (state.turnScheduler.progress.kind === "inTurn") return;
		advanceIn(state, choices);
	}
	throw new Error("the pre-game did not reach the first turn");
}

export function advance(state: GameState, source: ChoiceSource): void {
	advanceIn(state, asChoiceController(source));
}

function advanceIn(state: GameState, choices: AnyChoiceController): void {
	if (gameOver(state)) return;

	// Scheduler transitions and turn-based actions mutate canonical state outside
	// executeIn, so invalidate any read window held by the caller up front.
	state.revision++;
	const scheduler = state.turnScheduler;
	for (let transition = 0; transition < 64; transition++) {
		const command = scheduler.nextAction;

		switch (command.kind) {
			case "advancePreGameStep": {
				const step = scheduler.remainingPregameSteps.shift();
				if (!step) {
					scheduler.nextAction = { kind: "advanceTurn" };
					continue;
				}
				scheduler.progress = { kind: "pregame", step };
				performPreGameActions(state, choices, step);
				scheduler.nextAction = { kind: "finishPreGameStep" };
				// A pre-game step is a rules-defined location, exactly like a turn's
				// step. Unlike one, CR 103 opens no priority window, so there is no
				// priority() call before returning.
				return;
			}

			case "finishPreGameStep": {
				assert(scheduler.progress.kind === "pregame");
				scheduler.nextAction = { kind: "advancePreGameStep" };
				continue;
			}

			case "advanceTurn": {
				const turn = takeNextTurn(state);
				const result = performIn(
					state,
					{
						kind: "begin turn",
						turnId: turn.id,
						player: turn.player,
						isExtra: turn.isExtra,
					},
					choices,
					newScope(),
					0,
				);

				// Selection consumes the occurrence (and advances ordinary turn order),
				// but a skipped turn never becomes current.
				if (
					!result.executed.some(
						(ev) => ev.kind === "begin turn" && ev.turnId === turn.id,
					)
				) {
					scheduler.nextAction = { kind: "advanceTurn" };
					continue;
				}

				// The turn is now current even though no phase of it has begun,
				// so "whose turn is it" already answers with its player.
				scheduler.progress = { kind: "inTurn", turn, location: null };
				state.players[turn.player].landsPlayed = 0;
				scheduler.remainingSteps = [];
				scheduler.nextAction = { kind: "advancePhase", turn };
				continue;
			}

			case "advancePhase": {
				const { turn } = command;
				const phase = turn.remainingPhases.shift();
				if (!phase) {
					scheduler.remainingSteps = [];
					state.completedTurns++;
					scheduler.nextAction = { kind: "advanceTurn" };
					continue;
				}

				const mainRole =
					phase.kind === "main"
						? turn.mainPhasesBegun === 0
							? "precombat"
							: "postcombat"
						: undefined;
				const result = performIn(
					state,
					{
						kind: "begin phase",
						turnId: turn.id,
						phaseId: phase.id,
						player: turn.player,
						phase: phase.kind,
						mainRole,
					},
					choices,
					newScope(),
					0,
				);

				if (
					!result.executed.some(
						(ev) => ev.kind === "begin phase" && ev.phaseId === phase.id,
					)
				) {
					scheduler.nextAction = { kind: "advancePhase", turn };
					continue;
				}

				if (phase.kind === "main") {
					const role = mainRole ?? "precombat";
					turn.mainPhasesBegun++;
					scheduler.progress = {
						kind: "inTurn",
						turn,
						location: { kind: "mainPhase", phase, role },
					};
					scheduler.nextAction = { kind: "finishPhase" };
					priority(state, choices);
					return;
				}

				scheduler.remainingSteps = makeSteps(state, phase);
				scheduler.nextAction = { kind: "advanceStep", turn, phase };
				continue;
			}

			case "advanceStep": {
				const { turn, phase } = command;
				const step = scheduler.remainingSteps.shift();
				if (!step) {
					scheduler.nextAction = { kind: "finishPhase" };
					continue;
				}

				const result = performIn(
					state,
					{
						kind: "begin step",
						turnId: step.turnId,
						phaseId: step.phaseId,
						stepId: step.id,
						player: turn.player,
						step: step.kind,
					},
					choices,
					newScope(),
					0,
				);
				if (
					!result.executed.some(
						(ev) => ev.kind === "begin step" && ev.stepId === step.id,
					)
				) {
					scheduler.nextAction = { kind: "advanceStep", turn, phase };
					continue;
				}

				scheduler.progress = {
					kind: "inTurn",
					turn,
					location: { kind: "step", phase, step },
				};
				scheduler.nextAction = { kind: "finishStep" };
				performTurnBasedActions(state, choices, step, turn.player);
				// Untap has no priority window. Cleanup normally has none, but the
				// priority helper opens one if something triggered.
				priority(state, choices);
				return;
			}

			case "finishStep": {
				const progress = scheduler.progress;
				assert(progress.kind === "inTurn");
				assert(progress.location?.kind === "step");
				emptyManaPools(state);
				scheduler.nextAction = {
					kind: "advanceStep",
					turn: progress.turn,
					phase: progress.location.phase,
				};
				continue;
			}

			case "finishPhase": {
				const progress = scheduler.progress;
				assert(progress.kind === "inTurn");
				emptyManaPools(state);
				scheduler.remainingSteps = [];
				scheduler.nextAction = {
					kind: "advancePhase",
					turn: progress.turn,
				};
				continue;
			}

			default:
				assertNever(command);
		}
	}

	throw new Error("scheduler did not reach a rules-defined location");
}

export function gameOver(state: GameState): boolean {
	return state.players.some((p) => p.lost || p.won);
}

export function winner(state: GameState): PlayerId | null {
	const w = state.players.find((p) => p.won);
	if (w) return w.id;
	const losers = state.players.filter((p) => p.lost);
	if (losers.length === 1)
		return state.players.find((p) => !p.lost)?.id ?? null;
	return null;
}
