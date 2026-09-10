import { createHash } from "node:crypto";
import type {
	ActivatedAbilityId,
	ActivatedAbilityStackItem,
	BlockAssignment,
	BoundReplacement,
	EntityRef,
	GameEvent,
	GameState,
	ManaAmount,
	ObjectId,
	ObjectPredicateDef,
	PendingTrigger,
	PlayerId,
	PlayerView,
	PriorityAction,
	ReadonlyGameState,
	PredicateContext,
	TargetDef,
	TriggeredAbilityStackItem,
	TurnLocation,
} from "./index.ts";
import {
	activePlayer,
	buildPlayerView,
	createReadContext,
	eligibleBlockers as eligibleBlockersFor,
	getSnapshot,
	name,
	objectMatchesPredicate,
	turnLocation,
} from "./index.ts";
import { assert, assertDefined } from "./lib/assert.ts";

function objectLabel(state: ReadonlyGameState, id: ObjectId): string {
	const object = state.objects.get(id);
	return object ? name(state, id) : "unknown";
}

export interface ChoiceOption {
	id: string;
	label: string;
}

interface ChoiceRequestBase {
	version: 1;
	id: string;
	ordinal: number;
	fingerprint: string;
	player: PlayerId;
	options: ChoiceOption[];
}

export interface ReplacementChoiceRequest extends ChoiceRequestBase {
	kind: "replacement";
	context: { event: GameEvent };
}

/**
 * Choosing an object for an "enter as a copy" replacement is not targeting.
 * The no-copy option is part of the same decision because the replacement may
 * be optional.
 */
export type ObjectChoiceReason =
	| { kind: "copy"; event: GameEvent; source: ObjectId }
	| { kind: "sacrifice" }
	| { kind: "discard" }
	| { kind: "select"; prompt: string; source?: ObjectId };

/** Choosing an object is not targeting. The engine supplies every legal option. */
export interface ObjectChoiceRequest extends ChoiceRequestBase {
	kind: "object";
	context: {
		reason: ObjectChoiceReason;
		objects: ObjectId[];
		predicate?: {
			definition: ObjectPredicateDef;
			context: PredicateContext;
		};
		optional: boolean;
	};
}

export interface ObjectChoiceInput {
	reason: ObjectChoiceReason;
	objects: readonly ObjectId[];
	predicate?: {
		definition: ObjectPredicateDef;
		context: PredicateContext;
	};
}

export interface RequiredObjectChoiceInput extends ObjectChoiceInput {
	optional?: undefined;
}

export interface OptionalObjectChoiceInput extends ObjectChoiceInput {
	optional: { label: string };
}

export interface OptionalChoiceRequest extends ChoiceRequestBase {
	kind: "optional";
	context: { ability: TriggeredAbilityStackItem | ActivatedAbilityStackItem };
}

export interface PriorityActionChoiceRequest extends ChoiceRequestBase {
	kind: "priorityAction";
	context: {
		activePlayer: PlayerId | null;
		location: TurnLocation | null;
	};
}

/** A modal mana ability's mutually exclusive outcomes. */
export interface ManaChoiceRequest extends ChoiceRequestBase {
	kind: "mana";
	context: {
		source: ObjectId;
		ability: ActivatedAbilityId;
		amounts: ManaAmount[];
	};
}

/**
 * `announcing` keeps the three announcement paths distinguishable to an agent:
 * a spell being cast, an ability being activated, and a triggered ability
 * being put on the stack ask for a target under different rules.
 */
export interface TargetChoiceRequest extends ChoiceRequestBase {
	kind: "target";
	context: {
		announcing: "spell" | "activated ability" | "triggered ability";
		source: ObjectId;
		definition: TargetDef;
	};
}

export interface TriggerOrderChoiceRequest extends ChoiceRequestBase {
	kind: "triggerOrder";
	context: {
		triggers: {
			id: string;
			source: ObjectId;
			triggerId: string;
			text: string;
		}[];
	};
}

/**
 * The defending player is intentionally omitted: this project supports
 * exactly two players and all attackers currently attack the opposing
 * player implicitly.
 */
export interface DeclareAttackersChoiceRequest extends ChoiceRequestBase {
	kind: "declareAttackers";
	player: PlayerId;
	context: {
		eligibleAttackers: ObjectId[];
	};
}

/**
 * The defending player is intentionally omitted: this project supports
 * exactly two players and all blockers currently block specific attackers.
 * Each assignment pairs one eligible blocker with one attacking creature.
 */
export interface DeclareBlockersChoiceRequest extends ChoiceRequestBase {
	kind: "declareBlockers";
	player: PlayerId;
	context: {
		attackers: ObjectId[];
		eligibleBlockers: ObjectId[];
	};
}

export interface ScryChoiceRequest extends ChoiceRequestBase {
	kind: "scry";
	player: PlayerId;
	context: {
		/** The looked-at cards in current top-to-bottom order. */
		cards: ObjectId[];
	};
}

export interface SurveilChoiceRequest extends ChoiceRequestBase {
	kind: "surveil";
	player: PlayerId;
	context: {
		/** The looked-at cards in current top-to-bottom order. */
		cards: ObjectId[];
	};
}

export interface ChooseFromTopChoiceRequest extends ChoiceRequestBase {
	kind: "chooseFromTop";
	player: PlayerId;
	context: {
		/** The looked-at cards in current top-to-bottom order. */
		cards: ObjectId[];
		/** The exact number of cards to put into hand. */
		keep: number;
	};
}

