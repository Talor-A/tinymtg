/** Syntax boundary between Forge scripts and the strict importer. */
export interface ForgeDiagnostic {
	severity: "warning";
	code: "MALFORMED_LINE" | "MALFORMED_PARAM" | "MALFORMED_SVAR";
	message: string;
	line?: number;
	nodeId?: string;
	paramId?: string;
}
export interface ForgeDirectiveNode {
	kind: "directive";
	id: string;
	line: number;
	key: string;
	value: string;
}
export interface ForgeFaceMarkerNode {
	kind: "face-marker";
	id: string;
	line: number;
	marker: string;
	argument?: string;
	raw: string;
}
export interface ForgeMalformedNode {
	kind: "malformed";
	id: string;
	line: number;
	raw: string;
	reason: string;
}
export type ForgeSourceNode =
	| ForgeDirectiveNode
	| ForgeFaceMarkerNode
	| ForgeMalformedNode;
export interface ForgeScriptDocument {
	nodes: ForgeSourceNode[];
}
export interface ForgeDirectiveRef {
	nodeId: string;
	line: number;
	key: string;
	value: string;
}
export interface ForgeParamEntry {
	id: string;
	index: number;
	raw: string;
	key: string;
	value: string;
	malformed: boolean;
}
export interface ForgeParamList {
	entries: ForgeParamEntry[];
	effectiveLower: ReadonlyMap<string, string>;
}
export type ForgeAbilityToken = "AB" | "SP" | "ST" | "DB";
export interface ForgeAbilityDiscriminator {
	token: ForgeAbilityToken;
	api: string;
}
const ABILITY_TOKENS: readonly ForgeAbilityToken[] = ["AB", "SP", "ST", "DB"];
export function forgeAbilityDiscriminator(
	params: ForgeParamList,
): ForgeAbilityDiscriminator | null {
	const present = ABILITY_TOKENS.filter((token) =>
		params.effectiveLower.has(token.toLowerCase()),
	);
	if (present.length !== 1) return null;
	const token = present[0];
	assert(token !== undefined);
	return {
		token,
		api: (params.effectiveLower.get(token.toLowerCase()) ?? "").toLowerCase(),
	};
}
export interface ForgeAbilityRecord {
	id: string;
	source: ForgeDirectiveRef;
	params: ForgeParamList;
	discriminator: ForgeAbilityDiscriminator | null;
}
export type ForgeTriggerRecord = ForgeAbilityRecord;
export type ForgeReplacementRecord = ForgeAbilityRecord;
export type ForgeStaticRecord = ForgeAbilityRecord;
export interface ForgeSVarRecord {
	id: string;
	name: string;
	value: string;
	source: ForgeDirectiveRef;
	parsed:
		| { kind: "params"; params: ForgeParamList }
		| { kind: "scalar"; value: string };
}
export interface ForgeKeywordRecord {
	id: string;
	source: ForgeDirectiveRef;
	raw: string;
	keyword: string;
	segments: string[];
}
export interface ForgeCharacteristics {
	name?: ForgeDirectiveRef;
	manaCost?: ForgeDirectiveRef;
	types?: ForgeDirectiveRef;
	colors?: ForgeDirectiveRef;
	pt?: ForgeDirectiveRef;
	loyalty?: ForgeDirectiveRef;
	defense?: ForgeDirectiveRef;
	attractionLights?: ForgeDirectiveRef;
	oracle?: ForgeDirectiveRef;
	text?: ForgeDirectiveRef;
	flavorName?: ForgeDirectiveRef;
	copyFaceFrom?: ForgeDirectiveRef;
	all: ForgeDirectiveRef[];
}
export type ForgeFaceState =
	| "original"
	| "alternate"
	| "specialize-white"
	| "specialize-blue"
	| "specialize-black"
	| "specialize-red"
	| "specialize-green";
export interface ForgeFaceAst {
	state: ForgeFaceState;
	slot: number;
	characteristics: ForgeCharacteristics;
	keywordRecords: ForgeKeywordRecord[];
	abilities: ForgeAbilityRecord[];
	triggers: ForgeTriggerRecord[];
	replacements: ForgeReplacementRecord[];
	statics: ForgeStaticRecord[];
	svars: ForgeSVarRecord[];
	draftActions: ForgeDirectiveRef[];
	variants: ForgeDirectiveRef[];
	otherDirectives: ForgeDirectiveRef[];
	svarIndex: Map<string, ForgeSVarRecord[]>;
}
export interface ForgeCardAst {
	document: ForgeScriptDocument;
	cardDirectives: ForgeDirectiveRef[];
	faces: ForgeFaceAst[];
}
export interface ForgeParseResult {
	document: ForgeScriptDocument;
	card: ForgeCardAst;
	diagnostics: ForgeDiagnostic[];
}

