import { characteristicsFromCardDef, defineCard } from "./index.ts";

/**
 * Clue token
 * {2}, Sacrifice this token: Draw a card.
 *
 * Forge: tokenscripts/c_a_clue_draw.txt
 */
export const CLUE_CARD = defineCard({
	id: "clue-token",
	name: "Clue Token",
	manaCost: "none",
	colors: [],
	types: ["artifact"],
	subtypes: ["Clue"],
	activatedAbilities: [
		{
			kind: "activated",
			id: "draw-card",
			text: "{2}, Sacrifice this token: Draw a card.",
			cost: {
				mana: { n: 2 },
				tapSelf: false,
				sacrifice: {
					predicate: { kind: "self" },
					amount: 1,
				},
			},
			targets: [],
			effects: [
				{
					kind: "draw",
					subject: { kind: "relative-player", player: "you" },
					amount: 1,
				},
			],
		},
	],
});

export const CLUE_TOKEN = characteristicsFromCardDef(CLUE_CARD);