export type ChoiceRequest =
	| TargetChoiceRequest
	| ReplacementChoiceRequest
	| ObjectChoiceRequest
	| OptionalChoiceRequest
	| PriorityActionChoiceRequest
	| ManaChoiceRequest
	| TriggerOrderChoiceRequest
	| DeclareAttackersChoiceRequest
	| DeclareBlockersChoiceRequest
	| ScryChoiceRequest
	| SurveilChoiceRequest
	| ChooseFromTopChoiceRequest;

export interface ScryChoiceAnswer {
	/**
	 * Both arrays are ordered from the top of the resulting library
	 * toward the bottom—the earlier card will be drawn first.
	 */
	top: string[];
	bottom: string[];
}

export interface ScryResult {
	/** Both arrays are ordered in future draw order. */
	top: ObjectId[];
	bottom: ObjectId[];
}

/** Surveil uses the same ordered partition answer shape as scry. */
export interface SurveilChoiceAnswer {
	top: string[];
	bottom: string[];
}

export interface SurveilResult {
	top: ObjectId[];
	bottom: ObjectId[];
}

export interface ChooseFromTopChoiceAnswer {
	kept: string[];
	/** Ordered from nearest the top toward the bottom of the bottom group. */
	bottom: string[];
}

export interface ChooseFromTopResult {
	kept: ObjectId[];
	/** Ordered from nearest the top toward the bottom of the bottom group. */
	bottom: ObjectId[];
}

export type ChoiceAnswer =
	| { optionId: string }
	| { optionIds: string[] }
	| ScryChoiceAnswer
	| ChooseFromTopChoiceAnswer;

export interface SyncAgent {
	choose(view: PlayerView, request: ChoiceRequest): ChoiceAnswer;
}

/** The one engine-facing interface implemented by local and remote agents. */
export interface Agent {
	choose(
		view: PlayerView,
		request: ChoiceRequest,
	): ChoiceAnswer | PromiseLike<ChoiceAnswer>;
}

export type SyncAgentPair = [SyncAgent, SyncAgent];
export type AgentPair = [Agent, Agent];

export interface RecordedChoice {
	request: ChoiceRequest;
	answer: ChoiceAnswer;
}

export interface ChoiceTranscript {
	version: 1;
	choices: RecordedChoice[];
}

export class ChoiceReplayMismatchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ChoiceReplayMismatchError";
	}
}

export class InvalidChoiceAnswerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidChoiceAnswerError";
	}
}

/**
 * Normal control flow when an agent cannot answer synchronously. The engine
 * unwinds without awaiting; its caller owns discarding the speculative state,
 * awaiting the answer, recording it, and replaying from a checkpoint.
 */
export class ChoicePendingError extends Error {
	readonly answer: Promise<ChoiceAnswer>;

	constructor(
		readonly request: ChoiceRequest,
		answer: PromiseLike<ChoiceAnswer>,
	) {
		super(`choice ${request.id} is pending`);
		this.name = "ChoicePendingError";
		this.answer = Promise.resolve(answer);
	}
}

type RequestInput =
	| Omit<TargetChoiceRequest, "version" | "id" | "ordinal" | "fingerprint">
	| Omit<ReplacementChoiceRequest, "version" | "id" | "ordinal" | "fingerprint">
	| Omit<ObjectChoiceRequest, "version" | "id" | "ordinal" | "fingerprint">
	| Omit<OptionalChoiceRequest, "version" | "id" | "ordinal" | "fingerprint">
	| Omit<ManaChoiceRequest, "version" | "id" | "ordinal" | "fingerprint">
	| Omit<
			TriggerOrderChoiceRequest,
			"version" | "id" | "ordinal" | "fingerprint"
	  >
	| Omit<
			PriorityActionChoiceRequest,
			"version" | "id" | "ordinal" | "fingerprint"
	  >
	| Omit<
			DeclareAttackersChoiceRequest,
			"version" | "id" | "ordinal" | "fingerprint"
	  >
	| Omit<
			DeclareBlockersChoiceRequest,
			"version" | "id" | "ordinal" | "fingerprint"
	  >
	| Omit<ScryChoiceRequest, "version" | "id" | "ordinal" | "fingerprint">
	| Omit<SurveilChoiceRequest, "version" | "id" | "ordinal" | "fingerprint">
	| Omit<
			ChooseFromTopChoiceRequest,
			"version" | "id" | "ordinal" | "fingerprint"
	  >;

function canonicalize(value: unknown, seen = new Set<object>()): string {
	if (typeof value === "string" || typeof value === "boolean") {
		return JSON.stringify(value);
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("choice data must be finite");
		return JSON.stringify(value);
	}
	if (typeof value === "undefined") return "undefined";
	if (typeof value !== "object") {
		throw new Error(`choice data cannot contain ${typeof value}`);
	}
	if (value === null) return "null";
	if (seen.has(value)) throw new Error("choice data cannot contain cycles");
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			return `[${value.map((entry) => canonicalize(entry, seen)).join(",")}]`;
		}
		if (value instanceof Map || value instanceof Set) {
			throw new Error("choice data cannot contain Map or Set");
		}
		const record = value as Record<string, unknown>;
		const entries = Object.keys(record)
			.filter((key) => record[key] !== undefined)
			.sort()
			.map(
				(key) => `${JSON.stringify(key)}:${canonicalize(record[key], seen)}`,
			);
		return `{${entries.join(",")}}`;
	} finally {
		seen.delete(value);
	}
}

