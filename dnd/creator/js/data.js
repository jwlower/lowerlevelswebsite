/**
 * data.js - loads and indexes the rules database.
 *
 * Everything is static JSON fetched from ./data/. Big files (spells, magic
 * items) are loaded lazily so the wizard starts fast on a phone over the LAN.
 */

const DATA_DIR = new URL("../data/", import.meta.url);

/** Files pulled at boot. Everything else is fetched on first use. */
const EAGER = ["meta", "rules", "species", "classes", "backgrounds", "feats", "equipment"];
const LAZY = ["spells", "magic-items", "magic-variants", "optional-features", "reference", "creatures"];

const FILENAMES = {
	meta: "meta.json",
	rules: "rules.json",
	species: "species.json",
	classes: "classes.json",
	backgrounds: "backgrounds.json",
	feats: "feats.json",
	equipment: "equipment.json",
	spells: "spells.json",
	"magic-items": "magic-items.json",
	"magic-variants": "magic-variants.json",
	"optional-features": "optional-features.json",
	reference: "reference.json",
	creatures: "creatures.json",
};

const cache = new Map();
const inflight = new Map();

async function fetchOne(key) {
	if (cache.has(key)) return cache.get(key);
	if (inflight.has(key)) return inflight.get(key);

	const p = (async () => {
		const url = new URL(FILENAMES[key], DATA_DIR);
		const res = await fetch(url);
		if (!res.ok) throw new Error(`Could not load ${FILENAMES[key]} (HTTP ${res.status})`);
		const json = await res.json();
		cache.set(key, json);
		inflight.delete(key);
		return json;
	})();

	inflight.set(key, p);
	return p;
}

/** Loaded once at boot; the wizard reads from here synchronously afterwards. */
export const db = {
	meta: null,
	rules: null,
	species: [],
	classes: [],
	backgrounds: [],
	feats: [],
	equipment: [],
	// Filled in by ensure()
	spells: null,
	magicItems: null,
	magicVariants: null,
	optionalFeatures: null,
	reference: null,
	creatures: null,
	// Which homebrew files loaded, for the UI to report
	homebrewSources: [],
};

export async function loadCore() {
	const results = await Promise.all(EAGER.map(fetchOne));
	[db.meta, db.rules, db.species, db.classes, db.backgrounds, db.feats, db.equipment] = results;
	await loadHomebrew();
	return db;
}

/** Pull one of the lazy datasets on demand. */
export async function ensure(key) {
	if (!LAZY.includes(key)) throw new Error(`Unknown lazy dataset: ${key}`);
	const data = await fetchOne(key);
	if (key === "spells") db.spells = data;
	if (key === "magic-items") db.magicItems = data;
	if (key === "magic-variants") db.magicVariants = data;
	if (key === "optional-features") db.optionalFeatures = data;
	if (key === "reference") db.reference = data;
	if (key === "creatures") db.creatures = data;
	// Homebrew for a lazy set is merged the first time that set is loaded.
	mergeHomebrewInto(key);
	return data;
}

/* ------------------------------------------------------------------ *
 * Homebrew
 *
 * Custom content lives in two places, both optional:
 *
 *   1. dnd/creator/homebrew/*.json, listed in homebrew/index.json. These are
 *      files on disk, so they are shared by everyone using the LAN server.
 *   2. localStorage, for content imported through the UI on one device.
 *
 * Both use the same shape as the generated database: a top-level object whose
 * keys are dataset names. Anything you add is tagged `homebrew: true` so the
 * UI can badge it and the extractor never overwrites it.
 *
 *   { "name": "My Homebrew",
 *     "spells":     [ { "id": "...", "name": "...", ... } ],
 *     "classes":    [ ... ],
 *     "subclasses": [ { "classId": "wizard--xphb", ...subclass } ],
 *     "species": [...], "backgrounds": [...], "feats": [...],
 *     "magicItems": [...], "equipment": [...] }
 * ------------------------------------------------------------------ */

const HOMEBREW_KEY = "lowerlevels.dnd.homebrew.v1";
const HOMEBREW_DIR = new URL("../homebrew/", import.meta.url);

/** Collections merged straight into an existing dataset, by db key. */
const HOMEBREW_TARGETS = {
	species: "species",
	classes: "classes",
	backgrounds: "backgrounds",
	feats: "feats",
	equipment: "equipment",
	spells: "spells",
	magicItems: "magicItems",
	optionalFeatures: "optionalFeatures",
	creatures: "creatures",
};

/** Everything loaded from disk plus localStorage, before merging. */
let homebrewBundles = [];

/** Homebrew stored on this device only. */
export function localHomebrew() {
	try {
		return JSON.parse(localStorage.getItem(HOMEBREW_KEY) ?? "[]");
	} catch {
		return [];
	}
}

export function saveLocalHomebrew(bundles) {
	localStorage.setItem(HOMEBREW_KEY, JSON.stringify(bundles));
}

