/**
 * Resting, and everything a rest gives back.
 *
 * At the table a rest is the moment when half a dozen separate trackers all move
 * at once: spell slots, hit dice, Second Wind, Channel Divinity, a Warlock's
 * pact slots. Doing that by hand across a paper sheet is where mistakes creep
 * in, so both rests are single buttons that report exactly what they restored.
 *
 * The rules applied here, for the record:
 *
 *   Short rest  Features that recharge on a Short Rest reset. Warlock pact
 *               slots come back. Hit dice may be spent for healing, each one
 *               adding your Constitution modifier.
 *   Long rest   Everything above, plus all remaining features, all spell slots,
 *               hit points to full, temporary hit points cleared, and half your
 *               total hit dice recovered (rounded down, minimum one).
 *
 * Nothing here is derived state: the module only ever writes the small set of
 * "spent" counters on the character, and the sheet re-derives from those.
 */

import { el, modal, notice, toast, closeAllModals } from "./ui.js";
import { parseDice, roll } from "./dice.js";
import { getClass } from "./data.js";
import * as rules from "./rules.js";

/* ------------------------------------------------------------------ *
 * Applying a rest
 * ------------------------------------------------------------------ */

/**
 * The character after a short rest.
 *
 * Hit dice are deliberately NOT restored and hit points are NOT topped up: both
 * are the player's choice during the rest, handled by the dialog below.
 */
export function afterShortRest(char) {
	const kept = {};
	for (const r of rules.featureResources(char)) {
		// Long-rest features survive a short rest, so their spend carries over.
		if (r.recharge !== "short") kept[r.key] = char.resourcesUsed?.[r.key] ?? 0;
	}
	return {
		...char,
		resourcesUsed: kept,
		pactSlotsUsed: 0,
		lastRest: { kind: "short", at: new Date().toISOString() },
	};
}

/** The character after a long rest: everything back, and half the hit dice. */
export function afterLongRest(char) {
	const max = rules.hitPoints(char).max;

	// Half your total hit dice, rounded down, minimum one.
	const regain = rules.hitDiceRegainedOnLongRest(char);
	const dicePool = rules.hitDicePool(char);
	const nextDice = {};
	let left = regain;
	// Spend the recovery on the biggest dice first, which is what a player wants:
	// a d10 back beats a d6 back.
	for (const h of dicePool) {
		const give = Math.min(h.used, left);
		left -= give;
		const stillUsed = h.used - give;
		if (stillUsed > 0) nextDice[h.die] = stillUsed;
	}

	return {
		...char,
		hp: { ...(char.hp ?? {}), current: max, temp: 0 },
		spellSlotsUsed: {},
		pactSlotsUsed: 0,
		resourcesUsed: {},
		hitDiceUsed: nextDice,
		lastRest: { kind: "long", at: new Date().toISOString() },
	};
}

/* ------------------------------------------------------------------ *
 * What a rest is about to do
 * ------------------------------------------------------------------ */

/**
 * A plain-language list of what this rest will restore, built from what is
 * actually spent. An empty list means the rest changes nothing, which is worth
 * saying out loud rather than silently doing nothing.
 */
export function restPreview(char, kind) {
	const lines = [];
	const resources = rules.featureResources(char);
	const spentFeatures = resources.filter((r) =>
		r.used > 0 && (kind === "long" || r.recharge === "short"));

	for (const r of spentFeatures) {
		lines.push(`${r.name} — ${r.used} of ${r.max} use${r.max === 1 ? "" : "s"}`);
	}

	const sc = rules.spellcasting(char);
	if (kind === "long") {
		const slots = sc.slotsUsed?.reduce((a, b) => a + b, 0) ?? 0;
		if (slots) lines.push(`${slots} spell slot${slots === 1 ? "" : "s"}`);
	}
	if ((char.pactSlotsUsed ?? 0) > 0) {
		lines.push(`${char.pactSlotsUsed} Pact Magic slot${char.pactSlotsUsed === 1 ? "" : "s"}`);
	}

	if (kind === "long") {
		const hp = rules.hitPoints(char).max;
		const current = char.hp?.current ?? hp;
		if (current < hp) lines.push(`Hit points, ${current} back up to ${hp}`);
		if (char.hp?.temp) lines.push(`Temporary hit points cleared (${char.hp.temp} lost)`);

		const spentDice = rules.hitDicePool(char).reduce((n, h) => n + h.used, 0);
		if (spentDice) {
			const regain = Math.min(spentDice, rules.hitDiceRegainedOnLongRest(char));
			lines.push(`${regain} hit ${regain === 1 ? "die" : "dice"} recovered`);
		}
	}

	return lines;
}

/* ------------------------------------------------------------------ *
 * Features that give spell slots back
 * ------------------------------------------------------------------ */