function fingerprint(input: RequestInput): string {
	return createHash("sha256").update(canonicalize(input)).digest("hex");
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
	return (
		(typeof value === "object" || typeof value === "function") &&
		value !== null &&
		typeof (value as PromiseLike<T>).then === "function"
	);
}

/**
 * Central validation and canonicalization boundary for every answer shape:
 * synchronous live answers, recordAnswer async answers, and recorded replay
 * answers all pass through here before being stored or consumed.
 */
function normalizeAnswer(
	request: ChoiceRequest,
	answer: ChoiceAnswer,
): ChoiceAnswer {
	if (
		request.kind === "declareAttackers" ||
		request.kind === "declareBlockers"
	) {
		return normalizeMultiAnswer(request, answer);
	}
	if (request.kind === "triggerOrder") {
		return normalizeOrderedAnswer(request, answer);
	}
	if (request.kind === "scry" || request.kind === "surveil") {
		return normalizeScryAnswer(request, answer);
	}
	if (request.kind === "chooseFromTop") {
		return normalizeChooseFromTopAnswer(request, answer);
	}
	return normalizeSingleAnswer(request, answer);
}

function normalizeChooseFromTopAnswer(
	request: ChooseFromTopChoiceRequest,
	answer: ChoiceAnswer,
): ChooseFromTopChoiceAnswer {
	const kept = (answer as { kept?: unknown })?.kept;
	const bottom = (answer as { bottom?: unknown })?.bottom;
	if (!Array.isArray(kept) || !Array.isArray(bottom)) {
		throw new InvalidChoiceAnswerError(
			`agent returned an invalid answer for choice ${request.id}`,
		);
	}
	if (kept.length !== request.context.keep) {
		throw new InvalidChoiceAnswerError(
			`agent must keep exactly ${request.context.keep} cards for choice ${request.id}`,
		);
	}

	const legalIds = new Set(request.options.map((option) => option.id));
	const seen = new Set<string>();
	for (const id of [...kept, ...bottom]) {
		if (typeof id !== "string" || !legalIds.has(id) || seen.has(id)) {
			throw new InvalidChoiceAnswerError(
				`agent returned an invalid card arrangement for choice ${request.id}`,
			);
		}
		seen.add(id);
	}
	if (seen.size !== legalIds.size) {
		throw new InvalidChoiceAnswerError(
			`agent must place all ${legalIds.size} cards for choice ${request.id}`,
		);
	}
	return {
		kept: [...kept] as string[],
		bottom: [...bottom] as string[],
	};
}

function normalizeScryAnswer(
	request: ScryChoiceRequest | SurveilChoiceRequest,
	answer: ChoiceAnswer,
): ScryChoiceAnswer | SurveilChoiceAnswer {
	const top = (answer as { top?: unknown })?.top;
	const bottom = (answer as { bottom?: unknown })?.bottom;
	if (!Array.isArray(top) || !Array.isArray(bottom)) {
		throw new InvalidChoiceAnswerError(
			`agent returned an invalid answer for choice ${request.id}`,
		);
	}

	const legalIds = new Set(request.options.map((option) => option.id));
	const seen = new Set<string>();
	for (const id of [...top, ...bottom]) {
		if (typeof id !== "string") {
			throw new InvalidChoiceAnswerError(
				`agent returned an invalid answer for choice ${request.id}`,
			);
		}
		if (!legalIds.has(id)) {
			throw new InvalidChoiceAnswerError(
				`agent selected ${id} for choice ${request.id}; legal options: ${[...legalIds].join(", ")}`,
			);
		}
		if (seen.has(id)) {
			throw new InvalidChoiceAnswerError(
				`agent selected duplicate option ${id} for choice ${request.id}`,
			);
		}
		seen.add(id);
	}
	if (seen.size !== legalIds.size) {
		throw new InvalidChoiceAnswerError(
			`agent must place all ${legalIds.size} cards for choice ${request.id}`,
		);
	}
	return { top: [...top] as string[], bottom: [...bottom] as string[] };
}

function normalizeOrderedAnswer(
	request: TriggerOrderChoiceRequest,
	answer: ChoiceAnswer,
): { optionIds: string[] } {
	if (
		!answer ||
		!Array.isArray((answer as { optionIds?: unknown }).optionIds)
	) {
		throw new InvalidChoiceAnswerError(
			`agent returned an invalid answer for choice ${request.id}`,
		);
	}
	const optionIds = (answer as { optionIds: unknown[] }).optionIds;
	if (optionIds.length !== request.options.length) {
		throw new InvalidChoiceAnswerError(
			`agent must order all ${request.options.length} options for choice ${request.id}`,
		);
	}
	const legalIds = new Set(request.options.map((option) => option.id));
	const seen = new Set<string>();
	for (const id of optionIds) {
		if (typeof id !== "string" || !legalIds.has(id) || seen.has(id)) {
			throw new InvalidChoiceAnswerError(
				`agent returned an invalid trigger order for choice ${request.id}`,
			);
		}
		seen.add(id);
	}
	return { optionIds: [...optionIds] as string[] };
}

