import { RandomAgent } from "./agents";
import { assert, assertDefined, assertNever } from "./lib/assert";

export type PlayerId = 0 | 1;
export type ObjectId = number;

type EffectId = string & { readonly __effect: unique symbol };

function eid(id: string): EffectId {
	return id as EffectId;
}

type Zone =
	| "library"
	| "hand"
	| "battlefield"
	| "graveyard"
	| "exile"
	| "stack";
/** Zones an ability functions in. 'any' == functions from anywhere (CR 113.6). */
type ZoneScope = Zone | "any";

export type Color = "w" | "u" | "b" | "r" | "g";

type CardType =
	| "creature"
	| "artifact"
	| "enchantment"
	| "land"
	| "instant"
	| "sorcery"
	| "planeswalker";

type Step =
	| "untap"
	| "upkeep"
	| "draw"
	| "main1"
	| "combat"
	| "main2"
	| "end"
	| "cleanup";
export type CounterBag = Record<string, number>;

type EntityRef =
	| { type: "player"; player: PlayerId }
	| { type: "permanent"; id: ObjectId };

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

interface DrawEvent extends EventCommon {
	kind: "draw";
	player: PlayerId;
}

interface DiscardEvent extends EventCommon {
	kind: "discard";
	player: PlayerId;
	/** undefined = the player chooses */
	object?: ObjectId;
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
	/** CR 615.12 — "can't be prevented" skips prevention effects but not other replacements. */
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

interface AddCountersEvent extends EventCommon {
	kind: "addCounters";
	target: EntityRef;
	counter: string;
	amount: number;
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
	object: ObjectId;
}

/** Lets "skip your draw step" be a replacement effect that returns [] (CR 614.10). */
interface BeginStepEvent extends EventCommon {
	kind: "beginStep";
	player: PlayerId;
	step: Step;
}

interface CreateTokenEvent extends EventCommon {
	kind: "createToken";
	controller: PlayerId;
	cardId: string;
	amount: number;
}

export type GameEvent =
	| DrawEvent
	| DiscardEvent
	| DamageEvent
	| DestroyEvent
	| RegenerateEvent
	| ZoneChangeEvent
	| AddCountersEvent
	| LifeChangeEvent
	| TapEvent
	| BeginStepEvent
	| CreateTokenEvent;

type EventKind = GameEvent["kind"];

/* ------------------------------------------------------------------ *
 * Game state
 * ------------------------------------------------------------------ */

interface GameObject {
	id: ObjectId;
	cardId: string;
	owner: PlayerId;
	visibility: [Player0: boolean, Player1: boolean];
	controller: PlayerId;
	zone: Zone;
	tapped: boolean;
	counters: CounterBag;
	/** Damage marked this turn (cleared in cleanup). */
	damage: number;
	attacking: boolean;
	blocking: boolean;
	token: boolean;
	/** Set while a regeneration shield has been consumed this turn, purely cosmetic. */
	regeneratedThisTurn: boolean;
}

interface PlayerState {
	id: PlayerId;
	life: number;
	library: ObjectId[];
	hand: ObjectId[];
	graveyard: ObjectId[];
	exile: ObjectId[];
	/** Turn-scoped counters, e.g. cards drawn in the draw step (Chains of Mephistopheles). */
	drawnInDrawStep: number;
	lost: boolean;
}

interface FloatingEffect {
	id: EffectId;
	controller: PlayerId;
	expires: "endOfTurn" | "never";
	/** Consumed shields set this; expired effects are swept out of the registry. */
	expired: boolean;
	def: ReplacementDef;
	/** Mutable scratch space for shields ("prevent the next N damage"). */
	data: Record<string, number>;
}

export interface GameState {
	objects: Map<ObjectId, GameObject>;
	players: [PlayerState, PlayerState];
	battlefield: ObjectId[];
	stack: ObjectId[];
	floating: FloatingEffect[];
	turn: number;
	activePlayer: PlayerId;
	step: Step;
	nextObjectId: number;
	/** Set by the zone-change executor: entering a zone creates a *new* object (CR 400.7). */
	lastCreated: ObjectId | null;
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
	keywords: string[];
	controller: PlayerId;
	owner: PlayerId;
	counters: CounterBag;
	tapped: boolean;
}

interface StaticMod {
	text: string;
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
	/** label to  */
	label: string;
	text: string;
	layer: ReplacementLayer;
	/** CR 615 — prevention effects are replacements with an extra "can't be prevented" hook. */
	prevention?: boolean;
	/** Defaults to ['battlefield']. */
	functionsIn?: ZoneScope[];
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

/** Per-original-event bookkeeping. `applied` enforces CR 614.5. */
export interface ReplacementRun {
	applied: Set<EffectId>;
	depth: number;
}

/* ------------------------------------------------------------------ *
 * Cards
 * ------------------------------------------------------------------ */

export interface CardDef {
	id: string;
	name: string;
	types: CardType[];
	subtypes?: string[];
	colors: Color[];
	mv: number;
	power?: number;
	toughness?: number;
	keywords?: string[];
	/** Printed "enters tapped" — compiled into a self-replacement (CR 614.1d). */
	entersTapped?: boolean;
	/** Printed "enters with N counters" — also a self-replacement. */
	entersWith?: CounterBag;
	replacements?: ReplacementDef[];
	statics?: StaticMod[];
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
	lost: false,
});

export function newGame(): GameState {
	return {
		objects: new Map(),
		players: [newPlayerState(0), newPlayerState(1)],
		battlefield: [],
		stack: [],
		floating: [],
		turn: 0,
		activePlayer: 0 as PlayerId,
		step: "untap" as Step,
		nextObjectId: 0,
		lastCreated: null,
		log: [],
		rngState: 0,
	};
}

export function addFloating(
	state: GameState,
	controller: PlayerId,
	def: ReplacementDef,
	opts: { expires?: "endOfTurn" | "never"; data?: Record<string, number> } = {},
): void {
	state.floating.push({
		id: eid(`floating:${state.nextObjectId++}`),
		controller,
		expires: opts.expires ?? "endOfTurn",
		expired: false,
		def,
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

export function spawn(
	state: GameState,
	cardId: string,
	owner: PlayerId,
	zone: Zone,
	opts: { tapped?: boolean; counters?: CounterBag; token?: boolean } = {},
): GameObject {
	const obj: GameObject = {
		id: state.nextObjectId++,
		visibility: [
			defaultVisibility(zone, 0, owner),
			defaultVisibility(zone, 1, owner),
		],
		cardId,
		owner,
		controller: owner,
		zone,
		tapped: opts.tapped ?? false,
		counters: { ...(opts.counters ?? {}) },
		damage: 0,
		attacking: false,
		blocking: false,
		token: opts.token ?? false,
		regeneratedThisTurn: false,
	};
	state.objects.set(obj.id, obj);
	zoneList(state, zone, owner).push(obj.id);
	return obj;
}

/* ------------------------------------------------------------------ *
 * Agents
 * ------------------------------------------------------------------ */

/**
 * Every genuine player choice funnels through here. Note that CR 616.1 ordering
 * is a *real* decision point with real EV consequences (Hardened Scales vs
 * Doubling Season; prevention vs damage doubling), so it belongs in the action
 * space of a learned policy, not buried in engine defaults.
 */
export interface Agent {
	chooseReplacement(
		state: GameState,
		ev: GameEvent,
		options: BoundReplacement[],
	): BoundReplacement;
	chooseDiscard(state: GameState, player: PlayerId, hand: ObjectId[]): ObjectId;
}

/* ------------------------------------------------------------------ *
 * Lookups
 * ------------------------------------------------------------------ */

export function obj(state: GameState, id: ObjectId): GameObject {
	const o = state.objects.get(id);
	if (!o) throw new Error(`no object ${id}`);
	return o;
}

export function maybeObj(state: GameState, id: ObjectId): GameObject | null {
	return state.objects.get(id) ?? null;
}

export function player(state: GameState, id: PlayerId): PlayerState {
	const p = state.players[id];
	if (!p) throw new Error(`no player ${id}`);
	return p;
}

export function opponentsOf(state: GameState, id: PlayerId): PlayerId[] {
	return state.players.filter((p) => p.id !== id).map((p) => p.id);
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
			return player(state, owner).library;
		case "hand":
			return player(state, owner).hand;
		case "graveyard":
			return player(state, owner).graveyard;
		case "exile":
			return player(state, owner).exile;
	}
}

export function battlefieldObjects(state: GameState): GameObject[] {
	return state.battlefield.map((id) => obj(state, id));
}

export function creaturesControlledBy(
	state: GameState,
	p: PlayerId,
): GameObject[] {
	return battlefieldObjects(state).filter(
		(o) => o.controller === p && view(state, o.id).types.includes("creature"),
	);
}

export function log(state: GameState, line: string): void {
	state.log.push(line);
}

export function name(state: GameState, id: ObjectId): string {
	const o = maybeObj(state, id);
	return o ? `${card(o.cardId).name}#${o.id}` : `<gone#${id}>`;
}

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
	o: GameObject | null,
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
		counters: { ...(o?.counters ?? {}) },
		tapped: o?.tapped ?? false,
	};
}

function applyStatics(state: GameState, v: PermanentView): PermanentView {
	// Layer 4-7ish: continuous effects from permanents already on the battlefield.
	for (const src of battlefieldObjects(state)) {
		for (const mod of card(src.cardId).statics ?? []) {
			if (mod.applies(v, state, src)) mod.modify(v, state, src);
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
	const o = obj(state, id);
	return applyStatics(
		state,
		baseView(state, o.cardId, o.controller, o.owner, o),
	);
}
/**
 * CR 614.12: replacement effects that modify how a permanent enters check the
 * characteristics it *would have* on the battlefield, with continuous effects
 * already applied. So Root Maze ("artifacts and lands enter tapped") has to see
 * a card that some other static has turned into an artifact. This is the hook.
 */
export function etbPreview(
	state: GameState,
	ev: ZoneChangeEvent,
): PermanentView {
	const o = maybeObj(state, ev.object);
	const cardId = ev.copyOf ?? o?.cardId ?? "";
	const owner = o?.owner ?? ev.toController;
	const v = baseView(state, cardId, ev.toController, owner, null);
	v.id = ev.object;
	v.counters = { ...(ev.entersWithCounters ?? {}) };
	v.tapped = ev.entersTapped ?? false;
	return applyStatics(state, v);
}

export function lethalDamage(state: GameState, id: ObjectId): boolean {
	const o = obj(state, id);
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
 * Replacements
 * ------------------------------------------------------------------ */

const MAX_DEPTH = 64;
const MAX_ITERATIONS = 64;

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
			const o = maybeObj(state, id);
			if (!o) continue;
			const defs = [
				...synthesizedSelfReplacements(o),
				...(card(o.cardId).replacements ?? []),
			];
			for (const def of defs) {
				if (!functionsHere(def.functionsIn, zone)) continue;
				out.push({
					id: `${o.id}:${def.label}` as EffectId,
					def,
					source: o,
					controller: o.controller,
					data: o.counters, // sources with per-object charges can read/write here
					label: `${card(o.cardId).name}#${o.id} — ${def.text}`,
				});
			}
		}
	}

	for (const fx of state.floating) {
		if (fx.expired) continue;
		out.push({
			id: fx.id,
			def: fx.def,
			source: null,
			controller: fx.controller,
			data: fx.data,
			label: `(floating) ${fx.def.text}`,
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
		case "beginStep":
		case "lifeChange":
			return ev.player;

		case "damage":
			return ev.target.type === "player"
				? ev.target.player
				: (maybeObj(state, ev.target.id)?.controller ?? ev.sourceController);

		case "destroy":
		case "regenerate":
		case "tap":
		case "untap":
			return maybeObj(state, ev.object)?.controller ?? 0;

		case "addCounters":
			return ev.target.type === "player"
				? ev.target.player
				: (maybeObj(state, ev.target.id)?.controller ?? 0);

		case "createToken":
			return ev.controller;

		case "zoneChange": {
			const o = maybeObj(state, ev.object);
			if (!o) return ev.toController;
			// Objects on the battlefield / stack have a controller; cards elsewhere
			// don't, so their owner chooses. For a card entering the battlefield we
			// use the would-be controller, which is what players expect at the table.
			if (ev.from === "battlefield" || ev.from === "stack") return o.controller;
			if (ev.to === "battlefield") return ev.toController;
			return o.owner;
		}
	}
}

/* ------------------------------------------------------------------ *
 * 3. The loop
 * ------------------------------------------------------------------ */

const LAYER_ORDER: ReplacementLayer[] = ["self", "control", "copy", "other"];

function isUnpreventable(ev: GameEvent): boolean {
	return ev.kind === "damage" && ev.unpreventable;
}

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
		// CR 615.12 — "can't be prevented" locks out prevention effects only.
		if (r.def.prevention && isUnpreventable(ev)) return false;
		try {
			return r.def.applies(ev, ctxFor(state, r, run));
		} catch {
			return false;
		}
	});
}

