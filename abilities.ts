import type {
	CardDef,
	EffectCtx,
	GameEvent,
	Keyword,
	ProhibitionDef,
	ReplacementEffectDefinition,
	TriggeredAbilityDefinition,
} from "./index.ts";
import { assert } from "./lib/assert";

/** CR 702.12b: a permanent with indestructible can't be destroyed. */
const INDESTRUCTIBLE_PROHIBITION: ProhibitionDef = {
	label: "keyword:indestructible",
	text: "This permanent can't be destroyed.",
	applies: (event, ctx) =>
		event.kind === "destroy" && event.object === ctx.self?.id,
};

export function printedEntryReplacements(
	def: Pick<CardDef, "entersTapped" | "entersWith" | "id" | "name">,
): ReplacementEffectDefinition[] {
	const out: ReplacementEffectDefinition[] = [];
	const entersSelf = (ev: GameEvent, ctx: EffectCtx): boolean =>
		ev.kind === "change zone" &&
		ev.destination.zone === "battlefield" &&
		ctx.self !== null &&
		ev.object === ctx.self.id;

	if (def.entersTapped) {
		out.push({
			label: `${def.id}:enters-tapped`,
			text: `${def.name} enters tapped.`,
			layer: "other",
			functionsFrom: "any",
			applies: (ev, ctx) =>
				entersSelf(ev, ctx) &&
				ev.kind === "change zone" &&
				ev.destination.zone === "battlefield" &&
				!ev.destination.tapped,
			replace: (ev) =>
				ev.kind === "change zone" && ev.destination.zone === "battlefield"
					? [{ ...ev, destination: { ...ev.destination, tapped: true } }]
					: [ev],
		});
	}

	const entersWith = def.entersWith;
	if (entersWith && Object.keys(entersWith).length > 0) {
		out.push({
			label: `${def.id}:enters-with`,
			text: `${def.name} enters with counters.`,
			layer: "other",
			functionsFrom: "any",
			applies: (ev, ctx) =>
				entersSelf(ev, ctx) &&
				ev.kind === "change zone" &&
				ev.destination.zone === "battlefield" &&
				ev.destination.counters === undefined,
			replace: (ev) =>
				ev.kind === "change zone" && ev.destination.zone === "battlefield"
					? [
							{
								...ev,
								destination: {
									...ev.destination,
									counters: { ...entersWith },
								},
							},
						]
					: [ev],
		});
	}
	return out;
}

/** Prohibitions supplied by an object's effective keyword abilities. */
export function prohibitionsFromKeywords(
	keywords: readonly Keyword[],
): ProhibitionDef[] {
	return keywords.includes("indestructible")
		? [INDESTRUCTIBLE_PROHIBITION]
		: [];
}

/**
 * CR 702.108a and CR 702.45a: prowess and bushido are triggered ability
 * keywords, so `keywords: ["prowess"]` and `keywords: ["bushido 1"]` are
 * authoring shorthand for one ordinary trigger each, and that is what they
 * compile to here.
 *
 * The keyword itself stays on the characteristics — "has prowess" is what an
 * ability-changing effect or a text reference would read — and the trigger it
 * stands for becomes a real registered ability. The possession reference is
 * copiable, so trigger detection does not have to re-synthesize a definition
 * from a keyword list.
 *
 * A creature that gains prowess would need the reference granted alongside the
 * keyword. The temporary keyword effect can grant only indestructible, so that
 * unsupported case cannot silently lose its trigger.
 */
export function printedKeywordTriggers(
	keywords: readonly Keyword[],
): TriggeredAbilityDefinition[] {
	// One ability per instance, not one per distinct keyword: CR 702.108b lets a
	// creature have prowess more than once, and each instance triggers
	// separately. Thor Odinson prints `K:Prowess` twice and gets +2/+2.
	const prowess = keywords
		.filter((keyword) => keyword === "prowess")
		.map(
			(): TriggeredAbilityDefinition => ({
				id: "prowess",
				text: "Whenever you cast a noncreature spell, this creature gets +1/+1 until end of turn.",
				condition: {
					kind: "cast",
					player: "you",
					predicate: {
						kind: "not",
						predicate: { kind: "type", type: "creature" },
					},
				},
				targets: [],
				effects: [
					{
						kind: "modify-pt",
						subject: { kind: "source" },
						power: 1,
						toughness: 1,
						duration: "until-end-of-turn",
					},
				],
			}),
		);

	// Bushido N is likewise one ability per printed instance, and N comes from
	// the keyword itself. Samurai of the Pale Curtain prints `K:Bushido:1`.
	const bushido = keywords.flatMap((keyword): TriggeredAbilityDefinition[] => {
		const match = keyword.match(/^bushido (\d+)$/);
		if (!match) return [];
		const amount = Number(match[1]);
		assert(
			Number.isSafeInteger(amount) && amount > 0,
			`bushido must grant a positive whole amount, got ${keyword}`,
		);
		return [
			{
				id: keyword,
				text: `Whenever this creature blocks or becomes blocked, it gets +${amount}/+${amount} until end of turn.`,
				condition: {
					kind: "declare blockers",
					subject: "self blocks or becomes blocked",
				},
				targets: [],
				effects: [
					{
						kind: "modify-pt",
						subject: { kind: "source" },
						power: amount,
						toughness: amount,
						duration: "until-end-of-turn",
					},
				],
			},
		];
	});

	return [...prowess, ...bushido];
}