function normalizeSingleAnswer(
	request: ChoiceRequest,
	answer: ChoiceAnswer,
): { optionId: string } {
	if (
		!answer ||
		typeof (answer as { optionId?: unknown }).optionId !== "string"
	) {
		throw new InvalidChoiceAnswerError(
			`agent returned an invalid answer for choice ${request.id}`,
		);
	}
	const optionId = (answer as { optionId: string }).optionId;
	if (!request.options.some((option) => option.id === optionId)) {
		throw new InvalidChoiceAnswerError(
			`agent selected ${optionId} for choice ${request.id}; legal options: ${request.options.map((option) => option.id).join(", ")}`,
		);
	}
	return { optionId };
}

function normalizeMultiAnswer(
	request: ChoiceRequest,
	answer: ChoiceAnswer,
): { optionIds: string[] } {
	if (
		!answer ||
		!Array.isArray((answer as { optionIds?: unknown }).optionIds)
	) {
		throw new InvalidChoiceAnswerError(
			`agent returned an invalid answer for choice ${request.id}`,
		);
	}
	const optionIds = (answer as { optionIds: unknown[] }).optionIds;
	const seen = new Set<string>();
	for (const id of optionIds) {
		if (typeof id !== "string") {
			throw new InvalidChoiceAnswerError(
				`agent returned an invalid answer for choice ${request.id}`,
			);
		}
		if (seen.has(id)) {
			throw new InvalidChoiceAnswerError(
				`agent selected duplicate option ${id} for choice ${request.id}`,
			);
		}
		seen.add(id);
	}
	const validIds = new Set(request.options.map((option) => option.id));
	for (const id of seen) {
		if (!validIds.has(id)) {
			throw new InvalidChoiceAnswerError(
				`agent selected ${id} for choice ${request.id}; legal options: ${request.options.map((option) => option.id).join(", ")}`,
			);
		}
	}
	const normalized = request.options
		.map((option) => option.id)
		.filter((id) => seen.has(id));
	return { optionIds: normalized };
}

export function priorityOptionId(action: PriorityAction): string {
	return `priority:${createHash("sha256")
		.update(canonicalize(action))
		.digest("hex")}`;
}

function priorityOptionLabel(state: GameState, action: PriorityAction): string {
	switch (action.kind) {
		case "play land":
			return `play land ${objectLabel(state, action.card)}#${action.card}`;
		case "activate ability":
			return `activate ${objectLabel(state, action.source)}#${action.source} — ${action.ability}`;
		case "cast":
			return `cast ${objectLabel(state, action.card)}#${action.card}`;
		default:
			return action.kind;
	}
}

/**
 * Synchronous choice boundary shared by normal execution and transcript replay.
 * Existing transcript entries are consumed first; otherwise the live agent is
 * called and its answer is appended to the transcript.
 */
export class ChoiceController<CanSuspend extends boolean = false> {
	private declare readonly canSuspend: CanSuspend;
	private readonly agents: AgentPair | null;
	private readonly decisions: RecordedChoice[];
	private cursor = 0;
	private pendingRequest: ChoiceRequest | null = null;

	private constructor(
		agents: AgentPair | null,
		private readonly allowSuspension: CanSuspend,
		transcript?: ChoiceTranscript,
	) {
		if (transcript && transcript.version !== 1) {
			throw new Error(
				`unsupported choice transcript version ${transcript.version}`,
			);
		}
		this.agents = agents;
		this.decisions = clone(transcript?.choices ?? []);
	}

	static record(agents: SyncAgentPair): ChoiceController<false> {
		return new ChoiceController(agents, false);
	}

	static replay(transcript: ChoiceTranscript): ChoiceController<false> {
		return new ChoiceController(null, false, transcript);
	}

	static suspending(
		agents: AgentPair,
		transcript?: ChoiceTranscript,
	): ChoiceController<true> {
		return new ChoiceController(agents, true, transcript);
	}

	rewind(): void {
		this.cursor = 0;
	}

	transcript(): ChoiceTranscript {
		return { version: 1, choices: clone(this.decisions) };
	}

	/** Append an answer obtained after ChoicePendingError unwound the engine. */
	recordAnswer(request: ChoiceRequest, answer: ChoiceAnswer): void {
		const pending = this.pendingRequest;
		if (
			!pending ||
			request.id !== pending.id ||
			request.fingerprint !== pending.fingerprint
		) {
			throw new ChoiceReplayMismatchError(
				`choice ${request.id} does not match the controller's pending request`,
			);
		}
		if (request.ordinal !== this.decisions.length) {
			throw new ChoiceReplayMismatchError(
				`cannot record choice ${request.ordinal}; transcript has ${this.decisions.length} choices`,
			);
		}
		const normalized = normalizeAnswer(pending, answer);
		this.decisions.push({
			request: clone(pending),
			answer: clone(normalized),
		});
		this.pendingRequest = null;
	}

	assertComplete(): void {
		if (this.cursor !== this.decisions.length) {
			throw new ChoiceReplayMismatchError(
				`replay consumed ${this.cursor} of ${this.decisions.length} recorded choices`,
			);
		}
	}

