/**
 * sheet.js - the finished character sheet.
 *
 * Reads derived values from rules.js rather than storing them, so the sheet is
 * always consistent with the character record. The print stylesheet turns this
 * same markup into a paper sheet, which is the point: the table plays on paper.
 */

import { db, getSpecies, getClass, getBackground, getSubclass, getItem } from "./data.js";
import { el, section, modal, rulesHtml, notice, toast, propertyChips, infoButton, itemLink, refLink } from "./ui.js";
import { showSpell, showReference } from "./glossary.js";
import { isUnpackable, unpack, packSummary, sellDialog, groupChoiceDialog, customItemBuilder } from "./items.js";
import { describeEffects } from "./effects.js";
import { findCreature, statBlock, creatureSubtitle, showCreature, creatureRefLinks } from "./statblock.js";
import { restButtons, slotRecoveryFor, slotRecoveryDialog } from "./rest.js";
import * as rules from "./rules.js";

const fmt = rules.formatMod;

export function renderSheet(session, { onEdit, onLevelUp, onEditStep, onRerender } = {}) {
	// Every block that came from a wizard step can jump back to it. The optional
	// second argument names the section to land on, so "Change Fighting Style"
	// arrives at the fighting styles rather than the top of the Class step.
	const jump = (stepId, anchorTitle) =>
		(onEditStep ? () => onEditStep(stepId, anchorTitle) : null);
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
				skillsBlock(session, char, d, jump("class"), onRerender),
			]),
			el("div.sheet__col", {}, [
				combatBlock(session, d, onRerender),
				resourcesBlock(session, char, d, onRerender),
				loadoutBlock(session, char, d, jump("equipment"), onRerender),
				attacksBlock(d, jump("equipment"), char),
				equipmentBlock(session, char, d, jump("equipment"), onRerender),
			].filter(Boolean)),
			el("div.sheet__col", {}, [
				d.spellcasting && spellBlock(session, char, d, jump("spells"), onRerender),
				creatureBlock(char, jump("companions")),
				featuresBlock(char, d, { jump }),
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
				el("span.line-list__value.rr-dice", {
					dataset: { dice: `1d20 ${fmt(s.value)}`, diceLabel: `${s.name} save` },
					text: fmt(s.value),
				}),
			]),
		)),
	);
}

/**
 * The skills box.
 *
 * Two things live behind the header here: assigning the Expertise a feature
 * granted, and setting a proficiency by hand when the table has ruled something
 * the builder cannot know about. Both are edits to the same list, so both are
 * reached from the same place.
 */
function skillsBlock(session, char, d, onEdit, onRerender) {
	const pendingExpertise = d.expertiseGrants
		.filter((g) => g.picked.length < g.count)
		.reduce((n, g) => n + (g.count - g.picked.length), 0);

	return sheetBox("Skills",
		el("div", {}, [
			el("ul.line-list", {}, d.skills.map((s) =>
				el("li.line-list__row", {}, [
					el("span.line-list__marker", {
						class: s.expertise ? "is-expert" : s.proficient ? "is-on" : "",
						text: s.expertise ? "◉" : s.proficient ? "●" : "○",
					}),
					el("span.line-list__label", {}, [
						refLink(s.name, `skill|${s.name}|`),
						// A number that does not match the build gets a mark, so it is
						// never a mystery later.
						s.overridden && el("span.skill-override-mark", {
							text: "*",
							title: `Set by hand; the build says ${s.buildState}`,
						}),
					].filter(Boolean)),
					el("span.line-list__ability", { text: s.ability.toUpperCase() }),
					el("span.line-list__value.rr-dice", {
						dataset: { dice: `1d20 ${fmt(s.value)}`, diceLabel: s.name },
						text: fmt(s.value),
					}),
				]),
			)),

			// Expertise still to assign is the thing most easily forgotten.
			pendingExpertise > 0 && notice(
				`${pendingExpertise} Expertise still to assign.`,
				"warn",
			),

			el("div.btn-row.no-print", {}, [
				d.expertiseGrants.length > 0 && el("button.btn.btn--small", {
					type: "button",
					text: pendingExpertise > 0 ? `Assign Expertise (${pendingExpertise})` : "Expertise",
					onclick: () => expertiseDialog(session, onRerender),
				}),
				el("button.btn.btn--small", {
					type: "button",
					text: "Edit by hand",
					title: "Set a proficiency the builder does not know about",
					onclick: () => skillOverrideDialog(session, onRerender),
				}),
			].filter(Boolean)),
		].filter(Boolean)),
		onEdit,
	);
}

/**
 * Assigning the Expertise that features grant.
 *
 * Each grant is shown separately, because they are separate: a Rogue's level 1
 * pair and level 6 pair are different decisions made at different times, and
 * merging them into "four skills" would lose that.
 */
