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

type Brand<T, K extends string> = T & { readonly __brand: K };

export type PlayerId = 0 | 1;
export type ObjectId = Brand<number, "ObjectId">;

type Zone =
	| "library"
	| "hand"
	| "battlefield"
	| "graveyard"
	| "exile"
	| "stack";
export type Color = "w" | "u" | "b" | "r" | "g";
export type Supertype = "legendary" | "basic" | "snow";

type TurnId = Brand<number, "TurnId">;
type PhaseId = Brand<number, "PhaseId">;
type StepId = Brand<number, "StepId">;

type PhaseKind = "beginning" | "main" | "combat" | "ending";
type MainPhaseRole = "precombat" | "postcombat";
type StepKind =
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
	source: "normal" | "additional";
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

type SchedulerCommand =
	| { kind: "advanceTurn" }
	| { kind: "advancePhase" }
	| { kind: "advanceStep" }
	| { kind: "finishStep" }
	| { kind: "finishPhase" }
	| { kind: "finishTurn" };

interface TurnScheduler {
	/** The next serializable unit of scheduler control flow. */
	command: SchedulerCommand;
	/** Only exceptional turns are queued. The front is taken next. */
	pendingTurns: TurnOccurrence[];
	/** Used to lazily create the next ordinary turn when the queue is empty. */
	nextRegularPlayer: PlayerId;
	currentTurn: TurnOccurrence | null;
	currentPhase: PhaseOccurrence | null;
	currentStep: StepOccurrence | null;
	remainingSteps: StepOccurrence[];
	nextId: number;
}

/** Zones an ability functions in. 'any' == functions from anywhere (CR 113.6). */
type ZoneScope = Zone | "any";

type CardType =
	| "creature"
	| "artifact"
	| "enchantment"
	| "land"
	| "instant"
	| "sorcery"
	| "planeswalker";

/** Compatibility mirror for code that has not yet moved from state.step to the scheduler. */
type Step = StepKind | "main";

type PseudoCounters = "__deathtouched";
export type CounterNames = "+1/+1" | "-1/-1" | "charge" | "poison";
export type CounterBag = Partial<Record<CounterNames | PseudoCounters, number>>;

type EntityRef =
	| { type: "player"; player: PlayerId }
	| { type: "permanent"; id: ObjectId };

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

interface EventCommon {
	/**
	 * Conditional execution ("if you do..."). The event only executes if this fact
	 * was recorded earlier in the same bundle. Keeps events serializable — no closures.
	 */
	guard?: string;
	/** Fact recorded on successful execution, for other events to guard on. */
	fact?: string;
	note?: string;
}

interface DeclareAttackersEvent extends EventCommon {
	kind: "declare attackers";
	player: PlayerId;
	/** The opponent is implicit: this is deliberately a two-player-only engine. */
	attackers: ObjectId[];
}

interface DrawEvent extends EventCommon {
	kind: "draw";
	player: PlayerId;
}

interface DiscardEvent extends EventCommon {
	kind: "discard";
	player: PlayerId;
	cards:
		| {
				kind: "hand-size";
		  }
		| {
				kind: "specific";
				card: ObjectId;
		  }
		| {
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
	/** CR 615.12
	 * "can't be prevented" skips prevention effects but not other replacements.
	 */
	unpreventable: boolean;
}

/** CR 701.8. Distinct from the zone change it produces — that's what regeneration hooks. */
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
	kind: "zoneChange";
	object: ObjectId;
	from: Zone;
	to: Zone;
	cause: MoveCause;
	/** Who it will be controlled by if `to === 'battlefield'`. Drives CR 616.1's chooser. */
	toController: PlayerId;
	// --- fields only meaningful when entering the battlefield (CR 614.1c-d) ---
	entersTapped?: boolean;
	entersWithCounters?: CounterBag;
	/** Copiable-values override; set by copy-tier replacements (CR 616.1c). */
	copyOf?: string;
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
	kind: "addCounters";
	target: EntityRef;
	counter: CounterNames;
	amount: number;
	source?: ObjectId;
}

interface RemoveCountersEvent extends EventCommon {
	kind: "removeCounters";
	target: EntityRef;
	counters: "all" | Partial<Record<CounterNames, number | "all">>;
	source?: ObjectId;
}

interface LifeChangeEvent extends EventCommon {
	kind: "lifeChange";
	player: PlayerId;
	delta: number;
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

/** Lets "skip your draw step" be a replacement effect that returns [] (CR 614.10). */
interface BeginTurnEvent extends EventCommon {
	kind: "beginTurn";
	turnId: TurnId;
	player: PlayerId;
	isExtra: boolean;
}

interface BeginStepEvent extends EventCommon {
	kind: "beginStep";
	turnId?: TurnId;
	phaseId?: PhaseId;
	stepId?: StepId;
	player: PlayerId;
	step: StepKind;
}

interface CreateTokenEvent extends EventCommon {
	kind: "createToken";
	controller: PlayerId;
	cardId: string;
	amount: number;
}

interface LoseGameEvent extends EventCommon {
	kind: "loseGame";
	player: PlayerId;
	reason: string;
}

interface WinGameEvent extends EventCommon {
	kind: "winGame";
	player: PlayerId;
	reason: string;
}

interface BeginPhaseEvent extends EventCommon {
	kind: "beginPhase";
	turnId: TurnId;
	phaseId: PhaseId;
	player: PlayerId;
	phase: PhaseKind;
	mainRole?: MainPhaseRole;
}

export type GameEvent =
	| DeclareAttackersEvent
	| DrawEvent
	| DiscardEvent
	| DamageEvent
	| DestroyEvent
	| RegenerateEvent
	| ZoneChangeEvent
	| AddCountersEvent
	| RemoveCountersEvent
	| LifeChangeEvent
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

/** cards and tokens in the battlefield and other public zones are permanents. */
interface Permanent {
	kind: "permanent";
	id: ObjectId;
	cardId: string;
	owner: PlayerId;
	visibility: [Player0: boolean, Player1: boolean];
	controller: PlayerId;
	zone: "battlefield" | "graveyard" | "exile";
	tapped: boolean;
	counters: CounterBag;
	/** Mutable per-effect scratch space, keyed by effect label. */
	effectData: Record<string, Record<string, number>>;
	/** Damage marked this turn (cleared in cleanup). */
	damage: number;
	attacking: boolean;
	blocking: boolean;
	token: boolean;
}

/** cards that are not in public zones are not permanents. */
interface CardInPlay {
	kind: "card";
	zone: "library" | "hand" | "stack";
	id: ObjectId;
	cardId: string;
	controller: PlayerId;
	owner: PlayerId;
	visibility: [Player0: boolean, Player1: boolean];