	private request(input: RequestInput): ChoiceRequest {
		if (input.options.length === 0) {
			throw new Error(`choice ${input.kind} has no options`);
		}
		const optionIds = new Set(input.options.map((option) => option.id));
		if (optionIds.size !== input.options.length) {
			throw new Error(`choice ${input.kind} has duplicate option ids`);
		}

		const ordinal = this.cursor;
		const requestFingerprint = fingerprint(input);
		return {
			...clone(input),
			version: 1,
			ordinal,
			fingerprint: requestFingerprint,
			id: `${ordinal}:${requestFingerprint}`,
		} as ChoiceRequest;
	}

	private choose<T>(
		state: ReadonlyGameState,
		request: ChoiceRequest,
		candidates: readonly { id: string; value: T }[],
	): T {
		const recorded = this.decisions[this.cursor];
		if (recorded) {
			if (
				recorded.request.id !== request.id ||
				recorded.request.fingerprint !== request.fingerprint
			) {
				throw new ChoiceReplayMismatchError(
					`choice ${this.cursor} diverged: expected ${recorded.request.kind} ${recorded.request.fingerprint}, received ${request.kind} ${request.fingerprint}`,
				);
			}
			const recordedAnswer = recorded.answer;
			if (!("optionId" in recordedAnswer)) {
				throw new ChoiceReplayMismatchError(
					`recorded answer for choice ${request.id} is not a single-select answer`,
				);
			}
			const candidate = candidates.find(
				(option) => option.id === recordedAnswer.optionId,
			);
			if (!candidate) {
				throw new ChoiceReplayMismatchError(
					`recorded answer ${recordedAnswer.optionId} is not legal for choice ${request.id}`,
				);
			}
			this.cursor++;
			return candidate.value;
		}

		const agent = this.agents?.[request.player];
		if (!agent) {
			throw new ChoiceReplayMismatchError(
				`transcript ended before choice ${request.id}`,
			);
		}
		const answer = agent.choose(
			buildPlayerView(state, request.player),
			request,
		);
		if (isPromiseLike(answer)) {
			if (!this.allowSuspension) {
				throw new Error("an async agent was used outside advanceWithReplay()");
			}
			this.pendingRequest = clone(request);
			throw new ChoicePendingError(clone(request), answer);
		}
		const normalized = normalizeAnswer(request, answer);
		if (!("optionId" in normalized)) {
			throw new InvalidChoiceAnswerError(
				`choice ${request.id} requires a single-select answer`,
			);
		}
		const candidate = candidates.find(
			(option) => option.id === normalized.optionId,
		);
		if (!candidate) {
			throw new InvalidChoiceAnswerError(
				`choice ${request.id} has no live candidate for ${normalized.optionId}`,
			);
		}
		this.decisions.push({
			request: clone(request),
			answer: clone(normalized),
		});
		this.cursor++;
		return candidate.value;
	}

	private chooseMulti<T>(
		state: GameState,
		request: ChoiceRequest,
		candidates: readonly { id: string; value: T }[],
	): T[] {
		const recorded = this.decisions[this.cursor];
		if (recorded) {
			if (
				recorded.request.id !== request.id ||
				recorded.request.fingerprint !== request.fingerprint
			) {
				throw new ChoiceReplayMismatchError(
					`choice ${this.cursor} diverged: expected ${recorded.request.kind} ${recorded.request.fingerprint}, received ${request.kind} ${request.fingerprint}`,
				);
			}
			const normalized = normalizeAnswer(request, recorded.answer);
			if (!("optionIds" in normalized)) {
				throw new ChoiceReplayMismatchError(
					`recorded answer for choice ${request.id} is not a multi-select answer`,
				);
			}
			const values: T[] = [];
			for (const id of normalized.optionIds) {
				const candidate = candidates.find((option) => option.id === id);
				if (!candidate) {
					throw new ChoiceReplayMismatchError(
						`recorded answer ${id} is not legal for choice ${request.id}`,
					);
				}
				values.push(candidate.value);
			}
			this.cursor++;
			return values;
		}

		const agent = this.agents?.[request.player];
		if (!agent) {
			throw new ChoiceReplayMismatchError(
				`transcript ended before choice ${request.id}`,
			);
		}
		const answer = agent.choose(
			buildPlayerView(state, request.player),
			request,
		);
		if (isPromiseLike(answer)) {
			if (!this.allowSuspension) {
				throw new Error("an async agent was used outside advanceWithReplay()");
			}
			this.pendingRequest = clone(request);
			throw new ChoicePendingError(clone(request), answer);
		}
		const normalized = normalizeAnswer(request, answer);
		if (!("optionIds" in normalized)) {
			throw new InvalidChoiceAnswerError(
				`choice ${request.id} requires a multi-select answer`,
			);
		}
		const values: T[] = [];
		for (const id of normalized.optionIds) {
			const candidate = candidates.find((option) => option.id === id);
			if (!candidate) {
				throw new InvalidChoiceAnswerError(
					`choice ${request.id} has no live candidate for ${id}`,
				);
			}
			values.push(candidate.value);
		}
		this.decisions.push({
			request: clone(request),
			answer: clone(normalized),
		});
		this.cursor++;
		return values;
	}

	chooseTarget(
		state: GameState,
		player: PlayerId,
		announcement: {
			announcing: TargetChoiceRequest["context"]["announcing"];
			source: ObjectId;
		},
		definition: TargetDef,
		targets: EntityRef[],
	): EntityRef {
		const candidates = targets.map((target) => ({
			id: targetOptionId(target),
			value: target,
		}));
		const request = this.request({
			kind: "target",
			player,
			context: { ...announcement, definition },
			options: targets.map((target) => ({
				id: targetOptionId(target),
				label:
					target.type === "player"
						? `Player ${target.player}`
						: `${objectLabel(state, target.id)}#${target.id}`,
			})),
		});
		return this.choose(state, request, candidates);
	}