function expertiseDialog(session, onRerender) {
	const body = el("div.expertise-dialog");

	const build = () => {
		const char = session.character;
		const grants = rules.expertiseGrants(char);

		body.replaceChildren(...(grants.length
			? grants.map((g) => {
				const taken = new Set(
					// Expertise already spent by the OTHER grants, so the same skill
					// cannot be doubled up.
					grants.filter((o) => o.key !== g.key).flatMap((o) => o.picked),
				);

				return section(
					`${g.feature} — ${g.origin} ${g.level}`,
					`Choose ${g.count}${g.picked.length ? `; ${g.picked.length} chosen` : ""}.`,
					[
						g.options.length
							? choiceList({
								options: g.options.map((s) => ({
									id: s.id,
									label: s.name,
									hint: taken.has(s.id) ? "Expertise already" : s.ability.toUpperCase(),
								})),
								selected: g.picked,
								max: g.count,
								disabledIds: new Set([...taken].filter((id) => !g.picked.includes(id))),
								onChange: (ids) => {
									session.update((c) => ({
										...c,
										expertiseChoices: { ...(c.expertiseChoices ?? {}), [g.key]: ids },
									}));
									build();
									onRerender?.();
								},
								onInfo: (opt) => showReference(`skill|${opt.label}|`),
							})
							: notice(
								"This grant needs skills you are proficient in, and you have none that qualify yet.",
								"warn",
							),

						// Listed skills the character has not got: worth saying, since
						// the fix is to become proficient rather than to look harder.
						g.ineligible.length > 0 && el("p.muted", {
							text: `Also on this feature's list, but you lack proficiency: ${g.ineligible.map((s) => s.name).join(", ")}.`,
						}),
					].filter(Boolean),
				);
			})
			: [el("p.muted", { text: "No feature grants Expertise yet." })]));
	};

	build();
	modal("Expertise", body);
}

/**
 * Setting skills by hand.
 *
 * The builder's answer is always shown beside the override, and one button puts
 * everything back, so going off-book never means losing track of what the rules
 * would have said.
 */
function skillOverrideDialog(session, onRerender) {
	const body = el("div.skill-override");
	const ORDER = ["none", "proficient", "expert"];
	const LABEL = { none: "—", proficient: "proficient", expert: "expertise" };

	const build = () => {
		const char = session.character;
		const buildState = rules.skillsFromBuild(char);
		const overrides = char.skillOverrides ?? {};
		const changed = rules.skillOverrideList(char);

		body.replaceChildren(...[
			el("p.muted", {
				text: "Click a skill to cycle it. The builder's own answer is shown on the right; anything you change is marked and can be put back.",
			}),

			el("div.skill-override__list", {}, rules.skills(char).map((s) => {
				const current = overrides[s.id] ?? buildState[s.id];
				const isOverride = Boolean(overrides[s.id]) && overrides[s.id] !== buildState[s.id];
				return el("div.skill-override__row", {}, [
					el("button.skill-override__cycle", {
						type: "button",
						class: isOverride ? "is-override" : "",
						text: `${s.name}: ${LABEL[current]}`,
						title: isOverride
							? `Set by hand. The build says ${LABEL[buildState[s.id]]}.`
							: "Follows the build",
						onclick: () => {
							const next = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length];
							session.update((c) => {
								const o = { ...(c.skillOverrides ?? {}) };
								// Landing back on what the build says means there is no
								// override any more, so the entry is dropped entirely.
								if (next === buildState[s.id]) delete o[s.id];
								else o[s.id] = next;
								return { ...c, skillOverrides: o };
							});
							build();
							onRerender?.();
						},
					}),
					el("span.skill-override__build", {
						class: isOverride ? "is-differs" : "",
						text: `build: ${LABEL[buildState[s.id]]}`,
					}),
				]);
			})),

			changed.length > 0
				? el("div.skill-override__summary", {}, [
					el("h4", { text: `${changed.length} set by hand` }),
					el("ul", {}, changed.map((c) =>
						el("li", { text: `${c.name}: ${LABEL[c.now]} (build says ${LABEL[c.was]})` }))),
					el("button.btn.btn--danger", {
						type: "button",
						text: "Put them all back",
						onclick: () => {
							session.update((c) => ({ ...c, skillOverrides: {} }));
							build();
							onRerender?.();
							toast("Skills back to what the builder worked out.");
						},
					}),
				])
				: el("p.muted", { text: "Nothing overridden; every skill follows the build." }),
		].filter(Boolean));
	};

	build();
	modal("Skills by hand", body);
}

/**
 * Hit points, as they are actually used at the table.
 *
 * One current-over-max readout, and a single adjuster: type the number you took
 * or healed, then hit minus or plus. That beats a row of fixed steppers, because
 * damage is never conveniently 1 or 5.
 *
 * Damage comes off temporary hit points first, which is the rule most often got
 * wrong on paper, so the buttons do it for you. Only the current total and the
 * hand-entered bonus are stored; the maximum is derived, so levelling up widens
 * the bar on its own.
 */