function assert(condition: unknown): asserts condition {
	if (!condition) throw new Error("internal parser invariant");
}
function ref(node: ForgeDirectiveNode): ForgeDirectiveRef {
	return { nodeId: node.id, line: node.line, key: node.key, value: node.value };
}
export function parseForgeParams(
	body: string,
	idPrefix = "params",
	diagnostics?: ForgeDiagnostic[],
	line?: number,
): ForgeParamList {
	const entries: ForgeParamEntry[] = [];
	const effectiveLower = new Map<string, string>();
	if (body !== "")
		for (const [index, raw] of body.split("|").entries()) {
			const dollar = raw.indexOf("$");
			const key = (dollar >= 0 ? raw.slice(0, dollar) : raw).trim();
			const value = (dollar >= 0 ? raw.slice(dollar + 1) : "").trim();
			const malformed = dollar < 0 && raw.trim() !== "";
			const id = `${idPrefix}/param:${index}`;
			entries.push({ id, index, raw, key, value, malformed });
			effectiveLower.set(key.toLowerCase(), value);
			if (malformed && diagnostics)
				diagnostics.push({
					severity: "warning",
					code: "MALFORMED_PARAM",
					message: `Parameter fragment has no '$' separator: ${raw.trim()}`,
					...(line === undefined ? {} : { line }),
					paramId: id,
				});
		}
	return { entries, effectiveLower };
}
export function getForgeParam(
	params: ForgeParamList,
	key: string,
): string | undefined {
	return params.effectiveLower.get(key.trim().toLowerCase());
}
function looksLikeRecord(value: string): boolean {
	const first = value.split("|", 1)[0] ?? "";
	const dollar = first.indexOf("$");
	return (
		dollar >= 0 &&
		["ab", "sp", "st", "db", "mode", "event"].includes(
			first.slice(0, dollar).trim().toLowerCase(),
		)
	);
}
function parseSVar(
	node: ForgeDirectiveNode,
	diagnostics: ForgeDiagnostic[],
): ForgeSVarRecord {
	const colon = node.value.indexOf(":");
	if (colon <= 0) {
		diagnostics.push({
			severity: "warning",
			code: "MALFORMED_SVAR",
			message: `SVar directive has no '<name>:<value>' separator: ${node.value}`,
			line: node.line,
			nodeId: node.id,
		});
		return {
			id: node.id,
			name: node.value.trim(),
			value: "",
			source: ref(node),
			parsed: { kind: "scalar", value: "" },
		};
	}
	const name = node.value.slice(0, colon).trim();
	const value = node.value.slice(colon + 1);
	return {
		id: node.id,
		name,
		value,
		source: ref(node),
		parsed: looksLikeRecord(value)
			? {
					kind: "params",
					params: parseForgeParams(value, node.id, diagnostics, node.line),
				}
			: { kind: "scalar", value },
	};
}
const CHARACTERISTICS: ReadonlyMap<
	string,
	keyof Omit<ForgeCharacteristics, "all">
> = new Map([
	["Name", "name"],
	["ManaCost", "manaCost"],
	["Types", "types"],
	["Colors", "colors"],
	["PT", "pt"],
	["Loyalty", "loyalty"],
	["Defense", "defense"],
	["Lights", "attractionLights"],
	["Oracle", "oracle"],
	["Text", "text"],
	["FlavorName", "flavorName"],
	["CopyFaceFrom", "copyFaceFrom"],
]);
const CARD_DIRECTIVES = new Set([
	"AlternateMode",
	"MeldPair",
	"SETCOLORID",
	"HandLifeModifier",
	"AI",
	"DeckHints",
	"DeckNeeds",
	"DeckHas",
]);
const STATES: readonly ForgeFaceState[] = [
	"original",
	"alternate",
	"specialize-white",
	"specialize-blue",
	"specialize-black",
	"specialize-red",
	"specialize-green",
];
function emptyFace(slot: number): ForgeFaceAst {
	const state = STATES[slot];
	assert(state !== undefined);
	return {
		state,
		slot,
		characteristics: { all: [] },
		keywordRecords: [],
		abilities: [],
		triggers: [],
		replacements: [],
		statics: [],
		svars: [],
		draftActions: [],
		variants: [],
		otherDirectives: [],
		svarIndex: new Map(),
	};
}
function ability(
	node: ForgeDirectiveNode,
	diagnostics: ForgeDiagnostic[],
): ForgeAbilityRecord {
	const params = parseForgeParams(node.value, node.id, diagnostics, node.line);
	return {
		id: node.id,
		source: ref(node),
		params,
		discriminator: forgeAbilityDiscriminator(params),
	};
}

