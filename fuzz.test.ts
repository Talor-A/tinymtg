import { describe, expect, test } from "bun:test";
import "./cards.ts";
import type {
	AbilityStackItem,
	Agent,
	BoundReplacement,
	Color,
	GameEvent,
	GameState,
	ObjectId,
	PlayerId,
	PriorityAction,
} from "./index.ts";
import {
	addFloating,
	checkStateBasedActions,
	gameOver,
	newGame,
	perform,
	spawnCard,
	spawnPermanent,
	zoneList,
} from "./index.ts";

const ALL_CARDS = [
	"hardened-scales",
	"doubling-season",
	"walking-ballista",
	"grizzly-bears",
	"eager-cadet",
	"forest",
	"rest-in-peace",
	"leyline-of-the-void",
	"chains-of-mephistopheles",
	"necropotence",
	"furnace-of-rath",
	"palisade-giant",
	"mycosynth-lattice",
	"root-maze",
	"clone",
	"laboratory-maniac",
	"platinum-angel",
	"kalitas",
] as const;
const ALL_EVENTS = {
	addCounters: true,
	removeCounters: true,
	damage: true,
	destroy: true,
	regenerate: true,
	zoneChange: true,

	beginPhase: true,
	beginStep: true,
	loseGame: true,
	winGame: true,
	beginTurn: true,
	draw: true,
	discard: true,
	lifeChange: true,
	tap: true,
	createToken: true,
	untap: true,
} satisfies Record<GameEvent["kind"], true>;

const COLORS: Color[] = ["w", "u", "b", "r", "g"];

/** Deterministic xorshift-based PRNG so failures are reproducible. */
function mulberry32(seed: number): () => number {
	let t = seed >>> 0 || 1;
	return () => {
		t = (t + 0x6d2b79f5) >>> 0;
		let r = t;
		r = Math.imul(r ^ (r >>> 15), r | 1) >>> 0;
		r ^= Math.imul(r ^ (r >>> 7), r | 61) >>> 0;
		return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
	};
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
	if (arr.length === 0) throw new Error("pick from empty array");
	return arr[Math.floor(rng() * arr.length)]!;
}

function pickPlayer(rng: () => number): PlayerId {
	return rng() < 0.5 ? 0 : 1;
}

/** Agent that makes reproducible pseudo-random choices. */
export class FuzzAgent implements Agent {
	private rng: () => number;

	constructor(seed = 0) {
		this.rng = mulberry32(seed);
	}

	chooseReplacement(
		_state: GameState,
		_ev: GameEvent,
		options: BoundReplacement[],
	): BoundReplacement {
		return pick(this.rng, options);
	}

	chooseFromOwnHand(
		_state: GameState,
		_player: PlayerId,
		hand: ObjectId[],
	): ObjectId {
		return pick(this.rng, hand);
	}

	chooseOptional(_state: GameState, _ability: AbilityStackItem): boolean {
		return this.rng() < 0.5;
	}

	choosePriorityAction(
		state: GameState,
		actions: PriorityAction[],
	): PriorityAction {
		return pick(this.rng, actions);
	}
}

function randomObjectIn(
	state: GameState,
	rng: () => number,
	zone: "library" | "hand" | "graveyard" | "exile" | "battlefield" | "stack",
	owner?: PlayerId,
): ObjectId | null {
	const ids =
		zone === "battlefield"
			? state.battlefield
			: zone === "stack"
				? state.stack
				: ([0, 1] as const).flatMap((p) =>
						owner === undefined || owner === p ? zoneList(state, zone, p) : [],
					);
	return ids.length > 0 ? pick(rng, ids) : null;
}

function randomZone(
	rng: () => number,
): "library" | "hand" | "graveyard" | "exile" | "battlefield" {
	return pick(rng, ["library", "hand", "graveyard", "exile", "battlefield"]);
}

function randomCounter(rng: () => number) {
	return pick(rng, ["+1/+1", "-1/-1", "charge", "poison"] as const);
}

function buildFuzzState(rng: () => number): GameState {
	const state = newGame();

	// Seed each player's library so draw events have something to do.
	for (const p of [0, 1] as const) {
		for (let i = 0; i < 3 + Math.floor(rng() * 5); i++) {
			spawnCard(state, pick(rng, ALL_CARDS), p, "library");
		}
	}

	// Scatter some permanents on the battlefield for both players.
	for (let i = 0; i < 6 + Math.floor(rng() * 6); i++) {
		const owner = pickPlayer(rng);
		const cardId = pick(rng, ALL_CARDS);
		spawnPermanent(state, cardId, owner, "battlefield");
	}

	// Occasionally add floating one-shot effects.
	if (rng() < 0.4) {
		const target = randomObjectIn(state, rng, "battlefield");
		if (target !== null)
			addFloating(state, pickPlayer(rng), "regenerationShield", { target });
	}
	if (rng() < 0.4) {
		const targetPlayer = pickPlayer(rng);
		addFloating(state, pickPlayer(rng), "preventNextDamage", {
			targetType: "player",
			targetPlayer,
			amount: 1 + Math.floor(rng() * 4),
		});
	}
	if (rng() < 0.3) {
		addFloating(state, pickPlayer(rng), "prismaticStrands", {
			color: pick(rng, COLORS),
		});
	}
	if (rng() < 0.3) {
		addFloating(state, pickPlayer(rng), "gatherSpecimens", {
			you: pickPlayer(rng),
		});
	}

	return state;
}