function hpBlock(session, char, d, onRerender) {
	const max = d.hp.max;
	const current = char.hp?.current ?? max;
	const temp = char.hp?.temp ?? 0;
	const step = Math.max(1, Number(char.hp?.adjustBy ?? 1));
	/** The live step, for handlers that fire long after this block was drawn. */
	const currentStep = () => Math.max(1, Number(session.character.hp?.adjustBy ?? 1));

	/** Positive heals, negative damages. Temporary hit points soak damage first. */
	const shift = (delta) => {
		session.update((c) => {
			const cMax = rules.hitPoints(c).max;
			const cur = c.hp?.current ?? cMax;
			const tmp = c.hp?.temp ?? 0;

			if (delta >= 0) {
				return { ...c, hp: { ...(c.hp ?? {}), current: Math.min(cMax, cur + delta) } };
			}
			const incoming = -delta;
			const fromTemp = Math.min(tmp, incoming);
			return {
				...c,
				hp: {
					...(c.hp ?? {}),
					temp: tmp - fromTemp,
					// Below zero is kept rather than clamped: how far under you went
					// decides massive damage and death saves.
					current: cur - (incoming - fromTemp),
				},
			};
		});
		onRerender?.();
	};

	const pool = d.hitDicePool;
	const diceLeft = pool.reduce((n, h) => n + h.available, 0);
	const diceTotal = pool.reduce((n, h) => n + h.total, 0);
	const tone = current <= 0 ? "is-down" : current <= max / 2 ? "is-hurt" : "";

	return el("div.hp-block", {}, [
		el("div.hp-readout", {}, [
			el("span.hp-readout__label", { text: "Hit Points" }),
			el("div.hp-readout__row", {}, [
				// Editable, because a ruling at the table beats any button.
				el("input.hp-readout__current", {
					type: "number",
					value: current,
					class: tone,
					title: "Current hit points",
					oninput: (e) => session.update((c) => ({
						...c, hp: { ...(c.hp ?? {}), current: Number(e.target.value) || 0 },
					})),
					onchange: () => onRerender?.(),
				}),
				el("span.hp-readout__slash", { text: "/" }),
				// The maximum is derived, so changing it means adding a bonus to it.
				el("button.hp-readout__max.no-print", {
					type: "button",
					text: max,
					title: "How this maximum is worked out, and how to add to it",
					onclick: () => hpMaxDialog(session, d, onRerender),
				}),
				// Printing needs the number without the button chrome.
				el("span.hp-readout__max-print", { text: max }),
			]),
		]),

		// -[ n ]+ : the amount in the middle, the direction either side. The amount
		// is read when the button is pressed rather than when the block is drawn,
		// because typing into the field deliberately does not redraw the sheet --
		// that would take the caret away mid-number.
		el("div.hp-adjust", {}, [
			el("button.hp-adjust__btn", {
				type: "button", text: "−", title: "Take this much damage",
				onclick: () => shift(-currentStep()),
			}),
			el("input.hp-adjust__amount", {
				type: "number", min: 1, value: step,
				title: "How much to add or take away",
				oninput: (e) => session.update((c) => ({
					...c,
					hp: { ...(c.hp ?? {}), adjustBy: Math.max(1, Math.floor(Number(e.target.value) || 1)) },
				})),
			}),
			el("button.hp-adjust__btn", {
				type: "button", text: "+", title: "Heal this much",
				onclick: () => shift(currentStep()),
			}),
		]),

		// A filled bar reads faster than the numbers alone.
		el("div.hp-bar", {}, [
			el("div.hp-bar__fill", {
				class: tone,
				style: `width: ${Math.max(0, Math.min(100, (current / Math.max(1, max)) * 100))}%`,
			}),
		]),

		el("div.hp-extra", {}, [
			el("label.hp-temp", {}, [
				el("span", { text: "Temp HP" }),
				el("input", {
					type: "number", min: 0, value: temp,
					title: "Temporary hit points are lost first and never stack",
					oninput: (e) => session.update((c) => ({
						...c, hp: { ...(c.hp ?? {}), temp: Math.max(0, Number(e.target.value) || 0) },
					})),
					onchange: () => onRerender?.(),
				}),
			]),

			el("div.hp-dice", {}, [
				el("span.hp-dice__label", { text: "Hit dice" }),
				el("span.hp-dice__value", {
					text: `${diceLeft} / ${diceTotal}`,
					class: diceLeft === 0 ? "is-spent" : "",
					title: "Spend these on a short rest",
				}),
				...pool.map((h) => el("span.hp-dice__group", {
					text: `${h.available}${h.die}`,
					class: h.available === 0 ? "is-spent" : "",
					title: `${h.available} of ${h.total} ${h.die} left`,
				})),
			]),
		]),

		// The rests sit with the hit points, since that is what they restore.
		restButtons(session, char, d, onRerender),
	]);
}

/**
 * Editing the maximum.
 *
 * The class total is derived and should stay that way, so this adds a bonus on
 * top rather than replacing it -- an Aid spell, a DM's reward, a homebrew boon.
 * Levelling up then still widens the total underneath.
 */
function hpMaxDialog(session, d, onRerender) {
	const char = session.character;
	const body = el("div.hp-max-dialog", {}, [
		el("ul.breakdown", {}, d.hp.breakdown.map((b) =>
			el("li", {}, [
				el("span", { text: b.label }),
				el("strong", { text: b.value >= 0 ? `+${b.value}` : b.value }),
			]),
		)),
		el("label.hp-max-dialog__field", {}, [
			el("span", { text: "Bonus maximum HP" }),
			el("input", {
				type: "number",
				value: Number(char.hp?.bonusMax ?? 0),
				title: "Added to the total above; negative values lower it",
				oninput: (e) => {
					session.update((c) => ({
						...c, hp: { ...(c.hp ?? {}), bonusMax: Math.floor(Number(e.target.value) || 0) },
					}));
					onRerender?.();
				},
			}),
		]),
		el("p.muted", {
			text: "Left at zero, the maximum is whatever your class, Constitution and traits add up to.",
		}),
	]);
	modal("Hit point maximum", body);
}

/**
 * Limited-use features, with a box per use.
 *
 * The boxes are the point. On paper you pencil a tick beside Second Wind and rub
 * it out after a rest; here the rest buttons do the rubbing out, and the label
 * says which rest refills each pool.
 */
