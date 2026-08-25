import { Terminal } from "bun";
import { assert, assertDefined, assertNever } from "./lib/assert";

interface CardCommon {
	name: string;
	cost: ManaCost | undefined;
}

interface PermanentCard extends CardCommon {
	kind: "permanent";

	supertypes?: {
		basic?: true;
	};
	types: {
		creature?: {
			[key: string]: true;
		};
		land?: {
			forest?: boolean;
			island?: boolean;
			plains?: boolean;
			swamp?: boolean;
			mountain?: boolean;
		};
		artifact?: true;
		enchantment?: true;
		instant?: never;
		sorcery?: never;
	};
}

interface SpellCard extends CardCommon {
	kind: "spell";

	types: {
		creature?: never;
		land?: never;
		artifact?: never;
		enchantment?: never;
		instant?: true;
		sorcery?: true;
	};
}

type Card = PermanentCard | SpellCard;

interface Permanent {
	kind: "permanent";
	types?: {
		creature?: {
			[key: string]: true;
		};
		land?: {
			forest?: boolean;
			island?: boolean;
			plains?: boolean;
			swamp?: boolean;
			mountain?: boolean;
		};
		artifact?: true;
		enchantment?: true;
		instant?: never;
		sorcery?: never;
	};

	token?: boolean;
	tapped?: boolean;
	attacking?: boolean;
	card: Card;
}
interface CreaturePermanent extends Permanent {
	power: number;
	toughness: number;
	damage: number;
	types: {
		creature: {
			[key: string]: true;
		};
	};
}

interface Ability {}

/** a player in the game. */
interface Player {
	name: string;
	chooseSpellOrAbility: (
		state: InprogressGameState,
		actions: Action[],
	) => Action;
	declareAttackers: (
		state: InprogressGameState,
		attackers: Permanent[],
	) => Permanent[];
	declareBlockers: (
		state: InprogressGameState,
		attackers: Permanent[],
		blockers: Permanent[],
	) => Map<Permanent, Permanent[]>;
}

interface PlayLandAction {
	type: "play land";
	land: Card;
}

interface CastAction {
	type: "cast";
	spell: Card;
	plan: CastPlan;
}

interface PassAction {
	type: "pass";
}
type Action = PlayLandAction | CastAction | PassAction;

const DEFAULT_PHASES = [
	"untap",
	"upkeep",
	"draw",
	"main",
	"end",
	"cleanup",
] as const;

type Phase =
	| "untap"
	| "upkeep"
	| "draw"
	| "main"
	| "begin combat"
	| "declare attackers"
	| "declare blockers"
	| "after damage"
	| "end"
	| "cleanup";

interface GameStateCommon {
	players: [Player, Player];
	life: [number, number];
	starting: 0 | 1;
	step: number;
	zones: {
		stack: StackEntry[];
		graveyard: [Card[], Card[]];
		battlefield: [Permanent[], Permanent[]];
		hand: [Card[], Card[]];
		library: [Card[], Card[]];
		exile: [Card[], Card[]];
	};
	/** the player whose turn it is */
	activePlayer: 0 | 1;
	phases: Phase[];
	thisTurn: {
		landsPlayed: [number, number];
	};
	delayedTriggers: DelayedTrigger[];
}

interface DelayedTrigger {
	/** @returns true if the trigger happened. */
	match: (state: GameState) => boolean;
	controller: 0 | 1;
}

interface TerminalGameState extends GameStateCommon {
	state: "terminal";
	winner: Player;
}

interface PregameGameState extends GameStateCommon {
	state: "pregame";
}

interface InprogressGameState extends GameStateCommon {
	state: "inprogress";
	cache: {
		__attackers: Permanent[];
		__blockers: Map<Permanent, Permanent[]> | null;
	};
}

type GameState = PregameGameState | InprogressGameState | TerminalGameState;

interface CastStackEntry {
	type: "cast";
	card: Card;
	controller: 0 | 1;
}
interface AbilityStackEntry {
	type: "ability";
	ability: Ability;
}
type StackEntry = CastStackEntry | AbilityStackEntry;
function newGame(
	players: [
		starting: { player: Player; library: Card[] },
		second: { player: Player; library: Card[] },
	],
): PregameGameState {
	return {
		state: "pregame",
		life: [20, 20],
		players: [players[0].player, players[1].player],
		starting: 0,
		step: 0,
		zones: {
			stack: [],
			library: [players[0].library, players[1].library],
			battlefield: [[], []],
			hand: [[], []],
			graveyard: [[], []],
			exile: [[], []],
		},
		thisTurn: {
			landsPlayed: [0, 0],
		},
		activePlayer: 0,
		phases: [...DEFAULT_PHASES],
		delayedTriggers: [],
	};
}
function openingHands(state: PregameGameState) {
	completeDraw(state, 0, 7);
	completeDraw(state, 1, 7);
}

