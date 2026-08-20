/**
 * feats.js - taking a feat, and answering everything it asks.
 *
 * A feat is rarely just a paragraph. Resilient raises an ability AND grants a
 * saving throw proficiency; Skilled hands out three skills or tools; Magic
 * Initiate gives cantrips chosen from another class's list plus a level 1 spell
 * once per day. All of that has to cascade into the sheet, and all of it has to
 * be asked for at the point the feat is taken.
 *
 * This module renders those questions. It is used both by the level-up flow and
 * by a Build-mode section, so a feat can be revisited later.
 */

import { db, ensure, filterEntries } from "./data.js";
import { el, section, notice, choiceList, toast, modal, rulesHtml, infoButton } from "./ui.js";
import { showReference } from "./glossary.js";
import * as rules from "./rules.js";

/* ------------------------------------------------------------------ *
 * Which feats can be taken
 * ------------------------------------------------------------------ */

/**
 * Feats legal for this character at an ASI.
 *
 * 2024 splits feats into categories: only General feats (and Epic Boons at 19)
 * are options at an Ability Score Improvement. Origin feats come from a
 * background, and fighting styles from a class feature, so neither belongs here.
 */
export function asiFeatOptions(char, level) {
	const wanted = level >= 19 ? ["general", "epic-boon"] : ["general"];

	// A feat already taken cannot be taken again unless it says it is repeatable.
	const held = new Set(rules.grantedFeats(char).map((h) => h.name));

	return filterEntries(db.feats, { edition: char.edition ?? "2024", dedupe: true })
		.filter((f) => wanted.includes(f.category))
		.filter((f) => f.repeatable || !held.has(f.name))
		.filter((f) => char.houseRules?.ignoreFeatPrerequisites || meetsPrerequisite(f, char, level))
		.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A readable check against the feat's prerequisite line.
 *
 * The prerequisite is prose in the source data, so this reads it rather than
 * evaluating a structured rule: level gates and ability minimums are matched,
 * and anything it cannot interpret is allowed through with the requirement shown
 * on the card. Being permissive is the right failure mode -- blocking a legal
 * feat is worse than showing one the DM has to veto.
 */
export function meetsPrerequisite(feat, char, level) {
	const prereq = feat.prerequisite;
	if (!prereq) return true;

	const levelMatch = /level\s*(\d+)/i.exec(prereq);
	if (levelMatch && level < Number(levelMatch[1])) return false;

	// "STR 13+" style minimums.
	const scores = rules.abilityScores(char);
	for (const m of prereq.matchAll(/\b(STR|DEX|CON|INT|WIS|CHA)\s*(\d+)\+/gi)) {
		const key = m[1].toLowerCase();
		if ((scores[key] ?? 10) < Number(m[2])) return false;
	}

	if (/spellcasting/i.test(prereq) && !rules.spellcasting(char)) return false;

	return true;
}

/* ------------------------------------------------------------------ *
 * The questions a feat asks
 * ------------------------------------------------------------------ */

/**
 * Renders every outstanding decision for one feat.
 *
 * `onChange` is called after each answer so the caller can re-render and
 * re-check what is still pending.
 */
export function featOptionsEditor(char, featName, { onChange, abilities }) {
	const feat = (db.feats ?? []).find((f) => f.name === featName);
	const mech = feat?.mechanics;
	if (!mech) return null;

	const chosen = char.featOptions?.[featName] ?? {};
	const nodes = [];

	const patch = (part) => onChange({ ...chosen, ...part });

	/* --- ability increases ------------------------------------------- */
	const spread = (mech.abilityChoices ?? [])[0];
	if (spread) {
		const amount = spread.amount ?? 1;
		const slots = spread.count ?? 1;
		const total = amount * slots;
		const current = chosen.ability ?? {};
		const used = Object.values(current).reduce((a, b) => a + Number(b || 0), 0);

		nodes.push(el("div.feat-option", {}, [
			el("h5.feat-option__label", {
				text: `Raise ${total === 1 ? "an ability" : `abilities by ${total} total`}`,
			}),
			el("div.btn-row", {}, (spread.from ?? []).map((id) => {
				const ability = abilities.find((a) => a.id === id);
				const at = Number(current[id] ?? 0);
				// Raising a score past 20 does nothing, so do not offer it.
				const scores = rules.abilityScores(char);
				const wouldExceed = at === 0 && (scores[id] ?? 10) + amount > 20;
				return el("button.toggle-btn", {
					type: "button",
					class: [at > 0 ? "is-active" : "", wouldExceed ? "is-blocked" : ""].filter(Boolean).join(" "),
					disabled: wouldExceed,
					text: `${ability?.short ?? id.toUpperCase()}${at ? ` +${at}` : ""}`,
					title: wouldExceed
						? `${ability?.name ?? id} is already ${scores[id]}; 20 is the maximum`
						: `${ability?.name ?? id} — currently ${scores[id] ?? 10}`,
					onclick: () => {
						const next = { ...current };
						// Cycle: unset -> +amount -> unset, respecting the budget.
						if (at > 0) delete next[id];
						else if (used + amount <= total) next[id] = amount;
						else { toast(`Only ${total} point${total === 1 ? "" : "s"} to spend.`); return; }
						patch({ ability: next });
					},
				});
			})),
			used < total && el("p.feat-option__pending", {
				text: `${total - used} still to assign.`,
			}),
		].filter(Boolean)));
	}

	/* --- saving throw proficiency (Resilient) ------------------------ */
	for (const save of mech.saveChoices ?? []) {
		const picked = (chosen.saves ?? [])[0] ?? null;
		nodes.push(el("div.feat-option", {}, [
			el("h5.feat-option__label", { text: "Saving throw proficiency" }),
			el("div.btn-row", {}, (save.from ?? []).map((id) => {
				const ability = abilities.find((a) => a.id === id);
				const already = rules.saveProficiencies(char).has(id) && picked !== id;
				return el("button.toggle-btn", {
					type: "button",
					class: picked === id ? "is-active" : "",
					disabled: already,
					title: already ? "You already have this save proficiency" : ability?.name,
					text: ability?.short ?? id.toUpperCase(),
					onclick: () => patch({ saves: picked === id ? [] : [id] }),
				});
			})),
			!picked && el("p.feat-option__pending", { text: "Not chosen yet." }),
		].filter(Boolean)));
	}

	/* --- skills and tools (Skilled) ---------------------------------- */
	for (const skillChoice of mech.skillChoices ?? []) {
		const count = skillChoice.count ?? 1;
		const picked = chosen.skills ?? [];
		// "anySkill" means the whole skill list; already-held skills are locked
		// out because a duplicate proficiency does nothing.
		const pool = (skillChoice.from ?? []).includes("anySkill")
			? rules.skillProficiencySet(char)
			: null;
		const held = rules.skillProficiencySet(char);
		const options = (pool ? db.rules.skills.map((s) => s.id) : skillChoice.from ?? [])
			.filter((id) => typeof id === "string" && !id.startsWith("any"));

		nodes.push(el("div.feat-option", {}, [
			el("h5.feat-option__label", { text: `Choose ${count} skill${count === 1 ? "" : "s"}` }),
			choiceList({
				options: options.map((id) => {
					const skill = db.rules.skills.find((s) => s.id === id);
					return { id, label: skill?.name ?? id, hint: skill?.ability?.toUpperCase() };
				}),
				selected: picked,
				max: count,
				disabledIds: new Set([...held].filter((id) => !picked.includes(id))),
				onChange: (ids) => patch({ skills: ids }),
				onInfo: (opt) => showReference(`skill|${opt.label}|`),
			}),
			(skillChoice.from ?? []).includes("anyTool") && el("p.muted", {
				text: "This feat also allows tool proficiencies; add those on the Background step.",
			}),
		].filter(Boolean)));
	}

	/* --- which spell package (Magic Initiate) ------------------------ */
	if ((mech.spellVariants ?? []).length > 1) {
		nodes.push(el("div.feat-option", {}, [
			el("h5.feat-option__label", { text: "Spell list" }),
			el("div.btn-row", {}, mech.spellVariants.map((name) =>
				el("button.toggle-btn", {
					type: "button",
					class: chosen.variant === name ? "is-active" : "",
					text: name,
					// Changing package invalidates spells chosen from the old one.
					onclick: () => patch({ variant: name, spells: {} }),
				}),
			)),
			!chosen.variant && el("p.feat-option__pending", { text: "Not chosen yet." }),
		].filter(Boolean)));
	}

	/* --- spells chosen from a list ----------------------------------- */
	for (const spellChoice of mech.spellChoices ?? []) {
		if (spellChoice.variant && spellChoice.variant !== chosen.variant) continue;
		nodes.push(featSpellPicker(char, featName, spellChoice, chosen, patch));
	}

	if (!nodes.length) {
		return el("p.muted", { text: "Nothing to choose — this feat applies on its own." });
	}
	return el("div.feat-options", {}, nodes);
}

/**
 * A spell picker for one of a feat's spell choices.
 *
 * The pool comes from the feat's own filter ("level=0|class=Cleric"), so a Magic
 * Initiate (Cleric) sees Cleric cantrips and nothing else.
 */
function featSpellPicker(char, featName, spellChoice, chosen, patch) {
	const key = rules.spellChoiceKey(spellChoice);
	const picked = chosen.spells?.[key] ?? [];
	const count = spellChoice.count ?? 1;
	const host = el("div.feat-option", {}, [el("p.muted", { text: "Loading spells…" })]);

	const build = () => {
		const filter = rules.parseSpellFilter(spellChoice.filter);
		const pool = filterEntries(db.spells, { edition: char.edition ?? "2024" })
			.filter((sp) => !filter.levels || filter.levels.includes(sp.level))
			.filter((sp) => !filter.classes || (sp.classes ?? []).some((c) => filter.classes.includes(c)))
			.filter((sp) => !filter.schools || filter.schools.includes(String(sp.school).charAt(0).toUpperCase()))
			.sort((a, b) => a.name.localeCompare(b.name));

		const label = filter.levels?.includes(0)
			? `Choose ${count} cantrip${count === 1 ? "" : "s"}`
			: `Choose ${count} spell${count === 1 ? "" : "s"}`
				+ (spellChoice.note ? ` (${spellChoice.note})` : "");

		// Spells the character already has from any source. Picking one of these
		// again would spend the feat's choice on nothing.
		const alreadyHave = new Map();
		for (const g of rules.grantedSpells(char)) alreadyHave.set(g.id, g.source);
		for (const [classId, bucket] of Object.entries(char.spellsByClass ?? {})) {
			const className = db.classes.find((c) => c.id === classId)?.name ?? "your class";
			for (const list of ["cantrips", "prepared", "known"]) {
				for (const id of bucket[list] ?? []) if (!alreadyHave.has(id)) alreadyHave.set(id, className);
			}
		}

		host.replaceChildren(
			el("h5.feat-option__label", { text: label }),
			pool.length
				? choiceList({
					options: pool.map((sp) => ({
						id: sp.id,
						label: sp.name,
						hint: alreadyHave.has(sp.id) && !picked.includes(sp.id)
							? `already from ${alreadyHave.get(sp.id)}`
							: (sp.level === 0 ? sp.school : `Level ${sp.level} ${sp.school}`),
					})),
					selected: picked,
					max: count,
					// Greyed out rather than hidden, so it is clear why.
					disabledIds: new Set([...alreadyHave.keys()].filter((id) => !picked.includes(id))),
					onChange: (ids) => patch({ spells: { ...(chosen.spells ?? {}), [key]: ids } }),
					onInfo: (opt) => showReference(`spell|${opt.label}|`),
				})
				: notice("No spells matched this feat's list in the loaded data.", "warn"),
			picked.length < count && el("p.feat-option__pending", {
				text: `${count - picked.length} still to choose.`,
			}),
		);
	};

	if (db.spells) build();
	else ensure("spells").then(build);

	return host;
}

/** A one-line summary of what a feat still needs, for a card or a warning. */
export function pendingSummary(char, featName) {
	const pending = rules.featPendingChoices(char, featName);
	if (!pending.length) return null;

	const parts = pending.map((p) => {
		if (p.kind === "ability") return `${p.need} ability point${p.need === 1 ? "" : "s"}`;
		if (p.kind === "save") return "a saving throw";
		if (p.kind === "skill") return `${p.need} skill${p.need === 1 ? "" : "s"}`;
		if (p.kind === "variant") return "a spell list";
		if (p.kind === "spell") return `${p.need} spell${p.need === 1 ? "" : "s"}`;
		return p.kind;
	});
	return `Still to choose: ${parts.join(", ")}.`;
}
