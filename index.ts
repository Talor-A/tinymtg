import {
	printedKeywordTriggers,
	prohibitionsFromKeywords,
} from "./abilities.ts";
import {
	type AgentPair,
	type AnyChoiceController,
	asChoiceController,
	ChoiceController,
	ChoicePendingError,
	type ChoiceSource,
	type ChoiceTranscript,
} from "./choices.ts";
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
	type ChooseFromTopChoiceAnswer,
	type ChooseFromTopResult,
	InvalidChoiceAnswerError,
	type ObjectChoiceReason,
	type ObjectChoiceRequest,
	type OptionalObjectChoiceInput,
	type RecordedChoice,
	type RequiredObjectChoiceInput,
	type ScryChoiceAnswer,
	type ScryResult,
	type SearchLibraryChoiceRequest,
	type SurveilChoiceAnswer,
	type SurveilResult,
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

/** A zone whose objects are cards rather than permanents or spells. */
export type CardZone = "library" | "hand" | "graveyard" | "exile";

/** Public zones supported as origins by one-object effects. */
export type PublicObjectZone = "battlefield" | "graveyard" | "exile";

/* ------------------------------------------------------------------ *
 * Colors
 * ------------------------------------------------------------------ */

const COLORS = ["w", "u", "b", "r", "g"] as const;
export type Color = (typeof COLORS)[number];

/**
 * A kind of mana that can exist in a player's pool: the five colors plus
 * colorless.
 */
const MANA_TYPES = [...COLORS, "c"] as const;
export type ManaType = (typeof MANA_TYPES)[number];

/**
 * A kind of requirement a mana cost can contain: every {@link ManaType}, plus
 * generic.
 */
export const MANA_COST_TYPES = [...MANA_TYPES, "n"] as const;
export type ManaCostType = (typeof MANA_COST_TYPES)[number];

/** Mana currently available to a player, including colorless mana. */
export type ManaPool = Record<ManaType, number>;

/** A quantity of one or more kinds of mana. Missing kinds mean zero. */
export type ManaAmount = Partial<ManaPool>;

export type Supertype = "legendary" | "basic" | "snow";

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
 * Turns, Phases, and Steps
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
	zone: CardZone;
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
	/** Set until this permanent has been continuously controlled since this
	 * controller's most recent turn began. Only creatures without haste are
	 * restricted by this state. */
	summoningSick: boolean;
	counters: PermanentCounterBag;
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
 * Counters
 * ------------------------------------------------------------------ */

export type PermanentCounter = "+1/+1" | "-1/-1" | "charge";
export type PlayerCounter = "poison";
export type PermanentCounterBag = Partial<Record<PermanentCounter, number>>;
export type PlayerCounterBag = Partial<Record<PlayerCounter, number>>;

function bagAfterRemoval<C extends PermanentCounter | PlayerCounter>(
	bag: Partial<Record<C, number>>,
	request: "all" | Partial<Record<C, number | "all">>,
): Partial<Record<C, number>> {
	if (request === "all") return {};
	const next: Partial<Record<C, number>> = { ...bag };
	for (const [counter, amount] of Object.entries(request) as [
		C,
		number | "all",
	][]) {
		if (amount === "all") {
			next[counter] = 0;
			continue;
		}
		const present = next[counter];
		if (present === undefined)
			throw new Error(
				"undefined behavior: tried to remove a counter that wasn't present.",
			);
		if (present < amount)
			throw new Error(
				"undefined behavior: tried to remove more counters than were present.",
			);
		next[counter] = present - amount;
	}
	return next;
}

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */
/**
 * Used for referencing entities in events.
 * TODO: this might be insufficient
 */
export type PlayerRef = { type: "player"; player: PlayerId };
export type CardRef = { type: "card"; id: ObjectId };
export type PermanentRef = { type: "permanent"; id: ObjectId };
export type SpellRef = { type: "spell"; id: ObjectId };
export type DamageRecipientRef = PlayerRef | PermanentRef;
export type EntityRef = PlayerRef | CardRef | PermanentRef | SpellRef;

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

/** A card was discarded to pay its own cycling ability's cost. */
interface CycleEvent extends EventCommon {
	kind: "cycle";
	player: PlayerId;
	/** The new card object created by the discard zone change. */
	card: ObjectId;
}

/** A spell has finished being cast and is now on the stack. */
interface CastEvent extends EventCommon {
	kind: "cast";
	player: PlayerId;
	spell: ObjectId;
}

interface MillEvent extends EventCommon {
	kind: "mill";
	player: PlayerId;
	amount: number;
}
/**
 * Exiling cards off the top of a library. This is the same operation as
 * {@link MillEvent} with a different destination, and is deliberately the same
 * shape: a player and a count, never the cards. Which cards move is decided as
 * each child zone change executes, not when the event is built.
 */
interface ExileTopEvent extends EventCommon {
	kind: "exile top";
	player: PlayerId;
	amount: number;
}
interface ScryEvent extends EventCommon {
	kind: "scry";
	player: PlayerId;
	amount: number;
}
interface SurveilEvent extends EventCommon {
	kind: "surveil";
	player: PlayerId;
	amount: number;
}

/**
 * Look at the top cards, put a fixed number into the player's hand, and put the
 * rest on the bottom in the order that player chooses. This is not a draw.
 */
interface ChooseFromTopEvent extends EventCommon {
	kind: "choose from top";
	player: PlayerId;
	amount: number;
	keep: number;
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
	recipient: DamageRecipientRef;
	amount: number;
	combat: boolean;
	deathtouch: boolean;
	lifelink: boolean;
	/**
	 * "can't be prevented" skips prevention effects {@link ReplacementEffectDefinition}
	 * but not other replacements.
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

interface CounterEvent extends EventCommon {
	kind: "counter";
	spell: ObjectId;
	source?: ObjectId;
}

/**
 * sacrificing is an action performed by a permanent's controller.
 * Its child movement can be replaced, but the sacrifice is still successful
 * when that replacement moves the permanent somewhere other than a graveyard.
 */
interface SacrificeEvent extends EventCommon {
	kind: "sacrifice";
	object: ObjectId;
}

interface RegenerateEvent extends EventCommon {
	kind: "regenerate";
	object: ObjectId;
}

/**
 * Where a movement is taking the object, together with the data that only that
 * destination can use.
 *
 * Nesting the destination-specific fields inside the destination is what makes
 * the impossible combinations unrepresentable: a card headed for a graveyard
 * has nowhere to carry a controller or ETB counters, and a replacement effect
 * that changes the destination necessarily drops the data the old destination
 * carried with it.
 */
interface BattlefieldDestination {
	zone: "battlefield";
	/** Who the object will be controlled by when it enters. */
	controller: PlayerId;
	// --- CR 614.1c-d: replacements that modify how the object enters ---
	tapped?: boolean;
	counters?: PermanentCounterBag;

