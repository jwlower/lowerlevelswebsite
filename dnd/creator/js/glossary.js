/**
 * glossary.js - makes the highlighted terms in rules text clickable.
 *
 * The extractor tags every cross-reference as
 *   <span class="rr-ref" data-ref="skill|Insight|XPHB">Insight</span>
 * so a single delegated click handler can resolve the term against whichever
 * dataset owns it and pop the entry up, without every screen wiring its own
 * lookup. Datasets are pulled on demand, so clicking a spell name is the only
 * thing that ever loads the spell file.
 */

import { db, ensure, itemDescription } from "./data.js";
import { el, modal, rulesHtml } from "./ui.js";
import { statBlock, findCreature, creatureSubtitle } from "./statblock.js";

/**
 * Which dataset answers each tag, and which lazily-loaded file backs it.
 * `list` runs after loading and returns the array to search.
 */
const RESOLVERS = {
	skill: { load: "reference", list: () => db.reference?.skills, kind: "Skill" },
	sense: { load: "reference", list: () => db.reference?.senses, kind: "Sense" },
	condition: { load: "reference", list: () => db.reference?.conditions, kind: "Condition" },
	status: { load: "reference", list: () => db.reference?.conditions, kind: "Condition" },
	disease: { load: "reference", list: () => db.reference?.diseases, kind: "Disease" },
	language: { load: "reference", list: () => db.reference?.languages, kind: "Language" },
	action: { load: "reference", list: () => db.reference?.actions, kind: "Action" },
	variantrule: { load: "reference", list: () => db.reference?.variantRules, kind: "Rule" },
	itemMastery: { load: "reference", list: () => db.reference?.itemMasteries, kind: "Weapon Mastery" },

	spell: { load: "spells", list: () => db.spells, kind: "Spell" },
	feat: { load: null, list: () => db.feats, kind: "Feat" },
	background: { load: null, list: () => db.backgrounds, kind: "Background" },
	race: { load: null, list: () => db.species, kind: "Species" },
	class: { load: null, list: () => db.classes, kind: "Class" },
	optfeature: { load: "optional-features", list: () => db.optionalFeatures, kind: "Option" },
	creature: { load: "creatures", list: () => db.creatures, kind: "Creature" },
};

/** Items live across three files, so they get their own resolver. */
async function resolveItem(name) {
	if (!db.equipment) return null;
	const match = (list) =>
		list?.find((i) => i.name.toLowerCase() === name.toLowerCase());

	const gear = match(db.equipment);
	if (gear) return { entry: gear, kind: "Equipment" };

	await Promise.all([ensure("magic-items"), ensure("magic-variants")]);
	const item = match(db.magicItems);
	if (item) return { entry: item, kind: item.magic ? "Magic Item" : "Equipment" };

	return null;
}

/** Class and subclass features are nested inside the class records. */
function resolveClassFeature(name) {
	for (const cls of db.classes ?? []) {
		for (const block of cls.levels ?? []) {
			const f = (block.features ?? []).find((x) => x.name.toLowerCase() === name.toLowerCase());
			if (f) return { entry: { ...f, source: `${cls.name} ${f.level}` }, kind: "Class Feature" };
		}
		for (const sub of cls.subclasses ?? []) {
			for (const block of sub.levels ?? []) {
				const f = (block.features ?? []).find((x) => x.name.toLowerCase() === name.toLowerCase());
				if (f) return { entry: { ...f, source: `${sub.name} ${f.level}` }, kind: "Subclass Feature" };
			}
		}
	}
	return null;
}

/**
 * Resolve one reference. Prefers an entry from the matching source book, then
 * the same edition, then anything with the right name -- so a 2024 character
 * clicking "Insight" gets the 2024 wording where it exists.
 */
