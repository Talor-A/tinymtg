import { createHash } from "node:crypto";
import type {
	AbilityStackItem,
	BoundReplacement,
	GameEvent,
	GameState,
	ObjectId,
	PlayerId,
	PriorityAction,
} from "./index.ts";

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

export interface OwnHandChoiceRequest extends ChoiceRequestBase {
	kind: "ownHand";
	context: { hand: ObjectId[] };
}

export interface OptionalChoiceRequest extends ChoiceRequestBase {
	kind: "optional";
	context: { ability: AbilityStackItem };
}

export interface PriorityActionChoiceRequest extends ChoiceRequestBase {
	kind: "priorityAction";
	context: {
		activePlayer: PlayerId;
		step: GameState["step"];
		stack: ObjectId[];
	};
}

export type ChoiceRequest =
	| ReplacementChoiceRequest
	| OwnHandChoiceRequest
	| OptionalChoiceRequest
	| PriorityActionChoiceRequest;

export interface ChoiceAnswer {
	optionId: string;
}

export interface SyncAgent {
	choose(state: Readonly<GameState>, request: ChoiceRequest): ChoiceAnswer;
}

/** The one engine-facing interface implemented by local and remote agents. */
export interface Agent {
	choose(
		state: Readonly<GameState>,
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
	| Omit<ReplacementChoiceRequest, "version" | "id" | "ordinal" | "fingerprint">
	| Omit<OwnHandChoiceRequest, "version" | "id" | "ordinal" | "fingerprint">
	| Omit<OptionalChoiceRequest, "version" | "id" | "ordinal" | "fingerprint">
	| Omit<
			PriorityActionChoiceRequest,
			"version" | "id" | "ordinal" | "fingerprint"
	  >;

function canonicalize(value: unknown, seen = new Set<object>()): string {
	if (value === null) return "null";
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

function assertValidAnswer(request: ChoiceRequest, answer: ChoiceAnswer): void {
	if (!answer || typeof answer.optionId !== "string") {
		throw new InvalidChoiceAnswerError(
			`agent returned an invalid answer for choice ${request.id}`,
		);
	}
	if (!request.options.some((option) => option.id === answer.optionId)) {
		throw new InvalidChoiceAnswerError(
			`agent selected ${answer.optionId} for choice ${request.id}; legal options: ${request.options.map((option) => option.id).join(", ")}`,
		);
	}
}

function priorityOptionId(action: PriorityAction): string {
	return `priority:${createHash("sha256")
		.update(canonicalize(action))
		.digest("hex")}`;
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
		assertValidAnswer(pending, answer);
		this.decisions.push({ request: clone(pending), answer: clone(answer) });
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
		state: GameState,
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
			const candidate = candidates.find(
				(option) => option.id === recorded.answer.optionId,
			);
			if (!candidate) {
				throw new ChoiceReplayMismatchError(
					`recorded answer ${recorded.answer.optionId} is not legal for choice ${request.id}`,
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
		const answer = agent.choose(state, request);
		if (isPromiseLike(answer)) {
			if (!this.allowSuspension) {
				throw new Error("an async agent was used outside advanceWithReplay()");
			}
			this.pendingRequest = clone(request);
			throw new ChoicePendingError(clone(request), answer);
		}
		assertValidAnswer(request, answer);
		const candidate = candidates.find(
			(option) => option.id === answer.optionId,
		);
		if (!candidate) {
			throw new InvalidChoiceAnswerError(
				`choice ${request.id} has no live candidate for ${answer.optionId}`,
			);
		}
		this.decisions.push({
			request: clone(request),
			answer: clone(answer),
		});
		this.cursor++;
		return candidate.value;
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

	chooseFromOwnHand(
		state: GameState,
		player: PlayerId,
		hand: ObjectId[],
	): ObjectId {
		const candidates = hand.map((id) => ({ id: String(id), value: id }));
		const request = this.request({
			kind: "ownHand",
			player,
			context: { hand: [...hand] },
			options: hand.map((id) => ({
				id: String(id),
				label: `${state.objects.get(id)?.cardId ?? "unknown"}#${id}`,
			})),
		});
		return this.choose(state, request, candidates);
	}

	chooseOptional(state: GameState, ability: AbilityStackItem): boolean {
		const player = ability.controller;
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
				activePlayer: state.activePlayer,
				step: state.step,
				stack: [...state.stack],
			},
			options: actions.map((action) => ({
				id: priorityOptionId(action),
				label: action.kind,
			})),
		});
		return this.choose(state, request, candidates);
	}
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
