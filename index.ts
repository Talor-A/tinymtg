import { KeyboardAgent, RandomAgent } from "./agents";
import {
	type AgentPair,
	type AnyChoiceController,
	asChoiceController,
	ChoiceController,
	ChoicePendingError,
	type ChoiceSource,
	type ChoiceTranscript,
	type SyncAgentPair,
} from "./choices.ts";
import * as EFFECTS from "./effects";

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
type Brand<T, K extends string> = T & { readonly __brand: K };

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

export type Supertype = "legendary" | "basic" | "snow";

export type CardType =
	| "creature"
	| "artifact"
	| "enchantment"
	| "land"
	| "instant"
	| "sorcery"
	| "planeswalker";

/* ------------------------------------------------------------------ *
 * Turns
 * ------------------------------------------------------------------ */
type TurnId = Brand<number, "TurnId">;
type PhaseId = Brand<number, "PhaseId">;
type StepId = Brand<number, "StepId">;

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
	| {
			kind: "inTurn";
			turn: TurnOccurrence;
			location: TurnLocation;
	  };

type SchedulerCommand =
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
	/** The next serializable unit of scheduler control flow. */
	command: SchedulerCommand;
	/** The only externally observable turn locations. */
	progress: GameProgress;
	/** Only exceptional turns are queued. The front is taken next. */
	pendingTurns: TurnOccurrence[];
	/** Used to lazily create the next ordinary turn when the queue is empty. */
	nextRegularPlayer: PlayerId;
	remainingSteps: StepOccurrence[];
	nextId: number;
}

/** The current rules-defined turn location, or null before the game starts. */
export function turnLocation(state: ReadonlyGameState): TurnLocation | null {
	const progress = state.turnScheduler.progress;
	return progress.kind === "inTurn" ? progress.location : null;
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

export type CounterNames = "+1/+1" | "-1/-1" | "charge" | "poison";
export type CounterBag = Partial<Record<CounterNames, number>>;

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */
/**
 * Used for referencing entities in events.
 * TODO: this might be insufficient
 */
type EntityRef =
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
 * TODO: Per above, if a replacement effect replaces
 * `{ kind: zone change, from: battlefield, to: graveyard }`, we might still
 * consider the permanent destroyed, but 701.8b says if it's not moved to the
 * graveyard, it hasn't been "destroyed."
 *
 * possible implementation:
 * ```
 * { kind: zone change, from: battlefield, to: graveyard, isDestroy: true }
 * ```
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
	copyEffect?: CharacteristicsSnapshot;
	toBottom?: boolean;
}

type MoveCause =
	| "draw"
	| "discard"
	| "mill"
	| "destroy"
	| "sacrifice"
	| "sba"
	| "cast"
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
	turnId?: TurnId;
	phaseId?: PhaseId;
	stepId?: StepId;
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

/** Serializable `cardId:index` registry reference to a static ability. */
export type StaticAbilityId = string & {
	readonly __staticAbilityId: unique symbol;
};

/** Serializable `cardId:index` registry reference to an activated ability. */
export type ActivatedAbilityId = string & {
	readonly __activatedAbilityId: unique symbol;
};

/** Serializable `cardId:index` registry reference to a triggered ability. */
export type TriggeredAbilityId = string & {
	readonly __triggeredAbilityId: unique symbol;
};

/** Serializable `cardId:index` registry reference to a replacement effect. */
export type ReplacementAbilityId = string & {
	readonly __replacementAbilityId: unique symbol;
};

/** Serializable `cardId:index` registry reference to a prohibition effect. */
export type ProhibitionAbilityId = string & {
	readonly __prohibitionAbilityId: unique symbol;
};

function abilityRef(
	cardId: string,
	index: number,
	category: AbilityCategory,
): string {
	assert(
		Number.isSafeInteger(index) && index >= 0,
		`invalid ${category} ability index`,
	);
	return `${cardId}:${index}`;
}

/**
 * Card ids may themselves contain colons (`card:id:with:colons`), so the index
 * is always the segment after the *last* colon.
 */
function parseAbilityRef(
	id: string,
	category: AbilityCategory,
): { cardId: string; index: number } {
	const separator = id.lastIndexOf(":");
	assert(separator > 0, `invalid ${category} ability id: ${id}`);
	const indexText = id.slice(separator + 1);
	assert(/^\d+$/.test(indexText), `invalid ${category} ability id: ${id}`);
	return { cardId: id.slice(0, separator), index: Number(indexText) };
}

export function staticAbilityId(
	cardId: string,
	index: number,
): StaticAbilityId {
	return abilityRef(cardId, index, "static") as StaticAbilityId;
}

export function activatedAbilityId(
	cardId: string,
	index: number,
): ActivatedAbilityId {
	return abilityRef(cardId, index, "activated") as ActivatedAbilityId;
}

export function triggeredAbilityId(
	cardId: string,
	index: number,
): TriggeredAbilityId {
	return abilityRef(cardId, index, "triggered") as TriggeredAbilityId;
}

