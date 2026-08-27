import type {
	AbilityStackItem,
	Agent,
	BoundReplacement,
	GameEvent,
	GameState,
	ObjectId,
	PlayerId,
	PriorityAction,
} from "../index.ts";

/** Deterministic PRNG so fuzz choices and failures are reproducible. */
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

function pick<T>(rng: () => number, values: readonly T[]): T {
	const value = values[Math.floor(rng() * values.length)];
	if (value === undefined) throw new Error("pick from empty array");
	return value;
}

export class FuzzAgent implements Agent {
	private readonly rng: () => number;

	constructor(seed: number) {
		this.rng = mulberry32(seed);
	}

	chooseReplacement(
		_state: GameState,
		_event: GameEvent,
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
		_state: GameState,
		actions: PriorityAction[],
	): PriorityAction {
		return pick(this.rng, actions);
	}
}