export async function lookup(tag, name, source) {
	if (tag === "item") return resolveItem(name);
	if (tag === "classFeature" || tag === "subclassFeature") return resolveClassFeature(name);

	const resolver = RESOLVERS[tag];
	if (!resolver) return null;

	if (resolver.load) await ensure(resolver.load);
	const list = resolver.list() ?? [];

	const byName = list.filter((x) => x.name?.toLowerCase() === name.toLowerCase());
	if (!byName.length) return null;

	const entry = byName.find((x) => x.source === source)
		?? byName.find((x) => x.edition === "2024")
		?? byName[0];

	return { entry, kind: resolver.kind };
}

/** Builds the modal body for a resolved entry. */
function renderEntry(entry, kind, tag) {
	if (tag === "creature") {
		const creature = findCreature(entry.id) ?? entry;
		return statBlock(creature);
	}

	const meta = [
		kind,
		entry.level != null && tag === "spell"
			? (entry.level === 0 ? "Cantrip" : `Level ${entry.level}`)
			: null,
		entry.school,
		entry.ability ? entry.ability.toUpperCase() : null,
		entry.rarity,
		entry.category,
		entry.cr != null ? creatureSubtitle(entry) : null,
		entry.source,
	].filter(Boolean).join(" · ");

	return el("div", {}, [
		el("p.muted", { text: meta }),
		rulesHtml(tag === "item" ? itemDescription(entry) : (entry.html ?? entry.blurb ?? "")),
		entry.higherLevel ? rulesHtml(entry.higherLevel) : null,
		// Items carry their numbers outside the prose.
		tag === "item" ? itemStats(entry) : null,
	].filter(Boolean));
}

function itemStats(item) {
	const rows = [
		["Cost", item.costGp != null ? `${item.costGp} gp` : null],
		["Weight", item.weight ? `${item.weight} lb` : null],
		["Damage", item.damage ? `${item.damage} ${item.damageType ?? ""}`.trim() : null],
		["Versatile", item.versatileDamage],
		["AC", item.ac],
		["Properties", (item.properties ?? []).join(", ") || null],
		["Mastery", (item.mastery ?? []).join(", ") || null],
		["Attunement", item.reqAttune ? "required" : null],
	].filter(([, v]) => v != null && v !== "");

	if (!rows.length) return null;
	return el("div.sb-core", {}, rows.map(([label, value]) =>
		el("div.sb-line", {}, [
			el("span.sb-line__label", { text: label }),
			el("span.sb-line__value", { text: String(value) }),
		]),
	));
}

/** Opens the entry a reference points at, or explains why it cannot. */
export async function showReference(refValue) {
	const [tag, name, source] = String(refValue).split("|");
	if (!tag || !name) return;

	// Show something immediately: some lookups need to fetch a data file.
	const body = el("div", {}, [el("p.muted", { text: "Looking up…" })]);
	const close = modal(name, body);

	let found = null;
	try {
		found = await lookup(tag, name, source);
	} catch (err) {
		console.error("Glossary lookup failed:", err);
	}

	if (found?.entry) {
		body.replaceChildren(renderEntry(found.entry, found.kind, tag));
	} else {
		body.replaceChildren(el("div", {}, [
			el("p", { text: `No entry for "${name}" in the loaded database.` }),
			el("p.muted", {
				text: `Referenced as a ${tag}${source ? ` from ${source}` : ""}. `
					+ "Some reference categories (deities, hazards, tables) are not part of a "
					+ "character-creation database, so they are not extracted.",
			}),
		]));
	}
	return close;
}

/**
 * One delegated listener for the whole page, so references work inside modals
 * and re-rendered screens without any re-binding.
 */
export function installGlossary(root = document) {
	root.addEventListener("click", (e) => {
		const ref = e.target.closest?.(".rr-ref[data-ref]");
		if (!ref) return;
		e.preventDefault();
		e.stopPropagation();
		showReference(ref.dataset.ref);
	});

	// Keyboard access: references are focusable via the CSS/markup below.
	root.addEventListener("keydown", (e) => {
		if (e.key !== "Enter" && e.key !== " ") return;
		const ref = e.target.closest?.(".rr-ref[data-ref]");
		if (!ref) return;
		e.preventDefault();
		showReference(ref.dataset.ref);
	});
}