/** completes a valid draw. doesn't check legality, throws if not enough cards. */
function completeDraw<T extends GameState>(
	state: T,
	player: 0 | 1,
	count: number,
): T {
	const library = [...state.zones.library[player]];
	const hand = [...state.zones.hand[player]];

	assert(library.length >= count, "Not enough cards in library to draw");

	const newHand = [...hand, ...library.slice(0, count)];
	const newLibrary = library.slice(count);

	assert(newHand.length === hand.length + count, "Hand size mismatch");
	assert(newLibrary.length === library.length - count, "Library size mismatch");

	state.zones.hand[player] = newHand;
	state.zones.library[player] = newLibrary;
	return state;
}

function step(
	state: PregameGameState | InprogressGameState,
): InprogressGameState | TerminalGameState {
	state.step++;
	if (state.state === "pregame") {
		openingHands(state);
		return {
			...state,
			state: "inprogress",
			cache: { __attackers: [], __blockers: null },
		};
	}

	return handlePhase(state);
}

function isCreaturePermanent(
	permanent: Permanent,
): permanent is CreaturePermanent {
	if (!permanent.types?.creature) return false;
	assert("power" in permanent, "Creature permanent must have power");
	return true;
}

function discardToHandSize(
	state: InprogressGameState,
	player: 0 | 1,
	handSize: number,
): void {
	const hand = state.zones.hand[player];
	if (hand.length <= handSize) return;
	const countToDiscard = hand.length - handSize;
	const discarded = hand.slice(-countToDiscard);
	state.zones.hand[player] = hand.slice(0, -countToDiscard);
	state.zones.graveyard[player] = [
		...state.zones.graveyard[player],
		...discarded,
	];

	assert(
		state.zones.hand[player].length <= handSize,
		`Hand size should be ${handSize} after discarding`,
	);
	assert(
		state.zones.graveyard[player].length >= discarded.length,
		`Graveyard should have ${discarded.length} cards after discarding`,
	);
}

function canPlayLand(state: InprogressGameState, player: 0 | 1): boolean {
	if (player !== state.activePlayer) return false;
	if (state.thisTurn.landsPlayed[player] !== 0) return false;
	if (state.phases[0] !== "main") return false;
	return true;
}

interface ManaCost {
	w?: number;
	u?: number;
	b?: number;
	r?: number;
	g?: number;
	c?: number;
}
function cmc(cost: ManaCost): number {
	return Object.values(cost).reduce((acc, cost) => acc + (cost ?? 0), 0);
}

interface CastPlan {
	tap: Permanent[];
}

const colorToBasicLand = {
	w: "plains",
	u: "island",
	b: "swamp",
	r: "mountain",
	g: "forest",
} as const;

function getCastPlan(
	state: InprogressGameState,
	player: 0 | 1,
	card: Card,
): CastPlan | null {
	assertDefined(card.cost);
	const cost = cmc(card.cost);
	const landsInPlay = state.zones.battlefield[player].filter(
		(permanent) => permanent.card.types.land && !permanent.tapped,
	);
	if (cost > landsInPlay.length) return null;
	const landsToPay: Permanent[] = [];

	for (const [color, count = 0] of Object.entries(card.cost) as [
		keyof ManaCost,
		number,
	][]) {
		if (count === 0) continue;
		if (color === "c") continue;

		const lands: Permanent[] = landsInPlay.filter(
			(permanent) => permanent.card.types.land?.[colorToBasicLand[color]],
		);
		if (lands.length < count) return null;
		landsToPay.push(...lands.slice(0, count));
	}
	if (card.cost.c) {
		const landsRemaining = landsInPlay.filter(
			(land) => !landsToPay.includes(land),
		);
		assert(landsRemaining.length >= card.cost.c, "should have had more lands");
		landsToPay.push(...landsRemaining.slice(0, card.cost.c));
	}
	return { tap: landsToPay };
}

