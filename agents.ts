import type {
	Agent,
	BoundReplacement,
	GameEvent,
	GameState,
	ObjectId,
	PlayerId,
} from "./index.ts";
import { randomElement } from "./lib/array.ts";
import { assertDefined } from "./lib/assert.ts";

export class ScriptedAgent implements Agent {
	constructor(public preferences: string[] = []) {}

	chooseReplacement(
		_state: GameState,
		_ev: GameEvent,
		options: BoundReplacement[],
	): BoundReplacement {
		assertDefined(options[0]);

		for (const pref of this.preferences) {
			const hit = options.find((o) =>
				o.label.toLowerCase().includes(pref.toLowerCase()),
			);
			if (hit) return hit;
		}
		return options[0];
	}

	chooseDiscard(
		_state: GameState,
		_player: PlayerId,
		hand: ObjectId[],
	): ObjectId {
		assertDefined(hand[0]);
		return hand[0];
	}
}

export class RandomAgent implements Agent {
	chooseReplacement(
		_state: GameState,
		_ev: GameEvent,
		options: BoundReplacement[],
	): BoundReplacement {
		assertDefined(options[0]);
		return randomElement(options);
	}

	chooseDiscard(
		_state: GameState,
		_player: PlayerId,
		hand: ObjectId[],
	): ObjectId {
		assertDefined(hand[0]);
		return randomElement(hand);
	}
}