function resourcesBlock(session, char, d, onRerender) {
	if (!d.featureResources.length) return null;

	const toggle = (key, index, used) => {
		// Clicking a filled box gives that use back; clicking an empty one spends
		// up to and including it, which is how a row of boxes is meant to behave.
		const next = index < used ? index : index + 1;
		session.update((c) => ({
			...c,
			resourcesUsed: { ...(c.resourcesUsed ?? {}), [key]: next },
		}));
		onRerender?.();
	};

	return sheetBox("Uses",
		el("div.resource-list", {}, d.featureResources.map((r) =>
			el("div.resource-row", {}, [
				el("div.resource-row__head", {}, [
					refLink(r.name, r.ref, { className: "resource-row__name" }),
					el("span.resource-row__recharge", {
						class: `is-${r.recharge}`,
						text: r.recharge === "short" ? "short rest" : "long rest",
						title: r.recharge === "short"
							? "Comes back on a short or long rest"
							: "Comes back on a long rest",
					}),
				]),
				el("div.resource-row__pips", {}, [
					...Array.from({ length: r.max }, (_, i) =>
						el("button.pip", {
							type: "button",
							class: i < r.used ? "is-used" : "",
							title: i < r.used ? `Give back use ${i + 1}` : `Spend use ${i + 1}`,
							onclick: () => toggle(r.key, i, r.used),
						}),
					),
					el("span.resource-row__count", {
						text: `${r.available} of ${r.max}`,
						class: r.available === 0 ? "is-spent" : "",
					}),
					// Some features do something specific when spent -- Arcane
					// Recovery hands back spell slots you choose -- so those get a
					// button rather than just a box to tick.
					slotRecoveryFor(char, r.name) && r.available > 0 && el("button.link-btn.no-print", {
						type: "button", text: "use",
						title: slotRecoveryFor(char, r.name).blurb,
						onclick: () => slotRecoveryDialog(session, r, onRerender),
					}),
				].filter(Boolean)),
			]),
		)),
	);
}

function combatBlock(session, d, onRerender) {
	const char = session.character;
	return sheetBox("Combat",
		el("div", {}, [
			el("div.combat-grid", {}, [
				bigStat("Armour Class", d.ac.total, d.ac.source),
				bigStat("Initiative", fmt(d.initiative), null, {
					dice: `1d20 ${fmt(d.initiative)}`, diceLabel: "Initiative",
				}),
				bigStat("Speed", `${d.speed} ft`),
				bigStat("Passive Perception", d.passivePerception),
				d.darkvision ? bigStat("Darkvision", `${d.darkvision} ft`) : null,
			].filter(Boolean)),

			hpBlock(session, char, d, onRerender),
		]),
	);
}

/**
 * What you are wearing and holding, changeable mid-session.
 *
 * This is the control that Play mode was missing. Donning armour, raising a
 * shield, drawing a weapon and switching grip all change derived numbers -- AC,
 * damage dice, and which fighting styles apply -- so they belong on the page you
 * have open during a fight rather than back in the build wizard.
 *
 * Everything here re-derives immediately: change a grip and the attack table's
 * damage die and Dueling both update.
 */
function loadoutBlock(session, char, d, onEdit, onRerender) {
	const carried = (char.equipment ?? [])
		.map((entry, index) => ({ entry, index, item: getItem(entry.itemId) }))
		.filter(({ item }) => item);

	const armour = carried.filter(({ item }) => item.armor && item.ac);
	const shields = carried.filter(({ item }) => item.type === "S");
	const weapons = carried.filter(({ item }) => item.weapon);

	if (!armour.length && !shields.length && !weapons.length) return null;

	const setEntry = (index, patch) => {
		session.update((c) => {
			const next = [...c.equipment];
			next[index] = { ...next[index], ...patch };
			return { ...c, equipment: next };
		});
		onRerender?.();
	};

	/** Only one suit of armour can be worn, so donning one doffs the rest. */
	const donArmour = (index, worn) => {
		session.update((c) => {
			const next = c.equipment.map((entry, i) => {
				const item = getItem(entry.itemId);
				if (item?.armor && item.ac) {
					return { ...entry, equipped: worn && i === index };
				}
				return entry;
			});
			return { ...c, equipment: next };
		});
		onRerender?.();
	};

	return sheetBox("Worn & held",
		el("div.loadout", {}, [
			armour.length > 0 && el("div.loadout__group", {}, [
				el("h5.loadout__label", { text: "Armour" }),
				...armour.map(({ entry, index, item }) =>
					loadoutRow({
						name: item.name,
						on: Boolean(entry.equipped),
						onLabel: "worn", offLabel: "off",
						onAction: `Don ${item.name}`, offAction: `Doff ${item.name}`,
						note: armourNote(item),
						onToggle: (next) => donArmour(index, next),
					}),
				),
			]),

			shields.length > 0 && el("div.loadout__group", {}, [
				el("h5.loadout__label", { text: "Shield" }),
				...shields.map(({ entry, index, item }) =>
					loadoutRow({
						name: item.name,
						on: Boolean(entry.equipped),
						onLabel: "held", offLabel: "stowed",
						onAction: `Raise ${item.name}`, offAction: `Stow ${item.name}`,
						note: entry.equipped
							? `+${item.ac ?? 2} AC · off hand occupied`
							: `+${item.ac ?? 2} AC when held`,
						onToggle: (next) => setEntry(index, { equipped: next }),
					}),
				),
			]),

			weapons.length > 0 && el("div.loadout__group", {}, [
				el("h5.loadout__label", { text: "Weapons" }),
				...weapons.map(({ entry, index, item }) =>
					weaponRow(session, char, { entry, index, item }, setEntry),
				),
			]),

			// Say plainly what the current loadout switches on or off.
			loadoutEffects(d),
		].filter(Boolean)),
		onEdit,
	);
}