export function newRun(): ReplacementRun {
	return { applied: new Set(), depth: 0 };
}

/**
 * Runs an event through the replacement pipeline and returns the event(s) that
 * actually happen. May return [] (fully replaced by nothing, e.g. "skip your
 * draw step" or full damage prevention).
 *
 * Note the applied-set is *inherited* by events produced from a replacement.
 * That's what makes Chains of Mephistopheles terminate: the draw that Chains
 * hands back can't be replaced by Chains again.
 */
function resolveReplacements(
	state: GameState,
	event: GameEvent,
	agents: Agent[],
	run: ReplacementRun = newRun(),
): GameEvent[] {
	if (run.depth > MAX_DEPTH) {
		throw new Error(
			`replacement recursion exceeded ${MAX_DEPTH} — probable rules loop`,
		);
	}

	let current = event;

	for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
		const candidates = applicable(state, current, run);
		if (candidates.length === 0) return [current];

		// CR 616.1a-c and 616.1e: take the earliest non-empty tier, only then let a player choose.
		const tier = LAYER_ORDER.find((l) =>
			candidates.some((c) => c.def.layer === l),
		);
		assert(tier, "no tier found");

		const tiered = candidates.filter((c) => c.def.layer === tier);

		const chooser = affectedPlayer(state, current);
		const agent = agents[chooser];
		if (!agent) throw new Error(`no agent for player ${chooser}`);

		const chosen =
			tiered.length === 1
				? tiered[0]!
				: agent.chooseReplacement(state, current, tiered);

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
		if (produced.length === 1 && produced[0]!.kind === current.kind) {
			current = produced[0]!;
			continue;
		}

		// Zero, several, or a different kind: each resulting event re-enters the
		// pipeline, inheriting the applied-set (CR 614.5 across the chain).
		return produced.flatMap((e) =>
			resolveReplacements(state, e, agents, {
				applied: new Set(run.applied),
				depth: run.depth + 1,
			}),
		);
	}

	throw new Error("replacement loop failed to converge");
}

