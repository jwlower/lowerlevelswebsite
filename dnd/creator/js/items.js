/**
 * items.js - the three things you do to an item that are not "carry it".
 *
 *   unpack   Turn a Priest's Pack into the seven things inside it, because a
 *            pack is a shopping convenience, not a thing you use.
 *   sell     Turn an item into coin at whatever rate the table uses. Half price
 *            is the common ruling, so that is the default, but the rate is
 *            editable because every table does this differently.
 *   build    Make an item up. DMs hand out invented gear constantly, and until
 *            now there was nowhere to put it.
 *
 * A custom item is stored on the character and shaped exactly like a database
 * item, so once it exists the attack table, armour class, equipment list and
 * item popovers all treat it like anything out of the book. See
 * data.js setCustomItems for how that resolution works.
 */

import { db, getItem, getItemByRef, ensure } from "./data.js";
import { el, modal, field, section, notice, toast, closeAllModals, itemLink, debounce } from "./ui.js";
import * as rules from "./rules.js";

/* ------------------------------------------------------------------ *
 * Unpacking
 * ------------------------------------------------------------------ */

/** True when this inventory row is a pack with a known list of contents. */
export function isUnpackable(entry) {
	const item = getItem(entry?.itemId);
	return Boolean(item?.packContents?.length);
}

/**
 * Replace a pack with its contents.
 *
 * Quantities multiply: two Explorer's Packs unpack into twenty torches. Contents
 * that have no item of their own ("alms box", "vestments") come through as plain
 * named lines so nothing is silently dropped.
 */
export function unpack(char, index) {
	const entry = char.equipment?.[index];
	const item = getItem(entry?.itemId);
	if (!item?.packContents?.length) return char;

	const packs = Math.max(1, Number(entry.quantity ?? 1));
	const additions = [];

	for (const content of item.packContents) {
		const quantity = Math.max(1, Number(content.quantity ?? 1)) * packs;
		const inner = content.ref ? getItemByRef(content.ref, char.edition ?? "2024") : null;
		additions.push({
			itemId: inner?.id ?? null,
			name: inner?.name ?? content.name,
			quantity,
			equipped: false,
			// Worth knowing where a pile of torches came from.
			source: `unpacked:${item.name}`,
			// Nothing in the database backs this line, so the sheet shows the name.
			freeText: inner ? undefined : true,
		});
	}

	const next = [...char.equipment];
	next.splice(index, 1, ...additions);
	return { ...char, equipment: next };
}

/** A one-line summary for the button's tooltip. */
export function packSummary(entry) {
	const item = getItem(entry?.itemId);
	if (!item?.packContents?.length) return null;
	return item.packContents
		.map((c) => (c.quantity > 1 ? `${c.name} x${c.quantity}` : c.name))
		.join(", ");
}

/* ------------------------------------------------------------------ *
 * Selling
 * ------------------------------------------------------------------ */

/** What one of these is worth on the page, in gold. */
export const itemValueGp = (entry) => Number(getItem(entry?.itemId)?.costGp ?? 0);

/**
 * The sell dialog.
 *
 * Rate defaults to 50%, which is the usual ruling for selling used gear, and is
 * remembered on the character so a table that sells at 25% only says so once.
 * The proceeds are added to the purse in gold; anything below a whole gold piece
 * is kept as silver and copper rather than rounded away.
 */
