/**
 * sheet.js - the finished character sheet.
 *
 * Reads derived values from rules.js rather than storing them, so the sheet is
 * always consistent with the character record. The print stylesheet turns this
 * same markup into a paper sheet, which is the point: the table plays on paper.
 */

import { db, getSpecies, getClass, getBackground, getSubclass, getItem } from "./data.js";
import { el, section, modal, rulesHtml, notice, toast } from "./ui.js";
import { describeEffects } from "./effects.js";
import { findCreature, statBlock, creatureSubtitle, showCreature, creatureRefLinks } from "./statblock.js";
import * as rules from "./rules.js";

const fmt = rules.formatMod;

export function renderSheet(session, { onEdit, onLevelUp, onEditStep } = {}) {
	// Every block that came from a wizard step can jump back to it.
	const jump = (stepId) => (onEditStep ? () => onEditStep(stepId) : null);
	const char = session.character;
	const d = rules.derive(char);

	const cls = getClass(char.classes?.[0]?.classId);
	const sub = getSubclass(char.classes?.[0]?.classId, char.classes?.[0]?.subclassId);
	const species = getSpecies(char.speciesId);
	const bg = getBackground(char.backgroundId);
	const lineage = rules.selectedLineage(char);

	return el("div.sheet", {}, [
		sheetHeader(char, d, { cls, sub, species, bg, lineage, onEdit, onLevelUp }),
		el("div.sheet__grid", {}, [
			el("div.sheet__col", {}, [
				abilityBlock(d, jump("abilities")),
				savesBlock(d),
				skillsBlock(d, jump("class")),
			]),
			el("div.sheet__col", {}, [
				combatBlock(session, d),
				attacksBlock(d, jump("equipment")),
				equipmentBlock(char, d, jump("equipment")),
			]),
			el("div.sheet__col", {}, [
				d.spellcasting && spellBlock(char, d, jump("spells")),
				creatureBlock(char, jump("companions")),
				featuresBlock(char, d, { species, lineage, bg, jump }),
				proficienciesBlock(d),
				effectsBlock(char),
			].filter(Boolean)),
		]),
		detailsBlock(char),
	]);
}

/* ------------------------------------------------------------------ *
 * Header
 * ------------------------------------------------------------------ */

function sheetHeader(char, d, { cls, sub, species, bg, lineage, onEdit, onLevelUp }) {
	const classLine = (char.classes ?? [])
		.map((c) => {
			const k = getClass(c.classId);
			const s = getSubclass(c.classId, c.subclassId);
			return k ? `${k.name}${s ? ` (${s.name})` : ""} ${c.levels}` : null;
		})
		.filter(Boolean)
		.join(" / ");

	return el("header.sheet__header", {}, [
		el("div.sheet__identity", {}, [
			el("h2.sheet__name", { text: char.name || "Unnamed character" }),
			el("p.sheet__subtitle", {
				text: [
					classLine,
					species ? `${species.name}${lineage ? ` (${lineage.name})` : ""}` : null,
					bg?.name,
					char.details?.alignment,
				].filter(Boolean).join(" · "),
			}),
			el("p.sheet__meta", {
				text: `Level ${d.level} · Proficiency ${fmt(d.proficiencyBonus)} · ${char.edition} rules`,
			}),
		]),
		el("div.sheet__actions.no-print", {}, [
			onEdit && el("button.btn", { type: "button", text: "Edit", onclick: onEdit }),
			onLevelUp && el("button.btn.btn--primary", { type: "button", text: "Level up", onclick: onLevelUp }),
			el("button.btn", { type: "button", text: "Print", onclick: () => window.print() }),
		].filter(Boolean)),
	]);
}

/* ------------------------------------------------------------------ *
 * Blocks
 * ------------------------------------------------------------------ */

function abilityBlock(d, onEdit) {
	return sheetBox("Abilities",
		el("div.ability-grid", {}, (db.rules?.abilities ?? []).map((a) =>
			el("div.ability-cell", {}, [
				el("span.ability-cell__name", { text: a.short }),
				el("span.ability-cell__mod", { text: fmt(d.abilityMods[a.id] ?? 0) }),
				el("span.ability-cell__score", { text: d.abilityScores[a.id] ?? 10 }),
			]),
		)),
		onEdit,
	);
}

