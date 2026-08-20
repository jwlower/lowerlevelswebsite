/**
 * spellsheet.js - the spell sheet, as its own page.
 *
 * Real character sheets keep spells on a separate sheet, and for good reason:
 * a caster's spell list does not fit in a column beside their armour class.
 * This is that page. It is the view you keep open during a fight, so slots are
 * clickable, prepared spells can be swapped in place, and every spell name
 * opens its full description.
 *
 * It also prints as its own page, after the character sheet.
 */

import { db, ensure } from "./data.js";
import { el, notice, toast, modal, rulesHtml, infoButton } from "./ui.js";
import { showSpell, showReference } from "./glossary.js";
import * as rules from "./rules.js";
import { afterShortRest, afterLongRest } from "./rest.js";

const fmt = rules.formatMod;

/* ------------------------------------------------------------------ *
 * Formatting helpers
 * ------------------------------------------------------------------ */

/** "1 action", "1 bonus action", "1 minute". */
function timeLabel(time) {
	if (!Array.isArray(time) || !time.length) return "—";
	const t = time[0];
	const unit = t.unit === "bonus" ? "bonus" : t.unit;
	const n = t.number ?? 1;
	if (unit === "action") return n > 1 ? `${n} actions` : "Action";
	if (unit === "bonus") return "Bonus";
	if (unit === "reaction") return "Reaction";
	return `${n} ${unit}${n > 1 ? "s" : ""}`;
}

/** "Self", "60 ft", "Touch". */
function rangeLabel(range) {
	if (!range) return "—";
	const d = range.distance;
	if (!d) return range.type ?? "—";
	if (d.type === "self") return "Self";
	if (d.type === "touch") return "Touch";
	if (d.type === "sight") return "Sight";
	if (d.type === "unlimited") return "Unlim.";
	if (d.amount != null) return `${d.amount} ${d.type === "feet" ? "ft" : d.type}`;
	return d.type ?? "—";
}

/** "V S M". */
function componentLabel(components) {
	if (!components) return "—";
	const parts = [];
	if (components.v) parts.push("V");
	if (components.s) parts.push("S");
	if (components.m) parts.push("M");
	return parts.join(" ") || "—";
}

/** "Instant", "1 min", "1 hr". */
function durationLabel(duration) {
	if (!Array.isArray(duration) || !duration.length) return "—";
	const d = duration[0];
	if (d.type === "instant") return "Instant";
	if (d.type === "permanent") return "Until dispelled";
	if (d.type === "special") return "Special";
	const amount = d.duration?.amount;
	const unit = d.duration?.type ?? "";
	const short = { minute: "min", hour: "hr", round: "rnd", turn: "turn", day: "day" }[unit] ?? unit;
	return `${d.duration?.upTo ? "≤" : ""}${amount ?? ""} ${short}`.trim();
}

/* ------------------------------------------------------------------ *
 * The sheet
 * ------------------------------------------------------------------ */

export function renderSpellSheet(session, { onEditStep, onRerender } = {}) {
	const char = session.character;
	const sc = rules.spellcasting(char);

	if (!sc) {
		return el("div.spellsheet", {}, [
			el("p.muted", { text: `${char.name || "This character"} has no spellcasting.` }),
		]);
	}

	return el("div.spellsheet", {}, [
		el("header.spellsheet__header", {}, [
			el("div", {}, [
				el("h2.spellsheet__name", { text: `${char.name || "Unnamed character"} — Spells` }),
				el("p.spellsheet__meta", {
					text: sc.multiclass
						? `${sc.classes.map((c) => `${c.className} ${c.levels}`).join(" / ")}`
							+ ` · effective caster level ${sc.effectiveCasterLevel}`
						: `${sc.classes[0].className} ${sc.classes[0].levels}`,
				}),
			]),
			el("div.btn-row.no-print", {}, [
				onEditStep && el("button.btn", {
					type: "button", text: "Choose spells", onclick: () => onEditStep("spells"),
				}),
				el("button.btn", { type: "button", text: "Print", onclick: () => window.print() }),
			].filter(Boolean)),
		]),

		// Per-class numbers. Each casting class has its own DC and limits.
		el("div.spellsheet__classes", {}, sc.classes.map((caster) => classCard(char, caster))),

		slotPanel(session, sc, onRerender),

		grantedPanel(char),

		// The lists themselves, one block per casting class.
		...sc.classes.map((caster) => classSpellList(session, char, caster, sc, onRerender)),
	].filter(Boolean));
}