export function sellDialog(session, index, onDone) {
	const char = session.character;
	const entry = char.equipment?.[index];
	if (!entry) return;

	const unit = itemValueGp(entry);
	const owned = Math.max(1, Number(entry.quantity ?? 1));
	let count = owned;
	let rate = Number(char.sellRate ?? 50);

	const body = el("div.sell-dialog");

	const build = () => {
		const grossGp = unit * count;
		const takeGp = (grossGp * rate) / 100;

		body.replaceChildren(...[
			el("p", {}, [
				el("strong", { text: entry.name }),
				el("span.muted", {
					text: unit
						? ` — listed at ${unit} gp each`
						: " — no listed price, so name your own figure",
				}),
			]),

			el("div.sell-dialog__grid", {}, [
				field("How many",
					el("input.sell-dialog__input", {
						type: "number", min: 1, max: owned, value: count,
						oninput: (e) => {
							count = Math.min(owned, Math.max(1, Number(e.target.value) || 1));
							build();
						},
					}),
					`You have ${owned}`),
				field("Rate",
					el("div.sell-dialog__rate", {}, [
						el("input.sell-dialog__input", {
							type: "number", min: 0, max: 1000, value: rate,
							oninput: (e) => {
								rate = Math.max(0, Number(e.target.value) || 0);
								build();
							},
						}),
						el("span", { text: "%" }),
					]),
					"Half price is the usual ruling"),
			]),

			// The common rates, one click away.
			el("div.btn-row.sell-dialog__presets", {}, [25, 50, 100].map((r) =>
				el("button.toggle-btn", {
					type: "button",
					class: rate === r ? "is-active" : "",
					text: `${r}%`,
					title: r === 100 ? "Full listed price" : `${r}% of listed price`,
					onclick: () => { rate = r; build(); },
				}),
			)),

			unit
				? el("p.sell-dialog__total", {}, [
					el("span", { text: "You receive " }),
					el("strong", { text: formatCoin(takeGp) }),
					el("span.muted", { text: ` (${count} x ${unit} gp at ${rate}%)` }),
				])
				: notice("This item has no listed price, so nothing is added automatically. Adjust your coin by hand after removing it.", "warn"),

			el("div.btn-row", {}, [
				el("button.btn.btn--primary", {
					type: "button",
					text: count === owned ? "Sell all of them" : `Sell ${count}`,
					onclick: () => {
						session.update((c) => applySale(c, index, count, takeGp));
						closeAllModals();
						toast(unit ? `Sold for ${formatCoin(takeGp)}.` : "Removed from your pack.");
						onDone?.();
					},
				}),
			]),
		].filter(Boolean));
	};

	build();
	modal(`Sell ${entry.name}`, body);
}

/**
 * Removes what was sold and adds the coin.
 *
 * Fractions of a gold piece become silver and copper rather than vanishing,
 * because selling five 1 gp items at 25% is 1 gp 2 sp 5 cp and a player will
 * notice the missing change.
 */
function applySale(char, index, count, takeGp) {
	const equipment = [...(char.equipment ?? [])];
	const entry = equipment[index];
	if (!entry) return char;

	const owned = Math.max(1, Number(entry.quantity ?? 1));
	if (count >= owned) equipment.splice(index, 1);
	else equipment[index] = { ...entry, quantity: owned - count };

	const purse = { ...(char.currency ?? {}) };
	const totalCp = Math.round(takeGp * 100);
	const gp = Math.floor(totalCp / 100);
	const sp = Math.floor((totalCp % 100) / 10);
	const cp = totalCp % 10;
	purse.gp = (Number(purse.gp) || 0) + gp;
	purse.sp = (Number(purse.sp) || 0) + sp;
	purse.cp = (Number(purse.cp) || 0) + cp;

	return { ...char, equipment, currency: purse, sellRate: char.sellRate };
}

/** "2 gp 5 sp", skipping the denominations that are zero. */
export function formatCoin(gpAmount) {
	const totalCp = Math.round(Number(gpAmount ?? 0) * 100);
	if (!totalCp) return "nothing";
	const parts = [];
	const gp = Math.floor(totalCp / 100);
	const sp = Math.floor((totalCp % 100) / 10);
	const cp = totalCp % 10;
	if (gp) parts.push(`${gp} gp`);
	if (sp) parts.push(`${sp} sp`);
	if (cp) parts.push(`${cp} cp`);
	return parts.join(" ");
}

/* ------------------------------------------------------------------ *
 * Group items ("a Holy Symbol")
 * ------------------------------------------------------------------ */

/**
 * Some kit lines name a category rather than an item: a Cleric starts with "a
 * Holy Symbol", which means an Amulet, an Emblem or a Reliquary. Those arrive as
 * group entries, and this swaps one for the specific thing chosen.
 */