function getActions(
	state: InprogressGameState,
	player: 0 | 1,
): (PlayLandAction | CastAction)[] {
	if (player !== state.activePlayer) return [];

	return state.zones.hand[player].flatMap(
		(cardInHand): (PlayLandAction | CastAction)[] => {
			assert(
				cardInHand.kind === "permanent",
				"Only permanent cards can be played",
			);
			if (cardInHand.types.land) {
				if (!canPlayLand(state, player)) return [];
				return [{ type: "play land", land: cardInHand }];
			}
			if (cardInHand.types.creature) {
				const castPlan = getCastPlan(state, player, cardInHand);
				if (castPlan) {
					return [{ type: "cast", spell: cardInHand, plan: castPlan }];
				}
			}
			return [];
		},
	);
}

function playLand(
	state: InprogressGameState,
	action: PlayLandAction,
	player: 0 | 1,
): void {
	assert(
		state.thisTurn.landsPlayed[player] === 0,
		"land played but lands already played",
	);
	assert(state.activePlayer === player, "land played by non-active player");

	const hand = state.zones.hand[player];
	assert(hand.length > 0, "no lands in hand to play");
	const land = hand.includes(action.land);
	assert(land, "land not in hand to play");
	hand.splice(hand.indexOf(action.land), 1);
	state.zones.battlefield[player].push({
		kind: "permanent",
		tapped: false,
		card: action.land,
	});
	// console.log(state.players[player].name, "played", action.land.name);
	state.thisTurn.landsPlayed[player]++;
}

function playSpell(
	state: InprogressGameState,
	action: CastAction,
	player: 0 | 1,
): void {
	assert(state.zones.stack.length === 0, "spell cast but stack not empty");
	assert(state.activePlayer === player, "spell cast by non-active player");

	const hand = state.zones.hand[player];
	assert(hand.length > 0, "no spells in hand to play");
	const spell = hand.includes(action.spell);

	assert(spell, "spell not in hand to play");
	hand.splice(hand.indexOf(action.spell), 1);

	action.plan.tap.forEach((land) => {
		assert(!land.tapped, "land not tapped");
		land.tapped = true;
	});

	state.zones.stack.push({
		type: "cast",
		controller: player,
		card: action.spell,
	});
}

function resolveStack(state: InprogressGameState): void {
	assert(state.zones.stack.length > 0, "stack not empty");
	const item = state.zones.stack.pop();
	assertDefined(item);

	if (item.type !== "cast") throw new Error("stack item is not a cast");

	assert(
		item.controller === state.activePlayer,
		"stack item controller does not match active player",
	);

	if (item.card.kind !== "permanent")
		throw new Error("stack item is not a permanent");

	state.zones.battlefield[item.controller].push({
		kind: "permanent",
		card: item.card,
	});
}

function resolvePriority(state: InprogressGameState): void {
	if (state.zones.stack.length !== 0)
		throw new Error("stack not implemented yet");

	/** the player who has priority */
	let priority: 0 | 1 = state.activePlayer;

	for (let i = 0; i < 10000; i++) {
		const actions = getActions(state, priority);
		const action = state.players[priority].chooseSpellOrAbility(state, [
			...actions,
			{ type: "pass" },
		]);
		if (
			priority === state.activePlayer &&
			state.phases[0] === "main" &&
			state.thisTurn.landsPlayed[priority] === 0 &&
			state.zones.hand[priority].some(
				(card) => card.kind === "permanent" && card.types.land,
			)
		) {
			assert(actions.length > 0, "should be able to play a land");
		}
		if (action.type === "play land") {
			assert(state.zones.stack.length === 0, "land played but stack not empty");
			// players receive priority after playing a land.
			playLand(state, action, priority);
			continue;
		}
		if (action.type === "cast") {
			playSpell(state, action, priority);

			// throw new Error("cast not implemented yet");
		}

		if (action.type === "pass") {
			if (priority === state.activePlayer) {
				priority = (1 - priority) as 0 | 1;
				continue;
			}
			// when the non-active player passes on an empty stack, proceed to the next
			// phase.
			if (state.zones.stack.length === 0) {
				return;
			}
			// otherwise, priority swaps.

			resolveStack(state);
		}
	}

	throw new Error("too many priority windows");
}

function canBeDeclaredAttacker(
	permanent: Permanent,
	state: InprogressGameState,
): boolean {
	if (!permanent.card.types.creature) return false;
	// TODO: entered this turn?

	return true;
}
function declareAttacker(
	state: InprogressGameState,
	attacker: Permanent,
): void {
	attacker.tapped = true;
	attacker.attacking = true;
}

function resolveAttackers(state: InprogressGameState): Permanent[] {
	if (state.zones.battlefield[state.activePlayer].length === 0) {
		return [];
	}
	const eligibleAttackers = state.zones.battlefield[state.activePlayer].filter(
		(permanent) => canBeDeclaredAttacker(permanent, state),
	);
	const attackers = state.players[state.activePlayer].declareAttackers(
		state,
		eligibleAttackers,
	);

	attackers.forEach((attacker) => {
		declareAttacker(state, attacker);
	});
	return attackers;
}