function savesBlock(d) {
	return sheetBox("Saving throws",
		el("ul.line-list", {}, Object.values(d.savingThrows).map((s) =>
			el("li.line-list__row", {}, [
				el("span.line-list__marker", { class: s.proficient ? "is-on" : "", text: s.proficient ? "●" : "○" }),
				el("span.line-list__label", { text: s.name }),
				el("span.line-list__value", { text: fmt(s.value) }),
			]),
		)),
	);
}

function skillsBlock(d, onEdit) {
	return sheetBox("Skills",
		el("ul.line-list", {}, d.skills.map((s) =>
			el("li.line-list__row", {}, [
				el("span.line-list__marker", {
					class: s.expertise ? "is-expert" : s.proficient ? "is-on" : "",
					text: s.expertise ? "◉" : s.proficient ? "●" : "○",
				}),
				el("span.line-list__label", { text: s.name }),
				el("span.line-list__ability", { text: s.ability.toUpperCase() }),
				el("span.line-list__value", { text: fmt(s.value) }),
			]),
		)),
		onEdit,
	);
}

function combatBlock(session, d) {
	const char = session.character;
	return sheetBox("Combat",
		el("div", {}, [
			el("div.combat-grid", {}, [
				bigStat("Armour Class", d.ac.total, d.ac.source),
				bigStat("Initiative", fmt(d.initiative)),
				bigStat("Speed", `${d.speed} ft`),
				bigStat("Passive Perception", d.passivePerception),
				d.darkvision ? bigStat("Darkvision", `${d.darkvision} ft`) : null,
			].filter(Boolean)),

			el("div.hp-block", {}, [
				el("div.hp-block__max", {}, [
					el("span.hp-block__label", { text: "Hit Point Maximum" }),
					el("span.hp-block__value", { text: d.hp.max }),
					el("button.link-btn.no-print", {
						type: "button", text: "how?",
						onclick: () => modal("Hit points", el("ul.breakdown", {},
							d.hp.breakdown.map((b) =>
								el("li", {}, [
									el("span", { text: b.label }),
									el("strong", { text: b.value >= 0 ? `+${b.value}` : b.value }),
								]),
							),
						)),
					}),
				]),
				el("div.hp-block__current", {}, [
					labelledInput("Current", char.hp?.current ?? d.hp.max, (v) =>
						session.update((c) => ({ ...c, hp: { ...c.hp, current: v } }))),
					labelledInput("Temp", char.hp?.temp ?? 0, (v) =>
						session.update((c) => ({ ...c, hp: { ...c.hp, temp: v } }))),
				]),
				el("div.hp-block__dice", {
					text: `Hit dice: ${Object.entries(d.hitDice).map(([die, n]) => `${n}${die}`).join(", ") || "—"}`,
				}),
			]),
		]),
	);
}

function attacksBlock(d, onEdit) {
	if (!d.attacks.length) {
		return sheetBox("Attacks", el("p.muted", { text: "Mark a weapon as in hand to see attacks here." }), onEdit);
	}

	return sheetBox("Attacks",
		el("div", {}, [
			el("table.sheet-table", {}, [
				el("thead", {}, el("tr", {}, [
					el("th", { text: "Weapon" }),
					el("th", { text: "Atk" }),
					el("th", { text: "Damage" }),
					el("th", { text: "Notes" }),
				])),
				el("tbody", {}, d.attacks.map((a) =>
					el("tr", {}, [
						el("td", {}, [
							el("span", { text: a.name }),
							// Grip matters for Dueling and Great Weapon Fighting, so it
							// is shown rather than left implicit.
							el("span.attack-grip", { text: a.grip === "two-handed" ? "two-handed" : "one-handed" }),
						]),
						el("td", { text: fmt(a.attackBonus) }),
						el("td", {}, [
							el("span", { text: `${a.damage} ${a.damageType}`.trim() }),
							a.bonusDamage > 0 && el("span.attack-bonus", { text: `incl. ${fmt(a.bonusDamage)}` }),
						].filter(Boolean)),
						el("td", {}, [
							el("span.attack-props", {
								text: [...(a.mastery ?? []), ...(a.properties ?? [])].join(", "),
							}),
							...a.activeEffects.map((e) =>
								el("span.attack-effect.is-on", { text: `${e.name}: ${e.detail}` }),
							),
						]),
					]),
				)),
			]),

			// Anything that could apply but does not, with the reason. This is what
			// turns "why is Dueling missing" into "because of the second weapon".
			...d.attacks
				.filter((a) => a.inactiveEffects.length)
				.map((a) => el("details.attack-inactive.no-print", {}, [
					el("summary", {
						text: `${a.name}: ${a.inactiveEffects.length} feature${a.inactiveEffects.length === 1 ? "" : "s"} not applying`,
					}),
					el("ul.attack-inactive__list", {}, a.inactiveEffects.map((e) =>
						el("li", {}, [
							el("strong", { text: e.name }),
							el("span", { text: ` needs ${e.requires} — ${e.why}.` }),
						]),
					)),
				])),
		]),
		onEdit,
	);
}

