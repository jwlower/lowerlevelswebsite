/**
 * state.js - the character record, its roster, and persistence.
 *
 * Everything lives in localStorage, which keeps the whole app static: serve the
 * folder from any machine on the LAN and it works with no backend. Characters
 * are per-device, so export/import JSON is the way to move one between phones
 * or hand a character to the DM.
 */

const STORAGE_KEY = "lowerlevels.dnd.characters.v1";
const SETTINGS_KEY = "lowerlevels.dnd.settings.v1";
const SCHEMA_VERSION = 1;

/* ------------------------------------------------------------------ *
 * Blank character
 * ------------------------------------------------------------------ */

export function newCharacter(overrides = {}) {
	const now = new Date().toISOString();
	return {
		schemaVersion: SCHEMA_VERSION,
		id: crypto.randomUUID(),
		name: "",
		createdAt: now,
		updatedAt: now,

		// Which ruleset this character is built from.
		edition: "2024",

		// Multiclassing is supported; classes[0] is the starting class.
		classes: [], // [{ classId, subclassId, levels, hitDiceRolled: [] }]

		speciesId: null,
		speciesChoices: {}, // { [choiceId]: optionId }
		lineageId: null, // for 2014-style subraces
		size: null,

		backgroundId: null,

		abilityMethod: "standard-array",
		baseAbilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
		abilityBonuses: { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 }, // from background
		asiBonuses: { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 }, // from level-up ASIs
		rolledScores: [],

		// Skills are tracked BY SOURCE rather than as one flat list, so the app can
		// tell "the Fighter chose Insight" from "the background granted Insight"
		// and warn instead of silently swallowing the duplicate. rules.js derives
		// the flat set from these plus the fixed grants.
		skillChoices: { class: [], species: [], feat: [] },
		extraSkills: [], // added by hand on the sheet
		expertise: [], // added by hand
		// Expertise assigned against a feature that grants it, keyed by
		// "classId:Feature:level" so a Rogue's level 1 and level 6 grants stay
		// separate. See rules.expertiseGrants.
		expertiseChoices: {},
		// Deliberate departures from what the builder worked out, keyed by skill
		// id: "none" | "proficient" | "expert". Anything absent follows the build.
		skillOverrides: {},
		toolProficiencies: [],
		// Languages, tracked by where each choice came from so a duplicate can be
		// spotted the same way a duplicate skill is. `languages` stays as the
		// by-hand list for anything a DM simply grants.
		languages: [],
		languageChoices: { origin: [], species: [], background: [], feat: {} },
		// Feats chosen for a species trait, keyed by that trait's choice id.
		featChoices: {},
		feats: [], // feats taken at level-up, by name
		// The level each feat was taken at, so the timeline can place it.
		featLevels: {},
		// The decisions a feat required, keyed by feat name:
		//   { ability: {con:1}, saves: ["con"], skills: [...], variant, spells: {} }
		featOptions: {},
		optionalFeaturePicks: [], // fighting styles, invocations, maneuvers, metamagic

		equipment: [], // [{ itemId, name, quantity, equipped, notes }]
		// Items a DM invented, kept with the character that was given them.
		// Same shape as a database item, so everything downstream treats them
		// alike; see customitems.js.
		customItems: [],
		currency: { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 },

		// Spells are kept PER CLASS: a Cleric 3 / Wizard 2 prepares Cleric spells
		// against the Cleric table and Wizard spells against the Wizard table,
		// even though both draw on one shared pool of slots.
		spellsByClass: {}, // { [classId]: { cantrips: [], prepared: [], known: [] } }
		// Slot expenditure, for use at the table. Keyed by slot level as a string.
		spellSlotsUsed: {}, // { "1": 2, "3": 1 }
		pactSlotsUsed: 0,

		// Table-side expenditure, all reset by the rest buttons in Play mode.
		// Hit dice are grouped by die size ({ d10: 2 }) because that is how they
		// are spent; feature uses are keyed "classId:Feature Name" so a
		// Cleric/Paladin tracks two Channel Divinity pools rather than one.
		hitDiceUsed: {}, // { "d10": 2 }
		resourcesUsed: {}, // { "fighter--xphb:Second Wind": 1 }
		// A short-rest log, so the sheet can show what the last rest restored.
		lastRest: null, // { kind: "short" | "long", at: ISO string }
		// Which variant of a subclass's granted spell list applies, keyed by class
		// id -- the 2024 Circle of the Land picks a terrain, for instance.
		spellVariants: {},

		// bonusMax adds to the derived maximum; overrideMax replaces it outright.
		// adjustBy is the step the +/- buttons on the sheet use.
		hp: { current: null, temp: 0, overrideMax: null, bonusMax: 0, adjustBy: 1 },
		acOverride: null,
		customEffects: [],

		details: {
			alignment: "",
			playerName: "",
			appearance: "",
			personality: "",
			ideals: "",
			bonds: "",
			flaws: "",
			backstory: "",
			notes: "",
		},

		// House rules. Each one relaxes a restriction the books impose; they are
		// per-character so one table's variant does not leak into another's.
		houseRules: {
			freeAbilityAssignment: false, // put the +2/+1 on any ability, not just the background's three
			allowDuplicateSkills: false,  // stop locking skills already granted elsewhere
			ignoreFeatPrerequisites: false,
			unrestrictedWildShape: false, // ignore the CR and movement limits on forms
		},

		// Wizard bookkeeping
		completedSteps: [],
		...overrides,
	};
}