export function parseForgeCardScript(source: string): ForgeParseResult {
	const diagnostics: ForgeDiagnostic[] = [];
	const nodes: ForgeSourceNode[] = [];
	for (const [index, raw] of source.split(/\r\n|\n|\r/).entries()) {
		const text = raw.trim();
		if (text === "" || text.startsWith("#")) continue;
		const line = index + 1,
			id = `line:${line}`,
			colon = text.indexOf(":"),
			key = colon > 0 ? text.slice(0, colon) : text;
		if (key === "ALTERNATE" || key.startsWith("SPECIALIZE")) {
			nodes.push({
				kind: "face-marker",
				id,
				line,
				marker: key,
				...(colon > 0 ? { argument: text.slice(colon + 1).trim() } : {}),
				raw: text,
			});
			continue;
		}
		if (colon <= 0) {
			const reason =
				colon === 0 ? "line has no directive key" : "line has no ':' separator";
			nodes.push({ kind: "malformed", id, line, raw: text, reason });
			diagnostics.push({
				severity: "warning",
				code: "MALFORMED_LINE",
				message: reason,
				line,
				nodeId: id,
			});
			continue;
		}
		nodes.push({
			kind: "directive",
			id,
			line,
			key,
			value: text.slice(colon + 1).trim(),
		});
	}
	const document = { nodes };
	const faces = new Map<number, ForgeFaceAst>([[0, emptyFace(0)]]);
	const cardDirectives: ForgeDirectiveRef[] = [];
	let slot = 0;
	for (const node of nodes) {
		if (node.kind === "malformed") continue;
		if (node.kind === "face-marker") {
			if (node.marker === "ALTERNATE") slot = 1;
			else {
				const n = new Map([
					["WHITE", 2],
					["BLUE", 3],
					["BLACK", 4],
					["RED", 5],
					["GREEN", 6],
				]).get(node.argument ?? "");
				if (n !== undefined) slot = n;
			}
			if (!faces.has(slot)) faces.set(slot, emptyFace(slot));
			continue;
		}
		const r = ref(node);
		if (CARD_DIRECTIVES.has(node.key.trim())) {
			cardDirectives.push(r);
			continue;
		}
		const face = faces.get(slot);
		assert(face !== undefined);
		const characteristic = CHARACTERISTICS.get(node.key.trim());
		if (characteristic !== undefined) {
			face.characteristics.all.push(r);
			face.characteristics[characteristic] = r;
			continue;
		}
		switch (node.key.trim()) {
			case "K": {
				const segments = node.value.split(":");
				face.keywordRecords.push({
					id: node.id,
					source: r,
					raw: node.value,
					keyword: (segments[0] ?? "").trim(),
					segments,
				});
				break;
			}
			case "A":
				face.abilities.push(ability(node, diagnostics));
				break;
			case "T":
				face.triggers.push(ability(node, diagnostics));
				break;
			case "R":
				face.replacements.push(ability(node, diagnostics));
				break;
			case "S":
				face.statics.push(ability(node, diagnostics));
				break;
			case "SVar": {
				const svar = parseSVar(node, diagnostics);
				face.svars.push(svar);
				const name = svar.name.toLowerCase(),
					bucket = face.svarIndex.get(name);
				if (bucket) bucket.push(svar);
				else face.svarIndex.set(name, [svar]);
				break;
			}
			case "Draft":
				face.draftActions.push(r);
				break;
			case "Variant":
				face.variants.push(r);
				break;
			default:
				face.otherDirectives.push(r);
		}
	}
	const card = {
		document,
		cardDirectives,
		faces: [...faces.values()].sort((a, b) => a.slot - b.slot),
	};
	return { document, card, diagnostics };
}
export function lookupForgeSVar(
	face: ForgeFaceAst,
	name: string,
): ForgeSVarRecord | undefined {
	return face.svarIndex.get(name.trim().toLowerCase())?.at(-1);
}
export function printForgeCardScript(document: ForgeScriptDocument): string {
	const lines = document.nodes.map((node) =>
		node.kind === "directive"
			? `${node.key}:${node.value}`
			: node.kind === "face-marker"
				? node.argument === undefined
					? node.marker
					: `${node.marker}:${node.argument}`
				: node.raw,
	);
	return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}