/** One casting class's headline numbers. */
function classCard(char, caster) {
	const chosen = rules.classSpells(char, caster.classId);
	const limit = caster.preparedLimit ?? caster.spellsKnownLimit;

	const stat = (label, value, warn = false) =>
		el("div.ss-stat", { class: warn ? "is-warn" : "" }, [
			el("span.ss-stat__label", { text: label }),
			el("span.ss-stat__value", { text: value }),
		]);

	return el("div.ss-class", {}, [
		el("h3.ss-class__name", {
			text: caster.subclassName
				? `${caster.className} ${caster.levels} (${caster.subclassName})`
				: `${caster.className} ${caster.levels}`,
		}),
		el("div.ss-class__stats", {}, [
			stat("Ability", caster.ability.toUpperCase()),
			stat("Save DC", caster.saveDc),
			stat("Attack", fmt(caster.attackBonus)),
			caster.cantripsKnown != null
				&& stat("Cantrips", `${chosen.cantrips.length}/${caster.cantripsKnown}`,
					chosen.cantrips.length > caster.cantripsKnown),
			caster.spellbookLimit != null
				&& stat("Spellbook", `${chosen.known.length}/${caster.spellbookLimit}`,
					chosen.known.length > caster.spellbookLimit),
			limit != null
				&& stat(caster.preparedLimit != null ? "Prepared" : "Known",
					`${chosen.prepared.length}/${limit}`,
					chosen.prepared.length > limit),
		].filter(Boolean)),
	]);
}

/** The shared slot pool, plus Pact Magic and the rest buttons. */
function slotPanel(session, sc, onRerender) {
	if (!sc.slots.length && !sc.pact) {
		return notice("No spell slots at this level. Cantrips still work.", "warn");
	}

	const pips = (total, used, onClick, extraClass = "") =>
		el("div.ss-pips", {}, Array.from({ length: total }, (_, i) => {
			const isUsed = i < used;
			return el(`button.slot-pip${extraClass}`, {
				type: "button",
				class: isUsed ? "is-used" : "",
				title: isUsed ? "Restore this slot" : "Spend this slot",
				onclick: () => onClick(i, isUsed),
			});
		}));

	return el("section.ss-slots", {}, [
		el("h3.ss-section__title", { text: "Spell slots" }),
		sc.multiclass && el("p.muted", {
			text: "Shared across all your casting classes.",
		}),

		el("div.ss-slot-rows", {}, [
			...sc.slots.map((total, i) => {
				const level = i + 1;
				const used = sc.slotsUsed[i] ?? 0;
				return el("div.ss-slot-row", {}, [
					el("span.ss-slot-row__level", { text: `Level ${level}` }),
					pips(total, used, (pip, isUsed) => {
						const next = isUsed && pip === used - 1 ? pip : pip + 1;
						session.update((c) => ({
							...c,
							spellSlotsUsed: { ...(c.spellSlotsUsed ?? {}), [String(level)]: next },
						}));
						onRerender?.();
					}),
					el("span.ss-slot-row__count", { text: `${total - used} left` }),
				]);
			}),

			sc.pact && el("div.ss-slot-row", {}, [
				el("span.ss-slot-row__level", { text: `Pact · L${sc.pact.level}` }),
				pips(sc.pact.count, sc.pact.used, (pip, isUsed) => {
					const next = isUsed && pip === sc.pact.used - 1 ? pip : pip + 1;
					session.update({ pactSlotsUsed: next });
					onRerender?.();
				}, ".slot-pip--pact"),
				el("span.ss-slot-row__count", { text: `${sc.pact.count - sc.pact.used} left` }),
			]),
		].filter(Boolean)),

		el("div.btn-row.no-print", {}, [
			el("button.btn.btn--rest", {
				type: "button", text: "Short rest",
				title: sc.pact
					? "Pact Magic slots and short-rest features return"
					: "Short-rest features return",
				onclick: () => {
					session.update((c) => afterShortRest(c));
					toast("Short rest taken.");
					onRerender?.();
				},
			}),
			el("button.btn.btn--rest.btn--rest-long", {
				type: "button", text: "Long rest",
				title: "All slots, all features, and hit points",
				onclick: () => {
					session.update((c) => afterLongRest(c));
					toast("Long rest taken.");
					onRerender?.();
				},
			}),
		]),
	].filter(Boolean));
}

/**
 * Spells the character has for free, laid out like the rest of the list.
 *
 * These are not class spells -- a High Elf's Misty Step belongs to the lineage,
 * not to the Wizard list -- so they get their own block rather than being mixed
 * into a class's prepared spells. But they are shown in the same table, grouped
 * by level, because at the table what matters is "what can I cast", and a chip
 * row off to one side does not answer that.
 *
 * Each row names its origin and links to it.
 */