function canBeDeclaredBlocker(
	permanent: Permanent,
	state: InprogressGameState,
): boolean {
	if (!permanent.card.types.creature) return false;

	return !permanent.tapped;
}

function resolveBlockers(state: InprogressGameState) {
	const attackers = state.cache.__attackers;
	if (attackers.length === 0) return;

	const defendingPlayer = (1 - state.activePlayer) as 0 | 1;
	if (state.zones.battlefield[defendingPlayer].length === 0) {
		return;
	}

	const eligibleBlockers = state.zones.battlefield[defendingPlayer].filter(
		(permanent) => canBeDeclaredBlocker(permanent, state),
	);

	const declaredBlockers = state.players[defendingPlayer].declareBlockers(
		state,
		attackers,
		eligibleBlockers,
	);

	const seenBlockers = new Set<Permanent>();

	for (const [attacker, blockersPerAttacker] of declaredBlockers) {
		assert(attacker.attacking === true);
		assert(state.zones.battlefield[state.activePlayer].includes(attacker));
		for (const blocker of blockersPerAttacker) {
			assert(seenBlockers.has(blocker) === false, "blocker seen twice");
			seenBlockers.add(blocker);

			assert(state.zones.battlefield[defendingPlayer].includes(blocker));
		}
	}

	state.cache.__blockers = declaredBlockers;
}

function dealCombatDamage(state: InprogressGameState) {
	const defendingPlayer = state.activePlayer === 0 ? 1 : 0;
	assertDefined(state.cache.__blockers);
	if (!state.cache.__attackers.length) return;
	if (!state.cache.__blockers.size) return;

	for (const attacker of state.cache.__attackers) {
		assert(isCreaturePermanent(attacker));
		if (!isCreaturePermanent(attacker)) continue;

		// if unblocked
		if (!state.cache.__blockers.has(attacker)) {
			state.life[defendingPlayer] -= attacker.power;
			console.log(attacker.card.name, "dealt", attacker.power, "damage");
			console.log(
				state.players[defendingPlayer].name,
				"life",
				state.life[defendingPlayer],
			);
		}
		// blocked
		else {
			const blockers = state.cache.__blockers.get(attacker);
			assertDefined(blockers);
			assertDefined(blockers[0]);
			assert(isCreaturePermanent(blockers[0]));
			if (!isCreaturePermanent(blockers[0])) continue;

			if (blockers.length === 1) {
				blockers[0].damage += attacker.power;
			} else {
				throw new Error("Multiple blockers not supported");
			}
		}
	}
}

function applyStateBasedActions(
	state: InprogressGameState,
): InprogressGameState | TerminalGameState {
	const defendingPlayer = state.activePlayer === 0 ? 1 : 0;
	const activePlayer = state.activePlayer;

	if (state.life[activePlayer] <= 0) {
		return {
			...state,
			state: "terminal",
			winner: state.players[defendingPlayer],
		};
	}

	if (state.life[defendingPlayer] <= 0) {
		return {
			...state,
			state: "terminal",
			winner: state.players[activePlayer],
		};
	}

	for (const player of [0, 1] as const) {
		for (const permanent of state.zones.battlefield[activePlayer]) {
			if (!isCreaturePermanent(permanent)) continue;

			if (permanent.damage > permanent.toughness) {
				diesDueToDamage(state, permanent, player);
			}
		}
	}

	return state;
}

function diesDueToDamage(
	state: InprogressGameState,
	permanent: Permanent,
	controller: 0 | 1,
) {
	const battlefield = state.zones.battlefield[controller];
	const graveyard = state.zones.graveyard[controller];
	const updatedBattlefield = battlefield.filter((p) => p !== permanent);
	const updatedGraveyard = [...graveyard, permanent.card];

	assert(
		updatedBattlefield.length === battlefield.length - 1,
		"battlefield not updated",
	);
	assert(
		updatedGraveyard.length === graveyard.length + 1,
		"graveyard not updated",
	);

	console.log(permanent.card.name, "died to damage");

	state.zones.battlefield[controller] = updatedBattlefield;
	state.zones.graveyard[controller] = updatedGraveyard;
}

