import { readSync } from "node:fs";
import {
	blockAssignmentOptionId,
	priorityOptionId,
	targetOptionId,
} from "./choices.ts";
import type {
	BlockAssignment,
	ChoiceAnswer,
	ChoiceRequest,
	EntityRef,
	ObjectId,
	PlayerView,
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
		public blockerChoices: BlockAssignment[][] = [],
		public targetChoices: EntityRef[] = [],
		public scryChoices: { top: ObjectId[]; bottom: ObjectId[] }[] = [],
		public sacrificeChoices: ObjectId[] = [],
		public surveilChoices: { top: ObjectId[]; bottom: ObjectId[] }[] = [],
		public chooseFromTopChoices: {
			kept: ObjectId[];
			bottom: ObjectId[];
		}[] = [],
		public searchChoices: (ObjectId | null)[] = [],
	) {}

	choose(_view: PlayerView, request: ChoiceRequest): ChoiceAnswer {
		switch (request.kind) {
			case "replacement":
				for (const preference of this.preferences) {
					const option = request.options.find((candidate) =>
						candidate.label.toLowerCase().includes(preference.toLowerCase()),
					);
					if (option) return { optionId: option.id };
				}
				return firstOption(request);

			case "target": {
				const target = this.targetChoices.shift();
				return target
					? { optionId: targetOptionId(target) }
					: firstOption(request);
			}

			case "object": {
				if (request.context.reason.kind !== "sacrifice")
					return firstOption(request);
				const permanent = this.sacrificeChoices.shift();
				return permanent
					? { optionId: String(permanent) }
					: firstOption(request);
			}

			case "searchLibrary": {
				const card = this.searchChoices.shift();
				return card === null
					? { optionId: "decline" }
					: card === undefined
						? firstOption(request)
						: { optionId: String(card) };
			}

			case "mana":
				return firstOption(request);

			case "optional":
				return {
					optionId: (this.optionalChoices.shift() ?? true) ? "yes" : "no",
				};

			case "priorityAction": {
				const preferred = this.priorityActions[0];
				const option = preferred
					? request.options.find(
							(candidate) => candidate.id === priorityOptionId(preferred),
						)
					: undefined;
				if (option) this.priorityActions.shift();
				return option ? { optionId: option.id } : firstOption(request);
			}

			case "triggerOrder":
				return { optionIds: request.options.map((option) => option.id) };

			case "declareAttackers": {
				const attackers = this.attackerChoices.shift() ?? [];
				return { optionIds: attackers.map((id) => String(id)) };
			}

			case "declareBlockers": {
				const blockers = this.blockerChoices.shift() ?? [];
				return {
					optionIds: blockers.map(({ blocker, attacker }) =>
						blockAssignmentOptionId(blocker, attacker),
					),
				};
			}

			case "partition": {
				switch (request.context.reason) {
					case "scry": {
						const arrangement = this.scryChoices.shift() ?? {
							top: request.context.cards,
							bottom: [],
						};
						return {
							groups: [
								arrangement.top.map(String),
								arrangement.bottom.map(String),
							],
						};
					}
					case "surveil": {
						const arrangement = this.surveilChoices.shift() ?? {
							top: request.context.cards,
							bottom: [],
						};
						return {
							groups: [
								arrangement.top.map(String),
								arrangement.bottom.map(String),
							],
						};
					}
					case "choose-from-top": {
						const keep = request.context.groups[0].exactSize;
						assertDefined(keep);
						const arrangement = this.chooseFromTopChoices.shift() ?? {
							kept: request.context.cards.slice(0, keep),
							bottom: request.context.cards.slice(keep),
						};
						return {
							groups: [
								arrangement.kept.map(String),
								arrangement.bottom.map(String),
							],
						};
					}
					default:
						return assertNever(request.context.reason);
				}
			}

			default:
				return assertNever(request);
		}
	}
}

export class RandomAgent implements SyncAgent {
	choose(_view: PlayerView, request: ChoiceRequest): ChoiceAnswer {
		switch (request.kind) {
			case "declareAttackers":
				return {
					optionIds: request.options
						.filter(() => Math.random() < 0.5)
						.map((option) => option.id),
				};
			case "declareBlockers": {
				// A blocker appears in one option per attacker it may block, and
				// may be assigned to only one of them, so take the first coin flip
				// that comes up for each blocker and skip that blocker's rest.
				const assigned = new Set<ObjectId>();
				const optionIds: string[] = [];
				for (const option of request.options) {
					const { blocker } = option.assignment;
					if (assigned.has(blocker)) continue;
					if (Math.random() >= 0.5) continue;
					assigned.add(blocker);
					optionIds.push(option.id);
				}
				return { optionIds };
			}
			case "triggerOrder":
				return {
					optionIds: request.options
						.map((option) => ({ option, order: Math.random() }))
						.sort((left, right) => left.order - right.order)
						.map(({ option }) => option.id),
				};
			case "partition": {
				const shuffled = request.options
					.map((option) => ({ option, order: Math.random() }))
					.sort((left, right) => left.order - right.order)
					.map(({ option }) => option.id);
				const firstExact = request.context.groups[0].exactSize;
				const secondExact = request.context.groups[1].exactSize;
				const firstCount =
					firstExact ??
					(secondExact === undefined
						? Math.floor(Math.random() * (shuffled.length + 1))
						: shuffled.length - secondExact);
				return {
					groups: [shuffled.slice(0, firstCount), shuffled.slice(firstCount)],
				};
			}
			case "replacement":
			case "object":
			case "target":
			case "optional":
			case "priorityAction":
			case "mana":
			case "searchLibrary":
				return { optionId: randomElement(request.options).id };
			default:
				return assertNever(request);
		}
	}
}

