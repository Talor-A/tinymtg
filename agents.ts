import { readSync } from "node:fs";
import type {
	ChoiceAnswer,
	ChoiceRequest,
	GameState,
	ObjectId,
	PriorityAction,
	SyncAgent,
} from "./index.ts";
import { randomElement } from "./lib/array.ts";
import { assertDefined, assertNever } from "./lib/assert.ts";

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

function firstOption(request: ChoiceRequest): ChoiceAnswer {
	const option = request.options[0];
	assertDefined(option);
	return { optionId: option.id };
}

export class ScriptedAgent implements SyncAgent {
	constructor(
		public preferences: string[] = [],
		public optionalChoices: boolean[] = [],
		public priorityActions: PriorityAction[] = [],
		public attackerChoices: ObjectId[][] = [],
	) {}

	choose(_state: Readonly<GameState>, request: ChoiceRequest): ChoiceAnswer {
		switch (request.kind) {
			case "replacement":
				for (const preference of this.preferences) {
					const option = request.options.find((candidate) =>
						candidate.label.toLowerCase().includes(preference.toLowerCase()),
					);
					if (option) return { optionId: option.id };
				}
				return firstOption(request);

			case "ownHand":
				return firstOption(request);

			case "optional":
				return {
					optionId: (this.optionalChoices.shift() ?? true) ? "yes" : "no",
				};

			case "priorityAction": {
				const preferred = this.priorityActions.shift();
				const option = preferred
					? request.options.find((candidate) =>
							candidate.label.includes(preferred.kind),
						)
					: undefined;
				return option ? { optionId: option.id } : firstOption(request);
			}

			case "declareAttackers": {
				const attackers = this.attackerChoices.shift() ?? [];
				return { optionIds: attackers.map((id) => String(id)) };
			}

			default:
				return assertNever(request);
		}
	}
}

export class RandomAgent implements SyncAgent {
	choose(_state: Readonly<GameState>, request: ChoiceRequest): ChoiceAnswer {
		switch (request.kind) {
			case "declareAttackers":
				return {
					optionIds: request.options
						.filter(() => Math.random() < 0.5)
						.map((option) => option.id),
				};
			case "replacement":
			case "ownHand":
			case "optional":
			case "priorityAction":
				return { optionId: randomElement(request.options).id };
			default:
				return assertNever(request);
		}
	}
}

export class KeyboardAgent implements SyncAgent {
	choose(_state: Readonly<GameState>, request: ChoiceRequest): ChoiceAnswer {
		switch (request.kind) {
			case "replacement":
				console.log(`\n[Replacement choice for ${request.context.event.kind}]`);
				break;
			case "ownHand":
				console.log(`\n[Player ${request.player}: choose a card to discard]`);
				break;
			case "optional":
				console.log(`\n[Optional ability: ${request.context.ability.text}]`);
				break;
			case "priorityAction":
				console.log("\n[Priority action choice]");
				break;
			case "declareAttackers":
				return this.chooseAttackers(request);
			default:
				return assertNever(request);
		}

		for (let i = 0; i < request.options.length; i++) {
			console.log(`  ${i + 1}. ${request.options[i]?.label}`);
		}
		while (true) {
			const input = prompt(`Pick 1-${request.options.length}: `);
			const index = Number.parseInt(input, 10) - 1;
			const option = request.options[index];
			if (option) return { optionId: option.id };
			console.log("Invalid input, try again.");
		}
	}

	private chooseAttackers(
		request: Extract<ChoiceRequest, { kind: "declareAttackers" }>,
	): ChoiceAnswer {
		console.log(`\n[Player ${request.player}: declare attackers]`);
		for (let i = 0; i < request.options.length; i++) {
			console.log(`  ${i + 1}. ${request.options[i]?.label}`);
		}
		while (true) {
			const input = prompt(
				"Attackers (comma-separated numbers, blank for none): ",
			);
			const trimmed = input.trim();
			if (trimmed === "") return { optionIds: [] };

			const parts = trimmed.split(",").map((part) => part.trim());
			if (parts.some((part) => !/^\d+$/.test(part))) {
				console.log("Invalid input, try again.");
				continue;
			}
			const indices = parts.map((part) => Number.parseInt(part, 10) - 1);
			if (new Set(indices).size !== indices.length) {
				console.log("Duplicate selection, try again.");
				continue;
			}
			const options = indices.map((index) => request.options[index]);
			if (options.some((option) => !option)) {
				console.log("Invalid input, try again.");
				continue;
			}
			return {
				optionIds: options.map((option) => {
					assertDefined(option);
					return option.id;
				}),
			};
		}
	}
}