	/** Mutable per-effect scratch space, keyed by effect label. */
	effectData: Record<string, Record<string, number>>;
}

type GameObject = Permanent | CardInPlay;

type EffectId = string & { readonly __effect: unique symbol };

function eid(id: string): EffectId {
	return id as EffectId;
}

interface SpellStackItem {
	id: ObjectId;
	kind: "spell";
	card: ObjectId;
	controller: PlayerId;
	effect: EffectId;
}
export interface AbilityStackItem {
	id: ObjectId;
	kind: "ability";
	/** The source may have left the battlefield by the time this resolves. */
	source: ObjectId;
	sourceCardId: string;
	controller: PlayerId;
	triggerId: string;
	text: string;
	optional: boolean;
	effects: AbilityEffect[];
}
type StackItem = SpellStackItem | AbilityStackItem;

export interface PendingTrigger {
	source: ObjectId;
	sourceCardId: string;
	controller: PlayerId;
	triggerId: string;
	text: string;
	optional: boolean;
	effects: AbilityEffect[];
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

	landsPlayed: number;
	lost: boolean;
	won: boolean;
}

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

export interface GameState {
	objects: Map<ObjectId, GameObject>;
	stackItems: Map<ObjectId, StackItem>;
	players: [PlayerState, PlayerState];
	battlefield: ObjectId[];
	stack: ObjectId[];
	/** Trigger occurrences waiting for the next time a player would receive priority. */
	pendingTriggers: PendingTrigger[];
	floating: FloatingEffect[];
	turn: number;
	activePlayer: PlayerId;
	step: Step;
	turnScheduler: TurnScheduler;
	nextObjectId: number;
	/** Monotonic tag source for guard facts (e.g. Chains of Mephistopheles). */
	nextTag: number;
	log: string[];
	rngState: number;
}

/* ------------------------------------------------------------------ *
 * Characteristics (layers-lite)
 * ------------------------------------------------------------------ */

interface PermanentView {
	id: ObjectId | null;
	cardId: string;
	name: string;
	types: CardType[];
	subtypes: string[];
	colors: Color[];
	power: number;
	toughness: number;
	keywords: Keyword[];
	controller: PlayerId;
	owner: PlayerId;
	counters: CounterBag;
	tapped: boolean;
}

interface ContinuousEffect {
	text: string;
	layer: ContinuousEffectLayer;
	/** `source` is the permanent granting the effect */
	applies(view: PermanentView, state: GameState, source: GameObject): boolean;
	modify(view: PermanentView, state: GameState, source: GameObject): void;
}

/* ------------------------------------------------------------------ *
 * Replacement effects
 * ------------------------------------------------------------------ */

/**
 * CR 616.1 application order. Within the first non-empty tier, the affected
 * player chooses which to apply, then the whole check restarts.
 *   'self'    616.1a — self-replacement (the object's own "as it enters", "enters with")
 *   'control' 616.1b — control-changing
 *   'copy'    616.1c — copy effects
 *   'other'   616.1e — everything else (the back-face-up 616.1d tier is not modeled)
 */
export type ReplacementLayer = "self" | "control" | "copy" | "other";

export interface EffectCtx {
	state: GameState;
	/** The object generating the effect; null for floating/rule effects. */
	self: GameObject | null;
	controller: PlayerId;
	/** Mutable per-effect scratch (floating shields). */
	data: Record<string, number>;
	rc: ReplacementRun;
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
	functionsIn?: ZoneScope[];
	/** further scope the rule, after applying functionsIn above. */
	applies(ev: GameEvent, ctx: EffectCtx): boolean;
	replace(ev: GameEvent, ctx: EffectCtx): GameEvent[];
	/** Consume shields / decrement counters here. */
	onApplied?(ev: GameEvent, ctx: EffectCtx): void;
}

/** A ReplacementDef bound to a concrete source. This is what the loop sees. */
export interface BoundReplacement {
	id: EffectId;
	def: ReplacementDef;
	source: GameObject | null;
	controller: PlayerId;
	data: Record<string, number>;
	label: string;
}

/* ------------------------------------------------------------------ *
 * Prohibition effects — CR 614.17
 * ------------------------------------------------------------------ */

export interface ProhibitionCtx {
	state: GameState;
	/** The object generating the effect; null for rule effects. */
	self: GameObject | null;
	controller: PlayerId;
}

/**
 * A static effect saying an event can't happen. Prohibitions aren't replacement
 * effects: in particular, they don't compete with or consume replacement effects.
 */
export interface ProhibitionDef {
	label: string;
	text: string;
	/** @default ['battlefield'] */
	functionsIn?: ZoneScope[];
	applies(ev: GameEvent, ctx: ProhibitionCtx): boolean;
}

export interface BoundProhibition {
	id: EffectId;
	def: ProhibitionDef;
	source: GameObject | null;
	controller: PlayerId;
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
 * Cards
 * ------------------------------------------------------------------ */

export type TriggerCondition =
	| { kind: "beginStep"; step: "upkeep"; player: "controller" }
	| { kind: "entersBattlefield"; object: "self" }
	| { kind: "declaredAttacker"; object: "self" };

export type AbilityEffect = {
	kind: "gainLife";
	player: "controller";
	amount: number;
};

export interface TriggerDef {
	id: string;
	text: string;
	condition: TriggerCondition;
	optional?: boolean;
	effects: AbilityEffect[];
}

export type Keyword = "indestructible" | "lifelink" | "flying";

export interface CardDef {
	id: string;
	name: string;
	supertypes?: Supertype[];
	types: CardType[];
	subtypes?: string[];
	colors: Color[];
	mv: number;
	power?: number;
	toughness?: number;
	keywords?: Keyword[];
	/** Printed "enters tapped" — compiled into a self-replacement (CR 614.1d). */
	entersTapped?: boolean;
	/** Printed "enters with N counters" — also a self-replacement. */
	entersWith?: CounterBag;
	replacements?: ReplacementDef[];
	prohibitions?: ProhibitionDef[];
	statics?: ContinuousEffect[];
	triggers?: TriggerDef[];
	/** STUB: activated abilities and alternate casting costs are not yet processed. */
	activated?: unknown[];
	/** STUB: alternate casting costs such as Plot are not yet processed. */
	plot?: { cost?: string };
}
/**
 * Registry indirection so `state.ts` can read card definitions without importing
 * `cards.ts` (which itself needs state helpers). Card data is populated at import
 * time by cards.ts.
 */
const DB: Record<string, CardDef> = {};

export function registerCard(def: CardDef): CardDef {
	DB[def.id] = def;
	return def;
}

function card(id: string): CardDef {
	const def = DB[id];
	if (!def) throw new Error(`unknown card: ${id}`);
	return def;
}

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
		objects: new Map(),
		stackItems: new Map(),
		players: [newPlayerState(0), newPlayerState(1)],
		battlefield: [],
		stack: [],
		pendingTriggers: [],
		floating: [],
		turn: 0,
		activePlayer: 0 as PlayerId,
		step: "untap" as Step,
		turnScheduler: {
			command: { kind: "advanceTurn" },
			pendingTurns: [],
			nextRegularPlayer: 0 as PlayerId,
			currentTurn: null,
			currentPhase: null,
			currentStep: null,
			remainingSteps: [],
			nextId: 0,
		},
		nextObjectId: 0,
		nextTag: 0,
		log: [],
		rngState: 0,
	};
}