function equipmentBlock(char, d, onEdit) {
	const coins = (db.rules?.currencies ?? [])
		.map((c) => ({ ...c, amount: char.currency?.[c.id] ?? 0 }))
		.filter((c) => c.amount > 0);

	return sheetBox("Equipment",
		el("div", {}, [
			el("ul.item-list", {}, (char.equipment ?? []).map((e) =>
				el("li.item-list__row", {}, [
					el("span", { text: e.quantity > 1 ? `${e.name} ×${e.quantity}` : e.name }),
					e.equipped && el("span.chip.chip--small", { text: "worn" }),
				]),
			)),
			!(char.equipment ?? []).length && el("p.muted", { text: "Nothing carried." }),
			el("p.sheet__note", {
				text: `${d.weight.toFixed(1)} lb carried · capacity ${d.carrying.capacity} lb`,
			}),
			coins.length > 0 && el("p.sheet__note", {
				text: coins.map((c) => `${c.amount} ${c.id}`).join(" · "),
			}),
		].filter(Boolean)),
		onEdit,
	);
}

function spellBlock(char, d, onEdit) {
	const sc = d.spellcasting;
	const primary = sc.classes[0];

	return sheetBox("Spellcasting",
		el("div", {}, [
			el("div.combat-grid", {}, [
				bigStat("Save DC", primary?.saveDc ?? "—"),
				bigStat("Attack", fmt(primary?.attackBonus ?? 0)),
				primary?.preparedCount != null ? bigStat("Prepared", primary.preparedCount) : null,
			].filter(Boolean)),

			sc.slots?.length > 0 && el("div.slot-row", {}, sc.slots.map((n, i) =>
				el("div.slot-box", {}, [
					el("span.slot-box__level", { text: `L${i + 1}` }),
					el("span.slot-box__count", { text: n }),
				]),
			)),

			sc.pactMagic && el("p.sheet__note", {
				text: `Pact Magic: ${sc.pactMagic.count} × level ${sc.pactMagic.level}`,
			}),

			spellNameList("Cantrips", char.spells?.cantrips),
			spellNameList("Spells", char.spells?.prepared),
		].filter(Boolean)),
		onEdit,
	);
}

/** Spell ids resolve to names only once the spell file has been loaded. */
function spellNameList(title, ids) {
	if (!ids?.length) return null;
	const names = ids.map((id) => {
		const found = db.spells?.find((s) => s.id === id);
		return found?.name ?? id.split("--")[0].replace(/-/g, " ");
	});
	return el("div.spell-list", {}, [
		el("h5.spell-list__title", { text: title }),
		el("p.spell-list__names", { text: names.join(", ") }),
	]);
}

/**
 * Wild Shape forms and companions. The stat blocks are only in memory once
 * creatures.json has been lazily loaded, so unresolved entries fall back to
 * showing the id -- which still tells the player what they picked.
 */
function creatureBlock(char, onEdit) {
	const forms = char.wildShapeForms ?? [];
	const companions = Object.entries(char.companions ?? {});
	if (!forms.length && !companions.length) return null;

	return sheetBox("Forms & companions",
		el("div", {}, [
			forms.length > 0 && el("div.spell-list", {}, [
				el("h5.spell-list__title", { text: "Wild Shape forms" }),
				el("div.chip-row", {}, forms.map((id) => {
					const c = findCreature(id);
					return el("button.chip.chip--creature", {
						type: "button",
						text: c?.name ?? id.split("--")[0].replace(/-/g, " "),
						onclick: () => showCreature(id),
					});
				})),
			]),
			...companions.map(([featureName, id]) => {
				const c = findCreature(id);
				return el("div.spell-list", {}, [
					el("h5.spell-list__title", { text: featureName }),
					c
						? el("details.feature-detail", {}, [
							el("summary", {}, [
								el("span.feature-detail__name", { text: c.name }),
								el("span.feature-detail__source", { text: creatureSubtitle(c) }),
							]),
							statBlock(c),
						])
						: el("p.muted", { text: id }),
				]);
			}),
		].filter(Boolean)),
		onEdit,
	);
}