function grantedPanel(char) {
	const granted = rules.grantedSpells(char);
	const available = granted.filter((g) => g.available);
	const later = granted.filter((g) => !g.available);
	if (!granted.length) return null;

	const spells = db.spells ?? [];
	// Keep the origin alongside the spell record so the row can show both.
	const resolved = available
		.map((g) => ({ granted: g, spell: spells.find((sp) => sp.id === g.id) }))
		.filter((x) => x.spell);

	// Anything we could not resolve still gets named, so nothing vanishes.
	const unresolved = available.filter((g) => !spells.some((sp) => sp.id === g.id));

	const byLevel = new Map();
	for (const row of resolved) {
		const lvl = row.spell.level;
		if (!byLevel.has(lvl)) byLevel.set(lvl, []);
		byLevel.get(lvl).push(row);
	}

	return el("section.ss-list.ss-granted", {}, [
		el("h3.ss-section__title", { text: "Granted spells" }),
		el("p.muted", {
			text: "Always available, and they do not count against your prepared limit. "
				+ "S species · B background · F feat · D domain, oath or circle.",
		}),

		...[...byLevel.entries()].sort((a, b) => a[0] - b[0]).map(([level, rows]) =>
			grantedTable(level === 0 ? "Cantrips" : `Level ${level}`, rows),
		),

		unresolved.length > 0 && el("p.muted", {
			text: `Also granted: ${unresolved.map((g) => `${g.name} (${g.source})`).join(", ")}.`,
		}),

		later.length > 0 && el("p.muted", {
			text: `Unlocks later: ${later.map((g) => `${g.name} at level ${g.unlockLevel} (${g.source})`).join(", ")}.`,
		}),
	].filter(Boolean));
}

/** One letter for the origin: species, background, feat, class or subclass. */
function grantBadge(ref) {
	const tag = String(ref).split("|")[0];
	if (tag === "race") return "S";
	if (tag === "feat") return "F";
	if (tag === "background") return "B";
	if (tag === "class") return "C";
	return "D";
}

/** A granted-spell table: same columns as the class lists, plus the origin. */
function grantedTable(title, rows) {
	return el("div.ss-level", {}, [
		el("div.ss-level__head", {}, [
			el("span.ss-level__title", { text: title }),
		]),
		el("table.ss-table", {}, [
			el("thead", {}, el("tr", {}, [
				el("th", { text: "Spell" }),
				el("th", { text: "From" }),
				el("th", { text: "Time" }),
				el("th", { text: "Range" }),
				el("th", { text: "Comp" }),
				el("th", { text: "Duration" }),
			])),
			el("tbody", {}, rows
				.sort((a, b) => a.spell.name.localeCompare(b.spell.name))
				.map(({ granted, spell }) => el("tr", {}, [
					el("td", {}, [
						el("button.spell-link", {
							type: "button", text: spell.name,
							onclick: () => showSpell(spell),
						}),
						spell.concentration && el("span.ss-tag", { text: "C", title: "Concentration" }),
						spell.ritual && el("span.ss-tag", { text: "R", title: "Ritual" }),
					].filter(Boolean)),
					el("td", {}, [
						granted.ref
							? el("button.granted-spell__badge", {
								type: "button",
								text: grantBadge(granted.ref),
								title: `From ${granted.source} — click to read`,
								onclick: () => showReference(granted.ref),
							})
							: null,
						el("span.ss-from", {
							// Keep the terms: "1/day each" is not the same as prepared.
							text: [
								granted.source,
								granted.kind && granted.kind !== "prepared" ? granted.kind : null,
								granted.note ?? null,
							].filter(Boolean).join(" · "),
						}),
					].filter(Boolean)),
					el("td", { text: timeLabel(spell.time) }),
					el("td", { text: rangeLabel(spell.range) }),
					el("td", { text: componentLabel(spell.components) }),
					el("td", { text: durationLabel(spell.duration) }),
				]))),
		]),
	]);
}

/**
 * One class's spells, grouped by level.
 *
 * Prepared spells can be toggled here, not just in the creator: swapping which
 * spells are prepared is a thing you do on a Long Rest at the table, and this is
 * the page that is open when it happens.
 */