/* ------------------------------------------------------------------ *
 * Zone movement — CR 400.7: an object that moves zones becomes a *new*
 * object. Getting this right is what makes "exile it instead" and
 * flicker effects behave, and what stops stale ids from leaking.
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
): boolean {
	const o = maybeObj(state, id);
	if (!o || o.zone !== from) return false;

	const src = zoneList(state, from, o.owner);
	const idx = src.indexOf(id);
	if (idx === -1) return false;
	src.splice(idx, 1);
	state.objects.delete(id);

	// Tokens cease to exist when they leave the battlefield (CR 111.7).
	if (o.token && from === "battlefield") {
		log(state, `  ${card(o.cardId).name}#${id} (token) ceases to exist`);
		state.lastCreated = null;
		return true;
	}

	const fresh: GameObject = {
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
		counters: to === "battlefield" ? { ...(opts.counters ?? {}) } : {},
		damage: 0,
		attacking: false,
		blocking: false,
		token: false,
		regeneratedThisTurn: false,
	};
	state.objects.set(fresh.id, fresh);

	const dst = zoneList(state, to, fresh.owner);
	if (to === "library" && !opts.toBottom) dst.push(fresh.id);
	else if (to === "library") dst.unshift(fresh.id);
	else dst.push(fresh.id);

	state.lastCreated = fresh.id;
	log(
		state,
		`  ${card(fresh.cardId).name}#${fresh.id} is now in ${to}` +
			(fresh.tapped ? " (tapped)" : "") +
			(Object.keys(fresh.counters).length
				? ` with ${JSON.stringify(fresh.counters)}`
				: ""),
	);
	return true;
}

/** Convenience for logs/tests. */
export function describeEvent(state: GameState, ev: GameEvent): string {
	switch (ev.kind) {
		case "draw":
			return `draw(P${ev.player})`;
		case "discard":
			return `discard(P${ev.player}${ev.object ? `, ${name(state, ev.object)}` : ""})`;
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
		case "lifeChange":
			return `life(P${ev.player} ${ev.delta >= 0 ? "+" : ""}${ev.delta})`;
		case "tap":
			return `tap(${name(state, ev.object)})`;
		case "untap":
			return `untap(${name(state, ev.object)})`;
		case "beginStep":
			return `beginStep(P${ev.player}, ${ev.step})`;
		case "createToken":
			return `token(${ev.amount}x ${ev.cardId} for P${ev.controller})`;
	}
}
export function checkStateBasedActions(
	state: GameState,
	agents: [Agent, Agent],
): void {
	for (let pass = 0; pass < 32; pass++) {
		let acted = false;

		for (const p of state.players) {
			if (!p.lost && p.life <= 0) {
				p.lost = true;
				log(state, `  SBA: P${p.id} loses the game`);
				acted = true;
			}
		}

		for (const id of [...state.battlefield]) {
			const o = maybeObj(state, id);
			if (!o) continue;
			const v = view(state, id);
			if (!v.types.includes("creature")) continue;

			if (v.toughness <= 0) {
				log(state, `  SBA: ${name(state, id)} has toughness ${v.toughness}`);
				perform(
					state,
					{
						kind: "zoneChange",
						object: id,
						from: "battlefield",
						to: "graveyard",
						cause: "sba",
						toController: o.controller,
					},
					agents,
					newScope(),
					true,
				);
				acted = true;
				continue;
			}
			if (lethalDamage(state, id) || o.counters.__deathtouched) {
				log(state, `  SBA: ${name(state, id)} has lethal damage`);
				perform(
					state,
					{
						kind: "destroy",
						object: id,
						noRegen: false,
					},
					agents,
					newScope(),
					true,
				);
				acted = true;
			}
		}

		if (!acted) return;
	}
	throw new Error("SBA loop did not stabilize");
}
/** The single entry point. Replace, then execute, then check SBAs at the top level. */
export function perform(
	state: GameState,
	event: GameEvent,
	agents: [Agent, Agent],
	scope: Scope = newScope(),
	nested = false,
): void {
	log(state, `${nested ? "  " : ""}> ${describeEvent(state, event)}`);
	const finals = resolveReplacements(state, event, agents);
	if (finals.length === 0) log(state, "  (replaced by nothing)");
	for (const ev of finals) execute(state, ev, agents, scope);
	if (!nested) checkStateBasedActions(state, agents);
}