export function replacementAbilityId(
	cardId: string,
	index: number,
): ReplacementAbilityId {
	return abilityRef(cardId, index, "replacement") as ReplacementAbilityId;
}

export function prohibitionAbilityId(
	cardId: string,
	index: number,
): ProhibitionAbilityId {
	return abilityRef(cardId, index, "prohibition") as ProhibitionAbilityId;
}

export function resolveStaticAbility(id: StaticAbilityId): ContinuousEffect {
	const { cardId, index } = parseAbilityRef(id, "static");
	const effect = card(cardId).abilityDefinitions.static[index];
	assertDefined(effect, `unknown static ability: ${id}`);
	return effect;
}

export function resolveActivatedAbility(
	id: ActivatedAbilityId,
): ActivatedAbilityDef {
	const { cardId, index } = parseAbilityRef(id, "activated");
	const ability = card(cardId).abilityDefinitions.activated[index];
	assertDefined(ability, `unknown activated ability: ${id}`);
	return ability;
}

export function resolveTriggeredAbility(id: TriggeredAbilityId): TriggerDef {
	const { cardId, index } = parseAbilityRef(id, "triggered");
	const ability = card(cardId).abilityDefinitions.triggered[index];
	assertDefined(ability, `unknown triggered ability: ${id}`);
	return ability;
}

export function resolveReplacementAbility(
	id: ReplacementAbilityId,
): ReplacementDef {
	const { cardId, index } = parseAbilityRef(id, "replacement");
	const def = card(cardId).abilityDefinitions.replacement[index];
	assertDefined(def, `unknown replacement ability: ${id}`);
	return def;
}

