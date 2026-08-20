#!/usr/bin/env node
/**
 * extract-5etools.mjs
 *
 * Reads a 5etools data directory and emits a compact, character-creation-focused
 * database for the Lower Levels character creator.
 *
 * Only character-creation material is extracted: species, classes, subclasses and
 * their features, backgrounds, feats, optional features (invocations / maneuvers /
 * metamagic / fighting styles), equipment, spells, languages and rules reference.
 * Bestiary, adventures, encounters, vehicles and DM tooling are all skipped.
 *
 * Every record is tagged with:
 *   edition : "2024" (5.5e / XPHB-era) or "2014" (5e / PHB-era)
 *   srd     : true when the record is covered by an SRD released under CC BY 4.0
 *
 * The `srd` flag drives the two-tier build (see --tier below).
 *
 * Usage:
 *   node tools/extract-5etools.mjs --src "<path to 5etools>/data" [--out dnd/creator/data] [--tier full|srd]
 */

import fs from "node:fs";
import path from "node:path";

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
	const i = argv.indexOf(`--${name}`);
	return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const SRC = arg("src");
const OUT = arg("out", "dnd/creator/data");
const TIER = arg("tier", "full"); // "full" = everything, "srd" = CC BY 4.0 material only

if (!SRC) {
	console.error("Missing --src. Point it at your 5etools `data` directory.\n");
	console.error('  node tools/extract-5etools.mjs --src "C:/path/to/5etools/data"');
	process.exit(1);
}
if (!fs.existsSync(SRC)) {
	console.error(`Source directory not found: ${SRC}`);
	process.exit(1);
}
if (!["full", "srd"].includes(TIER)) {
	console.error(`--tier must be "full" or "srd" (got "${TIER}")`);
	process.exit(1);
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

const readJson = (...p) => {
	const file = path.join(SRC, ...p);
	if (!fs.existsSync(file)) return null;
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (err) {
		console.warn(`  ! could not parse ${path.join(...p)}: ${err.message}`);
		return null;
	}
};

const slug = (s) =>
	String(s)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");

/** Stable id that keeps same-named entries from different books distinct. */
const idOf = (name, source) => `${slug(name)}--${slug(source)}`;

/**
 * 5etools marks 2024 material with edition "one" -- but only on races, classes,
 * backgrounds, feats and optional features. Spells and items carry no `edition`
 * field at all, so for those we fall back to the source book. This set is the
 * list of 2024-edition books, derived from the sources that do carry the flag.
 */
const EDITION_2024_SOURCES = new Set([
	"XPHB", "XDMG", "XMM", "ABH", "EFA", "FRHoF", "LFL", "RHW", "SatO", "HotB",
]);

const editionOf = (e) => {
	if (e?.edition) return e.edition === "one" ? "2024" : "2014";
	return EDITION_2024_SOURCES.has(e?.source) ? "2024" : "2014";
};

/** True when the entry is in either SRD (5.1 for 2014, 5.2.1 for 2024). */
const isSrd = (e) => Boolean(e?.srd || e?.srd52);

/** srd flag normalised to which SRD it came from, for attribution. */
const srdSourceOf = (e) => (e?.srd52 ? "SRD 5.2.1" : e?.srd ? "SRD 5.1" : null);

const uniq = (arr) => [...new Set(arr)];
const compact = (obj) => {
	const out = {};
	for (const [k, v] of Object.entries(obj)) {
		if (v === undefined || v === null) continue;
		if (Array.isArray(v) && v.length === 0) continue;
		if (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) continue;
		out[k] = v;
	}
	return out;
};

/* ------------------------------------------------------------------ *
 * {@tag ...} markup renderer
 *
 * 5etools rules text is peppered with inline tags:
 *   {@item Longsword|XPHB}          -> Longsword
 *   {@item Book|XPHB|Book (prayers)}-> Book (prayers)   (3rd part is the display text)
 *   {@damage 8d6}                   -> 8d6
 *   {@dc 15}                        -> DC 15
 *   {@i text} / {@b text}           -> <em> / <strong>
 * Tags nest, so we resolve inside-out until none remain.
 * ------------------------------------------------------------------ */

const REF_TAGS = new Set([
	"item", "spell", "condition", "skill", "sense", "feat", "action", "creature",
	"race", "class", "classFeature", "subclassFeature", "optfeature", "background",
	"variantrule", "hazard", "disease", "status", "language", "deity", "reward",
	"table", "vehicle", "object", "trap", "psionic", "boon", "cult", "itemMastery",
	"card", "legroup", "book", "adventure", "quickref", "filter", "footnote", "area",
]);

/** {@atk}/{@atkr} codes. 2014 uses mw/rw, 2024 uses m/r. */
const ATTACK_KINDS = {
	m: "Melee", r: "Ranged",
	mw: "Melee Weapon", rw: "Ranged Weapon",
	ms: "Melee Spell", rs: "Ranged Spell",
};

const escapeHtml = (s) =>
	String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function renderTag(tag, body) {
	const parts = body.split("|");
	const first = parts[0] ?? "";

	switch (tag) {
		case "i": case "italic": case "note":
			return `<em>${first}</em>`;
		case "b": case "bold":
			return `<strong>${first}</strong>`;
		case "s": case "strike":
			return `<s>${first}</s>`;
		case "u": case "underline":
			return `<u>${first}</u>`;

		// Dice and numbers
		case "dice": case "damage": case "d20": case "autodice":
			return `<span class="rr-dice">${first}</span>`;
		case "hit": {
			// A bare "5" is an attack bonus and needs its sign to read correctly.
			const n = Number(first);
			return `<span class="rr-dice">${Number.isFinite(n) && n >= 0 ? `+${n}` : first}</span>`;
		}
		case "scaledamage": case "scaledice":
			// {@scaledamage 8d6|3-9|1d6} -> the base value is the last part
			return `<span class="rr-dice">${parts[2] ?? first}</span>`;
		case "dc":
			return `DC ${first}`;
		case "chance":
			return `${first} percent`;
		case "recharge":
			return first ? `Recharge ${first}-6` : "Recharge 6";
		case "coinflip":
			return "flip a coin";

		// Attack lines. {@atkr m} {@hit 5} renders as "Melee Attack Roll: +5";
		// dropping these leaves stat block actions reading "Bite5, reach 5 ft."
		case "h": return "<em>Hit:</em> ";
		case "m": return "<em>Miss:</em> ";
		case "atk": case "atkr": {
			const kinds = first.split(",").map((c) => ATTACK_KINDS[c.trim()] ?? c.trim());
			return `<em>${kinds.join(" or ")} Attack Roll:</em> `;
		}
		case "hom": return "";
		case "5etools": case "5etoolsImg": case "loader": case "link":
			return parts[0];
		case "color":
			return first;
		case "highlight":
			return `<mark>${first}</mark>`;

		// These put their display text FIRST and use the later parts as routing
		// arguments, unlike {@item Name|SOURCE|display}. Reading parts[2] here
		// would print machine junk such as "level=0" into the rules text.
		case "filter": case "quickref": case "book": case "adventure": case "footnote":
			return `<span class="rr-ref">${first}</span>`;

		default:
			if (REF_TAGS.has(tag)) {
				// display text is the 3rd pipe part when present, else the name
				const display = parts[2] || parts[0];
				// Keep the tag, name and source in a data attribute so the app can
				// look the reference up and show it. Without this the rendered HTML
				// says "Insight" with no way to tell a skill from a spell.
				const name = parts[0].trim();
				const source = (parts[1] ?? "").trim();
				const ref = `${tag}|${name}|${source}`.replace(/"/g, "&quot;");
				return `<span class="rr-ref" data-ref="${ref}">${display}</span>`;
			}
			// Unknown tag: fall back to its first argument so no text is lost.
			return first;
	}
}

/**
 * Magic variant text uses a second, different templating syntax: {=field}
 * substitutes a value from the variant's own `inherits` block, so the shared
 * "+N Weapon" description reads "+1" or "+3" depending on the variant. Without
 * this, the rules text renders the literal "{=bonusWeapon".
 *
 * A trailing /modifier adjusts the substitution: /u uppercase, /l lowercase,
 * /t title case, /a prefixes an article.
 */
function substituteFields(str, fields) {
	if (typeof str !== "string" || !fields) return str;

	return str.replace(/\{=(\w+)(?:\/([^}]+))?\}/g, (whole, key, mod) => {
		let value = fields[key];
		if (value == null) return whole;
		value = String(value);

		switch (mod) {
			case "u": return value.toUpperCase();
			case "l": return value.toLowerCase();
			case "t": return value.replace(/\b\w/g, (c) => c.toUpperCase());
			case "a": return `${/^[aeiou]/i.test(value) ? "an" : "a"} ${value}`;
			default: return value;
		}
	});
}

function renderInline(str, fields = null) {
	if (typeof str !== "string") return "";
	let out = escapeHtml(fields ? substituteFields(str, fields) : str);
	// Resolve innermost {@tag ...} first, repeatedly, so nested tags unwind.
	const re = /\{@(\w+)\s*([^{}]*)\}/;
	let guard = 0;
	while (re.test(out) && guard++ < 50) {
		out = out.replace(new RegExp(re, "g"), (_m, tag, body) => renderTag(tag, body));
	}
	// Any malformed leftovers get their braces dropped rather than shown raw.
	return out.replace(/\{@\w+\s*/g, "").replace(/\}/g, "").trim();
}

/**
 * Some 5etools structures are passed through verbatim (class table rows, spell
 * casting times, attunement notes). Those still contain {@tag} markup, so walk
 * the whole value and render every string inside it. Only ever call this on raw
 * source data -- running it over already-rendered HTML would double-escape it.
 */
function deepRender(value) {
	if (typeof value === "string") return renderPlain(value);
	if (Array.isArray(value)) return value.map(deepRender);
	if (value && typeof value === "object") {
		const out = {};
		for (const [k, v] of Object.entries(value)) out[k] = deepRender(v);
		return out;
	}
	return value;
}

/**
 * Finds every {@creature Name|SOURCE} reference inside a raw entries tree.
 *
 * Summoning spells do not carry the summoned stat block; they point at one.
 * "Summon Elemental" references Elemental Spirit, the Beast Master references
 * Beast of the Land/Sea/Sky. Collecting the references while the source tag is
 * still present lets the UI link a spell straight to its stat block, which is
 * the thing you actually need at the table.
 *
 * Must run on RAW entries -- rendering strips the |SOURCE part.
 */
function collectCreatureRefs(entries) {
	const found = new Map();
	const re = /\{@creature\s+([^}|]+)(?:\|([^}|]*))?(?:\|[^}]*)?\}/g;

	const walk = (value) => {
		if (typeof value === "string") {
			for (const m of value.matchAll(re)) {
				const name = m[1].trim();
				const source = (m[2] || "").trim() || "MM";
				found.set(`${name}|${source}`, { name, source });
			}
			return;
		}
		if (Array.isArray(value)) return value.forEach(walk);
		if (value && typeof value === "object") Object.values(value).forEach(walk);
	};

	walk(entries);
	return [...found.values()].map((c) => ({ ...c, id: idOf(c.name, c.source) }));
}