function handlePhase(
	state: InprogressGameState,
): InprogressGameState | TerminalGameState {
	const phase = state.phases[0];
	assert(phase !== undefined, "No phases left");

	// console.log("player", state.players[state.activePlayer].name, "phase", phase);
	// console.log(JSON.stringify(state, null, 2));
	assert(state.zones.stack.length === 0, "stack not empty");
	switch (phase) {
		case undefined:
			throw new Error("No phases left");
		case "untap":
			state.phases.shift();
			break;
		case "upkeep":
			resolvePriority(state);
			state.phases.shift();
			break;
		case "draw":
			// put triggers on stack

			if (state.zones.library[state.activePlayer].length === 0) {
				return {
					...state,
					state: "terminal",
					winner:
						state.activePlayer === 0 ? state.players[1] : state.players[0],
				};
			}
			completeDraw(state, state.activePlayer, 1);

			resolvePriority(state);
			state.phases.shift();
			break;
		case "main":
			assert(state.cache.__attackers.length === 0);
			resolvePriority(state);
			state.phases.shift();
			break;
		case "begin combat":
			assert(state.cache.__attackers.length === 0);
			resolvePriority(state);
			state.phases.shift();
			break;
		case "declare attackers":
			resolveAttackers(state);

			resolvePriority(state);
			state.phases.shift();
			break;
		case "declare blockers":
			resolveBlockers(state);
			resolvePriority(state);
			state.phases.shift();
			break;
		case "after damage": {
			dealCombatDamage(state);
			const newState = applyStateBasedActions(state);
			if (newState.state === "terminal") return newState;
			state = newState;

			resolvePriority(state);
			state.phases.shift();
			state.cache.__attackers = [];
			state.cache.__blockers = null;

			break;
		}

		case "end":
			state.phases.shift();
			assert(state.cache.__attackers.length === 0);
			break;
		case "cleanup":
			assert(state.cache.__attackers.length === 0);
			discardToHandSize(state, state.activePlayer, 7);
			state.phases = [...DEFAULT_PHASES];
			state.activePlayer = state.activePlayer === 0 ? 1 : 0;
			state.thisTurn = {
				landsPlayed: [0, 0],
			};

			assert(
				state.zones.hand[state.activePlayer].length <= 7,
				`Hand size should be 7 after cleanup`,
			);
			break;
		default:
			assertNever(phase);
	}
	return state;
}

if (import.meta.main) {
	async function __dummyLibrary(): Promise<Card[]> {
		const kalonian_tusker: Card = {
			name: "Kalonian Tusker",
			cost: { g: 2 },
			kind: "permanent",
			types: {
				creature: {
					beast: true,
				},
			},
		};
		const forest: Card = {
			name: "Forest",
			cost: undefined,
			kind: "permanent",
			types: {
				land: {
					forest: true,
				},
			},
		};
		return shuffle([
			...Array.from({ length: 30 }).map(() => kalonian_tusker),
			...Array.from({ length: 30 }).map(() => forest),
		]);
	}

	function randomNonPass(state: GameState, actions: Action[]): Action {
		assertDefined(actions[0]);
		if (actions.length === 1) {
			return actions[0];
		}

		const action = actions[Math.floor(Math.random() * actions.length - 1) + 1];
		assertDefined(action);
		return action;
	}

	function declareAttackers(
		state: InprogressGameState,
		attackers: Permanent[],
	): Permanent[] {
		return attackers;
	}

	function declareBlockers() {
		return new Map();
	}

	function createPlayer(name: string): Player {
		return {
			name,
			chooseSpellOrAbility: randomNonPass,
			declareAttackers,
			declareBlockers,
		};
	}

	let state: GameState = newGame([
		{
			player: createPlayer("p1"),
			library: await __dummyLibrary(),
		},
		{
			player: createPlayer("p2"),
			library: await __dummyLibrary(),
		},
	]);

	while (state.state !== "terminal") {
		const stepCount = state.step;
		assert(stepCount < 10000, "max step count exceeded");
		state = step(state);

		assert(state.step === stepCount + 1, "step count mismatch");
	}
	console.log(state.winner.name, "wins!");
	console.log(printGameState(state));
}

/** mutates array in place and randomizes it. */
function shuffle<T>(array: T[]): T[] {
	for (let i = array.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		const a = array[i];
		const b = array[j];
		assertDefined(a);
		assertDefined(b);

		[array[i], array[j]] = [b, a];
	}
	return array;
}

function printGameState(state: GameState): string {
	return `step: ${state.step}

zones:
battlefield:
${state.zones.battlefield.map((zone) => zone.length).join(" ")}
hand:
${state.zones.hand.map((zone) => zone.length).join(" ")}
  `;
}