function execute(
	state: GameState,
	ev: GameEvent,
	agents: [Agent, Agent],
	scope: Scope,
): void {
	if (ev.guard && !scope.facts.has(ev.guard)) {
		log(
			state,
			`  (skipped ${describeEvent(state, ev)} — guard "${ev.guard}" unmet)`,
		);
		return;
	}

	let happened = true;

	switch (ev.kind) {
		case "draw": {
			const p = player(state, ev.player);
			const top = p.library[p.library.length - 1];
			if (top === undefined) {
				// CR 104.3c / 704.5b: the loss happens at the next SBA check, not here.
				p.lost = true;
				log(state, `  P${ev.player} tried to draw from an empty library`);
				happened = false;
				break;
			}
			if (state.step === "draw" && state.activePlayer === ev.player)
				p.drawnInDrawStep++;
			// Drawing *is* a zone change, so zone-change replacements get a look too.
			perform(
				state,
				{
					kind: "zoneChange",
					object: top,
					from: "library",
					to: "hand",
					cause: "draw",
					toController: ev.player,
				},
				agents,
				scope,
				true,
			);
			break;
		}

		case "discard": {
			const p = player(state, ev.player);
			if (p.hand.length === 0) {
				happened = false;
				break;
			}
			const chosen =
				ev.object ?? agents[ev.player].chooseDiscard(state, ev.player, p.hand);
			perform(
				state,
				{
					kind: "zoneChange",
					object: chosen,
					from: "hand",
					to: "graveyard",
					cause: "discard",
					toController: ev.player,
				},
				agents,
				scope,
				true,
			);
			break;
		}

		case "damage": {
			if (ev.amount <= 0) {
				happened = false;
				break;
			}
			if (ev.target.type === "player") {
				player(state, ev.target.player).life -= ev.amount;
				log(
					state,
					`  P${ev.target.player} -> ${player(state, ev.target.player).life} life`,
				);
			} else {
				const o = maybeObj(state, ev.target.id);
				if (o?.zone !== "battlefield") {
					happened = false;
					break;
				}
				o.damage += ev.amount;
				if (ev.deathtouch) o.counters.__deathtouched = 1;
				log(state, `  ${name(state, o.id)} has ${o.damage} damage marked`);
			}
			if (ev.lifelink) {
				perform(
					state,
					{
						kind: "lifeChange",
						player: ev.sourceController,
						delta: ev.amount,
						source: ev.source,
					},
					agents,
					scope,
					true,
				);
			}
			break;
		}

		case "destroy": {
			const o = maybeObj(state, ev.object);
			if (o?.zone !== "battlefield") {
				happened = false;
				break;
			}
			perform(
				state,
				{
					kind: "zoneChange",
					object: o.id,
					from: "battlefield",
					to: "graveyard",
					cause: "destroy",
					toController: o.controller,
				},
				agents,
				scope,
				true,
			);
			break;
		}

		case "regenerate": {
			const o = maybeObj(state, ev.object);
			if (!o) {
				happened = false;
				break;
			}
			o.tapped = true;
			o.damage = 0;
			o.attacking = false;
			o.blocking = false;
			delete o.counters["__deathtouched"];
			o.regeneratedThisTurn = true;
			log(
				state,
				`  ${name(state, o.id)} regenerates (tapped, damage removed, out of combat)`,
			);
			break;
		}

		case "zoneChange": {
			happened = moveObject(state, ev.object, ev.from, ev.to, {
				toController: ev.toController,
				tapped: ev.entersTapped,
				counters: ev.entersWithCounters,
				copyOf: ev.copyOf,
				toBottom: ev.toBottom,
			});
			break;
		}

		case "addCounters": {
			if (ev.amount <= 0) {
				happened = false;
				break;
			}
			if (ev.target.type === "permanent") {
				const o = maybeObj(state, ev.target.id);
				if (!o) {
					happened = false;
					break;
				}
				o.counters[ev.counter] = (o.counters[ev.counter] ?? 0) + ev.amount;
				log(
					state,
					`  ${name(state, o.id)} now has ${o.counters[ev.counter]} ${ev.counter}`,
				);
			}
			break;
		}

		case "lifeChange": {
			const p = player(state, ev.player);
			p.life += ev.delta;
			log(state, `  P${ev.player} -> ${p.life} life`);
			break;
		}

		case "tap":
		case "untap": {
			const o = maybeObj(state, ev.object);
			if (!o) {
				happened = false;
				break;
			}
			o.tapped = ev.kind === "tap";
			break;
		}

		case "beginStep": {
			state.step = ev.step;
			if (ev.step === "untap") {
				state.players.forEach((p) => {
					p.drawnInDrawStep = 0;
				});
			}
			if (ev.step === "draw") {
				perform(
					state,
					{ kind: "draw", player: ev.player },
					agents,
					scope,
					true,
				);
			}
			break;
		}

		case "createToken": {
			for (let i = 0; i < ev.amount; i++) {
				const t: GameObject = {
					id: state.nextObjectId++ as ObjectId,
					visibility: [true, true],
					cardId: ev.cardId,
					owner: ev.controller,
					controller: ev.controller,
					zone: "battlefield",
					tapped: false,
					counters: {},
					damage: 0,
					attacking: false,
					blocking: false,
					token: true,
					regeneratedThisTurn: false,
				};
				state.objects.set(t.id, t);
				state.battlefield.push(t.id);
				log(state, `  created ${name(state, t.id)}`);
			}
			break;
		}
	}

	if (happened && ev.fact) scope.facts.add(ev.fact);
}

const TURN: Step[] = [
	"untap",
	"upkeep",
	"draw",
	"main1",
	"combat",
	"main2",
	"end",
	"cleanup",
];

export function runTurn(state: GameState, agents: [Agent, Agent]): void {
	for (const step of TURN) {
		perform(
			state,
			{ kind: "beginStep", player: state.activePlayer, step },
			agents,
		);
		if (state.players.some((p) => p.lost)) return;
	}
	for (const id of state.battlefield) obj(state, id).damage = 0;
	state.floating = state.floating.filter(
		(f) => !f.expired && f.expires !== "endOfTurn",
	);
	state.turn++;
	state.activePlayer = ((state.activePlayer + 1) %
		state.players.length) as PlayerId;
}

if (import.meta.main) {
	const state = newGame();

	const agents: [Agent, Agent] = [new RandomAgent(), new RandomAgent()];

	for (let i = 0; i < 1000; i++) {
		runTurn(state, agents);
		if (state.players.some((p) => p.lost)) {
			dump(state);
			process.exit(0);
		}
	}

	throw new Error("max turn count reached");
}

function dump(state: GameState): void {
	console.log(state.log.map((l) => `    ${l}`).join("\n"));
	state.log.length = 0;
}