/** "AC 16 · no DEX · stealth disadvantage" */
function armourNote(item) {
	const kind = { LA: "light", MA: "medium", HA: "heavy" }[item.type];
	const bits = [`AC ${item.ac}`];
	if (kind === "light") bits.push("+ full DEX");
	if (kind === "medium") bits.push("+ DEX max 2");
	if (kind === "heavy") bits.push("no DEX");
	if (item.stealthDisadvantage) bits.push("stealth disadvantage");
	if (item.strengthRequirement) bits.push(`needs STR ${item.strengthRequirement}`);
	return bits.join(" · ");
}

/**
 * A labelled on/off control with a note.
 *
 * The button shows the CURRENT state, not the action -- mixing the two reads as
 * "DOFF" on something already doffed. The tooltip names what pressing will do.
 */
function loadoutRow({ name, on, onLabel, offLabel, onAction, offAction, note, onToggle, extra }) {
	return el("div.loadout__row", { class: on ? "is-on" : "" }, [
		el("button.loadout__toggle", {
			type: "button",
			text: on ? onLabel : offLabel,
			title: on ? offAction : onAction,
			"aria-pressed": String(on),
			onclick: () => onToggle(!on),
		}),
		el("div.loadout__body", {}, [
			el("span.loadout__name", {}, [itemLink(name)]),
			note && el("span.loadout__note", { text: note }),
		].filter(Boolean)),
		extra,
	].filter(Boolean));
}

/** A weapon: drawn or stowed, plus grip when the weapon allows a choice. */
function weaponRow(session, char, { entry, index, item }, setEntry) {
	const props = (item.properties ?? []).map((p) => p.toLowerCase());
	const hasShield = rules.shieldInHand(char);
	const grip = rules.gripFor(entry, item, { hasShield });
	const versatile = props.includes("versatile");

	// A shield fills the off hand, so two-handed is off the table.
	const gripControl = versatile && entry.equipped
		? el("div.grip-toggle", {}, [
			...["one-handed", "two-handed"].map((option) => {
				const blocked = hasShield && option === "two-handed";
				return el("button.grip-toggle__btn", {
					type: "button",
					class: [grip === option ? "is-active" : "", blocked ? "is-blocked" : ""].filter(Boolean).join(" "),
					disabled: blocked,
					text: option === "one-handed" ? `1H ${item.damage}` : `2H ${item.versatileDamage}`,
					title: blocked
						? "Not while a shield is in your off hand"
						: option === "one-handed"
							? "One hand: leaves a hand free, and enables Dueling"
							: "Two hands: bigger die, and enables Great Weapon Fighting",
					onclick: () => setEntry(index, { grip: option }),
				});
			}),
		])
		: null;

	const note = [
		item.damage
			? `${grip === "two-handed" && item.versatileDamage ? item.versatileDamage : item.damage} ${item.damageType ?? ""}`.trim()
			: null,
		rules.attackReachLabel(item),
		entry.equipped && props.includes("two-handed") && hasShield
			? "cannot be used with a shield"
			: null,
	].filter(Boolean).join(" · ");

	return loadoutRow({
		name: item.name,
		on: Boolean(entry.equipped),
		onLabel: "drawn", offLabel: "stowed",
		onAction: `Draw ${item.name}`, offAction: `Stow ${item.name}`,
		note,
		onToggle: (next) => setEntry(index, { equipped: next }),
		extra: gripControl,
	});
}

/**
 * What the current loadout turns on, and what it is holding back.
 *
 * Pulled from the same conditional evaluation the attack table uses, so this can
 * never disagree with it.
 */
function loadoutEffects(d) {
	const active = new Map();
	const blocked = new Map();

	for (const attack of d.attacks) {
		for (const e of attack.activeEffects) {
			active.set(e.name, `${e.name} on ${attack.name}`);
		}
		for (const e of attack.inactiveEffects) {
			if (!active.has(e.name)) blocked.set(e.name, `${e.name}: ${e.why}`);
		}
	}
	// A feature active on any weapon is not "blocked".
	for (const name of active.keys()) blocked.delete(name);

	if (!active.size && !blocked.size) return null;

	return el("div.loadout__effects", {}, [
		...[...active.values()].map((text) =>
			el("p.loadout__effect.is-on", { text })),
		...[...blocked.values()].map((text) =>
			el("p.loadout__effect.is-off", { text })),
	]);
}

