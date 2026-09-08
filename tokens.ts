import { characteristicsFromCardDef, registerCard } from "./index.ts";

/**
 * Clue token
 * {2}, Sacrifice this token: Draw a card.
 *
 * Forge: tokenscripts/c_a_clue_draw.txt
 */
export const CLUE_TOKEN = characteristicsFromCardDef(
	registerCard({
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
						selector: { kind: "self" },
						amount: 1,
					},
				},
				targets: [],
				effects: [{ kind: "draw", player: "you", amount: 1 }],
			},
		],
	}),
);