/**
 * Adds a homebrew bundle on this device and merges it immediately.
 * Returns a summary of what it contained.
 */
export function addLocalHomebrew(bundle) {
	const bundles = localHomebrew();
	bundles.push(bundle);
	saveLocalHomebrew(bundles);
	homebrewBundles.push({ ...bundle, _origin: "device" });
	db.homebrewSources = homebrewBundles.map((b) => b.name ?? b._origin);
	// Datasets not loaded yet (magic items, spells) pick this up in ensure().
	return mergeAllHomebrew();
}

export function removeLocalHomebrew(name) {
	saveLocalHomebrew(localHomebrew().filter((b) => b.name !== name));
}

async function loadHomebrew() {
	homebrewBundles = [];

	// Files on disk, if a homebrew/index.json exists. Absent is not an error:
	// most installs will not have any homebrew at all.
	try {
		const res = await fetch(new URL("index.json", HOMEBREW_DIR));
		if (res.ok) {
			const index = await res.json();
			const files = Array.isArray(index) ? index : (index.files ?? []);
			for (const file of files) {
				try {
					const r = await fetch(new URL(file, HOMEBREW_DIR));
					if (!r.ok) continue;
					const bundle = await r.json();
					homebrewBundles.push({ ...bundle, _origin: file });
				} catch (err) {
					console.warn(`Homebrew file ${file} could not be loaded:`, err);
				}
			}
		}
	} catch {
		// No homebrew directory. Normal.
	}

	for (const bundle of localHomebrew()) {
		homebrewBundles.push({ ...bundle, _origin: "device" });
	}

	db.homebrewSources = homebrewBundles.map((b) => b.name ?? b._origin);
	return mergeAllHomebrew();
}

/** Merge every bundle's entries into whichever datasets are loaded. */
function mergeAllHomebrew() {
	const summary = {};
	for (const key of Object.keys(HOMEBREW_TARGETS)) {
		const n = mergeHomebrewInto(key);
		if (n) summary[key] = n;
	}
	return summary;
}

/**
 * Merge homebrew entries for one dataset. Safe to call repeatedly: entries are
 * keyed by id, so a second call replaces rather than duplicates. Datasets that
 * have not been lazily loaded yet are skipped, and picked up by ensure().
 */
function mergeHomebrewInto(datasetKey) {
	// ensure() passes file-style keys; normalise to the db property name.
	const normalised = { "magic-items": "magicItems", "optional-features": "optionalFeatures" }[datasetKey]
		?? datasetKey;
	const target = db[normalised];
	if (!Array.isArray(target)) return 0;

	let added = 0;
	for (const bundle of homebrewBundles) {
		const entries = bundle[normalised];
		if (!Array.isArray(entries)) continue;

		for (const raw of entries) {
			if (!raw?.name) continue;
			const entry = {
				edition: "2024",
				source: bundle.name ?? "Homebrew",
				srd: false,
				...raw,
				homebrew: true,
				id: raw.id ?? `${slugify(raw.name)}--homebrew`,
			};
			const i = target.findIndex((x) => x.id === entry.id);
			if (i === -1) target.push(entry);
			else target[i] = entry;
			added++;
		}
	}

	// Subclasses attach to an existing class rather than forming their own list.
	if (normalised === "classes") added += mergeHomebrewSubclasses();

	return added;
}

/** Homebrew subclasses declare the class they belong to via `classId`. */
function mergeHomebrewSubclasses() {
	let added = 0;
	for (const bundle of homebrewBundles) {
		for (const raw of bundle.subclasses ?? []) {
			if (!raw?.name || !raw.classId) continue;
			const parent = db.classes.find((c) => c.id === raw.classId);
			if (!parent) {
				console.warn(`Homebrew subclass "${raw.name}" targets unknown class "${raw.classId}"`);
				continue;
			}
			parent.subclasses = parent.subclasses ?? [];
			const entry = {
				source: bundle.name ?? "Homebrew",
				edition: parent.edition,
				srd: false,
				...raw,
				homebrew: true,
				id: raw.id ?? `${slugify(raw.name)}--homebrew`,
			};
			const i = parent.subclasses.findIndex((s) => s.id === entry.id);
			if (i === -1) parent.subclasses.push(entry);
			else parent.subclasses[i] = entry;
			added++;
		}
	}
	return added;
}

const slugify = (s) =>
	String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/* ------------------------------------------------------------------ *
 * Lookup helpers
 * ------------------------------------------------------------------ */

const byId = (list, id) => list.find((x) => x.id === id) ?? null;

export const getSpecies = (id) => byId(db.species, id);
export const getClass = (id) => byId(db.classes, id);
export const getBackground = (id) => byId(db.backgrounds, id);
export const getFeat = (id) => byId(db.feats, id);
export const getItem = (id) =>
	byId(db.equipment, id) ?? (db.magicItems ? byId(db.magicItems, id) : null);

