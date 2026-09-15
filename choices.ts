import { createHash } from "node:crypto";
import type {
	ActivatedAbilityId,
	ActivatedAbilityStackItem,
	BlockAssignment,
	BoundReplacement,
	Engine,
	EntityRef,
	GameEvent,
	GameState,
	ManaAmount,
	ObjectId,
	ObjectPredicateDef,
	PendingTrigger,
	PlayerId,
	PlayerLibrarySearchCardView,
	PlayerView,
	PredicateContext,
	PriorityAction,
	ReadonlyGameState,
	TargetDef,
	TriggeredAbilityStackItem,
	TurnLocation,
} from "./index.ts";
import {
	activePlayer,
	buildPlayerView,
	createReadContext,
	eligibleBlockers,
	getSnapshot,
	name,
	objectMatchesPredicate,
	turnLocation,
} from "./index.ts";
import { assert, assertDefined } from "./lib/assert.ts";

function objectLabel(
	engine: Engine,
	state: ReadonlyGameState,
	id: ObjectId,
): string {
	const object = state.objects.get(id);
	return object ? name(engine, state, id) : "unknown";
}

/** The option id naming one looked-at card. */
function cardOptionId(id: ObjectId): string {
	return String(id);
}

/**
 * The card an option id names, inverting {@link cardOptionId}.
 *
 * `normalizeAnswer` has already checked that every id in a partition answer is
 * one of the request's own options, so this converts rather than searches.
 */
function objectForCardOption(id: string): ObjectId {
	const parsed = Number(id);
	assert(Number.isSafeInteger(parsed), `card option ${id} is not an object id`);
	return parsed as ObjectId;
}

export interface ChoiceOption {
	id: string;
	label: string;
}

/**
 * The attacker one `declareAttackers` option declares.
 *
 * The object id is carried rather than left for an agent to recover from the
 * option id or the display label: an agent picks attackers by looking at the
 * board, and a label is for humans.
 */
export interface AttackerChoiceOption extends ChoiceOption {
	attacker: ObjectId;
}

/**
 * The blocker-to-attacker assignment one `declareBlockers` option declares.
 *
 * One option per legal pair, so a blocker able to block three attackers
 * appears in three options — and an answer may contain at most one of them
 * (CR 509.1a). Without this field an agent cannot tell which options share a
 * blocker, so it cannot construct a legal answer without parsing the label.
 */
export interface BlockAssignmentChoiceOption extends ChoiceOption {
	assignment: BlockAssignment;
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
	options: AttackerChoiceOption[];
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
	options: BlockAssignmentChoiceOption[];
	context: {
		attackers: ObjectId[];
		eligibleBlockers: ObjectId[];
	};
}

export type PartitionChoiceReason = "scry" | "surveil" | "choose-from-top";

export interface PartitionChoiceGroup {
	label: string;
	/** When present, this group must contain exactly this many cards. */
	exactSize?: number;
}

export interface PartitionChoiceRequest extends ChoiceRequestBase {
	kind: "partition";
	player: PlayerId;
	context: {
		reason: PartitionChoiceReason;
		/** The looked-at cards in current top-to-bottom order. */
		cards: ObjectId[];
		/** The two ordered destinations for the looked-at cards. */
		groups: [PartitionChoiceGroup, PartitionChoiceGroup];
	};
}

/**
 * Searching is its own choice rather than a generic object choice because it
 * temporarily reveals cards from a normally hidden library to the searcher.
 * `player` is the searcher; `owner` is intentionally independent.
 */