/**
 * Features that recover spell slots, and the budget each one allows.
 *
 * These cannot be read out of the rules text -- "a combined level equal to half
 * your Wizard level, rounded up" is prose -- so the arithmetic is declared here,
 * keyed by feature name, in the same spirit as effects.js.
 *
 * `levels` is the class level the budget is measured against, which for a
 * multiclassed character is the level in THAT class, not the total.
 */
const SLOT_RECOVERY = {
	"Arcane Recovery": {
		className: "Wizard",
		kind: "spell",
		// Half your Wizard level, rounded up, in combined slot levels.
		budget: (classLevel) => Math.ceil(classLevel / 2),
		// No slot of 6th level or higher.
		maxSlotLevel: 5,
		blurb: "Recover spell slots with a combined level up to half your Wizard level, rounded up. Nothing of 6th level or higher.",
	},
	"Magical Cunning": {
		className: "Warlock",
		kind: "pact",
		// Half your Pact Magic slots, rounded up -- handled as a slot count.
		budget: () => null,
		blurb: "Regain half your expended Pact Magic slots, rounded up.",
	},
};

/**
 * The recovery a feature offers this character, or null.
 *
 * Returns the live budget and what is currently spent, so the dialog can show
 * only slots there is any point offering.
 */
export function slotRecoveryFor(char, featureName) {
	const rule = SLOT_RECOVERY[featureName];
	if (!rule) return null;

	const entry = (char.classes ?? []).find((c) => {
		const cls = getClass(c.classId);
		return cls?.name === rule.className;
	});
	if (!entry) return null;

	const classLevel = entry.levels ?? 0;
	const sc = rules.spellcasting(char);
	if (!sc) return null;

	if (rule.kind === "pact") {
		const spent = char.pactSlotsUsed ?? 0;
		return {
			kind: "pact",
			blurb: rule.blurb,
			// Half the pact slots you have spent, rounded up.
			slots: Math.ceil((sc.pact?.count ?? 0) / 2),
			spent,
		};
	}

	// Which levels have anything to give back, capped by the feature.
	const cap = rule.maxSlotLevel ?? 9;
	const available = [];
	for (let level = 1; level <= Math.min(cap, sc.slots.length); level++) {
		const used = sc.slotsUsed[level - 1] ?? 0;
		if (used > 0) available.push({ level, used });
	}

	return {
		kind: "spell",
		blurb: rule.blurb,
		budget: rule.budget(classLevel),
		maxSlotLevel: cap,
		available,
	};
}

/**
 * The slot recovery dialog.
 *
 * The budget is in combined slot LEVELS, not slots: at Wizard 5 you have 3 to
 * spend, so that is one 3rd-level slot, or a 2nd and a 1st, or three 1sts. The
 * running total is shown so the choice is obvious, and nothing can be recovered
 * that was not spent in the first place.
 */