/**
 * Generated magic items ("Flame Tongue Longsword") carry a pointer to their
 * variant rather than a copy of its rules text, since one variant can apply to
 * a hundred base weapons. Resolve the text at render time.
 */
export function itemDescription(item) {
	if (!item) return "";
	if (item.html) return item.html;
	if (item.variantOf && db.magicVariants) {
		const html = db.magicVariants.find((v) => v.id === item.variantOf)?.html ?? "";
		return substituteItemFields(html, item);
	}
	return "";
}

/**
 * Variant text can refer to the item it is attached to: the shared "of Slaying"
 * description reads "{=baseName/a} {=baseName/l} of slaying is a magic weapon",
 * and elemental weapons reference "{=dmgType}". These differ per generated item
 * while the description itself is shared, so they resolve at render time.
 *
 * The modifier is a sequence of letters applied in order:
 *   a article   l lowercase   u uppercase   t title case   s plural
 *
 * The closing brace is optional: the extractor strips stray braces while
 * cleaning up 5etools markup, so stored text can read "{=baseName/l".
 */
function substituteItemFields(html, item) {
	if (!html.includes("{=")) return html;

	const values = {
		baseName: item.baseName,
		dmgType: item.damageType,
	};

	return html.replace(/\{=(\w+)(?:\/(\w+))?\}?/g, (whole, key, mods) => {
		const raw = values[key];
		if (raw == null) return whole;

		let value = String(raw);
		let article = "";
		for (const mod of mods ?? "") {
			switch (mod) {
				case "l": value = value.toLowerCase(); break;
				case "u": value = value.toUpperCase(); break;
				case "t": value = value.replace(/\w/g, (c) => c.toUpperCase()); break;
				case "s": value = `${value}s`; break;
				case "a": article = /^[aeiou]/i.test(value) ? "an " : "a "; break;
				default: break;
			}
		}
		return article + value;
	});
}

/** Equipment lookup by the slugged name used in startingEquipment refs. */
export function getItemByRef(ref, edition) {
	if (!ref) return null;
	const matches = db.equipment.filter((i) => i.id.startsWith(`${ref}--`));
	if (!matches.length) return null;
	return matches.find((i) => i.edition === edition) ?? matches[0];
}

export const getSubclass = (classId, subclassId) =>
	getClass(classId)?.subclasses?.find((s) => s.id === subclassId) ?? null;

/**
 * Books get reprinted, so the same species appears in several sources: the 2024
 * Elf exists in both XPHB and LFL, and the 2014 Goblin in six books. The
 * reprints are often thinner than the original -- the LFL Elf carries no lineage
 * table at all -- so showing them side by side in a picker means the player can
 * pick a version that silently lacks its choices.
 *
 * Entries are therefore collapsed to one per name, preferring the core rulebook
 * and then the most complete recent reprint.
 */
const SOURCE_PRIORITY = ["XPHB", "PHB", "MPMM", "TCE", "XGE", "SCAG", "VGM", "MTF"];

const sourceRank = (source) => {
	const i = SOURCE_PRIORITY.indexOf(source);
	return i === -1 ? SOURCE_PRIORITY.length : i;
};

/** Keeps the highest-priority entry for each name. */
export function dedupeByName(list) {
	const best = new Map();
	for (const entry of list ?? []) {
		const key = `${entry.name}|${entry.edition}`;
		const current = best.get(key);
		if (!current || sourceRank(entry.source) < sourceRank(current.source)) {
			best.set(key, entry);
		}
	}
	return [...best.values()];
}

/** All entries sharing a name, so the UI can offer the other printings. */
export const variantsOf = (list, entry) =>
	(list ?? []).filter((x) => x.name === entry.name && x.edition === entry.edition);

/**
 * Filter a dataset by edition and source.
 * `edition` is "2024", "2014", or "all".
 * `sources` is an optional allow-list of book codes.
 * `dedupe` collapses reprints to one entry per name.
 */
export function filterEntries(list, { edition = "2024", sources = null, srdOnly = false, dedupe = false } = {}) {
	const filtered = (list ?? []).filter((x) => {
		if (edition !== "all" && x.edition !== edition) return false;
		if (srdOnly && !x.srd) return false;
		if (sources?.length && !sources.includes(x.source)) return false;
		return true;
	});
	return dedupe ? dedupeByName(filtered) : filtered;
}

/** Skills and abilities come from the hand-maintained rules.json, not 5etools. */
export const allSkills = () => db.rules?.skills ?? [];
export const allAbilities = () => db.rules?.abilities ?? [];
export const skillById = (id) => allSkills().find((s) => s.id === id) ?? null;
export const abilityById = (id) => allAbilities().find((a) => a.id === id) ?? null;

/** Every distinct source book present in the loaded data, for the filter UI. */
export function availableSources() {
	const set = new Set();
	for (const list of [db.species, db.classes, db.backgrounds, db.feats]) {
		for (const x of list ?? []) set.add(x.source);
	}
	return [...set].sort();
}