/* ------------------------------------------------------------------ *
 * Roster persistence
 * ------------------------------------------------------------------ */

function readRoster() {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch (err) {
		console.error("Could not read saved characters:", err);
		return [];
	}
}

function writeRoster(list) {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
		return true;
	} catch (err) {
		// Most likely the 5 MB quota. Tell the caller so the UI can warn.
		console.error("Could not save characters:", err);
		return false;
	}
}

export const listCharacters = () =>
	readRoster().sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));

export const getCharacter = (id) => readRoster().find((c) => c.id === id) ?? null;

export function saveCharacter(char) {
	const list = readRoster();
	const updated = { ...char, updatedAt: new Date().toISOString() };
	const i = list.findIndex((c) => c.id === char.id);
	if (i === -1) list.push(updated);
	else list[i] = updated;
	const ok = writeRoster(list);
	return ok ? updated : null;
}

export function deleteCharacter(id) {
	return writeRoster(readRoster().filter((c) => c.id !== id));
}

export function duplicateCharacter(id) {
	const src = getCharacter(id);
	if (!src) return null;
	const copy = {
		...structuredClone(src),
		id: crypto.randomUUID(),
		name: `${src.name || "Unnamed"} (copy)`,
		createdAt: new Date().toISOString(),
	};
	return saveCharacter(copy);
}

/* ------------------------------------------------------------------ *
 * Import / export
 * ------------------------------------------------------------------ */