function attacksBlock(d, onEdit, char) {
	if (!d.attacks.length) {
		return sheetBox("Attacks", el("p.muted", { text: "Draw a weapon to see attacks here." }), onEdit);
	}

	return sheetBox("Attacks",
		el("div", {}, [
			el("table.sheet-table.attack-table", {}, [
				el("thead", {}, el("tr", {}, [
					el("th", { text: "Weapon" }),
					el("th", { text: "Atk" }),
					el("th", { text: "Damage" }),
					el("th", { text: "Range" }),
				])),

				// Each attack is two rows: the numbers, then its properties across
				// the full width. Four chips in a narrow fifth column wrapped one
				// per line and made every row three times taller than it needed.
				el("tbody", {}, d.attacks.flatMap((a) => [
					el("tr.attack-row", {}, [
						el("td", {}, [
							itemLink(a.name),
							// Grip matters for Dueling and Great Weapon Fighting.
							el("span.attack-grip", { text: a.grip === "two-handed" ? "two-handed" : "one-handed" }),
						]),
						el("td.attack-num", {}, [
							el("span.rr-dice", {
								dataset: { dice: `1d20 ${fmt(a.attackBonus)}`, diceLabel: `${a.name} attack` },
								text: fmt(a.attackBonus),
							}),
						]),
						el("td", {}, [
							el("span.rr-dice", {
								dataset: { dice: a.damage, diceLabel: `${a.name} damage` },
								text: `${a.damage} ${a.damageType}`.trim(),
							}),
							a.bonusDamage > 0 && el("span.attack-bonus", { text: `incl. ${fmt(a.bonusDamage)}` }),
						].filter(Boolean)),
						el("td", {}, [
							el("span.attack-range", { text: a.reach.label, title: a.reach.detail }),
						]),
					]),

					// The notes row: properties, masteries, and what is or is not firing.
					el("tr.attack-notes-row", {}, [
						el("td", { colspan: "4" }, [
							propertyChips(a.properties, a.mastery, char.edition),
							a.shieldConflict && el("span.attack-effect.is-conflict", {
								text: "Two-Handed: cannot be used while holding a shield",
							}),
							...a.activeEffects.map((e) =>
								el("span.attack-effect.is-on", { text: `${e.name}: ${e.detail}` }),
							),
						].filter(Boolean)),
					]),
				])),
			]),

			// Anything that could apply but does not, with the reason.
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

function equipmentBlock(session, char, d, onEdit, onRerender) {
	const coins = (db.rules?.currencies ?? [])
		.map((c) => ({ ...c, amount: char.currency?.[c.id] ?? 0 }))
		.filter((c) => c.amount > 0);

	return sheetBox("Equipment",
		el("div", {}, [
			el("ul.item-list", {}, (char.equipment ?? []).map((e, i) =>
				el("li.item-list__row", {}, [
					// The name opens the item, exactly as a spell name does.
					el("span", {}, [
						itemLink(e.name),
						e.quantity > 1 && el("span.item-list__qty", { text: `×${e.quantity}` }),
					].filter(Boolean)),
					e.equipped && el("span.chip.chip--small", { text: "worn" }),
					// Unpacking, choosing and selling all happen mid-session, so they
					// belong on the sheet and not only in the build wizard.
					el("span.item-list__acts.no-print", {}, [
						isUnpackable(e) && el("button.link-btn", {
							type: "button", text: "unpack",
							title: `Replace with its contents: ${packSummary(e)}`,
							onclick: () => {
								session.update((c) => unpack(c, i));
								toast(`${e.name} unpacked.`);
								onRerender?.();
							},
						}),
						getItem(e.itemId)?.isGroup && el("button.link-btn", {
							type: "button", text: "choose",
							onclick: () => groupChoiceDialog(session, i, onRerender),
						}),
						el("button.link-btn", {
							type: "button", text: "sell",
							onclick: () => sellDialog(session, i, onRerender),
						}),
					].filter(Boolean)),
				].filter(Boolean)),
			)),
			!(char.equipment ?? []).length && el("p.muted", { text: "Nothing carried." }),
			el("p.sheet__note", {
				text: `${d.weight.toFixed(1)} lb carried · capacity ${d.carrying.capacity} lb`,
			}),
			coins.length > 0 && el("p.sheet__note", {
				text: coins.map((c) => `${c.amount} ${c.id}`).join(" · "),
			}),
			el("div.btn-row.no-print", {}, [
				el("button.btn.btn--small", {
					type: "button", text: "Add a custom item",
					title: "For something your DM has just handed you",
					onclick: () => customItemBuilder(session, { onDone: onRerender }),
				}),
			]),
		].filter(Boolean)),
		onEdit,
	);
}

/**
 * The spellbook, built for use at the table rather than for character creation.
 *
 * Slots are the shared pool across every casting class, so they are tracked once
 * and clicked to expend. Prepared lists stay per class, because that is how
 * multiclassing works: a Cleric 3 / Wizard 2 prepares from two separate lists
 * against two separate limits while drawing on the one pool of slots.
 */
function spellBlock(session, char, d, onEdit, onRerender) {
	const sc = d.spellcasting;
	if (!sc) return null;

	return sheetBox("Spellcasting",
		el("div", {}, [
			// Per-class numbers: each class has its own DC and prepared limit.
			...sc.classes.map((caster) => spellClassHeader(char, caster)),

			sc.slots.length > 0 && slotTracker(session, sc, onRerender),
			sc.pact && pactTracker(session, sc.pact, onRerender),

			(sc.slots.length > 0 || sc.pact) && el("div.btn-row.rest-row.no-print", {}, [
				sc.pact && el("button.btn", {
					type: "button", text: "Short rest",
					title: "Pact Magic slots return on a Short Rest",
					onclick: () => {
						session.update({ pactSlotsUsed: 0 });
						toast("Pact Magic slots restored");
						onRerender?.();
					},
				}),
				el("button.btn", {
					type: "button", text: "Long rest",
					title: "All spell slots return",
					onclick: () => {
						session.update({ spellSlotsUsed: {}, pactSlotsUsed: 0 });
						toast("All spell slots restored");
						onRerender?.();
					},
				}),
			].filter(Boolean)),

			// The lists themselves, grouped by spell level.
			...sc.classes.map((caster) => preparedList(char, caster)),
		].filter(Boolean)),
		onEdit,
	);
}

/** Save DC, attack bonus and the class's own prepared count. */
function spellClassHeader(char, caster) {
	const chosen = rules.classSpells(char, caster.classId);
	const limit = caster.preparedLimit ?? caster.spellsKnownLimit;
	const over = limit != null && chosen.prepared.length > limit;

	return el("div.spell-class", {}, [
		el("h5.spell-class__name", {
			text: caster.subclassName
				? `${caster.className} (${caster.subclassName}) ${caster.levels}`
				: `${caster.className} ${caster.levels}`,
		}),
		el("div.combat-grid", {}, [
			bigStat("Save DC", caster.saveDc),
			bigStat("Attack", fmt(caster.attackBonus)),
			bigStat("Ability", caster.ability.toUpperCase()),
			caster.cantripsKnown != null
				&& bigStat("Cantrips", `${chosen.cantrips.length}/${caster.cantripsKnown}`),
			// A Wizard's book is a separate, larger limit than its prepared count.
			caster.spellbookLimit != null
				&& bigStat("Spellbook", `${chosen.known.length}/${caster.spellbookLimit}`),
			limit != null && bigStat(caster.preparedLimit != null ? "Prepared" : "Known",
				`${chosen.prepared.length}/${limit}`),
		].filter(Boolean)),
		over && el("p.spell-class__warn", {
			text: `${chosen.prepared.length} prepared but the limit is ${limit}.`,
		}),
	].filter(Boolean));
}

/**
 * Clickable slot pips. Clicking an unused pip expends it, clicking a used one
 * gives it back -- which is what actually happens at a table mid-fight.
 */
function slotTracker(session, sc, onRerender) {
	return el("div.slot-track", {}, sc.slots.map((total, i) => {
		const level = i + 1;
		const used = sc.slotsUsed[i] ?? 0;

		return el("div.slot-track__row", {}, [
			el("span.slot-track__level", { text: `Level ${level}` }),
			el("div.slot-track__pips", {}, Array.from({ length: total }, (_, pip) => {
				const isUsed = pip < used;
				return el("button.slot-pip", {
					type: "button",
					class: isUsed ? "is-used" : "",
					title: isUsed ? `Restore a level ${level} slot` : `Expend a level ${level} slot`,
					"aria-label": `Level ${level} slot ${pip + 1} of ${total}${isUsed ? ", expended" : ""}`,
					onclick: () => {
						// Clicking pip N sets usage to N+1, or back to N if it was
						// already the last used one.
						const next = isUsed && pip === used - 1 ? pip : pip + 1;
						session.update((c) => ({
							...c,
							spellSlotsUsed: { ...(c.spellSlotsUsed ?? {}), [String(level)]: next },
						}));
						onRerender?.();
					},
				});
			})),
			el("span.slot-track__count", { text: `${total - used}/${total}` }),
		]);
	}));
}

/** Pact Magic is its own pool on a short-rest clock. */
function pactTracker(session, pact, onRerender) {
	return el("div.slot-track", {}, [
		el("div.slot-track__row", {}, [
			el("span.slot-track__level", { text: `Pact (L${pact.level})` }),
			el("div.slot-track__pips", {}, Array.from({ length: pact.count }, (_, pip) => {
				const isUsed = pip < pact.used;
				return el("button.slot-pip.slot-pip--pact", {
					type: "button",
					class: isUsed ? "is-used" : "",
					title: isUsed ? "Restore a Pact Magic slot" : "Expend a Pact Magic slot",
					onclick: () => {
						const next = isUsed && pip === pact.used - 1 ? pip : pip + 1;
						session.update({ pactSlotsUsed: next });
						onRerender?.();
					},
				});
			})),
			el("span.slot-track__count", { text: `${pact.count - pact.used}/${pact.count}` }),
		]),
	]);
}

/** One class's cantrips and prepared spells, grouped by level. */
function preparedList(char, caster) {
	const chosen = rules.classSpells(char, caster.classId);
	if (!chosen.cantrips.length && !chosen.prepared.length) return null;

	const resolve = (ids) => ids
		.map((id) => (db.spells ?? []).find((sp) => sp.id === id) ?? { id, name: id.split("--")[0].replace(/-/g, " "), level: 0 })
		.sort((a, b) => a.name.localeCompare(b.name));

	const byLevel = new Map();
	for (const sp of resolve(chosen.prepared)) {
		if (!byLevel.has(sp.level)) byLevel.set(sp.level, []);
		byLevel.get(sp.level).push(sp);
	}

	const preparedIds = new Set(chosen.prepared);
	const unprepared = resolve(chosen.known.filter((id) => !preparedIds.has(id)));

	return el("div.spell-book", {}, [
		el("h5.spell-book__title", { text: `${caster.className} spells` }),

		chosen.cantrips.length > 0 && el("div.spell-book__group", {}, [
			el("span.spell-book__label", { text: "Cantrips" }),
			el("div.spell-book__names", {}, resolve(chosen.cantrips).map(spellLink)),
		]),

		...[...byLevel.entries()].sort((a, b) => a[0] - b[0]).map(([level, list]) =>
			el("div.spell-book__group", {}, [
				el("span.spell-book__label", { text: `Level ${level}` }),
				el("div.spell-book__names", {}, list.map(spellLink)),
			]),
		),

		// Known but not prepared: in the book, unavailable until the next rest.
		unprepared.length > 0 && el("div.spell-book__group.is-unprepared", {}, [
			el("span.spell-book__label", { text: "In book" }),
			el("div.spell-book__names", {}, unprepared.map(spellLink)),
		]),
	].filter(Boolean));
}

/** A spell name that opens its full description. */
const spellLink = (sp) =>
	el("button.spell-link", {
		type: "button",
		text: sp.name,
		title: `Read ${sp.name}`,
		onclick: () => showSpell(sp.id ?? sp.name),
	});

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

/**
 * Features in the order they were acquired.
 *
 * Grouped by the level they arrive at, because that is how a player reads a
 * sheet: "what did I get at 3rd?" Each row links to its own rules text, to the
 * feature that granted it, and back to the step where it can be changed.
 */
function featuresBlock(char, d, { jump }) {
	const timeline = rules.characterTimeline(char);
	if (!timeline.length) return null;

	const byLevel = new Map();
	for (const row of timeline) {
		if (!byLevel.has(row.level)) byLevel.set(row.level, []);
		byLevel.get(row.level).push(row);
	}

	return sheetBox("Features & traits",
		el("div.timeline", {}, [...byLevel.entries()]
			.sort((a, b) => a[0] - b[0])
			.map(([level, rows]) => el("div.timeline__group", {}, [
				el("div.timeline__level", {
					text: level === 1 ? "Level 1 & origin" : `Level ${level}`,
				}),
				el("div.timeline__rows", {}, rows.map((row) => timelineRow(row, jump))),
			]))),
	);
}

/** One acquired feature, trait or choice. */
function timelineRow(row, jump) {
	// A choice ("Fighting Style: Dueling") gets two links: the pick itself, and
	// the feature that granted it.
	if (row.kind === "choice") {
		const missing = row.picks.length < (row.expected ?? 1);
		return el("div.timeline__row", { class: missing ? "is-missing" : "" }, [
			el("div.timeline__head", {}, [
				el("span.timeline__name", { text: row.originFeature }),
				el("span.timeline__origin", { text: row.origin }),
			]),
			el("div.timeline__picks", {},
				row.picks.length
					? row.picks.map((pick) => el("span.timeline__pick", {}, [
						el("span.timeline__pick-name", { text: pick.name }),
						pick.ref && infoButton(() => showReference(pick.ref), pick.name),
					].filter(Boolean)))
					: [el("span.timeline__warn", { text: `Nothing chosen (${row.expected} to pick)` })],
			),
			jump && el("button.timeline__edit.no-print", {
				type: "button", text: "Change",
				title: `Change ${row.originFeature}`,
				onclick: jump(row.step, row.anchor ?? row.originFeature),
			}),
		].filter(Boolean));
	}

	// Everything else is a disclosure with its full text. A feature that granted
	// a pick shows it right in the summary, so "Fighting Style: Dueling" reads as
	// one thing rather than two entries.
	const picks = row.picks ?? [];
	const missing = picks.length < (row.expected ?? 0);

	return el("details.timeline__row.feature-detail", { class: missing ? "is-missing" : "" }, [
		el("summary", {}, [
			el("span.feature-detail__name", {
				text: picks.length ? `${row.name}: ${picks.map((p) => p.name).join(", ")}` : row.name,
			}),
			el("span.feature-detail__source", { text: row.origin }),
		]),
		el("div.feature-detail__body", {}, [
			// The pick itself is a separate rules entry, so link it separately.
			// The pick's name, with a "?" beside it rather than a sentence link.
			picks.length > 0 && el("div.timeline__picks", {}, picks.map((pick) =>
				el("span.timeline__pick", {}, [
					el("span.timeline__pick-name", { text: pick.name }),
					pick.ref && infoButton(() => showReference(pick.ref), pick.name),
				].filter(Boolean)),
			)),
			missing && el("p.timeline__warn", {
				text: `${row.expected - picks.length} still to choose.`,
			}),
			rulesHtml(row.html),
			el("div.btn-row", {}, [
				row.originRef && el("button.link-btn.no-print", {
					type: "button", text: `About ${row.origin}`,
					onclick: () => showReference(row.originRef),
				}),
				jump && el("button.link-btn.no-print", {
					type: "button",
					text: picks.length || row.expected ? `Change ${row.name}` : "Change this",
					// Use the row's declared anchor; only fall back to the name
					// when the feature genuinely names its own section.
					onclick: jump(row.step, row.anchor ?? row.originFeature ?? null),
				}),
			].filter(Boolean)),
		].filter(Boolean)),
	]);
}

/**
 * Proficiencies, with as much of it clickable as the data supports.
 *
 * Tools and languages are real entries, so each one opens. Armour and weapon
 * *categories* ("light", "martial") have no entry of their own -- so the row
 * label links to the rule that governs them instead of pretending each word is
 * a lookup that will fail.
 */
function proficienciesBlock(d) {
	const p = d.proficiencies;

	const row = (label, values, { rule, refFor } = {}) => {
		if (!values?.length) return null;
		return el("div.prof-row", {}, [
			rule
				? refLink(label, rule, { title: `Read ${label} rules`, className: "prof-row__label" })
				: el("span.prof-row__label", { text: label }),
			el("span.prof-row__value", {}, refFor
				? values.flatMap((v, i) => [
					i > 0 ? el("span", { text: ", " }) : null,
					refLink(v, refFor(v), { title: `Read ${v}` }),
				].filter(Boolean))
				: [el("span", { text: values.join(", ") })]),
		]);
	};

	return sheetBox("Proficiencies",
		el("div", {}, [
			row("Armour", p.armor, { rule: "variantrule|Armor Training|XPHB" }),
			row("Weapons", p.weapons, { rule: "variantrule|Weapon|XPHB" }),
			// Tools are items, so each one opens its own entry.
			row("Tools", p.tools, {
				rule: "variantrule|Tool Proficiencies|XGE",
				refFor: (name) => `item|${name}|`,
			}),
			row("Languages", p.languages, { refFor: (name) => `language|${name}|` }),
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

const bigStat = (label, value, hint, rollable) =>
	el("div.big-stat", {}, [
		el("span.big-stat__label", { text: label }),
		// When a stat is a die roll, the number itself is the button.
		rollable
			? el("span.big-stat__value.rr-dice", { dataset: rollable, text: value })
			: el("span.big-stat__value", { text: value }),
		hint && el("span.big-stat__hint", { text: hint }),
	].filter(Boolean));

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