	chooseReplacement(
		state: GameState,
		player: PlayerId,
		event: GameEvent,
		options: BoundReplacement[],
	): BoundReplacement {
		const candidates = options.map((option) => ({
			id: String(option.id),
			value: option,
		}));
		const request = this.request({
			kind: "replacement",
			player,
			context: { event },
			options: options.map((option) => ({
				id: String(option.id),
				label: option.label,
			})),
		});
		return this.choose(state, request, candidates);
	}

	chooseObject(
		state: ReadonlyGameState,
		player: PlayerId,
		input: RequiredObjectChoiceInput,
	): ObjectId;
	chooseObject(
		state: ReadonlyGameState,
		player: PlayerId,
		input: OptionalObjectChoiceInput,
	): ObjectId | null;
	chooseObject(
		state: ReadonlyGameState,
		player: PlayerId,
		input: RequiredObjectChoiceInput | OptionalObjectChoiceInput,
	): ObjectId | null {
		assert(
			new Set(input.objects).size === input.objects.length,
			"object choice received duplicate objects",
		);
		const read = input.predicate ? createReadContext(state) : null;
		const objects = input.objects.filter((id) => {
			if (!input.predicate) return true;
			assertDefined(read);
			return objectMatchesPredicate(
				input.predicate.definition,
				getSnapshot(read, id),
				{
					controller: input.predicate.context.controller,
					id: input.predicate.context.source,
				},
			);
		});
		if (objects.length === 0) {
			assert(input.optional, "required object choice has no legal objects");
			return null;
		}
		const candidates: { id: string; value: ObjectId | null }[] = objects.map(
			(id) => ({ id: String(id), value: id }),
		);
		if (input.optional) candidates.push({ id: "decline", value: null });
		const request = this.request({
			kind: "object",
			player,
			context: {
				reason: input.reason,
				objects: [...objects],
				...(input.predicate ? { predicate: input.predicate } : {}),
				optional: input.optional !== undefined,
			},
			options: [
				...objects.map((id) => ({
					id: String(id),
					label: `${objectLabel(state, id)}#${id}`,
				})),
				...(input.optional
					? [{ id: "decline", label: input.optional.label }]
					: []),
			],
		});
		return this.choose(state, request, candidates);
	}

	chooseManaAmount(
		state: GameState,
		player: PlayerId,
		source: ObjectId,
		ability: ActivatedAbilityId,
		amounts: readonly ManaAmount[],
	): ManaAmount {
		const candidates = amounts.map((amount, index) => ({
			id: String(index),
			value: amount,
		}));
		const request = this.request({
			kind: "mana",
			player,
			context: {
				source,
				ability,
				amounts: amounts.map((amount) => ({ ...amount })),
			},
			options: amounts.map((amount, index) => ({
				id: String(index),
				label: `Add ${(["w", "u", "b", "r", "g", "c"] as const)
					.map((type) => {
						const quantity = amount[type] ?? 0;
						return quantity === 0
							? ""
							: quantity === 1
								? `{${type.toUpperCase()}}`
								: `${quantity}{${type.toUpperCase()}}`;
					})
					.join("")}.`,
			})),
		});
		return this.choose(state, request, candidates);
	}

	chooseOptional(
		state: GameState,
		ability: TriggeredAbilityStackItem | ActivatedAbilityStackItem,
		player: PlayerId = ability.controller,
	): boolean {
		const candidates = [
			{ id: "yes", value: true },
			{ id: "no", value: false },
		];
		const request = this.request({
			kind: "optional",
			player,
			context: { ability },
			options: [
				{ id: "yes", label: "Yes" },
				{ id: "no", label: "No" },
			],
		});
		return this.choose(state, request, candidates);
	}

	choosePriorityAction(
		state: GameState,
		player: PlayerId,
		actions: PriorityAction[],
	): PriorityAction {
		const candidates = actions.map((action) => ({
			id: priorityOptionId(action),
			value: action,
		}));
		const request = this.request({
			kind: "priorityAction",
			player,
			context: {
				activePlayer: activePlayer(state),
				location: turnLocation(state),
			},
			options: actions.map((action) => ({
				id: priorityOptionId(action),
				label: priorityOptionLabel(state, action),
			})),
		});
		return this.choose(state, request, candidates);
	}

	chooseTriggerOrder(
		state: GameState,
		player: PlayerId,
		triggers: PendingTrigger[],
	): PendingTrigger[] {
		if (triggers.length < 2) return [...triggers];
		const candidates = triggers.map((trigger, index) => ({
			id: `trigger:${index}:${trigger.source}:${trigger.triggerId}`,
			value: trigger,
		}));
		const request = this.request({
			kind: "triggerOrder",
			player,
			context: {
				triggers: candidates.map((candidate) => ({
					id: candidate.id,
					source: candidate.value.source,
					triggerId: String(candidate.value.triggerId),
					text: candidate.value.text,
				})),
			},
			options: candidates.map((candidate) => ({
				id: candidate.id,
				label: `${objectLabel(state, candidate.value.source)}#${candidate.value.source} — ${candidate.value.text}`,
			})),
		});
		return this.chooseMulti(state, request, candidates);
	}