	copiableOverride?: CharacteristicsSnapshot;
}

interface StackDestination {
	zone: "stack";
	/** Who the spell will be controlled by (CR 601.2a). */
	controller: PlayerId;
	/** Choices installed atomically when this movement creates the spell. */
	targets: TargetBindings;
}

interface LibraryDestination {
	zone: "library";
	/** CR 401.1: a library is ordered, so an arrival needs an end to arrive at. */
	position: "top" | "bottom";
}

/**
 * CR 400.3: an object in a hand, graveyard, or exile has an owner and no
 * controller, and those zones are unordered. Nothing else is needed to put an
 * object there.
 */
interface OwnedZoneDestination {
	zone: "hand" | "graveyard" | "exile";
}

type ZoneChangeDestination =
	| BattlefieldDestination
	| StackDestination
	| LibraryDestination
	| OwnedZoneDestination;

interface ZoneChangeEventBase extends EventCommon {
	kind: "change zone";
	object: ObjectId;
	cause: MoveCause;
}

/** An existing object moving from one zone to another. */
interface ObjectZoneChangeEvent extends ZoneChangeEventBase {
	from: Zone;
	destination: ZoneChangeDestination;
	createdToken?: never;
}

/**
 * A created token is not in a zone before it enters the battlefield.
 */
interface TokenZoneChangeEvent extends ZoneChangeEventBase {
	from: null;
	/** Tokens are always created from effects. (CR 111.1). */
	cause: "effect";
	destination: BattlefieldDestination;
	createdToken: {
		values: CharacteristicsSnapshot;
		/** Scratch for the token's own replacement abilities during this event. */
		effectData: Record<string, Record<string, number>>;
	};
}

type ZoneChangeEvent = ObjectZoneChangeEvent | TokenZoneChangeEvent;

type MoveCause =
	| "cast"
	| "draw"
	| "play land"
	| "discard"
	| "mill"
	| "exile top"
	| "surveil"
	| "destroy"
	| "counter"
	| "sacrifice"
	| "bounce"
	| "sba"
	| "cast"
	| "illegal target"
	| "resolve"
	| "effect"
	| "return"
	| "put";

interface AddCountersEvent extends EventCommon {
	kind: "add counters";
	permanent: PermanentRef;
	counter: PermanentCounter;
	amount: number;
	source?: ObjectId;
}

interface RemoveCountersEvent extends EventCommon {
	kind: "remove counters";
	permanent: PermanentRef;
	counters: "all" | Partial<Record<PermanentCounter, number | "all">>;
	source?: ObjectId;
}

interface AddPlayerCountersEvent extends EventCommon {
	kind: "add player counters";
	player: PlayerId;
	counter: PlayerCounter;
	amount: number;
	source?: ObjectId;
}

interface RemovePlayerCountersEvent extends EventCommon {
	kind: "remove player counters";
	player: PlayerId;
	counters: "all" | Partial<Record<PlayerCounter, number | "all">>;
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
	/** The complete set of permanents instructed to change state together. */
	objects: ObjectId[];
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
	/** The characteristics stated by the token-creating instruction (CR 111.4). */
	characteristics: CharacteristicsSnapshot;
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
	| CastEvent
	| DrawCardsEvent
	| DrawEvent
	| CycleEvent
	| MillEvent
	| ExileTopEvent
	| ScryEvent
	| SurveilEvent
	| ChooseFromTopEvent
	| DiscardEvent
	| DamageEvent
	| DestroyEvent
	| CounterEvent
	| SacrificeEvent
	| RegenerateEvent
	| ZoneChangeEvent
	| AddCountersEvent
	| RemoveCountersEvent
	| AddPlayerCountersEvent
	| RemovePlayerCountersEvent
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
 * Abilities: definitions and possession
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

function abilityDefinition<C extends AbilityCategory>(
	engine: Engine,
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
		engine.cardDefinition(cardId).abilityDefinitions[category];
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

/* ------------------------------------------------------------------ *
 * Characteristics and snapshots
 * ------------------------------------------------------------------ */

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
	zone: CardZone;
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

export interface PermanentSnapshot extends SnapshotBase {
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
	summoningSick: boolean;
	attacking: boolean;
	blocking: boolean;
	damage: number;
	counters: PermanentCounterBag;
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
export type PlayerLibrarySearchCardView = DeepReadOnly<
	CardSnapshot & { readonly zone: "library" }
>;
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

export function characteristicsFromCardDef(
	def: CardDef,
): CharacteristicsSnapshot {
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
	engine: Engine,
	object: DeepReadOnly<GameObject>,
): DeepReadOnly<CharacteristicsSnapshot> {
	switch (object.kind) {
		case "card":
			return printedCharacteristics(engine.cardDefinition(object.cardId));

		case "spell":
			return object.representation.kind === "copy"
				? object.representation.copyEffect
				: printedCharacteristics(
						engine.cardDefinition(object.representation.cardId),
					);

		case "permanent":
			if (object.copiableOverride) return object.copiableOverride;
			return object.representation.kind === "token"
				? object.representation.createdValues
				: printedCharacteristics(
						engine.cardDefinition(object.representation.cardId),
					);

		case "nonbattlefield-token":
			return object.createdValues;

		default:
			return assertNever(object);
	}
}

function initialCharacteristics(
	engine: Engine,
	object: DeepReadOnly<GameObject>,
): CharacteristicsSnapshot {
	return cloneCharacteristics(baseCharacteristics(engine, object));
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

/* ------------------------------------------------------------------ *
 * Views: what a player is allowed to see
 * ------------------------------------------------------------------ */

export interface GameView {
	readonly objects: ReadonlyMap<ObjectId, GameObjectSnapshot>;
}

export interface PlayerPublicView {
	readonly id: PlayerId;
	readonly life: number;
	readonly counters: DeepReadOnly<PlayerCounterBag>;
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
	readonly engine: Engine;
	readonly state: ReadonlyGameState;
	readonly revision: number;
	readonly view: GameView;
}

/**
 * Build all derived object information for one mutation-free rules window.
 * Callers must discard this view as soon as they mutate `state`.
 */
function buildGameView(engine: Engine, state: ReadonlyGameState): GameView {
	return buildFilteredGameView(engine, state);
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
	engine: Engine,
	state: ReadonlyGameState,
	included?: ReadonlySet<ObjectId>,
): GameView {
	const copiable = new Map<ObjectId, CharacteristicsSnapshot>();
	const characteristics = new Map<ObjectId, CharacteristicsSnapshot>();
	const abilities: Partial<
		Record<
			ContinuousEffectLayer,
			[
				effect: CharacteristicStaticAbilityDefinition,
				source: DeepReadOnly<GameObject>,
			][]
		>
	> = {};

	for (const object of state.objects.values()) {
		const initial = initialCharacteristics(engine, object);
		if (!included || included.has(object.id)) {
			// `initial` is already a fresh clone, and layer 1a replaces rather than
			// mutates its map entry, so it can serve as the copiable values directly.
			copiable.set(object.id, initial);
			characteristics.set(object.id, cloneCharacteristics(initial));
		}

		for (const id of initial.abilities.static) {
			const ability = abilityDefinition(engine, "static", id);
			if (!functionsHere(ability.functionsFrom, object.zone)) continue;
			if (!isCharacteristicStaticAbility(ability)) continue;
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
							!ability.applies(
								continuousEffectEvaluation(subject, current),
								state,
								source,
							)
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
					if (
						!ability.applies(
							continuousEffectEvaluation(subject, current),
							state,
							source,
						)
					)
						continue;
					const next = cloneCharacteristics(current);
					ability.modify(next, state, source);
					characteristics.set(objectId, next);
				}
			}
		}

		if (layer === "6-ability-changing") {
			for (const effect of state.temporaryEffects) {
				const definition = temporaryEffectDefinition(engine, effect);
				if (
					definition?.kind !== "grant-keyword" &&
					definition?.kind !== "grant-triggered"
				)
					continue;
				const slot =
					definition.subject.kind === "source"
						? SELF_SLOT
						: definition.subject.slot;
				const bound = effect.bindings[slot];
				assertDefined(
					bound,
					`temporary ability effect has no binding for ${slot}`,
				);
				if (bound.type !== "permanent") continue;
				const current = characteristics.get(bound.id);
				if (!current) continue;
				if (definition.kind === "grant-keyword") {
					if (!current.keywords.includes(definition.keyword))
						current.keywords.push(definition.keyword);
				} else {
					current.abilities.triggered.push(definition.ability);
				}
			}
		}

		if (layer === "7c-modify-power-toughness") {
			for (const effect of state.temporaryEffects) {
				const definition = temporaryEffectDefinition(engine, effect);
				if (definition?.kind !== "modify-pt") continue;
				const slot =
					definition.subject.kind === "source"
						? SELF_SLOT
						: definition.subject.slot;
				const bound = effect.bindings[slot];
				assertDefined(bound, `temporary P/T effect has no binding for ${slot}`);
				if (bound.type !== "permanent") continue;
				const current = characteristics.get(bound.id);
				if (current?.kind !== "creature") continue;
				current.power += definition.power;
				current.toughness += definition.toughness;
			}
		}

		// +1/+1 and -1/-1 counters apply in layer 7c.
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
					summoningSick: object.summoningSick,
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

/* ------------------------------------------------------------------ *
 * Game state
 * ------------------------------------------------------------------ */

type EffectId = Brand<string, "EffectId">;

function eid(id: string): EffectId {
	return id as EffectId;
}

/**
 * Approximation of last known information (CR 113.7a, CR 608.2h): only the
 * source's controller, colors, deathtouch, and lifelink are retained for damage
 * effects. TODO: replace this projection with the engine's characteristic
 * snapshot types before extending effects that read a departed source.
 */
export interface SourceLastKnown {
	controller: PlayerId;
	colors: Color[];
	deathtouch: boolean;
	lifelink: boolean;
}

/** A trigger not yet on the stack, so not yet targeted (CR 603.3d). */
export interface PendingTrigger {
	source: ObjectId;
	triggerId: TriggeredAbilityId;
	controller: PlayerId;
	text: string;
	/** The final event occurrence that caused this trigger to fire. */
	readonly triggeringEvent: DeepReadOnly<GameEvent>;
	/** The new object created by that occurrence, when it was a zone change. */
	readonly triggeringZoneChangeResult: ObjectId | null;
	/** Copied off the trigger definition, which outlives it. */
	targetDefinitions: TargetDef[];
	effects: TriggeredEffectDef[];
	sourceLastKnown: SourceLastKnown | null;
}

export type DelayedTriggerId = Brand<number, "DelayedTriggerId">;

/** A one-shot trigger waiting for its definition's next matching event. */
export interface DelayedTrigger {
	id: DelayedTriggerId;
	controller: PlayerId;
	source: ObjectId;
	sourceLastKnown: SourceLastKnown;
	triggerId: TriggeredAbilityId;
}

interface PlayerState {
	id: PlayerId;
	life: number;
	library: ObjectId[];
	hand: ObjectId[];
	graveyard: ObjectId[];
	exile: ObjectId[];
	counters: PlayerCounterBag;
	stats: {
		drawn: {
			inDrawStep: number;
			thisTurn: number;
			fromEmptyLibrary: boolean;
		};
		attacks: {
			attackedWithCreatures: number;
		};
		lands: {
			played: number;
		};
	};
	manaPool: ManaPool;
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
 * An ability on the stack carries everything its resolution needs: the
 * restrictions it was announced under, the targets chosen then, and its
 * instructions. CR 113.7a lets the source leave in the meantime, so none of it
 * is read back off the source object or the card registry.
 */
interface AbilityStackItemBase<AllowedPlayer extends TriggerEffectPlayer> {
	id: StackItemId;
	source: ObjectId;
	controller: PlayerId;
	text: string;
	targetDefinitions: TargetDef[];
	targets: TargetBindings;
	effects: EffectDef<AllowedPlayer>[];
	sourceLastKnown: SourceLastKnown | null;
}

export interface TriggeredAbilityStackItem
	extends AbilityStackItemBase<TriggerEffectPlayer> {
	kind: "triggered ability";
	triggerId: TriggeredAbilityId;
	readonly triggeringEvent: DeepReadOnly<GameEvent>;
	readonly triggeringZoneChangeResult: ObjectId | null;
}

export interface ActivatedAbilityStackItem
	extends AbilityStackItemBase<RelativeEffectPlayer> {
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
	/** One-shot triggers waiting for their next matching event. */
	delayedTriggers: DelayedTrigger[];
	temporaryEffects: TemporaryEffect[];
	/** Block declarations for the current combat, in damage-assignment order. */
	blockAssignments: BlockAssignment[];
	/** Turns whose phases have all been consumed; 0 during the first turn. */
	completedTurns: number;
	turnScheduler: TurnScheduler;
	nextObjectId: number;
	nextStackItemId: number;
	nextDelayedTriggerId: number;
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

export interface ReplacementApplyCtx extends EffectCtx {
	/** Replay-safe decisions made while applying this replacement. */
	choices: AnyChoiceController;
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

export interface ReplacementEffectDefinition {
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
	replace(ev: GameEvent, ctx: ReplacementApplyCtx): GameEvent[];
	/**
	 * Consume shields / decrement counters here.
	 *
	 * TODO: is this an antipattern/smell?
	 */
	onApplied?(ev: GameEvent, ctx: ReplacementApplyCtx): void;
}

/** A ReplacementDef bound to a concrete source. This is what the loop sees. */
export interface BoundReplacement {
	id: EffectId;
	def: ReplacementEffectDefinition;
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
 * @see {ReplacementEffectDefinition}.
 */
export interface BoundProhibition {
	id: EffectId;
	def: ProhibitionDef;
	source: DeepReadOnly<GameObject> | null;
	controller: PlayerId;
	label: string;
}

/* ------------------------------------------------------------------ *
 * Temporary continuous effects
 *
 * A resolving spell or ability can create a continuous effect that is not an
 * ability of an object (CR 611.2). Keep its rules data directly in game state.
 * The discriminant says which rules consumer interprets it: the layer walk
 * handles characteristic changes, the action rules handle play permissions,
 * and the replacement pipeline handles replacement and prevention effects.
 * ------------------------------------------------------------------ */

interface TemporaryEffectCommon {
	id: EffectId;
	controller: PlayerId;
}

export type TemporaryEffectDuration =
	| "until-end-of-turn"
	| "until-end-of-your-next-turn";

type ScheduledTemporaryEffectDuration =
	| { duration: "until-end-of-turn" }
	| {
			duration: "until-end-of-your-next-turn";
			/** The controller's next turn, once that turn has successfully begun. */
			expiresAtEndOfTurn: TurnId | null;
	  };

/**
 * Where a temporary effect's definition lives, as serializable data.
 *
 * A resolving spell or ability creates the effect, so it always has a source
 * to point back at: `spell-effect` names the very `EffectDef` that created it,
 * the same `cardId:index` scheme {@link AbilityId} uses for possessed
 * abilities. The definition stays in the registry and is never cloned, so a
 * new card that pumps or shields is registry data rather than a new engine
 * variant.
 *
 * `builtin` covers the small set of engine-authored effects that no card
 * creates yet. These are the prevention and control effects carried over from
 * the old floating-effect registry; nothing but tests constructs them today.
 * A card that needs one should gain a spell effect instead of extending this.
 */
export type TemporaryEffectSource =
	| { origin: "spell-effect"; cardId: string; effectIndex: number }
	| {
			origin: "ability-effect";
			category: "triggered" | "activated";
			abilityId: AbilityId<"triggered" | "activated">;
			effectIndex: number;
	  }
	| { origin: "builtin"; builtin: BuiltinTemporaryEffect };

export type BuiltinTemporaryEffect =
	| { kind: "prevent-next-damage"; recipient: EntityRef; remaining: number }
	| { kind: "prevent-color-damage"; color: Color }
	| { kind: "regeneration-shield"; permanent: ObjectId; used: boolean }
	| { kind: "control-entering-creatures" };

/**
 * One instantiation of a continuous effect that is not possessed by an object
 * (CR 611.2). The definition comes from {@link TemporaryEffectSource}; this
 * record carries only what is specific to this instance: who controls it, when
 * it ends, and the subjects its creating effect bound.
 *
 * Which rules consumer reads it follows from the definition, not from a field
 * here: a characteristic-changing `EffectDef` is applied by the layer walk, and
 * a `may-play` definition is read while offering and executing actions.
 */
export type TemporaryEffect = TemporaryEffectCommon &
	ScheduledTemporaryEffectDuration & {
		source: TemporaryEffectSource;
		/**
		 * What the creating effect resolved its subjects to, by target slot.
		 *
		 * An effect that names its own source ("it gets +1/+1") binds
		 * {@link SELF_SLOT}: the object is resolved once, when the effect is
		 * created, because the source may leave the battlefield before the layer
		 * walk next runs and the bonus outlives it either way.
		 */
		bindings: Record<string, EntityRef>;
	};

/** Binding key for an effect that affects the object that created it. */
export const SELF_SLOT = "self";

export type NewTemporaryEffect = Pick<TemporaryEffect, "source" | "bindings">;

export function addTemporaryEffect(
	state: GameState,
	controller: PlayerId,
	effect: NewTemporaryEffect,
	duration: TemporaryEffectDuration = "until-end-of-turn",
): void {
	state.revision++;
	const common = {
		id: eid(`temporary:${state.nextObjectId++}`),
		controller,
		...effect,
	};
	if (duration === "until-end-of-turn") {
		state.temporaryEffects.push({ ...common, duration });
		return;
	}
	state.temporaryEffects.push({
		...common,
		duration,
		expiresAtEndOfTurn: null,
	});
}

/**
 * The `EffectDef` a spell-effect-sourced temporary effect was created by.
 *
 * Returns null for builtin effects, which have no card definition behind them.
 */
function temporaryEffectDefinition(
	engine: Engine,
	effect: TemporaryEffect,
): EffectDef<TriggerEffectPlayer> | null {
	const source = effect.source;
	if (source.origin === "builtin") return null;
	const effects: EffectDef<TriggerEffectPlayer>[] = (() => {
		if (source.origin === "spell-effect") {
			const spell = engine.cardDefinition(source.cardId).spell;
			assertDefined(
				spell,
				`temporary effect source ${source.cardId} has no spell definition`,
			);
			return spell.effects;
		}
		const ability = abilityDefinition(
			engine,
			source.category,
			source.abilityId,
		);
		// Mana abilities declare `effects?: never`, so they cannot be the source
		// of a temporary effect.
		assertDefined(ability.effects, "ability source has no effects");
		return ability.effects;
	})();
	const definition = effects[source.effectIndex];
	assertDefined(definition, "unknown temporary effect definition");
	return definition;
}

/* ------------------------------------------------------------------ *
 * Effects
 *
 * One serializable effect language is shared by card definitions, imported IR,
 * stack items, and the resolver. An effect never carries a chosen target: it
 * names a target slot its own ability declared, and the resolver looks the
 * binding up. Temporary continuous effects remain definition-only.
 * ------------------------------------------------------------------ */

export type RelativeEffectPlayer = "you" | "opponent";
export type TriggerEffectPlayer = RelativeEffectPlayer | "triggering-player";

export interface TargetEffectRef {
	kind: "target";
	slot: string;
}

export interface SourceEffectRef {
	kind: "source";
}

export interface EffectResultObjectRef {
	kind: "effect-result";
	slot: string;
}

/** The new object created by the zone change that triggered this ability. */
export interface TriggeringZoneChangeResultEffectRef {
	kind: "triggering-zone-change-result";
}

/** A non-targeted permanent chosen as an instruction resolves. */
export interface ChosenPermanentEffectRef<Player extends TriggerEffectPlayer> {
	kind: "chosen-permanent";
	player: Player;
	predicate: ObjectPredicateDef;
	prompt: string;
}

/** Every battlefield permanent matching this predicate as the effect resolves. */
export interface MatchingPermanentSubjects {
	kind: "matching-permanents";
	predicate: ObjectPredicateDef;
}

export type MayPlaySubjectRef = TargetEffectRef | EffectResultObjectRef;

export type EffectPlayerSubject<AllowedPlayer extends TriggerEffectPlayer> =
	| { kind: "relative-player"; player: AllowedPlayer }
	| { kind: "target-player"; slot: string };

/** A destination resolved only when a one-object zone change executes. */
export type ZoneChangeEffectDestination<
	AllowedPlayer extends TriggerEffectPlayer,
> =
	| { zone: "hand" }
	| { zone: "graveyard" }
	| { zone: "exile" }
	| { zone: "library"; position: "top" | "bottom" }
	| {
			zone: "battlefield";
			controller: "owner" | AllowedPlayer;
			tapped?: boolean;
	  };

type BoundZoneChangeEffectDef<AllowedPlayer extends TriggerEffectPlayer> = {
	[Origin in PublicObjectZone]: {
		kind: "change-zone";
		subject:
			| SourceEffectRef
			| TargetEffectRef
			| EffectResultObjectRef
			| TriggeringZoneChangeResultEffectRef;
		from: Origin;
		destination: Exclude<
			ZoneChangeEffectDestination<AllowedPlayer>,
			{ zone: Origin }
		>;
		/** Optionally bind the new object that reaches the declared destination. */
		resultSlot?: string;
	};
}[PublicObjectZone];

/** Hidden library cards can only enter this instruction through a preceding search. */
type SearchedCardZoneChangeEffectDef<
	AllowedPlayer extends TriggerEffectPlayer,
> = {
	kind: "change-zone";
	subject: EffectResultObjectRef;
	from: "library";
	destination: Exclude<
		ZoneChangeEffectDestination<AllowedPlayer>,
		{ zone: "library" }
	>;
	resultSlot?: string;
};

type ChosenPermanentZoneChangeEffectDef<Player extends TriggerEffectPlayer> = {
	kind: "change-zone";
	subject: ChosenPermanentEffectRef<Player>;
	from: "battlefield";
	destination: Exclude<
		ZoneChangeEffectDestination<Player>,
		{ zone: "battlefield" }
	>;
	resultSlot?: never;
};

export type ZoneChangeEffectDef<Player extends TriggerEffectPlayer> =
	| BoundZoneChangeEffectDef<Player>
	| SearchedCardZoneChangeEffectDef<Player>
	| ChosenPermanentZoneChangeEffectDef<Player>;

type SearchLibraryEffectDef<AllowedPlayer extends TriggerEffectPlayer> = {
	kind: "search-library";
	/** The player who sees the eligible cards and makes the choice. */
	searcher: EffectPlayerSubject<AllowedPlayer>;
	/** The player whose library is inspected and later shuffled. */
	owner: EffectPlayerSubject<AllowedPlayer>;
	/** Omitted means "a card"; a predicate makes failing to find legal. */
	predicate?: ObjectPredicateDef;
	resultSlot: string;
};

type ExileTopEffectDef<AllowedPlayer extends TriggerEffectPlayer> = {
	kind: "exile-top";
	/** A relative player, or the player bound to a target slot. */
	subject: EffectPlayerSubject<AllowedPlayer>;
	amount: number;
	/** Optionally bind the cards that actually reached exile, in order. */
	resultSlot?: string;
};

type EachPlayerDrawEffectDef = {
	kind: "each player draw";
	subjects: "each-player";
	amount: number;
};

type ShuffleIntoLibraryEffectDef<AllowedPlayer extends TriggerEffectPlayer> = {
	kind: "shuffle-into-library";
	/** Whose nonlibrary zones are inspected and whose libraries are shuffled. */
	owners:
		| "each-player"
		| EffectPlayerSubject<AllowedPlayer>
		| { kind: "triggering-zone-change-result-owner" };
	/** Every listed zone is inspected before any matching card moves. */
	from: [Exclude<CardZone, "library">, ...Exclude<CardZone, "library">[]];
	/** Omitted means every card in the declared owners' origin zones. */
	predicate?: ObjectPredicateDef;
};

type CreateDelayedTriggerEffectDef = {
	kind: "create-delayed-trigger";
	ability: TriggeredAbilityId;
};

export type EffectDef<AllowedPlayer extends TriggerEffectPlayer> =
	| {
			kind: "gain-life" | "lose-life" | "draw" | "scry" | "surveil" | "mill";
			/** A relative player, or the player bound to a target slot. */
			subject: EffectPlayerSubject<AllowedPlayer>;
			amount: number;
	  }
	| EachPlayerDrawEffectDef
	| CreateDelayedTriggerEffectDef
	| ExileTopEffectDef<AllowedPlayer>
	| SearchLibraryEffectDef<AllowedPlayer>
	| ShuffleIntoLibraryEffectDef<AllowedPlayer>
	| {
			kind: "shuffle-library";
			subject: EffectPlayerSubject<AllowedPlayer>;
	  }
	| {
			kind: "choose-from-top";
			subject: AllowedPlayer;
			amount: number;
			keep: number;
	  }
	| {
			kind: "discard";
			selector: "any" | "random";
			amount: number;
			subject: AllowedPlayer;
	  }
	| {
			kind: "damage";
			subject:
				| { kind: "relative-player"; player: AllowedPlayer }
				| TargetEffectRef;
			amount: number;
	  }
	| { kind: "destroy"; subject: TargetEffectRef }
	| { kind: "tap" | "untap"; subject: TargetEffectRef }
	| { kind: "tap" | "untap"; subjects: MatchingPermanentSubjects }
	| { kind: "counter"; subject: TargetEffectRef }
	| {
			kind: "add counters";
			/** The permanent receiving the counters. */
			subject: SourceEffectRef | TargetEffectRef;
			counter: PermanentCounter;
			amount: number;
	  }
	| ZoneChangeEffectDef<AllowedPlayer>
	| {
			kind: "sacrifice";
			/** A relative player, or the player bound to a target slot. */
			subject: EffectPlayerSubject<AllowedPlayer>;
			predicate: ObjectPredicateDef;
			amount: 1;
	  }
	| {
			kind: "modify-pt";
			/**
			 * What gets the bonus: the object whose effect this is ("it gets
			 * +1/+1"), or the creature bound to a declared target slot ("target
			 * creature gets +3/+3").
			 */
			subject: SourceEffectRef | TargetEffectRef;
			power: number;
			toughness: number;
			duration: TemporaryEffectDuration;
	  }
	| {
			kind: "grant-keyword";
			keyword: Keyword;
			subject: SourceEffectRef | TargetEffectRef;
			duration: TemporaryEffectDuration;
	  }
	| {
			kind: "grant-triggered";
			ability: TriggeredAbilityId;
			subject: SourceEffectRef | TargetEffectRef;
			duration: TemporaryEffectDuration;
	  }
	| {
			kind: "may-play";
			/** The card in exile that this effect's controller may play. */
			subject: MayPlaySubjectRef;
			from: "exile";
			duration: TemporaryEffectDuration;
	  }
	| {
			kind: "add-mana";
			subject: "you";
			mana: ManaAmount;
	  }
	| {
			kind: "create-token";
			controller: AllowedPlayer;
			characteristics: CharacteristicsSnapshot;
			amount: number;
	  }
	| {
			kind: "may";
			decider: RelativeEffectPlayer;
			effects: EffectDef<AllowedPlayer>[];
	  };

interface DeclaredEffectResult {
	slot: string;
	zone: Zone;
}

/** The named object result produced by one instruction, if it declares one. */
function declaredEffectResult(
	effect: Exclude<EffectDef<TriggerEffectPlayer>, { kind: "may" }>,
): DeclaredEffectResult | null {
	if (effect.kind === "exile-top" && effect.resultSlot !== undefined)
		return { slot: effect.resultSlot, zone: "exile" };
	if (effect.kind === "search-library")
		return { slot: effect.resultSlot, zone: "library" };
	if (effect.kind === "change-zone" && effect.resultSlot !== undefined)
		return { slot: effect.resultSlot, zone: effect.destination.zone };
	return null;
}

/** Effects on a triggered ability may refer to the player that triggered it. */
export type TriggeredEffectDef = EffectDef<TriggerEffectPlayer>;

/** Spell effects can refer only to players relative to the spell's controller. */
export type SpellEffectDef = EffectDef<RelativeEffectPlayer>;

/** Activated effects can refer only to players relative to the ability's controller. */
export type ActivatedEffectDef = EffectDef<RelativeEffectPlayer>;
/* ------------------------------------------------------------------ *
 * Triggers
 *
 * When an event happens, trigger conditions are checked. If the
 * condition is met, the trigger's abilities are put on the stack.
 * ------------------------------------------------------------------ */

export type ValidPlayer = "you" | "opponent" | "either";

interface GainLifeTriggerCondition {
	kind: "gain life" | "lose life";
	/** Which player gained or lost life. */
	player: ValidPlayer;
}

interface DrawTriggerCondition {
	kind: "draw";
	player: ValidPlayer;
	/**
	 * At most one draw-count qualifier; the union makes combining two
	 * impossible. `{ nth: N }` fires only on the draw that brings the turn's
	 * count to exactly N, e.g. Sneaky Snacker's "when you draw your third card
	 * in a turn". "except-first-in-draw-step" matches every draw that is not
	 * the first card of that player's own draw step, e.g. Xyris's "whenever an
	 * opponent draws a card except the first one they draw in each of their
	 * draw steps". Both counters are incremented before triggers are detected,
	 * so the event itself is already counted when either is checked.
	 */
	qualifier?: "except-first-in-draw-step" | { nth: number };
}

/** Matches this source dealing combat damage to a player. */
interface DealsCombatDamageTriggerCondition {
	kind: "damage";
	source: "self";
	recipient: "player";
	combat: true;
}

/** Matches a cast by player and the spell's current characteristics. */
interface CastTriggerCondition {
	kind: "cast";
	player: ValidPlayer;
	/** Omitted when the trigger matches every spell cast. */
	predicate?: ObjectPredicateDef;
}

/** Matches a player cycling a card with the declared characteristics. */
interface CycleTriggerCondition {
	kind: "cycle";
	player: ValidPlayer;
	predicate: ObjectPredicateDef;
}

/** Matches the player declaring attackers and/or each matching attacker. */
interface DeclareAttackersTriggerCondition {
	kind: "declare attackers";
	attacker?: ValidPlayer;
	predicate?: ObjectPredicateDef;
}

/**
 * Matches the source blocking, or being blocked, as blockers are declared.
 *
 * Only the source's own participation is supported, because that is exactly
 * bushido's condition (CR 702.45a). Both halves are one condition and fire
 * once: an attacker becomes blocked a single time however many creatures were
 * assigned to it (CR 509.1h), and a creature that blocks is never also an
 * attacker in the same combat.
 */
interface DeclareBlockersTriggerCondition {
	kind: "declare blockers";
	subject: "self blocks or becomes blocked";
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
	predicate: ObjectPredicateDef;
}

/** Matches a permanent becoming tapped or untapped. */
interface TapTriggerCondition {
	kind: "untap" | "tap";
	predicate: ObjectPredicateDef;
}

/** Matches a permanent sacrificed by the specified relative player. */
interface SacrificeTriggerCondition {
	kind: "sacrifice";
	player: ValidPlayer;
	predicate: ObjectPredicateDef;
}

type TriggerCondition =
	| GainLifeTriggerCondition
	| DrawTriggerCondition
	| DealsCombatDamageTriggerCondition
	| CastTriggerCondition
	| CycleTriggerCondition
	| DeclareAttackersTriggerCondition
	| DeclareBlockersTriggerCondition
	| BeginStepTriggerCondition
	| ZoneChangeTriggerCondition
	| TapTriggerCondition
	| SacrificeTriggerCondition;

export interface TriggeredAbilityDefinition {
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
	effects: TriggeredEffectDef[];
}

/* ------------------------------------------------------------------ *
 * Cards
 * ------------------------------------------------------------------ */

export type Keyword =
	| "devoid"
	| "indestructible"
	| "hexproof"
	| "shroud"
	| "deathtouch"
	| "lifelink"
	| "flying"
	| "reach"
	| "defender"
	| "haste"
	| "vigilance"
	| "trample"
	| "flash"
	/** A triggered ability keyword; see {@link printedKeywordTriggers}. */
	| "prowess"
	/**
	 * Bushido N, also a triggered ability keyword. N is part of the keyword
	 * rather than a separate field because "bushido 1" and "bushido 2" are
	 * different keywords a card can be printed with, and the number is what
	 * the ability they stand for grants.
	 */
	| `bushido ${number}`;

/**
 * A predicate over one object supplied by a caller-defined domain. Targeting,
 * triggers, costs, and continuous effects establish that domain before testing
 * the predicate against the object's current characteristics.
 *
 * `not` is therefore relative to that existing domain: negating `creature`
 * while examining permanents can match a land, but can never introduce a
 * player, spell, or card from another zone. Requiring at least two operands for
 * `and` and `or` leaves no empty or single-operand boolean form to interpret.
 */
export type ObjectPredicateDef =
	| { kind: "token" }
	| { kind: "self" }
	| { kind: "attacking" }
	| { kind: "blocking" }
	| { kind: "type"; type: CardType }
	| { kind: "supertype"; supertype: Supertype }
	| { kind: "subtype"; subtype: string }
	| { kind: "color"; color: Color }
	| { kind: "owner"; player: "you" | "opponent" }
	| { kind: "controller"; player: "you" | "opponent" }
	| {
			kind: "and" | "or";
			predicates: [
				ObjectPredicateDef,
				ObjectPredicateDef,
				...ObjectPredicateDef[],
			];
	  }
	| { kind: "not"; predicate: ObjectPredicateDef };

/** Declarative targeting; the runtime supports one required target slot. */
export interface TargetDef {
	id: string;
	min: number;
	max: number;
	legal:
		| { kind: "player"; player: ValidPlayer }
		| { kind: "spell"; predicate?: ObjectPredicateDef }
		| {
				kind: "card";
				/** Only public card zones can supply Magic targets in this slice. */
				zone: Extract<CardZone, "graveyard" | "exile">;
				predicate?: ObjectPredicateDef;
		  }
		| {
				kind: "permanent";
				/** Omitted when every permanent is legal. */
				predicate?: ObjectPredicateDef;
		  }
		| { kind: "any-target" };
}

/** What an effect requires from each target slot it consumes. */
export type TargetRequirement =
	| { kind: "damage-recipient"; message: string }
	| { kind: "player" | "permanent" | "spell"; message: string }
	| {
			kind: "card";
			zone: Extract<CardZone, "graveyard" | "exile">;
			message: string;
	  };

export interface EffectTargetUse {
	slot: string;
	required: TargetRequirement;
}

/**
 * The target slots one effect consumes and the selector domain each requires.
 * The declared {@link TargetDef} remains the canonical full selector, including
 * its predicate; these requirements only prove that the effect can consume it.
 */
export function effectTargetUses<Player extends TriggerEffectPlayer>(
	effect: Exclude<EffectDef<Player>, { kind: "may" }>,
): EffectTargetUse[] {
	switch (effect.kind) {
		case "damage":
			return effect.subject.kind === "target"
				? [
						{
							slot: effect.subject.slot,
							required: {
								kind: "damage-recipient",
								message:
									"damage requires a player, permanent, or any-target selector",
							},
						},
					]
				: [];
		case "gain-life":
		case "lose-life":
		case "draw":
		case "scry":
		case "surveil":
		case "mill":
		case "exile-top":
		case "sacrifice":
			return effect.subject.kind === "target-player"
				? [
						{
							slot: effect.subject.slot,
							required: {
								kind: "player",
								message: "a targeted player effect requires a player target",
							},
						},
					]
				: [];
		case "destroy":
		case "counter":
			return [
				{
					slot: effect.subject.slot,
					required: {
						kind: effect.kind === "counter" ? "spell" : "permanent",
						message:
							effect.kind === "counter"
								? "counter requires a spell target"
								: `${effect.kind} requires a permanent target`,
					},
				},
			];
		case "tap":
		case "untap":
			return "subject" in effect
				? [
						{
							slot: effect.subject.slot,
							required: {
								kind: "permanent",
								message: `${effect.kind} requires a permanent target`,
							},
						},
					]
				: [];
		case "modify-pt":
		case "grant-keyword":
		case "grant-triggered":
		case "add counters":
			return effect.subject.kind === "target"
				? [
						{
							slot: effect.subject.slot,
							required: {
								kind: "permanent",
								message: `${effect.kind} requires a permanent target`,
							},
						},
					]
				: [];
		case "change-zone":
			if (effect.subject.kind !== "target") return [];
			assert(
				effect.from !== "library",
				"a targeted card change-zone effect must use a public origin",
			);
			return [
				{
					slot: effect.subject.slot,
					required:
						effect.from === "battlefield"
							? {
									kind: "permanent",
									message:
										"a battlefield change-zone effect requires a permanent target",
								}
							: {
									kind: "card",
									zone: effect.from,
									message:
										"a card change-zone effect requires a target in its origin",
								},
				},
			];
		case "may-play":
			return effect.subject.kind === "target"
				? [
						{
							slot: effect.subject.slot,
							required: {
								kind: "card",
								zone: effect.from,
								message:
									"temporary play permission requires a card target in its origin",
							},
						},
					]
				: [];
		case "search-library": {
			const uses: EffectTargetUse[] = [];
			for (const subject of [effect.searcher, effect.owner]) {
				if (subject.kind !== "target-player") continue;
				uses.push({
					slot: subject.slot,
					required: {
						kind: "player",
						message: "library search requires a player target",
					},
				});
			}
			return uses;
		}
		case "shuffle-library":
			return effect.subject.kind === "target-player"
				? [
						{
							slot: effect.subject.slot,
							required: {
								kind: "player",
								message: "library shuffle requires a player target",
							},
						},
					]
				: [];
		case "shuffle-into-library":
			return effect.owners !== "each-player" &&
				effect.owners.kind === "target-player"
				? [
						{
							slot: effect.owners.slot,
							required: {
								kind: "player",
								message: "library shuffle requires a player target",
							},
						},
					]
				: [];
		case "each player draw":
		case "create-delayed-trigger":
		case "choose-from-top":
		case "discard":
		case "add-mana":
		case "create-token":
			return [];
		default:
			return assertNever(effect);
	}
}

export function targetSelectorSatisfies(
	selector: TargetDef["legal"],
	requirement: TargetRequirement,
): boolean {
	if (requirement.kind === "damage-recipient")
		return (
			selector.kind === "player" ||
			selector.kind === "permanent" ||
			selector.kind === "any-target"
		);
	if (requirement.kind === "card")
		return selector.kind === "card" && selector.zone === requirement.zone;
	return selector.kind === requirement.kind;
}

/** What an object predicate reads `self`, `you`, and `opponent` relative to. */
export interface PredicateContext {
	controller: PlayerId;
	source: ObjectId | null;
}

/**
 * Whether one object satisfies a predicate. `context.source` is the id the
 * `self` case compares against, or null where there is no source object.
 */
export function objectMatchesPredicate(
	predicate: ObjectPredicateDef,
	object: DeepReadOnly<GameObjectSnapshot | ContinuousEffectEvaluation>,
	context: PredicateContext,
): boolean {
	const characteristics = object.currentCharacteristics;
	switch (predicate.kind) {
		case "self":
			return context.source !== null && object.objectId === context.source;
		case "attacking":
			return "attacking" in object && object.attacking;
		case "blocking":
			return "blocking" in object && object.blocking;
		case "type":
			return characteristics.types.includes(predicate.type);
		case "supertype":
			return characteristics.supertypes.includes(predicate.supertype);
		case "subtype":
			return characteristics.subtypes.includes(predicate.subtype);
		case "color":
			return characteristics.colors.includes(predicate.color);
		case "token":
			if (object.kind === "nonbattlefield-token") return true;
			if (object.kind === "permanent") {
				return object.representation.kind === "token";
			} else if (
				object.kind === undefined ||
				object.kind === "continuous effect evaluation"
			) {
				return object.token;
			}
			return false;
		case "owner":
			return predicate.player === "you"
				? object.owner === context.controller
				: object.owner !== context.controller;
		case "controller":
			// An object with no controller matches neither "you" nor "opponent".
			if (object.controller === null) return false;
			return predicate.player === "you"
				? object.controller === context.controller
				: object.controller !== context.controller;
		case "and":
			return predicate.predicates.every((part) =>
				objectMatchesPredicate(part, object, context),
			);
		case "or":
			return predicate.predicates.some((part) =>
				objectMatchesPredicate(part, object, context),
			);
		case "not":
			return !objectMatchesPredicate(predicate.predicate, object, context);
	}
}

export interface SpellAbilityDef {
	id: string;
	text: string;
	additionalCost?: SpellAdditionalCostDef;
	targets: TargetDef[];
	effects: SpellEffectDef[];
}

/** The one required additional spell cost currently supported. */
export type SpellAdditionalCostDef = {
	kind: "sacrifice";
	predicate: ObjectPredicateDef;
	amount: 1;
};

export interface SacrificeActivationCost {
	predicate: ObjectPredicateDef;
	amount: 1;
}

/**
 * Discarding as a cost. The card is chosen from hand while the ability is
 * announced, so it is any card its controller holds, not a selected one: no
 * printed cost narrows the choice in the supported set (e.g. the Blood token's
 * "{1}, {T}, Discard a card, Sacrifice this token: Draw a card").
 */
export interface DiscardActivationCost {
	amount: 1;
	/** Cycling discards its source; omitted means the player chooses a card. */
	subject?: "source";
}

interface ActivatedAbilityDefBase {
	id: string;
	text: string;
	cost: ActivationCost;
}

export interface ActivatedAbilityDef extends ActivatedAbilityDefBase {
	kind: "activated";
	/** Defaults to the battlefield. Hand is supported for cycling abilities. */
	functionsFrom?: [PublicObjectZone | "hand"];
	targets: TargetDef[];
	effects: ActivatedEffectDef[];
	restrictions?: {
		asSorcery: true;
	};
}

/** The exact keyword ability defined by CR 702.29a. */
export interface CyclingAbilityDef extends ActivatedAbilityDefBase {
	kind: "cycling";
	functionsFrom: ["hand"];
	cost: {
		mana: PayableActivationManaCost;
		tapSelf: false;
		sacrifice?: never;
		discard: { amount: 1; subject: "source" };
	};
	targets: [];
	effects: [
		{
			kind: "draw";
			subject: { kind: "relative-player"; player: "you" };
			amount: 1;
		},
	];
}

/** A mana ability whose instructions always produce the same mana. */
export interface FixedManaAbilityDef extends ActivatedAbilityDefBase {
	kind: "mana";
	effects: ActivatedEffectDef[];
	manaOptions?: never;
}

/**
 * A single mana ability that requires its controller to choose exactly one
 * mutually exclusive outcome as it is activated.
 */
export interface ModalManaAbilityDef extends ActivatedAbilityDefBase {
	kind: "mana";
	effects?: never;
	manaOptions: [ManaAmount, ManaAmount, ...ManaAmount[]];
}

/** CR 605.1a mana abilities cannot require targets. */
export type ManaAbilityDef = FixedManaAbilityDef | ModalManaAbilityDef;

/** Every ability definition possessed through an activated-ability reference. */
export type AnyActivatedAbilityDefinition =
	| ActivatedAbilityDef
	| CyclingAbilityDef
	| ManaAbilityDef;

/** A finite fixed mana cost. Omitted symbols require zero mana. */
export interface FixedManaCost {
	w?: number;
	u?: number;
	b?: number;
	r?: number;
	g?: number;
	/** Colorless: payable only with colorless mana, as in {C}. */
	c?: number;
	/** Generic: payable with mana of any type, as in {3}. */
	n?: number;
}

/** A fixed mana cost that can be paid from a mana pool. */
export type PayableManaCost = FixedManaCost | "zero";

/**
 * Mana supported in an activation cost under the TINY-65 scope.
 *
 * The parent scope says generic/coloured mana. That includes {1} and WUBRG,
 * but not specifically colorless {C}; `c?: never` makes that choice explicit.
 * "none" is also absent because it is a card-only absence of a mana cost, not
 * a payable activation cost.
 */
export type PayableActivationManaCost =
	| {
			w?: number;
			u?: number;
			b?: number;
			r?: number;
			g?: number;
			c?: never;
			n?: number;
	  }
	| "zero";

/** The fixed components supported for one activation cost. */
export interface ActivationCost {
	mana: PayableActivationManaCost;
	tapSelf: boolean;
	sacrifice?: SacrificeActivationCost;
	discard?: DiscardActivationCost;
}

export type CardDefManaCost =
	| PayableManaCost
	/**
	 * Some cards have no mana cost. These cannot be cast from hand.
	 *
	 * This differs from "zero": a zero-cost card can be cast normally. Tokens
	 * and cards such as Crashing Footfalls can instead have no mana cost.
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
	static: StaticAbilityDefinition[];
	activated: AnyActivatedAbilityDefinition[];
	triggered: TriggeredAbilityDefinition[];
	replacement: ReplacementEffectDefinition[];
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
	entersWith?: PermanentCounterBag;
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
	statics?: StaticAbilityDefinition[];
	activatedAbilities?: AnyActivatedAbilityDefinition[];
	triggers?: TriggeredAbilityDefinition[];
	replacements?: ReplacementEffectDefinition[];
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
 * copiable. The TEST_ENTERS_WITH_COUNTERS fixture's copiable values carry
 * `test-enters-with-counters:<n>` in `abilities.replacement`; a copy effect
 * that enters as a copy carries that same reference on the event's copy
 * snapshot, and the reference *is* the provenance. Nothing at execution time
 * has to ask which card an object was copied from.
 *
 * They function from anywhere, because the object is still in the zone it is
 * leaving when they apply, and they are self-scoped to the object entering.
 */
function printedEntryReplacements(
	def: CardDefBase,
): ReplacementEffectDefinition[] {
	const out: ReplacementEffectDefinition[] = [];
	const entersSelf = (ev: GameEvent, ctx: EffectCtx): boolean =>
		ev.kind === "change zone" &&
		ev.destination.zone === "battlefield" &&
		ctx.self !== null &&
		ev.object === ctx.self.id;

	if (def.entersTapped) {
		out.push({
			label: `${def.id}:enters-tapped`,
			text: `${def.name} enters tapped.`,
			layer: "other",
			functionsFrom: "any",
			applies: (ev, ctx) =>
				entersSelf(ev, ctx) &&
				ev.kind === "change zone" &&
				ev.destination.zone === "battlefield" &&
				!ev.destination.tapped,
			replace: (ev) =>
				ev.kind === "change zone" && ev.destination.zone === "battlefield"
					? [{ ...ev, destination: { ...ev.destination, tapped: true } }]
					: [ev],
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
				ev.destination.zone === "battlefield" &&
				ev.destination.counters === undefined,
			replace: (ev) =>
				ev.kind === "change zone" && ev.destination.zone === "battlefield"
					? [
							{
								...ev,
								destination: {
									...ev.destination,
									counters: { ...entersWith },
								},
							},
						]
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
	assert(
		!input.keywords?.includes("devoid") || input.colors.length === 0,
		`devoid card ${input.id} must be colorless`,
	);
	if ("abilityDefinitions" in input) {
		validateCardEffectResultFlow(input);
		return input;
	}
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
		triggered: [...(triggers ?? [])],
		replacement: [...(replacements ?? [])],
		prohibition: prohibitions ?? [],
	};
	// Author-declared indices are resolved first so that an explicit `printed`
	// list keeps meaning what it said; the keyword and entry shorthands are
	// appended after, and are always printed.
	const printedAbilities = printedRefsFor(
		input.id,
		abilityDefinitions,
		printed,
	);
	for (const trigger of printedKeywordTriggers(input.keywords ?? [])) {
		printedAbilities.triggered.push(
			abilityId("triggered", input.id, abilityDefinitions.triggered.length),
		);
		abilityDefinitions.triggered.push(trigger);
	}
	for (const entry of printedEntryReplacements(input)) {
		printedAbilities.replacement.push(
			abilityId("replacement", input.id, abilityDefinitions.replacement.length),
		);
		abilityDefinitions.replacement.push(entry);
	}
	const definition: CardDef = {
		...base,
		abilityDefinitions,
		printedAbilities,
	};
	validateCardEffectResultFlow(definition);
	return definition;
}

/** Name used at the source/compiler boundary; identical to the engine CardDef. */
export type OracleCardDef = CardDef;

/** Rules operations bound to one immutable set of card definitions. */
export class Engine {
	readonly #cards: ReadonlyMap<string, CardDef>;

	constructor(inputs: readonly (CardDefInput | CardDef)[]) {
		const cards = new Map<string, CardDef>();
		for (const input of inputs) {
			const definition = defineCard(input);
			assert(!cards.has(definition.id), `duplicate card: ${definition.id}`);
			cards.set(definition.id, definition);
		}
		this.#cards = cards;
	}

	cardDefinition(id: string): CardDef {
		const definition = this.#cards.get(id);
		assertDefined(definition, `unknown card: ${id}`);
		return definition;
	}

	withCards(inputs: readonly (CardDefInput | CardDef)[]): Engine {
		return new Engine([...this.#cards.values(), ...inputs]);
	}

	getAbilityDefinition<C extends AbilityCategory>(
		category: C,
		id: AbilityId<C>,
	): AbilityDef<C> {
		return abilityDefinition(this, category, id);
	}

	newGame(seed = 0): GameState {
		return newGame(seed);
	}

	spawnCard(
		state: GameState,
		cardId: string,
		owner: PlayerId,
		zone: "library" | "hand" | "graveyard" | "exile",
	): CardObject {
		return spawnCard(state, cardId, owner, zone);
	}

	spawnPermanent(
		state: GameState,
		cardId: string,
		owner: PlayerId,
		opts: {
			tapped?: boolean;
			summoningSick?: boolean;
			counters?: PermanentCounterBag;
			token?: boolean;
		} = {},
	): PermanentObject {
		return spawnPermanent(this, state, cardId, owner, opts);
	}

	spawnToken(
		state: GameState,
		owner: PlayerId,
		characteristics: CharacteristicsSnapshot,
	): PermanentObject {
		return spawnToken(state, owner, characteristics);
	}

	name(state: ReadonlyGameState, id: ObjectId): string {
		return name(this, state, id);
	}

	buildGameView(state: ReadonlyGameState): GameView {
		return buildGameView(this, state);
	}

	createReadContext(state: ReadonlyGameState): ReadContext {
		return createReadContext(this, state);
	}

	buildPlayerView(state: ReadonlyGameState, viewer: PlayerId): PlayerView {
		return buildPlayerView(this, state, viewer);
	}

	eligibleAttackers(state: ReadonlyGameState, player: PlayerId): ObjectId[] {
		return eligibleAttackers(this, state, player);
	}

	eligibleBlockers(
		state: ReadonlyGameState,
		player: PlayerId,
		attacker?: ObjectId,
	): ObjectId[] {
		return eligibleBlockers(this, state, player, attacker);
	}

	etbPreview(state: ReadonlyGameState, ev: ZoneChangeEvent): PermanentSnapshot {
		return etbPreview(this, state, ev);
	}

	temporaryEffectDefinition(
		effect: TemporaryEffect,
	): EffectDef<TriggerEffectPlayer> | null {
		return temporaryEffectDefinition(this, effect);
	}

	lethalDamage(
		stateOrRead: ReadonlyGameState | ReadContext,
		id: ObjectId,
	): boolean {
		return lethalDamage(this, stateOrRead, id);
	}

	prepareEffectData(state: GameState): void {
		prepareEffectData(this, state);
	}

	collectReplacements(
		state: ReadonlyGameState,
		ev?: GameEvent,
	): BoundReplacement[] {
		return collectReplacements(this, state, ev);
	}

	describeEvent(state: ReadonlyGameState, ev: GameEvent): string {
		return describeEvent(this, state, ev);
	}

	checkStateBasedActions(state: GameState, source: ChoiceSource): void {
		checkStateBasedActions(this, state, source);
	}

	perform(
		state: GameState,
		event: GameEvent,
		source: ChoiceSource,
	): PerformResult {
		return perform(this, state, event, source);
	}

	getObservableActions(state: GameState, player: PlayerId): PriorityAction[] {
		return getObservableActions(this, state, player);
	}

	executeAbilityAction(
		state: GameState,
		priorityPlayer: PlayerId,
		action: ActivateAbilityAction,
		source: ChoiceSource,
	): void {
		executeAbilityAction(this, state, priorityPlayer, action, source);
	}

	executeCastAction(
		state: GameState,
		priorityPlayer: PlayerId,
		action: CastAction,
		source: ChoiceSource,
	): void {
		executeCastAction(this, state, priorityPlayer, action, source);
	}

	executeLandAction(
		state: GameState,
		priorityPlayer: PlayerId,
		action: PlayLandAction,
		source: ChoiceSource,
	): void {
		executeLandAction(this, state, priorityPlayer, action, source);
	}

	settlePriority(state: GameState, source: ChoiceSource): void {
		settlePriority(this, state, source);
	}

	advanceWithReplay(
		checkpoint: GameState,
		agents: AgentPair,
		transcript: ChoiceTranscript = { version: 1, choices: [] },
	): Promise<AdvanceWithReplayResult> {
		return advanceWithReplay(this, checkpoint, agents, transcript);
	}

	startGame(state: GameState, source: ChoiceSource): void {
		startGame(this, state, source);
	}

	advance(state: GameState, source: ChoiceSource): void {
		advance(this, state, source);
	}

	gameOver(state: GameState): boolean {
		return gameOver(state);
	}

	winner(state: GameState): PlayerId | "draw" | null {
		return winner(state);
	}
}

export function createEngine(
	inputs: readonly (CardDefInput | CardDef)[],
): Engine {
	return new Engine(inputs);
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
	stats: {
		drawn: {
			thisTurn: 0,
			inDrawStep: 0,
			fromEmptyLibrary: false,
		},
		attacks: {
			attackedWithCreatures: 0,
		},
		lands: {
			played: 0,
		},
	},
	manaPool: { w: 0, u: 0, b: 0, r: 0, g: 0, c: 0 },
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
function newGame(seed = 0): GameState {
	return {
		revision: 0,
		objects: new Map(),
		players: [newPlayerState(0), newPlayerState(1)],
		battlefield: [],
		stack: [],
		pendingTriggers: [],
		delayedTriggers: [],
		temporaryEffects: [],
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
		nextDelayedTriggerId: 0,
		nextTag: 0,
		log: [],
		rngState: seedRng(seed),
	};
}

/* ------------------------------------------------------------------ *
 * Object creation
 * ------------------------------------------------------------------ */

function spawnCard(
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
	opts: {
		tapped?: boolean;
		summoningSick?: boolean;
		counters?: PermanentCounterBag;
		token?: boolean;
	} = {},
): PermanentObject {
	const obj: PermanentObject = {
		kind: "permanent",
		representation,
		zone: "battlefield",
		id: state.nextObjectId++ as ObjectId,

		owner,
		controller: owner,

		tapped: opts.tapped ?? false,
		summoningSick: opts.summoningSick ?? true,
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

function spawnPermanent(
	engine: Engine,
	state: GameState,
	cardId: string,
	owner: PlayerId,
	opts: {
		tapped?: boolean;
		summoningSick?: boolean;
		counters?: PermanentCounterBag;
		token?: boolean;
	} = {},
): PermanentObject {
	const representation: PermanentObject["representation"] = opts.token
		? {
				kind: "token",
				createdValues: characteristicsFromCardDef(
					engine.cardDefinition(cardId),
				),
			}
		: { kind: "card", cardId };
	return spawnOnBattlefield(state, owner, representation, opts);
}

function spawnToken(
	state: GameState,
	owner: PlayerId,
	characteristics: CharacteristicsSnapshot,
): PermanentObject {
	return spawnOnBattlefield(state, owner, {
		kind: "token",
		createdValues: characteristics,
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

function name(engine: Engine, state: ReadonlyGameState, id: ObjectId): string {
	const object = maybeObject(state, id);
	return object ? initialCharacteristics(engine, object).name : `<gone#${id}>`;
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

/* ------------------------------------------------------------------ *
 * Combat eligibility
 * ------------------------------------------------------------------ */

/**
 * The single source of truth for who may be declared as an attacker (CR 508.1a):
 * a creature controlled by the declaring player, untapped, currently on the
 * battlefield, without defender, and not affected by summoning sickness.
 * Battlefield order is preserved.
 */
function eligibleAttackers(
	engine: Engine,
	state: ReadonlyGameState,
	player: PlayerId,
): ObjectId[] {
	const read = createReadContext(engine, state);
	return state.battlefield.filter((id) => {
		const object = state.objects.get(id);
		const snapshot = read.view.objects.get(id);
		return (
			object?.kind === "permanent" &&
			object.controller === player &&
			!object.tapped &&
			snapshot?.kind === "permanent" &&
			snapshot.currentCharacteristics.types.includes("creature") &&
			!snapshot.currentCharacteristics.keywords.includes("defender") &&
			(!object.summoningSick ||
				snapshot.currentCharacteristics.keywords.includes("haste"))
		);
	});
}

/**
 * The single source of truth for who may be declared as a blocker (CR 509.1a):
 * a creature controlled by the defending player, untapped, currently on the
 * battlefield, and able to block the given attacker. A creature with flying
 * can be blocked only by a creature with flying or reach (CR 702.9b). Blocking
 * does not tap the blocker. Battlefield order is preserved.
 */
function eligibleBlockers(
	engine: Engine,
	state: ReadonlyGameState,
	player: PlayerId,
	attacker?: ObjectId,
): ObjectId[] {
	const read = createReadContext(engine, state);
	const attackerSnapshot =
		attacker === undefined ? undefined : getSnapshot(read, attacker);
	if (attackerSnapshot !== undefined) {
		assert(attackerSnapshot.kind === "permanent");
		assert(attackerSnapshot.currentCharacteristics.kind === "creature");
	}
	return state.battlefield.filter((id) => {
		const object = state.objects.get(id);
		const snapshot = read.view.objects.get(id);
		if (
			object?.kind !== "permanent" ||
			object.controller !== player ||
			object.tapped ||
			snapshot?.kind !== "permanent" ||
			!snapshot.currentCharacteristics.types.includes("creature")
		)
			return false;
		if (
			attackerSnapshot?.currentCharacteristics.keywords.includes("flying") &&
			!snapshot.currentCharacteristics.keywords.includes("flying") &&
			!snapshot.currentCharacteristics.keywords.includes("reach")
		)
			return false;
		return !snapshot.currentCharacteristics.abilities.static.some(
			(abilityId) => {
				const ability = abilityDefinition(engine, "static", abilityId);
				return "kind" in ability && ability.kind === "cant-block-self";
			},
		);
	});
}

/* ------------------------------------------------------------------ *
 * Rejected actions
 *
 * Every one of these is thrown before anything is mutated, or after the
 * attempt has been rewound: an illegal action never leaves a partial game.
 * ------------------------------------------------------------------ */

/** Thrown when a "declare attackers" event fails validation. Nothing is
 * mutated: the whole event is rejected atomically. */
export class IllegalAttackDeclarationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "IllegalAttackDeclarationError";
	}
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

/* ------------------------------------------------------------------ *
 * Logging
 * ------------------------------------------------------------------ */

export function log(state: GameState, line: string): void {
	state.log.push(line);
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
export interface CharacteristicStaticAbilityDefinition {
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
		snapshot: DeepReadOnly<ContinuousEffectEvaluation>,
		state: ReadonlyGameState,
		source: DeepReadOnly<GameObject>,
	): boolean;
	modify(
		view: CharacteristicsSnapshot,
		state: ReadonlyGameState,
		source: DeepReadOnly<GameObject>,
	): void;
}

/**
 * The deliberately small rule-effect subset. These are static abilities, so
 * possession is still copied, granted, and removed through the ordinary
 * `abilities.static` references. Unlike characteristic effects, they are read
 * by the rule they modify instead of participating in CR 613's layer system.
 *
 * The supported cases are finite positive additions to the source controller's
 * ordinary land-play allowance and an unconditional prohibition on the source
 * blocking. Temporary effects (Explore), unlimited allowances (Fastbond),
 * other affected players, conditions, broader combat restrictions, and
 * alternate-zone land play remain outside the engine's subset.
 */
export interface AdjustLandPlaysStaticAbilityDefinition {
	kind: "adjust-land-plays";
	text: string;
	affects: "you";
	amount: number;
	/** This first rule-effect slice functions only from the battlefield. */
	functionsFrom?: never;
}

/** A battlefield permanent with this currently possessed ability can't block. */
export interface CantBlockSelfStaticAbilityDefinition {
	kind: "cant-block-self";
	text: string;
	/** This first rule-effect slice functions only from the battlefield. */
	functionsFrom?: never;
}

export type StaticAbilityDefinition =
	| CharacteristicStaticAbilityDefinition
	| AdjustLandPlaysStaticAbilityDefinition
	| CantBlockSelfStaticAbilityDefinition;

function isCharacteristicStaticAbility(
	ability: StaticAbilityDefinition,
): ability is CharacteristicStaticAbilityDefinition {
	return !("kind" in ability);
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
function etbPreview(
	engine: Engine,
	state: ReadonlyGameState,
	ev: ZoneChangeEvent,
): PermanentSnapshot {
	assert(
		ev.destination.zone === "battlefield",
		"an ETB preview requires a battlefield destination",
	);
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
		delayedTriggers: state.delayedTriggers.map(
			(trigger) => structuredClone(trigger) as DelayedTrigger,
		),
		temporaryEffects: state.temporaryEffects.map((effect) => ({ ...effect })),
		log: [],
	};
	let id: ObjectId;
	if (ev.from === null) {
		assert(
			!preview.objects.has(ev.object),
			`created token id ${ev.object} is already in use`,
		);
		id = ev.object;
		preview.objects.set(id, {
			kind: "permanent",
			id,
			owner: ev.destination.controller,
			controller: ev.destination.controller,
			zone: "battlefield",
			representation: {
				kind: "token",
				createdValues: cloneCharacteristics(ev.createdToken.values),
			},
			...(ev.destination.copiableOverride
				? {
						copiableOverride: cloneCharacteristics(
							ev.destination.copiableOverride,
						),
					}
				: {}),
			tapped: ev.destination.tapped ?? false,
			summoningSick: true,
			counters: { ...ev.destination.counters },
			effectData: {},
			damage: 0,
			attacking: false,
			blocking: false,
			token: true,
			attributes: {},
		});
		preview.battlefield.push(id);
	} else {
		assertDefined(maybeObject(state, ev.object));
		id = moveObject(engine, preview, ev.object, ev.from, ev.destination);
	}
	const snapshot = getSnapshot(createReadContext(engine, preview), id);
	assert(snapshot.kind === "permanent");
	return snapshot;
}

const GAME_VIEW_CACHE = new WeakMap<
	object,
	{ engine: Engine; revision: number; view: GameView }
>();

function cachedGameView(
	engine: Engine,
	state: ReadonlyGameState,
	revision: number,
): GameView {
	const cached = GAME_VIEW_CACHE.get(state);
	if (cached?.engine === engine && cached.revision === revision)
		return cached.view;
	const view = buildGameView(engine, state);
	GAME_VIEW_CACHE.set(state, { engine, revision, view });
	return view;
}

function createReadContext(
	engine: Engine,
	state: ReadonlyGameState,
): ReadContext {
	let derived: GameView | undefined;
	const revision = state.revision;
	return {
		engine,
		state,
		revision,
		get view() {
			if (state.revision !== revision)
				throw new Error("attempted to use a stale ReadContext");
			if (!derived) derived = cachedGameView(engine, state, revision);
			return derived;
		},
	};
}

export function getSnapshot(
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
		engine: Engine;
		revision: number;
		views: [PlayerView | undefined, PlayerView | undefined];
	}
>();

function playerGameView(
	engine: Engine,
	state: ReadonlyGameState,
	revision: number,
): GameView {
	const complete = GAME_VIEW_CACHE.get(state);
	if (complete?.engine === engine && complete.revision === revision)
		return complete.view;

	// Libraries expose counts only, so deriving snapshots for every card there
	// would add substantial work to each agent decision without adding data.
	const visibleObjects = new Set<ObjectId>();
	for (const object of state.objects.values()) {
		if (object.zone !== "library") visibleObjects.add(object.id);
	}
	return buildFilteredGameView(engine, state, visibleObjects);
}

function deepFreeze<T>(value: T): DeepReadOnly<T> {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
		return value as DeepReadOnly<T>;
	}
	for (const nested of Object.values(value)) deepFreeze(nested);
	return Object.freeze(value) as DeepReadOnly<T>;
}

/** Build a detached player-specific projection from one stable read window. */
function buildPlayerView(
	engine: Engine,
	state: ReadonlyGameState,
	viewer: PlayerId,
): PlayerView {
	let cached = PLAYER_VIEW_CACHE.get(state);
	if (cached?.engine === engine && cached.revision === state.revision) {
		const existing = cached.views[viewer];
		if (existing) return existing;
	} else {
		cached = {
			engine,
			revision: state.revision,
			views: [undefined, undefined],
		};
		PLAYER_VIEW_CACHE.set(state, cached);
	}
	const revision = state.revision;
	const read: ReadContext = {
		engine,
		state,
		revision,
		view: playerGameView(engine, state, revision),
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
			landsPlayed: player.stats.lands.played,
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
	const snapshot = getSnapshot(read, object.id);
	return snapshot.currentCharacteristics;
}

// TODO: this duplicates info and does not discriminate by category of game object.
export interface ContinuousEffectEvaluation {
	readonly kind?: "continuous effect evaluation";
	readonly token: boolean;
	readonly objectId: ObjectId;
	readonly cardId: string | null;
	readonly owner: PlayerId;
	readonly controller: PlayerId | null;
	readonly zone: Zone;
	readonly attacking: boolean;
	readonly blocking: boolean;
	readonly currentCharacteristics: DeepReadOnly<CharacteristicsSnapshot>;
}

function continuousEffectEvaluation(
	object: DeepReadOnly<GameObject>,
	characteristics: DeepReadOnly<CharacteristicsSnapshot>,
): ContinuousEffectEvaluation {
	const cardId = physicalCardId(object);
	return {
		objectId: object.id,
		cardId,
		token:
			object.kind === "nonbattlefield-token" ||
			(object.kind === "permanent" && object.representation.kind === "token"),
		owner: object.owner,
		controller: controllerOf(object),
		zone: object.zone,
		attacking: object.kind === "permanent" && object.attacking,
		blocking: object.kind === "permanent" && object.blocking,
		currentCharacteristics: characteristics,
	};
}

function lethalDamage(
	engine: Engine,
	stateOrRead: ReadonlyGameState | ReadContext,
	id: ObjectId,
): boolean {
	const read =
		"view" in stateOrRead
			? stateOrRead
			: createReadContext(engine, stateOrRead);
	const o = read.state.objects.get(id);
	assertDefined(o);
	assert(o.kind === "permanent");
	const snapshot = getSnapshot(read, id);
	assert(snapshot.kind === "permanent");
	const characteristics = snapshot.currentCharacteristics;
	if (characteristics.kind !== "creature") return false;
	return characteristics.toughness > 0 && o.damage >= characteristics.toughness;
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
function anyPossessedCharacteristicStatic(
	engine: Engine,
	state: ReadonlyGameState,
	predicate: (effect: CharacteristicStaticAbilityDefinition) => boolean,
): boolean {
	for (const object of state.objects.values()) {
		for (const id of baseCharacteristics(engine, object).abilities.static) {
			const ability = abilityDefinition(engine, "static", id);
			if (!isCharacteristicStaticAbility(ability)) continue;
			if (predicate(ability)) return true;
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
	engine: Engine,
	view: GameView,
	object: DeepReadOnly<GameObject>,
): { id: ReplacementAbilityId; def: ReplacementEffectDefinition }[] {
	return abilityReferencesOf(view, object).replacement.map((id) => ({
		id,
		def: abilityDefinition(engine, "replacement", id),
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

function prepareEffectData(engine: Engine, state: GameState): void {
	// Which replacements an object has is a derived fact, so the view has to be
	// built before anything is written back.
	const view = cachedGameView(engine, state, state.revision);
	const pending: [object: GameObject, key: string][] = [];
	for (const object of state.objects.values()) {
		for (const { id } of replacementsOf(engine, view, object)) {
			if (object.effectData[id] === undefined) pending.push([object, id]);
		}
	}
	if (pending.length === 0) return;
	for (const [object, key] of pending) object.effectData[key] = {};
	state.revision++;
	// `effectData` is per-effect mutable scratch and is not an input to any
	// derived characteristic, so the view stays accurate across this bump. Any
	// ReadContext taken before the bump still goes stale, as it must.
	GAME_VIEW_CACHE.set(state, { engine, revision: state.revision, view });
}

/** The object this event is about to put onto the battlefield, if any. */
function enteringObject(ev: GameEvent | undefined): ObjectId | null {
	return ev?.kind === "change zone" && ev.destination.zone === "battlefield"
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
	object: DeepReadOnly<GameObject> | null,
	ev: ZoneChangeEvent,
): readonly ReplacementAbilityId[] {
	if (ev.destination.zone === "battlefield" && ev.destination.copiableOverride)
		return ev.destination.copiableOverride.abilities.replacement;
	if (ev.from === null) return ev.createdToken.values.abilities.replacement;
	assertDefined(object);
	return abilityReferencesOf(view, object).replacement;
}

/**
 * Every replacement effect currently in play, bound to its source.
 *
 * Pass the event being resolved to get the entering object's *would-be*
 * possession instead of its canonical possession; without it this is the plain
 * event-independent sweep.
 */
function collectReplacements(
	engine: Engine,
	state: ReadonlyGameState,
	ev?: GameEvent,
): BoundReplacement[] {
	const out: BoundReplacement[] = [];
	const view = cachedGameView(engine, state, state.revision);
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
			for (const { id: abilityId, def } of replacementsOf(engine, view, o)) {
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

	if (
		entering !== null &&
		ev?.kind === "change zone" &&
		ev.destination.zone === "battlefield"
	) {
		const canonical = maybeObject(state, entering);
		if (ev.from === null) {
			assert(
				canonical === null,
				`created token id ${ev.object} is already in use`,
			);
		}
		const o: DeepReadOnly<GameObject> | null =
			canonical ??
			(ev.from === null
				? {
						kind: "permanent",
						id: ev.object,
						owner: ev.destination.controller,
						controller: ev.destination.controller,
						zone: "battlefield",
						representation: {
							kind: "token",
							createdValues: ev.createdToken.values,
						},
						tapped: ev.destination.tapped ?? false,
						summoningSick: true,
						counters: { ...ev.destination.counters },
						effectData: ev.createdToken.effectData,
						damage: 0,
						attacking: false,
						blocking: false,
						token: true,
						attributes: {},
					}
				: null);
		// The would-be permanent is evaluated in the zone it is entering, so an
		// ETB replacement written with the ordinary battlefield default works
		// whether the object gets there on its own or as a copy.
		if (o) {
			const displayName =
				ev.destination.copiableOverride?.name ??
				(ev.from === null ? ev.createdToken.values.name : viewName(view, o.id));
			for (const id of incomingReplacementRefs(view, o, ev)) {
				const def = abilityDefinition(engine, "replacement", id);
				if (!functionsHere(def.functionsFrom, "battlefield")) continue;
				out.push({
					id: `${o.id}:${id}` as EffectId,
					def,
					source: o,
					// CR 616.1b has already settled who it enters under.
					controller: ev.destination.controller,
					data: effectDataFor(o, id),
					label: `${displayName}#${o.id} — ${def.text}`,
				});
			}
		}
	}

	for (const effect of state.temporaryEffects) {
		// A spell-effect-sourced temporary effect is defined by an `EffectDef`.
		// None of those are replacement effects today: their definitions are read
		// by the layer walk or action rules, so only builtins reach this pipeline.
		if (effect.source.origin !== "builtin") continue;
		// `collectReplacements` reads a ReadonlyGameState, but a consumed shield
		// has to record its own consumption. `onApplied` runs only while the
		// live state is being mutated, so the write is safe; the cast is what
		// makes it expressible.
		const builtin = effect.source.builtin as BuiltinTemporaryEffect;
		let def: ReplacementEffectDefinition;
		switch (builtin.kind) {
			case "control-entering-creatures":
				def = {
					label: `control-entering-creatures:${effect.controller}`,
					layer: "control",
					functionsFrom: "any",
					text: "If a creature would enter the battlefield under an opponent's control this turn, it enters under your control instead.",
					applies(ev, ctx) {
						if (
							ev.kind !== "change zone" ||
							ev.destination.zone !== "battlefield"
						)
							return false;
						if (ev.destination.controller === effect.controller) return false;
						return etbPreview(
							engine,
							ctx.state,
							ev,
						).currentCharacteristics.types.includes("creature");
					},
					replace: (ev) =>
						ev.kind === "change zone" && ev.destination.zone === "battlefield"
							? [
									{
										...ev,
										destination: {
											...ev.destination,
											controller: effect.controller,
										},
									},
								]
							: [ev],
				};
				break;
			case "prevent-next-damage": {
				const recipient = builtin.recipient;
				def = {
					label: `prevent-next-damage:${builtin.remaining}`,
					layer: "other",
					isPreventionEffect: true,
					functionsFrom: "any",
					text: `Prevent the next ${builtin.remaining} damage that would be dealt to ${
						recipient.type === "player"
							? `P${recipient.player}`
							: `#${recipient.id}`
					} this turn.`,
					applies(ev) {
						if (ev.kind !== "damage" || ev.amount <= 0) return false;
						if (builtin.remaining <= 0) return false;
						return recipient.type === "player"
							? ev.recipient.type === "player" &&
									ev.recipient.player === recipient.player
							: ev.recipient.type === "permanent" &&
									ev.recipient.id === recipient.id;
					},
					replace(ev) {
						if (ev.kind !== "damage") return [ev];
						const remaining =
							ev.amount - Math.min(ev.amount, builtin.remaining);
						return remaining > 0 ? [{ ...ev, amount: remaining }] : [];
					},
					onApplied(ev) {
						assert(ev.kind === "damage");
						// Mutable instance state lives on the record, not the definition.
						builtin.remaining = Math.max(0, builtin.remaining - ev.amount);
					},
				};
				break;
			}
			case "prevent-color-damage":
				def = {
					label: `prevent-color-damage:${builtin.color}`,
					layer: "other",
					isPreventionEffect: true,
					functionsFrom: "any",
					text: `Prevent all damage that ${builtin.color} sources would deal this turn.`,
					applies: (ev) =>
						ev.kind === "damage" && ev.sourceColors.includes(builtin.color),
					replace: () => [],
				};
				break;
			case "regeneration-shield":
				def = {
					label: `regeneration-shield:${builtin.permanent}`,
					layer: "other",
					functionsFrom: "any",
					text: `Regeneration shield on #${builtin.permanent}.`,
					applies: (ev) =>
						ev.kind === "destroy" &&
						ev.object === builtin.permanent &&
						!ev.noRegen &&
						!builtin.used,
					replace: (ev) =>
						ev.kind === "destroy"
							? [{ kind: "regenerate", object: ev.object }]
							: [ev],
					onApplied: () => {
						builtin.used = true;
					},
				};
				break;
			default:
				assertNever(builtin);
		}
		out.push({
			id: effect.id,
			def,
			source: null,
			controller: effect.controller,
			data: {},
			label: `(temporary) ${def.text}`,
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
		case "cast":
		case "cycle":
		case "draw":
		case "draw cards":
		case "mill":
		case "exile top":
		case "scry":
		case "surveil":
		case "choose from top":
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
			return ev.recipient.type === "player"
				? ev.recipient.player
				: affectedObjectPlayer(state, ev.recipient.id);

		case "counter":
			return affectedObjectPlayer(state, ev.spell);
		case "destroy":
		case "sacrifice":
		case "regenerate":
			return affectedObjectPlayer(state, ev.object);
		case "tap":
		case "untap": {
			const first = ev.objects[0];
			assertDefined(first, `${ev.kind} event has no affected permanent`);
			const player = affectedObjectPlayer(state, first);
			assert(
				ev.objects.every((id) => affectedObjectPlayer(state, id) === player),
				`replacement ordering for a ${ev.kind} event affecting multiple players is not implemented`,
			);
			return player;
		}

		case "add counters":
		case "remove counters":
			return affectedObjectPlayer(state, ev.permanent.id);

		case "add player counters":
		case "remove player counters":
			return ev.player;

		case "create token":
			return ev.controller;

		case "lose game":
		case "win game":
			return ev.player;

		case "change zone": {
			if (ev.from === null) return ev.destination.controller;
			const o = maybeObject(state, ev.object);
			assertDefined(o);
			if (ev.from === "battlefield") return controllerOf(o) ?? o.owner;
			if (ev.destination.zone === "stack") return ev.destination.controller;

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

function applyCtxFor(
	read: ReadContext,
	r: BoundReplacement,
	run: ReplacementRun,
	choices: AnyChoiceController,
): ReplacementApplyCtx {
	return { ...ctxFor(read, r, run), choices };
}

function prohibitionsFor(read: ReadContext, ev: GameEvent): BoundProhibition[] {
	const out: BoundProhibition[] = [];
	for (const object of read.state.objects.values()) {
		const snapshot = getSnapshot(read, object.id);
		const definitions: ProhibitionDef[] = [
			...prohibitionsFromKeywords(snapshot.currentCharacteristics.keywords),
			...abilityReferencesOf(read.view, object).prohibition.map((id) =>
				abilityDefinition(read.engine, "prohibition", id),
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
	return collectReplacements(read.engine, read.state, ev).filter((r) => {
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

		const chooser =
			tiered.length === 1 ? null : affectedPlayer(read.state, current);

		const chosen =
			chooser === null
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
		const ctx = applyCtxFor(read, chosen, run, choices);
		const produced = chosen.def.replace(current, ctx);
		chosen.def.onApplied?.(current, ctx);

		log(
			read.state as GameState,
			`  [replace] ${chosen.label}` +
				(chooser === null ? "" : ` (P${chooser} chose from ${tiered.length})`),
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

/**
 * Move `id` out of `from` and into `destination`, replacing it with the new
 * object CR 400.7 says the movement creates.
 *
 * The destination is the same discriminated union the zone-change event
 * carries, so this cannot be handed a controller for a graveyard arrival or a
 * library position for a battlefield arrival.
 */
function moveObject(
	engine: Engine,
	state: GameState,
	id: ObjectId,
	from: Zone,
	destination: ZoneChangeDestination,
): ObjectId {
	const to = destination.zone;
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
	if (destination.zone === "battlefield") {
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
			controller: destination.controller,
			zone: "battlefield",
			representation,
			...(destination.copiableOverride
				? {
						copiableOverride: cloneCharacteristics(
							destination.copiableOverride,
						),
					}
				: {}),
			tapped: destination.tapped ?? false,
			summoningSick: true,
			counters: { ...destination.counters },
			effectData: {},
			damage: 0,
			attacking: false,
			blocking: false,
			token: tokenValues !== null,
			attributes: {},
		};
	} else if (destination.zone === "stack") {
		assert(printedId, "tokens cannot become spells");
		fresh = {
			kind: "spell",
			id: freshId,
			owner: old.owner,
			controller: destination.controller,
			zone: "stack",
			representation: { kind: "card", cardId: printedId },
			effectData: {},
		};
	} else if (tokenValues) {
		fresh = {
			kind: "nonbattlefield-token",
			id: freshId,
			owner: old.owner,
			zone: destination.zone,
			createdValues: tokenValues,
			effectData: {},
		};
	} else {
		assert(printedId, "card-backed object has no card identity");
		fresh = {
			kind: "card",
			id: freshId,
			owner: old.owner,
			zone: destination.zone,
			cardId: printedId,
			effectData: {},
		};
	}
	state.objects.set(fresh.id, fresh);
	if (destination.zone === "stack") {
		assert(
			fresh.kind === "spell",
			"only spells can enter the stack as objects",
		);
		state.stack.push({
			kind: "spell",
			objectId: fresh.id,
			targets: structuredClone(destination.targets),
		});
	} else {
		const dst = mutableZoneList(state, destination.zone, fresh.owner);
		if (destination.zone === "library" && destination.position === "bottom")
			dst.unshift(fresh.id);
		else dst.push(fresh.id);
	}
	log(
		state,
		`  ${initialCharacteristics(engine, fresh).name}#${fresh.id} is now in ${to}`,
	);
	return fresh.id;
}

/** Convenience for logs/tests. */
function describeEvent(
	engine: Engine,
	state: ReadonlyGameState,
	ev: GameEvent,
): string {
	switch (ev.kind) {
		case "cast":
			return `cast(P${ev.player}, ${name(engine, state, ev.spell)}#${ev.spell})`;
		case "draw cards":
			return `draw cards(P${ev.player}, ${ev.amount})`;
		case "draw":
			return `draw(P${ev.player})`;
		case "cycle":
			return `cycle(P${ev.player}, ${name(engine, state, ev.card)}#${ev.card})`;
		case "mill":
			return `mill(P${ev.player}, ${ev.amount})`;
		case "exile top":
			return `exile top(P${ev.player}, ${ev.amount})`;
		case "scry":
			return `scry(P${ev.player}, ${ev.amount})`;
		case "surveil":
			return `surveil(P${ev.player}, ${ev.amount})`;
		case "choose from top":
			return `choose ${ev.keep} from top(P${ev.player}, ${ev.amount})`;
		case "discard":
			if (ev.cards.kind === "hand-size")
				return `discard(P${ev.player}, to hand size)`;
			if (ev.cards.kind === "specific")
				return `discard(P${ev.player}, ${name(engine, state, ev.cards.card)})`;
			assert(ev.cards.kind === "any");
			return `discard(P${ev.player})`;
		case "damage": {
			const recipient =
				ev.recipient.type === "player"
					? `P${ev.recipient.player}`
					: name(engine, state, ev.recipient.id);
			return `damage(${ev.amount} from ${name(engine, state, ev.source)} to ${recipient})`;
		}
		case "destroy":
			return `destroy(${name(engine, state, ev.object)})`;
		case "counter":
			return `counter(${name(engine, state, ev.spell)})`;
		case "sacrifice":
			return `sacrifice(${name(engine, state, ev.object)})`;
		case "regenerate":
			return `regenerate(${name(engine, state, ev.object)})`;
		case "change zone": {
			const to = ev.destination;
			const extras = (
				to.zone === "battlefield"
					? [
							to.tapped ? "tapped" : "",
							to.counters ? JSON.stringify(to.counters) : "",
							to.copiableOverride
								? `copiableOverride=${to.copiableOverride.name}`
								: "",
						]
					: to.zone === "library"
						? [to.position]
						: []
			)
				.filter(Boolean)
				.join(" ");
			const objectName =
				ev.from === null
					? ev.createdToken.values.name
					: name(engine, state, ev.object);
			const from = ev.from ?? "creation";
			return `move(${objectName}#${ev.object}: ${from}->${to.zone}${extras ? ` ${extras}` : ""})`;
		}
		case "add counters":
			return `counters(${ev.amount}x ${ev.counter} on ${name(engine, state, ev.permanent.id)})`;
		case "add player counters":
			return `counters(${ev.amount}x ${ev.counter} on P${ev.player})`;
		case "remove counters":
		case "remove player counters": {
			const tgt =
				ev.kind === "remove counters"
					? name(engine, state, ev.permanent.id)
					: `P${ev.player}`;
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
		case "untap":
			return `${ev.kind}(${ev.objects
				.map((id) => `${name(engine, state, id)}#${id}`)
				.join(", ")})`;
		case "begin turn":
			return `beginTurn(P${ev.player}, #${ev.turnId}${ev.isExtra ? ", extra" : ""})`;
		case "begin step":
			return `beginStep(P${ev.player}, ${ev.step})`;
		case "begin phase":
			return `beginPhase(P${ev.player}, ${ev.phase})`;
		case "create token":
			return `token(${ev.amount}x ${ev.characteristics.name} for P${ev.controller})`;
		case "lose game":
			return `loseGame(P${ev.player}: ${ev.reason})`;
		case "declare attackers":
			return ev.attackers.length === 0
				? `declareAttackers(P${ev.player}, none)`
				: `declareAttackers(P${ev.player}, ${ev.attackers.map((id) => name(engine, state, id)).join(", ")})`;
		case "declare blockers":
			return ev.blockers.length === 0
				? `declareBlockers(P${ev.player}, none)`
				: `declareBlockers(P${ev.player}, ${ev.blockers
						.map(
							({ blocker, attacker }) =>
								`${name(engine, state, blocker)} -> ${name(engine, state, attacker)}`,
						)
						.join(", ")})`;
		case "win game":
			return `winGame(P${ev.player}: ${ev.reason})`;
	}
}

/* ------------------------------------------------------------------ *
 * State-based actions
 * ------------------------------------------------------------------ */

function checkStateBasedActions(
	engine: Engine,
	state: GameState,
	source: ChoiceSource,
): void {
	checkStateBasedActionsIn(engine, state, asChoiceController(engine, source));
}

function checkStateBasedActionsIn(
	engine: Engine,
	state: GameState,
	choices: AnyChoiceController,
): void {
	for (let pass = 0; pass < 32; pass++) {
		let acted = false;
		const deathtouchedSinceLastCheck = new Set<ObjectId>();
		for (const id of state.battlefield) {
			if (maybePermanent(state, id)?.attributes.deathtouched)
				deathtouchedSinceLastCheck.add(id);
		}

		for (const p of state.players) {
			//   704.5a. If a player has 0 or less life, that player loses the game.
			if (!p.lost && !p.won && p.life <= 0) {
				performIn(
					engine,
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
			if (!p.lost && !p.won && p.stats.drawn.fromEmptyLibrary) {
				performIn(
					engine,
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
				p.stats.drawn.fromEmptyLibrary = false;
				if (p.lost) acted = true;
			}
			// 704.5c. If a player has ten or more poison counters, that player loses
			// the game.
			if (
				!p.lost &&
				!p.won &&
				p.counters.poison !== undefined &&
				p.counters.poison >= 10
			) {
				performIn(
					engine,
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
		// to exist.
		for (const o of state.objects.values()) {
			if (o.kind === "nonbattlefield-token") {
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
					`  SBA: ${initialCharacteristics(engine, o).name}#${o.id} (token) ceases to exist`,
				);
				acted = true;
			} else if (o.kind === "spell") {
				// 704.5e. If a copy of a spell is in a zone other than the stack, it ceases
				// to exist.

				// right now, we should be doing the proper bookkeeping to prevent this.
				assert(o.zone === "stack");
			}
			// If a copy of a card is in any zone other than the stack or the
			// battlefield, it ceases to exist.
			// TODO: remove copies.
		}

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
		// ability* possessed by some object, or from a temporary P/T effect created
		// by a resolving spell or ability.
		const hasCharacteristicChangingStatic = anyPossessedCharacteristicStatic(
			engine,
			state,
			(effect) => includes(CHARACTERISTIC_CHANGING_LAYERS, effect.layer),
		);
		const hasTemporaryPtChange = state.temporaryEffects.some(
			(effect) =>
				temporaryEffectDefinition(engine, effect)?.kind === "modify-pt",
		);

		const needsPermanentSbas =
			hasCharacteristicChangingStatic ||
			hasTemporaryPtChange ||
			state.battlefield.some((id) => {
				const object = maybePermanent(state, id);
				if (!object) return false;
				if (object.damage > 0 || deathtouchedSinceLastCheck.has(id))
					return true;
				if (object.counters["+1/+1"] || object.counters["-1/-1"]) return true;
				const initial = initialCharacteristics(engine, object);
				return "toughness" in initial && initial.toughness <= 0;
			});
		if (!needsPermanentSbas) {
			if (!acted) return;
			continue;
		}

		const sbaRead = createReadContext(engine, state);
		const simultaneousView = sbaRead.view;
		const zeroToughness: { id: ObjectId; toughness: number }[] = [];
		const lethalDamageIds: ObjectId[] = [];
		const counterCancellations: { id: ObjectId; amount: number }[] = [];
		for (const id of state.battlefield) {
			const o = maybePermanent(state, id);
			if (!o) continue;
			const snapshot = getSnapshot(sbaRead, id);
			assert(snapshot.kind === "permanent");
			const characteristics = snapshot.currentCharacteristics;
			if (characteristics.kind === "creature") {
				if (characteristics.toughness <= 0) {
					zeroToughness.push({ id, toughness: characteristics.toughness });
				} else if (
					lethalDamage(engine, sbaRead, id) ||
					deathtouchedSinceLastCheck.has(id)
				) {
					lethalDamageIds.push(id);
				}
			}
			if (o.counters["+1/+1"] && o.counters["-1/-1"]) {
				counterCancellations.push({
					id,
					amount: Math.min(o.counters["+1/+1"], o.counters["-1/-1"]),
				});
			}
		}

		// CR 704.3: determine every applicable SBA from one derived view before
		// performing any of them. Passing that same view into each departure also
		// gives dies triggers the correct last-known set of watching abilities.
		for (const { id, toughness } of zeroToughness) {
			if (!maybePermanent(state, id)) continue;
			// 704.5f. Regeneration cannot replace a nonpositive-toughness death.
			log(
				state,
				`  SBA: ${name(engine, state, id)} has toughness ${toughness}`,
			);
			performIn(
				engine,
				state,
				{
					kind: "change zone",
					object: id,
					from: "battlefield",
					destination: { zone: "graveyard" },
					cause: "sba",
				},
				choices,
				newScope(),
				0,
				simultaneousView,
			);
			acted = true;
		}

		for (const id of lethalDamageIds) {
			if (!maybePermanent(state, id)) continue;
			// 704.5g. If a creature has toughness greater than 0, it has damage marked
			// on it, and the total damage marked on it is greater than or equal to its
			// toughness, that creature has been dealt lethal damage and is destroyed.
			// Regeneration can replace this event.
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
			const objectName = name(engine, state, id);
			const result = performIn(
				engine,
				state,
				destroy,
				choices,
				newScope(),
				0,
				simultaneousView,
			);
			if (result.executed.length > 0) {
				log(state, `  SBA: ${objectName} has lethal damage`);
				acted = true;
			}
		}

		// 704.5q. Counter cancellation was determined in the same SBA window.
		for (const { id, amount } of counterCancellations) {
			if (maybePermanent(state, id)) {
				performIn(
					engine,
					state,
					{
						kind: "remove counters",
						permanent: { type: "permanent", id: id },
						counters: { "+1/+1": amount, "-1/-1": amount },
					},
					choices,
					newScope(),
					0,
				);
				acted = true;
			}
		}

		let clearedDeathtouch = false;
		for (const id of deathtouchedSinceLastCheck) {
			const object = maybePermanent(state, id);
			if (!object?.attributes.deathtouched) continue;
			delete object.attributes.deathtouched;
			clearedDeathtouch = true;
		}
		if (clearedDeathtouch) state.revision++;

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
	/** Objects produced by earlier instructions in this resolution. */
	bindings: Map<string, EntityRef[]>;
}

export function newScope(): Scope {
	return { facts: new Set(), bindings: new Map() };
}

/** Result of running one event through replacements and execution. */
export interface PerformResult {
	executed: GameEvent[];
	created: ObjectId[];
}

/**
 * One successfully executed final event, with the derived information from
 * immediately before and after it. Higher-level events whose child events
 * remove their subject (such as sacrifice) match that subject against
 * `before`; arrival, cast, tap, and other events match their result in `after`.
 */
interface EventOccurrence {
	readonly event: DeepReadOnly<GameEvent>;
	readonly before: GameView;
	readonly after: ReadContext;
	readonly created: readonly ObjectId[];
	readonly changed: readonly ObjectId[];
}

/** Public entry point. Replace, then execute. Callers must run SBAs separately. */
function perform(
	engine: Engine,
	state: GameState,
	event: GameEvent,
	source: ChoiceSource,
): PerformResult {
	return performIn(
		engine,
		state,
		event,
		asChoiceController(engine, source),
		newScope(),
		0,
	);
}

/** Applies event replacements and delegates to `executeIn` to apply changes. */
function performIn(
	engine: Engine,
	state: GameState,
	event: GameEvent,
	choices: AnyChoiceController,
	scope: Scope,
	depth: number,
	leavesTriggerView?: GameView,
): PerformResult {
	log(state, `${"  ".repeat(depth)}> ${describeEvent(engine, state, event)}`);
	// Mutable replacement scratch is installed before the mutation-free read window.
	prepareEffectData(engine, state);
	const read = createReadContext(engine, state);
	const finals = resolveReplacements(read, event, choices);
	if (finals.length === 0)
		log(state, `${"  ".repeat(depth + 1)}(replaced by nothing)`);
	const executed: GameEvent[] = [];
	const created: ObjectId[] = [];
	for (const ev of finals) {
		const before = createReadContext(engine, state);
		const result = executeIn(
			engine,
			state,
			before,
			ev,
			choices,
			scope,
			depth + 1,
			leavesTriggerView,
		);
		executed.push(...result.executed);
		created.push(...result.created);
	}
	return { executed, created };
}

/**
 * Executes an event after replacements. New events are fed back through
 * `performIn` so they receive their own replacement pass.
 */
function executeIn(
	engine: Engine,
	state: GameState,
	before: ReadContext,
	ev: GameEvent,
	choices: AnyChoiceController,
	scope: Scope,
	depth: number,
	leavesTriggerView?: GameView,
): PerformResult {
	if (ev.guard && !scope.facts.has(ev.guard)) {
		log(
			state,
			`${"  ".repeat(depth)}(skipped ${describeEvent(engine, state, ev)} — guard "${ev.guard}" unmet)`,
		);
		return { executed: [], created: [] };
	}
	if (ev.unless && scope.facts.has(ev.unless)) {
		log(
			state,
			`${"  ".repeat(depth)}(skipped ${describeEvent(engine, state, ev)} — fact "${ev.unless}" present)`,
		);
		return { executed: [], created: [] };
	}

	let happened = true;
	// Materialize the view before any direct mutation or child event can make
	// the ReadContext stale. Trigger matching receives this exact LKI view.
	const beforeView = before.view;
	const created: ObjectId[] = [];
	const changed: ObjectId[] = [];
	const childResults: PerformResult[] = [];
	let leavesBattlefieldTriggers: LeavesBattlefieldTriggerCandidate[] = [];

	switch (ev.kind) {
		case "cast": {
			const spell = maybeObject(state, ev.spell);
			assert(spell?.kind === "spell", "cast event subject is not a spell");
			assert(spell.zone === "stack", "cast event subject is not on the stack");
			assert(
				spell.controller === ev.player,
				"cast event player does not control its spell",
			);
			break;
		}

		case "cycle": {
			const card = maybeObject(state, ev.card);
			assert(card?.kind === "card", "cycled event subject is not a card");
			assert(
				card.owner === ev.player,
				"cycled event player does not own its card",
			);
			break;
		}

		case "draw cards": {
			// Should this be >= 0? could a replacement effect alter this legally?
			assert(
				ev.amount >= 1,
				`draw cards amount must be at least 1, got ${ev.amount}`,
			);
			for (let i = 0; i < ev.amount; i++) {
				childResults.push(
					performIn(
						engine,
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
				p.stats.drawn.fromEmptyLibrary = true;
				log(
					state,
					`${"  ".repeat(depth)}P${ev.player} tried to draw from an empty library`,
				);
				happened = false;
				break;
			}
			p.stats.drawn.thisTurn++;
			if (
				currentStepKind(state) === "draw" &&
				activePlayer(state) === ev.player
			)
				p.stats.drawn.inDrawStep++;
			// Drawing *is* a zone change, so zone-change replacements get a look too.
			childResults.push(
				performIn(
					engine,
					state,
					{
						kind: "change zone",
						object: top,
						from: "library",
						destination: { zone: "hand" },
						cause: "draw",
					},
					choices,
					scope,
					depth + 1,
				),
			);
			break;
		}

		case "mill":
		case "exile top": {
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
						engine,
						state,
						{
							kind: "change zone",
							object: top,
							from: "library",
							destination: {
								zone: ev.kind === "mill" ? "graveyard" : "exile",
							},
							cause: ev.kind,
						},
						choices,
						scope,
						depth + 1,
					),
				);
			}
			break;
		}

		case "scry": {
			assert(
				Number.isSafeInteger(ev.amount) && ev.amount >= 0,
				`scry amount must be a nonnegative integer, got ${ev.amount}`,
			);
			if (ev.amount === 0) {
				happened = false;
				break;
			}
			const library = state.players[ev.player].library;
			const count = Math.min(ev.amount, library.length);
			const seen = library.slice(library.length - count).reverse();
			const arrangement = choices.chooseScry(state, ev.player, seen);
			const arranged = [...arrangement.top, ...arrangement.bottom];
			assert(arranged.length === seen.length, "scry changed the card count");
			assert(
				new Set(arranged).size === arranged.length,
				"scry arrangement contains duplicate cards",
			);
			assert(
				arranged.every((id) => seen.includes(id)),
				"scry arrangement contains a card that was not looked at",
			);

			library.length -= count;
			library.unshift(...[...arrangement.bottom].reverse());
			library.push(...[...arrangement.top].reverse());
			log(state, `${"  ".repeat(depth)}P${ev.player} scries ${ev.amount}`);
			break;
		}

		case "surveil": {
			assert(
				Number.isSafeInteger(ev.amount) && ev.amount >= 0,
				`surveil amount must be a nonnegative integer, got ${ev.amount}`,
			);
			if (ev.amount === 0) {
				happened = false;
				break;
			}
			const library = state.players[ev.player].library;
			const count = Math.min(ev.amount, library.length);
			const seen = library.slice(library.length - count).reverse();
			const arrangement = choices.chooseSurveil(state, ev.player, seen);
			const arranged = [...arrangement.top, ...arrangement.bottom];
			assert(arranged.length === seen.length, "surveil changed the card count");
			assert(
				new Set(arranged).size === arranged.length,
				"surveil arrangement contains duplicate cards",
			);
			assert(
				arranged.every((id) => seen.includes(id)),
				"surveil arrangement contains a card that was not looked at",
			);

			// Use normal zone-change events so replacements and triggers apply.
			// Reverse the chosen order so its first card is on top of the graveyard.
			for (const id of [...arrangement.bottom].reverse()) {
				childResults.push(
					performIn(
						engine,
						state,
						{
							kind: "change zone",
							object: id,
							from: "library",
							destination: { zone: "graveyard" },
							cause: "surveil",
						},
						choices,
						scope,
						depth + 1,
					),
				);
			}

			for (const id of arrangement.top) {
				const index = library.indexOf(id);
				assert(index !== -1, `surveil top card ${id} left the library`);
				library.splice(index, 1);
			}
			library.push(...[...arrangement.top].reverse());
			log(state, `${"  ".repeat(depth)}P${ev.player} surveils ${ev.amount}`);
			break;
		}

		case "choose from top": {
			assert(
				Number.isSafeInteger(ev.amount) && ev.amount >= 1,
				`choose-from-top amount must be a positive integer, got ${ev.amount}`,
			);
			assert(
				Number.isSafeInteger(ev.keep) && ev.keep >= 1 && ev.keep <= ev.amount,
				`choose-from-top keep count must be between one and ${ev.amount}, got ${ev.keep}`,
			);
			const library = state.players[ev.player].library;
			const count = Math.min(ev.amount, library.length);
			const seen = library.slice(library.length - count).reverse();
			const choice = choices.chooseFromTop(state, ev.player, seen, ev.keep);
			const actualKeep = Math.min(ev.keep, seen.length);
			assert(
				choice.kept.length === actualKeep,
				`choose-from-top must keep exactly ${actualKeep} cards`,
			);
			const arranged = [...choice.kept, ...choice.bottom];
			assert(
				arranged.length === seen.length,
				"choose-from-top changed the card count",
			);
			assert(
				new Set(arranged).size === arranged.length,
				"choose-from-top arrangement contains duplicate cards",
			);
			assert(
				arranged.every((id) => seen.includes(id)),
				"choose-from-top arrangement contains a card that was not looked at",
			);
			if (seen.length === 0) {
				assert(choice.bottom.length === 0);
				log(
					state,
					`${"  ".repeat(depth)}P${ev.player} looks at an empty library`,
				);
				break;
			}

			for (const id of choice.kept) {
				assert(
					library.includes(id),
					`choose-from-top kept card ${id} left the library`,
				);
				childResults.push(
					performIn(
						engine,
						state,
						{
							kind: "change zone",
							object: id,
							from: "library",
							destination: { zone: "hand" },
							cause: "put",
						},
						choices,
						scope,
						depth + 1,
					),
				);
			}

			for (const id of choice.bottom) {
				const index = library.indexOf(id);
				assert(index !== -1, `choose-from-top card ${id} left the library`);
				library.splice(index, 1);
			}
			library.unshift(...[...choice.bottom].reverse());
			log(
				state,
				`${"  ".repeat(depth)}P${ev.player} keeps ${actualKeep} of the top ${count} cards`,
			);
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
					const selected: ObjectId = choices.chooseObject(state, ev.player, {
						reason: { kind: "discard" },
						objects: remaining,
					});

					assertDefined(selected);
					toDiscard.push(selected);
				}
				toDiscard.forEach((id) => {
					childResults.push(
						performIn(
							engine,
							state,
							{
								kind: "change zone",
								object: id,
								from: "hand",
								destination: { zone: "graveyard" },
								cause: "discard",
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
					: choices.chooseObject(state, ev.player, {
							reason: { kind: "discard" },
							objects: p.hand,
						});
			assertDefined(chosen);
			childResults.push(
				performIn(
					engine,
					state,
					{
						kind: "change zone",
						object: chosen,
						from: "hand",
						destination: { zone: "graveyard" },
						cause: "discard",
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
			if (ev.recipient.type === "player") {
				state.players[ev.recipient.player].life -= ev.amount;
				log(
					state,
					`${"  ".repeat(depth)}P${ev.recipient.player} -> ${state.players[ev.recipient.player].life} life`,
				);
			} else {
				const o = maybePermanent(state, ev.recipient.id);
				if (o?.zone !== "battlefield") {
					happened = false;
					break;
				}
				const characteristics = getSnapshot(before, o.id);
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
					`${"  ".repeat(depth)}${name(engine, state, o.id)} has ${o.damage} damage marked`,
				);
			}
			if (ev.lifelink) {
				childResults.push(
					performIn(
						engine,
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

		case "counter": {
			const spell = maybeObject(state, ev.spell);
			if (spell?.kind !== "spell" || spell.zone !== "stack") {
				happened = false;
				break;
			}
			const movement = performIn(
				engine,
				state,
				{
					kind: "change zone",
					object: spell.id,
					from: "stack",
					destination: { zone: "graveyard" },
					cause: "counter",
				},
				choices,
				scope,
				depth + 1,
			);
			childResults.push(movement);
			// Replacing the destination does not undo the counter. The spell was
			// countered if the movement from the stack happened at all.
			happened = movement.executed.some(
				(child) =>
					child.kind === "change zone" &&
					child.object === spell.id &&
					child.from === "stack" &&
					child.cause === "counter",
			);
			break;
		}

		case "sacrifice": {
			const o = maybePermanent(state, ev.object);
			if (o?.zone !== "battlefield") {
				happened = false;
				break;
			}
			const snapshot = getSnapshot(before, o.id);
			assert(snapshot.kind === "permanent");
			const movement = performIn(
				engine,
				state,
				{
					kind: "change zone",
					object: o.id,
					from: "battlefield",
					destination: { zone: "graveyard" },
					cause: "sacrifice",
				},
				choices,
				scope,
				depth + 1,
			);
			childResults.push(movement);
			// A destination replacement such as Rest in Peace does not undo the
			// sacrifice. It only changes where the permanent arrives.
			happened = movement.executed.some(
				(child) =>
					child.kind === "change zone" &&
					child.object === o.id &&
					child.from === "battlefield" &&
					child.cause === "sacrifice",
			);
			break;
		}

		case "destroy": {
			const o = maybePermanent(state, ev.object);
			if (o?.zone !== "battlefield") {
				happened = false;
				break;
			}
			const snapshot = getSnapshot(before, o.id);
			assert(snapshot.kind === "permanent");
			const movement = performIn(
				engine,
				state,
				{
					kind: "change zone",
					object: o.id,
					from: "battlefield",
					destination: { zone: "graveyard" },
					cause: "destroy",
				},
				choices,
				scope,
				depth + 1,
				leavesTriggerView,
			);
			childResults.push(movement);
			happened = movement.executed.some(
				(child) =>
					child.kind === "change zone" &&
					child.object === o.id &&
					child.from === "battlefield" &&
					child.destination.zone === "graveyard" &&
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
				`${"  ".repeat(depth)}${name(engine, state, o.id)} regenerates (tapped, damage removed, out of combat)`,
			);
			break;
		}

		case "change zone": {
			leavesBattlefieldTriggers = leavesBattlefieldTriggerCandidates(
				engine,
				leavesTriggerView ?? before.view,
				ev,
			);
			let newId: ObjectId;
			if (ev.from === null) {
				assert(
					!state.objects.has(ev.object),
					`created token id ${ev.object} is already in use`,
				);
				newId = ev.object;
				state.objects.set(newId, {
					kind: "permanent",
					id: newId,
					owner: ev.destination.controller,
					controller: ev.destination.controller,
					zone: "battlefield",
					representation: {
						kind: "token",
						createdValues: cloneCharacteristics(ev.createdToken.values),
					},
					...(ev.destination.copiableOverride
						? {
								copiableOverride: cloneCharacteristics(
									ev.destination.copiableOverride,
								),
							}
						: {}),
					tapped: ev.destination.tapped ?? false,
					summoningSick: true,
					counters: { ...ev.destination.counters },
					effectData: {},
					damage: 0,
					attacking: false,
					blocking: false,
					token: true,
					attributes: {},
				});
				state.battlefield.push(newId);
				log(
					state,
					`  ${initialCharacteristics(engine, permanent(state, newId)).name}#${newId} is now in battlefield`,
				);
			} else {
				recordSourceDeparture(state, before, ev.object, ev.from);
				newId = moveObject(engine, state, ev.object, ev.from, ev.destination);
			}
			created.push(newId);
			break;
		}

		case "add counters": {
			if (ev.amount <= 0) {
				throw new Error(
					"undefined behavior: tried to add non-natural quantity of counters.",
				);
			}
			const o = maybePermanent(state, ev.permanent.id);
			if (!o) {
				throw new Error(
					"undefined behavior: tried to add counters to a non-existent permanent.",
				);
			}
			o.counters[ev.counter] = (o.counters[ev.counter] ?? 0) + ev.amount;
			log(
				state,
				`${"  ".repeat(depth)}${name(engine, state, o.id)} now has ${o.counters[ev.counter]} ${ev.counter}`,
			);
			break;
		}
		case "add player counters": {
			if (ev.amount <= 0) {
				throw new Error(
					"undefined behavior: tried to add non-natural quantity of counters.",
				);
			}
			const p = state.players[ev.player];
			p.counters[ev.counter] = (p.counters[ev.counter] ?? 0) + ev.amount;
			log(
				state,
				`${"  ".repeat(depth)}${p.id} now has ${p.counters[ev.counter]} ${ev.counter}`,
			);
			break;
		}
		case "remove counters": {
			const o = maybePermanent(state, ev.permanent.id);
			if (!o) {
				happened = false;
				break;
			}
			o.counters = bagAfterRemoval(o.counters, ev.counters);
			break;
		}
		case "remove player counters": {
			const p = state.players[ev.player];
			p.counters = bagAfterRemoval(p.counters, ev.counters);
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
			assert(
				new Set(ev.objects).size === ev.objects.length,
				`${ev.kind} event contains duplicate permanents`,
			);
			const transitions = ev.objects.flatMap((id) => {
				const object = maybePermanent(state, id);
				return object && object.tapped !== tapped ? [object] : [];
			});
			if (transitions.length === 0) {
				happened = false;
				break;
			}
			// The complete transition set is determined before any permanent changes.
			for (const o of transitions) {
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
				const tokenId = state.nextObjectId++ as ObjectId;
				childResults.push(
					performIn(
						engine,
						state,
						{
							kind: "change zone",
							object: tokenId,
							from: null,
							destination: { zone: "battlefield", controller: ev.controller },
							cause: "effect",

							createdToken: {
								values: cloneCharacteristics(ev.characteristics),
								effectData: {},
							},
						},
						choices,
						scope,
						depth + 1,
					),
				);
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
			const eligible = new Set(eligibleAttackers(engine, state, ev.player));
			for (const id of ev.attackers) {
				if (!eligible.has(id)) {
					throw new IllegalAttackDeclarationError(
						`${name(engine, state, id)} is not an eligible attacker for P${ev.player}`,
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
				const attackerSnapshot = getSnapshot(before, id);
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
				creaturesControlledBy(
					createReadContext(engine, state),
					currentTurn.player,
				)
					.filter((o) => o.attacking)
					.map((o) => o.id),
			);
			const eligible = new Set(eligibleBlockers(engine, state, ev.player));
			for (const { blocker, attacker } of ev.blockers) {
				if (usedBlockers.has(blocker)) {
					throw new IllegalBlockDeclarationError(
						`${name(engine, state, blocker)} cannot block multiple attackers`,
					);
				}
				usedBlockers.add(blocker);
				if (!eligible.has(blocker)) {
					throw new IllegalBlockDeclarationError(
						`${name(engine, state, blocker)} is not an eligible blocker for P${ev.player}`,
					);
				}
				if (!attackingIds.has(attacker)) {
					throw new IllegalBlockDeclarationError(
						`${name(engine, state, attacker)} is not a legal attacker to be blocked`,
					);
				}
				if (
					!eligibleBlockers(engine, state, ev.player, attacker).includes(
						blocker,
					)
				) {
					throw new IllegalBlockDeclarationError(
						`${name(engine, state, blocker)} cannot block ${name(engine, state, attacker)}`,
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
		if (ev.kind === "change zone")
			enqueueLeavesBattlefieldTriggers(
				state,
				leavesBattlefieldTriggers,
				ev,
				created,
			);
		detectTriggers(state, {
			event: ev,
			before: beforeView,
			after: createReadContext(engine, state),
			created,
			changed,
		});
		if (ev.kind === "begin step" && state.delayedTriggers.length > 0)
			enqueueMatchingDelayedTriggers(engine, state, ev);
		if (ev.fact) scope.facts.add(ev.fact);
	}

	return { executed, created };
}

/* ------------------------------------------------------------------ *
 * Trigger detection
 * ------------------------------------------------------------------ */

/** Adds a trigger to `state.pendingTriggers`. */
function enqueueTrigger(
	engine: Engine,
	state: GameState,
	source: GameObject,
	triggerId: TriggeredAbilityId,
	trigger: TriggeredAbilityDefinition,
	triggeringEvent: DeepReadOnly<GameEvent>,
	created: readonly ObjectId[],
): void {
	// A card in the graveyard has no controller (CR 109.4). Its owner is the
	// only player the engine can mean by "you" for a trigger that functions
	// from there, so the pending trigger belongs to the owner.
	const controller = controllerOf(source) ?? source.owner;
	// Copied, not referenced: the pending trigger and the stack item built from
	// it outlive the source and must not write back into the card registry.
	state.pendingTriggers.push({
		source: source.id,
		triggerId,
		controller,
		text: trigger.text,
		triggeringEvent,
		triggeringZoneChangeResult:
			triggeringEvent.kind === "change zone"
				? (() => {
						assert(
							created.length === 1,
							"a zone-change occurrence must create exactly one new object",
						);
						return created[0] ?? null;
					})()
				: null,
		targetDefinitions: structuredClone(trigger.targets),
		effects: structuredClone(trigger.effects),
		sourceLastKnown: null,
	});
	log(
		state,
		`  [trigger] ${name(engine, state, source.id)}#${source.id} — ${trigger.text}`,
	);
}

function relativePlayerMatches(
	actual: PlayerId,
	expected: ValidPlayer,
	source: DeepReadOnly<GameObject>,
): boolean {
	if (expected === "either") return true;
	// A card in the graveyard has no controller (CR 109.4); its owner is
	// the player "you" means for a trigger that functions from there.
	const controller = controllerOf(source) ?? source.owner;
	return expected === "you" ? actual === controller : actual !== controller;
}

function triggerSubjectsMatch(
	read: ReadContext,
	source: DeepReadOnly<GameObject>,
	subjects: DeepReadOnly<GameObject>[],
	predicate: ObjectPredicateDef,
): boolean {
	// A card in the graveyard has no controller (CR 109.4); its owner is
	// the player "you" means for a trigger that functions from there.
	const controller = controllerOf(source) ?? source.owner;
	return subjects.some((subject) =>
		objectMatchesPredicate(predicate, getSnapshot(read, subject.id), {
			controller,
			source: source.id,
		}),
	);
}

function triggerMatches(
	occurrence: EventOccurrence,
	source: DeepReadOnly<GameObject>,
	condition: TriggerCondition,
): boolean {
	const { event: ev, after: read, created, changed } = occurrence;
	if (ev.kind !== condition.kind) return false;

	switch (condition.kind) {
		case "cast": {
			assert(ev.kind === "cast");
			if (!relativePlayerMatches(ev.player, condition.player, source))
				return false;
			if (condition.predicate === undefined) return true;
			const spell = maybeObject(read.state, ev.spell);
			assert(spell?.kind === "spell", "cast event subject is not a spell");
			return triggerSubjectsMatch(read, source, [spell], condition.predicate);
		}

		case "cycle": {
			assert(ev.kind === "cycle");
			if (!relativePlayerMatches(ev.player, condition.player, source))
				return false;
			const card = maybeObject(read.state, ev.card);
			assert(card?.kind === "card", "cycle trigger subject is not a card");
			return triggerSubjectsMatch(read, source, [card], condition.predicate);
		}

		case "gain life":
		case "lose life":
			assert(ev.kind === "gain life" || ev.kind === "lose life");
			return relativePlayerMatches(ev.player, condition.player, source);

		case "draw": {
			assert(ev.kind === "draw");
			if (!relativePlayerMatches(ev.player, condition.player, source))
				return false;
			const qualifier = condition.qualifier;
			if (qualifier === undefined) return true;
			// An `nth` condition fires once: only on the draw that brings
			// the turn's count to exactly `nth`.
			if (qualifier !== "except-first-in-draw-step")
				return (
					read.state.players[ev.player].stats.drawn.thisTurn === qualifier.nth
				);
			// `drawnInDrawStep` only counts a player's own draws during their
			// own draw step — the same guard the increment uses — and it is stale
			// outside that step, so a draw elsewhere on the turn (an opponent's
			// extra draw on your turn, say) must match without consulting it.
			if (
				currentStepKind(read.state) !== "draw" ||
				activePlayer(read.state) !== ev.player
			)
				return true;
			return read.state.players[ev.player].stats.drawn.inDrawStep > 1;
		}

		case "damage":
			assert(ev.kind === "damage");
			return (
				ev.source === source.id && ev.combat && ev.recipient.type === "player"
			);

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
			if (!condition.predicate) return true;
			const attackers = ev.attackers.flatMap((id) => {
				const attacker = maybeObject(read.state, id);
				return attacker ? [attacker] : [];
			});
			return triggerSubjectsMatch(read, source, attackers, condition.predicate);
		}

		case "declare blockers": {
			assert(ev.kind === "declare blockers");
			// Either side of the assignment: the source blocking something, or
			// something blocking the source.
			return ev.blockers.some(
				({ blocker, attacker }) =>
					blocker === source.id || attacker === source.id,
			);
		}

		case "change zone": {
			assert(ev.kind === "change zone");
			if (condition.from !== "any" && ev.from !== condition.from) return false;
			if (condition.to !== "any" && ev.destination.zone !== condition.to)
				return false;

			if (condition.from === "battlefield") {
				// Battlefield-to-graveyard triggers are detected from the pre-event
				// view, where both the departed object and every watching ability still
				// have their last-known characteristics. Never inspect the new graveyard
				// object here: it is a different object under CR 400.7.
				if (condition.to === "graveyard") return false;
				throw new Error("leaves the battlefield triggers are not supported");
			}
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
				condition.predicate,
			);
		}

		case "tap":
		case "untap": {
			assert(ev.kind === "tap" || ev.kind === "untap");
			const subjects = changed.flatMap((id) => {
				const subject = maybeObject(read.state, id);
				return subject ? [subject] : [];
			});
			return triggerSubjectsMatch(read, source, subjects, condition.predicate);
		}

		case "sacrifice": {
			assert(ev.kind === "sacrifice");
			const sacrificed = occurrence.before.objects.get(ev.object);
			assert(
				sacrificed?.kind === "permanent",
				"sacrifice trigger subject has no permanent LKI",
			);
			if (
				!relativePlayerMatches(sacrificed.controller, condition.player, source)
			)
				return false;
			const controller = controllerOf(source) ?? source.owner;
			return objectMatchesPredicate(condition.predicate, sacrificed, {
				controller,
				source: source.id,
			});
		}
	}
}

/** Observe only successful, final event occurrences. */
function detectTriggers(state: GameState, occurrence: EventOccurrence): void {
	const read = occurrence.after;
	for (const abilitySource of state.objects.values()) {
		const snapshot = read.view.objects.get(abilitySource.id);
		assertDefined(snapshot, `no derived view for object ${abilitySource.id}`);
		for (const triggerId of snapshot.currentCharacteristics.abilities
			.triggered) {
			const trigger = abilityDefinition(read.engine, "triggered", triggerId);
			const functionsFrom = trigger.functionsFrom ?? ["battlefield"];
			if (!functionsFrom.includes(abilitySource.zone)) continue;
			if (triggerMatches(occurrence, abilitySource, trigger.condition)) {
				enqueueTrigger(
					read.engine,
					state,
					abilitySource,
					triggerId,
					trigger,
					occurrence.event,
					occurrence.created,
				);
			}
		}
	}
}

/** Consume each one-shot delayed trigger whose next matching event just happened. */
function enqueueMatchingDelayedTriggers(
	engine: Engine,
	state: GameState,
	ev: BeginStepEvent,
): void {
	const remaining: DelayedTrigger[] = [];
	for (const delayed of state.delayedTriggers) {
		const trigger = abilityDefinition(engine, "triggered", delayed.triggerId);
		const condition = trigger.condition;
		assert(
			condition.kind === "begin step",
			"only delayed begin-step triggers are implemented",
		);
		if (ev.step !== condition.step) {
			remaining.push(delayed);
			continue;
		}
		const playerMatches =
			condition.player === "either" ||
			(condition.player === "you"
				? ev.player === delayed.controller
				: ev.player !== delayed.controller);
		if (!playerMatches) {
			remaining.push(delayed);
			continue;
		}

		state.pendingTriggers.push({
			source: delayed.source,
			triggerId: delayed.triggerId,
			controller: delayed.controller,
			text: trigger.text,
			triggeringEvent: ev,
			triggeringZoneChangeResult: null,
			targetDefinitions: structuredClone(trigger.targets),
			effects: structuredClone(trigger.effects),
			sourceLastKnown: structuredClone(delayed.sourceLastKnown),
		});
		log(state, `  [delayed trigger] #${delayed.id} — ${trigger.text}`);
	}
	state.delayedTriggers = remaining;
}

interface LeavesBattlefieldTriggerCandidate {
	pending: Omit<
		PendingTrigger,
		"triggeringEvent" | "triggeringZoneChangeResult"
	>;
	sourceName: string;
}

/**
 * Detect dies triggers from the last-known battlefield view. This view can be
 * shared by every zone change in one simultaneous state-based-action pass, so
 * a watcher that dies in that pass still observes all the other deaths.
 */
function leavesBattlefieldTriggerCandidates(
	engine: Engine,
	before: GameView,
	ev: ZoneChangeEvent,
): LeavesBattlefieldTriggerCandidate[] {
	if (ev.from !== "battlefield") return [];

	const departed = before.objects.get(ev.object);
	assert(
		departed?.kind === "permanent" && departed.zone === "battlefield",
		"a battlefield departure source must be a battlefield permanent",
	);

	const candidates: LeavesBattlefieldTriggerCandidate[] = [];
	for (const source of before.objects.values()) {
		if (source.kind !== "permanent" || source.zone !== "battlefield") continue;
		const controller = source.controller;
		assertDefined(
			controller,
			"a battlefield trigger source must have a controller",
		);

		for (const triggerId of source.currentCharacteristics.abilities.triggered) {
			const trigger = abilityDefinition(engine, "triggered", triggerId);
			if (!functionsHere(trigger.functionsFrom, "battlefield")) continue;
			const condition = trigger.condition;
			if (condition.kind !== "change zone" || condition.from !== "battlefield")
				continue;
			if (condition.to !== "any" && condition.to !== ev.destination.zone)
				continue;
			if (ev.destination.zone !== "graveyard" || condition.to !== "graveyard")
				throw new Error("leaves the battlefield triggers are not supported");
			if (
				!objectMatchesPredicate(condition.predicate, departed, {
					controller,
					source: source.objectId,
				})
			)
				continue;

			const characteristics = source.currentCharacteristics;
			candidates.push({
				pending: {
					source: source.objectId,
					triggerId,
					controller,
					text: trigger.text,
					targetDefinitions: structuredClone(trigger.targets),
					effects: structuredClone(trigger.effects),
					sourceLastKnown: {
						controller,
						colors: [...characteristics.colors],
						deathtouch: characteristics.keywords.includes("deathtouch"),
						lifelink: characteristics.keywords.includes("lifelink"),
					},
				},
				sourceName: characteristics.name,
			});
		}
	}
	return candidates;
}

function enqueueLeavesBattlefieldTriggers(
	state: GameState,
	candidates: LeavesBattlefieldTriggerCandidate[],
	triggeringEvent: DeepReadOnly<ZoneChangeEvent>,
	created: ObjectId[],
): void {
	assert(
		created.length === 1,
		"a zone-change occurrence must create exactly one new object",
	);
	for (const { pending, sourceName } of candidates) {
		state.pendingTriggers.push({
			...pending,
			triggeringEvent,
			triggeringZoneChangeResult: created[0] ?? null,
		});
		log(state, `  [trigger] ${sourceName}#${pending.source} — ${pending.text}`);
	}
}

/**
 * Capture the limited SourceLastKnown approximation before departure for
 * waiting abilities. This does not preserve a full characteristic snapshot.
 */
function recordSourceDeparture(
	state: GameState,
	before: ReadContext,
	id: ObjectId,
	from: Zone,
): void {
	if (from !== "battlefield" && from !== "stack") return;
	const waiting = [
		...state.pendingTriggers,
		...state.stack.filter(
			(entry): entry is TriggeredAbilityStackItem | ActivatedAbilityStackItem =>
				entry.kind !== "spell",
		),
	].filter((item) => item.source === id);
	if (waiting.length === 0) return;

	const snapshot = getSnapshot(before, id);
	assert(
		snapshot.kind === "permanent" || snapshot.kind === "spell",
		"an ability source left a zone it could not have been an ability source in",
	);
	const characteristics = snapshot.currentCharacteristics;
	for (const item of waiting) {
		item.sourceLastKnown = {
			controller: snapshot.controller,
			colors: [...characteristics.colors],
			deathtouch: characteristics.keywords.includes("deathtouch"),
			lifelink: characteristics.keywords.includes("lifelink"),
		};
	}
}

/* ------------------------------------------------------------------ *
 * Resolving the stack
 * ------------------------------------------------------------------ */

function putPendingTriggersOnStack(
	engine: Engine,
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
	// CR 603.3b: the active player's triggers go on the stack first, each player
	// ordering their own. The non-active player therefore orders and targets
	// with the active player's items already on the stack.
	const nonactivePlayer = (1 - active) as PlayerId;
	for (const controller of [active, nonactivePlayer] as const) {
		const controlled = state.pendingTriggers.filter(
			(pending) => pending.controller === controller,
		);
		for (const pending of choices.chooseTriggerOrder(
			state,
			controller,
			controlled,
		)) {
			// CR 603.3d: targets are chosen as the ability is put on the stack,
			// not when the event that triggered it happened.
			const target = requiredTargetDefinition(
				pending.targetDefinitions,
				pending.effects,
			);
			let targets: TargetBindings = [];
			if (target) {
				const ctx = { controller: pending.controller, source: pending.source };
				const candidates = legalTargets(
					createReadContext(engine, state),
					target,
					ctx,
				);
				if (candidates.length === 0) {
					// CR 603.3d: with no legal choice the ability is removed rather
					// than waiting on the stack for one to appear.
					log(state, `  [illegal target] ${pending.text} is removed`);
					continue;
				}
				const chosen = choices.chooseTarget(
					state,
					pending.controller,
					{ announcing: "triggered ability", source: pending.source },
					target,
					candidates,
				);
				assert(
					isLegalTarget(createReadContext(engine, state), target, chosen, ctx),
					"chooseTarget returned a target outside its own candidate list",
				);
				targets = [{ slot: target.id, target: chosen }];
			}
			const item: TriggeredAbilityStackItem = {
				id: state.nextStackItemId++ as StackItemId,
				kind: "triggered ability",
				...pending,
				targets,
			};
			state.stack.push(item);
			state.revision++;
			log(state, `  [stack] ${item.text}`);
		}
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
	engine: Engine,
	state: GameState,
	choices: AnyChoiceController,
): void {
	const entry = state.stack[state.stack.length - 1];
	assertDefined(entry, "nothing on the stack to resolve");
	if (entry.kind === "spell") {
		resolveSpell(engine, state, choices, entry);
	} else {
		resolveStackAbility(engine, state, choices, entry);
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
	engine: Engine,
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

	const read = createReadContext(engine, state);
	const snapshot = getSnapshot(read, object.id);
	assert(snapshot.kind === "spell", "a spell object read back as another kind");
	const characteristics = snapshot.currentCharacteristics;

	log(state, `  [resolve] ${characteristics.name}#${object.id}`);

	// CR 608.3: a resolving permanent spell becomes a permanent, entering under
	// its controller.
	if (
		characteristics.types.some((type) => includes(PERMANENT_CARD_TYPES, type))
	) {
		performIn(
			engine,
			state,
			{
				kind: "change zone",
				object: object.id,
				from: "stack",
				destination: { zone: "battlefield", controller: object.controller },
				cause: "resolve",
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
	const definition = read.engine.cardDefinition(
		object.representation.cardId,
	).spell;
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
			engine,
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
		engine,
		state,
		{
			kind: "change zone",
			object: object.id,
			from: "stack",
			destination: { zone: "graveyard" },
			cause: legal ? "resolve" : "illegal target",
		},
		choices,
		newScope(),
		0,
	);
}

/**
 * CR 608.2n: unlike a spell, an ability moves to no zone; it ceases to exist as
 * the final part of its own resolution. Remaining on the stack until then is
 * what lets an ability that removes its own source still receive that
 * departure's last known information.
 */
function resolveStackAbility(
	engine: Engine,
	state: GameState,
	choices: AnyChoiceController,
	entry: TriggeredAbilityStackItem | ActivatedAbilityStackItem,
): void {
	log(state, `  [resolve] ${entry.text}`);

	assert(
		entry.targetDefinitions.length <= 1,
		"multiple target slots are not implemented",
	);
	const target = entry.targetDefinitions[0] ?? null;
	assert(
		entry.targets.length === (target ? 1 : 0),
		"ability target binding count disagrees with its captured definition",
	);
	const binding = entry.targets[0];
	if (target)
		assert(binding?.slot === target.id, "ability has the wrong target slot");
	// CR 608.2b: with one required target, an illegal target stops every effect,
	// including the untargeted parts of the same ability.
	const legal =
		!target ||
		(binding !== undefined &&
			isLegalTarget(createReadContext(engine, state), target, binding.target, {
				controller: entry.controller,
				source: entry.source,
			}));
	if (legal) {
		/** Share a scope so facts can pass through the complete effect sequence. */
		resolveEffects(
			engine,
			state,
			choices,
			{
				controller: entry.controller,
				source: entry.source,
				ability: entry,
				targets: entry.targets,
			},
			entry.effects,
			newScope(),
		);
	} else {
		log(state, "  [illegal target] ability does not resolve");
	}

	const removed = state.stack.pop();
	assert(removed === entry, "the stack changed while resolving its top entry");
	state.revision++;
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

/**
 * Read the live source, or the limited SourceLastKnown approximation after
 * departure. The ability's controller is captured separately.
 */
function sourceInformation(
	engine: Engine,
	state: GameState,
	item: ResolutionSource,
): SourceLastKnown {
	const object = maybeObject(state, item.source);
	if (object && (object.kind === "permanent" || object.kind === "spell")) {
		const snapshot = getSnapshot(createReadContext(engine, state), item.source);
		assert(
			snapshot.kind === "permanent" || snapshot.kind === "spell",
			"source object read back as another kind",
		);
		const characteristics = snapshot.currentCharacteristics;
		return {
			controller: object.controller,
			colors: [...characteristics.colors],
			deathtouch: characteristics.keywords.includes("deathtouch"),
			lifelink: characteristics.keywords.includes("lifelink"),
		};
	}
	const lastKnown = item.ability?.sourceLastKnown ?? null;
	assertDefined(
		lastKnown,
		`no current or last known information for source ${item.source}`,
	);
	return lastKnown;
}

/**
 * Where the effects being resolved are defined, as a serializable reference a
 * temporary effect can hold.
 *
 * A spell points at its card's `spell.effects`; an ability points at its own
 * `cardId:index` registry entry, which is where its effects live.
 */
function resolvingEffectSource(
	state: GameState,
	item: ResolutionSource,
	effectIndex: number,
): TemporaryEffectSource {
	const ability = item.ability;
	if (ability) {
		return {
			origin: "ability-effect",
			category:
				ability.kind === "triggered ability" ? "triggered" : "activated",
			abilityId:
				ability.kind === "triggered ability"
					? ability.triggerId
					: ability.abilityId,
			effectIndex,
		};
	}
	const object = maybeObject(state, item.source);
	assert(
		object?.kind === "spell" && object.representation.kind === "card",
		"a temporary effect must come from a card spell or an ability",
	);
	return {
		origin: "spell-effect",
		cardId: object.representation.cardId,
		effectIndex,
	};
}

function resolveEffects(
	engine: Engine,
	state: GameState,
	choices: AnyChoiceController,
	item: ResolutionSource,
	effects: EffectDef<TriggerEffectPlayer>[],
	scope: Scope,
): void {
	const resolvePlayer = (
		subject: EffectPlayerSubject<TriggerEffectPlayer>,
	): PlayerId => {
		if (subject.kind === "relative-player")
			return relativeEffectPlayer(item, subject.player);
		const binding = item.targets.find(({ slot }) => slot === subject.slot);
		assert(
			binding?.target.type === "player",
			`effect has no player target in slot ${subject.slot}`,
		);
		return binding.target.player;
	};
	// iterate effects
	for (const [effectIndex, effect] of effects.entries()) {
		if (effect.kind === "may") {
			const decider =
				effect.decider === "you"
					? item.controller
					: ((1 - item.controller) as PlayerId);
			// TODO: seems trivial to fix.
			assertDefined(
				item.ability,
				"optional effects on a resolving spell are not implemented",
			);
			if (choices.chooseOptional(state, item.ability, decider))
				resolveEffects(engine, state, choices, item, effect.effects, scope);
			continue;
		}
		const declaredResult = declaredEffectResult(effect);
		if (declaredResult) {
			assert(
				!scope.bindings.has(declaredResult.slot),
				`effect result slot ${declaredResult.slot} is already bound`,
			);
			// Every producer begins with an empty result. Its specialized execution
			// replaces this only with objects that reached the declared destination.
			scope.bindings.set(declaredResult.slot, []);
		}
		if (effect.kind === "each player draw") {
			assert(effect.subjects === "each-player");
			const active = activePlayer(state);
			assertDefined(active, "each-player draw must resolve during a turn");
			for (const player of [active, (1 - active) as PlayerId]) {
				performIn(
					engine,
					state,
					{ kind: "draw cards", player, amount: effect.amount },
					choices,
					scope,
					0,
				);
			}
			continue;
		}
		if (
			(effect.kind === "tap" || effect.kind === "untap") &&
			"subjects" in effect
		) {
			assert(effect.subjects.kind === "matching-permanents");
			const read = createReadContext(engine, state);
			const subjects = state.battlefield.filter((id) => {
				const object = getSnapshot(read, id);
				assert(object.kind === "permanent");
				return objectMatchesPredicate(effect.subjects.predicate, object, {
					controller: item.controller,
					source: item.source,
				});
			});
			if (subjects.length > 0) {
				performIn(
					engine,
					state,
					{ kind: effect.kind, objects: subjects },
					choices,
					scope,
					0,
				);
			}
			continue;
		}
		if (effect.kind === "create-delayed-trigger") {
			// Capture the source now. The delayed ability can trigger and resolve
			// after the original object has left every zone where it functioned.
			state.delayedTriggers.push({
				id: state.nextDelayedTriggerId++ as DelayedTriggerId,
				controller: item.controller,
				source: item.source,
				sourceLastKnown: sourceInformation(engine, state, item),
				triggerId: effect.ability,
			});
			state.revision++;
			continue;
		}
		if (effect.kind === "search-library") {
			const chosen = choices.searchLibrary(
				state,
				resolvePlayer(effect.searcher),
				{
					owner: resolvePlayer(effect.owner),
					source: item.source,
					...(effect.predicate
						? {
								predicate: {
									definition: effect.predicate,
									context: {
										controller: item.controller,
										source: item.source,
									},
								},
							}
						: {}),
				},
			);
			if (chosen !== null) {
				const object = maybeObject(state, chosen);
				assert(
					object?.kind === "card" &&
						object.zone === "library" &&
						object.owner === resolvePlayer(effect.owner),
					"library search returned a card outside the searched library",
				);
				scope.bindings.set(effect.resultSlot, [{ type: "card", id: chosen }]);
			}
			continue;
		}
		if (effect.kind === "shuffle-library") {
			shuffleLibrary(state, resolvePlayer(effect.subject));
			continue;
		}
		if (effect.kind === "shuffle-into-library") {
			let predicateSource = item.source;
			let owners: PlayerId[];
			if (effect.owners === "each-player") {
				const active = activePlayer(state);
				assertDefined(
					active,
					"each-player shuffle must resolve during a turn",
				);
				owners = [active, (1 - active) as PlayerId];
			} else if (effect.owners.kind === "triggering-zone-change-result-owner") {
				assert(
					item.ability?.kind === "triggered ability",
					"a triggering zone-change owner requires a triggered ability",
				);
				const id = item.ability.triggeringZoneChangeResult;
				if (id === null) continue;
				const result = maybeObject(state, id);
				// If another instruction already moved the destination object, there
				// is no longer an object in the declared origin to shuffle back.
				if (
					!result ||
					!effect.from.includes(result.zone as Exclude<CardZone, "library">)
				)
					continue;
				assert(
					result.kind === "card",
					"a shuffled trigger result must be a card",
				);
				owners = [result.owner];
				predicateSource = result.id;
			} else {
				owners = [resolvePlayer(effect.owners)];
			}

			const read = createReadContext(engine, state);
			const candidatesByOwner = owners.map((owner) => ({
				owner,
				candidates: effect.from.flatMap((zone) =>
					read.state.players[owner][zone].filter((id) => {
						if (effect.predicate === undefined) return true;
						return objectMatchesPredicate(
							effect.predicate,
							getSnapshot(read, id),
							{ controller: item.controller, source: predicateSource },
						);
					}),
				),
			}));
			for (const { owner, candidates } of candidatesByOwner) {
				for (const id of candidates) {
					const card = maybeObject(state, id);
					if (
						card?.kind !== "card" ||
						card.owner !== owner ||
						!effect.from.includes(card.zone as Exclude<CardZone, "library">)
					)
						continue;
					performIn(
						engine,
						state,
						{
							kind: "change zone",
							object: card.id,
							from: card.zone,
							destination: { zone: "library", position: "top" },
							cause: "effect",
						},
						choices,
						scope,
						0,
					);
				}
				shuffleLibrary(state, owner);
			}
			continue;
		}
		let bound: EntityRef | null = null;
		const targetUses = effectTargetUses(effect);
		if (targetUses.length > 0) {
			const targetSlot = targetUses[0]?.slot;
			assertDefined(targetSlot);
			assert(
				targetUses.every((use) => use.slot === targetSlot),
				"one effect cannot consume multiple target slots",
			);
			const binding = item.targets.find(({ slot }) => slot === targetSlot);
			assertDefined(binding, "effect has no target binding");
			bound = binding.target;
		}
		if (effect.kind === "sacrifice") {
			assert(
				effect.amount === 1,
				"only sacrificing one permanent is implemented",
			);
			const sacrificingPlayer =
				effect.subject.kind === "relative-player"
					? relativeEffectPlayer(item, effect.subject.player)
					: (() => {
							assert(
								bound?.type === "player",
								"sacrifice effect requires a bound player target",
							);
							return bound.player;
						})();
			const candidates = legalSacrifices(
				createReadContext(engine, state),
				sacrificingPlayer,
				effect.predicate,
				{ controller: item.controller, source: item.source },
			);
			// CR 701.21: an impossible sacrifice does nothing; it does not make
			// the resolving spell or ability illegal.
			if (candidates.length === 0) continue;
			const chosen = choices.chooseObject(state, sacrificingPlayer, {
				reason: { kind: "sacrifice" },
				objects: candidates,
			});
			performIn(
				engine,
				state,
				{ kind: "sacrifice", object: chosen },
				choices,
				scope,
				0,
			);
			continue;
		}
		if (effect.kind === "add counters" && effect.subject.kind === "source") {
			// A source that has left the battlefield cannot receive counters.
			const source = maybePermanent(state, item.source);
			if (!source) continue;
			performIn(
				engine,
				state,
				{
					kind: "add counters",
					permanent: { type: "permanent", id: source.id },
					counter: effect.counter,
					amount: effect.amount,
					source: item.source,
				},
				choices,
				scope,
				0,
			);
			continue;
		}
		if (effect.kind === "change-zone") {
			let ref: EntityRef | null;
			if (effect.subject.kind === "source") ref = null;
			else if (effect.subject.kind === "target") ref = bound;
			else if (effect.subject.kind === "triggering-zone-change-result") {
				assert(
					item.ability?.kind === "triggered ability",
					"a triggering zone-change result requires a triggered ability",
				);
				const id = item.ability.triggeringZoneChangeResult;
				if (id === null) continue;
				const result = maybeObject(state, id);
				// A token has ceased to exist, or another effect has already moved the
				// destination object. In either case this instruction does nothing.
				if (!result || result.zone !== effect.from) continue;
				if (effect.from === "battlefield") {
					assert(
						result.kind === "permanent",
						"a battlefield zone-change result must be a permanent",
					);
					ref = { type: "permanent", id };
				} else {
					if (result.kind === "nonbattlefield-token") continue;
					assert(
						result.kind === "card",
						"a public-zone change result must be a card",
					);
					ref = { type: "card", id };
				}
			} else if (effect.subject.kind === "chosen-permanent") {
				assert(
					effect.from === "battlefield",
					"a chosen permanent must come from the battlefield",
				);
				const chooser = relativeEffectPlayer(item, effect.subject.player);
				const predicate = {
					definition: effect.subject.predicate,
					context: { controller: item.controller, source: item.source },
				};
				const read = createReadContext(engine, state);
				const candidates = state.battlefield.filter((id) =>
					objectMatchesPredicate(
						predicate.definition,
						getSnapshot(read, id),
						predicate.context,
					),
				);
				// An instruction requiring an impossible choice does nothing.
				if (candidates.length === 0) continue;
				const chosen = choices.chooseObject(state, chooser, {
					reason: {
						kind: "select",
						prompt: effect.subject.prompt,
						source: item.source,
					},
					objects: candidates,
					predicate,
				});
				ref = { type: "permanent", id: chosen };
			} else {
				const results = scope.bindings.get(effect.subject.slot) ?? [];
				assert(
					results.length <= 1,
					`one-object change-zone result ${effect.subject.slot} contains multiple objects`,
				);
				ref = results[0] ?? null;
				if (ref === null) continue;
			}
			if (ref !== null)
				assert(
					ref.type === "permanent" || ref.type === "card",
					"change-zone requires a bound object",
				);
			const id = ref === null ? item.source : ref.id;
			const object = maybeObject(state, id);
			// An instruction cannot move an object that has left its stated origin.
			if (!object || object.zone !== effect.from) continue;
			if (effect.from === "battlefield") {
				assert(
					object.kind === "permanent" &&
						(ref === null || ref?.type === "permanent"),
					"a battlefield change-zone subject must be a permanent",
				);
			} else {
				assert(
					object.kind === "card" && (ref === null || ref?.type === "card"),
					"a nonbattlefield change-zone subject must be a card",
				);
			}
			const result = performIn(
				engine,
				state,
				effectToEvent(
					engine,
					state,
					item,
					effect,
					ref ??
						(effect.from === "battlefield"
							? { type: "permanent", id }
							: { type: "card", id }),
				),
				choices,
				scope,
				0,
			);
			if (effect.resultSlot !== undefined) {
				const produced = result.created.flatMap((id): EntityRef[] => {
					const created = maybeObject(state, id);
					if (
						effect.destination.zone === "battlefield" &&
						created?.kind === "permanent" &&
						created.zone === "battlefield"
					)
						return [{ type: "permanent", id }];
					if (
						effect.destination.zone !== "battlefield" &&
						created?.kind === "card" &&
						created.zone === effect.destination.zone
					)
						return [{ type: "card", id }];
					return [];
				});
				assert(
					produced.length <= 1,
					`one-object change-zone effect produced multiple objects in ${effect.destination.zone}`,
				);
				scope.bindings.set(effect.resultSlot, produced);
			}
			continue;
		}
		if (
			effect.kind === "modify-pt" ||
			effect.kind === "grant-keyword" ||
			effect.kind === "grant-triggered"
		) {
			let slot: string;
			let subject: EntityRef;
			if (effect.subject.kind === "source") {
				// An instruction affecting its source does nothing if that object
				// has already left the battlefield.
				const self = maybePermanent(state, item.source);
				if (!self) continue;
				slot = SELF_SLOT;
				subject = { type: "permanent", id: self.id };
			} else {
				assert(
					bound?.type === "permanent",
					"temporary characteristic effect requires a bound permanent target",
				);
				slot = effect.subject.slot;
				subject = bound;
			}
			// The effect keeps a reference to the definition that created it, so
			// its characteristic change is never denormalized into game state.
			addTemporaryEffect(
				state,
				item.controller,
				{
					source: resolvingEffectSource(state, item, effectIndex),
					bindings: { [slot]: subject },
				},
				effect.duration,
			);
			continue;
		}
		if (effect.kind === "exile-top" && effect.resultSlot !== undefined) {
			const result = performIn(
				engine,
				state,
				effectToEvent(engine, state, item, effect, bound),
				choices,
				scope,
				0,
			);
			const exiledCards = result.created.flatMap((id): EntityRef[] => {
				const created = maybeObject(state, id);
				return created?.kind === "card" && created.zone === "exile"
					? [{ type: "card", id }]
					: [];
			});
			scope.bindings.set(effect.resultSlot, exiledCards);
			continue;
		}
		if (effect.kind === "may-play") {
			const slot = effect.subject.slot;
			let subjects: EntityRef[];
			if (effect.subject.kind === "effect-result") {
				subjects = scope.bindings.get(slot) ?? [];
			} else {
				assert(
					bound?.type === "card",
					"temporary play permission requires a bound card target",
				);
				subjects = [bound];
			}
			for (const subject of subjects) {
				assert(
					subject.type === "card",
					"temporary play permission requires a bound card",
				);
				const object = maybeObject(state, subject.id);
				// A preceding instruction can move a subject before permission is
				// created. In that case this instruction does nothing for that object.
				assertDefined(object);
				assert(object.kind === "card");
				assert(object.zone === effect.from);
				addTemporaryEffect(
					state,
					item.controller,
					{
						source: resolvingEffectSource(state, item, effectIndex),
						bindings: { [slot]: subject },
					},
					effect.duration,
				);
			}
			continue;
		}
		performIn(
			engine,
			state,
			effectToEvent(engine, state, item, effect, bound),
			choices,
			scope,
			0,
		);
	}
}

/**
 * Turns one definition-time instruction into the event it performs. `subject`
 * is the entity resolved for the instruction's semantic operand, when it has
 * one; it can come from either a target slot or the ability's source.
 */
function relativeEffectPlayer(
	item: ResolutionSource,
	relative: TriggerEffectPlayer,
): PlayerId {
	if (relative === "you") return item.controller;
	if (relative === "opponent") return (1 - item.controller) as PlayerId;
	assert(
		item.ability?.kind === "triggered ability",
		"triggering-player requires a triggered ability",
	);
	assert(
		"player" in item.ability.triggeringEvent,
		`triggering ${item.ability.triggeringEvent.kind} event has no player`,
	);
	return item.ability.triggeringEvent.player;
}

function effectToEvent(
	engine: Engine,
	state: GameState,
	item: ResolutionSource,
	effect: Exclude<
		EffectDef<TriggerEffectPlayer>,
		{ kind: "may" } | EachPlayerDrawEffectDef | CreateDelayedTriggerEffectDef
	>,
	subject: EntityRef | null,
): GameEvent {
	/**
	 * The player an instruction acts on: either relative to the source's
	 * controller, or the one bound to the target slot the instruction names.
	 */
	const effectPlayer = (
		who: EffectPlayerSubject<TriggerEffectPlayer>,
	): PlayerId => {
		if (who.kind === "relative-player")
			return relativeEffectPlayer(item, who.player);
		assert(
			subject?.type === "player",
			"a targeted player effect requires a bound player target",
		);
		return subject.player;
	};
	switch (effect.kind) {
		case "gain-life":
			return {
				kind: "gain life",
				player: effectPlayer(effect.subject),
				amount: effect.amount,
			};
		case "lose-life":
			return {
				kind: "lose life",
				player: effectPlayer(effect.subject),
				amount: effect.amount,
			};
		case "draw":
			return {
				kind: "draw cards",
				player: effectPlayer(effect.subject),
				amount: effect.amount,
			};
		case "scry":
			return {
				kind: "scry",
				player: effectPlayer(effect.subject),
				amount: effect.amount,
			};
		case "surveil":
			return {
				kind: "surveil",
				player: effectPlayer(effect.subject),
				amount: effect.amount,
			};
		case "choose-from-top":
			return {
				kind: "choose from top",
				player: relativeEffectPlayer(item, effect.subject),
				amount: effect.amount,
				keep: effect.keep,
			};
		case "mill":
			return {
				kind: "mill",
				player: effectPlayer(effect.subject),
				amount: effect.amount,
			};
		case "exile-top":
			return {
				kind: "exile top",
				player: effectPlayer(effect.subject),
				amount: effect.amount,
			};
		case "create-token":
			assert(
				Number.isSafeInteger(effect.amount) && effect.amount >= 1,
				"token amount must be a positive safe integer",
			);
			return {
				kind: "create token",
				controller: relativeEffectPlayer(item, effect.controller),
				characteristics: cloneCharacteristics(effect.characteristics),
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
					player: relativeEffectPlayer(item, effect.subject),
					cards: { kind: "any" },
				};
			}
			if (effect.selector === "random") {
				throw new Error("discard at random not implemented");
			}
			throw new Error("unexpected discard effect kind");
		}
		case "damage": {
			const recipient =
				effect.subject.kind === "relative-player"
					? {
							type: "player" as const,
							player: relativeEffectPlayer(item, effect.subject.player),
						}
					: subject;
			assert(
				recipient?.type === "player" || recipient?.type === "permanent",
				"damage recipient must be a player or permanent",
			);
			// CR 119.3: lifelink life goes to the controller of the damage source,
			// which need not be the controller of the ability.
			const source = sourceInformation(engine, state, item);
			return {
				kind: "damage",
				source: item.source,
				sourceController: source.controller,
				sourceColors: source.colors,
				recipient,
				amount: effect.amount,
				combat: false,
				deathtouch: source.deathtouch,
				lifelink: source.lifelink,
				unpreventable: false,
			};
		}
		case "destroy":
			assert(
				subject !== null && subject.type === "permanent",
				"destroy requires a bound permanent target",
			);
			return {
				kind: "destroy",
				object: subject.id,
				source: item.source,
				noRegen: false,
			};
		case "tap":
		case "untap":
			assert("subject" in effect, `${effect.kind} set resolves directly`);
			assert(
				subject !== null && subject.type === "permanent",
				`${effect.kind} requires a bound permanent target`,
			);
			return {
				kind: effect.kind,
				objects: [subject.id],
			};
		case "counter":
			assert(
				subject !== null && subject.type === "spell",
				"counter requires a bound spell target",
			);
			return {
				kind: "counter",
				spell: subject.id,
				source: item.source,
			};
		case "add counters":
			assert(
				subject !== null && subject.type === "permanent",
				"add counters requires a permanent object",
			);
			return {
				kind: "add counters",
				permanent: subject,
				counter: effect.counter,
				amount: effect.amount,
				source: item.source,
			};
		case "change-zone": {
			assert(
				subject !== null &&
					"id" in subject &&
					(effect.from === "battlefield"
						? subject.type === "permanent"
						: subject.type === "card"),
				"change-zone subject type disagrees with its origin",
			);
			const object = state.objects.get(subject.id);
			assert(
				object !== undefined && object.zone === effect.from,
				"change-zone subject is not in its declared origin",
			);
			const destination: ZoneChangeDestination =
				effect.destination.zone === "battlefield"
					? {
							zone: "battlefield",
							controller:
								effect.destination.controller === "owner"
									? object.owner
									: relativeEffectPlayer(item, effect.destination.controller),
							...(effect.destination.tapped ? { tapped: true } : {}),
						}
					: { ...effect.destination };
			return {
				kind: "change zone",
				from: effect.from,
				destination,
				cause: "effect",
				object: subject.id,
			};
		}
		case "sacrifice":
			throw new Error("sacrifice effects are resolved with a player choice");
		case "modify-pt":
			throw new Error(
				"temporary P/T effects resolve without creating an event",
			);
		case "grant-keyword":
			throw new Error(
				"temporary keyword effects resolve without creating an event",
			);
		case "grant-triggered":
			throw new Error(
				"temporary triggered-ability grants resolve without creating an event",
			);
		case "may-play":
			throw new Error(
				"temporary play permissions resolve without creating an event",
			);
		case "search-library":
			throw new Error("library searches resolve without creating an event");
		case "shuffle-library":
			throw new Error("library shuffles resolve without creating an event");
		case "shuffle-into-library":
			throw new Error(
				"shuffling cards into libraries resolves without one aggregate event",
			);
		case "add-mana":
			return {
				kind: "add mana",
				player: relativeEffectPlayer(item, effect.subject),
				source: item.source,
				mana: effect.mana,
			};
	}
}

/* ------------------------------------------------------------------ *
 * Cast timing and mana payment
 * ------------------------------------------------------------------ */

/**
 * CR 601.3 / CR 702.8: when a spell may be *begun*. Instants and spells with
 * flash may be cast whenever their controller has priority. The engine has no
 * "as though" effects; every other spell is restricted to sorcery timing.
 */
function doTimingRestrictionsAllowCast(
	characteristics: DeepReadOnly<CharacteristicsSnapshot>,
	state: GameState,
	player: PlayerId,
): boolean {
	assert(
		state.turnScheduler.progress.kind === "inTurn",
		"tried to cast outside a game",
	);
	// TODO: "you may cast x as though it had flash"

	assert(characteristics.types.length > 0, "object has no types");

	if (characteristics.types.includes("instant")) {
		assert(
			characteristics.types.length === 1,
			"instant type must be the only type",
		);
		return true;
	}
	if (characteristics.keywords.includes("flash")) return true;

	return isSorcerySpeed(state, player);
}

/** @returns true if "only as a sorcery" abilities can be activated now.
 * in theory some spells could grant actual sorceries flash or otherwise
 * modify their timing. this is not that.
 */
function isSorcerySpeed(state: ReadonlyGameState, player: PlayerId): boolean {
	// CR 307.1: sorcery timing. A main phase of your own turn, with the stack
	// empty. Every non-instant card type shares this restriction.
	if (turnLocation(state)?.kind !== "mainPhase") return false;
	if (activePlayer(state) !== player) return false;
	if (state.stack.length !== 0) return false;

	return true;
}

/**
 * The mana a cost demands, split into the specific part (each requirement
 * payable only by mana of that exact {@link ManaType}) and the generic part
 * (payable by any mana at all).
 *
 * The split is what makes payment planning tractable: specific requirements
 * have exactly one way to be paid, generic has many.
 */
interface ManaCostBreakdown {
	specific: Partial<Record<ManaType, number>>;
	generic: number;
}

function manaCostBreakdown(cost: PayableManaCost): ManaCostBreakdown {
	if (cost === "zero") return { specific: {}, generic: 0 };
	const specific: Partial<Record<ManaType, number>> = {};
	for (const type of MANA_TYPES) {
		const amount = cost[type] ?? 0;
		assert(
			Number.isSafeInteger(amount) && amount >= 0,
			`invalid ${type} quantity in mana cost`,
		);
		if (amount > 0) specific[type] = amount;
	}
	const generic = cost.n ?? 0;
	assert(
		Number.isSafeInteger(generic) && generic >= 0,
		"invalid generic quantity in mana cost",
	);
	return { specific, generic };
}

/**
 * The exact mana to spend from `pool` for `cost`, or null if the pool cannot
 * pay it. Pool-only: untapped sources are deliberately not considered, so a
 * player taps for mana first and then casts.
 *
 * Specific requirements are satisfied first, since only their own mana type can
 * pay them. Whatever generic remains is then paid in a fixed order — colorless
 * first, then colors in WUBRG order. That is a deterministic engine choice
 * rather than a player decision: it can spend mana the player was saving, but
 * it never fails a payment that some other assignment would have made, because
 * once the specific requirements are met every remaining unit of mana is
 * interchangeable for generic.
 */
export function planManaPayment(
	pool: DeepReadOnly<ManaPool>,
	cost: PayableManaCost,
): ManaAmount | null {
	const breakdown = manaCostBreakdown(cost);

	const payment: ManaPool = { w: 0, u: 0, b: 0, r: 0, g: 0, c: 0 };
	const remaining: ManaPool = { ...pool };

	for (const type of MANA_TYPES) {
		const required = breakdown.specific[type] ?? 0;
		if (remaining[type] < required) return null;
		remaining[type] -= required;
		payment[type] += required;
	}

	let generic = breakdown.generic;
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

/* ------------------------------------------------------------------ *
 * Targeting
 * ------------------------------------------------------------------ */

/**
 * Proves the sequential dataflow of named effect results once, when a card
 * definition enters the engine. These slots pass objects between instructions;
 * they are unrelated to an ability's Magic target slots.
 */
function validateEffectResultFlow(
	effects: EffectDef<TriggerEffectPlayer>[],
	triggeringZoneChangeDestination: Zone | "any" | null = null,
): void {
	const check = (
		sequence: EffectDef<TriggerEffectPlayer>[],
		available: Map<string, Zone>,
	): void => {
		for (const effect of sequence) {
			if (effect.kind === "may") {
				// The optional branch may not execute. It can read preceding results and
				// pass its own results between inner instructions, but it cannot make a
				// result definitely available to a following outer instruction.
				check(effect.effects, new Map(available));
				continue;
			}
			if (
				effect.kind === "change-zone" &&
				effect.subject.kind === "triggering-zone-change-result"
			) {
				assert(
					triggeringZoneChangeDestination === "any" ||
						triggeringZoneChangeDestination === effect.from,
					`change-zone refers to an unavailable triggering ${effect.from} object`,
				);
			}
			if (
				effect.kind === "change-zone" &&
				effect.subject.kind === "effect-result"
			) {
				assert(
					available.get(effect.subject.slot) === effect.from,
					`change-zone refers to unavailable ${effect.from} effect result ${effect.subject.slot}`,
				);
			}
			const declaredResult = declaredEffectResult(effect);
			if (declaredResult) {
				assert(
					declaredResult.slot.length > 0,
					"effect result slot must have a name",
				);
				assert(
					!available.has(declaredResult.slot),
					`duplicate effect result slot ${declaredResult.slot}`,
				);
				available.set(declaredResult.slot, declaredResult.zone);
			}
			if (
				effect.kind === "may-play" &&
				effect.subject.kind === "effect-result"
			) {
				assert(
					available.get(effect.subject.slot) === effect.from,
					`may-play refers to unavailable effect result ${effect.subject.slot}`,
				);
			}
		}
	};
	check(effects, new Map());
}

function validateCardEffectResultFlow(definition: CardDef): void {
	if (definition.spell) {
		validateEffectResultFlow(definition.spell.effects);
		requiredTargetDefinition(
			definition.spell.targets,
			definition.spell.effects,
		);
	}
	for (const ability of definition.abilityDefinitions.activated) {
		if (!ability.effects) continue;
		validateEffectResultFlow(ability.effects);
		if ("targets" in ability)
			requiredTargetDefinition(ability.targets, ability.effects);
	}
	for (const trigger of definition.abilityDefinitions.triggered) {
		validateEffectResultFlow(
			trigger.effects,
			trigger.condition.kind === "change zone" ? trigger.condition.to : null,
		);
		requiredTargetDefinition(trigger.targets, trigger.effects);
	}
}

/**
 * The single required target slot a spell or ability declares, or null, after
 * checking that its targets and instructions fall inside the executable
 * subset. Every announcement path runs this before it can spend a cost, so an
 * unsupported definition can never leave a half-paid cast behind.
 */
function requiredTargetDefinition(
	targets: TargetDef[],
	effects: EffectDef<TriggerEffectPlayer>[],
): TargetDef | null {
	assert(targets.length <= 1, "multiple target slots are not implemented");
	const target = targets[0] ?? null;
	if (target) {
		assert(
			target.min === 1 && target.max === 1,
			"only one required target is implemented",
		);
	}
	const check = (effect: EffectDef<TriggerEffectPlayer>): void => {
		if (effect.kind === "may") {
			for (const inner of effect.effects) check(inner);
			return;
		}
		if (effect.kind === "sacrifice") {
			assert(
				effect.amount === 1,
				"only sacrificing one permanent is implemented",
			);
		}
		for (const use of effectTargetUses(effect)) {
			assert(
				target !== null && use.slot === target.id,
				"effect must reference its ability's target slot",
			);
			assert(
				targetSelectorSatisfies(target.legal, use.required),
				use.required.message,
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
	ctx: PredicateContext,
): boolean {
	if (target.type === "player") {
		if (
			definition.legal.kind !== "player" &&
			definition.legal.kind !== "any-target"
		)
			return false;
		const validPlayer =
			definition.legal.kind === "player" ? definition.legal.player : "either";
		const matchesController = target.player === ctx.controller;
		return (
			(validPlayer === "either" ||
				(validPlayer === "you" && matchesController) ||
				(validPlayer === "opponent" && !matchesController)) &&
			!read.state.players[target.player].lost &&
			!read.state.players[target.player].won
		);
	}
	if (target.type === "spell") {
		if (definition.legal.kind !== "spell") return false;
		const snapshot = read.view.objects.get(target.id);
		return (
			target.id !== ctx.source &&
			snapshot?.kind === "spell" &&
			(definition.legal.predicate === undefined ||
				objectMatchesPredicate(definition.legal.predicate, snapshot, {
					controller: ctx.controller,
					source: ctx.source,
				}))
		);
	}
	if (target.type === "card") {
		if (definition.legal.kind !== "card") return false;
		const snapshot = read.view.objects.get(target.id);
		return (
			snapshot?.kind === "card" &&
			snapshot.zone === definition.legal.zone &&
			(definition.legal.predicate === undefined ||
				objectMatchesPredicate(definition.legal.predicate, snapshot, {
					controller: ctx.controller,
					source: ctx.source,
				}))
		);
	}
	if (definition.legal.kind === "player" || definition.legal.kind === "spell")
		return false;
	if (definition.legal.kind === "card") return false;
	const snapshot = read.view.objects.get(target.id);
	// CR 608.2b: a target that left the zone it was targeted in is illegal, and
	// the object that replaced it is a different object with a different id.
	if (snapshot?.kind !== "permanent") return false;
	// CR 702.18a / 702.11b: shroud rejects every spell or ability targeting
	// this permanent; hexproof rejects only sources an opponent controls.
	// `ctx.controller` is captured from the announcing spell or ability, while
	// the permanent's current controller comes from the same derived snapshot
	// whose type, colour, and other target restrictions are checked below.
	if (snapshot.currentCharacteristics.keywords.includes("shroud")) return false;
	if (
		snapshot.currentCharacteristics.keywords.includes("hexproof") &&
		snapshot.controller !== ctx.controller
	)
		return false;
	if (definition.legal.kind === "any-target") {
		// CR 115.4: "any target" is a creature, a planeswalker, a battle, or a
		// player; the engine has no battles.
		return (
			snapshot.currentCharacteristics.types.includes("creature") ||
			snapshot.currentCharacteristics.types.includes("planeswalker")
		);
	}
	return (
		definition.legal.predicate === undefined ||
		objectMatchesPredicate(definition.legal.predicate, snapshot, {
			controller: ctx.controller,
			source: ctx.source,
		})
	);
}

function legalTargets(
	read: ReadContext,
	definition: TargetDef,
	ctx: PredicateContext,
): EntityRef[] {
	const candidates: EntityRef[] = [
		{ type: "player", player: 0 },
		{ type: "player", player: 1 },
		...read.state.stack.flatMap((entry): EntityRef[] =>
			entry.kind === "spell" ? [{ type: "spell", id: entry.objectId }] : [],
		),
		...read.state.battlefield.map(
			(id): EntityRef => ({ type: "permanent", id }),
		),
		...(definition.legal.kind === "card"
			? zoneList(read.state, definition.legal.zone, "any").flatMap(
					(id): EntityRef[] => {
						const snapshot = read.view.objects.get(id);
						return snapshot?.kind === "card" ? [{ type: "card", id }] : [];
					},
				)
			: []),
	];
	return candidates.filter((target) =>
		isLegalTarget(read, definition, target, ctx),
	);
}

function legalSacrifices(
	read: ReadContext,
	player: PlayerId,
	predicate: ObjectPredicateDef,
	context: PredicateContext,
): ObjectId[] {
	return read.state.battlefield.filter((id) => {
		const snapshot = read.view.objects.get(id);
		return (
			snapshot?.kind === "permanent" &&
			snapshot.controller === player &&
			objectMatchesPredicate(predicate, snapshot, {
				controller: context.controller,
				source: context.source,
			})
		);
	});
}

/* ------------------------------------------------------------------ *
 * The actions a player is offered
 * ------------------------------------------------------------------ */

/**
 * Whether the rules currently permit `player` to play this exact card object
 * from its current zone. "Play" covers casting a spell or playing a land. A
 * zone change creates a new object id, so a temporary permission cannot follow
 * a card that leaves exile and later returns.
 */
function hasPlayPermission(
	read: ReadContext,
	player: PlayerId,
	object: DeepReadOnly<CardObject>,
): boolean {
	if (object.zone === "hand")
		return (
			object.owner === player &&
			read.state.players[player].hand.includes(object.id)
		);
	if (object.zone !== "exile") return false;

	for (const temporary of read.state.temporaryEffects) {
		if (temporary.controller !== player) continue;
		const definition = temporaryEffectDefinition(read.engine, temporary);
		if (definition?.kind !== "may-play") continue;
		assert(definition.from === "exile");
		const subject = temporary.bindings[definition.subject.slot];
		assert(
			subject?.type === "card",
			"temporary play permission has no bound card",
		);
		if (subject.id === object.id) return true;
	}
	return false;
}

/**
 * Whether `player` could begin casting `object` right now. This is an
 * action-offering preflight only: the actual announcement rechecks permission,
 * puts the spell on the stack, chooses targets, pays, and rewinds a failed
 * attempt.
 */
function canCast(
	object: DeepReadOnly<CardObject>,
	state: GameState,
	read: ReadContext,
	player: PlayerId,
): boolean {
	// TODO: this is simplified and does not account for alternative costs.
	assert(object.kind === "card");
	if (!hasPlayPermission(read, player, object)) return false;

	const snapshot = getSnapshot(read, object.id);
	assert(snapshot.kind === "card");
	const characteristics = snapshot.currentCharacteristics;

	// CR 202.1: a card with no mana cost cannot be cast without an alternative
	// cost, and the engine has none.
	if (characteristics.manaCost === "none") return false;

	// CR 305.1: lands are played as a special action, never cast.
	if (characteristics.types.includes("land")) return false;

	if (!doTimingRestrictionsAllowCast(characteristics, state, player))
		return false;

	if (
		planManaPayment(
			state.players[player].manaPool,
			characteristics.manaCost,
		) === null
	)
		return false;
	const definition = read.engine.cardDefinition(object.cardId).spell;
	const additionalCost = definition?.additionalCost;
	if (characteristics.types.some((type) => includes(SPELL_CARD_TYPES, type))) {
		assertDefined(
			definition,
			`${characteristics.name} has no spell definition`,
		);
		const target = requiredTargetDefinition(
			definition.targets,
			definition.effects,
		);
		if (
			target &&
			legalTargets(read, target, { controller: player, source: object.id })
				.length === 0
		)
			return false;
	} else {
		assert(
			!definition?.targets.length,
			"targeted permanent spells are not implemented",
		);
	}
	if (additionalCost) {
		assert(additionalCost.kind === "sacrifice");
		assert(additionalCost.amount === 1);
		if (
			legalSacrifices(read, player, additionalCost.predicate, {
				controller: player,
				source: object.id,
			}).length === 0
		)
			return false;
	}
	return true;
}

function castableSpells(
	state: GameState,
	read: ReadContext,
	player: PlayerId,
): CastAction[] {
	const castable: CastAction[] = [];
	for (const object of state.objects.values()) {
		if (object.kind !== "card") continue;
		if (canCast(object, state, read, player)) {
			castable.push({ kind: "cast", card: object.id });
		}
	}
	return castable;
}

/**
 * CR 305.2a's ordinary one land, plus the supported finite positive static
 * adjustments affecting `player`. The allowance is derived rather than stored:
 * changing an ability's possession, source zone, or source controller changes
 * the answer immediately, while `landsPlayed` remains turn history.
 */
function landPlayAllowance(read: ReadContext, player: PlayerId): number {
	let allowance = 1;
	for (const object of read.state.objects.values()) {
		// Use current possession from the derived view: a layer-6 grant or removal
		// changes whether this object generates the rule effect. The allowance is
		// not an input to characteristic derivation, so this does not recurse.
		for (const id of abilityReferencesOf(read.view, object).static) {
			const ability = abilityDefinition(read.engine, "static", id);
			if (!("kind" in ability) || ability.kind !== "adjust-land-plays")
				continue;
			if (!functionsHere(ability.functionsFrom, object.zone)) continue;
			assert(
				ability.affects === "you",
				"adjust-land-plays effect must affect its source's controller",
			);
			assert(
				Number.isSafeInteger(ability.amount) && ability.amount > 0,
				"adjust-land-plays amount must be a finite positive integer",
			);
			const controller = controllerOf(object);
			if (controller !== player) continue;
			allowance += ability.amount;
			assert(
				Number.isSafeInteger(allowance),
				"land-play allowance exceeds the safe integer range",
			);
		}
	}
	return allowance;
}

function canPlayOrdinaryLand(
	state: GameState,
	read: ReadContext,
	player: PlayerId,
): boolean {
	const location = turnLocation(state);
	return (
		player === activePlayer(state) &&
		location?.kind === "mainPhase" &&
		state.stack.length === 0 &&
		state.players[player].stats.lands.played < landPlayAllowance(read, player)
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
	return [...state.objects.values()].flatMap((object) => {
		if (
			object.kind !== "permanent" &&
			!(object.kind === "card" && object.zone !== "library")
		)
			return [];
		const abilityController = controllerOf(object) ?? object.owner;
		if (abilityController !== player) return [];
		const snapshot = getSnapshot(read, object.id);
		const actions: ActivateAbilityAction[] = [];
		for (const ability of snapshot.currentCharacteristics.abilities.activated) {
			const definition = abilityDefinition(read.engine, "activated", ability);
			const functionsFrom =
				definition.kind === "mana" ? undefined : definition.functionsFrom;
			if (!functionsHere(functionsFrom, object.zone)) continue;
			if (
				definition.kind === "activated" &&
				definition.restrictions?.asSorcery &&
				!isSorcerySpeed(state, player)
			) {
				continue;
			}
			if (
				definition.cost.tapSelf &&
				(object.kind !== "permanent" || object.tapped)
			)
				continue;
			if (
				definition.cost.tapSelf &&
				object.kind === "permanent" &&
				object.summoningSick &&
				snapshot.currentCharacteristics.types.includes("creature") &&
				!snapshot.currentCharacteristics.keywords.includes("haste")
			)
				continue;
			if (
				!planManaPayment(state.players[player].manaPool, definition.cost.mana)
			)
				continue;
			if (
				definition.cost.sacrifice &&
				legalSacrifices(read, player, definition.cost.sacrifice.predicate, {
					controller: player,
					source: object.id,
				}).length === 0
			)
				continue;
			if (definition.cost.discard) {
				if (
					definition.cost.discard.subject === "source" &&
					(object.kind !== "card" || object.zone !== "hand")
				)
					continue;
				if (
					definition.cost.discard.subject === undefined &&
					state.players[player].hand.length === 0
				)
					continue;
			}
			if (definition.kind === "activated") {
				// CR 601.2c via CR 602.2b: an ability with a required target cannot
				// be activated at all unless a legal target exists for it.
				const target = requiredTargetDefinition(
					definition.targets,
					definition.effects,
				);
				if (
					target &&
					legalTargets(read, target, {
						controller: player,
						source: object.id,
					}).length === 0
				)
					continue;
			}
			actions.push({ kind: "activate ability", source: object.id, ability });
		}
		return actions;
	});
}

/** Actions currently offered to a player receiving priority. */
function getObservableActions(
	engine: Engine,
	state: GameState,
	player: PlayerId,
): PriorityAction[] {
	const actions: PriorityAction[] = [{ kind: "pass" }];
	const read = createReadContext(engine, state);
	if (canPlayOrdinaryLand(state, read, player)) {
		const candidates = [
			...state.players[player].hand,
			...state.players[0].exile,
			...state.players[1].exile,
		];
		for (const id of candidates) {
			const object = maybeObject(state, id);
			if (object?.kind !== "card" || !hasPlayPermission(read, player, object))
				continue;
			const snapshot = getSnapshot(read, id);
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
 * holder is supplied by the scheduler and all legality is rechecked before
 * payment mutates canonical state.
 */
/* ------------------------------------------------------------------ *
 * Activating an ability
 * ------------------------------------------------------------------ */

function executeAbilityAction(
	engine: Engine,
	state: GameState,
	priorityPlayer: PlayerId,
	action: ActivateAbilityAction,
	source: ChoiceSource,
): void {
	activateAbilityIn(
		engine,
		state,
		priorityPlayer,
		action,
		asChoiceController(engine, source),
	);
}

/**
 * Puts a checkpoint's contents back while `state` keeps the identity its caller
 * holds. The checkpoint is a `structuredClone`, so nothing it hands back is
 * shared with the state being rolled back.
 *
 * The derived-view caches are dropped as well: they are keyed by state object
 * and revision number, and rolling the revision back means a later legitimate
 * mutation can reach a number a view from the abandoned branch was cached
 * under.
 */
function restoreCheckpoint(state: GameState, checkpoint: GameState): void {
	Object.assign(state, checkpoint);
	GAME_VIEW_CACHE.delete(state);
	PLAYER_VIEW_CACHE.delete(state);
}

function activateAbilityIn(
	engine: Engine,
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
	if (
		object?.kind !== "permanent" &&
		!(object?.kind === "card" && object.zone !== "library")
	) {
		throw new IllegalAbilityActivationError(
			`object ${action.source} is not an ability source in a supported zone`,
		);
	}
	const abilityController = controllerOf(object) ?? object.owner;
	if (abilityController !== priorityPlayer) {
		throw new IllegalAbilityActivationError(
			`P${priorityPlayer} does not control or own object ${action.source} in its current zone`,
		);
	}
	const snapshot = getSnapshot(createReadContext(engine, state), object.id);
	if (
		!snapshot.currentCharacteristics.abilities.activated.includes(
			action.ability,
		)
	) {
		throw new IllegalAbilityActivationError(
			`object ${action.source} does not have ability ${action.ability}`,
		);
	}
	const ability = abilityDefinition(engine, "activated", action.ability);
	const functionsFrom =
		ability.kind === "mana" ? undefined : ability.functionsFrom;
	if (!functionsHere(functionsFrom, object.zone)) {
		throw new IllegalAbilityActivationError(
			`ability ${action.ability} does not function from ${object.zone}`,
		);
	}
	if (
		ability.kind === "activated" &&
		ability.restrictions?.asSorcery &&
		!isSorcerySpeed(state, priorityPlayer)
	) {
		throw new IllegalAbilityActivationError(
			`ability ${action.ability} can be activated only as a sorcery`,
		);
	}
	if (ability.cost.tapSelf) {
		if (object.kind !== "permanent") {
			throw new IllegalAbilityActivationError(
				`object ${action.source} cannot pay a tap cost from ${object.zone}`,
			);
		}
		if (object.tapped) {
			throw new IllegalAbilityActivationError(
				`object ${action.source} is already tapped`,
			);
		}
		if (
			object.summoningSick &&
			snapshot.currentCharacteristics.types.includes("creature") &&
			!snapshot.currentCharacteristics.keywords.includes("haste")
		) {
			throw new IllegalAbilityActivationError(
				`object ${action.source} cannot pay a tap cost due to summoning sickness`,
			);
		}
	}
	const manaPayment = planManaPayment(
		state.players[priorityPlayer].manaPool,
		ability.cost.mana,
	);
	if (!manaPayment) {
		throw new IllegalAbilityActivationError(
			`P${priorityPlayer} cannot pay ability ${action.ability}'s mana cost from their mana pool`,
		);
	}

	const context: ResolutionSource = {
		source: object.id,
		controller: priorityPlayer,
		ability: null,
		targets: [],
	};
	let events: GameEvent[] = [];
	if (ability.kind === "mana") {
		if ("manaOptions" in ability) {
			if (
				!Array.isArray(ability.manaOptions) ||
				ability.manaOptions.length < 2
			) {
				throw new IllegalAbilityActivationError(
					`modal mana ability ${action.ability} must have at least two options`,
				);
			}
			if ("effects" in ability) {
				throw new IllegalAbilityActivationError(
					`modal mana ability ${action.ability} cannot also have fixed effects`,
				);
			}
			for (const option of ability.manaOptions) {
				if (
					typeof option !== "object" ||
					option === null ||
					Array.isArray(option)
				) {
					throw new IllegalAbilityActivationError(
						`mana ability ${action.ability} has an invalid option`,
					);
				}
				for (const type of Object.keys(option)) {
					if (!MANA_TYPES.includes(type as ManaType)) {
						throw new IllegalAbilityActivationError(
							`mana ability ${action.ability} produces an invalid mana type`,
						);
					}
				}
				let total = 0;
				for (const type of MANA_TYPES) {
					const amount = option[type] ?? 0;
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
			}
			const chosen = choices.chooseManaAmount(
				state,
				priorityPlayer,
				object.id,
				action.ability,
				ability.manaOptions,
			);
			assert(
				ability.manaOptions.includes(chosen),
				"chooseManaAmount returned an option outside its own candidate list",
			);
			events = [
				effectToEvent(
					engine,
					state,
					context,
					{ kind: "add-mana", subject: "you", mana: { ...chosen } },
					null,
				),
			];
		} else {
			events = ability.effects.map((effect) => {
				if (effect.kind !== "add-mana") {
					throw new IllegalAbilityActivationError(
						"only fixed mana production is supported for mana abilities",
					);
				}
				let total = 0;
				for (const type of MANA_TYPES) {
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
				return effectToEvent(engine, state, context, effect, null);
			});
		}
	}
	let targets: TargetBindings = [];
	let targetDefinitions: TargetDef[] = [];
	if (ability.kind !== "mana") {
		for (const effect of ability.effects) {
			if (
				effect.kind === "draw" ||
				effect.kind === "scry" ||
				effect.kind === "surveil" ||
				effect.kind === "choose-from-top" ||
				effect.kind === "mill" ||
				effect.kind === "exile-top" ||
				effect.kind === "gain-life" ||
				effect.kind === "lose-life" ||
				effect.kind === "damage" ||
				effect.kind === "destroy" ||
				effect.kind === "tap" ||
				effect.kind === "untap" ||
				effect.kind === "counter" ||
				effect.kind === "change-zone" ||
				effect.kind === "modify-pt" ||
				effect.kind === "grant-keyword" ||
				effect.kind === "grant-triggered" ||
				effect.kind === "may-play" ||
				effect.kind === "add counters" ||
				effect.kind === "sacrifice" ||
				effect.kind === "create-token" ||
				effect.kind === "create-delayed-trigger" ||
				effect.kind === "search-library" ||
				effect.kind === "shuffle-library"
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

		// CR 601.2c and CR 601.2h in order: the target is chosen, and rejected if
		// illegal, strictly before the activation cost below is paid. Nothing above this
		// point has mutated the game, so a refused activation leaves no trace.
		targetDefinitions = structuredClone(ability.targets);
		const target = requiredTargetDefinition(targetDefinitions, ability.effects);
		if (target) {
			const ctx = { controller: priorityPlayer, source: object.id };
			const candidates = legalTargets(
				createReadContext(engine, state),
				target,
				ctx,
			);
			if (candidates.length === 0) {
				throw new IllegalAbilityActivationError(
					`ability ${action.ability} has no legal target`,
				);
			}
			const chosen = choices.chooseTarget(
				state,
				priorityPlayer,
				{ announcing: "activated ability", source: object.id },
				target,
				candidates,
			);
			if (
				!isLegalTarget(createReadContext(engine, state), target, chosen, ctx)
			) {
				throw new IllegalAbilityActivationError(
					`ability ${action.ability}'s chosen target is no longer legal`,
				);
			}
			targets = [{ slot: target.id, target: chosen }];
		}
	}
	// Cost choices are made while announcing the ability, before payment.
	let sacrificePayment: ObjectId | null = null;
	const sacrificeCost = ability.cost.sacrifice;
	if (sacrificeCost) {
		assert(
			sacrificeCost.amount === 1,
			"only sacrificing one permanent is implemented",
		);
		const candidates = legalSacrifices(
			createReadContext(engine, state),
			priorityPlayer,
			sacrificeCost.predicate,
			{ controller: priorityPlayer, source: object.id },
		);
		if (candidates.length === 0) {
			throw new IllegalAbilityActivationError(
				`ability ${action.ability} has no permanent that can pay its sacrifice cost`,
			);
		}
		sacrificePayment = choices.chooseObject(state, priorityPlayer, {
			reason: { kind: "sacrifice" },
			objects: candidates,
		});
	}
	let discardPayment: ObjectId | null = null;
	const discardCost = ability.cost.discard;
	if (discardCost) {
		assert(discardCost.amount === 1, "only discarding one card is implemented");
		if (discardCost.subject === "source") {
			if (object.kind !== "card" || object.zone !== "hand")
				throw new IllegalAbilityActivationError(
					`ability ${action.ability} cannot discard its source from ${object.zone}`,
				);
			discardPayment = object.id;
		} else {
			const hand = state.players[priorityPlayer].hand;
			if (hand.length === 0) {
				throw new IllegalAbilityActivationError(
					`ability ${action.ability} has no card that can pay its discard cost`,
				);
			}
			discardPayment = choices.chooseObject(state, priorityPlayer, {
				reason: { kind: "discard" },
				objects: [...hand],
			});
		}
	}

	// CR 602.2b puts the ability on the stack before its cost is paid, so the
	// announcement mutates before the activation is known to be legal. CR 733.1
	// requires an attempt that cannot be completed to rewind everything it did.
	const checkpoint = structuredClone(state);

	// The ability is announced before payment so that it is already on the stack
	// to receive its source's last known information when paying the cost is
	// what removes the source. A mana ability never uses the stack.
	const item: ActivatedAbilityStackItem | null =
		ability.kind !== "mana"
			? {
					id: state.nextStackItemId++ as StackItemId,
					kind: "activated ability",
					source: object.id,
					abilityId: action.ability,
					controller: priorityPlayer,
					text: ability.text,
					targetDefinitions,
					targets,
					effects: structuredClone(ability.effects),
					sourceLastKnown: null,
				}
			: null;
	if (item) {
		state.stack.push(item);
		state.revision++;
		log(state, `  [stack] ${item.text}`);
	}

	const scope = newScope();
	try {
		// Spending mana is not an event, but it shares the activation checkpoint
		// with replaceable tap and sacrifice events. If payment fails after a
		// replacement changes the game, every component and the announcement rewind.
		const pool = state.players[priorityPlayer].manaPool;
		let spentMana = false;
		for (const type of MANA_TYPES) {
			const spent = manaPayment[type] ?? 0;
			assert(
				pool[type] >= spent,
				`payment plan spends ${spent} ${type} from a pool holding ${pool[type]}`,
			);
			pool[type] -= spent;
			if (spent > 0) spentMana = true;
		}
		if (spentMana) state.revision++;

		if (ability.cost.tapSelf) {
			const tapPayment = performIn(
				engine,
				state,
				{ kind: "tap", objects: [object.id] },
				choices,
				scope,
				0,
			);
			if (
				!tapPayment.executed.some(
					(event) =>
						event.kind === "tap" &&
						event.objects.length === 1 &&
						event.objects[0] === object.id,
				)
			) {
				throw new IllegalAbilityActivationError(
					`the tap cost for ability ${action.ability} was not paid`,
				);
			}
		}

		if (sacrificeCost) {
			assertDefined(sacrificePayment);
			const sacrifice = performIn(
				engine,
				state,
				{ kind: "sacrifice", object: sacrificePayment },
				choices,
				scope,
				0,
			);
			if (
				!sacrifice.executed.some(
					(event) =>
						event.kind === "sacrifice" && event.object === sacrificePayment,
				)
			) {
				throw new IllegalAbilityActivationError(
					`the sacrifice cost for ability ${action.ability} was not paid`,
				);
			}
		}

		if (discardCost) {
			assertDefined(discardPayment);
			const discard = performIn(
				engine,
				state,
				{
					kind: "discard",
					player: priorityPlayer,
					cards: { kind: "specific", card: discardPayment },
				},
				choices,
				scope,
				0,
			);
			// The discard event itself only instructs; the card leaving hand is
			// the child that actually pays the cost. Its destination is not part
			// of that check: CR 701.8a still calls the card discarded when a
			// replacement (Rest in Peace) exiles it instead of putting it in the
			// graveyard, so the cost is paid either way.
			if (
				!discard.executed.some(
					(event) =>
						event.kind === "change zone" &&
						event.object === discardPayment &&
						event.cause === "discard",
				)
			) {
				throw new IllegalAbilityActivationError(
					`the discard cost for ability ${action.ability} was not paid`,
				);
			}
			if (ability.kind === "cycling") {
				assert(
					discardPayment === object.id,
					"cycling must discard its source card",
				);
				const cycledCard = discard.created[0];
				assertDefined(cycledCard, "cycling discard created no card object");
				assert(
					discard.created.length === 1,
					"cycling discard created more than one card object",
				);
				performIn(
					engine,
					state,
					{ kind: "cycle", player: priorityPlayer, card: cycledCard },
					choices,
					scope,
					0,
				);
			}
		}
	} catch (error) {
		// Rejected/suspended replacement choices and replaced-away taps leave the
		// same half-finished activation as any other unpayable cost.
		restoreCheckpoint(state, checkpoint);
		throw error;
	}
	if (ability.kind === "mana") {
		log(state, `  [mana ability] ${ability.text}`);
		for (const event of events)
			performIn(engine, state, event, choices, scope, 0);
	}
}

/**
 * Casts a spell for the priority holder supplied by the scheduler, putting it
 * onto the stack (CR 601.2). Timing, actor, card, zone and affordability are
 * all rechecked before announcement mutates canonical state. Mana abilities
 * are still activated beforehand at priority rather than during casting.
 */
/* ------------------------------------------------------------------ *
 * Casting a spell
 * ------------------------------------------------------------------ */

function executeCastAction(
	engine: Engine,
	state: GameState,
	priorityPlayer: PlayerId,
	action: CastAction,
	source: ChoiceSource,
): void {
	castSpellIn(
		engine,
		state,
		priorityPlayer,
		action,
		asChoiceController(engine, source),
	);
}

function castSpellIn(
	engine: Engine,
	state: GameState,
	priorityPlayer: PlayerId,
	action: CastAction,
	choices: AnyChoiceController,
): void {
	if (state.turnScheduler.progress.kind !== "inTurn") {
		throw new IllegalCastError("a spell cannot be cast outside a turn");
	}

	const object = maybeObject(state, action.card);
	if (object?.kind !== "card") {
		throw new IllegalCastError(
			`object ${action.card} is not a card P${priorityPlayer} can cast`,
		);
	}

	const read = createReadContext(engine, state);
	if (!hasPlayPermission(read, priorityPlayer, object)) {
		throw new IllegalCastError(
			`P${priorityPlayer} has no permission to cast object ${action.card} from ${object.zone}`,
		);
	}
	const origin = object.zone;
	const snapshot = getSnapshot(read, action.card);
	assert(snapshot.kind === "card");
	const characteristics = snapshot.currentCharacteristics;

	if (characteristics.manaCost === "none") {
		throw new IllegalCastError(
			`${characteristics.name} has no mana cost and cannot be cast`,
		);
	}
	if (characteristics.types.includes("land")) {
		throw new IllegalCastError(
			`${characteristics.name} is a land and is played, not cast`,
		);
	}
	if (!doTimingRestrictionsAllowCast(characteristics, state, priorityPlayer)) {
		throw new IllegalCastError(
			`P${priorityPlayer} cannot cast ${characteristics.name} at this time`,
		);
	}

	const payment = planManaPayment(
		state.players[priorityPlayer].manaPool,
		characteristics.manaCost,
	);
	if (!payment) {
		throw new IllegalCastError(
			`P${priorityPlayer} cannot pay ${characteristics.name}'s mana cost from their mana pool`,
		);
	}

	const definition = read.engine.cardDefinition(object.cardId).spell;
	let target: TargetDef | null = null;
	const additionalCost = definition?.additionalCost ?? null;
	if (characteristics.types.some((type) => includes(SPELL_CARD_TYPES, type))) {
		assertDefined(
			definition,
			`${characteristics.name} has no spell definition`,
		);
		target = requiredTargetDefinition(definition.targets, definition.effects);
	} else {
		assert(
			!definition?.targets.length,
			"targeted permanent spells are not implemented",
		);
	}
	if (additionalCost) {
		assert(additionalCost.kind === "sacrifice");
		assert(additionalCost.amount === 1);
		if (
			legalSacrifices(read, priorityPlayer, additionalCost.predicate, {
				controller: priorityPlayer,
				source: action.card,
			}).length === 0
		) {
			throw new IllegalCastError(
				`${characteristics.name} has no permanent that can pay its additional cost`,
			);
		}
	}

	// CR 601.2a moves the card to the stack before CR 601.2c chooses targets and
	// CR 601.2h pays costs. Since that exposes an incomplete announcement to
	// replacements and choices, CR 733.1 rewinds the entire attempt if any later
	// step cannot be completed.
	const checkpoint = structuredClone(state);
	let castSpell: ObjectId;
	try {
		const movement = performIn(
			engine,
			state,
			{
				kind: "change zone",
				object: action.card,
				from: origin,
				destination: {
					zone: "stack",
					controller: priorityPlayer,
					targets: [],
				},
				cause: "cast",
			},
			choices,
			newScope(),
			0,
		);
		const executedMove = movement.executed.filter(
			(event): event is ZoneChangeEvent =>
				event.kind === "change zone" &&
				event.object === action.card &&
				event.from === origin &&
				event.destination.zone === "stack" &&
				event.cause === "cast" &&
				event.destination.controller === priorityPlayer,
		);
		if (
			movement.executed.length !== 1 ||
			executedMove.length !== 1 ||
			movement.created.length !== 1
		) {
			throw new IllegalCastError(
				`${characteristics.name}'s move to the stack was replaced`,
			);
		}

		const spellId = movement.created[0];
		assertDefined(spellId, "casting created no spell object");
		const spell = maybeObject(state, spellId);
		assert(
			spell?.kind === "spell" &&
				spell.zone === "stack" &&
				spell.controller === priorityPlayer,
			"casting did not create the expected spell object",
		);
		const entry = state.stack[state.stack.length - 1];
		assert(
			entry?.kind === "spell" && entry.objectId === spellId,
			"the announced spell is not the top stack entry",
		);
		assert(entry.targets.length === 0, "new spell already has target bindings");

		if (target) {
			const ctx = { controller: priorityPlayer, source: spellId };
			const candidates = legalTargets(
				createReadContext(engine, state),
				target,
				ctx,
			);
			if (candidates.length === 0) {
				throw new IllegalCastError(
					`${characteristics.name} has no legal target`,
				);
			}
			const chosen = choices.chooseTarget(
				state,
				priorityPlayer,
				{ announcing: "spell", source: spellId },
				target,
				candidates,
			);
			if (
				!isLegalTarget(createReadContext(engine, state), target, chosen, ctx)
			) {
				throw new IllegalCastError(
					`${characteristics.name}'s chosen target is no longer legal`,
				);
			}
			entry.targets = [{ slot: target.id, target: structuredClone(chosen) }];
			state.revision++;
		}

		let sacrificePayment: ObjectId | null = null;
		if (additionalCost) {
			const candidates = legalSacrifices(
				createReadContext(engine, state),
				priorityPlayer,
				additionalCost.predicate,
				{ controller: priorityPlayer, source: spellId },
			);
			if (candidates.length === 0) {
				throw new IllegalCastError(
					`${characteristics.name} has no permanent that can pay its additional cost`,
				);
			}
			sacrificePayment = choices.chooseObject(state, priorityPlayer, {
				reason: { kind: "sacrifice" },
				objects: candidates,
			});
		}

		// Spending mana is a cost, not an event, so nothing may replace or trigger
		// off it. It shares the announcement transaction with the replaceable
		// sacrifice payment below.
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
			} for ${characteristics.name}`,
		);

		if (additionalCost) {
			assertDefined(sacrificePayment);
			const sacrifice = performIn(
				engine,
				state,
				{ kind: "sacrifice", object: sacrificePayment },
				choices,
				newScope(),
				0,
			);
			if (
				!sacrifice.executed.some(
					(event) =>
						event.kind === "sacrifice" && event.object === sacrificePayment,
				)
			) {
				throw new IllegalCastError(
					`${characteristics.name}'s additional sacrifice cost was not paid`,
				);
			}
		}

		castSpell = spellId;
	} catch (error) {
		restoreCheckpoint(state, checkpoint);
		throw error;
	}

	// CR 601.2i: the spell has been cast. Cast triggers fire only now, once the
	// announcement transaction has committed and can no longer be rewound.
	performIn(
		engine,
		state,
		{ kind: "cast", player: priorityPlayer, spell: castSpell },
		choices,
		newScope(),
		0,
	);
}

/**
 * Executes a land action for the priority holder supplied by the scheduler.
 * Timing, actor, card, zone, and allowance are rechecked before mutation.
 */
/* ------------------------------------------------------------------ *
 * Playing a land
 * ------------------------------------------------------------------ */

function executeLandAction(
	engine: Engine,
	state: GameState,
	priorityPlayer: PlayerId,
	action: PlayLandAction,
	source: ChoiceSource,
): void {
	playLandIn(
		engine,
		state,
		priorityPlayer,
		action,
		asChoiceController(engine, source),
	);
}

function playLandIn(
	engine: Engine,
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
	const read = createReadContext(engine, state);
	const allowance = landPlayAllowance(read, priorityPlayer);
	if (state.players[priorityPlayer].stats.lands.played >= allowance) {
		throw new IllegalLandPlayError(
			`the ${allowance}-land-per-turn allowance is exhausted`,
		);
	}

	const object = maybeObject(state, action.card);
	if (object?.kind !== "card") {
		throw new IllegalLandPlayError(
			`object ${action.card} is not a card P${priorityPlayer} can play`,
		);
	}
	if (!hasPlayPermission(read, priorityPlayer, object)) {
		throw new IllegalLandPlayError(
			`P${priorityPlayer} has no permission to play object ${action.card} from ${object.zone}`,
		);
	}
	const origin = object.zone;
	const snapshot = getSnapshot(read, action.card);
	if (
		snapshot.kind !== "card" ||
		!snapshot.currentCharacteristics.types.includes("land")
	) {
		throw new IllegalLandPlayError(`object ${action.card} is not a land`);
	}

	performIn(
		engine,
		state,
		{
			kind: "change zone",
			object: action.card,
			from: origin,
			destination: { zone: "battlefield", controller: priorityPlayer },
			cause: "play land",
		},
		choices,
		newScope(),
		0,
	);
	state.players[priorityPlayer].stats.lands.played++;
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
/* ------------------------------------------------------------------ *
 * Passing priority
 * ------------------------------------------------------------------ */

function settlePriority(
	engine: Engine,
	state: GameState,
	source: ChoiceSource,
): void {
	settlePriorityIn(engine, state, asChoiceController(engine, source));
}

function settlePriorityIn(
	engine: Engine,
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
		checkStateBasedActionsIn(engine, state, choices);
		if (gameOver(state)) return;

		putPendingTriggersOnStack(engine, state, choices, active);
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
			getObservableActions(engine, state, priority),
		);

		if (action.kind === "play land") {
			playLandIn(engine, state, priority, action, choices);
			// A special action neither passes nor changes who has priority.
			lastWasPass = false;
			continue;
		}
		if (action.kind === "activate ability") {
			activateAbilityIn(engine, state, priority, action, choices);
			// CR 117.3c: the activating player receives priority again. Mana
			// abilities resolve immediately; other activated abilities are stacked.
			lastWasPass = false;
			continue;
		}
		if (action.kind === "cast") {
			castSpellIn(engine, state, priority, action, choices);
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
			resolveTopOfStack(engine, state, choices);
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

function priority(
	engine: Engine,
	state: GameState,
	choices: AnyChoiceController,
) {
	settlePriorityIn(engine, state, choices);
}

/* ------------------------------------------------------------------ *
 * Turn progression
 * ------------------------------------------------------------------ */
function performPreGameActions(
	state: GameState,
	__choices: AnyChoiceController,
	step: PreGameStepKind,
): void {
	switch (step) {
		case "shuffle":
			for (const player of state.players) shuffleLibrary(state, player.id);
			break;
		case "opening hand":
		case "mulligan":
		case "opening hand actions":
			break;
		default:
			assertNever(step);
	}
}

function performTurnBasedActions(
	engine: Engine,
	state: GameState,
	choices: AnyChoiceController,
	step: StepOccurrence,
	active: PlayerId,
): void {
	switch (step.kind) {
		case "untap": {
			const objects = state.battlefield.filter(
				(id) => maybePermanent(state, id)?.controller === active,
			);
			if (objects.length === 0) break;
			performIn(
				engine,
				state,
				{
					kind: "untap",
					objects,
				},
				choices,
				newScope(),
				0,
			);
			break;
		}
		case "draw":
			state.players[active].stats.drawn.inDrawStep = 0;
			performIn(
				engine,
				state,
				{ kind: "draw", player: active },
				choices,
				newScope(),
				0,
			);
			break;
		case "cleanup":
			performIn(
				engine,
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
			state.temporaryEffects = state.temporaryEffects.filter((effect) => {
				if (effect.duration === "until-end-of-turn") return false;
				if (effect.expiresAtEndOfTurn === null) return true;
				if (effect.expiresAtEndOfTurn !== step.turnId) return true;
				assert(
					effect.controller === active,
					"a next-turn effect must expire during its controller's cleanup",
				);
				return false;
			});

			break;
		case "declare attackers": {
			// Ask once for a replayable subset, then commit it as one event. Battlefield
			// order is preserved so the offered options are stable and deterministic.
			const eligible = eligibleAttackers(engine, state, active);
			const attackers = choices.chooseAttackers(state, active, eligible);
			performIn(
				engine,
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
			const read = createReadContext(engine, state);
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
				recipient: DamageRecipientRef,
				amount: number,
			): DamageEvent => ({
				kind: "damage",
				source: source.id,
				sourceController: source.controller,
				sourceColors: characteristics.colors,
				recipient,
				amount,
				combat: true,
				deathtouch: characteristics.keywords.includes("deathtouch"),
				lifelink: characteristics.keywords.includes("lifelink"),
				unpreventable: false,
			});

			for (const id of state.battlefield) {
				const o = maybePermanent(state, id);
				if (!o?.attacking) continue;
				const snapshot = getSnapshot(read, id);
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

				// Assign lethal in declaration order. A nontrampling attacker puts
				// every remainder on the final blocker; trample may assign only lethal
				// there and assigns the rest to the defending player.
				let remaining = Math.max(0, characteristics.power);
				const hasTrample = characteristics.keywords.includes("trample");
				const blockers = (blockersByAttacker.get(id) ?? []).filter(
					(blockerId) => maybePermanent(state, blockerId)?.blocking,
				);
				for (let index = 0; index < blockers.length && remaining > 0; index++) {
					const blockerId = blockers[index];
					assertDefined(blockerId);
					const blocker = maybePermanent(state, blockerId);
					assertDefined(blocker);
					const blockerSnapshot = getSnapshot(read, blockerId);
					assert(blockerSnapshot.kind === "permanent");
					const blockerCharacteristics = blockerSnapshot.currentCharacteristics;
					if (blockerCharacteristics.kind !== "creature") continue;
					const lethalAmount = characteristics.keywords.includes("deathtouch")
						? 1
						: Math.max(0, blockerCharacteristics.toughness - blocker.damage);
					const amount =
						index === blockers.length - 1 && !hasTrample
							? remaining
							: Math.min(remaining, lethalAmount);
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
				if (hasTrample && remaining > 0) {
					events.push(
						damageEvent(
							o,
							characteristics,
							{ type: "player", player: defender },
							remaining,
						),
					);
				}
			}

			for (const { blocker, attacker } of state.blockAssignments) {
				const blockerObject = maybePermanent(state, blocker);
				const attackerObject = maybePermanent(state, attacker);
				if (!blockerObject?.blocking || !attackerObject?.attacking) continue;
				const blockerSnapshot = getSnapshot(read, blocker);
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
			for (const ev of events)
				performIn(engine, state, ev, choices, newScope(), 0);
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
			const attackers = creaturesControlledBy(
				createReadContext(engine, state),
				active,
			)
				.filter((o) => o.attacking)
				.map((o) => o.id);
			const eligible = eligibleBlockers(engine, state, defender);
			const blockers = choices.chooseBlockers(
				state,
				defender,
				attackers,
				eligible,
			);
			performIn(
				engine,
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
async function advanceWithReplay(
	engine: Engine,
	checkpoint: GameState,
	agents: AgentPair,
	transcript: ChoiceTranscript = { version: 1, choices: [] },
): Promise<AdvanceWithReplayResult> {
	const baseline = structuredClone(checkpoint);
	const choices = ChoiceController.suspending(engine, agents, transcript);

	for (let attempts = 1; ; attempts++) {
		const attempt = structuredClone(baseline);
		choices.rewind();

		try {
			advanceIn(engine, attempt, choices);
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
function startGame(
	engine: Engine,
	state: GameState,
	source: ChoiceSource,
): void {
	const choices = asChoiceController(engine, source);
	// One transition per pre-game step, plus the one that installs the turn.
	for (let call = 0; call <= PRE_GAME_STEPS.length + 1; call++) {
		if (state.turnScheduler.progress.kind === "inTurn") return;
		advanceIn(engine, state, choices);
	}
	throw new Error("the pre-game did not reach the first turn");
}

function advance(engine: Engine, state: GameState, source: ChoiceSource): void {
	advanceIn(engine, state, asChoiceController(engine, source));
}

function advanceIn(
	engine: Engine,
	state: GameState,
	choices: AnyChoiceController,
): void {
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
					engine,
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

				for (const effect of state.temporaryEffects) {
					if (
						effect.duration === "until-end-of-your-next-turn" &&
						effect.controller === turn.player &&
						effect.expiresAtEndOfTurn === null
					) {
						effect.expiresAtEndOfTurn = turn.id;
					}
				}

				// CR 302.6: permanents already controlled as this turn begins are no
				// longer affected by summoning sickness. This applies to every
				// permanent because a later type-changing effect may make it a creature.
				for (const id of state.battlefield) {
					const object = permanent(state, id);
					if (object.controller === turn.player) object.summoningSick = false;
				}

				// The turn is now current even though no phase of it has begun,
				// so "whose turn is it" already answers with its player.
				scheduler.progress = { kind: "inTurn", turn, location: null };
				state.players[turn.player].stats.lands.played = 0;
				// A turn boundary closes every "...in a turn" draw count, for both
				// players: an opponent can draw during your turn.
				for (const p of state.players) p.stats.drawn.thisTurn = 0;
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
					engine,
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
					priority(engine, state, choices);
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
					engine,
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
				performTurnBasedActions(engine, state, choices, step, turn.player);
				// Untap has no priority window. Cleanup normally has none, but the
				// priority helper opens one if something triggered.
				priority(engine, state, choices);
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

export function winner(state: GameState): PlayerId | "draw" | null {
	if (state.players[0].won && state.players[1].won) {
		throw new Error("two players cannot win the game at the same time.");
	}
	if (state.players[0].lost && state.players[1].lost) return "draw";

	const won = state.players.filter((p) => p.won);

	if (won[0]) return won[0].id;

	const lost = state.players.filter((p) => p.lost);

	if (lost[0]) return (1 - lost[0].id) as PlayerId;
	// game still in progress.
	return null;
}