export function groupChoiceDialog(session, index, onDone) {
	const char = session.character;
	const entry = char.equipment?.[index];
	const group = getItem(entry?.itemId);
	if (!group?.isGroup) return;

	modal(`Which ${group.name}?`, el("div", {}, [
		el("p.muted", { text: `A ${group.name} can be any of these. Pick the one you carry.` }),
		el("div.group-choice", {}, (group.members ?? []).map((m) => {
			const real = getItemByRef(m.ref, char.edition ?? "2024");
			return el("button.group-choice__btn", {
				type: "button",
				text: m.name,
				title: real ? `${real.costGp ?? "?"} gp, ${real.weight ?? "?"} lb` : m.name,
				onclick: () => {
					session.update((c) => {
						const next = [...c.equipment];
						next[index] = {
							...next[index],
							itemId: real?.id ?? next[index].itemId,
							name: real?.name ?? m.name,
						};
						return { ...c, equipment: next };
					});
					closeAllModals();
					onDone?.();
				},
			});
		})),
	]));
}

/* ------------------------------------------------------------------ *
 * Building an item
 * ------------------------------------------------------------------ */

const RARITIES = ["none", "common", "uncommon", "rare", "very rare", "legendary", "artifact"];

/** The kinds of thing a custom item can be, and what each kind needs asked. */
const KINDS = [
	{ id: "wonder", label: "Wondrous item", hint: "Rings, cloaks, trinkets — anything not held as a weapon or worn as armour." },
	{ id: "weapon", label: "Weapon", hint: "Rolls to hit and deals damage. Start from a real weapon to inherit its dice and properties." },
	{ id: "armor", label: "Armour", hint: "Sets your armour class while worn." },
	{ id: "shield", label: "Shield", hint: "Adds to your armour class while held." },
	{ id: "gear", label: "Gear", hint: "Ordinary kit: a tool, a container, something consumable." },
];

/**
 * The custom item builder.
 *
 * The important idea is the template: pick a real Longsword as the base and the
 * new item inherits its damage die, properties, mastery, weight and range, so a
 * "Sword of the Cranky Badger" behaves like a longsword without anyone typing
 * "1d8 slashing". Only what makes it special has to be filled in.
 */