/**
 * Finds every {@spell Name|SOURCE} reference in a raw entries tree.
 *
 * Species and feats hand out spells in prose: the High Elf lineage grants
 * Prestidigitation, Magic Initiate grants two cantrips. Without collecting these
 * the spell list can only show what the class grants, and a player has no way to
 * tell where a cantrip they already have came from.
 *
 * Must run on RAW entries -- rendering strips the |SOURCE part.
 */
function collectSpellRefs(entries) {
	const found = new Map();
	const re = /\{@spell\s+([^}|]+)(?:\|([^}|]*))?(?:\|[^}]*)?\}/g;

	const walk = (value) => {
		if (typeof value === "string") {
			for (const m of value.matchAll(re)) {
				const name = m[1].trim();
				const source = (m[2] || "").trim() || "PHB";
				found.set(name.toLowerCase(), { name, source, id: idOf(name, source) });
			}
			return;
		}
		if (Array.isArray(value)) return value.forEach(walk);
		if (value && typeof value === "object") Object.values(value).forEach(walk);
	};

	walk(entries);
	return [...found.values()];
}

/** Plain-text version, for search indexes and the printable sheet. */
const renderPlain = (str) =>
	renderInline(str)
		.replace(/<[^>]+>/g, "")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/\s+/g, " ")
		.trim();

/**
 * Recursively flatten a 5etools `entries` tree into a list of blocks:
 *   { type: "text",  html }
 *   { type: "list",  items: [html] }
 *   { type: "table", caption, colLabels, rows }
 *   { type: "sub",   name, blocks: [...] }
 */
function renderEntries(entries, depth = 0) {
	if (!entries) return [];
	const list = Array.isArray(entries) ? entries : [entries];
	const out = [];

	for (const e of list) {
		if (e == null) continue;

		if (typeof e === "string") {
			const html = renderInline(e);
			if (html) out.push({ type: "text", html });
			continue;
		}

		switch (e.type) {
			case "entries":
			case "section":
			case "inset":
			case "insetReadaloud": {
				const blocks = renderEntries(e.entries, depth + 1);
				if (e.name) out.push({ type: "sub", name: renderPlain(e.name), blocks });
				else out.push(...blocks);
				break;
			}
			case "list": {
				const items = (e.items ?? []).map((it) => {
					if (typeof it === "string") return renderInline(it);
					if (it.type === "item" || it.type === "itemSpell" || it.type === "itemSub") {
						const nm = it.name ? `<strong>${renderInline(it.name)}</strong> ` : "";
						const body = it.entry
							? renderInline(it.entry)
							: renderEntries(it.entries, depth + 1).map(blockToHtml).join(" ");
						return `${nm}${body}`.trim();
					}
					return renderEntries(it, depth + 1).map(blockToHtml).join(" ");
				}).filter(Boolean);
				if (items.length) out.push({ type: "list", items });
				break;
			}
			case "table": {
				out.push({
					type: "table",
					caption: e.caption ? renderPlain(e.caption) : undefined,
					colLabels: (e.colLabels ?? []).map(renderPlain),
					rows: (e.rows ?? []).map((row) =>
						(Array.isArray(row) ? row : [row]).map((cell) =>
							typeof cell === "object" && cell !== null
								? renderPlain(cell.roll ? `${cell.roll.min ?? cell.roll.exact}` : JSON.stringify(cell))
								: renderPlain(cell),
						),
					),
				});
				break;
			}
			case "item": case "itemSub": case "itemSpell": {
				const nm = e.name ? `<strong>${renderInline(e.name)}</strong> ` : "";
				const body = e.entry
					? renderInline(e.entry)
					: renderEntries(e.entries, depth + 1).map(blockToHtml).join(" ");
				out.push({ type: "text", html: `${nm}${body}`.trim() });
				break;
			}
			case "options": {
				const blocks = renderEntries(e.entries, depth + 1);
				out.push(...blocks);
				break;
			}
			case "quote": {
				const body = renderEntries(e.entries, depth + 1).map(blockToHtml).join(" ");
				out.push({ type: "text", html: `<em>${body}</em>` });
				break;
			}
			case "abilityDc":
				out.push({
					type: "text",
					html: `<strong>Spell save DC</strong> = 8 + Proficiency Bonus + ${(e.attributes ?? []).map((a) => a.toUpperCase()).join(" or ")} modifier`,
				});
				break;
			case "abilityAttackMod":
				out.push({
					type: "text",
					html: `<strong>Spell attack modifier</strong> = Proficiency Bonus + ${(e.attributes ?? []).map((a) => a.toUpperCase()).join(" or ")} modifier`,
				});
				break;
			// Cross-references to another feature. These are resolved and inlined by
			// inlineRefs() before rendering; anything still here could not be
			// resolved, so drop the dangling pointer rather than print it raw.
			case "refClassFeature": case "refSubclassFeature": case "refOptionalfeature":
				break;
			case "image": case "gallery": case "link":
				break;
			default: {
				if (e.entries) out.push(...renderEntries(e.entries, depth + 1));
				else if (e.entry) out.push({ type: "text", html: renderInline(e.entry) });
			}
		}
	}
	return out;
}

const blockToHtml = (b) => {
	switch (b.type) {
		case "text": return b.html;
		case "list": return `<ul>${b.items.map((i) => `<li>${i}</li>`).join("")}</ul>`;
		case "sub": return `<strong>${b.name}.</strong> ${b.blocks.map(blockToHtml).join(" ")}`;
		case "table": return `<table><thead><tr>${b.colLabels.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${b.rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
		default: return "";
	}
};

/** Short one-line summary used for card blurbs in the picker UI. */
function blurbFrom(blocks, max = 190) {
	for (const b of blocks) {
		if (b.type !== "text") continue;
		const plain = b.html.replace(/<[^>]+>/g, "").trim();
		if (plain.length < 25) continue;
		return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}\u2026` : plain;
	}
	return "";
}

/* ------------------------------------------------------------------ *
 * Shared normalisers
 * ------------------------------------------------------------------ */

/**
 * 5etools proficiency maps take several shapes:
 *   [{ "athletics": true }]            a fixed grant
 *   [{ choose: { from: [...], count } }] an explicit choice
 *   [{ anyGamingSet: 1 }]              choose 1 from a named category
 *   [{ any: 2 }]                       choose 2 from anything
 *
 * Skills are slugged because their ids are matched against rules.json. Tools and
 * languages keep their printed names, since slugging turns "Calligrapher's
 * Supplies" into "calligrapher-s-supplies", which then displays as nonsense.
 */
function normProficiencies(arr, { slugify = true } = {}) {
	if (!arr) return { fixed: [], choices: [] };
	const fixed = [];
	const choices = [];

	for (const entry of Array.isArray(arr) ? arr : [arr]) {
		if (!entry || typeof entry !== "object") continue;
		for (const [k, v] of Object.entries(entry)) {
			if (k === "choose") {
				choices.push({
					count: v.count ?? 1,
					from: (v.from ?? []).map((f) => (slugify ? slug(f) : titleCase(f))),
				});
			} else if (k === "any" || k === "anyStandard") {
				choices.push({ count: typeof v === "number" ? v : 1, from: "any" });
			} else if (/^any[A-Z]/.test(k)) {
				// anyGamingSet -> "Gaming Set", anyArtisansTool -> "Artisans Tool"
				const category = k.slice(3).replace(/([a-z])([A-Z])/g, "$1 $2");
				choices.push({
					count: typeof v === "number" ? v : 1,
					from: "category",
					category,
				});
			} else if (v === true) {
				fixed.push(slugify ? slug(k) : titleCase(k));
			}
		}
	}
	return { fixed: uniq(fixed), choices };
}

/** Background/species ability blocks: fixed bonuses plus weighted choices. */
function normAbility(arr) {
	if (!arr) return null;
	const out = { fixed: {}, choices: [] };
	for (const entry of Array.isArray(arr) ? arr : [arr]) {
		if (!entry || typeof entry !== "object") continue;
		for (const [k, v] of Object.entries(entry)) {
			if (k === "choose") {
				if (v.weighted) {
					out.choices.push({
						kind: "weighted",
						from: v.weighted.from ?? [],
						weights: v.weighted.weights ?? [],
					});
				} else {
					out.choices.push({
						kind: "any",
						from: v.from ?? [],
						count: v.count ?? 1,
						amount: v.amount ?? 1,
					});
				}
			} else if (typeof v === "number") {
				out.fixed[k] = (out.fixed[k] ?? 0) + v;
			}
		}
	}
	return compact(out);
}

/**
 * Starting-equipment entries can name a whole category instead of one item
 * ("any Gaming Set"). 5etools writes these noun-first in camelCase, so
 * "setGaming" naively title-cases to the nonsense "SetGaming". Map them.
 */
const EQUIPMENT_TYPE_NAMES = {
	setGaming: "Gaming Set",
	toolArtisan: "Artisan's Tools",
	instrumentMusical: "Musical Instrument",
	weaponSimple: "any Simple weapon",
	weaponMartial: "any Martial weapon",
	weaponSimpleMelee: "any Simple melee weapon",
	weaponMartialMelee: "any Martial melee weapon",
	focusSpellcastingArcane: "Arcane Focus",
	focusSpellcastingDruidic: "Druidic Focus",
	focusSpellcastingHoly: "Holy Symbol",
};

/** Starting equipment: { A: [...], B: [...] } option sets; values are in copper. */
function normStartingEquipment(se) {
	if (!se) return null;
	const groups = Array.isArray(se) ? se : [se];
	const options = [];

	for (const group of groups) {
		if (!group || typeof group !== "object") continue;
		for (const [key, contents] of Object.entries(group)) {
			if (!/^[A-Z]$/.test(key) || !Array.isArray(contents)) continue;
			const items = [];
			let gold = 0;
			for (const c of contents) {
				if (c == null) continue;
				// Most background kits list plain strings ("bedroll|xphb") rather than
				// objects. Treated as prose these lost their item reference, which put
				// a line reading "bedroll|xphb" on the sheet with nothing behind it.
				const entry = typeof c === "string" ? { item: c } : c;
				if (typeof entry.value === "number") { gold += entry.value / 100; continue; }
				const c2 = entry;
				// "spellbook" arrives as a {special} entry even though there is a real
				// Spellbook item, so a special that names a known item gets its ref.
				const rawRef = c2.item ?? c2.special ?? c2.equipmentType;
				if (!rawRef) continue;
				const [nm] = String(rawRef).split("|");
				const isCategory = Boolean(c2.equipmentType && !c2.item);
				items.push(compact({
					name: c2.displayName
						?? (isCategory ? (EQUIPMENT_TYPE_NAMES[nm] ?? titleCase(nm)) : titleCase(nm)),
					ref: c2.item || c2.special ? slug(nm) : undefined,
					// A category entry needs the player to choose a specific item.
					category: isCategory ? (EQUIPMENT_TYPE_NAMES[nm] ?? titleCase(nm)) : undefined,
					quantity: c2.quantity ?? 1,
				}));
			}
			options.push(compact({ key, items, gold: gold || undefined }));
		}
	}
	return options.length ? options : null;
}