function randomEvent(state: GameState, rng: () => number): GameEvent | null {
	const source = randomObjectIn(state, rng, "battlefield");
	const targetPermanent = randomObjectIn(state, rng, "battlefield");
	const handTarget = randomObjectIn(state, rng, "hand");

	const choices: (() => GameEvent | null)[] = [
		() => ({ kind: "draw", player: pickPlayer(rng) }),

		() =>
			source !== null
				? {
						kind: "damage",
						source,
						sourceController: state.objects.get(source)?.controller ?? 0,
						sourceColors: [pick(rng, COLORS)],
						target:
							rng() < 0.5 || targetPermanent === null
								? { type: "player", player: pickPlayer(rng) }
								: { type: "permanent", id: targetPermanent },
						amount: Math.floor(rng() * 5),
						combat: false,
						deathtouch: false,
						lifelink: false,
						unpreventable: rng() < 0.1,
					}
				: null,

		() =>
			targetPermanent !== null
				? {
						kind: "destroy",
						object: targetPermanent,
						noRegen: rng() < 0.2,
					}
				: null,

		() =>
			targetPermanent !== null
				? {
						kind: "addCounters",
						target: { type: "permanent", id: targetPermanent },
						counter: randomCounter(rng),
						amount: 1 + Math.floor(rng() * 3),
					}
				: null,

		() =>
			targetPermanent !== null
				? {
						kind: "removeCounters",
						target: { type: "permanent", id: targetPermanent },
						counters:
							rng() < 0.5
								? "all"
								: { [randomCounter(rng)]: 1 + Math.floor(rng() * 3) },
					}
				: null,

		() => ({
			kind: "lifeChange",
			player: pickPlayer(rng),
			delta: Math.floor(rng() * 11) - 5,
		}),

		() => {
			const from = randomZone(rng);
			const id = randomObjectIn(state, rng, from);
			if (id === null) return null;
			const to = randomZone(rng);
			const o = state.objects.get(id);
			if (!o) return null;
			return {
				kind: "zoneChange",
				object: id,
				from,
				to,
				cause: "effect",
				toController: o.controller,
			};
		},

		() =>
			handTarget !== null
				? {
						kind: "discard",
						player: state.players[0].hand.length > 0 ? 0 : 1,
						cards: { kind: "specific", card: handTarget },
					}
				: {
						kind: "discard",
						player: state.players[0].hand.length > 0 ? 0 : 1,
						cards: { kind: "any" },
					},
		() => ({
			kind: "discard",
			player: state.players[0].hand.length > 0 ? 0 : 1,
			cards: { kind: "hand-size" },
		}),
	];

	// Try a few times to produce a valid event.
	for (let attempt = 0; attempt < 8; attempt++) {
		const ev = pick(rng, choices)();
		if (ev) return ev;
	}
	return null;
}

interface FuzzResult {
	seed: number;
	ok: boolean;
	error?: Error;
	logTail?: string[];
	eventsApplied: number;
	eventKinds: Set<GameEvent["kind"]>;
}

function runFuzzCase(seed: number, eventsPerCase = 40): FuzzResult {
	const rng = mulberry32(seed);
	const state = buildFuzzState(rng);
	const agents: [Agent, Agent] = [new FuzzAgent(seed), new FuzzAgent(seed + 1)];
	const eventKinds = new Set<GameEvent["kind"]>();

	try {
		let applied = 0;
		for (let i = 0; i < eventsPerCase; i++) {
			if (gameOver(state)) break;
			const ev = randomEvent(state, rng);

			if (!ev) continue;
			eventKinds.add(ev.kind);
			perform(state, ev, agents);
			checkStateBasedActions(state, agents);
			applied++;
		}

		// Consistency invariants.
		for (const zone of ["library", "hand", "graveyard", "exile"] as const) {
			for (const p of [0, 1] as const) {
				for (const id of zoneList(state, zone, p)) {
					if (!state.objects.has(id)) {
						throw new Error(`stale id ${id} in ${zone} for P${p}`);
					}
				}
			}
		}
		for (const id of state.battlefield) {
			if (!state.objects.has(id)) {
				throw new Error(`stale id ${id} on battlefield`);
			}
		}

		return { seed, ok: true, eventsApplied: applied, eventKinds };
	} catch (error) {
		const tail = state.log.slice(-50);
		return {
			seed,
			ok: false,
			error: error instanceof Error ? error : new Error(String(error)),
			logTail: tail,
			eventsApplied: 0,
			eventKinds: new Set(),
		};
	}
}

function describeFailure(r: FuzzResult): string {
	const lines: string[] = [
		`Fuzz seed ${r.seed} failed: ${r.error?.message ?? "unknown error"}`,
	];
	if (r.logTail?.length) {
		lines.push("Last log lines:");
		lines.push(...r.logTail.map((l) => `  ${l}`));
	}
	lines.push(`Reproduce with: runFuzzCase(${r.seed})`);
	return lines.join("\n");
}

describe("tiny fuzzer", () => {
	test("random game states survive 200 fuzz cases", () => {
		const failures: FuzzResult[] = [];
		const eventKinds = new Set<GameEvent["kind"]>();
		for (let seed = 0; seed < 200; seed++) {
			const result = runFuzzCase(seed);
			if (!result.ok) failures.push(result);
			for (const kind of result.eventKinds) eventKinds.add(kind);
		}

		(Object.keys(ALL_EVENTS) as GameEvent["kind"][]).forEach((kind) => {
			expect(eventKinds).toContain(kind);
		});

		if (failures.length > 0) {
			console.error(failures.map(describeFailure).join("\n\n"));
		}
		expect(failures.length, `${failures.length} fuzz case(s) failed`).toBe(0);
	});
});
