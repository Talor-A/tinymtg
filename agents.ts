import { readSync } from "node:fs";
import type {
	AbilityStackItem,
	Agent,
	BoundReplacement,
	GameEvent,
	GameState,
	ObjectId,
	PlayerId,
	PriorityAction,
} from "./index.ts";
import { randomElement } from "./lib/array.ts";
import { assert, assertDefined } from "./lib/assert.ts";

function readLineSync(): string {
	const buffer = Buffer.alloc(1);
	let result = "";
	while (true) {
		const bytesRead = readSync(process.stdin.fd, buffer, 0, 1, null);
		if (bytesRead === 0) break;
		const char = buffer.toString("utf8");
		if (char === "\n") break;
		if (char !== "\r") result += char;
	}
	return result;
}

function prompt(question: string): string {
	process.stdout.write(question);
	return readLineSync().trim();
}

function objectName(state: GameState, id: ObjectId): string {
	const o = state.objects.get(id);
	return o ? `${o.cardId}#${o.id}` : `<gone#${id}>`;
}

export class ScriptedAgent implements Agent {
	constructor(
		public preferences: string[] = [],
		public optionalChoices: boolean[] = [],
		public priorityActions: PriorityAction[] = [],
	) {}

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

	chooseFromOwnHand(
		_state: GameState,
		_player: PlayerId,
		hand: ObjectId[],
	): ObjectId {
		assertDefined(hand[0]);
		return hand[0];
	}

	chooseOptional(_state: GameState, _ability: AbilityStackItem): boolean {
		return this.optionalChoices.shift() ?? true;
	}

	choosePriorityAction(
		state: GameState,
		actions: PriorityAction[],
	): PriorityAction {
		assertDefined(actions[0]);
		return actions[0];
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

	chooseFromOwnHand(
		_state: GameState,
		_player: PlayerId,
		hand: ObjectId[],
	): ObjectId {
		assertDefined(hand[0]);
		return randomElement(hand);
	}

	chooseOptional(_state: GameState, _ability: AbilityStackItem): boolean {
		return randomElement([true, false]);
	}

	choosePriorityAction(
		_state: GameState,
		_actions: PriorityAction[],
	): PriorityAction {
		return randomElement(_actions);
	}
}

export class KeyboardAgent implements Agent {
	chooseReplacement(
		_state: GameState,
		ev: GameEvent,
		options: BoundReplacement[],
	): BoundReplacement {
		assertDefined(options[0]);
		console.log(`\n[Replacement choice for ${ev.kind}]`);
		for (let i = 0; i < options.length; i++) {
			console.log(`  ${i + 1}. ${options[i]?.label}`);
		}
		while (true) {
			const input = prompt(`Pick 1-${options.length}: `);
			const n = Number.parseInt(input, 10);
			if (!Number.isNaN(n) && n >= 1 && n <= options.length) {
				return options[n - 1]!;
			}
			console.log("Invalid input, try again.");
		}
	}

	chooseFromOwnHand(
		state: GameState,
		player: PlayerId,
		hand: ObjectId[],
	): ObjectId {
		assertDefined(hand[0]);
		console.log(`\n[Player ${player}: choose a card to discard]`);
		for (let i = 0; i < hand.length; i++) {
			console.log(`  ${i + 1}. ${objectName(state, hand[i]!)}`);
		}
		while (true) {
			const input = prompt(`Pick 1-${hand.length}: `);
			const n = Number.parseInt(input, 10);
			if (!Number.isNaN(n) && n >= 1 && n <= hand.length) {
				return hand[n - 1]!;
			}
			console.log("Invalid input, try again.");
		}
	}

	chooseOptional(_state: GameState, ability: AbilityStackItem): boolean {
		console.log(`\n[Optional ability: ${ability.text}]`);
		while (true) {
			const input = prompt("Use it? (y/n): ").toLowerCase();
			if (input === "y" || input === "yes") return true;
			if (input === "n" || input === "no") return false;
			console.log("Invalid input, try again.");
		}
	}

	choosePriorityAction(
		state: GameState,
		actions: PriorityAction[],
	): PriorityAction {
		console.log(`\n[Priority action choice]`);
		for (let i = 0; i < actions.length; i++) {
			console.log(`  ${i + 1}. ${actions[i]?.kind}`);
		}
		while (true) {
			const input = prompt(`Pick 1-${actions.length}: `);
			const n = Number.parseInt(input, 10);
			if (!Number.isNaN(n) && n >= 1 && n <= actions.length) {
				const action = actions[n - 1];
				assert(action);
				return action;
			}
			console.log("Invalid input, try again.");
		}
	}
}
