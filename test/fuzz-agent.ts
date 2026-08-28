import type {
	ChoiceAnswer,
	ChoiceRequest,
	GameState,
	SyncAgent,
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

export class FuzzAgent implements SyncAgent {
	private readonly rng: () => number;

	constructor(seed: number) {
		this.rng = mulberry32(seed);
	}

	choose(_state: Readonly<GameState>, request: ChoiceRequest): ChoiceAnswer {
		if (request.kind === "declareAttackers") {
			return {
				optionIds: request.options
					.filter(() => this.rng() < 0.5)
					.map((option) => option.id),
			};
		}
		const option =
			request.options[Math.floor(this.rng() * request.options.length)];
		if (!option) throw new Error("fuzz agent received no options");
		return { optionId: option.id };
	}
}