export function slotRecoveryDialog(session, resource, rerender) {
	const body = el("div.recovery-dialog");

	const build = () => {
		const live = session.character;
		const info = slotRecoveryFor(live, resource.name);
		if (!info) { body.replaceChildren(notice("This feature does not recover slots.", "warn")); return; }

		if (info.kind === "pact") {
			body.replaceChildren(...[
				el("p", { text: info.blurb }),
				info.spent > 0
					? el("p", { text: `${info.spent} Pact Magic slot${info.spent === 1 ? "" : "s"} spent; you get ${Math.min(info.spent, info.slots)} back.` })
					: el("p.muted", { text: "No Pact Magic slots are spent." }),
				el("div.btn-row", {}, [
					el("button.btn.btn--primary", {
						type: "button",
						text: "Use it",
						disabled: info.spent === 0,
						onclick: () => {
							session.update((c) => ({
								...c,
								pactSlotsUsed: Math.max(0, (c.pactSlotsUsed ?? 0) - info.slots),
								resourcesUsed: {
									...(c.resourcesUsed ?? {}),
									[resource.key]: Math.min(resource.max, (c.resourcesUsed?.[resource.key] ?? 0) + 1),
								},
							}));
							closeAllModals();
							toast("Pact Magic slots recovered.");
							rerender?.();
						},
					}),
				]),
			].filter(Boolean));
			return;
		}

		// Spell slots: pick a set whose combined level fits the budget.
		const spentLevels = Object.entries(picks).reduce((n, [lvl, count]) => n + Number(lvl) * count, 0);
		const left = info.budget - spentLevels;

		body.replaceChildren(...[
			el("p", { text: info.blurb }),
			el("p.recovery-dialog__budget", {}, [
				el("span", { text: "Budget " }),
				el("strong", { text: `${left} of ${info.budget}` }),
				el("span.muted", { text: " combined slot levels left" }),
			]),

			info.available.length
				? el("div.recovery-list", {}, info.available.map((slot) => {
					const taken = picks[slot.level] ?? 0;
					const canAdd = taken < slot.used && slot.level <= left;
					return el("div.recovery-row", {}, [
						el("span.recovery-row__level", { text: `Level ${slot.level}` }),
						el("span.recovery-row__spent", { text: `${slot.used} spent` }),
						el("div.recovery-row__controls", {}, [
							el("button.hp-adjust__btn", {
								type: "button", text: "−",
								disabled: taken === 0,
								title: `Recover one fewer level ${slot.level} slot`,
								onclick: () => { picks[slot.level] = taken - 1; build(); },
							}),
							el("span.recovery-row__count", { text: taken }),
							el("button.hp-adjust__btn", {
								type: "button", text: "+",
								disabled: !canAdd,
								title: taken >= slot.used
									? "You did not spend any more of these"
									: slot.level > left
										? `A level ${slot.level} slot costs ${slot.level} of your budget`
										: `Recover a level ${slot.level} slot`,
								onclick: () => { picks[slot.level] = taken + 1; build(); },
							}),
						]),
					]);
				}))
				: notice("No spell slots are spent, so there is nothing to recover.", "info"),

			el("div.btn-row", {}, [
				el("button.btn.btn--primary", {
					type: "button",
					text: spentLevels ? `Recover ${describePicks(picks)}` : "Recover nothing",
					disabled: !spentLevels,
					onclick: () => {
						session.update((c) => {
							const used = { ...(c.spellSlotsUsed ?? {}) };
							for (const [lvl, count] of Object.entries(picks)) {
								if (!count) continue;
								used[lvl] = Math.max(0, Number(used[lvl] ?? 0) - count);
							}
							return {
								...c,
								spellSlotsUsed: used,
								resourcesUsed: {
									...(c.resourcesUsed ?? {}),
									[resource.key]: Math.min(resource.max, (c.resourcesUsed?.[resource.key] ?? 0) + 1),
								},
							};
						});
						closeAllModals();
						toast(`Recovered ${describePicks(picks)}.`);
						rerender?.();
					},
				}),
			]),
		].filter(Boolean));
	};

	const picks = {};
	build();
	modal(resource.name, body);
}

const describePicks = (picks) =>
	Object.entries(picks)
		.filter(([, n]) => n > 0)
		.map(([lvl, n]) => `${n} x level ${lvl}`)
		.join(", ") || "nothing";

/* ------------------------------------------------------------------ *
 * The rest buttons
 * ------------------------------------------------------------------ */

/**
 * The two rest buttons.
 *
 * They live inside the hit point block rather than in a bar of their own,
 * because a rest is mostly about hit points, hit dice and feature uses -- all of
 * which are right there.
 */
export function restButtons(session, char, d, rerender) {
	const shortSpent = d.featureResources.filter((r) => r.recharge === "short" && r.used > 0).length;
	const diceSpent = d.hitDicePool.reduce((n, h) => n + h.used, 0);

	return el("div.rest-buttons.no-print", {}, [
		el("button.btn.btn--small.btn--rest", {
			type: "button",
			text: "Short rest",
			title: shortSpent
				? `Spend hit dice, and recover ${shortSpent} feature${shortSpent === 1 ? "" : "s"}`
				: "Spend hit dice to heal",
			onclick: () => shortRestDialog(session, char, d, rerender),
		}),
		el("button.btn.btn--small.btn--rest.btn--rest-long", {
			type: "button",
			text: "Long rest",
			title: diceSpent
				? "Hit points, every feature, and half your hit dice back"
				: "Hit points and every feature back",
			onclick: () => longRestDialog(session, char, rerender),
		}),
	]);
}

/* ------------------------------------------------------------------ *
 * Short rest
 * ------------------------------------------------------------------ */

/**
 * The short rest dialog: spend hit dice, then confirm.
 *
 * Hit dice are spent one at a time and rolled for real, because that is how it
 * happens at the table and because the roll is the interesting part. Healing is
 * applied as you go, so closing the dialog half way through keeps the hit points
 * you actually rolled -- only the feature reset waits for the button.
 */
