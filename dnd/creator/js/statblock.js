/**
 * statblock.js - renders a creature stat block.
 *
 * Used in three places, all player-facing: Wild Shape forms, the Beast Master's
 * companion, and the stat block a summoning spell points at. The DM's bestiary
 * is not part of this app; only creatures that player content references are
 * extracted at all.
 */

import { db, ensure } from "./data.js";
import { el, modal, rulesHtml } from "./ui.js";
import { modifier, formatMod } from "./rules.js";

/** Look a creature up by id, or fall back to matching on name. */
export function findCreature(ref) {
	if (!db.creatures) return null;
	if (typeof ref === "string") {
		return db.creatures.find((c) => c.id === ref)
			?? db.creatures.find((c) => c.name.toLowerCase() === ref.toLowerCase())
			?? null;
	}
	return db.creatures.find((c) => c.id === ref?.id)
		?? db.creatures.find((c) => c.name.toLowerCase() === String(ref?.name ?? "").toLowerCase())
		?? null;
}

const SIZE_NAMES = { T: "Tiny", S: "Small", M: "Medium", L: "Large", H: "Huge", G: "Gargantuan" };

/** "Medium Beast, CR 1/4" style line. */
export function creatureSubtitle(c) {
	const size = (c.size ?? []).map((s) => SIZE_NAMES[s] ?? s).join(" or ");
	const type = c.creatureType
		? c.creatureType.charAt(0).toUpperCase() + c.creatureType.slice(1)
		: null;
	return [
		[size, type].filter(Boolean).join(" "),
		c.cr != null ? `CR ${c.cr}` : null,
	].filter(Boolean).join(" · ");
}

/** Speeds as "40 ft., climb 40 ft." */
export function speedLine(speed) {
	if (!speed) return "—";
	if (typeof speed === "number") return `${speed} ft.`;
	return Object.entries(speed)
		.filter(([, v]) => v)
		.map(([mode, v]) => {
			const n = typeof v === "object" ? v.number : v;
			return mode === "walk" ? `${n} ft.` : `${mode} ${n} ft.`;
		})
		.join(", ");
}

/** Full stat block node. */
export function statBlock(c) {
	if (!c) return el("p.muted", { text: "Stat block not found in the loaded data." });

	const abilityRow = el("div.sb-abilities", {},
		["str", "dex", "con", "int", "wis", "cha"].map((k) => {
			const score = c.abilities?.[k];
			return el("div.sb-ability", {}, [
				el("span.sb-ability__name", { text: k.toUpperCase() }),
				el("span.sb-ability__score", { text: score ?? "—" }),
				el("span.sb-ability__mod", { text: score != null ? formatMod(modifier(score)) : "" }),
			]);
		}),
	);

	const line = (label, value) =>
		value ? el("div.sb-line", {}, [
			el("span.sb-line__label", { text: label }),
			el("span.sb-line__value", { text: value }),
		]) : null;

	const group = (title, items) =>
		items?.length ? el("div.sb-group", {}, [
			el("h5.sb-group__title", { text: title }),
			...items.map((a) => el("div.sb-entry", {}, [
				el("strong.sb-entry__name", { text: a.name }),
				rulesHtml(a.html),
			])),
		]) : null;

	const fmtMap = (m) => (m && typeof m === "object"
		? Object.entries(m).map(([k, v]) => `${k} ${v}`).join(", ")
		: m);

	return el("div.statblock", {}, [
		el("div.sb-head", {}, [
			el("h4.sb-name", { text: c.name }),
			el("p.sb-meta", { text: `${creatureSubtitle(c)} · ${c.source}` }),
		]),
		el("div.sb-core", {}, [
			// Summon stat blocks scale with spell level, so AC and HP are often a
			// formula rather than a number.
			line("AC", c.ac != null ? `${c.ac}${c.acNote ? ` (${c.acNote})` : ""}` : c.acNote),
			line("HP", c.hp != null ? `${c.hp}${c.hpFormula ? ` (${c.hpFormula})` : ""}` : c.hpFormula),
			line("Speed", speedLine(c.speed)),
		].filter(Boolean)),
		abilityRow,
		el("div.sb-core", {}, [
			line("Skills", fmtMap(c.skills)),
			line("Resistances", Array.isArray(c.resist) ? c.resist.map(fmtMap).join(", ") : fmtMap(c.resist)),
			line("Immunities", Array.isArray(c.immune) ? c.immune.map(fmtMap).join(", ") : fmtMap(c.immune)),
			line("Senses", (c.senses ?? []).join(", ")),
			line("Passive Perception", c.passivePerception),
			line("Languages", Array.isArray(c.languages) ? c.languages.join(", ") : c.languages),
		].filter(Boolean)),
		group("Traits", c.traits),
		group("Actions", c.actions),
		group("Bonus Actions", c.bonusActions),
		group("Reactions", c.reactions),
	]);
}

/** Opens a stat block in a modal, loading the creature file if needed. */
export async function showCreature(ref) {
	await ensure("creatures");
	const c = findCreature(ref);
	modal(c?.name ?? (typeof ref === "string" ? ref : ref?.name ?? "Creature"), statBlock(c));
}

/**
 * A row of buttons linking to each stat block a spell or feature references,
 * so "Summon Elemental" gives you one click to the Elemental Spirit block.
 */
export function creatureRefLinks(refs) {
	if (!refs?.length) return null;
	return el("div.creature-refs", {}, [
		el("span.creature-refs__label", { text: refs.length > 1 ? "Stat blocks:" : "Stat block:" }),
		...refs.map((r) =>
			el("button.chip.chip--creature", {
				type: "button",
				text: r.name,
				onclick: (e) => { e.preventDefault(); e.stopPropagation(); showCreature(r); },
			}),
		),
	]);
}