export async function customItemBuilder(session, { editId = null, onDone } = {}) {
	// The base picker searches the full catalogue, which is loaded on demand.
	await ensure("items");

	const char = session.character;
	const existing = (char.customItems ?? []).find((i) => i.id === editId) ?? null;

	const draft = existing
		? { ...existing }
		: {
			id: `custom--${crypto.randomUUID()}`,
			custom: true,
			source: "Custom",
			edition: char.edition ?? "2024",
			kind: "wonder",
			name: "",
			rarity: "none",
			baseItemId: null,
			bonusWeapon: "",
			bonusAc: "",
			extraDamage: "",
			attunement: false,
			charges: null,
			weight: null,
			costGp: null,
			notes: "",
		};

	const body = el("div.item-builder");

	/** Copy the mechanical bones of a real item onto the draft. */
	const applyBase = (base) => {
		draft.baseItemId = base?.id ?? null;
		if (!base) {
			delete draft.weapon; delete draft.armor; delete draft.type;
			return;
		}
		draft.type = base.type;
		draft.weapon = base.weapon || undefined;
		draft.weaponCategory = base.weaponCategory;
		draft.damage = base.damage;
		draft.damageType = base.damageType;
		draft.versatileDamage = base.versatileDamage;
		draft.properties = base.properties ?? [];
		draft.mastery = base.mastery ?? [];
		draft.range = base.range;
		draft.armor = base.armor || undefined;
		draft.ac = base.ac;
		draft.strengthRequirement = base.strengthRequirement;
		draft.stealthDisadvantage = base.stealthDisadvantage;
		if (base.weight != null && draft.weight == null) draft.weight = base.weight;
		// The kind follows the base, since it is no longer a free choice.
		if (base.weapon) draft.kind = "weapon";
		else if (base.armor) draft.kind = "armor";
		else if (base.type === "S") draft.kind = "shield";
	};

	const baseResults = el("div.item-builder__results");

	const runSearch = (term) => {
		const q = String(term ?? "").trim().toLowerCase();
		if (q.length < 2) {
			baseResults.replaceChildren(el("p.muted", { text: "Type at least two letters." }));
			return;
		}
		const pool = [...(db.equipment ?? []), ...(db.magicItems ?? [])]
			.filter((i) => i.name.toLowerCase().includes(q))
			.filter((i) => (i.edition ?? draft.edition) === draft.edition || !i.edition)
			.slice(0, 24);

		baseResults.replaceChildren(
			pool.length
				? el("div.item-builder__hits", {}, pool.map((i) =>
					el("button.item-builder__hit", {
						type: "button",
						class: draft.baseItemId === i.id ? "is-active" : "",
						text: i.name,
						title: [i.typeName, i.damage ? `${i.damage} ${i.damageType ?? ""}`.trim() : null,
							i.ac ? `AC ${i.ac}` : null, i.weight ? `${i.weight} lb` : null]
							.filter(Boolean).join(" · "),
						onclick: () => { applyBase(i); build(); },
					}),
				))
				: el("p.muted", { text: "Nothing matched." }),
		);
	};

	const build = () => {
		const base = draft.baseItemId ? getItem(draft.baseItemId) : null;
		const kind = KINDS.find((k) => k.id === draft.kind) ?? KINDS[0];

		body.replaceChildren(...[
			/* --- what it is ------------------------------------------- */
			section("Name", null,
				el("input.item-builder__name", {
					type: "text",
					value: draft.name,
					placeholder: "Sword of the Cranky Badger",
					oninput: (e) => { draft.name = e.target.value; },
				}),
			),

			section("What kind of thing is it?", kind.hint,
				el("div.btn-row", {}, KINDS.map((k) =>
					el("button.toggle-btn", {
						type: "button",
						class: draft.kind === k.id ? "is-active" : "",
						text: k.label,
						onclick: () => { draft.kind = k.id; build(); },
					}),
				)),
			),

			/* --- the template ----------------------------------------- */
			section("Start from an existing item",
				"Optional, and the quickest route: the new item inherits its damage, properties, weight and range.",
				el("div", {}, [
					el("input.search-input", {
						type: "search",
						placeholder: "Longsword, Chain Mail, Shield…",
						oninput: debounce((e) => runSearch(e.target.value), 200),
					}),
					baseResults,
					base && el("p.item-builder__base", {}, [
						el("span", { text: "Based on " }),
						el("strong", { text: base.name }),
						el("span.muted", {
							text: [
								base.damage ? ` — ${base.damage} ${base.damageType ?? ""}`.trimEnd() : null,
								base.ac ? ` — AC ${base.ac}` : null,
								(base.properties ?? []).length ? ` — ${base.properties.join(", ")}` : null,
							].filter(Boolean).join(""),
						}),
						el("button.link-btn", {
							type: "button", text: "clear",
							onclick: () => { applyBase(null); build(); },
						}),
					].filter(Boolean)),
				].filter(Boolean)),
			),

			/* --- what makes it special -------------------------------- */
			section("What it does", "Leave anything blank that does not apply.",
				el("div.item-builder__grid", {}, [
					field("Rarity",
						el("select", {
							onchange: (e) => { draft.rarity = e.target.value; },
						}, RARITIES.map((r) =>
							el("option", { value: r, text: r === "none" ? "not magical" : r, selected: draft.rarity === r }),
						)),
					),

					(draft.kind === "weapon") && field("Attack and damage bonus",
						el("input", {
							type: "number", value: numberOrBlank(draft.bonusWeapon),
							placeholder: "1",
							oninput: (e) => { draft.bonusWeapon = e.target.value === "" ? "" : `+${Math.abs(Number(e.target.value) || 0)}`; },
						}),
						"A +1 sword: enter 1",
					),

					(draft.kind === "weapon") && field("Extra damage",
						el("input", {
							type: "text", value: draft.extraDamage ?? "",
							placeholder: "1d6 fire",
							oninput: (e) => { draft.extraDamage = e.target.value; },
						}),
						"Shown alongside the weapon's own damage",
					),

					(draft.kind === "armor" || draft.kind === "shield") && field("Armour class bonus",
						el("input", {
							type: "number", value: numberOrBlank(draft.bonusAc),
							placeholder: "1",
							oninput: (e) => { draft.bonusAc = e.target.value === "" ? "" : `+${Math.abs(Number(e.target.value) || 0)}`; },
						}),
						"On top of the armour's own rating",
					),

					(draft.kind === "shield") && field("Shield rating",
						el("input", {
							type: "number", value: draft.ac ?? 2,
							oninput: (e) => { draft.ac = Number(e.target.value) || 2; draft.type = "S"; },
						}),
						"A plain shield is 2",
					),

					(draft.kind === "armor" && !base) && field("Base armour class",
						el("input", {
							type: "number", value: draft.ac ?? "",
							placeholder: "14",
							oninput: (e) => {
								draft.ac = Number(e.target.value) || null;
								draft.armor = true;
								draft.type = draft.type ?? "MA";
							},
						}),
					),

					field("Weight (lb)",
						el("input", {
							type: "number", step: "0.1", value: draft.weight ?? "",
							oninput: (e) => { draft.weight = e.target.value === "" ? null : Number(e.target.value); },
						}),
					),

					field("Value (gp)",
						el("input", {
							type: "number", step: "0.1", value: draft.costGp ?? "",
							oninput: (e) => { draft.costGp = e.target.value === "" ? null : Number(e.target.value); },
						}),
						"Used when selling",
					),
				].filter(Boolean)),
			),

			/* --- attunement and charges ------------------------------- */
			section("Attunement and charges", null,
				el("div", {}, [
					el("label.checkbox-row", {}, [
						el("input", {
							type: "checkbox", checked: Boolean(draft.attunement),
							onchange: (e) => { draft.attunement = e.target.checked; build(); },
						}),
						el("span", { text: "Requires attunement" }),
					]),

					el("label.checkbox-row", {}, [
						el("input", {
							type: "checkbox", checked: Boolean(draft.charges),
							onchange: (e) => {
								draft.charges = e.target.checked ? { max: 3, recharge: "long" } : null;
								build();
							},
						}),
						el("span", { text: "Has limited uses" }),
					]),

					draft.charges && el("div.item-builder__grid", {}, [
						field("Uses",
							el("input", {
								type: "number", min: 1, value: draft.charges.max,
								oninput: (e) => { draft.charges.max = Math.max(1, Number(e.target.value) || 1); },
							}),
						),
						field("Comes back on",
							el("div.btn-row", {}, ["short", "long"].map((r) =>
								el("button.toggle-btn", {
									type: "button",
									class: draft.charges.recharge === r ? "is-active" : "",
									text: r === "short" ? "Short rest" : "Long rest",
									onclick: () => { draft.charges.recharge = r; build(); },
								}),
							)),
							"Tracked in the Uses box with your class features",
						),
					]),
				].filter(Boolean)),
			),

			/* --- the words -------------------------------------------- */
			section("Description", "What the DM told you it does.",
				el("textarea.item-builder__notes", {
					rows: 5,
					value: draft.notes ?? "",
					placeholder: "While holding this sword you have advantage on Charisma checks made to intimidate badgers.",
					oninput: (e) => { draft.notes = e.target.value; },
				}),
			),

			/* --- save ------------------------------------------------- */
			el("div.btn-row.item-builder__actions", {}, [
				el("button.btn.btn--primary", {
					type: "button",
					text: existing ? "Save changes" : "Create it",
					onclick: () => {
						if (!draft.name.trim()) { toast("Give it a name first."); return; }
						session.update((c) => saveCustomItem(c, draft, Boolean(existing)));
						closeAllModals();
						toast(existing ? `${draft.name} updated.` : `${draft.name} created and added to your pack.`);
						onDone?.();
					},
				}),
				existing && el("button.btn.btn--danger", {
					type: "button",
					text: "Delete",
					title: "Removes the item and takes it out of your pack",
					onclick: () => {
						session.update((c) => ({
							...c,
							customItems: (c.customItems ?? []).filter((i) => i.id !== draft.id),
							equipment: (c.equipment ?? []).filter((e) => e.itemId !== draft.id),
						}));
						closeAllModals();
						toast(`${draft.name} deleted.`);
						onDone?.();
					},
				}),
			].filter(Boolean)),
		].filter(Boolean));
	};

	build();
	modal(existing ? `Edit ${existing.name}` : "Make an item", body);
}

