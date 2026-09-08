import type {
	ChoiceAnswer,
	ChoiceRequest,
	PlayerView,
	SyncAgent,
} from "../../index.ts";

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

	choose(_view: PlayerView, request: ChoiceRequest): ChoiceAnswer {
		if (request.kind === "triggerOrder") {
			return {
				optionIds: request.options
					.map((option) => ({ option, order: this.rng() }))
					.sort((left, right) => left.order - right.order)
					.map(({ option }) => option.id),
			};
		}
		if (request.kind === "declareAttackers") {
			return {
				optionIds: request.options
					.filter(() => this.rng() < 0.5)
					.map((option) => option.id),
			};
		}
		if (request.kind === "declareBlockers") {
			// A single blocker cannot be assigned to multiple attackers, so pick a
			// random subset and then keep only the first assignment for each blocker.
			const selected = request.options.filter(() => this.rng() < 0.5);
			const used = new Set<string>();
			return {
				optionIds: selected
					.filter((option) => {
						const blocker = option.id.split(":")[0];
						if (blocker === undefined) return false;
						if (used.has(blocker)) return false;
						used.add(blocker);
						return true;
					})
					.map((option) => option.id),
			};
		}
		if (request.kind === "scry" || request.kind === "surveil") {
			const shuffled = request.options
				.map((option) => ({ option, order: this.rng() }))
				.sort((left, right) => left.order - right.order)
				.map(({ option }) => option.id);
			const topCount = Math.floor(this.rng() * (shuffled.length + 1));
			return {
				top: shuffled.slice(0, topCount),
				bottom: shuffled.slice(topCount),
			};
		}
		const option =
			request.options[Math.floor(this.rng() * request.options.length)];
		if (!option) throw new Error("fuzz agent received no options");
		return { optionId: option.id };
	}
}
