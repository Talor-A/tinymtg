import {
	type Color,
	etbPreview,
	type ObjectId,
	type PlayerId,
	type ReplacementDef,
} from ".";

type EffectFactory = (
	params: Record<string, number | string>,
) => ReplacementDef;
const gatherSpecimens: EffectFactory = (params) => {
	const you = params.you as PlayerId;
	return {
		label: `gather:${you}`,
		layer: "control",
		functionsFrom: "any",
		text: "If a creature would enter the battlefield under an opponent's control this turn, it enters under your control instead.",
		applies(ev, ctx) {
			if (ev.kind !== "change zone" || ev.to !== "battlefield") return false;
			if (ev.toController === you) return false;
			return etbPreview(ctx.state, ev).currentCharacteristics.types.includes(
				"creature",
			);
		},
		replace: (ev) =>
			ev.kind === "change zone" ? [{ ...ev, toController: you }] : [ev],
	};
};
const preventNextDamage: EffectFactory = (params) => {
	const targetType = params.targetType as "player" | "permanent";
	const target =
		targetType === "player"
			? { type: "player" as const, player: params.targetPlayer as PlayerId }
			: { type: "permanent" as const, id: params.targetId as ObjectId };
	const n = params.amount as number;
	return {
		label: `shield:${n}`,
		layer: "other",
		isPreventionEffect: true,
		text: `Prevent the next ${n} damage that would be dealt to ${
			target.type === "player" ? `P${target.player}` : `#${target.id}`
		} this turn.`,
		functionsFrom: "any",
		applies(ev, ctx) {
			if (ev.kind !== "damage" || ev.amount <= 0) return false;
			if ((ctx.data.remaining ?? 0) <= 0) return false;
			return (
				ev.target.type === target.type &&
				(target.type === "player"
					? ev.target.type === "player" && ev.target.player === target.player
					: ev.target.type === "permanent" && ev.target.id === target.id)
			);
		},
		replace(ev, ctx) {
			if (ev.kind !== "damage") return [ev];
			const prevented = Math.min(ev.amount, ctx.data.remaining ?? 0);
			const remaining = ev.amount - prevented;
			// Fully prevented damage is replaced by *nothing* — not by 0 damage.
			return remaining > 0 ? [{ ...ev, amount: remaining }] : [];
		},
		onApplied(ev, ctx) {
			if (ev.kind !== "damage") return;
			ctx.data.remaining = Math.max(0, (ctx.data.remaining ?? 0) - ev.amount);
		},
	};
};
const prismaticStrands: EffectFactory = (params): ReplacementDef => {
	const color = params.color as Color;
	return {
		label: `strands:${color}`,
		layer: "other",
		isPreventionEffect: true,
		functionsFrom: "any",
		text: `Prevent all damage that ${color} sources would deal this turn.`,
		applies: (ev) => ev.kind === "damage" && ev.sourceColors.includes(color),
		replace: () => [],
	};
};

const regenerationShield: EffectFactory = (params): ReplacementDef => {
	const target = params.target as ObjectId;
	return {
		label: `regen:${target}`,
		layer: "other",
		functionsFrom: "any",
		text: `Regeneration shield on #${target}.`,
		applies: (ev, ctx) =>
			ev.kind === "destroy" &&
			ev.object === target &&
			!ev.noRegen &&
			(ctx.data.used ?? 0) === 0,
		replace: (ev) =>
			ev.kind === "destroy"
				? [{ kind: "regenerate", object: ev.object }]
				: [ev],
		onApplied: (_ev, ctx) => {
			ctx.data.used = 1;
		},
	};
};

export {
	gatherSpecimens,
	preventNextDamage,
	prismaticStrands,
	regenerationShield,
};