const numberOrBlank = (bonus) => {
	const n = Number(String(bonus ?? "").replace("+", ""));
	return Number.isFinite(n) && n !== 0 ? n : "";
};

/**
 * Writes the item to the character, and puts a new one in the pack.
 *
 * The stored shape is deliberately a database item: `html` rather than `notes`,
 * `magic` set from the rarity, so nothing downstream needs to know it was made
 * up here.
 */
function saveCustomItem(char, draft, isEdit) {
	const item = {
		...draft,
		magic: draft.rarity && draft.rarity !== "none" ? true : undefined,
		rarity: draft.rarity === "none" ? undefined : draft.rarity,
		reqAttune: draft.attunement ? "yes" : undefined,
		blurb: (draft.notes ?? "").slice(0, 160),
		html: (draft.notes ?? "")
			.split(/\n{2,}/)
			.filter(Boolean)
			.map((para) => `<p>${escapeText(para)}</p>`)
			.join(""),
	};

	const customItems = isEdit
		? (char.customItems ?? []).map((i) => (i.id === item.id ? item : i))
		: [...(char.customItems ?? []), item];

	// A new item goes straight into the pack; editing an existing one leaves the
	// inventory alone but refreshes the name shown there.
	const equipment = isEdit
		? (char.equipment ?? []).map((e) => (e.itemId === item.id ? { ...e, name: item.name } : e))
		: [...(char.equipment ?? []), {
			itemId: item.id,
			name: item.name,
			quantity: 1,
			equipped: false,
			magic: Boolean(item.magic),
			source: "custom",
		}];

	return { ...char, customItems, equipment };
}