export interface SearchLibraryChoiceRequest extends ChoiceRequestBase {
	kind: "searchLibrary";
	context: {
		owner: PlayerId;
		source: ObjectId;
		cards: PlayerLibrarySearchCardView[];
		predicate?: ObjectPredicateDef;
		optional: boolean;
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
	| PartitionChoiceRequest
	| SearchLibraryChoiceRequest;

export interface PartitionChoiceAnswer {
	/** Each group is ordered nearest its destination first. */
	groups: [string[], string[]];
}

export interface PartitionResult {
	/** Each group is ordered nearest its destination first. */
	groups: [ObjectId[], ObjectId[]];
}

export type ChoiceAnswer =
	| { optionId: string }
	| { optionIds: string[] }
	| PartitionChoiceAnswer;

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
	| Omit<PartitionChoiceRequest, "version" | "id" | "ordinal" | "fingerprint">
	| Omit<
			SearchLibraryChoiceRequest,
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
	if (request.kind === "declareBlockers") {
		return normalizeBlockerAnswer(request, answer);
	}
	if (request.kind === "declareAttackers") {
		return normalizeMultiAnswer(request, answer);
	}
	if (request.kind === "triggerOrder") {
		return normalizeOrderedAnswer(request, answer);
	}
	if (request.kind === "partition") {
		return normalizePartitionAnswer(request, answer);
	}
	return normalizeSingleAnswer(request, answer);
}

function normalizePartitionAnswer(
	request: PartitionChoiceRequest,
	answer: ChoiceAnswer,
): PartitionChoiceAnswer {
	const groups = (answer as { groups?: unknown })?.groups;
	if (
		!Array.isArray(groups) ||
		groups.length !== 2 ||
		!groups.every(Array.isArray)
	) {
		throw new InvalidChoiceAnswerError(
			`agent returned an invalid answer for choice ${request.id}`,
		);
	}
	const partitionGroups = groups as [unknown[], unknown[]];

	const legalIds = new Set(request.options.map((option) => option.id));
	const seen = new Set<string>();
	for (let groupIndex = 0; groupIndex < partitionGroups.length; groupIndex++) {
		const group = partitionGroups[groupIndex];
		const definition = request.context.groups[groupIndex];
		assertDefined(group);
		assertDefined(definition);
		if (
			definition.exactSize !== undefined &&
			group.length !== definition.exactSize
		) {
			throw new InvalidChoiceAnswerError(
				`agent must put exactly ${definition.exactSize} cards in ${definition.label} for choice ${request.id}`,
			);
		}
		for (const id of group) {
			if (typeof id !== "string" || !legalIds.has(id) || seen.has(id)) {
				throw new InvalidChoiceAnswerError(
					`agent returned an invalid card partition for choice ${request.id}`,
				);
			}
			seen.add(id);
		}
	}
	if (seen.size !== legalIds.size) {
		throw new InvalidChoiceAnswerError(
			`agent must place all ${legalIds.size} cards for choice ${request.id}`,
		);
	}
	const first = partitionGroups[0];
	const second = partitionGroups[1];
	assertDefined(first);
	assertDefined(second);
	return {
		groups: [[...first] as string[], [...second] as string[]],
	};
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

/**
 * A blocker blocks at most one attacker (CR 509.1a), and the request offers one
 * option per legal pair, so two options naming the same blocker conflict.
 *
 * Rejecting that here reports it as what it is — a bad answer to this choice —
 * rather than letting it reach the declare-blockers event, which throws
 * `IllegalBlockDeclarationError` from deep inside the turn-based actions and
 * tells an agent author nothing about which choice produced it.
 */
function normalizeBlockerAnswer(
	request: DeclareBlockersChoiceRequest,
	answer: ChoiceAnswer,
): { optionIds: string[] } {
	const normalized = normalizeMultiAnswer(request, answer);
	const blockers = new Set<ObjectId>();
	for (const id of normalized.optionIds) {
		const option = request.options.find((option) => option.id === id);
		assertDefined(option);
		const { blocker } = option.assignment;
		if (blockers.has(blocker)) {
			throw new InvalidChoiceAnswerError(
				`agent assigned blocker ${blocker} to more than one attacker for choice ${request.id}`,
			);
		}
		blockers.add(blocker);
	}
	return normalized;
}

export function priorityOptionId(action: PriorityAction): string {
	return `priority:${createHash("sha256")
		.update(canonicalize(action))
		.digest("hex")}`;
}

function priorityOptionLabel(
	engine: Engine,
	state: GameState,
	action: PriorityAction,
): string {
	switch (action.kind) {
		case "play land":
			return `play land ${objectLabel(engine, state, action.card)}#${action.card}`;
		case "activate ability": {
			// The ability's own rules text, not its `cardId:index` registry id:
			// a land with two mana abilities offers two options that are
			// indistinguishable when labelled by id.
			const ability = engine.getAbilityDefinition("activated", action.ability);
			return `activate ${objectLabel(engine, state, action.source)}#${action.source} — ${ability.text}`;
		}
		case "cast":
			return `cast ${objectLabel(engine, state, action.card)}#${action.card}`;
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
		private readonly engine: Engine,
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

	static record(
		engine: Engine,
		agents: SyncAgentPair,
	): ChoiceController<false> {
		return new ChoiceController(engine, agents, false);
	}

	static replay(
		engine: Engine,
		transcript: ChoiceTranscript,
	): ChoiceController<false> {
		return new ChoiceController(engine, null, false, transcript);
	}

	static suspending(
		engine: Engine,
		agents: AgentPair,
		transcript?: ChoiceTranscript,
	): ChoiceController<true> {
		return new ChoiceController(engine, agents, true, transcript);
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

	/**
	 * The answer to one request: replayed from the transcript while the cursor
	 * is still inside it, and asked of the agent once it is not.
	 *
	 * The caller decodes the answer, because only the caller knows which shape
	 * its choice takes. `invalid` is how it reports an answer it cannot use:
	 * a transcript that no longer fits the game being replayed is a replay
	 * mismatch, while a live agent that answers something illegal is an
	 * invalid answer, and the caller cannot tell those apart on its own.
	 */
	private ask(
		state: ReadonlyGameState,
		request: ChoiceRequest,
	): { answer: ChoiceAnswer; invalid: (message: string) => Error } {
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
			// A recorded answer the normalizer rejects is a broken transcript
			// rather than a misbehaving agent, so it reports as a mismatch.
			let answer: ChoiceAnswer;
			try {
				answer = normalizeAnswer(request, recorded.answer);
			} catch (error) {
				throw new ChoiceReplayMismatchError(
					`recorded answer for choice ${request.id} is not a valid answer: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
			this.cursor++;
			return {
				answer,
				invalid: (message) => new ChoiceReplayMismatchError(message),
			};
		}

		const agent = this.agents?.[request.player];
		if (!agent) {
			throw new ChoiceReplayMismatchError(
				`transcript ended before choice ${request.id}`,
			);
		}
		const answer = agent.choose(
			buildPlayerView(this.engine, state, request.player),
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
		this.decisions.push({
			request: clone(request),
			answer: clone(normalized),
		});
		this.cursor++;
		return {
			answer: normalized,
			invalid: (message) => new InvalidChoiceAnswerError(message),
		};
	}

	private choose<T>(
		state: ReadonlyGameState,
		request: ChoiceRequest,
		candidates: readonly { id: string; value: T }[],
	): T {
		const { answer, invalid } = this.ask(state, request);
		if (!("optionId" in answer)) {
			throw invalid(`choice ${request.id} requires a single-select answer`);
		}
		const candidate = candidates.find(
			(option) => option.id === answer.optionId,
		);
		if (!candidate) {
			throw invalid(
				`choice ${request.id} has no live candidate for ${answer.optionId}`,
			);
		}
		return candidate.value;
	}

	private chooseMulti<T>(
		state: ReadonlyGameState,
		request: ChoiceRequest,
		candidates: readonly { id: string; value: T }[],
	): T[] {
		const { answer, invalid } = this.ask(state, request);
		if (!("optionIds" in answer)) {
			throw invalid(`choice ${request.id} requires a multi-select answer`);
		}
		return answer.optionIds.map((id) => {
			const candidate = candidates.find((option) => option.id === id);
			if (!candidate) {
				throw invalid(`choice ${request.id} has no live candidate for ${id}`);
			}
			return candidate.value;
		});
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
						: `${objectLabel(this.engine, state, target.id)}#${target.id}`,
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
		const read = input.predicate ? createReadContext(this.engine, state) : null;
		const objects = input.objects.filter((id) => {
			if (!input.predicate) return true;
			assertDefined(read);
			return objectMatchesPredicate(
				input.predicate.definition,
				getSnapshot(read, id),
				input.predicate.context,
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
					label: `${objectLabel(this.engine, state, id)}#${id}`,
				})),
				...(input.optional
					? [{ id: "decline", label: input.optional.label }]
					: []),
			],
		});
		return this.choose(state, request, candidates);
	}

	/**
	 * Search one library for at most one eligible card. Qualified hidden-zone
	 * searches may fail to find; an unrestricted search must choose when the
	 * library is nonempty (CR 701.19b).
	 */
	searchLibrary(
		state: ReadonlyGameState,
		searcher: PlayerId,
		input: {
			owner: PlayerId;
			source: ObjectId;
			predicate?: {
				definition: ObjectPredicateDef;
				context: PredicateContext;
			};
		},
	): ObjectId | null {
		const read = createReadContext(this.engine, state);
		const cards: PlayerLibrarySearchCardView[] = state.players[
			input.owner
		].library
			.map((id): PlayerLibrarySearchCardView => {
				const card = getSnapshot(read, id);
				assert(
					card.kind === "card" && card.zone === "library",
					`library contains non-card object ${id}`,
				);
				return { ...card, zone: "library" };
			})
			.filter((card) =>
				input.predicate
					? objectMatchesPredicate(
							input.predicate.definition,
							card,
							input.predicate.context,
						)
					: true,
			);
		if (cards.length === 0) return null;

		const optional = input.predicate !== undefined;
		const candidates: { id: string; value: ObjectId | null }[] = cards.map(
			(card) => ({ id: String(card.objectId), value: card.objectId }),
		);
		if (optional) candidates.push({ id: "decline", value: null });
		const request = this.request({
			kind: "searchLibrary",
			player: searcher,
			context: {
				owner: input.owner,
				source: input.source,
				cards: cards.map((card) => structuredClone(card)),
				...(input.predicate ? { predicate: input.predicate.definition } : {}),
				optional,
			},
			options: [
				...cards.map((card) => ({
					id: String(card.objectId),
					label: `${card.currentCharacteristics.name}#${card.objectId}`,
				})),
				...(optional ? [{ id: "decline", label: "Find no card" }] : []),
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
				label: priorityOptionLabel(this.engine, state, action),
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
				label: `${objectLabel(this.engine, state, candidate.value.source)}#${candidate.value.source} — ${candidate.value.text}`,
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
				label: `${objectLabel(this.engine, state, id)}#${id}`,
				attacker: id,
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
		eligibleBlockerIds: ObjectId[],
	): BlockAssignment[] {
		if (attackers.length === 0 || eligibleBlockerIds.length === 0) return [];
		const candidates: { id: string; value: BlockAssignment }[] = [];
		for (const blocker of eligibleBlockerIds) {
			for (const attacker of attackers) {
				if (
					!eligibleBlockers(this.engine, state, player, attacker).includes(
						blocker,
					)
				)
					continue;
				candidates.push({
					id: blockAssignmentOptionId(blocker, attacker),
					value: { blocker, attacker },
				});
			}
		}
		if (candidates.length === 0) return [];
		const offeredBlockers = eligibleBlockerIds.filter((blocker) =>
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
				label: `${objectLabel(this.engine, state, candidate.value.blocker)}#${candidate.value.blocker} blocks ${objectLabel(this.engine, state, candidate.value.attacker)}#${candidate.value.attacker}`,
				assignment: candidate.value,
			})),
		});
		return this.chooseMulti(state, request, candidates);
	}

	/** Partition looked-at cards into two ordered destination groups. */
	choosePartition(
		state: GameState,
		player: PlayerId,
		cards: ObjectId[],
		reason: PartitionChoiceReason,
		groups: [PartitionChoiceGroup, PartitionChoiceGroup],
	): PartitionResult {
		assert(
			new Set(cards).size === cards.length,
			"partition candidates contain duplicate object ids",
		);
		assert(
			groups.every((group) => group.label.length > 0),
			"partition groups must have labels",
		);
		assert(
			groups[0].label !== groups[1].label,
			"partition group labels must be distinct",
		);
		for (const group of groups) {
			if (group.exactSize === undefined) continue;
			assert(
				Number.isSafeInteger(group.exactSize) &&
					group.exactSize >= 0 &&
					group.exactSize <= cards.length,
				`partition group ${group.label} has invalid exact size ${group.exactSize}`,
			);
		}
		if (
			groups[0].exactSize !== undefined &&
			groups[1].exactSize !== undefined
		) {
			assert(
				groups[0].exactSize + groups[1].exactSize === cards.length,
				"exact partition group sizes must place every card",
			);
		}
		if (cards.length === 0) return { groups: [[], []] };
		if (groups[0].exactSize === cards.length || groups[1].exactSize === 0) {
			return { groups: [[...cards], []] };
		}
		if (groups[1].exactSize === cards.length || groups[0].exactSize === 0) {
			return { groups: [[], [...cards]] };
		}
		const request = this.request({
			kind: "partition",
			player,
			context: { reason, cards: [...cards], groups },
			options: this.cardOptions(state, cards),
		});
		const { answer, invalid } = this.ask(state, request);
		if (!("groups" in answer)) {
			throw invalid(`choice ${request.id} requires a partition answer`);
		}
		return {
			groups: [
				answer.groups[0].map(objectForCardOption),
				answer.groups[1].map(objectForCardOption),
			],
		};
	}

	/** One option per looked-at card, in the order they were looked at. */
	private cardOptions(
		state: ReadonlyGameState,
		cards: readonly ObjectId[],
	): ChoiceOption[] {
		return cards.map((id) => ({
			id: cardOptionId(id),
			label: `${objectLabel(this.engine, state, id)}#${id}`,
		}));
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
	engine: Engine,
	source: ChoiceSource,
): ChoiceController<false> {
	return source instanceof ChoiceController
		? source
		: ChoiceController.record(engine, source);
}

export function targetOptionId(target: EntityRef): string {
	if (target.type === "player") return `player:${target.player}`;
	return `${target.type}:${target.id}`;
}