function classSpellList(session, char, caster, sc, onRerender) {
	const chosen = rules.classSpells(char, caster.classId);
	const spells = db.spells ?? [];
	const resolve = (ids) => ids
		.map((id) => spells.find((sp) => sp.id === id))
		.filter(Boolean);

	const cantrips = resolve(chosen.cantrips);
	const preparedIds = new Set(chosen.prepared);
	// A Wizard's book holds more than it prepares, so show both states.
	const pool = caster.spellbookLimit != null
		? resolve(chosen.known)
		: resolve(chosen.prepared);

	if (!cantrips.length && !pool.length) {
		return el("section.ss-list", {}, [
			el("h3.ss-section__title", { text: `${caster.className} spells` }),
			notice(`No ${caster.className} spells chosen yet. Use "Choose spells" above.`, "warn"),
		]);
	}

	const byLevel = new Map();
	for (const sp of pool) {
		if (!byLevel.has(sp.level)) byLevel.set(sp.level, []);
		byLevel.get(sp.level).push(sp);
	}

	const limit = caster.preparedLimit ?? caster.spellsKnownLimit;

	const togglePrepared = (id) => {
		const current = rules.classSpells(char, caster.classId).prepared ?? [];
		const has = current.includes(id);
		if (!has && limit != null && current.length >= limit) {
			toast(`Only ${limit} can be prepared. Unprepare one first.`);
			return;
		}
		const next = has ? current.filter((x) => x !== id) : [...current, id];
		session.update((c) => ({
			...c,
			spellsByClass: {
				...(c.spellsByClass ?? {}),
				[caster.classId]: { ...(c.spellsByClass?.[caster.classId] ?? {}), prepared: next },
			},
		}));
		onRerender?.();
	};

	return el("section.ss-list", {}, [
		el("h3.ss-section__title", { text: `${caster.className} spells` }),
		caster.spellbookLimit != null
			? el("p.muted", { text: "Tick to prepare from your spellbook. Swap on a Long Rest." })
			: el("p.muted.no-print", {
				text: "These are your prepared spells. To swap them, use Choose spells above.",
			}),

		cantrips.length > 0 && spellTable("Cantrips", cantrips.sort(byName), {
			// Cantrips are always on, so there is nothing to prepare.
			showPrepared: false,
		}),

		// The prepared checkbox is only meaningful for a caster with a spellbook,
		// where the list shown is the book and preparing picks from it. For every
		// other class the spells listed ARE the prepared ones, so a checkbox would
		// just delete the row -- swapping those is a Build-mode decision.
		...[...byLevel.entries()].sort((a, b) => a[0] - b[0]).map(([level, list]) =>
			spellTable(`Level ${level}`, list.sort(byName), {
				showPrepared: caster.spellbookLimit != null,
				preparedIds,
				onToggle: togglePrepared,
				slotsAvailable: (sc.slots[level - 1] ?? 0) - (sc.slotsUsed[level - 1] ?? 0),
				slotsTotal: sc.slots[level - 1] ?? 0,
			}),
		),
	].filter(Boolean));
}

const byName = (a, b) => a.name.localeCompare(b.name);

/** A compact table of spells, one level per table. */
function spellTable(title, list, { showPrepared, preparedIds, onToggle, slotsAvailable, slotsTotal } = {}) {
	return el("div.ss-level", {}, [
		el("div.ss-level__head", {}, [
			el("span.ss-level__title", { text: title }),
			slotsTotal
				? el("span.ss-level__slots", { text: `${slotsAvailable}/${slotsTotal} slots` })
				: null,
		].filter(Boolean)),

		el("table.ss-table", {}, [
			el("thead", {}, el("tr", {}, [
				showPrepared ? el("th.ss-table__prep", { text: "Prep" }) : null,
				el("th", { text: "Spell" }),
				el("th", { text: "Time" }),
				el("th", { text: "Range" }),
				el("th", { text: "Comp" }),
				el("th", { text: "Duration" }),
			].filter(Boolean))),

			el("tbody", {}, list.map((sp) => {
				const isPrepared = preparedIds?.has(sp.id) ?? false;
				return el("tr", { class: showPrepared && !isPrepared ? "is-unprepared" : "" }, [
					showPrepared ? el("td.ss-table__prep", {}, [
						el("input", {
							type: "checkbox",
							checked: isPrepared,
							title: isPrepared ? "Prepared" : "In your book, not prepared",
							onchange: () => onToggle?.(sp.id),
						}),
					]) : null,
					el("td", {}, [
						el("button.spell-link", {
							type: "button", text: sp.name,
							onclick: () => showSpell(sp),
						}),
						sp.concentration && el("span.ss-tag", { text: "C", title: "Concentration" }),
						sp.ritual && el("span.ss-tag", { text: "R", title: "Ritual" }),
					].filter(Boolean)),
					el("td", { text: timeLabel(sp.time) }),
					el("td", { text: rangeLabel(sp.range) }),
					el("td", { text: componentLabel(sp.components) }),
					el("td", { text: durationLabel(sp.duration) }),
				].filter(Boolean));
			})),
		]),
	]);
}