export function addFloating(
	state: GameState,
	controller: PlayerId,
	factory: keyof typeof EFFECTS,
	params: Record<string, number | string> = {},
	opts: { expires?: "endOfTurn" | "never"; data?: Record<string, number> } = {},
): void {
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

function defaultVisibility(
	zone: string,
	to: PlayerId,
	owner: PlayerId,
): boolean {
	if (zone === "battlefield") return true;
	if (zone === "hand") return to === owner;
	return false;
}

export function spawnCard(
	state: GameState,
	cardId: string,
	owner: PlayerId,
	zone: "library" | "hand" | "stack",
): CardInPlay {
	const obj: CardInPlay = {
		kind: "card",
		id: state.nextObjectId++ as ObjectId,
		cardId,
		owner,
		controller: owner,
		visibility: [
			defaultVisibility(zone, 0, owner),
			defaultVisibility(zone, 1, owner),
		],
		zone,
		effectData: {},
	};
	state.objects.set(obj.id, obj);
	zoneList(state, zone, owner).push(obj.id);
	return obj;
}

export function spawnPermanent(
	state: GameState,
	cardId: string,
	owner: PlayerId,
	zone: "battlefield" | "graveyard" | "exile",
	opts: { tapped?: boolean; counters?: CounterBag; token?: boolean } = {},
): Permanent {
	const obj: Permanent = {
		kind: "permanent",
		id: state.nextObjectId++ as ObjectId,
		visibility: [
			defaultVisibility(zone, 0, owner),
			defaultVisibility(zone, 1, owner),
		],
		cardId,
		owner,
		controller: owner,
		zone,
		tapped: opts.tapped ?? false,
		counters: { ...opts.counters },
		effectData: {},
		damage: 0,
		attacking: false,
		blocking: false,
		token: opts.token ?? false,
	};
	state.objects.set(obj.id, obj);
	zoneList(state, zone, owner).push(obj.id);
	return obj;
}

/* ------------------------------------------------------------------ *
 * Lookups
 * ------------------------------------------------------------------ */

export function permanent(state: GameState, id: ObjectId): Permanent {
	const o = maybeObject(state, id);
	if (!o) throw new Error(`no object ${id}`);
	assert(o.kind === "permanent");
	return o;
}

export function maybePermanent(
	state: GameState,
	id: ObjectId,
): Permanent | null {
	const o = maybeObject(state, id);
	if (!o) return null;
	assert(o.kind === "permanent");
	return o;
}

export function maybeObject(state: GameState, id: ObjectId): GameObject | null {
	return state.objects.get(id) ?? null;
}

export function zoneList(
	state: GameState,
	zone: Zone,
	owner: PlayerId,
): ObjectId[] {
	switch (zone) {
		case "battlefield":
			return state.battlefield;
		case "stack":
			return state.stack;
		case "library":
			return state.players[owner].library;
		case "hand":
			return state.players[owner].hand;
		case "graveyard":
			return state.players[owner].graveyard;
		case "exile":
			return state.players[owner].exile;
	}
}

export function permanentsInPlay(state: GameState): Permanent[] {
	return state.battlefield.map((id) => {
		const object = permanent(state, id);
		assert(object.kind === "permanent");
		return object;
	});
}

export function creaturesControlledBy(
	state: GameState,
	p: PlayerId,
): GameObject[] {
	return permanentsInPlay(state).filter(
		(o) => o.controller === p && view(state, o.id).types.includes("creature"),
	);
}

/**
 * The single source of truth for who may be declared as an attacker (CR 508.1a,
 * deliberately simplified): a creature controlled by the declaring player,
 * untapped, currently on the battlefield. All creatures are treated as if they
 * have haste, so control duration and summoning sickness are not checked.
 * Battlefield order is preserved.
 */
export function eligibleAttackers(
	state: GameState,
	player: PlayerId,
): ObjectId[] {
	return creaturesControlledBy(state, player)
		.filter((o) => o.kind === "permanent" && !o.tapped)
		.map((o) => o.id);
}

/** Thrown when a "declare attackers" event fails validation. Nothing is
 * mutated: the whole event is rejected atomically. */
export class IllegalAttackDeclarationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "IllegalAttackDeclarationError";
	}
}

export function log(state: GameState, line: string): void {
	state.log.push(line);
}

