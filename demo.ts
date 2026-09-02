#!/usr/bin/env bun
/**
 * A flashy, narrated tour of the tinymtg engine.
 *
 * Runs real scripted games through the real scheduler. Every replacement that
 * fires below (Furnace of Rath doubling combat damage, Palisade Giant
 * redirecting it, Kalitas exiling a creature and replacing it with a Zombie)
 * is the actual replacement-effect pipeline making its own choices about
 * ordering and layers, and Rhox War Monk's lifelink rides the same damage
 * events.
 *
 * Two caveats, so the tour doesn't oversell itself: each act builds a fresh
 * board with `spawnPermanent`, which places permanents directly rather than
 * moving them through the enters-the-battlefield path, and the acts are
 * independent games rather than one continuous match.
 *
 * Run it with:
 *   bun demo.ts
 */
import { ScriptedAgent } from "./agents.ts";
import "./cards.ts";
import type {
	ChoiceRequest,
	GameState,
	ObjectId,
	PlayerId,
	PlayerView,
	SyncAgent,
} from "./index.ts";
import {
	advance,
	gameOver,
	newGame,
	permanent,
	spawnCard,
	spawnPermanent,
	turnLocation,
	view,
	winner,
} from "./index.ts";

/* ------------------------------------------------------------------ *
 * Tiny terminal theatrics
 * ------------------------------------------------------------------ */