	/**
	 * One replayable multi-select decision over a subset of eligible
	 * attackers, including the empty subset. An empty eligible list is not a
	 * real decision and is answered without issuing a request.
	 */
	chooseAttackers(
		state: GameState,
		player: PlayerId,
		eligibleAttackers: ObjectId[],
	): ObjectId[] {
		if (eligibleAttackers.length === 0) return [];
		const candidates = eligibleAttackers.map((id) => ({
			id: String(id),
			value: id,
		}));
		const request = this.request({
			kind: "declareAttackers",
			player,
			context: { eligibleAttackers: [...eligibleAttackers] },
			options: eligibleAttackers.map((id) => ({
				id: String(id),
				label: `${objectLabel(state, id)}#${id}`,
			})),
		});
		return this.chooseMulti(state, request, candidates);
	}
	/**
	 * One replayable multi-select decision over blocker-to-attacker
	 * assignments. Empty lists short-circuit without a request: no attackers
	 * means nothing can block, and no eligible blockers means nothing will.
	 */
	chooseBlockers(
		state: GameState,
		player: PlayerId,
		attackers: ObjectId[],
		eligibleBlockers: ObjectId[],
	): BlockAssignment[] {
		if (attackers.length === 0 || eligibleBlockers.length === 0) return [];
		const candidates: { id: string; value: BlockAssignment }[] = [];
		for (const blocker of eligibleBlockers) {
			for (const attacker of attackers) {
				if (!eligibleBlockersFor(state, player, attacker).includes(blocker))
					continue;
				candidates.push({
					id: blockAssignmentOptionId(blocker, attacker),
					value: { blocker, attacker },
				});
			}
		}
		if (candidates.length === 0) return [];
		const offeredBlockers = eligibleBlockers.filter((blocker) =>
			candidates.some((candidate) => candidate.value.blocker === blocker),
		);
		const request = this.request({
			kind: "declareBlockers",
			player,
			context: {
				attackers: [...attackers],
				eligibleBlockers: offeredBlockers,
			},
			options: candidates.map((candidate) => ({
				id: candidate.id,
				label: `${objectLabel(state, candidate.value.blocker)}#${candidate.value.blocker} blocks ${objectLabel(state, candidate.value.attacker)}#${candidate.value.attacker}`,
			})),
		});
		return this.chooseMulti(state, request, candidates);
	}

	/**
	 * One replayable ordered partition of the looked-at cards. `cards` and both
	 * result arrays are top-to-bottom: an earlier card will be drawn first.
	 */
	chooseScry(
		state: GameState,
		player: PlayerId,
		cards: ObjectId[],
	): ScryResult {
		if (cards.length === 0) return { top: [], bottom: [] };
		assert(
			new Set(cards).size === cards.length,
			"scry candidates contain duplicate object ids",
		);
		const candidates = cards.map((id) => ({ id: String(id), value: id }));
		const request = this.request({
			kind: "scry",
			player,
			context: { cards: [...cards] },
			options: cards.map((id) => ({
				id: String(id),
				label: `${objectLabel(state, id)}#${id}`,
			})),
		});

		let normalized: ChoiceAnswer;
		const recorded = this.decisions[this.cursor];
		if (recorded) {
			if (
				recorded.request.id !== request.id ||
				recorded.request.fingerprint !== request.fingerprint
			) {
				throw new ChoiceReplayMismatchError(
					`choice ${this.cursor} diverged: expected ${recorded.request.kind} ${recorded.request.fingerprint}, received ${request.kind} ${request.fingerprint}`,
				);
			}
			normalized = normalizeAnswer(request, recorded.answer);
		} else {
			const agent = this.agents?.[request.player];
			if (!agent) {
				throw new ChoiceReplayMismatchError(
					`transcript ended before choice ${request.id}`,
				);
			}
			const answer = agent.choose(
				buildPlayerView(state, request.player),
				request,
			);
			if (isPromiseLike(answer)) {
				if (!this.allowSuspension) {
					throw new Error(
						"an async agent was used outside advanceWithReplay()",
					);
				}
				this.pendingRequest = clone(request);
				throw new ChoicePendingError(clone(request), answer);
			}
			normalized = normalizeAnswer(request, answer);
			this.decisions.push({
				request: clone(request),
				answer: clone(normalized),
			});
		}

		if (!("top" in normalized)) {
			throw new InvalidChoiceAnswerError(
				`choice ${request.id} requires a scry answer`,
			);
		}
		const objectFor = (id: string): ObjectId => {
			const candidate = candidates.find((entry) => entry.id === id);
			assertDefined(candidate, `scry choice has no live candidate for ${id}`);
			return candidate.value;
		};
		this.cursor++;
		return {
			top: normalized.top.map(objectFor),
			bottom: normalized.bottom.map(objectFor),
		};
	}