export function name(state: GameState, id: ObjectId): string {
	const o = maybeObject(state, id);
	return o ? `${card(o.cardId).name}#${o.id}` : `<gone#${id}>`;
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

/* ------------------------------------------------------------------ *
 * Layers-lite
 *
 * This is deliberately a sketch of CR 613: base characteristics, then
 * copy effects, then type/color changers, then P/T setters, then P/T
 * modifiers, then counters. A real implementation needs timestamps and
 * dependency ordering; the shape below is where those hooks go.
 * ------------------------------------------------------------------ */

function baseView(
	state: GameState,
	cardId: string,
	controller: PlayerId,
	owner: PlayerId,
	o: Permanent | null,
): PermanentView {
	const def = card(cardId);
	return {
		id: o?.id ?? null,
		cardId,
		name: def.name,
		types: [...def.types],
		subtypes: [...(def.subtypes ?? [])],
		colors: [...def.colors],
		power: def.power ?? 0,
		toughness: def.toughness ?? 0,
		keywords: [...(def.keywords ?? [])],
		controller,
		owner,
		counters: { ...o?.counters },
		tapped: o?.tapped ?? false,
	};
}

function applyStatics(state: GameState, v: PermanentView): PermanentView {
	const effects: Partial<
		Record<
			ContinuousEffectLayer,
			[source: Permanent, effect: ContinuousEffect][]
		>
	> = {};
	// Layer 4-7ish: continuous effects from permanents already on the battlefield.
	for (const source of permanentsInPlay(state)) {
		for (const staticModifier of card(source.cardId).statics ?? []) {
			const arr = effects[staticModifier.layer] ?? [];
			effects[staticModifier.layer] = arr;
			arr.push([source, staticModifier]);
		}
	}

	for (const layer of CONTINUOUS_EFFECT_LAYERS) {
		if (!effects[layer]) continue;
		for (const [source, effect] of effects[layer]) {
			if (!effect.applies(v, state, source)) continue;
			effect.modify(v, state, source);
		}
	}

	// Layer 7d: counters.
	const plus = v.counters["+1/+1"] ?? 0;
	const minus = v.counters["-1/-1"] ?? 0;
	v.power += plus - minus;
	v.toughness += plus - minus;
	return v;
}

/** Current characteristics of an object that exists. */
export function view(state: GameState, id: ObjectId): PermanentView {
	const o = permanent(state, id);
	return applyStatics(
		state,
		baseView(state, o.cardId, o.controller, o.owner, o),
	);
}
/**
 * CR 614.12: replacement effects that modify how a permanent enters check the
 * characteristics it *would have* on the battlefield, with continuous effects
 * already applied. So Root Maze ("artifacts and lands enter tapped") has to see
 * a card that Mycosynth Wellspring has turned into an artifact.
 */
export function etbPreview(
	state: GameState,
	ev: ZoneChangeEvent,
): PermanentView {
	const o = maybeObject(state, ev.object);
	const cardId = ev.copyOf ?? o?.cardId ?? "";
	const owner = o?.owner ?? ev.toController;
	const v = baseView(state, cardId, ev.toController, owner, null);
	v.id = ev.object;
	v.counters = { ...ev.entersWithCounters };
	v.tapped = ev.entersTapped ?? false;
	return applyStatics(state, v);
}

export function lethalDamage(state: GameState, id: ObjectId): boolean {
	const o = permanent(state, id);
	const v = view(state, id);
	return (
		v.types.includes("creature") && v.toughness > 0 && o.damage >= v.toughness
	);
}

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

/* ------------------------------------------------------------------ *
 * 1. Which effects exist right now?
 * ------------------------------------------------------------------ */

const ALL_ZONES: Zone[] = [
	"library",
	"hand",
	"battlefield",
	"graveyard",
	"exile",
	"stack",
];

function functionsHere(scopes: ZoneScope[] | undefined, zone: Zone): boolean {
	const s = scopes ?? ["battlefield"];
	return s.includes("any") || s.includes(zone);
}

/**
 * Printed "enters tapped" / "enters with N counters" are self-replacement effects
 * (CR 614.1c-d) that live on the card itself and function from wherever it's moving
 * from. Compiling them here rather than hand-writing them per card keeps the
 * self tier honest and automatic.
 */
function synthesizedProhibitions(
	state: GameState,
	o: GameObject,
): ProhibitionDef[] {
	if (
		o.kind !== "permanent" ||
		o.zone !== "battlefield" ||
		!view(state, o.id).keywords.includes("indestructible")
	) {
		return [];
	}

	return [
		{
			label: "keyword:indestructible",
			text: "This permanent can't be destroyed.",
			applies: (ev, ctx) => ev.kind === "destroy" && ev.object === ctx.self?.id,
		},
	];
}

function synthesizedSelfReplacements(o: GameObject): ReplacementDef[] {
	// These are generated unconditionally and resolve the *effective* card inside
	// applies(), because a copy-tier effect (CR 616.1c) can have already rewritten
	// what this permanent is going to be by the time the self tier runs again.
	// Reading `card(o.cardId)` here instead would silently drop the printed ETB
	// modifiers of whatever a Clone chose to copy.
	const effective = (ev: GameEvent, self: GameObject | null) => {
		if (ev.kind !== "zoneChange") return null;
		return card(ev.copyOf ?? self?.cardId ?? o.cardId);
	};

	return [
		{
			label: "printed:entersTapped",
			text: `${card(o.cardId).name}: printed "enters tapped"`,
			layer: "self",
			functionsIn: ["any"],
			applies(ev, ctx) {
				if (ev.kind !== "zoneChange" || ev.to !== "battlefield") return false;
				if (ev.object !== ctx.self?.id || ev.entersTapped === true)
					return false;
				return effective(ev, ctx.self)?.entersTapped === true;
			},
			replace: (ev) =>
				ev.kind === "zoneChange" ? [{ ...ev, entersTapped: true }] : [ev],
		},
		{
			label: "printed:entersWith",
			text: `${card(o.cardId).name}: printed "enters with counters"`,
			layer: "self",
			functionsIn: ["any"],
			applies(ev, ctx) {
				if (ev.kind !== "zoneChange" || ev.to !== "battlefield") return false;
				if (ev.object !== ctx.self?.id || ev.entersWithCounters !== undefined)
					return false;
				return effective(ev, ctx.self)?.entersWith !== undefined;
			},
			replace(ev, ctx) {
				if (ev.kind !== "zoneChange") return [ev];
				const counters = effective(ev, ctx.self)?.entersWith ?? {};
				return [{ ...ev, entersWithCounters: { ...counters } }];
			},
		},
	];
}

/**
 * The registry is recomputed on every pass rather than cached, because applying
 * one replacement can add or remove sources mid-chain. Cache it later behind a
 * dirty flag if profiling says so — correctness first.
 */
export function collectProhibitions(state: GameState): BoundProhibition[] {
	const out: BoundProhibition[] = [];

	for (const zone of ALL_ZONES) {
		const ids =
			zone === "battlefield"
				? state.battlefield
				: zone === "stack"
					? state.stack
					: state.players.flatMap((p) => zoneList(state, zone, p.id));

		for (const id of ids) {
			const o = maybeObject(state, id);
			if (!o) continue;
			const defs = [
				...synthesizedProhibitions(state, o),
				...(card(o.cardId).prohibitions ?? []),
			];
			for (const def of defs) {
				if (!functionsHere(def.functionsIn, zone)) continue;
				out.push({
					id: `${o.id}:${def.label}` as EffectId,
					def,
					source: o,
					controller: o.controller,
					label: `${card(o.cardId).name}#${o.id} — ${def.text}`,
				});
			}
		}
	}

	return out;
}

function prohibitionsFor(
	state: GameState,
	event: GameEvent,
): BoundProhibition[] {
	return collectProhibitions(state).filter((p) =>
		p.def.applies(event, {
			state,
			self: p.source,
			controller: p.controller,
		}),
	);
}

/** Whether a static "can't" effect prohibits this event (CR 614.17). */
export function canEventHappen(state: GameState, event: GameEvent): boolean {
	return prohibitionsFor(state, event).length === 0;
}

export function collectReplacements(state: GameState): BoundReplacement[] {
	const out: BoundReplacement[] = [];

	for (const zone of ALL_ZONES) {
		const ids =
			zone === "battlefield"
				? state.battlefield
				: zone === "stack"
					? state.stack
					: state.players.flatMap((p) => zoneList(state, zone, p.id));

		for (const id of ids) {
			const o = maybeObject(state, id);
			if (!o) continue;
			const defs = [
				...synthesizedSelfReplacements(o),
				...(card(o.cardId).replacements ?? []),
			];
			for (const def of defs) {
				if (!functionsHere(def.functionsIn, zone)) continue;
				const key = def.label;
				if (!o.effectData[key]) o.effectData[key] = {};
				out.push({
					id: `${o.id}:${key}` as EffectId,
					def,
					source: o,
					controller: o.controller,
					data: o.effectData[key],
					label: `${card(o.cardId).name}#${o.id} — ${def.text}`,
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
 * 2. Who chooses? (CR 616.1)
 * ------------------------------------------------------------------ */

/**
 * "The affected object's controller (or its owner if it has no controller) or the
 * affected player chooses one to apply."
 */
export function affectedPlayer(state: GameState, ev: GameEvent): PlayerId {
	switch (ev.kind) {
		case "draw":
		case "discard":
		case "beginTurn":
		case "beginStep":
		case "beginPhase":
		case "lifeChange":
			return ev.player;
		case "declare attackers":
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

		case "addCounters":
			return ev.target.type === "player"
				? ev.target.player
				: (maybePermanent(state, ev.target.id)?.controller ?? 0);

		case "removeCounters":
			return ev.target.type === "player"
				? ev.target.player
				: (maybePermanent(state, ev.target.id)?.controller ?? 0);

		case "createToken":
			return ev.controller;

		case "loseGame":
		case "winGame":
			return ev.player;

		case "zoneChange": {
			const o = maybeObject(state, ev.object);
			if (!o) return ev.toController;
			// Objects on the battlefield / stack have a controller; cards elsewhere
			// don't, so their owner chooses. For a card entering the battlefield we
			// use the would-be controller, which is what players expect at the table.
			if (ev.from === "battlefield" || ev.from === "stack") return o.controller;
			if (ev.to === "battlefield") return ev.toController;
			return o.owner;
		}
		default:
			assertNever(ev);
	}
}

/* ------------------------------------------------------------------ *
 * 3. The loop
 * ------------------------------------------------------------------ */

const LAYER_ORDER: ReplacementLayer[] = [
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
];

function ctxFor(
	state: GameState,
	r: BoundReplacement,
	run: ReplacementRun,
): EffectCtx {
	return {
		state,
		self: r.source,
		controller: r.controller,
		data: r.data,
		rc: run,
	};
}

function applicable(
	state: GameState,
	ev: GameEvent,
	run: ReplacementRun,
): BoundReplacement[] {
	return collectReplacements(state).filter((r) => {
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
		return r.def.applies(ev, ctxFor(state, r, run));
	});
}

export function newRun(): ReplacementRun {
	return { applied: new Set(), depth: 0 };
}

/* ------------------------------------------------------------------ *
 * Replacements
 * ------------------------------------------------------------------ */

const MAX_REPLACEMENT_EFFECT_RECURSION_DEPTH = 64;
const MAX_REPLACEMENT_EFFECT_CHOICES = 64;

/**
 * Runs an event through the replacement pipeline and returns the event(s) that
 * actually happen. May return [] (fully replaced by nothing, e.g. "skip your
 * draw step" or full damage prevention).
 */
function resolveReplacements(
	state: GameState,
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
		/**
		 * CR 614.17c: if an event can't happen, only a self-replacement gets an
		 * opportunity to change it. Other replacement/prevention effects don't
		 * apply, so (for example) indestructible doesn't consume regeneration.
		 */
		const prohibitions = prohibitionsFor(state, current);
		const allCandidates = applicable(state, current, run);
		const candidates =
			prohibitions.length === 0
				? allCandidates
				: allCandidates.filter((candidate) => candidate.def.layer === "self");
		if (candidates.length === 0) {
			for (const prohibition of prohibitions) {
				log(state, `  [prohibit] ${prohibition.label}`);
			}
			return prohibitions.length === 0 ? [current] : [];
		}

		/** find the highest priority tier that has at least one candidate. */
		const tier = LAYER_ORDER.find((l) =>
			candidates.some((c) => c.def.layer === l),
		);
		assert(tier, "no tier found");

		const tiered = candidates.filter((c) => c.def.layer === tier);

		const chooser = affectedPlayer(state, current);

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
					choices.chooseReplacement(state, chooser, current, tiered);

		assertDefined(chosen);
		run.applied.add(chosen.id);
		const ctx = ctxFor(state, chosen, run);
		const produced = chosen.def.replace(current, ctx);
		chosen.def.onApplied?.(current, ctx);

		log(
			state,
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
			resolveReplacements(state, e, choices, {
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
		counters?: Record<string, number>;
		copyOf?: string;
		toBottom?: boolean;
	},
): ObjectId | null {
	const o = maybeObject(state, id);
	if (!o || o.zone !== from) return null;

	const src = zoneList(state, from, o.owner);
	const idx = src.indexOf(id);
	if (idx === -1) return null;
	src.splice(idx, 1);
	state.objects.delete(id);

	// Tokens cease to exist when they leave the battlefield (CR 111.7).
	// TODO: this probably manifests as a bug. tokens can be put into zones, they
	// disappear due to SBA.
	// For example, a token is still put into graveyard
	if (o.kind === "permanent" && o.token && from === "battlefield") {
		log(state, `  ${card(o.cardId).name}#${id} (token) ceases to exist`);
		return null;
	}
	let fresh: GameObject;

	switch (to) {
		case "library":
		case "hand":
		case "stack":
			{
				fresh = {
					kind: "card",
					zone: to,
					id: state.nextObjectId++ as ObjectId,
					cardId: opts.copyOf ?? o.cardId,
					owner: o.owner,
					controller: o.owner,
					visibility: [
						defaultVisibility(to, 0, o.owner),
						defaultVisibility(to, 1, o.owner),
					],
					effectData: {},
				} satisfies CardInPlay;
				state.objects.set(fresh.id, fresh);
			}

			break;
		case "battlefield":
		case "graveyard":
		case "exile": {
			fresh = {
				kind: "permanent",
				id: state.nextObjectId++ as ObjectId,
				cardId: opts.copyOf ?? o.cardId,
				owner: o.owner,
				controller: to === "battlefield" ? opts.toController : o.owner,
				visibility: [
					defaultVisibility(to, 0, o.owner),
					defaultVisibility(to, 1, o.owner),
				],
				zone: to,
				tapped: to === "battlefield" ? (opts.tapped ?? false) : false,
				counters: to === "battlefield" ? { ...opts.counters } : {},
				effectData: {},
				damage: 0,
				attacking: false,
				blocking: false,
				token: false,
			} satisfies Permanent;
			state.objects.set(fresh.id, fresh);
		}
	}

	const dst = zoneList(state, to, fresh.owner);
	if (to === "library" && !opts.toBottom) dst.push(fresh.id);
	else if (to === "library") dst.unshift(fresh.id);
	else dst.push(fresh.id);

	if (fresh.kind === "permanent") {
		log(
			state,
			`  ${card(fresh.cardId).name}#${fresh.id} is now in ${to}` +
				(fresh.tapped ? " (tapped)" : "") +
				(Object.keys(fresh.counters).length
					? ` with ${JSON.stringify(fresh.counters)}`
					: ""),
		);
	}
	return fresh.id;
}

/** Convenience for logs/tests. */
export function describeEvent(state: GameState, ev: GameEvent): string {
	switch (ev.kind) {
		case "draw":
			return `draw(P${ev.player})`;
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
		case "zoneChange": {
			const extras = [
				ev.entersTapped ? "tapped" : "",
				ev.entersWithCounters ? JSON.stringify(ev.entersWithCounters) : "",
				ev.copyOf ? `copyOf=${ev.copyOf}` : "",
			]
				.filter(Boolean)
				.join(" ");
			return `move(${name(state, ev.object)}: ${ev.from}->${ev.to}${extras ? ` ${extras}` : ""})`;
		}
		case "addCounters": {
			const tgt =
				ev.target.type === "player"
					? `P${ev.target.player}`
					: name(state, ev.target.id);
			return `counters(${ev.amount}x ${ev.counter} on ${tgt})`;
		}
		case "removeCounters": {
			const tgt =
				ev.target.type === "player"
					? `P${ev.target.player}`
					: name(state, ev.target.id);
			if (ev.counters === "all") return `counters(rm all on ${tgt})`;
			return `counters(rm ${Object.entries(ev.counters)
				.map(([k, v]) => `${v}x ${k}`)
				.join(",")} on ${tgt})`;
		}
		case "lifeChange":
			return `life(P${ev.player} ${ev.delta >= 0 ? "+" : ""}${ev.delta})`;
		case "tap":
			if (ev.ref.kind === "all") return `tap(all P${ev.ref.player})`;
			return `tap(${name(state, ev.ref.object)})`;
		case "untap":
			if (ev.ref.kind === "all") return `untap(all P${ev.ref.player})`;
			return `untap(${name(state, ev.ref.object)})`;
		case "beginTurn":
			return `beginTurn(P${ev.player}, #${ev.turnId}${ev.isExtra ? ", extra" : ""})`;
		case "beginStep":
			return `beginStep(P${ev.player}, ${ev.step})`;
		case "beginPhase":
			return `beginPhase(P${ev.player}, ${ev.phase})`;
		case "createToken":
			return `token(${ev.amount}x ${ev.cardId} for P${ev.controller})`;
		case "loseGame":
			return `loseGame(P${ev.player}: ${ev.reason})`;
		case "declare attackers":
			return ev.attackers.length === 0
				? `declareAttackers(P${ev.player}, none)`
				: `declareAttackers(P${ev.player}, ${ev.attackers.map((id) => name(state, id)).join(", ")})`;
		case "winGame":
			return `winGame(P${ev.player}: ${ev.reason})`;
	}
}

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
					{ kind: "loseGame", player: p.id, reason: "life" },
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
						kind: "loseGame",
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
			if (p.counters["poison"] !== undefined && p.counters["poison"] >= 10) {
				performIn(
					state,
					{
						kind: "loseGame",
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

		for (const id of state.battlefield) {
			const o = permanent(state, id);
			const v = view(state, id);
			if (!v.types.includes("creature")) continue;

			// 704.5f. If a creature has toughness 0 or less, it's put into its
			// owner's graveyard. Regeneration can't replace this event.
			if (v.toughness <= 0) {
				log(state, `  SBA: ${name(state, id)} has toughness ${v.toughness}`);
				performIn(
					state,
					{
						kind: "zoneChange",
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
				continue;
			}
			// 704.5g. If a creature has toughness greater than 0, it has damage marked
			// on it, and the total damage marked on it is greater than or equal to its
			// toughness, that creature has been dealt lethal damage and is destroyed.
			// Regeneration can replace this event.
			if (lethalDamage(state, id) || o.counters.__deathtouched) {
				const destroy: DestroyEvent = {
					kind: "destroy",
					object: id,
					noRegen: false,
				};
				// CR 702.12b: an indestructible permanent ignores these SBAs. Ask the
				// generic prohibition system rather than special-casing the keyword.
				if (canEventHappen(state, destroy)) {
					log(state, `  SBA: ${name(state, id)} has lethal damage`);
					performIn(state, destroy, choices, newScope(), 0);
					acted = true;
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
						kind: "removeCounters",
						target: { type: "permanent", id: id },
						counters: { "+1/+1": n, "-1/-1": n },
					},
					choices,
					newScope(),
					0,
				);
				acted = true;
			}
		}

		if (!acted) return;
	}
	throw new Error("SBA loop did not stabilize");
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
	const finals = resolveReplacements(state, event, choices);
	if (finals.length === 0)
		log(state, `${"  ".repeat(depth + 1)}(replaced by nothing)`);
	const executed: GameEvent[] = [];
	const created: ObjectId[] = [];
	for (const ev of finals) {
		const result = executeIn(state, ev, choices, scope, depth + 1);
		executed.push(...result.executed);
		created.push(...result.created);
	}
	return { executed, created };
}

/**
 * adds a trigger to state.pendingTriggers
 */
function enqueueTrigger(
	state: GameState,
	source: GameObject,
	trigger: TriggerDef,
): void {
	state.pendingTriggers.push({
		source: source.id,
		sourceCardId: source.cardId,
		controller: source.controller,
		triggerId: trigger.id,
		text: trigger.text,
		optional: trigger.optional ?? false,
		effects: trigger.effects.map((effect) => ({ ...effect })),
	});
	log(
		state,
		`  [trigger] ${card(source.cardId).name}#${source.id} — ${trigger.text}`,
	);
}

/** Observe events only after they successfully execute and all replacements are final. */
function detectTriggers(
	state: GameState,
	ev: GameEvent,
	created: ObjectId[],
): void {
	if (ev.kind === "beginStep") {
		// Snapshot the battlefield: trigger detection itself must not be affected by
		// later stack resolution or zone changes.
		for (const source of permanentsInPlay(state)) {
			for (const trigger of card(source.cardId).triggers ?? []) {
				const condition = trigger.condition;
				if (
					condition.kind === "beginStep" &&
					condition.step === ev.step &&
					ev.player === source.controller
				) {
					enqueueTrigger(state, source, trigger);
				}
			}
		}
		return;
	}

	if (ev.kind === "zoneChange" && ev.to === "battlefield") {
		// Zone changes create a new object (CR 400.7), so inspect the resulting ID,
		// not ev.object, which identifies the object in its previous zone.
		for (const id of created) {
			const source = maybePermanent(state, id);
			if (source?.zone !== "battlefield") continue;
			for (const trigger of card(source.cardId).triggers ?? []) {
				if (trigger.condition.kind === "entersBattlefield") {
					enqueueTrigger(state, source, trigger);
				}
			}
		}
		return;
	}

	if (ev.kind === "declare attackers") {
		// Only the IDs that were actually declared (and are still around) trigger.
		// A rejected or empty declaration never reaches this point with attackers.
		for (const id of ev.attackers) {
			const source = maybePermanent(state, id);
			if (source?.zone !== "battlefield") continue;
			for (const trigger of card(source.cardId).triggers ?? []) {
				if (trigger.condition.kind === "declaredAttacker") {
					enqueueTrigger(state, source, trigger);
				}
			}
		}
	}
}

/**
 * after applying effects, executes the event.
 * When new states result, feed them back to `perform`
 * (so that new effects get applied.)
 */
function executeIn(
	state: GameState,
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
			if (state.step === "draw" && state.activePlayer === ev.player)
				p.drawnInDrawStep++;
			// Drawing *is* a zone change, so zone-change replacements get a look too.
			childResults.push(
				performIn(
					state,
					{
						kind: "zoneChange",
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
								kind: "zoneChange",
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
						kind: "zoneChange",
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
				if (ev.deathtouch) o.counters.__deathtouched = 1;
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
							kind: "lifeChange",
							player: ev.sourceController,
							delta: ev.amount,
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
			const pv = view(state, o.id);
			childResults.push(
				performIn(
					state,
					{
						kind: "zoneChange",
						object: o.id,
						from: "battlefield",
						to: "graveyard",
						cause: "destroy",
						toController: pv.controller,
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
			delete o.counters.__deathtouched;
			log(
				state,
				`${"  ".repeat(depth)}${name(state, o.id)} regenerates (tapped, damage removed, out of combat)`,
			);
			break;
		}

		case "zoneChange": {
			const newId = moveObject(state, ev.object, ev.from, ev.to, {
				toController: ev.toController,
				tapped: ev.entersTapped,
				counters: ev.entersWithCounters,
				copyOf: ev.copyOf,
				toBottom: ev.toBottom,
			});
			if (newId === null) {
				happened = false;
			} else {
				created.push(newId);
			}
			break;
		}

		case "addCounters": {
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
		case "removeCounters": {
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

		case "lifeChange": {
			const p = state.players[ev.player];
			p.life += ev.delta;
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
		case "beginTurn":
		case "beginPhase":
			// Structural continuation belongs to the turn scheduler. These events only
			// record that the replaceable boundary successfully happened.
			break;

		case "beginStep":
			// Turn-based actions (untap, normal draw, combat declarations, etc.)
			// run only after the scheduler confirms this exact boundary executed.
			state.step = ev.step;
			break;

		case "createToken": {
			for (let i = 0; i < ev.amount; i++) {
				const t: GameObject = {
					kind: "permanent",
					id: state.nextObjectId++ as ObjectId,
					visibility: [true, true],
					cardId: ev.cardId,
					owner: ev.controller,
					controller: ev.controller,
					zone: "battlefield",
					tapped: false,
					counters: {},
					effectData: {},
					damage: 0,
					attacking: false,
					blocking: false,
					token: true,
				};
				state.objects.set(t.id, t);
				state.battlefield.push(t.id);
				created.push(t.id);
				log(state, `${"  ".repeat(depth)}created ${name(state, t.id)}`);
			}
			break;
		}

		case "declare attackers": {
			// The trustworthy boundary is the turn scheduler's own record of what step
			// is genuinely in progress, not the mutable state.step mirror alone: a
			// declare-attackers occurrence must exist, and it must belong to the
			// scheduler's current turn. state.step is kept only as an additional
			// mirror check, never the sole boundary.
			const scheduler = state.turnScheduler;
			const currentStep = scheduler.currentStep;
			const currentTurn = scheduler.currentTurn;
			if (
				currentStep?.kind !== "declare attackers" ||
				!currentTurn ||
				currentStep.turnId !== currentTurn.id ||
				state.step !== "declare attackers"
			) {
				throw new IllegalAttackDeclarationError(
					`cannot declare attackers outside the declare attackers step (current step: "${state.step}")`,
				);
			}
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

		case "loseGame": {
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

		case "winGame": {
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
		detectTriggers(state, ev, created);
		if (ev.fact) scope.facts.add(ev.fact);
	}

	return { executed, created };
}

function putPendingTriggersOnStack(state: GameState): void {
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
	state.stackItems.delete(id);
	if (!item) throw new Error(`no stack item ${id}`);
	if (item.kind !== "ability") {
		throw new Error("spell resolution is not implemented");
	}

	log(state, `  [resolve] ${item.text}`);
	if (item.optional && !choices.chooseOptional(state, item)) {
		log(state, `    P${item.controller} declined`);
		return;
	}

	for (const effect of item.effects) {
		switch (effect.kind) {
			case "gainLife":
				performIn(
					state,
					{
						kind: "lifeChange",
						player: item.controller,
						delta: effect.amount,
						source: item.source,
					},
					choices,
					newScope(),
					0,
				);
				break;

			default:
				throw new Error(`unsupported effect kind ${effect.kind}`);
		}
	}
}

function _canPlayLand(state: GameState, player: PlayerId): boolean {
	return false;
}

function getObservableActions(
	state: GameState,
	player: PlayerId,
): PriorityAction[] {
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
		const isStepWithNoPriority =
			state.step === "untap" || state.step === "cleanup";
		if (isStepWithNoPriority && state.stack.length === 0) return;

		if (state.step === "cleanup") {
			assert(state.turnScheduler.remainingSteps.length === 0);
			assert(state.turnScheduler.currentPhase !== null);
			assert(state.turnScheduler.currentTurn !== null);

			state.turnScheduler.remainingSteps.push({
				id: nextScheduleId(state) as StepId,
				phaseId: state.turnScheduler.currentPhase.id,
				turnId: state.turnScheduler.currentTurn.id,
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

function nextScheduleId(state: GameState): number {
	return state.turnScheduler.nextId++;
}

function makePhase(
	state: GameState,
	turnId: TurnId,
	kind: PhaseKind,
	source: PhaseOccurrence["source"] = "normal",
): PhaseOccurrence {
	return { id: nextScheduleId(state) as PhaseId, turnId, kind, source };
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
		case "upkeep":
		case "begin combat":
		case "declare blockers":
		case "combat damage":
		case "end":
			// Their turn-based actions are not implemented yet.
			break;
		default:
			assertNever(step.kind);
	}
}

/**
 * Executes one scheduler transition. Scheduler commands are engine control
 * flow, not CR 703 turn-based actions and not replaceable GameEvents.
 *
 * Keeping this boundary smaller than a turn gives async callers a cheap,
 * serializable checkpoint to replay when a choice is not immediately available.
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

	const scheduler = state.turnScheduler;
	let command = scheduler.command;

	switch (command.kind) {
		case "advanceTurn": {
			const turn = takeNextTurn(state);
			const result = performIn(
				state,
				{
					kind: "beginTurn",
					turnId: turn.id,
					player: turn.player,
					isExtra: turn.isExtra,
				},
				choices,
				newScope(),
				0,
			);

			// Selection consumes the occurrence (and advances ordinary turn order),
			// but a skipped turn never becomes the current turn.
			if (
				!result.executed.some(
					(ev) => ev.kind === "beginTurn" && ev.turnId === turn.id,
				)
			) {
				command = { kind: "advanceTurn" };
				break;
			}

			scheduler.currentTurn = turn;
			scheduler.currentPhase = null;
			scheduler.currentStep = null;
			scheduler.remainingSteps = [];
			state.activePlayer = turn.player;
			state.players[turn.player].landsPlayed = 0;
			command = { kind: "advancePhase" };
			break;
		}

		case "advancePhase": {
			const turn = scheduler.currentTurn;
			assertDefined(turn, "cannot advance a phase without a current turn");
			const phase = turn.remainingPhases.shift();
			if (!phase) {
				command = { kind: "finishTurn" };
				break;
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
					kind: "beginPhase",
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

			// The occurrence was consumed even if its boundary was replaced with
			// nothing. Structural progress itself is never replaceable.
			if (
				!result.executed.some(
					(ev) => ev.kind === "beginPhase" && ev.phaseId === phase.id,
				)
			) {
				command = { kind: "advancePhase" };
				break;
			}

			scheduler.currentPhase = phase;
			if (phase.kind === "main") {
				turn.mainPhasesBegun++;
				state.step = "main";
				priority(state, choices);
				command = { kind: "finishPhase" };
			} else {
				scheduler.remainingSteps = makeSteps(state, phase);
				command = { kind: "advanceStep" };
			}
			break;
		}

		case "advanceStep": {
			const turn = scheduler.currentTurn;
			assertDefined(turn, "cannot advance a step without a current turn");
			const step = scheduler.remainingSteps.shift();
			if (!step) {
				command = { kind: "finishPhase" };
				break;
			}

			const result = performIn(
				state,
				{
					kind: "beginStep",
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
					(ev) => ev.kind === "beginStep" && ev.stepId === step.id,
				)
			) {
				command = { kind: "advanceStep" };
				break;
			}

			scheduler.currentStep = step;
			performTurnBasedActions(state, choices, step);
			// Untap has no priority window. Cleanup normally has none, but the
			// existing priority helper already opens one if something triggered.
			priority(state, choices);
			command = { kind: "finishStep" };
			break;
		}

		case "finishStep":
			// CR 703.4q mana emptying belongs here once mana pools exist.
			scheduler.currentStep = null;
			command = { kind: "advanceStep" };
			break;

		case "finishPhase":
			// CR 703.4q also empties mana at this boundary.
			scheduler.currentStep = null;
			scheduler.currentPhase = null;
			scheduler.remainingSteps = [];
			command = { kind: "advancePhase" };
			break;

		case "finishTurn":
			scheduler.currentStep = null;
			scheduler.currentPhase = null;
			scheduler.currentTurn = null;
			scheduler.remainingSteps = [];
			state.turn++;
			command = { kind: "advanceTurn" };
			break;

		default:
			assertNever(command);
	}

	scheduler.command = command;
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

if (import.meta.main) {
	async function run() {
		// Import the card database here so index.ts finishes initializing first;
		// a top-level import would create a circular TDZ because cards.ts calls
		// registerCard during its own initialization.
		await import("./cards.ts");

		const state = newGame();

		// Human plays P0, a random CPU plays P1.
		const agents: SyncAgentPair = [new KeyboardAgent(), new RandomAgent()];

		// Set up a small demo board: each player has Ajani's Mantra so there is an
		// optional upkeep choice every turn, plus libraries so the draw step works.
		spawnPermanent(state, "ajanis-mantra", 0, "battlefield");
		spawnPermanent(state, "ajanis-mantra", 1, "battlefield");
		for (let i = 0; i < 10; i++) spawnCard(state, "forest", 0, "library");
		for (let i = 0; i < 10; i++) spawnCard(state, "forest", 1, "library");
		spawnCard(state, "grizzly-bears", 0, "hand");

		console.log("Welcome to tinymtg! You are Player 0.\n");
		printBoard(state);

		let advanceCount = 0;
		while (true) {
			const startingTurn = state.turn;
			console.log(
				`\n=== Turn ${startingTurn + 1}, Player ${state.activePlayer} (${state.activePlayer === 0 ? "You" : "CPU"}) ===`,
			);
			while (state.turn === startingTurn && !gameOver(state)) {
				advance(state, agents);
			}
			printBoard(state);
			if (gameOver(state)) {
				console.log(`\nGame over! Winner: Player ${winner(state)}`);
				return;
			}
			advanceCount++;
			if (advanceCount >= 10_000) {
				console.log("Max advancement count reached.");
				return;
			}
		}
	}
	run();
}

function dump(state: GameState): void {
	console.log(state.log.map((l) => `    ${l}`).join("\n"));
	state.log.length = 0;
}

function printBoard(state: GameState): void {
	dump(state);
	console.log("Battlefield:");
	if (state.battlefield.length === 0) {
		console.log("  (empty)");
	}
	for (const id of state.battlefield) {
		const o = permanent(state, id);
		const v = view(state, id);
		const info = [
			`P${o.controller}`,
			`${v.name}#${o.id}`,
			v.tapped ? "tapped" : "",
			Object.keys(o.counters).length ? JSON.stringify(o.counters) : "",
		]
			.filter(Boolean)
			.join(" ");
		console.log(`  ${info}`);
	}
	for (const p of state.players) {
		console.log(
			`P${p.id}: life=${p.life} hand=${p.hand.length} library=${p.library.length} graveyard=${p.graveyard.length}`,
		);
	}
}