/**
 * Title case that leaves the small words alone, because spell and item names
 * are written "Speak with Animals" and "Aura of Life", not "Speak With Animals".
 * The first word is always capitalised.
 */
const SMALL_WORDS = new Set([
	"a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "of", "on",
	"or", "the", "to", "with", "without", "into", "per",
]);

const titleCase = (s) =>
	String(s)
		.split(/(\s+)/)
		.map((word, i) => {
			if (/^\s+$/.test(word)) return word;
			const lower = word.toLowerCase();
			if (i > 0 && SMALL_WORDS.has(lower)) return lower;
			return word.replace(/^\w/, (c) => c.toUpperCase());
		})
		.join("")
		.replace(/'S\b/g, "'s");

/* ------------------------------------------------------------------ *
 * Extractors
 * ------------------------------------------------------------------ */

/**
 * Descriptive flavour text lives in separate fluff-*.json files. We only want
 * the opening paragraph, as a blurb for the picker cards.
 */
function loadFluff(file, key) {
	const raw = readJson(file);
	const map = new Map();
	for (const f of raw?.[key] ?? []) {
		const b = blurbFrom(renderEntries(f.entries));
		if (b) map.set(`${f.name}|${f.source}`, b);
	}
	return map;
}

/**
 * 2024 species express their required pick (lineage, ancestry, legacy) inside
 * the trait text rather than as a subrace. Two encodings show up:
 *
 *   a) a table whose first column is the option name
 *      (Elf "Elven Lineages", Dragonborn "Draconic Ancestors", Tiefling "Fiendish Legacies")
 *   b) a hanging list of named items
 *      (Goliath "Giant Ancestry", Gnome "Gnomish Lineage", Aasimar "Celestial Revelation")
 *
 * Both are normalised into the same { id, name, prompt, options[] } shape so the
 * wizard can render one picker regardless of how the book laid it out.
 */
const CHOICE_TRAIT_RE = /lineage|ancestry|legacy|revelation|ancestor/i;

function extractSpeciesChoices(entries) {
	const choices = [];
	if (!Array.isArray(entries)) return choices;

	for (const trait of entries) {
		if (!trait || typeof trait !== "object" || !trait.name) continue;
		if (!CHOICE_TRAIT_RE.test(trait.name)) continue;

		const sub = Array.isArray(trait.entries) ? trait.entries : [];
		const prompt = sub.filter((x) => typeof x === "string").map(renderPlain)[0] ?? "";
		let options = [];

		// (a) table encoding
		const table = sub.find((x) => x && typeof x === "object" && x.type === "table");
		if (table?.rows?.length) {
			const labels = (table.colLabels ?? []).map(renderPlain);
			options = table.rows.map((row) => {
				const cells = (Array.isArray(row) ? row : [row]).map((c) =>
					typeof c === "object" && c !== null ? renderPlain(JSON.stringify(c)) : c,
				);
				const name = renderPlain(cells[0]);
				// Remaining columns become labelled detail lines (Level 1 / Level 3 / ...).
				const detail = cells.slice(1).map((c, i) => {
					const lbl = labels[i + 1];
					const body = renderInline(String(c));
					return lbl && !/^level 1$/i.test(lbl)
						? `<strong>${lbl}:</strong> ${body}`
						: body;
				});
				// The columns are "Level 1 / Level 3 / Level 5", so the label tells
				// us when each spell unlocks. Without this the app would offer a
				// level-5 spell to a level-1 character.
				const spellsByLevel = {};
				cells.slice(1).forEach((cell, ci) => {
					const label = labels[ci + 1] ?? "";
					const m = /level\s*(\d+)/i.exec(label);
					const gate = m ? Number(m[1]) : 1;
					const refs = collectSpellRefs(cell);
					if (!refs.length) return;
					spellsByLevel[gate] = [...(spellsByLevel[gate] ?? []), ...refs];
				});

				return compact({
					id: slug(name), name,
					html: detail.join(" &middot; "),
					spellRefs: collectSpellRefs(row),
					spellsByLevel,
				});
			});
		}

		// (b) hanging-list encoding
		if (!options.length) {
			const list = sub.find((x) => x && typeof x === "object" && x.type === "list");
			if (list?.items?.length) {
				options = list.items
					.filter((it) => it && typeof it === "object" && it.name)
					.map((it) => {
						const name = renderPlain(it.name);
						const html = it.entry
							? renderInline(it.entry)
							: renderEntries(it.entries).map(blockToHtml).join(" ");
						const refs = collectSpellRefs(it.entries ?? it.entry);
						return compact({
							id: slug(name), name, html,
							spellRefs: refs,
							// Hanging-list options have no level table: available at once.
							spellsByLevel: refs.length ? { 1: refs } : undefined,
						});
					});
			}
		}

		if (options.length > 1) {
			choices.push({
				id: slug(trait.name),
				name: renderPlain(trait.name),
				prompt,
				options,
			});
		}
	}

	// A species can also grant a feat outright: the 2024 Human's Versatile trait
	// reads "You gain an Origin feat of your choice". That is a required decision
	// with no table behind it, so it is detected from the trait text.
	for (const trait of entries) {
		if (!trait || typeof trait !== "object" || !trait.name) continue;
		const text = renderPlain(JSON.stringify(trait.entries ?? []));
		const match = /\b(Origin|General|Fighting Style|Epic Boon)\s+feat\b/i.exec(text);
		if (!match) continue;

		choices.push({
			id: slug(trait.name),
			name: renderPlain(trait.name),
			prompt: renderPlain(
				(trait.entries ?? []).find((e) => typeof e === "string") ?? "Choose a feat.",
			),
			type: "feat",
			featCategory: match[1].toLowerCase().replace(/\s+/g, "-"),
			count: 1,
		});
	}

	return choices;
}

function extractSpecies() {
	const raw = readJson("races.json");
	if (!raw) return [];
	const subraces = raw.subrace ?? [];
	const fluff = loadFluff("fluff-races.json", "raceFluff");

	return (raw.race ?? []).map((r) => {
		const blocks = renderEntries(r.entries);
		const traits = blocks
			.filter((b) => b.type === "sub")
			.map((b) => ({ name: b.name, html: b.blocks.map(blockToHtml).join(" ") }));

		const mine = subraces.filter(
			(s) => s.raceName === r.name && s.raceSource === r.source,
		);

		return compact({
			id: idOf(r.name, r.source),
			name: r.name,
			source: r.source,
			page: r.page,
			edition: editionOf(r),
			srd: isSrd(r),
			srdSource: srdSourceOf(r),
			creatureTypes: r.creatureTypes,
			size: r.size,
			speed: typeof r.speed === "object" ? r.speed : { walk: r.speed ?? 30 },
			darkvision: r.darkvision,
			resist: r.resist,
			immune: r.immune,
			conditionImmune: r.conditionImmune,
			ability: normAbility(r.ability),
			skillProficiencies: normProficiencies(r.skillProficiencies),
			languageProficiencies: normProficiencies(r.languageProficiencies, { slugify: false }),
			traitTags: r.traitTags,
			age: r.age,
			blurb: fluff.get(`${r.name}|${r.source}`) ?? blurbFrom(blocks),
			// Spells this species hands out in its trait text.
			spellRefs: collectSpellRefs(r.entries),
			traits,
			// Required in-trait picks (Elven Lineage, Draconic Ancestry, ...).
			choices: extractSpeciesChoices(r.entries),
			// A subrace/lineage is a required pick when the species defines any.
			lineages: mine.map((s) => {
				const sb = renderEntries(s.entries);
				return compact({
					id: idOf(`${r.name}-${s.name ?? "variant"}`, s.source),
					name: s.name ?? "Variant",
					source: s.source,
					edition: editionOf(s),
					srd: isSrd(s),
					speed: typeof s.speed === "object" ? s.speed : s.speed ? { walk: s.speed } : undefined,
					darkvision: s.darkvision,
					resist: s.resist,
					ability: normAbility(s.ability),
					skillProficiencies: normProficiencies(s.skillProficiencies),
					blurb: blurbFrom(sb),
					traits: sb
						.filter((b) => b.type === "sub")
						.map((b) => ({ name: b.name, html: b.blocks.map(blockToHtml).join(" ") })),
					html: sb.map(blockToHtml).join(""),
				});
			}),
		});
	});
}

function extractBackgrounds() {
	const raw = readJson("backgrounds.json");
	if (!raw) return [];
	const fluff = loadFluff("fluff-backgrounds.json", "backgroundFluff");

	return (raw.background ?? []).map((b) => {
		const blocks = renderEntries(b.entries);
		return compact({
			id: idOf(b.name, b.source),
			name: b.name,
			source: b.source,
			page: b.page,
			edition: editionOf(b),
			srd: isSrd(b),
			srdSource: srdSourceOf(b),
			ability: normAbility(b.ability),
			// 2024 backgrounds grant exactly one origin feat.
			feats: (b.feats ?? []).flatMap((f) =>
				Object.keys(f).filter((k) => f[k] === true).map((k) => {
					const [nm] = k.split("|");
					return { name: titleCase(nm), ref: slug(nm) };
				}),
			),
			skillProficiencies: normProficiencies(b.skillProficiencies),
			toolProficiencies: normProficiencies(b.toolProficiencies, { slugify: false }),
			languageProficiencies: normProficiencies(b.languageProficiencies, { slugify: false }),
			startingEquipment: normStartingEquipment(b.startingEquipment),
			spellRefs: collectSpellRefs(b.entries),
			blurb: fluff.get(`${b.name}|${b.source}`) ?? blurbFrom(blocks),
			html: blocks.map(blockToHtml).join(""),
		});
	});
}

/**
 * The decisions a feat makes you take, and the things it hands over.
 *
 * Feats are the most mechanically varied thing in the book: Resilient raises an
 * ability AND grants a saving throw proficiency, Skilled hands out three skills
 * or tools, Magic Initiate gives cantrips chosen from another class's list. All
 * of that is structured in the source data, so it is normalised here rather than
 * left as prose the app cannot act on.
 *
 * Produces:
 *   abilityChoices  [{ from, amount, count }]   pick which ability to raise
 *   fixedAbility    { str: 1, ... }             raised outright
 *   saveChoices     [{ from }]                  Resilient's save proficiency
 *   skillChoices    [{ from, count }]           "anySkill"/"anyTool" expand later
 *   spellGrants     [...]                       fixed spells, as for subclasses
 *   spellChoices    [{ variant, kind, level, count, filter }]  pick from a list
 */
function normFeatMechanics(feat) {
	const abilityChoices = [];
	const fixedAbility = {};

	for (const block of feat.ability ?? []) {
		if (!block || typeof block !== "object") continue;
		if (block.choose) {
			abilityChoices.push(compact({
				from: block.choose.from ?? [],
				amount: block.choose.amount ?? 1,
				count: block.choose.count ?? 1,
				hidden: block.hidden || undefined,
			}));
			continue;
		}
		for (const [k, v] of Object.entries(block)) {
			if (typeof v === "number") fixedAbility[k] = (fixedAbility[k] ?? 0) + v;
		}
	}

	const saveChoices = [];
	for (const block of feat.savingThrowProficiencies ?? []) {
		if (block?.choose?.from) saveChoices.push({ from: block.choose.from });
	}

	const languages = normProficiencies(feat.languageProficiencies, { slugify: false });

	// Skilled and friends: "anySkill" / "anyTool" are expanded by the app, which
	// knows the character's existing proficiencies.
	const skillChoices = [];
	for (const block of feat.skillToolLanguageProficiencies ?? []) {
		for (const choice of (Array.isArray(block?.choose) ? block.choose : [block?.choose]).filter(Boolean)) {
			skillChoices.push({ from: choice.from ?? [], count: choice.count ?? 1 });
		}
	}
	for (const block of feat.skillProficiencies ?? []) {
		if (block?.choose?.from) {
			skillChoices.push({ from: block.choose.from, count: block.choose.count ?? 1 });
		}
	}

	// Spells: fixed grants reuse the subclass normaliser; the "choose from a
	// list" placeholders become explicit choices.
	const spellGrants = normAdditionalSpells(feat.additionalSpells);
	const spellChoices = [];

	for (const group of feat.additionalSpells ?? []) {
		if (!group || typeof group !== "object") continue;
		const variant = group.name ?? null;

		for (const kind of ["known", "innate", "prepared", "expanded"]) {
			const byLevel = group[kind];
			if (!byLevel || typeof byLevel !== "object") continue;

			// Feats use "_" for "no level gate".
			for (const [levelKey, value] of Object.entries(byLevel)) {
				const level = levelKey === "_" ? 1 : Number(levelKey);
				if (!Number.isFinite(level)) continue;

				const collect = (list, note) => {
					for (const raw of Array.isArray(list) ? list : [list]) {
						if (!raw || typeof raw !== "object" || !raw.choose) continue;
						spellChoices.push(compact({
							variant, kind, level, note,
							count: raw.count ?? 1,
							filter: String(raw.choose),
						}));
					}
				};

				if (Array.isArray(value)) { collect(value); continue; }
				if (value && typeof value === "object") {
					for (const [mode, inner] of Object.entries(value)) {
						if (Array.isArray(inner)) { collect(inner, mode); continue; }
						if (inner && typeof inner === "object") {
							for (const [times, list] of Object.entries(inner)) {
								const per = times.endsWith("e") ? `${times.slice(0, -1)}/day each` : `${times}/day`;
								collect(list, `${mode} ${per}`);
							}
						}
					}
				}
			}
		}
	}

	// The spellcasting ability, where the feat lets you choose it.
	const spellAbility = (feat.additionalSpells ?? [])
		.map((g) => g?.ability)
		.filter(Boolean)
		.map((a) => (a === "inherit" ? { inherit: true } : { choose: a.choose ?? [a] }))[0] ?? null;

	return compact({
		// { fixed: ["Sylvan"], choices: [{ count: 3, from: "any" }] }
		languages: (languages?.fixed?.length || languages?.choices?.length) ? languages : undefined,
		abilityChoices,
		fixedAbility,
		saveChoices,
		skillChoices,
		spellGrants,
		spellChoices,
		spellAbility,
		// Variant names, when the feat offers alternative packages.
		spellVariants: uniq((feat.additionalSpells ?? []).map((g) => g?.name).filter(Boolean)),
	});
}

function extractFeats() {
	const raw = readJson("feats.json");
	if (!raw) return [];

	const CATEGORY = {
		O: "origin", G: "general", FS: "fighting-style",
		"FS:P": "fighting-style", "FS:R": "fighting-style", EB: "epic-boon",
	};

	return (raw.feat ?? []).map((f) => {
		const blocks = renderEntries(f.entries);
		return compact({
			id: idOf(f.name, f.source),
			name: f.name,
			source: f.source,
			page: f.page,
			edition: editionOf(f),
			srd: isSrd(f),
			category: CATEGORY[f.category] ?? (f.category ? slug(f.category) : "general"),
			repeatable: f.repeatable,
			prerequisite: f.prerequisite ? renderPrereq(f.prerequisite) : null,
			ability: normAbility(f.ability),
			// Everything the feat makes you choose, and everything it grants.
			mechanics: normFeatMechanics(f),
			skillProficiencies: normProficiencies(f.skillProficiencies),
			toolProficiencies: normProficiencies(f.toolProficiencies, { slugify: false }),
			blurb: blurbFrom(blocks),
			// Magic Initiate and friends grant spells; record which.
			spellRefs: collectSpellRefs(f.entries),
			html: blocks.map(blockToHtml).join(""),
		});
	});
}

/** Prerequisites arrive as structured objects; render them to a readable line. */
function renderPrereq(prereq) {
	const parts = [];
	for (const p of Array.isArray(prereq) ? prereq : [prereq]) {
		if (!p || typeof p !== "object") continue;
		const bits = [];
		if (p.level) bits.push(`Level ${typeof p.level === "object" ? p.level.level : p.level}`);
		if (p.ability) {
			for (const a of Array.isArray(p.ability) ? p.ability : [p.ability]) {
				for (const [k, v] of Object.entries(a)) bits.push(`${k.toUpperCase()} ${v}+`);
			}
		}
		if (p.spellcasting || p.spellcasting2020) bits.push("Spellcasting feature");
		if (p.spellcastingFeature) bits.push("Spellcasting feature");
		if (p.spellcastingPrepared) bits.push("Prepared spellcaster");
		if (p.proficiency) {
			for (const pr of Array.isArray(p.proficiency) ? p.proficiency : [p.proficiency]) {
				for (const [k, v] of Object.entries(pr)) bits.push(`${titleCase(v === true ? k : v)} proficiency`);
			}
		}
		if (p.race) bits.push(uniq(p.race.map((r) => titleCase(r.name))).join(" or "));
		if (p.background) bits.push(uniq(p.background.map((b) => titleCase(b.name ?? b))).join(" or "));
		if (p.feat) bits.push(uniq(p.feat.map((x) => titleCase(String(x).split("|")[0]))).join(" or "));
		if (p.otherSummary?.entry) bits.push(renderPlain(p.otherSummary.entry));
		else if (p.other) bits.push(renderPlain(p.other));
		if (bits.length) parts.push(bits.join(", "));
	}
	return parts.length ? parts.join(" or ") : null;
}

function extractOptionalFeatures() {
	const raw = readJson("optionalfeatures.json");
	if (!raw) return [];

	const TYPE = {
		EI: "eldritch-invocation", MV: "maneuver", "MV:B": "maneuver",
		"MV:C2-UA": "maneuver", MM: "metamagic", "FS:F": "fighting-style",
		"FS:B": "fighting-style", "FS:P": "fighting-style", "FS:R": "fighting-style",
		AI: "artificer-infusion", PB: "pact-boon", RN: "rune", AF: "arcane-shot",
		ED: "elemental-discipline", MT: "metamagic", OTH: "other",
	};

	return (raw.optionalfeature ?? []).map((o) => {
		const blocks = renderEntries(o.entries);
		return compact({
			id: idOf(o.name, o.source),
			name: o.name,
			source: o.source,
			page: o.page,
			edition: editionOf(o),
			srd: isSrd(o),
			featureTypes: uniq((o.featureType ?? []).map((t) => TYPE[t] ?? slug(t))),
			rawTypes: o.featureType,
			prerequisite: o.prerequisite ? renderPrereq(o.prerequisite) : null,
			blurb: blurbFrom(blocks),
			html: blocks.map(blockToHtml).join(""),
		});
	});
}

/**
 * Flattens a class or subclass `additionalSpells` block.
 *
 * This is where domain spells live: a Life Domain Cleric always has Bless and
 * Cure Wounds prepared from level 3, and an Oath of the Ancients Paladin gets
 * Ensnaring Strike and Speak with Animals. They are granted, not chosen, so they
 * do not spend a prepared slot -- but a player still needs to see them.
 *
 * 5etools stores these in six shapes, which are normalised to one list:
 *   prepared   always prepared, the common case
 *   known      added to the spells you know
 *   innate     castable without a slot; sometimes {ritual: []} or {daily: {...}}
 *   expanded   widens the list you may choose from -- NOT granted outright
 *   name       a variant the player picks between (Circle of the Land terrain)
 *
 * Each result is { variant, kind, level, note, spells: [{name, source, id}] }.
 */
function normAdditionalSpells(additionalSpells) {
	const out = [];
	if (!Array.isArray(additionalSpells)) return out;

	const toSpell = (raw) => {
		if (typeof raw !== "string") return null;
		// Entries can carry a filter suffix after a #, which is not a spell name.
		const [namePart] = raw.split("#");
		const [name, source] = namePart.split("|");
		if (!name) return null;
		const src = (source || "PHB").trim();
		return { name: titleCase(name.trim()), source: src.toUpperCase(), id: idOf(name.trim(), src) };
	};

	for (const group of additionalSpells) {
		if (!group || typeof group !== "object") continue;
		const variant = group.name ?? null;

		for (const kind of ["prepared", "known", "innate", "expanded"]) {
			const byLevel = group[kind];
			if (!byLevel || typeof byLevel !== "object") continue;

			for (const [levelKey, value] of Object.entries(byLevel)) {
				const level = Number(levelKey);
				if (!Number.isFinite(level)) continue;

				// A plain list of spells.
				if (Array.isArray(value)) {
					const spells = value.map(toSpell).filter(Boolean);
					if (spells.length) out.push({ variant, kind, level, spells });
					continue;
				}

				// {ritual: [...]} or {daily: {"1": [...], "1e": [...]}}
				if (value && typeof value === "object") {
					for (const [mode, inner] of Object.entries(value)) {
						if (Array.isArray(inner)) {
							const spells = inner.map(toSpell).filter(Boolean);
							if (spells.length) out.push({ variant, kind, level, note: mode, spells });
							continue;
						}
						if (inner && typeof inner === "object") {
							for (const [times, list] of Object.entries(inner)) {
								const spells = (Array.isArray(list) ? list : []).map(toSpell).filter(Boolean);
								if (!spells.length) continue;
								// "1e" means once each; "1" means once in total.
								const per = times.endsWith("e") ? `${times.slice(0, -1)}/day each` : `${times}/day`;
								out.push({ variant, kind, level, note: `${mode} ${per}`, spells });
							}
						}
					}
				}
			}
		}
	}

	return out;
}

/**
 * Works out whether a class feature is a limited resource, and how it recharges.
 *
 * This is what makes a rest mean something: Second Wind has uses that come back
 * on a Short Rest, Action Surge on a Short or Long Rest, Channel Divinity on a
 * Short Rest. None of it is a machine-readable field, so it is read from two
 * places that ARE reliable:
 *
 *   uses     the class table column named after the feature ("Second Wind",
 *            "Channel Divinity", "Focus Points"), which is per level
 *   recharge the regain clause in the feature's own text
 *
 * Features that turn out to have neither are not resources, and return null.
 */
const RESOURCE_COLUMN_ALIASES = {
	"monk's focus": "focus points",
	"ki": "ki points",
	"sorcery points": "sorcery points",
	"rage": "rages",
};

const COUNT_WORDS = { one: 1, two: 2, three: 3, four: 4 };

/**
 * Expertise a feature grants, and which skills it may be spent on.
 *
 * Like the resource counts, this is prose rather than data, but the wording is
 * consistent across every class that grants it:
 *
 *   Rogue     "You gain Expertise in two of your skill proficiencies of your
 *              choice"                                    -> any two you have
 *   Wizard    "Choose one of the following skills in which you have
 *              proficiency: Arcana, History, ..."          -> one from a list
 *   Ranger    "Choose two of your skill proficiencies with which you lack
 *              Expertise"                                  -> any two you have
 *
 * `from` is either an explicit list of skill names or the string "proficient",
 * meaning any skill the character is already proficient in.
 */
function normFeatureExpertise(feature) {
	const text = renderPlain(JSON.stringify(feature.entries ?? []));
	if (!/Expertise/i.test(text)) return null;

	// An explicit list: "the following skills in which you have proficiency: A, B, or C."
	const listed = /following skills? in which you have proficiency:\s*([^.]+)\./i.exec(text);
	if (listed) {
		const from = listed[1]
			.split(/,|\bor\b/)
			.map((t) => t.trim())
			.filter(Boolean);
		const count = COUNT_WORDS[(/Choose (one|two|three|four)/i.exec(text)?.[1] ?? "one").toLowerCase()] ?? 1;
		return compact({ count, from });
	}

	// "Expertise in two of your skill proficiencies", or "Choose two of your
	// skill proficiencies with which you lack Expertise".
	const anyOf =
		/Expertise in (one|two|three|four) of your skill/i.exec(text)
		?? /Choose (one|two|three|four) of your skill proficiencies/i.exec(text);
	if (anyOf) {
		return { count: COUNT_WORDS[anyOf[1].toLowerCase()] ?? 1, from: "proficient" };
	}

	return null;
}

function normFeatureResource(feature, classTableGroups) {
	const text = renderPlain(JSON.stringify(feature.entries ?? []));

	// The clause has to be about *expending and regaining uses*, not merely
	// mentioning a rest. Weapon Mastery lets you swap masteries on a Long Rest
	// and Spellcasting mentions rests constantly, but neither is a resource you
	// spend, so a looser pattern fills the tracker with things that never
	// deplete.
	const spendsUses = /(?:regain(?:s)?\s+(?:all\s+)?(?:your\s+)?(?:expended\s+)?(?:uses|charges|rages|points|slots)|regain\s+the\s+use|can(?:no|')t\s+(?:use|do)\s+[^.]{0,40}?again\s+until|expended\s+uses)/i;
	if (!spendsUses.test(text)) return null;

	// "Short Rest" wins when both are named: "a Short or Long Rest" means it
	// comes back on the shorter of the two.
	let recharge = null;
	if (/Short\s+(?:or\s+Long\s+)?Rest/i.test(text)) recharge = "short";
	else if (/Long\s+Rest/i.test(text)) recharge = "long";

	// Uses from the class table.
	const wanted = (RESOURCE_COLUMN_ALIASES[feature.name.toLowerCase()] ?? feature.name).toLowerCase();
	let uses = null;
	for (const group of classTableGroups ?? []) {
		const cols = (group.colLabels ?? []).map((c) => renderPlain(c).toLowerCase());
		const i = cols.findIndex((c) => c === wanted);
		if (i === -1 || !Array.isArray(group.rows)) continue;
		uses = group.rows.slice(0, 20).map((row) => {
			const cell = Array.isArray(row) ? row[i] : null;
			const n = Number(typeof cell === "object" && cell !== null ? cell.value : cell);
			return Number.isFinite(n) ? n : 0;
		});
		break;
	}

	// Failing a table column, the text often states the count outright.
	let formula = null;
	if (!uses) {
		if (/number of times equal to your Proficiency Bonus/i.test(text)) {
			formula = "proficiency";
		} else if (/(?:number of times|times) equal to your (Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma) modifier/i.test(text)) {
			// Bardic Inspiration and friends scale off an ability instead.
			const ab = /equal to your (Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma) modifier/i.exec(text);
			formula = ab[1].slice(0, 3).toLowerCase();
		} else {
			// Take whichever count appears FIRST. Action Surge reads "once ... and
			// beginning at level 17, twice", so scanning for "twice" on its own would
			// grant the level-17 count from level 2.
			const first = /\b(once|twice)\b/i.exec(text);
			if (first) formula = first[1].toLowerCase() === "twice" ? "2" : "1";
			// "You can't use it again until you finish a Long Rest" is one use.
			else if (/can(?:no|')t\s+(?:use|do)\s+[^.]{0,40}?again\s+until/i.test(text)) formula = "1";
		}
	}

	// Without a recharge clause or a count there is nothing to track.
	if (!recharge) return null;
	if (!uses && !formula) return null;

	// A few features name a table column that counts what you KNOW rather than
	// what you can spend. Those are not resources.
	const KNOWLEDGE_COLUMNS = new Set(["weapon mastery", "cantrips", "prepared spells", "spells known"]);
	if (KNOWLEDGE_COLUMNS.has(wanted)) return null;

	return compact({ recharge, uses, formula });
}

/**
 * Classes are assembled from four parallel arrays in each class file:
 * `class`, `subclass`, `classFeature` and `subclassFeature`. Features are
 * referenced by "Name|Class|Source|Level" strings which we resolve into a
 * level-indexed progression.
 */
function extractClasses() {
	const dir = path.join(SRC, "class");
	if (!fs.existsSync(dir)) return [];

	const files = fs
		.readdirSync(dir)
		.filter((f) => f.startsWith("class-") && f.endsWith(".json"));

	const out = [];

	for (const file of files) {
		const raw = readJson("class", file);
		if (!raw?.class) continue;

		const fluffRaw = readJson("class", `fluff-${file}`);
		const fluff = new Map();
		for (const f of fluffRaw?.classFluff ?? []) {
			const b = blurbFrom(renderEntries(f.entries));
			if (b) fluff.set(`${f.name}|${f.source}`, b);
		}

		// Index features so the "Name|Class|Source|Level" refs can be resolved.
		const featureIndex = new Map();
		for (const cf of raw.classFeature ?? []) {
			featureIndex.set(
				[cf.name, cf.className, cf.classSource, cf.level].map((x) => String(x).toLowerCase()).join("|"),
				cf,
			);
		}
		const subFeatureIndex = new Map();
		for (const sf of raw.subclassFeature ?? []) {
			subFeatureIndex.set(
				[sf.name, sf.className, sf.classSource, sf.subclassShortName, sf.subclassSource, sf.level]
					.map((x) => String(x).toLowerCase()).join("|"),
				sf,
			);
		}

		const resolveFeatureRef = (ref, index) => {
			const key = (typeof ref === "string" ? ref : ref.classFeature ?? ref.subclassFeature ?? "")
				.toLowerCase();
			return index.get(key) ?? null;
		};

		/**
		 * Some features exist only as a cross-reference from another one. The 2024
		 * Beast Master, for instance, lists just "Beast Master" in its feature list
		 * and points at "Primal Companion" with a refSubclassFeature node -- so
		 * dropping refs loses the entire companion rules text.
		 *
		 * Walk the tree and splice the referenced feature's entries in place.
		 * `seen` breaks cycles if two features ever reference each other.
		 */
		const inlineRefs = (entries, seen = new Set()) => {
			if (!Array.isArray(entries)) return entries;

			return entries.flatMap((e) => {
				if (!e || typeof e !== "object") return [e];

				if (e.type === "refClassFeature" || e.type === "refSubclassFeature") {
					const isSub = e.type === "refSubclassFeature";
					const key = String(isSub ? e.subclassFeature : e.classFeature ?? "").toLowerCase();
					if (seen.has(key)) return [];
					const target = (isSub ? subFeatureIndex : featureIndex).get(key);
					if (!target) return [];

					const nextSeen = new Set(seen).add(key);
					return [{
						type: "entries",
						name: target.name,
						entries: inlineRefs(target.entries ?? [], nextSeen),
					}];
				}

				if (Array.isArray(e.entries)) {
					return [{ ...e, entries: inlineRefs(e.entries, seen) }];
				}
				return [e];
			});
		};

		for (const c of raw.class) {
			const prof = c.startingProficiencies ?? {};
			const skills = normProficiencies(prof.skills);

			// Level-indexed feature progression.
			const levels = Array.from({ length: 20 }, (_, i) => ({
				level: i + 1,
				features: [],
				gainsSubclassFeature: false,
			}));

			for (const ref of c.classFeatures ?? []) {
				const isObj = typeof ref === "object";
				const cf = resolveFeatureRef(ref, featureIndex);
				const refStr = isObj ? ref.classFeature : ref;
				const lvl = Number(String(refStr).split("|")[3]) || 1;
				if (lvl < 1 || lvl > 20) continue;

				if (isObj && ref.gainSubclassFeature) levels[lvl - 1].gainsSubclassFeature = true;
				if (!cf) continue;

				const blocks = renderEntries(inlineRefs(cf.entries));
				levels[lvl - 1].features.push(compact({
					name: cf.name,
					level: lvl,
					srd: isSrd(cf),
					creatureRefs: collectCreatureRefs(inlineRefs(cf.entries)),
					// Limited uses and how a rest brings them back.
					resource: normFeatureResource(cf, c.classTableGroups),
					// Expertise this feature lets the player assign.
					expertise: normFeatureExpertise(cf),
					isClassFeatureVariant: cf.isClassFeatureVariant,
					html: blocks.map(blockToHtml).join(""),
					blurb: blurbFrom(blocks, 140),
				}));
			}

			// Per-level numeric columns (Rages, Sneak Attack, Martial Arts die, slots...).
			const tables = (c.classTableGroups ?? []).map((g) => compact({
				title: g.title,
				subclasses: g.subclasses,
				colLabels: (g.colLabels ?? []).map(renderPlain),
				rows: deepRender(g.rows),
				rowsSpellProgression: g.rowsSpellProgression,
			}));

			// 5etools re-points every legacy subclass at the 2024 class as well, so
			// filtering on classSource alone would hand the 2024 Fighter all ten of
			// its 2014 subclasses. Match the edition too.
			const subclasses = (raw.subclass ?? [])
				.filter(
					(s) =>
						s.className === c.name &&
						s.classSource === c.source &&
						editionOf(s) === editionOf(c),
				)
				.map((s) => {
					const sLevels = Array.from({ length: 20 }, (_, i) => ({ level: i + 1, features: [] }));
					for (const ref of s.subclassFeatures ?? []) {
						const sf = resolveFeatureRef(ref, subFeatureIndex);
						const refStr = typeof ref === "string" ? ref : ref.subclassFeature ?? "";
						const lvl = Number(String(refStr).split("|")[5]) || Number(sf?.level) || 1;
						if (!sf || lvl < 1 || lvl > 20) continue;
						const blocks = renderEntries(inlineRefs(sf.entries));
						sLevels[lvl - 1].features.push(compact({
							name: sf.name,
							level: lvl,
							creatureRefs: collectCreatureRefs(inlineRefs(sf.entries)),
							resource: normFeatureResource(sf, [
								...(c.classTableGroups ?? []),
								...(s.subclassTableGroups ?? []),
							]),
							expertise: normFeatureExpertise(sf),
							html: blocks.map(blockToHtml).join(""),
							blurb: blurbFrom(blocks, 140),
						}));
					}
					return compact({
						id: idOf(`${c.name}-${s.name}`, s.source),
						name: s.name,
						shortName: s.shortName,
						source: s.source,
						page: s.page,
						edition: editionOf(s),
						srd: isSrd(s),
						spellcastingAbility: s.spellcastingAbility,
						casterProgression: s.casterProgression,
						additionalSpells: deepRender(s.additionalSpells),
						// Domain / oath / circle spells, normalised and level-gated.
						spellGrants: normAdditionalSpells(s.additionalSpells),
						optionalfeatureProgression: deepRender(s.optionalfeatureProgression),
						subclassTableGroups: deepRender(s.subclassTableGroups),
						blurb: sLevels.flatMap((l) => l.features).find((f) => f.blurb)?.blurb ?? "",
						levels: sLevels.filter((l) => l.features.length),
					});
				});

			out.push(compact({
				id: idOf(c.name, c.source),
				name: c.name,
				source: c.source,
				page: c.page,
				edition: editionOf(c),
				srd: isSrd(c),
				srdSource: srdSourceOf(c),
				blurb: fluff.get(`${c.name}|${c.source}`) ?? "",
				hitDie: c.hd?.faces ?? 8,
				primaryAbility: (c.primaryAbility ?? []).flatMap((a) =>
					Object.keys(a).filter((k) => a[k] === true),
				),
				savingThrows: c.proficiency ?? [],
				skillChoices: skills.choices,
				skillsFixed: skills.fixed,
				// 2014 classes list individual weapons here as {@item ...} refs,
				// so these need rendering rather than passing through.
				armorTraining: uniq(
					(prof.armor ?? [])
						.map((a) => renderPlain(typeof a === "string" ? a : a.full ?? a.proficiency ?? ""))
						.filter(Boolean),
				),
				weaponProficiencies: uniq(
					(prof.weapons ?? [])
						.map((w) => renderPlain(typeof w === "string" ? w : w.proficiency ?? ""))
						.filter(Boolean),
				),
				toolProficiencies: normProficiencies(prof.tools ?? prof.toolProficiencies, { slugify: false }),
				startingEquipment: normStartingEquipment(c.startingEquipment?.defaultData),
				startingEquipmentText: (c.startingEquipment?.entries ?? []).map(renderPlain).join(" "),
				multiclassing: c.multiclassing ? deepRender({
					requirements: c.multiclassing.requirements,
					proficienciesGained: c.multiclassing.proficienciesGained,
				}) : null,
				spellGrants: normAdditionalSpells(c.additionalSpells),
				casterProgression: c.casterProgression,
				spellcastingAbility: c.spellcastingAbility,
				preparedSpells: c.preparedSpells,
				cantripProgression: c.cantripProgression,
				spellsKnownProgression: c.spellsKnownProgression,
				// Normalised per-level progressions, read from the class tables.
				spellcasting: extractSpellcasting(c),
				featProgression: c.featProgression,
				optionalfeatureProgression: c.optionalfeatureProgression,
				subclassTitle: c.subclassTitle ?? "Subclass",
				subclassLevel: levels.find((l) => l.gainsSubclassFeature)?.level ?? 3,
				tables,
				levels,
				subclasses,
			}));
		}
	}
	return out;
}

/**
 * Pulls the spellcasting progressions out of a class's level tables.
 *
 * The 2024 rules dropped "level + ability modifier" for prepared spells in
 * favour of a flat number printed in the class table, so reading that column is
 * the only way to get it right. Slots live in a separate table flagged with
 * `rowsSpellProgression`, and the Warlock keeps its Pact Magic counts as two
 * more columns of its own.
 *
 * Everything is normalised to 20-entry arrays indexed by class level - 1, so the
 * app never has to know which book laid its table out which way.
 */
function extractSpellcasting(cls) {
	const tables = cls.classTableGroups ?? [];

	/** Find a column by label across every table group and return its 20 values. */
	const column = (...labels) => {
		const wanted = labels.map((l) => l.toLowerCase());
		for (const group of tables) {
			const cols = (group.colLabels ?? []).map((c) => renderPlain(c).toLowerCase());
			const i = cols.findIndex((c) => wanted.includes(c));
			if (i === -1 || !Array.isArray(group.rows)) continue;
			return group.rows.slice(0, 20).map((row) => {
				const cell = Array.isArray(row) ? row[i] : null;
				const n = Number(typeof cell === "object" && cell !== null ? cell.value ?? cell.roll?.exact : cell);
				return Number.isFinite(n) ? n : 0;
			});
		}
		return null;
	};

	// Spell slots: the table flagged as a spell progression.
	let slots = null;
	for (const group of tables) {
		if (!group.rowsSpellProgression) continue;
		slots = group.rowsSpellProgression.slice(0, 20).map((row) =>
			(Array.isArray(row) ? row : []).map((n) => Number(n) || 0),
		);
		break;
	}

	const cantrips = cls.cantripProgression?.slice(0, 20) ?? column("cantrips", "cantrips known");
	const prepared = column("prepared spells");
	const known = cls.spellsKnownProgression?.slice(0, 20) ?? column("spells known");

	// Pact Magic runs on its own short-rest track.
	const pactSlots = cls.casterProgression === "pact" ? column("spell slots") : null;
	const pactLevel = cls.casterProgression === "pact" ? column("slot level") : null;

	const ability = cls.spellcastingAbility ?? null;
	if (!ability && !slots && !cantrips && !prepared && !known) return null;

	return compact({
		ability,
		progression: cls.casterProgression,
		cantripsKnown: cantrips,
		preparedCount: prepared,
		spellsKnown: known,
		slots,
		pact: pactSlots ? { slots: pactSlots, level: pactLevel } : null,
	});
}

/**
 * Normalises an adventuring pack's contents.
 *
 * 5etools writes these as a mixed array: a bare "bedroll|phb" string, an
 * object with a quantity, or a {special} entry for something that has no item
 * of its own. Flattening them here means the app can offer to unpack a pack
 * without knowing any of that.
 */
function normPackContents(contents) {
	if (!Array.isArray(contents) || !contents.length) return undefined;
	const out = [];
	for (const raw of contents) {
		const entry = typeof raw === "string" ? { item: raw } : (raw ?? {});
		const quantity = Number(entry.quantity ?? 1) || 1;
		if (entry.special) {
			// No item record exists, so it is carried as a plain named line.
			out.push(compact({ name: titleCase(String(entry.special)), quantity, special: true }));
			continue;
		}
		if (!entry.item) continue;
		const [nm] = String(entry.item).split("|");
		out.push(compact({ name: titleCase(nm), ref: slug(nm), quantity }));
	}
	return out.length ? out : undefined;
}

function extractItems() {
	const base = readJson("items-base.json");
	const magic = readJson("items.json");

	const TYPE_NAMES = {};
	for (const t of base?.itemType ?? []) {
		TYPE_NAMES[`${t.abbreviation}|${t.source}`] = t.name;
		TYPE_NAMES[t.abbreviation] = t.name;
	}
	const PROP_NAMES = {};
	for (const p of base?.itemProperty ?? []) {
		const nm = p.name ?? p.entries?.[0]?.name;
		if (nm) {
			PROP_NAMES[`${p.abbreviation}|${p.source}`] = nm;
			PROP_NAMES[p.abbreviation] = nm;
		}
	}

	// Shared by both the base-item normaliser and the variant generator.
	const DMG_TYPES = {
		A: "acid", B: "bludgeoning", C: "cold", F: "fire", O: "force",
		L: "lightning", N: "necrotic", P: "piercing", I: "poison",
		Y: "psychic", R: "radiant", S: "slashing", T: "thunder",
	};

	const norm = (i, isMagic) => {
		const typeKey = i.type ? String(i.type).split("|")[0] : null;
		const blocks = renderEntries(i.entries);
		return compact({
			id: idOf(i.name, i.source),
			name: i.name,
			source: i.source,
			page: i.page,
			edition: editionOf(i),
			srd: isSrd(i),
			// items.json mixes magic items with ordinary adventuring gear (Mirror,
			// Oil, Rope), so rarity decides -- not which file the entry came from.
			magic: Boolean(i.rarity && i.rarity !== "none") || undefined,
			rarity: i.rarity && i.rarity !== "none" ? i.rarity : undefined,
			type: typeKey,
			typeName: TYPE_NAMES[i.type] ?? TYPE_NAMES[typeKey],
			// 5etools stores value in copper pieces.
			costGp: typeof i.value === "number" ? i.value / 100 : undefined,
			weight: i.weight,
			// Weapon fields
			weapon: i.weapon || undefined,
			weaponCategory: i.weaponCategory,
			damage: i.dmg1,
			damageType: i.dmgType ? DMG_TYPES[i.dmgType] ?? i.dmgType : undefined,
			versatileDamage: i.dmg2,
			properties: (i.property ?? []).map((p) => PROP_NAMES[p] ?? String(p).split("|")[0]),
			mastery: (i.mastery ?? []).map((m) => String(m).split("|")[0]),
			range: deepRender(i.range),
			reload: i.reload,
			// Armor fields
			armor: i.armor || undefined,
			ac: i.ac,
			strengthRequirement: i.strength ? Number(i.strength) : undefined,
			stealthDisadvantage: i.stealth || undefined,
			// Attunement / misc
			reqAttune: deepRender(i.reqAttune),
			bonusWeapon: i.bonusWeapon,
			bonusAc: i.bonusAc,
			bonusSpellAttack: i.bonusSpellAttack,
			charges: deepRender(i.charges),
			containerCapacity: deepRender(i.containerCapacity),
			// What is inside an adventuring pack. Entries are either an item
			// reference or a {special} string for something with no item entry of
			// its own ("alms box", "vestments").
			packContents: normPackContents(i.packContents),
			blurb: blurbFrom(blocks, 160),
			html: blocks.map(blockToHtml).join(""),
		});
	};

	/**
	 * "Flame Tongue" and "+1 Weapon" are not items in 5etools; they are variant
	 * templates with a `requires` predicate, combined with every matching base
	 * item to produce "Flame Tongue Longsword", "+1 Greataxe" and so on. Without
	 * this, searching for the most common magic items in the game finds nothing.
	 *
	 * Each variant's rules text is stored ONCE in magic-variants.json, and the
	 * ~6,800 generated combinations carry only a pointer to it. Inlining the text
	 * into every combination would multiply the file size for no benefit.
	 */
	const variants = (magic?.magicvariant ?? readJson("magicvariants.json")?.magicvariant ?? []);

	const matchesRequirement = (item, req) =>
		Object.entries(req).every(([k, val]) => {
			if (k === "type") return String(item.type ?? "").split("|")[0] === String(val).split("|")[0];
			return item[k] === val;
		});

	const normVariants = variants.map((v) => {
		const inh = v.inherits ?? {};
		// {=bonusWeapon} and friends resolve against the variant's own inherits.
		const withFields = JSON.parse(
			substituteFields(JSON.stringify(inh.entries ?? []), inh),
		);
		const blocks = renderEntries(withFields);
		return compact({
			id: idOf(v.name, inh.source ?? v.source ?? "DMG"),
			name: v.name,
			source: inh.source ?? v.source,
			edition: editionOf({ edition: v.edition, source: inh.source ?? v.source }),
			srd: isSrd(inh),
			rarity: inh.rarity,
			reqAttune: deepRender(inh.reqAttune),
			namePrefix: inh.namePrefix,
			nameSuffix: inh.nameSuffix,
			bonusWeapon: inh.bonusWeapon,
			bonusAc: inh.bonusAc,
			bonusSpellAttack: inh.bonusSpellAttack,
			blurb: blurbFrom(blocks, 160),
			html: blocks.map(blockToHtml).join(""),
		});
	});

	const variantById = new Map(normVariants.map((v) => [v.id, v]));

	/**
	 * Apply every variant to each base item it can attach to.
	 *
	 * A base item printed in both PHB and XPHB (Greatsword, say) would otherwise
	 * produce two identical "Flame Tongue Greatsword" entries, so generated names
	 * are deduped with the 2024 printing winning.
	 */
	const generated = [];
	const generatedNames = new Set();
	const baseItemsPreferred = [...(base?.baseitem ?? [])].sort(
		(a, b) => (editionOf(a) === "2024" ? 0 : 1) - (editionOf(b) === "2024" ? 0 : 1),
	);
	for (const v of variants) {
		const inh = v.inherits ?? {};
		const variantId = idOf(v.name, inh.source ?? v.source ?? "DMG");
		const meta = variantById.get(variantId);
		const requires = v.requires ?? [];
		const excludes = v.excludes ?? null;

		for (const item of baseItemsPreferred) {
			if (!requires.some((r) => matchesRequirement(item, r))) continue;
			if (excludes && matchesRequirement(item, excludes)) continue;

			const name = `${inh.namePrefix ?? ""}${item.name}${inh.nameSuffix ?? ""}`.trim();
			const dedupeKey = `${name}|${variantId}`;
			if (generatedNames.has(dedupeKey)) continue;
			generatedNames.add(dedupeKey);

			generated.push(compact({
				id: idOf(name, inh.source ?? v.source ?? "DMG"),
				name,
				source: meta?.source,
				edition: meta?.edition,
				srd: meta?.srd,
				magic: true,
				rarity: meta?.rarity,
				reqAttune: meta?.reqAttune,
				// Text lives on the variant; the UI resolves it via variantOf.
				variantOf: variantId,
				baseItem: idOf(item.name, item.source),
				// Variant text can reference {=baseName}; resolved when rendered,
				// since one shared description serves every base item.
				baseName: item.name,
				type: item.type ? String(item.type).split("|")[0] : undefined,
				weapon: item.weapon || undefined,
				armor: item.armor || undefined,
				weight: item.weight,
				damage: item.dmg1,
				damageType: item.dmgType ? DMG_TYPES[item.dmgType] ?? item.dmgType : undefined,
				ac: item.ac,
				bonusWeapon: meta?.bonusWeapon,
				bonusAc: meta?.bonusAc,
				blurb: meta?.blurb,
			}));
		}
	}

	// items.json holds ordinary adventuring gear (Bedroll, Rope, Priest's Pack)
	// alongside the magic items, and every class and background kit refers to
	// that gear. Splitting the output by file would leave those references
	// dangling, so the split is by whether an item is actually magical.
	const fromItemsFile = (magic?.item ?? []).map((i) => norm(i, true));
	const mundaneFromItemsFile = fromItemsFile.filter((i) => !i.magic);
	const trulyMagical = fromItemsFile.filter((i) => i.magic);

	// Categories like "Holy Symbol" and "Arcane Focus" are item GROUPS in
	// 5etools, not items, yet class and background kits refer to them exactly as
	// they refer to items. They are added to the equipment list as entries that
	// name their members, so a reference to one resolves and the UI can offer the
	// real choice instead of leaving a dead line on the sheet.
	const groupsAsItems = (magic?.itemGroup ?? []).map((g) => {
		const blocks = renderEntries(g.entries);
		const typeKey = g.type ? String(g.type).split("|")[0] : undefined;
		return compact({
			id: idOf(g.name, g.source),
			name: g.name,
			source: g.source,
			page: g.page,
			edition: editionOf(g),
			srd: isSrd(g),
			type: typeKey,
			typeName: TYPE_NAMES[g.type] ?? TYPE_NAMES[typeKey],
			costGp: typeof g.value === "number" ? g.value / 100 : undefined,
			weight: g.weight,
			// The flag the UI keys on to ask "which one?".
			isGroup: true,
			members: (g.items ?? []).map((m) => {
				const [nm] = String(m).split("|");
				return { name: titleCase(nm), ref: slug(nm) };
			}),
			blurb: blurbFrom(blocks, 160),
			html: blocks.map(blockToHtml).join(""),
		});
	});

	return {
		gear: [
			...(base?.baseitem ?? []).map((i) => norm(i, false)),
			...mundaneFromItemsFile,
			...groupsAsItems,
		],
		magic: [...trulyMagical, ...generated],
		variants: normVariants,
		// Tool categories ("Gaming Set", "Artisan's Tools") and their members, so
		// a background granting "any Gaming Set" can offer the four real options.
		groups: (magic?.itemGroup ?? []).map((g) => compact({
			id: idOf(g.name, g.source),
			name: g.name,
			source: g.source,
			edition: editionOf(g),
			srd: isSrd(g),
			type: g.type ? String(g.type).split("|")[0] : undefined,
			members: (g.items ?? []).map((m) => {
				const [nm] = String(m).split("|");
				return { name: titleCase(nm), ref: slug(nm) };
			}),
		})),
		// Weapon properties (Finesse, Thrown, Light) exist in both editions with
		// different wording, so tag the edition to pick the right one at runtime.
		properties: (base?.itemProperty ?? []).map((p) => compact({
			abbreviation: p.abbreviation,
			source: p.source,
			edition: editionOf(p),
			name: p.name ?? p.entries?.[0]?.name,
			html: renderEntries(p.entries).map(blockToHtml).join(""),
		})).filter((p) => p.name),
		masteries: (base?.itemMastery ?? []).map((m) => compact({
			id: idOf(m.name, m.source),
			name: m.name,
			source: m.source,
			edition: editionOf(m),
			srd: isSrd(m),
			html: renderEntries(m.entries).map(blockToHtml).join(""),
		})),
	};
}

function extractSpells() {
	const dir = path.join(SRC, "spells");
	if (!fs.existsSync(dir)) return [];

	// sources.json maps SOURCE -> spell name -> { class: [{name, source}] }
	const classMap = readJson("spells", "sources.json") ?? {};

	const SCHOOLS = {
		A: "Abjuration", C: "Conjuration", D: "Divination", E: "Enchantment",
		V: "Evocation", I: "Illusion", N: "Necromancy", T: "Transmutation",
	};

	const files = fs
		.readdirSync(dir)
		.filter((f) => f.startsWith("spells-") && f.endsWith(".json"));

	const out = [];
	for (const file of files) {
		const raw = readJson("spells", file);
		for (const s of raw?.spell ?? []) {
			const lists = classMap[s.source]?.[s.name]?.class ?? [];
			const blocks = renderEntries(s.entries);
			out.push(compact({
				id: idOf(s.name, s.source),
				name: s.name,
				source: s.source,
				page: s.page,
				edition: editionOf(s),
				srd: isSrd(s),
				level: s.level,
				school: SCHOOLS[s.school] ?? s.school,
				time: deepRender(s.time),
				range: deepRender(s.range),
				components: deepRender(s.components),
				duration: deepRender(s.duration),
				concentration: s.duration?.some?.((d) => d.concentration) || undefined,
				ritual: s.meta?.ritual || undefined,
				classes: uniq(lists.map((c) => slug(c.name))),
				classesDetailed: lists.map((c) => ({ name: c.name, source: c.source })),
				damageInflict: s.damageInflict,
				savingThrow: s.savingThrow,
				// Stat blocks this spell summons, e.g. Summon Elemental -> Elemental Spirit.
				creatureRefs: collectCreatureRefs([s.entries, s.entriesHigherLevel]),
				blurb: blurbFrom(blocks, 160),
				html: blocks.map(blockToHtml).join(""),
				higherLevel: s.entriesHigherLevel
					? renderEntries(s.entriesHigherLevel).map(blockToHtml).join("")
					: undefined,
			}));
		}
	}
	return out;
}

/**
 * Creatures a *player* needs at the table, not a DM's bestiary.
 *
 * Two groups are pulled:
 *   - companions and summons (bestiary-xphb.json / the 2014 equivalents):
 *     Beast of the Land/Sea/Sky for the Beast Master, the Summon X Spirit
 *     stat blocks, Otherworldly Steed, and so on.
 *   - Beasts at CR 1 or lower, which is the pool a Druid picks Wild Shape
 *     forms from.
 *
 * Everything else in the 18 MB bestiary is left behind.
 */
function extractCreatures(wantedNames = new Set()) {
	const dir = path.join(SRC, "bestiary");
	if (!fs.existsSync(dir)) return [];

	// Files holding player-facing stat blocks rather than monsters.
	const COMPANION_FILES = new Set(["bestiary-xphb.json", "bestiary-phb.json", "bestiary-tce.json"]);
	// Where the Wild Shape beast pool lives.
	const BEAST_FILES = new Set(["bestiary-xmm.json", "bestiary-mm.json"]);
	const MAX_BEAST_CR = 1;

	const crToNumber = (cr) => {
		const raw = typeof cr === "object" && cr !== null ? cr.cr : cr;
		if (raw == null) return null;
		const s = String(raw);
		if (s.includes("/")) {
			const [n, d] = s.split("/").map(Number);
			return d ? n / d : null;
		}
		const n = Number(s);
		return Number.isFinite(n) ? n : null;
	};

	const typeOf = (m) => {
		const t = typeof m.type === "object" && m.type !== null ? m.type.type : m.type;
		return String(t ?? "").toLowerCase();
	};

	const norm = (m, role) => {
		const cr = crToNumber(m.cr);
		const acEntry = Array.isArray(m.ac) ? m.ac[0] : m.ac;
		return compact({
			id: idOf(m.name, m.source),
			name: m.name,
			source: m.source,
			page: m.page,
			edition: editionOf(m),
			srd: isSrd(m),
			role, // "companion" | "beast"
			size: m.size,
			creatureType: typeOf(m),
			ac: typeof acEntry === "object" && acEntry !== null ? acEntry.ac : acEntry,
			acNote: typeof acEntry === "object" && acEntry !== null
				? (acEntry.from ? deepRender(acEntry.from).join(", ") : acEntry.special)
				: undefined,
			hp: m.hp?.average,
			hpFormula: m.hp?.formula ?? m.hp?.special,
			speed: deepRender(m.speed),
			abilities: {
				str: m.str, dex: m.dex, con: m.con, int: m.int, wis: m.wis, cha: m.cha,
			},
			skills: deepRender(m.skill),
			senses: (m.senses ?? []).map(renderPlain),
			passivePerception: m.passive,
			resist: deepRender(m.resist),
			immune: deepRender(m.immune),
			conditionImmune: deepRender(m.conditionImmune),
			languages: m.languages,
			cr: typeof m.cr === "object" && m.cr !== null ? m.cr.cr : m.cr,
			crValue: cr,
			traits: (m.trait ?? []).map((t) => ({
				name: renderPlain(t.name),
				html: renderEntries(t.entries).map(blockToHtml).join(""),
			})),
			actions: (m.action ?? []).map((a) => ({
				name: renderPlain(a.name),
				html: renderEntries(a.entries).map(blockToHtml).join(""),
			})),
			bonusActions: (m.bonus ?? []).map((a) => ({
				name: renderPlain(a.name),
				html: renderEntries(a.entries).map(blockToHtml).join(""),
			})),
			reactions: (m.reaction ?? []).map((a) => ({
				name: renderPlain(a.name),
				html: renderEntries(a.entries).map(blockToHtml).join(""),
			})),
			// Wild Shape at low levels excludes forms with a Fly Speed.
			hasFlySpeed: Boolean(m.speed?.fly),
			hasSwimSpeed: Boolean(m.speed?.swim),
		});
	};

	const out = [];
	const seen = new Set();
	// Names are matched slug-to-slug so a reference written "fire elemental"
	// still resolves to the "Fire Elemental" stat block.
	const wanted = new Set([...wantedNames].map(slug));
	const takenNames = new Set();

	// Prefer 2024 books, so a summon resolves to its current stat block when
	// both editions print one.
	const files = fs.readdirSync(dir)
		.filter((f) => f.startsWith("bestiary-") && f.endsWith(".json"))
		.sort((a, b) => {
			const rank = (f) => (f.includes("xphb") ? 0 : f.includes("xmm") ? 1 : f.includes("phb") ? 2 : f.includes("mm") ? 3 : 4);
			return rank(a) - rank(b) || a.localeCompare(b);
		});

	for (const file of files) {
		const isCompanion = COMPANION_FILES.has(file);
		const isBeastPool = BEAST_FILES.has(file);

		const raw = readJson("bestiary", file);
		for (const m of raw?.monster ?? []) {
			if (!m?.name) continue;
			const nameSlug = slug(m.name);

			let role = null;
			if (isCompanion) role = "companion";
			else if (isBeastPool && typeOf(m) === "beast") {
				const cr = crToNumber(m.cr);
				if (cr != null && cr <= MAX_BEAST_CR) role = "beast";
			}
			// Anything a spell or class feature points at, wherever it lives.
			// Only the first (highest-priority) printing of a name is kept.
			if (!role && wanted.has(nameSlug) && !takenNames.has(nameSlug)) role = "summon";
			if (!role) continue;

			const id = idOf(m.name, m.source);
			if (seen.has(id)) continue;
			seen.add(id);
			takenNames.add(nameSlug);
			out.push(norm(m, role));
		}
	}

	return out.sort((a, b) => (a.crValue ?? 0) - (b.crValue ?? 0) || a.name.localeCompare(b.name));
}

function extractReference() {
	const skills = readJson("skills.json");
	const senses = readJson("senses.json");
	const variantRules = readJson("variantrules.json");
	const conditions = readJson("conditionsdiseases.json");
	const languages = readJson("languages.json");
	const actions = readJson("actions.json");

	const simple = (arr, extra = () => ({})) =>
		(arr ?? []).map((x) => compact({
			id: idOf(x.name, x.source),
			name: x.name,
			source: x.source,
			edition: editionOf(x),
			srd: isSrd(x),
			html: renderEntries(x.entries).map(blockToHtml).join(""),
			...extra(x),
		}));

	return {
		skills: simple(skills?.skill, (x) => ({ ability: x.ability })),
		senses: simple(senses?.sense),
		conditions: simple(conditions?.condition),
		diseases: simple(conditions?.disease),
		languages: simple(languages?.language, (x) => ({
			type: x.type, script: x.script, typicalSpeakers: deepRender(x.typicalSpeakers),
		})),
		actions: simple(actions?.action, (x) => ({ time: deepRender(x.time) })),
		// The rules glossary: Advantage, Bonus Action, Long Rest, Cover and so on.
		// These are what most of the highlighted terms in rules text point at.
		variantRules: simple(variantRules?.variantrule, (x) => ({ ruleType: x.ruleType })),
	};
}

/* ------------------------------------------------------------------ *
 * Build
 * ------------------------------------------------------------------ */

console.log(`\nExtracting 5etools data`);
console.log(`  source : ${SRC}`);
console.log(`  output : ${OUT}`);
console.log(`  tier   : ${TIER}${TIER === "srd" ? "  (CC BY 4.0 SRD material only)" : "  (everything, local use)"}\n`);

const species = extractSpecies();
const classes = extractClasses();
const backgrounds = extractBackgrounds();
const feats = extractFeats();
const optionalFeatures = extractOptionalFeatures();
const items = extractItems();
const spells = extractSpells();
// Creatures are pulled on demand: whatever the extracted spells and class
// features actually reference, plus the Wild Shape beast pool.
const referencedCreatures = new Set([
	...spells.flatMap((s) => (s.creatureRefs ?? []).map((r) => r.name)),
	...classes.flatMap((c) => [
		...(c.levels ?? []).flatMap((l) => (l.features ?? []).flatMap((f) => (f.creatureRefs ?? []).map((r) => r.name))),
		...(c.subclasses ?? []).flatMap((sc) =>
			(sc.levels ?? []).flatMap((l) => (l.features ?? []).flatMap((f) => (f.creatureRefs ?? []).map((r) => r.name)))),
	]),
]);
const creatures = extractCreatures(referencedCreatures);
const reference = extractReference();

/** In the SRD tier, drop anything not flagged as SRD material. */
const gate = (arr) => (TIER === "srd" ? arr.filter((x) => x.srd) : arr);

const datasets = {
	"species.json": gate(species),
	"classes.json": gate(classes),
	"backgrounds.json": gate(backgrounds),
	"feats.json": gate(feats),
	"optional-features.json": gate(optionalFeatures),
	"equipment.json": gate(items.gear),
	"magic-items.json": gate(items.magic),
	"magic-variants.json": gate(items.variants),
	"spells.json": gate(spells),
	"creatures.json": gate(creatures),
	"reference.json": {
		...reference,
		itemProperties: items.properties,
		itemMasteries: gate(items.masteries),
		itemGroups: items.groups,
	},
};

fs.mkdirSync(OUT, { recursive: true });

const counts = {};
for (const [file, data] of Object.entries(datasets)) {
	const target = path.join(OUT, file);
	fs.writeFileSync(target, JSON.stringify(data));
	const n = Array.isArray(data) ? data.length : Object.values(data).flat().length;
	counts[file] = n;
	const kb = (fs.statSync(target).size / 1024).toFixed(0);
	console.log(`  ${file.padEnd(24)} ${String(n).padStart(6)} entries   ${kb.padStart(6)} KB`);
}

// A manifest the app reads at boot, so the UI knows what it is working with.
const byEdition = (arr) => ({
	"2024": arr.filter((x) => x.edition === "2024").length,
	"2014": arr.filter((x) => x.edition === "2014").length,
});

const meta = {
	generatedFrom: "5etools",
	tier: TIER,
	counts,
	editions: {
		species: byEdition(gate(species)),
		classes: byEdition(gate(classes)),
		backgrounds: byEdition(gate(backgrounds)),
		feats: byEdition(gate(feats)),
		spells: byEdition(gate(spells)),
	},
	sources: uniq([...species, ...classes, ...backgrounds, ...feats].map((x) => x.source)).sort(),
	attribution:
		"Game rules content is the property of Wizards of the Coast. SRD material is used " +
		"under CC BY 4.0. This build is generated locally from a 5etools data directory.",
};
fs.writeFileSync(path.join(OUT, "meta.json"), JSON.stringify(meta, null, 2));

console.log(`\n  meta.json written.`);
console.log(`  2024 material: ${meta.editions.classes["2024"]} classes, ${meta.editions.species["2024"]} species, ${meta.editions.backgrounds["2024"]} backgrounds`);
console.log(`  2014 material: ${meta.editions.classes["2014"]} classes, ${meta.editions.species["2014"]} species, ${meta.editions.backgrounds["2014"]} backgrounds`);
console.log(`\nDone.\n`);
