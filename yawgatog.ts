#!/usr/bin/env bun
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname);
const RULES_PATH = join(SCRIPT_DIR, "yawgatog-rules.md");
const INDEX_DIR = join(SCRIPT_DIR, ".cache");
const INDEX_PATH = join(INDEX_DIR, "yawgatog-index.json");

interface RuleEntry {
	number: string;
	anchor: string;
	level: number;
	title: string;
	body: string;
	line: number;
}

interface Index {
	version: number;
	source: string;
	generatedAt: string;
	byNumber: Record<string, RuleEntry>;
	byAnchor: Record<string, RuleEntry>;
	entries: RuleEntry[];
}

const HEADING_RE =
	/^(#{1,6})\s+\[([0-9]+(?:\.[0-9]+)?(?:[a-z])?)\.?\]\(#(R[0-9]+[a-z]?)\)\s+(.*)$/;

function stripMarkdownLinks(text: string): string {
	return text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

function normalize(text: string): string {
	return stripMarkdownLinks(text)
		.replace(/\*\*/g, "")
		.replace(/\*/g, "")
		.trim();
}

async function buildIndex(): Promise<Index> {
	const file = Bun.file(RULES_PATH);
	if (!(await file.exists())) {
		throw new Error(`Rules file not found: ${RULES_PATH}`);
	}

	const text = await file.text();
	const lines = text.split(/\r?\n/);
	const headings: Array<{
		level: number;
		number: string;
		anchor: string;
		title: string;
		line: number;
	}> = [];

	for (let i = 0; i < lines.length; i++) {
		const match = HEADING_RE.exec(lines[i]!);
		if (!match) continue;
		const hashes = match[1] as string;
		const number = match[2] as string;
		const anchor = match[3] as string;
		const title = match[4] as string;
		headings.push({
			level: hashes.length,
			number,
			anchor,
			title: normalize(title),
			line: i + 1,
		});
	}

	const entries: RuleEntry[] = [];
	for (let i = 0; i < headings.length; i++) {
		const h = headings[i]!;
		const startLine = h.line;
		const next = headings[i + 1];
		const endLine = next ? next.line - 1 : lines.length;
		let body = "";
		if (endLine > startLine) {
			body = normalize(lines.slice(startLine, endLine).join("\n"));
		}
		entries.push({
			number: h.number,
			anchor: h.anchor,
			level: h.level,
			title: h.title,
			body,
			line: h.line,
		});
	}

	const byNumber: Record<string, RuleEntry> = {};
	const byAnchor: Record<string, RuleEntry> = {};
	for (const e of entries) {
		byNumber[e.number] = e;
		byAnchor[e.anchor] = e;
	}

	return {
		version: 1,
		source: RULES_PATH,
		generatedAt: new Date().toISOString(),
		byNumber,
		byAnchor,
		entries,
	};
}

async function writeIndex(index: Index): Promise<void> {
	mkdirSync(INDEX_DIR, { recursive: true });
	await Bun.write(INDEX_PATH, JSON.stringify(index, null, 2));
}

async function loadIndex(forceRebuild = false): Promise<Index> {
	const rulesFile = Bun.file(RULES_PATH);
	const indexFile = Bun.file(INDEX_PATH);

	if (
		!forceRebuild &&
		(await indexFile.exists()) &&
		(await rulesFile.exists())
	) {
		const rulesMtime = rulesFile.lastModified;
		const indexMtime = indexFile.lastModified;
		if (indexMtime && rulesMtime && indexMtime >= rulesMtime) {
			const text = await indexFile.text();
			try {
				return JSON.parse(text) as Index;
			} catch {
				// fall through to rebuild
			}
		}
	}

	const index = await buildIndex();
	await writeIndex(index);
	return index;
}

function printEntry(e: RuleEntry): void {
	console.log(`\nCR ${e.number}  (${e.anchor})`);
	console.log(`${e.title}`);
	if (e.body) {
		console.log(`\n${e.body}`);
	}
}

function snippet(text: string, query: string, context = 60): string {
	const idx = text.toLowerCase().indexOf(query.toLowerCase());
	if (idx === -1) return text.slice(0, context * 2);
	const start = Math.max(0, idx - context);
	const end = Math.min(text.length, idx + query.length + context);
	let s = text.slice(start, end);
	if (start > 0) s = `…${s}`;
	if (end < text.length) s += "…";
	return s.replace(/\s+/g, " ").trim();
}

async function lookup(numberOrAnchor: string): Promise<void> {
	const index = await loadIndex();
	let e = index.byNumber[numberOrAnchor];
	if (!e && numberOrAnchor.startsWith("R")) {
		e = index.byAnchor[numberOrAnchor];
	}
	if (!e) {
		// Try stripping a trailing dot.
		const alt = numberOrAnchor.replace(/\.$/, "");
		if (alt !== numberOrAnchor) {
			e = index.byNumber[alt];
		}
	}
	if (!e) {
		console.error(`No rule found for "${numberOrAnchor}".`);
		process.exit(1);
	}
	printEntry(e);
}

async function search(query: string, regex = false): Promise<void> {
	const index = await loadIndex();
	const re = regex
		? new RegExp(query, "i")
		: new RegExp(
				query
					.split(/\s+/)
					.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
					.join(".*"),
				"i",
			);

	const hits: Array<{ entry: RuleEntry; text: string }> = [];
	for (const e of index.entries) {
		const haystack = `${e.title}\n${e.body}`;
		if (re.test(haystack)) {
			hits.push({
				entry: e,
				text: snippet(
					haystack,
					regex ? query : ((query.split(/\s+/)[0] ?? query) as string),
				),
			});
		}
	}

	if (hits.length === 0) {
		console.log("No matches.");
		return;
	}

	console.log(`${hits.length} match${hits.length === 1 ? "" : "es"}:\n`);
	for (const h of hits.slice(0, 20)) {
		console.log(`CR ${h.entry.number}  (${h.entry.anchor})`);
		console.log(`  ${h.text}\n`);
	}
	if (hits.length > 20) {
		console.log(`...and ${hits.length - 20} more.`);
	}
}

async function rebuild(): Promise<void> {
	const index = await buildIndex();
	await writeIndex(index);
	console.log(
		`Indexed ${index.entries.length} rule entries from ${index.source}\n→ ${INDEX_PATH}`,
	);
}

function usage(): void {
	console.log(`Usage: bun yawgatog.ts <command> [arg]

Commands:
  <rule>                Look up an exact rule, e.g. 704.3 or 704.3a or R7043a
  search <query>        Case-insensitive keyword search across all rules
  grep <regex>          Case-insensitive regex search across all rules
  index                 Force rebuild the cached index

Examples:
  bun yawgatog.ts 616.1
  bun yawgatog.ts search "can't be prevented"
  bun yawgatog.ts grep "lethal damage"`);
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.length === 0) {
		usage();
		return;
	}

	const [cmd, ...rest] = args;
	const arg = rest.join(" ");

	switch (cmd) {
		case "-h":
		case "--help":
			usage();
			return;
		case "index":
			await rebuild();
			return;
		case "search":
			if (!arg) {
				console.error("search requires a query.");
				process.exit(1);
			}
			await search(arg, false);
			return;
		case "grep":
			if (!arg) {
				console.error("grep requires a regex.");
				process.exit(1);
			}
			await search(arg, true);
			return;
		default:
			await lookup(cmd!);
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