const escapeText = (s) =>
	String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* ------------------------------------------------------------------ *
 * The list of what you have made
 * ------------------------------------------------------------------ */

/** A manager for the character's invented items, for the equipment step. */
export function customItemList(session, onDone) {
	const char = session.character;
	const items = char.customItems ?? [];

	return el("div", {}, [
		el("div.btn-row", {}, [
			el("button.btn.btn--primary", {
				type: "button",
				text: "Make an item",
				onclick: () => customItemBuilder(session, { onDone }),
			}),
		]),

		items.length
			? el("ul.custom-item-list", {}, items.map((i) =>
				el("li.custom-item-list__row", {}, [
					el("span.custom-item-list__name", {}, [itemLink(i.name)]),
					el("span.custom-item-list__meta", {
						text: [
							i.rarity ?? "not magical",
							i.bonusWeapon ? `${i.bonusWeapon} weapon` : null,
							i.bonusAc ? `${i.bonusAc} AC` : null,
							i.extraDamage || null,
							i.charges ? `${i.charges.max} uses / ${i.charges.recharge} rest` : null,
							i.reqAttune ? "attunement" : null,
						].filter(Boolean).join(" · "),
					}),
					el("button.link-btn", {
						type: "button", text: "edit",
						onclick: () => customItemBuilder(session, { editId: i.id, onDone }),
					}),
					// Re-adding matters: an item sold or dropped can come back.
					!(char.equipment ?? []).some((e) => e.itemId === i.id) && el("button.link-btn", {
						type: "button", text: "add to pack",
						onclick: () => {
							session.update((c) => ({
								...c,
								equipment: [...(c.equipment ?? []), {
									itemId: i.id, name: i.name, quantity: 1,
									equipped: false, magic: Boolean(i.magic), source: "custom",
								}],
							}));
							onDone?.();
						},
					}),
				].filter(Boolean)),
			))
			: el("p.muted", { text: "Nothing made up yet. Anything you create here stays with this character." }),
	]);
}