export function resolveProhibitionAbility(
	id: ProhibitionAbilityId,
): ProhibitionDef {
	const { cardId, index } = parseAbilityRef(id, "prohibition");
	const def = card(cardId).abilityDefinitions.prohibition[index];
	assertDefined(def, `unknown prohibition ability: ${id}`);
	return def;
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

	// TODO
	choices?: never;
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

interface AbilitySnapshot {
	kind: "ability";
	zone: "stack";
	objectId: ObjectId;
	controller: PlayerId;

	source: ObjectSnapshot;
	/** TODO */
	ability: never;
}

interface NonbattlefieldTokenSnapshot extends SnapshotBase {
	kind: "nonbattlefield-token";
	zone: "library" | "hand" | "graveyard" | "exile";
	controller: null;

	copiableValues: CharacteristicsSnapshot;
	currentCharacteristics: CharacteristicsSnapshot;
}

type ObjectSnapshot =
	| CardSnapshot
	| SpellSnapshot
	| PermanentSnapshot
	| AbilitySnapshot
	| NonbattlefieldTokenSnapshot;

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
			if (object.copyEffect) return object.copyEffect;
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

function cloneCharacteristics(
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
	readonly objects: ReadonlyMap<ObjectId, ObjectSnapshot>;
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
	const copiable = new Map<ObjectId, CharacteristicsSnapshot>();
	const characteristics = new Map<ObjectId, CharacteristicsSnapshot>();
	const abilities: Partial<
		Record<
			ContinuousEffectLayer,
			[effect: ContinuousEffect, source: DeepReadOnly<GameObject>][]
		>
	> = {};

	for (const object of state.objects.values()) {
		// `initial` is already a fresh clone, and layer 1a replaces rather than
		// mutates its map entry, so it can serve as the copiable values directly.
		const initial = initialCharacteristics(object);
		copiable.set(object.id, initial);
		characteristics.set(object.id, cloneCharacteristics(initial));

		for (const abilityId of initial.abilities.static) {
			const ability = resolveStaticAbility(abilityId);
			if (!functionsHere(ability.functionsIn, object.zone)) continue;
			(abilities[ability.layer] ??= []).push([ability, object]);
		}
	}

	for (const layer of CONTINUOUS_EFFECT_LAYERS) {
		for (const [ability, source] of abilities[layer] ?? []) {
			const zones: readonly Zone[] =
				ability.functionsIn === "any"
					? ALL_ZONES
					: (ability.functionsIn ?? ["battlefield"]);

			for (const zone of zones) {
				for (const objectId of zoneList(state, zone, "any")) {
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
	}

	// Counters are applied after continuous P/T modifiers.
	for (const object of state.objects.values()) {
		if (object.kind !== "permanent") continue;
		const current = characteristics.get(object.id);
		assertDefined(current);
		if (current.kind !== "creature") continue;
		const delta =
			(object.counters["+1/+1"] ?? 0) - (object.counters["-1/-1"] ?? 0);
		current.power += delta;
		current.toughness += delta;
	}

	const snapshots = new Map<ObjectId, ObjectSnapshot>();
	for (const object of state.objects.values()) {
		const copy = copiable.get(object.id);
		const current = characteristics.get(object.id);
		assertDefined(copy);
		assertDefined(current);

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
			case "spell":
				snapshots.set(object.id, {
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

type EffectId = string & { readonly __effect: unique symbol };

function eid(id: string): EffectId {
	return id as EffectId;
}

export interface PendingTrigger {
	source: ObjectId;
	triggerId: TriggeredAbilityId;
	controller: PlayerId;
	text: string;
	effects: EffectDef[];
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

	// manaPool: {
	// 	w?: number;
	// 	u?: number;
	// 	b?: number;
	// 	r?: number;
	// 	g?: number;
	// };
	landsPlayed: number;
	lost: boolean;
	won: boolean;
}

export interface PassAction {
	kind: "pass";
}
/** Reserved action shape; casting isn't observable or executable yet. */
export interface CastAction {
	kind: "cast";
}
/** Reserved action shape; activated abilities aren't observable or executable yet. */
export interface ActivateAbilityAction {
	kind: "activate ability";
}
/** Reserved action shape; land play isn't observable or executable yet. */
export interface PlayLandAction {
	kind: "play land";
}
export type PriorityAction =
	| PassAction
	| CastAction
	| ActivateAbilityAction
	| PlayLandAction;

export interface AbilityStackItem {
	id: ObjectId;
	kind: "ability";
	source: ObjectId;
	triggerId: TriggeredAbilityId;
	controller: PlayerId;
	text: string;
	effects: EffectDef[];
}

export interface GameState {
	/** Incremented whenever canonical state changes and used to reject stale views. */
	revision: number;
	objects: Map<ObjectId, GameObject>;
	players: [PlayerState, PlayerState];
	battlefield: ObjectId[];
	stack: ObjectId[];
	/** Ability stack entries are not game objects; the shared stack stores their ids. */
	stackItems: Map<ObjectId, AbilityStackItem>;
	/** Trigger occurrences waiting for the next time a player would receive priority. */
	pendingTriggers: PendingTrigger[];
	floating: FloatingEffect[];
	turn: number;
	activePlayer: PlayerId;
	turnScheduler: TurnScheduler;
	nextObjectId: number;
	/** Monotonic tag source for guard facts (e.g. Chains of Mephistopheles). */
	nextTag: number;
	log: string[];
	rngState: number;
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

	/** Casting choices that are properties of the spell. */
	// TODO
	choices: never;
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

	/** Layer-1 copy effect, if one currently defines its copiable values. */
	copyEffect?: CharacteristicsSnapshot;

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

/** Zones an ability functions in. 'any' == functions from anywhere (CR 113.6). */
type FunctionsIn = Zone[] | "any";
function functionsHere(
	scopes: FunctionsIn = ["battlefield"],
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
	functionsIn?: FunctionsIn;
	/** further scope the rule, after applying functionsIn above. */
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
	functionsIn?: FunctionsIn;
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
 * stack items, and the resolver. Target-bearing effects are definition-ready;
 * the current runtime executes only the targetless subset.
 * ------------------------------------------------------------------ */

export type EffectDef =
	| {
			kind: "gain-life" | "lose-life" | "draw";
			player: "you" | "opponent";
			amount: number;
	  }
	/** Definition-time targets are slot ids until casting binds them. */
	| { kind: "damage"; target: EntityRef | string; amount: number }
	| { kind: "destroy"; target: EntityRef | string }
	| {
			kind: "modify-pt";
			target: string;
			power: number;
			toughness: number;
			duration: "until-end-of-turn";
	  }
	| {
			kind: "add-mana";
			player: "you";
			mana: Record<Color, number>;
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
	 * Zones in which this trigger can function.
	 *
	 * Defaults to `["battlefield"]`.
	 */
	functionsIn?: [Zone];
	effects: EffectDef[];
}

/* ------------------------------------------------------------------ *
 * Cards
 * ------------------------------------------------------------------ */

export type Keyword = "indestructible" | "lifelink" | "flying";

/** Importer-neutral selector retained until targeting is executable. */
export type TargetSelectorDef =
	| { kind: "self" }
	| { kind: "type"; type: CardType }
	| { kind: "supertype"; supertype: Supertype }
	| { kind: "subtype"; subtype: string }
	| { kind: "color"; color: Color }
	| { kind: "controller"; player: "you" | "opponent" }
	| { kind: "all" | "any"; selectors: TargetSelectorDef[] }
	| { kind: "not"; selector: TargetSelectorDef };

/** Declarative targeting retained on compiled cards until casting is implemented. */
export interface TargetDef {
	id: string;
	min: number;
	max: number;
	legal:
		| { kind: "player" }
		| { kind: "permanent"; selector: TargetSelectorDef }
		| { kind: "any-target" };
}

export interface SpellAbilityDef {
	id: string;
	text: string;
	targets: TargetDef[];
	effects: EffectDef[];
}

export interface ActivatedAbilityDef {
	id: string;
	text: string;
	manaAbility: boolean;
	costs: { kind: "tap-self" }[];
	targets: TargetDef[];
	effects: EffectDef[];
}

type CardDefManaCost =
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
 * `staticAbilityId(cardId, index)` and friends resolve to it. What the card
 * actually has is {@link CardDef.printedAbilities}.
 */
export interface AbilityDefinitions {
	static: ContinuousEffect[];
	activated: ActivatedAbilityDef[];
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
	activatedAbilities?: ActivatedAbilityDef[];
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

const ABILITY_REF_CONSTRUCTORS = {
	static: staticAbilityId,
	activated: activatedAbilityId,
	triggered: triggeredAbilityId,
	replacement: replacementAbilityId,
	prohibition: prohibitionAbilityId,
} as const;

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
			return ABILITY_REF_CONSTRUCTORS[category](id, index);
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
			functionsIn: "any",
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
			functionsIn: "any",
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
			replacementAbilityId(input.id, abilityDefinitions.replacement.length),
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
	landsPlayed: 0,
	lost: false,
	won: false,
	counters: {},
});

export function newGame(): GameState {
	return {
		revision: 0,
		objects: new Map(),
		players: [newPlayerState(0), newPlayerState(1)],
		battlefield: [],
		stack: [],
		stackItems: new Map(),
		pendingTriggers: [],
		floating: [],
		turn: 0,
		activePlayer: 0 as PlayerId,
		turnScheduler: {
			command: { kind: "advanceTurn" },
			progress: { kind: "notStarted" },
			pendingTurns: [],
			nextRegularPlayer: 0 as PlayerId,
			remainingSteps: [],
			nextId: 0,
		},
		nextObjectId: 0,
		nextTag: 0,
		log: [],
		rngState: 0,
	};
}

/* ------------------------------------------------------------------ *
 * Object creation
 * ------------------------------------------------------------------ */

function defaultVisibility(zone: Zone, to: PlayerId, owner: PlayerId): boolean {
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
	zoneList(state, zone, owner).push(obj.id);
	state.revision++;
	return obj;
}

export function spawnPermanent(
	state: GameState,
	cardId: string,
	owner: PlayerId,
	battlefield?: "battlefield",
	opts?: { tapped?: boolean; counters?: CounterBag; token?: boolean },
): PermanentObject;
export function spawnPermanent(
	state: GameState,
	cardId: string,
	owner: PlayerId,
	opts?: { tapped?: boolean; counters?: CounterBag; token?: boolean },
): PermanentObject;
export function spawnPermanent(
	state: GameState,
	cardId: string,
	owner: PlayerId,
	zoneOrOpts:
		| "battlefield"
		| {
				tapped?: boolean;
				counters?: CounterBag;
				token?: boolean;
		  } = "battlefield",
	legacyOpts: { tapped?: boolean; counters?: CounterBag; token?: boolean } = {},
): PermanentObject {
	const opts = zoneOrOpts === "battlefield" ? legacyOpts : zoneOrOpts;
	const values = characteristicsFromCardDef(card(cardId));
	const obj: PermanentObject = {
		representation: opts.token
			? { kind: "token", createdValues: values }
			: { kind: "card", cardId },
		zone: "battlefield",
		kind: "permanent",
		id: state.nextObjectId++ as ObjectId,

		owner,
		controller: owner,

		tapped: opts.tapped ?? false,
		counters: { ...opts.counters },
		effectData: {},
		damage: 0,
		attacking: false,
		blocking: false,
		token: opts.token ?? false,
		attributes: {},
	};
	state.objects.set(obj.id, obj);
	zoneList(state, "battlefield", owner).push(obj.id);
	state.revision++;
	return obj;
}
export function spawnToken(
	state: GameState,
	owner: PlayerId,
	attributes: CharacteristicsSnapshot,
): PermanentObject {
	const obj: PermanentObject = {
		kind: "permanent",
		representation: {
			kind: "token",
			createdValues: attributes,
		},
		zone: "battlefield",
		id: state.nextObjectId++ as ObjectId,
		owner,
		controller: owner,
		attacking: false,
		blocking: false,
		counters: {},
		damage: 0,
		tapped: false,
		effectData: {},
		token: true,
		attributes: {},
	};
	state.objects.set(obj.id, obj);
	zoneList(state, "battlefield", owner).push(obj.id);
	state.revision++;
	return obj;
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
	}
}

/** @deprecated Use {@link physicalCardId}. */
export function cardIdOf(object: DeepReadOnly<GameObject>): string | null {
	return physicalCardId(object);
}

export function controllerOf(
	object: DeepReadOnly<GameObject>,
): PlayerId | null {
	return object.kind === "spell" || object.kind === "permanent"
		? object.controller
		: null;
}

export function isTokenObject(object: DeepReadOnly<GameObject>): boolean {
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

export function zoneList<T extends GameState | ReadonlyGameState>(
	state: T,
	zone: Zone,
	owner: PlayerId | "any",
): T["battlefield"] {
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
			return state.stack;
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

export function permanentsInPlay(state: GameState): PermanentObject[];
export function permanentsInPlay(
	state: ReadonlyGameState,
): DeepReadOnly<PermanentObject>[];
export function permanentsInPlay(
	state: ReadonlyGameState,
): DeepReadOnly<PermanentObject>[] {
	return state.battlefield.map((id) => {
		const object = permanent(state, id);
		assert(object.kind === "permanent");
		return object;
	});
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
export interface ContinuousEffect {
	text: string;
	layer: ContinuousEffectLayer;
	functionsIn?: Zone[] | "any";

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
		})) as [PlayerState, PlayerState],
		battlefield: [...state.battlefield],
		stack: [...state.stack],
		stackItems: new Map(
			[...state.stackItems].map(([id, item]) => [
				id,
				structuredClone(item) as AbilityStackItem,
			]),
		),
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
		copyEffect: ev.copyEffect,
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
			return (derived ??= cachedGameView(state, revision));
		},
	};
}

export function readObject(read: ReadContext, id: ObjectId): ObjectSnapshot {
	if (read.state.revision !== read.revision)
		throw new Error("attempted to use a stale ReadContext");
	const snapshot = read.view.objects.get(id);
	if (!snapshot) throw new Error(`no derived view for object ${id}`);
	return snapshot;
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
		controller: controllerOf(object as GameObject),
		zone: object.zone,
		counters: object.kind === "permanent" ? { ...object.counters } : {},
		tapped: object.kind === "permanent" ? object.tapped : false,
		power: "power" in characteristics ? characteristics.power : 0,
		toughness: "toughness" in characteristics ? characteristics.toughness : 0,
	};
}

function flattenSnapshot(snapshot: ObjectSnapshot): PermanentView {
	if (snapshot.kind === "ability") {
		throw new Error("ability snapshots have no characteristics");
	}
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

const EMPTY_ABILITY_REFERENCES: DeepReadOnly<AbilityReferences> = {
	static: [],
	activated: [],
	triggered: [],
	replacement: [],
	prohibition: [],
};

/**
 * Registry references an object currently has, or an empty set for objects with
 * no characteristics (abilities on the stack).
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
	if (!snapshot || snapshot.kind === "ability") return EMPTY_ABILITY_REFERENCES;
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
		for (const abilityId of baseCharacteristics(object).abilities.static) {
			if (predicate(resolveStaticAbility(abilityId))) return true;
		}
	}
	return false;
}

/** Effect-label name for logs, taken from the view rather than re-derived. */
function viewName(
	view: GameView,
	state: ReadonlyGameState,
	id: ObjectId,
): string {
	const snapshot = view.objects.get(id);
	return snapshot && snapshot.kind !== "ability"
		? snapshot.currentCharacteristics.name
		: name(state, id);
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
		def: resolveReplacementAbility(id),
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
	return ev.copyEffect
		? ev.copyEffect.abilities.replacement
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
					? state.stack
					: state.players.flatMap((p) => zoneList(state, zone, p.id));

		for (const id of ids) {
			// The object this event is putting onto the battlefield is collected
			// below instead, from what it would have rather than what it has.
			if (id === entering) continue;
			const o = maybeObject(state, id);
			if (!o) continue;
			for (const { id: abilityId, def } of replacementsOf(view, o)) {
				if (!functionsHere(def.functionsIn, zone)) continue;
				const data: Record<string, number> | undefined =
					o.effectData[abilityId];
				assertDefined(data, `effect data was not prepared for ${abilityId}`);
				out.push({
					id: `${o.id}:${abilityId}` as EffectId,
					def,
					source: o,
					controller: controllerOf(o) ?? o.owner,
					data,
					label: `${viewName(view, state, o.id)}#${o.id} — ${def.text}`,
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
			const displayName = ev.copyEffect?.name ?? viewName(view, state, o.id);
			for (const abilityId of incomingReplacementRefs(view, o, ev)) {
				const def = resolveReplacementAbility(abilityId);
				if (!functionsHere(def.functionsIn, "battlefield")) continue;
				out.push({
					id: `${o.id}:${abilityId}` as EffectId,
					def,
					source: o,
					// CR 616.1b has already settled who it enters under.
					controller: ev.toController,
					data: effectDataFor(o, abilityId),
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
 * "The affected object's controller (or its owner if it has no controller) or the
 * affected player chooses one to apply."
 */
export function affectedPlayer(
	state: ReadonlyGameState,
	ev: GameEvent,
): PlayerId {
	switch (ev.kind) {
		case "draw":
		case "mill":
		case "discard":
		case "begin turn":
		case "begin step":
		case "begin phase":
		case "gain life":
		case "lose life":
			return ev.player;
		case "declare attackers":
		case "declare blockers":
			return ev.player;

		case "damage":
			return ev.target.type === "player"
				? ev.target.player
				: (maybePermanent(state, ev.target.id)?.controller ??
						ev.sourceController);

		case "destroy":
		case "regenerate":
			return maybePermanent(state, ev.object)?.controller ?? 0;
		case "tap":
		case "untap":
			if (ev.ref.kind === "all") return state.activePlayer;
			return maybePermanent(state, ev.ref.object)?.controller ?? 0;

		case "add counters":
			return ev.target.type === "player"
				? ev.target.player
				: (maybePermanent(state, ev.target.id)?.controller ?? 0);

		case "remove counters":
			return ev.target.type === "player"
				? ev.target.player
				: (maybePermanent(state, ev.target.id)?.controller ?? 0);

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
			...abilityReferencesOf(read.view, object).prohibition.map(
				resolveProhibitionAbility,
			),
		];
		for (const def of definitions) {
			if (!functionsHere(def.functionsIn, object.zone)) continue;
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
				label: `${viewName(read.view, read.state, object.id)}#${object.id} — ${def.text}`,
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
		if (produced.length === 1 && produced[0]?.kind === current.kind) {
			current = produced[0]!;
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
		copyEffect?: CharacteristicsSnapshot;
		toBottom?: boolean;
	},
): ObjectId {
	const old = maybeObject(state, id);
	assert(old, `cannot move missing object ${id}`);
	assert(
		old.zone === from,
		`cannot move object ${id} from ${from}: it is in ${old.zone}`,
	);
	const src = zoneList(state, from, old.owner) as ObjectId[];
	const index = src.indexOf(id);
	assert(index !== -1, `object ${id} is missing from its ${from} zone list`);
	src.splice(index, 1);
	state.objects.delete(id);
	if (from === "stack") state.stackItems.delete(id);

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
		assert(
			printedId || tokenValues,
			"moved object has no card identity or token values",
		);
		fresh = {
			kind: "permanent",
			id: freshId,
			owner: old.owner,
			controller: opts.toController,
			zone: "battlefield",
			representation: tokenValues
				? {
						kind: "token",
						createdValues: tokenValues,
					}
				: { kind: "card", cardId: printedId! },
			...(opts.copyEffect
				? { copyEffect: cloneCharacteristics(opts.copyEffect) }
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
			choices: undefined as never,
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
	const dst = zoneList(state, to, fresh.owner) as ObjectId[];
	if (to === "library" && opts.toBottom) dst.unshift(fresh.id);
	else dst.push(fresh.id);
	log(
		state,
		`  ${initialCharacteristics(fresh).name}#${fresh.id} is now in ${to}`,
	);
	return fresh.id;
}

/** Convenience for logs/tests. */
export function describeEvent(state: ReadonlyGameState, ev: GameEvent): string {
	switch (ev.kind) {
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
				ev.copyEffect ? `copyOf=${ev.copyEffect.name}` : "",
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
			if (!isTokenObject(o) || o.zone === "battlefield") continue;
			const zone = zoneList(state, o.zone, o.owner);
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

		const hasCharacteristicChangingStatic = anyPossessedStatic(
			state,
			(effect) => CHARACTERISTIC_CHANGING_LAYERS.includes(effect.layer),
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
			let subjects: DeepReadOnly<GameObject>[];
			if (ev.ref.kind === "object") {
				const subject = maybeObject(read.state, ev.ref.object);
				subjects = subject ? [subject] : [];
			} else {
				const player = ev.ref.player;
				subjects = permanentsInPlay(read.state).filter(
					(object) => object.controller === player,
				);
			}
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
): void {
	for (const abilitySource of state.objects.values()) {
		const snapshot = read.view.objects.get(abilitySource.id);
		if (!snapshot || snapshot.kind === "ability") continue;
		for (const triggerId of snapshot.currentCharacteristics.abilities
			.triggered) {
			const trigger = resolveTriggeredAbility(triggerId);
			const functionsIn = trigger.functionsIn ?? ["battlefield"];
			if (!functionsIn.includes(abilitySource.zone)) continue;
			if (triggerMatches(read, abilitySource, trigger.condition, ev, created)) {
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
	const childResults: PerformResult[] = [];

	switch (ev.kind) {
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
			if (currentStepKind(state) === "draw" && state.activePlayer === ev.player)
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
			childResults.push(
				performIn(
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
				),
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
				copyEffect: ev.copyEffect,
				toBottom: ev.toBottom,
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
			const p = state.players[ev.player];
			p.life += ev.amount;
			log(state, `${"  ".repeat(depth)}P${ev.player} -> ${p.life} life`);
			break;
		}
		case "lose life": {
			const p = state.players[ev.player];
			p.life -= ev.amount;
			log(state, `${"  ".repeat(depth)}P${ev.player} -> ${p.life} life`);
			break;
		}

		case "tap":
		case "untap": {
			if (ev.ref.kind === "all") {
				const p = state.players[ev.ref.player];
				for (const o of permanentsInPlay(state).filter(
					(o) => o.controller === p.id,
				)) {
					o.tapped = ev.kind === "tap";
				}
			} else {
				const o = maybePermanent(state, ev.ref.object);
				if (!o) {
					happened = false;
					break;
				}
				o.tapped = ev.kind === "tap";
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
			if (
				ev.player !== currentTurn.player ||
				ev.player !== state.activePlayer
			) {
				throw new IllegalAttackDeclarationError(
					`P${ev.player} declared attackers, but P${state.activePlayer} is the active player`,
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
				o.tapped = true;
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
			if (ev.player !== defender || ev.player === state.activePlayer) {
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
			// Atomic commit: either every assignment marks its blocker, or none do.
			for (const { blocker } of ev.blockers) {
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
		detectTriggers(state, createReadContext(state), ev, created);
		if (ev.fact) scope.facts.add(ev.fact);
	}

	return { executed, created };
}

/* ------------------------------------------------------------------ *
 * Priority and the stack
 * ------------------------------------------------------------------ */

function putPendingTriggersOnStack(state: GameState): void {
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
		// TODO: implement putting on stack in upkeep.
		if (state.pendingTriggers.length > 0)
			throw new Error("pending triggers in untap step");
	}
	for (const pending of state.pendingTriggers) {
		const item: AbilityStackItem = {
			id: state.nextObjectId++ as ObjectId,
			kind: "ability",
			...pending,
		};
		state.stackItems.set(item.id, item);
		state.stack.push(item.id);
		log(state, `  [stack] ${item.text}`);
	}
	state.pendingTriggers.length = 0;
}

function resolveTopOfStack(
	state: GameState,
	choices: AnyChoiceController,
): void {
	const id = state.stack.pop();
	if (id === undefined) return;
	const item = state.stackItems.get(id);
	if (!item) throw new Error(`no stack item ${id}`);
	state.stackItems.delete(id);

	log(state, `  [resolve] ${item.text}`);

	/** Share a scope so facts can pass through the complete effect sequence. */
	resolveEffects(state, choices, item, item.effects, newScope());
}

function resolveEffects(
	state: GameState,
	choices: AnyChoiceController,
	item: AbilityStackItem,
	effects: EffectDef[],
	scope: Scope,
): void {
	for (const effect of effects) {
		if (effect.kind === "may") {
			const decider =
				effect.decider === "you"
					? item.controller
					: ((1 - item.controller) as PlayerId);
			if (choices.chooseOptional(state, item, decider))
				resolveEffects(state, choices, item, effect.effects, scope);
			continue;
		}
		performIn(state, effectToEvent(item, effect), choices, scope, 0);
	}
}

function effectToEvent(
	item: AbilityStackItem,
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
			if (effect.amount !== 1)
				throw new Error(
					"drawing multiple cards as one effect is not implemented",
				);
			return { kind: "draw", player: player(effect.player) };
		case "damage":
		case "destroy":
		case "modify-pt":
			throw new Error(`target resolution is not implemented: ${effect.kind}`);
		case "add-mana":
			throw new Error("mana pools are not implemented");
	}
}

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

	if (!pv.types) throw new Error("object has no types");

	for (const type of pv.types) {
		if (type === "instant") {
			assert(pv.types.length === 1, "instant type must be the only type");
			return true;
		}
		if (state.turnScheduler.progress.location.phase.kind !== "main") {
			return false;
		}
		// if it's not your turn:false
		if (state.activePlayer !== player) return false;
		// if stack is not empty: false
		if (state.stack.length !== 0) return false;
	}
	return false;
}

function simpleCanAfford(
	pv: PermanentView,
	state: GameState,
	player: PlayerId,
): boolean {
	if (pv.manaCost === "none") return false;

	if (pv.manaCost === "zero") return true;

	return false;
}

function canCast(
	object: CardObject,
	state: GameState,
	read: ReadContext,
	player: PlayerId,
): boolean {
	// TODO: this is simplified, and only accounts for the basics of casting
	// from hand. it does not account for special cast actions.
	assert(object.owner === player);
	assert(object.zone === "hand");
	assert(object.kind === "card");

	const pv = flattenSnapshot(readObject(read, object.id));

	if (pv.manaCost === "none") return false;

	// basic timing restrictions
	if (!doTimingRestrictionsAllowCast(pv, state, player)) return false;

	// affordability restrictions
	return true;
}

function getCastableSpells(state: GameState, playerId: PlayerId): CastAction[] {
	const castable: CastAction[] = [];
	const read = createReadContext(state);
	for (const objectId of state.players[playerId].hand) {
		const object = state.objects.get(objectId);
		assertDefined(object);
		assert(object.kind === "card");
		if (object && canCast(object, state, read, playerId)) {
			castable.push({ kind: "cast" });
		}
	}
	return castable;
}

function getObservableActions(
	_state: GameState,
	_player: PlayerId,
): PriorityAction[] {
	// Casting and activation are not implemented yet. Do not derive every object
	// view merely to discard the resulting actions in this pass-only engine.
	return [{ kind: "pass" }];
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
	let lastWasPass = false;
	let priority: 0 | 1 = state.activePlayer;

	for (let pass = 0; pass < 64; pass++) {
		checkStateBasedActionsIn(state, choices);
		if (gameOver(state)) return;

		putPendingTriggersOnStack(state);
		// players only get priority in the untap & cleanup steps
		// if something goes on the stack.
		const step = currentStepKind(state);
		if (step === "untap" && state.stack.length === 0) return;

		if (step === "cleanup") {
			if (state.stack.length === 0) return;

			assert(state.turnScheduler.remainingSteps.length === 0);
			const progress = state.turnScheduler.progress;
			assert(progress.kind === "inTurn");
			assert(progress.location.kind === "step");

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

		if (action.kind !== "pass") {
			throw new Error(`priority action "${action.kind}" is not implemented`);
		}
		if (lastWasPass) {
			if (state.stack.length === 0) return;
			resolveTopOfStack(state, choices);
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

/** CR 703 actions, dispatched only after the corresponding step began. */
function performTurnBasedActions(
	state: GameState,
	choices: AnyChoiceController,
	step: StepOccurrence,
): void {
	switch (step.kind) {
		case "untap":
			performIn(
				state,
				{
					kind: "untap",
					ref: { kind: "all", player: state.activePlayer },
				},
				choices,
				newScope(),
				0,
			);
			break;
		case "draw":
			state.players[state.activePlayer].drawnInDrawStep = 0;
			performIn(
				state,
				{ kind: "draw", player: state.activePlayer },
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
					player: state.activePlayer,
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
			const eligible = eligibleAttackers(state, state.activePlayer);
			const attackers = choices.chooseAttackers(
				state,
				state.activePlayer,
				eligible,
			);
			performIn(
				state,
				{
					kind: "declare attackers",
					player: state.activePlayer,
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
			break;
		case "combat damage": {
			// CR 510.2: all combat damage is assigned, then dealt, simultaneously.
			// Blocker declarations are now tracked, but damage assignment to
			// blockers (and trample) is not implemented yet. This step still
			// treats every still-attacking permanent as unblocked and hits the
			// opposing player directly. That is a deliberate deviation from a
			// full combat model, flagged here rather than assumed equivalent.
			// doubling it into a lethal blow — can't change another's amount.
			const defender = (1 - state.activePlayer) as PlayerId;
			const events: DamageEvent[] = [];
			const read = createReadContext(state);
			for (const id of state.battlefield) {
				const o = maybePermanent(state, id);
				if (!o?.attacking) continue;
				const snapshot = readObject(read, id);
				assert(snapshot.kind === "permanent");
				const characteristics = snapshot.currentCharacteristics;
				if (characteristics.kind !== "creature" || characteristics.power <= 0)
					continue;
				events.push({
					kind: "damage",
					source: id,
					sourceController: o.controller,
					sourceColors: characteristics.colors,
					target: { type: "player", player: defender },
					amount: characteristics.power,
					combat: true,
					// The engine has no deathtouch keyword yet; false is correct
					// until one is added.
					deathtouch: false,
					lifelink: characteristics.keywords.includes("lifelink"),
					unpreventable: false,
				});
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
			const defender = (1 - state.activePlayer) as PlayerId;
			const attackers = creaturesControlledBy(
				createReadContext(state),
				state.activePlayer,
			)
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
		const command = scheduler.command;

		switch (command.kind) {
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
					scheduler.command = { kind: "advanceTurn" };
					continue;
				}

				state.activePlayer = turn.player;
				state.players[turn.player].landsPlayed = 0;
				scheduler.remainingSteps = [];
				scheduler.command = { kind: "advancePhase", turn };
				continue;
			}

			case "advancePhase": {
				const { turn } = command;
				const phase = turn.remainingPhases.shift();
				if (!phase) {
					scheduler.remainingSteps = [];
					state.turn++;
					scheduler.command = { kind: "advanceTurn" };
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
					scheduler.command = { kind: "advancePhase", turn };
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
					scheduler.command = { kind: "finishPhase" };
					priority(state, choices);
					return;
				}

				scheduler.remainingSteps = makeSteps(state, phase);
				scheduler.command = { kind: "advanceStep", turn, phase };
				continue;
			}

			case "advanceStep": {
				const { turn, phase } = command;
				const step = scheduler.remainingSteps.shift();
				if (!step) {
					scheduler.command = { kind: "finishPhase" };
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
					scheduler.command = { kind: "advanceStep", turn, phase };
					continue;
				}

				scheduler.progress = {
					kind: "inTurn",
					turn,
					location: { kind: "step", phase, step },
				};
				scheduler.command = { kind: "finishStep" };
				performTurnBasedActions(state, choices, step);
				// Untap has no priority window. Cleanup normally has none, but the
				// priority helper opens one if something triggered.
				priority(state, choices);
				return;
			}

			case "finishStep": {
				const progress = scheduler.progress;
				assert(progress.kind === "inTurn");
				assert(progress.location.kind === "step");
				// CR 703.4q mana emptying belongs here once mana pools exist.
				scheduler.command = {
					kind: "advanceStep",
					turn: progress.turn,
					phase: progress.location.phase,
				};
				continue;
			}

			case "finishPhase": {
				const progress = scheduler.progress;
				assert(progress.kind === "inTurn");
				// CR 703.4q also empties mana at this boundary.
				scheduler.remainingSteps = [];
				scheduler.command = {
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