function shortRestDialog(session, char, d, rerender) {
	const body = el("div.rest-dialog");

	const build = () => {
		// Re-read, because spending a die has written to the character.
		const live = session.character;
		const derived = rules.derive(live);
		const hpMax = derived.hp.max;
		const current = live.hp?.current ?? hpMax;
		const conMod = derived.abilityMods.con ?? 0;
		const pool = derived.hitDicePool;
		const recovering = derived.featureResources.filter((r) => r.recharge === "short");

		const spendDie = (die, faces) => {
			const parsed = parseDice(`1d${faces}`);
			const result = roll(parsed);
			// Constitution applies to each die spent, and a die can never heal
			// less than nothing even with a punishing negative modifier.
			const healed = Math.max(0, result.total + conMod);
			session.update((c) => ({
				...c,
				hitDiceUsed: { ...(c.hitDiceUsed ?? {}), [die]: (c.hitDiceUsed?.[die] ?? 0) + 1 },
				hp: {
					...(c.hp ?? {}),
					current: Math.min(rules.hitPoints(c).max, (c.hp?.current ?? rules.hitPoints(c).max) + healed),
				},
			}));
			toast(`${die}: rolled ${result.total}${conMod ? ` ${conMod > 0 ? "+" : ""}${conMod} CON` : ""} → +${healed} HP`);
			build();
			rerender();
		};

		// replaceChildren stringifies whatever it is handed, so a conditional that
		// evaluates to null would print the word "null" on the page.
		body.replaceChildren(...[
			el("p.rest-dialog__hp", {}, [
				el("span", { text: "Hit points " }),
				el("strong", { text: `${current} / ${hpMax}` }),
				current >= hpMax ? el("span.muted", { text: " — already full" }) : null,
			].filter(Boolean)),

			/* --- hit dice ------------------------------------------------ */
			el("h4", { text: "Spend hit dice" }),
			pool.length
				? el("div.hd-list", {}, pool.map((h) =>
					el("div.hd-row", {}, [
						el("span.hd-row__die", { text: h.die }),
						el("span.hd-row__count", {
							text: `${h.available} of ${h.total} left`,
							class: h.available === 0 ? "is-spent" : "",
						}),
						el("button.btn.btn--small", {
							type: "button",
							text: `Roll ${h.die}${conMod ? ` ${conMod > 0 ? "+" : ""}${conMod}` : ""}`,
							disabled: h.available === 0 || current >= hpMax,
							title: h.available === 0
								? "No dice of this size left until a long rest"
								: current >= hpMax
									? "Already at full hit points"
									: `Heal 1${h.die}${conMod ? ` ${conMod > 0 ? "+" : ""}${conMod}` : ""}`,
							onclick: () => spendDie(h.die, h.faces),
						}),
					]),
				))
				: notice("No hit dice — add a class level first.", "warn"),

			/* --- what the rest itself restores --------------------------- */
			el("h4", { text: "The rest itself" }),
			recovering.length
				? el("ul.rest-dialog__list", {}, recovering.map((r) => {
					const recovery = slotRecoveryFor(live, r.name);
					return el("li", {}, [
						el("strong", { text: r.name }),
						el("span.muted", { text: ` — ${r.origin}: ` }),
						el("span", {
							text: r.used
								? `${r.used} of ${r.max} used, coming back`
								: `all ${r.max} still available`,
							class: r.used ? "is-spent" : "muted",
						}),
						// Arcane Recovery is used DURING the short rest, so it is
						// offered here rather than only in the Uses box.
						recovery && r.available > 0 && el("button.link-btn", {
							type: "button", text: "use it",
							title: recovery.blurb,
							onclick: () => slotRecoveryDialog(session, r, () => { build(); rerender(); }),
						}),
					].filter(Boolean));
				}))
				: el("p.muted", { text: "No short-rest features yet." }),

			(live.pactSlotsUsed ?? 0) > 0
				? el("p", { text: `Pact Magic: ${live.pactSlotsUsed} slot${live.pactSlotsUsed === 1 ? "" : "s"} come back.` })
				: null,

			el("div.btn-row.rest-dialog__confirm", {}, [
				el("button.btn.btn--primary", {
					type: "button",
					text: "Finish the short rest",
					onclick: () => {
						session.update((c) => afterShortRest(c));
						closeAllModals();
						toast("Short rest taken.");
						rerender();
					},
				}),
			]),
		].filter(Boolean));
	};

	build();
	modal("Short rest", body);
}

/* ------------------------------------------------------------------ *
 * Long rest
 * ------------------------------------------------------------------ */

/** The long rest dialog: a summary of what comes back, then one button. */
function longRestDialog(session, char, rerender) {
	const lines = restPreview(char, "long");

	modal("Long rest", el("div.rest-dialog", {}, [
		lines.length
			? el("div", {}, [
				el("p", { text: "This restores:" }),
				el("ul.rest-dialog__list", {}, lines.map((t) => el("li", { text: t }))),
			])
			: el("p.muted", { text: "Nothing is spent — a long rest would change nothing." }),

		el("div.btn-row.rest-dialog__confirm", {}, [
			el("button.btn.btn--primary", {
				type: "button",
				text: "Take a long rest",
				onclick: () => {
					session.update((c) => afterLongRest(c));
					closeAllModals();
					toast("Long rest taken.");
					rerender();
				},
			}),
		]),
	]));
}