	/**
	 * Choose exactly `keep` looked-at cards and order every other card for the
	 * bottom of the library. Cards are presented top-to-bottom, and `bottom` is
	 * returned nearest-to-top first within that bottom group.
	 */
	chooseFromTop(
		state: GameState,
		player: PlayerId,
		cards: ObjectId[],
		keep: number,
	): ChooseFromTopResult {
		assert(
			Number.isSafeInteger(keep) && keep >= 1,
			`choose-from-top keep count must be a positive integer, got ${keep}`,
		);
		assert(
			new Set(cards).size === cards.length,
			"choose-from-top candidates contain duplicate object ids",
		);
		const actualKeep = Math.min(keep, cards.length);
		if (cards.length <= keep) return { kept: [...cards], bottom: [] };

		const candidates = cards.map((id) => ({ id: String(id), value: id }));
		const request = this.request({
			kind: "chooseFromTop",
			player,
			context: { cards: [...cards], keep: actualKeep },
			options: cards.map((id) => ({
				id: String(id),
				label: `${objectLabel(state, id)}#${id}`,
			})),
		});

		let normalized: ChoiceAnswer;
		const recorded = this.decisions[this.cursor];
		if (recorded) {
			if (
				recorded.request.id !== request.id ||
				recorded.request.fingerprint !== request.fingerprint
			) {
				throw new ChoiceReplayMismatchError(
					`choice ${this.cursor} diverged: expected ${recorded.request.kind} ${recorded.request.fingerprint}, received ${request.kind} ${request.fingerprint}`,
				);
			}
			normalized = normalizeAnswer(request, recorded.answer);
		} else {
			const agent = this.agents?.[request.player];
			if (!agent) {
				throw new ChoiceReplayMismatchError(
					`transcript ended before choice ${request.id}`,
				);
			}
			const answer = agent.choose(
				buildPlayerView(state, request.player),
				request,
			);
			if (isPromiseLike(answer)) {
				if (!this.allowSuspension) {
					throw new Error(
						"an async agent was used outside advanceWithReplay()",
					);
				}
				this.pendingRequest = clone(request);
				throw new ChoicePendingError(clone(request), answer);
			}
			normalized = normalizeAnswer(request, answer);
			this.decisions.push({
				request: clone(request),
				answer: clone(normalized),
			});
		}

		if (!("kept" in normalized)) {
			throw new InvalidChoiceAnswerError(
				`choice ${request.id} requires a choose-from-top answer`,
			);
		}
		const objectFor = (id: string): ObjectId => {
			const candidate = candidates.find((entry) => entry.id === id);
			assertDefined(
				candidate,
				`choose-from-top choice has no live candidate for ${id}`,
			);
			return candidate.value;
		};
		this.cursor++;
		return {
			kept: normalized.kept.map(objectFor),
			bottom: normalized.bottom.map(objectFor),
		};
	}

	/** Surveil has exactly the same replayable ordered partition as scry. */
	chooseSurveil(
		state: GameState,
		player: PlayerId,
		cards: ObjectId[],
	): SurveilResult {
		if (cards.length === 0) return { top: [], bottom: [] };
		assert(
			new Set(cards).size === cards.length,
			"surveil candidates contain duplicate object ids",
		);
		const candidates = cards.map((id) => ({ id: String(id), value: id }));
		const request = this.request({
			kind: "surveil",
			player,
			context: { cards: [...cards] },
			options: cards.map((id) => ({
				id: String(id),
				label: `${objectLabel(state, id)}#${id}`,
			})),
		});

		let normalized: ChoiceAnswer;
		const recorded = this.decisions[this.cursor];
		if (recorded) {
			if (
				recorded.request.id !== request.id ||
				recorded.request.fingerprint !== request.fingerprint
			) {
				throw new ChoiceReplayMismatchError(
					`choice ${this.cursor} diverged: expected ${recorded.request.kind} ${recorded.request.fingerprint}, received ${request.kind} ${request.fingerprint}`,
				);
			}
			normalized = normalizeAnswer(request, recorded.answer);
		} else {
			const agent = this.agents?.[request.player];
			if (!agent) {
				throw new ChoiceReplayMismatchError(
					`transcript ended before choice ${request.id}`,
				);
			}
			const answer = agent.choose(
				buildPlayerView(state, request.player),
				request,
			);
			if (isPromiseLike(answer)) {
				if (!this.allowSuspension) {
					throw new Error(
						"an async agent was used outside advanceWithReplay()",
					);
				}
				this.pendingRequest = clone(request);
				throw new ChoicePendingError(clone(request), answer);
			}
			normalized = normalizeAnswer(request, answer);
			this.decisions.push({
				request: clone(request),
				answer: clone(normalized),
			});
		}

		if (!("top" in normalized)) {
			throw new InvalidChoiceAnswerError(
				`choice ${request.id} requires a surveil answer`,
			);
		}
		const objectFor = (id: string): ObjectId => {
			const candidate = candidates.find((entry) => entry.id === id);
			assertDefined(
				candidate,
				`surveil choice has no live candidate for ${id}`,
			);
			return candidate.value;
		};
		this.cursor++;
		return {
			top: normalized.top.map(objectFor),
			bottom: normalized.bottom.map(objectFor),
		};
	}
}

export function blockAssignmentOptionId(
	blocker: ObjectId,
	attacker: ObjectId,
): string {
	return `${blocker}:${attacker}`;
}
export type AnyChoiceController = ChoiceController<boolean>;
export type ChoiceSource = SyncAgentPair | ChoiceController<false>;

export function asChoiceController(
	source: ChoiceSource,
): ChoiceController<false> {
	return source instanceof ChoiceController
		? source
		: ChoiceController.record(source);
}

export function targetOptionId(target: EntityRef): string {
	if (target.type === "player") return `player:${target.player}`;
	return `${target.type}:${target.id}`;
}