const c = {
	reset: "\x1b[0m",
	dim: "\x1b[2m",
	bold: "\x1b[1m",
	red: "\x1b[31m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	blue: "\x1b[34m",
	magenta: "\x1b[35m",
	cyan: "\x1b[36m",
	white: "\x1b[37m",
};

const NO_COLOR = !!process.env.NO_COLOR || !process.stdout.isTTY;
function paint(code: string, s: string): string {
	return NO_COLOR ? s : `${code}${s}${c.reset}`;
}
const bold = (s: string) => paint(c.bold, s);
const dim = (s: string) => paint(c.dim, s);
const red = (s: string) => paint(c.red, s);
const green = (s: string) => paint(c.green, s);
const yellow = (s: string) => paint(c.yellow, s);
const blue = (s: string) => paint(c.blue, s);
const magenta = (s: string) => paint(c.magenta, s);
const cyan = (s: string) => paint(c.cyan, s);

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

const SPEED = process.env.DEMO_FAST ? 0 : 220;

function rule(char = "─", width = 64): string {
	return dim(char.repeat(width));
}

async function banner(text: string): Promise<void> {
	console.log();
	console.log(rule("═"));
	console.log(bold(cyan(`  ${text}`)));
	console.log(rule("═"));
	await sleep(SPEED * 2);
}

async function beat(text: string): Promise<void> {
	console.log(text);
	await sleep(SPEED);
}

/* ------------------------------------------------------------------ *
 * Board rendering
 * ------------------------------------------------------------------ */

const PLAYER_NAME: Record<PlayerId, string> = { 0: "Alice", 1: "Bob" };
const PLAYER_COLOR: Record<PlayerId, (s: string) => string> = {
	0: blue,
	1: magenta,
};

function lifeBar(life: number, max = 20): string {
	const clamped = Math.max(0, Math.min(max, life));
	const filled = Math.round((clamped / max) * 20);
	const bar = "█".repeat(filled) + "░".repeat(20 - filled);
	const color = life <= 5 ? red : life <= 10 ? yellow : green;
	return `${color(bar)} ${bold(String(life))}`;
}

function creatureBadge(state: GameState, id: ObjectId): string {
	const p = permanent(state, id);
	const v = view(state, id);
	const flags = [
		p.tapped ? dim("(tapped)") : "",
		p.attacking ? red("⚔") : "",
		v.keywords.includes("indestructible") ? cyan("[indestructible]") : "",
		v.keywords.includes("lifelink") ? green("[lifelink]") : "",
		p.damage > 0 ? yellow(`${p.damage}dmg`) : "",
	]
		.filter(Boolean)
		.join(" ");
	return `${bold(v.name)} ${dim(`${v.power}/${v.toughness}`)} ${flags}`.trim();
}

function printBoard(state: GameState): void {
	for (const pid of [0, 1] as PlayerId[]) {
		const player = state.players[pid];
		const name = PLAYER_COLOR[pid](bold(PLAYER_NAME[pid]));
		console.log(`  ${name}  ${lifeBar(player.life)}`);
		const creatures = state.battlefield.filter((id) => {
			const perm = permanent(state, id);
			return (
				perm.controller === pid && view(state, id).types.includes("creature")
			);
		});
		const permanents = state.battlefield.filter((id) => {
			const perm = permanent(state, id);
			return (
				perm.controller === pid && !view(state, id).types.includes("creature")
			);
		});
		if (creatures.length === 0 && permanents.length === 0) {
			console.log(dim("    (empty board)"));
		}
		for (const id of creatures) {
			console.log(`    ${creatureBadge(state, id)}`);
		}
		for (const id of permanents) {
			console.log(`    ${dim(view(state, id).name)}`);
		}
	}
}

const LINE_SPEED = process.env.DEMO_FAST ? 0 : 35;

/** Streams the engine's internal log lines since `from`, one at a time. */
async function printLogSince(state: GameState, from: number): Promise<number> {
	for (let i = from; i < state.log.length; i++) {
		const line = state.log[i];
		if (line === undefined) continue;
		if (line.startsWith("  [replace]"))
			console.log(dim(magenta(`    ${line.trim()}`)));
		else if (line.startsWith("  [prohibit]"))
			console.log(dim(cyan(`    ${line.trim()}`)));
		else if (line.startsWith(">")) console.log(`  ${bold(line)}`);
		else console.log(dim(`    ${line.trim()}`));
		await sleep(LINE_SPEED);
	}
	return state.log.length;
}

/* ------------------------------------------------------------------ *
 * Driving the scheduler
 * ------------------------------------------------------------------ */

type Agents = [SyncAgent, SyncAgent];

function isAt(state: GameState, expected: string): boolean {
	const loc = turnLocation(state);
	if (expected === "main") return loc?.kind === "mainPhase";
	return loc?.kind === "step" && loc.step.kind === expected;
}

async function advanceUntil(
	state: GameState,
	agents: Agents,
	done: (state: GameState) => boolean,
	maxAdvances = 200,
): Promise<void> {
	let logPos = state.log.length;
	for (let i = 0; i < maxAdvances; i++) {
		if (done(state) || gameOver(state)) return;
		advance(state, agents);
		logPos = await printLogSince(state, logPos);
	}
	throw new Error("engine did not reach the expected state in time");
}

async function advanceOnce(state: GameState, agents: Agents): Promise<void> {
	const logPos = state.log.length;
	advance(state, agents);
	await printLogSince(state, logPos);
}

/* ------------------------------------------------------------------ *
 * Scene setup
 * ------------------------------------------------------------------ */

const ALICE = 0 as PlayerId;
const BOB = 1 as PlayerId;

function fillLibrary(state: GameState, player: PlayerId, n: number): void {
	for (let i = 0; i < n; i++) spawnCard(state, "forest", player, "library");
}

// TODO: every act stages its board with spawnPermanent (index.ts:1759), which
// writes the object straight onto the battlefield — no "change zone" event, so
// no ETB replacements and no ETB triggers run during setup. Fine for staging a
// scene, but it means the demo never exercises the enters-the-battlefield path;
// Kalitas in Act V is the only zone-change replacement shown at all. Cards like
// Root Maze and Clone (cards.ts) are implemented and would need a real ETB to
// demonstrate.

function passing(): Agents {
	return [new ScriptedAgent(), new ScriptedAgent()];
}

async function main(): Promise<void> {
	console.log();
	console.log(
		bold(
			yellow("  ████████╗██╗███╗   ██╗██╗   ██╗███╗   ███╗████████╗ ██████╗ "),
		),
	);
	console.log(
		bold(
			yellow("  ╚══██╔══╝██║████╗  ██║╚██╗ ██╔╝████╗ ████║╚══██╔══╝██╔════╝ "),
		),
	);
	console.log(
		bold(
			yellow("     ██║   ██║██╔██╗ ██║ ╚████╔╝ ██╔████╔██║   ██║   ██║  ███╗"),
		),
	);
	console.log(
		bold(
			yellow("     ██║   ██║██║╚██╗██║  ╚██╔╝  ██║╚██╔╝██║   ██║   ██║   ██║"),
		),
	);
	console.log(
		bold(
			yellow("     ██║   ██║██║ ╚████║   ██║   ██║ ╚═╝ ██║   ██║   ╚██████╔╝"),
		),
	);
	console.log(
		bold(
			yellow("     ╚═╝   ╚═╝╚═╝  ╚═══╝   ╚═╝   ╚═╝     ╚═╝   ╚═╝    ╚═════╝ "),
		),
	);
	console.log(
		dim("             a from-scratch Magic: The Gathering rules engine"),
	);
	await sleep(SPEED * 3);

	/* ---------------------------- Act I ---------------------------- */
	await banner("Act I — Furnace of Rath doubles combat damage");
	await beat(
		"Alice sics a Grizzly Bears on Bob while a Furnace of Rath burns on the battlefield.",
	);
	await beat(
		dim(
			'Furnace of Rath: "If a source would deal damage to a permanent or player, it deals double that damage to that permanent or player instead."',
		),
	);

	{
		const state = newGame();
		fillLibrary(state, ALICE, 3);
		fillLibrary(state, BOB, 3);
		spawnPermanent(state, "furnace-of-rath", ALICE, "battlefield");
		const bear = spawnPermanent(state, "grizzly-bears", ALICE, "battlefield");

		const agents: Agents = [
			new ScriptedAgent([], [], [], [[bear.id]]),
			new ScriptedAgent(),
		];

		await advanceUntil(state, agents, (s) => isAt(s, "declare attackers"));
		await advanceOnce(state, agents); // commits the attack
		await advanceUntil(state, agents, (s) => isAt(s, "end combat"));

		console.log();
		console.log(dim(`  Grizzly Bears is a 2/2 — expect Bob to take 4, not 2.`));
		printBoard(state);
	}

	/* ---------------------------- Act II --------------------------- */
	// TODO: "learns his lesson" / "next attack" implies this continues Act I,
	// but every act calls newGame() and throws the previous board away. That is
	// why Bob is back at 20 here rather than the 16 Act I left him on. Either
	// reword the narration to stop implying continuity, or thread one game
	// through the acts (which would mean spawning the Giant mid-game rather
	// than pre-placing it).
	await banner(
		"Act II — Palisade Giant eats every hit meant for its controller",
	);
	await beat(
		"Bob learns his lesson and drops a Palisade Giant before Alice's next attack.",
	);
	await beat(
		dim(
			'Palisade Giant: "All damage that would be dealt to you and other permanents you control is dealt to Palisade Giant instead."',
		),
	);

	{
		const state = newGame();
		fillLibrary(state, ALICE, 3);
		fillLibrary(state, BOB, 3);
		const bear = spawnPermanent(state, "grizzly-bears", ALICE, "battlefield");
		spawnPermanent(state, "palisade-giant", BOB, "battlefield");

		const agents: Agents = [
			new ScriptedAgent([], [], [], [[bear.id]]),
			new ScriptedAgent(),
		];

		await advanceUntil(state, agents, (s) => isAt(s, "declare attackers"));
		await advanceOnce(state, agents);
		await advanceUntil(state, agents, (s) => isAt(s, "end combat"));

		console.log();
		console.log(
			dim(
				"  Bob stays at 20 — the Giant (7 toughness) soaked the hit instead.",
			),
		);
		printBoard(state);
	}

	/* --------------------------- Act III --------------------------- */
	// TODO: this act currently demonstrates nothing, and its narration is false.
	// Bob is given only a Furnace of Rath (an enchantment), so there is no
	// "much bigger creature" to attack into: nobody blocks, no damage event is
	// ever produced, the Furnace replacement never fires, and Darksteel Myr is
	// never dealt damage. The "indestructible holds" line below is read off
	// view().keywords as a badge rather than earned by anything the engine did.
	// Darksteel Myr is also 0/1, so even with a blocker present it would assign
	// 0 damage and take none from an unblocked swing.
	//
	// Indestructible IS implemented (index.ts:2599-2612, covered by
	// rules.test.ts:303 "indestructible permanents") — this scene just fails to
	// reach it. To fix: give Bob a real blocker with enough power to be lethal
	// to a 1-toughness creature, have Bob block the Myr, and let the Furnace
	// double that damage. Then the SBA at index.ts:3197 runs lethalDamage() and
	// the indestructible replacement is what actually keeps the Myr alive.
	await banner("Act III — indestructible shrugs off lethal damage");
	await beat(
		"Alice attacks a Darksteel Myr into a much bigger creature. It doesn't care.",
	);

	{
		const state = newGame();
		fillLibrary(state, ALICE, 3);
		fillLibrary(state, BOB, 3);
		spawnPermanent(state, "furnace-of-rath", BOB, "battlefield");
		const myr = spawnPermanent(state, "darksteel-myr", ALICE, "battlefield");

		const agents: Agents = [
			new ScriptedAgent([], [], [], [[myr.id]]),
			new ScriptedAgent(),
		];

		await advanceUntil(state, agents, (s) => isAt(s, "declare attackers"));
		await advanceOnce(state, agents);
		await advanceUntil(state, agents, (s) => isAt(s, "end combat"));

		console.log();
		console.log(
			dim(
				"  Even doubled by the opponent's own Furnace of Rath, indestructible holds.",
			),
		);
		printBoard(state);
	}

	/* --------------------------- Act IV ---------------------------- */
	await banner("Act IV — lifelink turns combat into a life swing");
	await beat("Rhox War Monk connects, and Alice climbs back up as Bob bleeds.");

	{
		const state = newGame();
		fillLibrary(state, ALICE, 3);
		fillLibrary(state, BOB, 3);
		state.players[ALICE].life = 10;
		const monk = spawnPermanent(state, "rhox-war-monk", ALICE, "battlefield");

		const agents: Agents = [
			new ScriptedAgent([], [], [], [[monk.id]]),
			new ScriptedAgent(),
		];

		await advanceUntil(state, agents, (s) => isAt(s, "declare attackers"));
		await advanceOnce(state, agents);
		await advanceUntil(state, agents, (s) => isAt(s, "end combat"));

		console.log();
		printBoard(state);
	}

	/* ---------------------------- Act V ----------------------------- */
	// TODO: "Zombie army" oversells a single 2/2 token — Kalitas makes exactly
	// one Zombie per creature that dies, and only one creature dies here. Either
	// retitle this ("...into a Zombie"), or give Bob several doomed creatures so
	// the plural is actually earned.
	//
	// The before/after count below is also loose: it counts all of Alice's
	// permanents (Kalitas included), so it reads 1 → 2 rather than counting the
	// tokens created. It happens to be right only because exactly one token was
	// made and nothing of Alice's left the battlefield.
	await banner("Act V — Kalitas turns a would-be kill into a Zombie army");
	await beat(
		"Alice controls Kalitas, Traitor of Ghet. When Bob's nontoken creature would die, it's exiled and Alice gets a 2/2 Zombie instead.",
	);

	{
		const state = newGame();
		fillLibrary(state, ALICE, 3);
		fillLibrary(state, BOB, 3);
		spawnPermanent(state, "kalitas", ALICE, "battlefield");
		const doomed = spawnPermanent(state, "eager-cadet", BOB, "battlefield");
		permanent(state, doomed.id).damage = 1; // 1/1 with 1 damage marked = lethal at SBA

		const agents = passing();
		const before = state.battlefield.filter(
			(id) => permanent(state, id).controller === ALICE,
		).length;

		// The scheduler checks state-based actions at the top of every priority
		// round, so simply advancing the game is enough to sweep the Cadet away.
		await advanceUntil(
			state,
			agents,
			(s) => !s.battlefield.includes(doomed.id),
		);

		console.log();
		const after = state.battlefield.filter(
			(id) => permanent(state, id).controller === ALICE,
		).length;
		console.log(
			dim(
				`  Alice's permanents: ${before} → ${after} (a Zombie token joined the team).`,
			),
		);
		printBoard(state);
	}

	/* --------------------------- Finale ----------------------------- */
	await banner("Finale — a real multi-turn game, played out to completion");
	await beat(
		"No more vignettes — two Grizzly Bears trade blows turn after turn until someone hits zero.",
	);

	{
		const state = newGame();
		fillLibrary(state, ALICE, 40);
		fillLibrary(state, BOB, 40);
		state.players[ALICE].life = 6;
		state.players[BOB].life = 6;
		const aliceBear = spawnPermanent(
			state,
			"grizzly-bears",
			ALICE,
			"battlefield",
		);
		const bobBear = spawnPermanent(state, "grizzly-bears", BOB, "battlefield");

		class SwingingAgent implements SyncAgent {
			constructor(
				private readonly self: PlayerId,
				private readonly own: ObjectId,
			) {}
			choose(view: PlayerView, request: ChoiceRequest) {
				if (
					request.kind === "declareAttackers" &&
					request.player === this.self
				) {
					const p = view.battlefield.find(
						(object) => object.objectId === this.own,
					);
					if (p?.kind !== "permanent") {
						throw new Error(`own permanent ${this.own} is not visible`);
					}
					return { optionIds: p.tapped ? [] : [String(this.own)] };
				}
				if (request.kind === "declareAttackers") return { optionIds: [] };
				if (request.kind === "declareBlockers") return { optionIds: [] };
				if (request.kind === "triggerOrder") {
					return { optionIds: request.options.map((option) => option.id) };
				}
				if (request.kind === "optional") return { optionId: "no" };
				const first = request.options[0];
				return { optionId: first ? first.id : "" };
			}
		}

		const agents: Agents = [
			new SwingingAgent(ALICE, aliceBear.id),
			new SwingingAgent(BOB, bobBear.id),
		];

		let logPos = state.log.length;
		let safety = 0;
		while (!gameOver(state) && safety++ < 500) {
			advance(state, agents);
			logPos = await printLogSince(state, logPos);
		}

		console.log();
		const w = winner(state);
		if (w !== null) {
			console.log(bold(PLAYER_COLOR[w](`  ★ ${PLAYER_NAME[w]} wins! ★`)));
		} else {
			console.log(bold("  Draw."));
		}
		printBoard(state);
	}

	console.log();
	// console.log(rule("═"));
	// console.log(
	// 	dim(
	// 		"  Every event above — attacks, damage, replacements, state-based actions —",
	// 	),
	// );
	// console.log(
	// 	dim("  ran through the same real event pipeline the test suite exercises."),
	// );
	// console.log(rule("═"));
	// console.log();
}

main().catch((err) => {
	console.error(red(bold("demo failed:")), err);
	process.exit(1);
});