export class KeyboardAgent implements SyncAgent {
	choose(_view: PlayerView, request: ChoiceRequest): ChoiceAnswer {
		switch (request.kind) {
			case "replacement":
				console.log(`\n[Replacement choice for ${request.context.event.kind}]`);
				break;
			case "object":
				switch (request.context.reason.kind) {
					case "copy":
						console.log(
							`\n[Player ${request.player}: choose what #${request.context.reason.source} enters as]`,
						);
						break;
					case "discard":
						console.log(
							`\n[Player ${request.player}: choose a card to discard]`,
						);
						break;
					case "sacrifice":
						console.log(
							`\n[Player ${request.player}: choose a permanent to sacrifice]`,
						);
						break;
					case "select":
						console.log(
							`\n[Player ${request.player}: ${request.context.reason.prompt}]`,
						);
						break;
					default:
						return assertNever(request.context.reason);
				}
				break;
			case "searchLibrary":
				console.log(
					`\n[Player ${request.player}: search player ${request.context.owner}'s library]`,
				);
				break;
			case "target":
				console.log(
					`\n[Player ${request.player}: choose target for ${request.context.announcing} from #${request.context.source}]`,
				);
				break;
			case "mana":
				console.log(
					`\n[Player ${request.player}: choose mana for ability ${request.context.ability}]`,
				);
				break;
			case "optional":
				console.log(`\n[Optional ability: ${request.context.ability.text}]`);
				break;
			case "priorityAction":
				console.log("\n[Priority action choice]");
				break;
			case "triggerOrder":
				return this.chooseTriggerOrder(request);
			case "declareAttackers":
				return this.chooseAttackers(request);
			case "declareBlockers":
				return this.chooseBlockers(request);
			case "partition":
				return this.choosePartition(request);
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

	private chooseTriggerOrder(
		request: Extract<ChoiceRequest, { kind: "triggerOrder" }>,
	): ChoiceAnswer {
		console.log(`\n[Player ${request.player}: order simultaneous triggers]`);
		for (let i = 0; i < request.options.length; i++) {
			console.log(`  ${i + 1}. ${request.options[i]?.label}`);
		}
		while (true) {
			const input = prompt(
				"Stack order, bottom first (comma-separated numbers): ",
			);
			const parts = input.split(",").map((part) => part.trim());
			const indices = parts.map((part) => Number.parseInt(part, 10) - 1);
			if (
				parts.some((part) => !/^\d+$/.test(part)) ||
				indices.length !== request.options.length ||
				new Set(indices).size !== indices.length
			) {
				console.log("Enter every trigger exactly once.");
				continue;
			}
			const options = indices.map((index) => request.options[index]);
			if (options.some((option) => !option)) {
				console.log("Invalid input, try again.");
				continue;
			}
			const optionIds: string[] = [];
			for (const option of options) {
				assertDefined(option);
				optionIds.push(option.id);
			}
			return { optionIds };
		}
	}

	private choosePartition(
		request: Extract<ChoiceRequest, { kind: "partition" }>,
	): ChoiceAnswer {
		const [firstDefinition, secondDefinition] = request.context.groups;
		console.log(
			`\n[Player ${request.player}: ${request.context.reason}; partition cards into ${firstDefinition.label} and ${secondDefinition.label}]`,
		);
		for (let i = 0; i < request.options.length; i++) {
			console.log(`  ${i + 1}. ${request.options[i]?.label}`);
		}
		while (true) {
			const input = prompt(
				`${firstDefinition.label}, then ${secondDefinition.label} (for example 2,1 / 3): `,
			);
			const sides = input.split("/");
			if (sides.length !== 2) {
				console.log("Separate the two groups with /.");
				continue;
			}
			const parse = (side: string | undefined): number[] | null => {
				const trimmed = side?.trim() ?? "";
				if (trimmed === "") return [];
				const parts = trimmed.split(",").map((part) => part.trim());
				if (parts.some((part) => !/^\d+$/.test(part))) return null;
				return parts.map((part) => Number.parseInt(part, 10) - 1);
			};
			const first = parse(sides[0]);
			const second = parse(sides[1]);
			if (!first || !second) {
				console.log("Invalid input, try again.");
				continue;
			}
			const indices = [...first, ...second];
			if (
				indices.length !== request.options.length ||
				new Set(indices).size !== indices.length ||
				indices.some((index) => !request.options[index]) ||
				(firstDefinition.exactSize !== undefined &&
					first.length !== firstDefinition.exactSize) ||
				(secondDefinition.exactSize !== undefined &&
					second.length !== secondDefinition.exactSize)
			) {
				console.log(
					"Enter every card exactly once with the required group sizes.",
				);
				continue;
			}
			return {
				groups: [
					first.map((index) => request.options[index]?.id ?? ""),
					second.map((index) => request.options[index]?.id ?? ""),
				],
			};
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

	private chooseBlockers(
		request: Extract<ChoiceRequest, { kind: "declareBlockers" }>,
	): ChoiceAnswer {
		console.log(`\n[Player ${request.player}: declare blockers]`);
		for (let i = 0; i < request.options.length; i++) {
			console.log(`  ${i + 1}. ${request.options[i]?.label}`);
		}
		while (true) {
			const input = prompt(
				"Blockers (comma-separated numbers, blank for none): ",
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