function featuresBlock(char, d, { species, lineage, bg, jump }) {
	const traits = [
		...(species?.traits ?? []).map((t) => ({ ...t, source: species.name, step: "species" })),
		...(lineage ? [{ name: lineage.name, html: lineage.html, source: species?.name, step: "species" }] : []),
	];

	// Feats arrive from three different steps, so each links back to its own.
	const featEntries = rules.grantedFeats(char).map((held) => {
		const feat = (db.feats ?? []).find((f) => f.name === held.name);
		return {
			name: held.name,
			html: feat?.html ?? "",
			source: held.from === "background" ? `${held.sourceName} (granted)` : held.sourceName,
			step: held.from === "background" ? "background" : held.from === "species" ? "species" : "class",
		};
	});

	return sheetBox("Features & traits",
		el("div.feature-accordion", {}, [
			...traits.map((t) => featureDetail(t.name, t.source, t.html, jump?.(t.step))),
			...featEntries.map((f) => featureDetail(f.name, f.source, f.html, jump?.(f.step))),
			...d.features.map((f) => featureDetail(f.name, `${f.source} ${f.level}`, f.html, jump?.("class"))),
			bg && featureDetail(bg.name, "Background", bg.html, jump?.("background")),
		].filter(Boolean)),
	);
}

/**
 * One collapsible feature. When a jump target is supplied, an "edit" link takes
 * the player back to the wizard step where that feature was chosen -- so a trait
 * you regret is two clicks from being changed rather than a hunt through steps.
 */
const featureDetail = (name, source, html, onEdit) =>
	el("details.feature-detail", {}, [
		el("summary", {}, [
			el("span.feature-detail__name", { text: name }),
			source && el("span.feature-detail__source", { text: source }),
		]),
		el("div.feature-detail__body", {}, [
			rulesHtml(html),
			onEdit && el("button.link-btn.no-print", {
				type: "button", text: "Change this", onclick: onEdit,
			}),
		].filter(Boolean)),
	]);

function proficienciesBlock(d) {
	const p = d.proficiencies;
	const row = (label, values) =>
		values?.length
			? el("div.prof-row", {}, [
				el("span.prof-row__label", { text: label }),
				el("span.prof-row__value", { text: values.join(", ") }),
			])
			: null;

	return sheetBox("Proficiencies",
		el("div", {}, [
			row("Armour", p.armor),
			row("Weapons", p.weapons),
			row("Tools", p.tools),
			row("Languages", p.languages),
		].filter(Boolean)),
	);
}

function effectsBlock(char) {
	const list = describeEffects(char);
	if (!list.length) return null;
	return sheetBox("Applied automatically",
		el("ul.effect-list", {}, list.map((t) => el("li", { text: t }))),
	);
}

function detailsBlock(char) {
	const d = char.details ?? {};
	const entries = [
		["Appearance", d.appearance],
		["Personality", d.personality],
		["Ideals", d.ideals],
		["Bonds", d.bonds],
		["Flaws", d.flaws],
		["Backstory", d.backstory],
		["Notes", d.notes],
	].filter(([, v]) => v?.trim());

	if (!entries.length) return null;

	return el("div.sheet__details", {},
		sheetBox("Character",
			el("div.detail-readout", {}, entries.map(([label, value]) =>
				el("div.detail-readout__row", {}, [
					el("h5", { text: label }),
					el("p", { text: value }),
				]),
			)),
		),
	);
}

/* ------------------------------------------------------------------ *
 * Small pieces
 * ------------------------------------------------------------------ */

const sheetBox = (title, body, onEdit) =>
	el("section.sheet-box", {}, [
		el("div.sheet-box__head", {}, [
			el("h3.sheet-box__title", { text: title }),
			onEdit && el("button.sheet-box__edit.no-print", {
				type: "button", text: "edit", title: `Change ${title.toLowerCase()}`,
				onclick: onEdit,
			}),
		].filter(Boolean)),
		el("div.sheet-box__body", {}, [body]),
	]);

const bigStat = (label, value, hint) =>
	el("div.big-stat", {}, [
		el("span.big-stat__label", { text: label }),
		el("span.big-stat__value", { text: value }),
		hint && el("span.big-stat__hint", { text: hint }),
	]);

function labelledInput(label, value, onChange) {
	return el("label.mini-field", {}, [
		el("span", { text: label }),
		el("input", {
			type: "number",
			value: value ?? 0,
			oninput: (e) => onChange(Number(e.target.value) || 0),
		}),
	]);
}