export function exportCharacter(char) {
	const blob = new Blob([JSON.stringify(char, null, 2)], { type: "application/json" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = `${(char.name || "character").replace(/[^\w-]+/g, "-").toLowerCase()}.json`;
	document.body.appendChild(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(url);
}

export function exportRoster() {
	const blob = new Blob([JSON.stringify(readRoster(), null, 2)], { type: "application/json" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = `lowerlevels-characters-${new Date().toISOString().slice(0, 10)}.json`;
	document.body.appendChild(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(url);
}

/**
 * Accepts either a single character object or an array of them, giving each a
 * fresh id so an import never overwrites something already on the device.
 */
export function importCharacters(json) {
	const incoming = Array.isArray(json) ? json : [json];
	const list = readRoster();
	const added = [];

	for (const raw of incoming) {
		if (!raw || typeof raw !== "object") continue;
		const char = migrate({
			...newCharacter(),
			...raw,
			id: crypto.randomUUID(),
			updatedAt: new Date().toISOString(),
		});
		list.push(char);
		added.push(char);
	}

	writeRoster(list);
	return added;
}

/** Brings older saved characters up to the current shape. */
export function migrate(char) {
	const base = newCharacter();
	const merged = { ...base, ...char };
	merged.details = { ...base.details, ...(char.details ?? {}) };
	merged.hp = { ...base.hp, ...(char.hp ?? {}) };
	merged.currency = { ...base.currency, ...(char.currency ?? {}) };
	merged.spellsByClass = { ...base.spellsByClass, ...(char.spellsByClass ?? {}) };
	merged.spellSlotsUsed = { ...base.spellSlotsUsed, ...(char.spellSlotsUsed ?? {}) };
	merged.hitDiceUsed = { ...base.hitDiceUsed, ...(char.hitDiceUsed ?? {}) };
	merged.customItems = [...(char.customItems ?? [])];
	merged.resourcesUsed = { ...base.resourcesUsed, ...(char.resourcesUsed ?? {}) };
	merged.spellVariants = { ...base.spellVariants, ...(char.spellVariants ?? {}) };
	// Characters saved before spells were tracked per class have one flat list.
	// Attach it to the first class so nothing is lost.
	if (char.spells && !Object.keys(char.spellsByClass ?? {}).length) {
		const firstClassId = char.classes?.[0]?.classId;
		if (firstClassId) {
			merged.spellsByClass = {
				[firstClassId]: {
					cantrips: char.spells.cantrips ?? [],
					prepared: char.spells.prepared ?? [],
					known: char.spells.known ?? [],
				},
			};
		}
	}
	delete merged.spells;
	merged.skillChoices = { ...base.skillChoices, ...(char.skillChoices ?? {}) };
	merged.languageChoices = { ...base.languageChoices, ...(char.languageChoices ?? {}) };
	merged.expertiseChoices = { ...base.expertiseChoices, ...(char.expertiseChoices ?? {}) };
	merged.skillOverrides = { ...base.skillOverrides, ...(char.skillOverrides ?? {}) };
	merged.houseRules = { ...base.houseRules, ...(char.houseRules ?? {}) };
	merged.featChoices = { ...base.featChoices, ...(char.featChoices ?? {}) };
	merged.featOptions = { ...base.featOptions, ...(char.featOptions ?? {}) };
	merged.featLevels = { ...base.featLevels, ...(char.featLevels ?? {}) };
	// Characters saved before skills were source-tracked carry a flat list.
	// Keep those proficiencies by treating them as manual additions.
	if (Array.isArray(char.skillProficiencies) && char.skillProficiencies.length
		&& !Object.values(char.skillChoices ?? {}).some((a) => a?.length)) {
		merged.extraSkills = [...new Set([...(char.extraSkills ?? []), ...char.skillProficiencies])];
	}
	delete merged.skillProficiencies;
	merged.baseAbilities = { ...base.baseAbilities, ...(char.baseAbilities ?? {}) };
	merged.abilityBonuses = { ...base.abilityBonuses, ...(char.abilityBonuses ?? {}) };
	merged.asiBonuses = { ...base.asiBonuses, ...(char.asiBonuses ?? {}) };
	merged.schemaVersion = SCHEMA_VERSION;
	return merged;
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

const DEFAULT_SETTINGS = {
	edition: "2024",
	sources: null, // null = all books
	showSrdOnly: false,
	hpMethod: "average", // "average" | "roll" | "max"
};

export function getSettings() {
	try {
		return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") };
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

export function saveSettings(patch) {
	const next = { ...getSettings(), ...patch };
	localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
	return next;
}

/* ------------------------------------------------------------------ *
 * Live editing session
 *
 * A tiny observable wrapper so the UI can re-render on every change and
 * autosave without each screen wiring up its own persistence.
 * ------------------------------------------------------------------ */

export function createSession(char) {
	let current = migrate(char);
	const listeners = new Set();
	let saveTimer = null;

	const notify = () => {
		for (const fn of listeners) fn(current);
	};

	const scheduleSave = () => {
		clearTimeout(saveTimer);
		saveTimer = setTimeout(() => saveCharacter(current), 400);
	};

	return {
		get character() {
			return current;
		},
		/** Apply a patch (object or updater fn), persist, and notify listeners. */
		update(patch) {
			const next = typeof patch === "function" ? patch(current) : { ...current, ...patch };
			current = next;
			scheduleSave();
			notify();
			return current;
		},
		/** Update without touching storage, for transient UI state. */
		set(next) {
			current = next;
			notify();
		},
		subscribe(fn) {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
		saveNow() {
			clearTimeout(saveTimer);
			return saveCharacter(current);
		},
	};
}
