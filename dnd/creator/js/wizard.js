/**
 * wizard.js - the guided creation flow.
 *
 * Each step is a small object with a title, a relevance test and a render
 * function. app.js walks the list, skipping steps that do not apply (no spell
 * step for a Fighter), so the flow stays short for simple characters and opens
 * up only where the rules actually demand a decision.
 */

import { db, getSpecies, getClass, getBackground, getSubclass, getItem, getItemByRef, filterEntries, ensure, allSkills, skillById, itemDescription } from "./data.js";
import { el, card, section, field, modal, rulesHtml, notice, choiceList, toast, gp, debounce, statBox, infoButton, itemLink, refLink } from "./ui.js";
import * as rules from "./rules.js";
import { creatureRefLinks, statBlock, findCreature, creatureSubtitle, showCreature } from "./statblock.js";
import { showSpell, showReference } from "./glossary.js";
import {
	isUnpackable, unpack, packSummary, sellDialog, groupChoiceDialog,
	customItemList, itemValueGp,
} from "./items.js";

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

const editionOpts = (char) => ({ edition: char.edition ?? "2024" });

/** Picker lists collapse reprints so the same species never appears twice. */
const pickerOpts = (char) => ({ edition: char.edition ?? "2024", dedupe: true });

const classEntry = (char) => char.classes?.[0] ?? null;

/**
 * Skills the character already has from somewhere other than `bucket`.
 *
 * Used to grey out an option that would be wasted: the 2024 Vampire Survivor
 * background hands you Insight, so a Fighter picking Insight again gets nothing.
 * The `allowDuplicateSkills` house rule turns the locking off.
 */
function skillsFromOtherSources(char, bucket) {
	const out = new Set();
	if (char.houseRules?.allowDuplicateSkills) return out;

	for (const [skillId, sources] of rules.skillSources(char)) {
		const ownList = char.skillChoices?.[bucket] ?? [];
		// A skill this bucket itself chose is not "from elsewhere".
		if (ownList.includes(skillId) && sources.length === 1) continue;
		out.add(skillId);
	}
	return out;
}

/**
 * One skill picker, shared by the class and species steps.
 * Selections are stored per bucket so changing a background never silently
 * drops the skills the class chose.
 */
function skillPicker(ctx, { bucket, title, choice, hint }) {
	const { session } = ctx;
	const char = session.character;

	const pool = choice.from === "any" || choice.from === undefined
		? allSkills().map((sk) => sk.id)
		: choice.from ?? [];

	const count = choice.count ?? 1;
	const chosen = (char.skillChoices?.[bucket] ?? []).filter((id) => pool.includes(id));
	const locked = skillsFromOtherSources(char, bucket);

	// Anything already granted elsewhere is not worth spending a pick on.
	const wasted = chosen.filter((id) => locked.has(id));
	const available = pool.filter((id) => !locked.has(id));

	return section(title, hint ?? `Choose ${count}.`, [
		wasted.length > 0 && notice(
			`${wasted.map((id) => skillById(id)?.name ?? id).join(", ")} `
			+ `${wasted.length === 1 ? "is" : "are"} already granted by another source, so `
			+ `${wasted.length === 1 ? "this pick is" : "these picks are"} wasted. `
			+ `Still open: ${available.slice(0, 6).map((id) => skillById(id)?.name ?? id).join(", ")}`
			+ `${available.length > 6 ? "…" : ""}`,
			"warn",
		),
		choiceList({
			options: pool.map((id) => {
				const sk = skillById(id);
				const from = rules.skillSources(char).get(id);
				return {
					id,
					label: sk?.name ?? id,
					hint: locked.has(id) && from
						? `already from ${from[0]}`
						: (sk ? sk.ability.toUpperCase() : ""),
				};
			}),
			selected: chosen,
			max: count,
			disabledIds: locked,
			onChange: (ids) => {
				session.update((c) => ({
					...c,
					skillChoices: { ...(c.skillChoices ?? {}), [bucket]: ids },
				}));
				ctx.rerender();
			},
			// Skills have glossary entries, so they get an explanation too.
			onInfo: (opt) => showReference(`skill|${skillById(opt.id)?.name ?? opt.label}|`),
		}),
		el("label.house-rule-toggle", {}, [
			el("input", {
				type: "checkbox",
				checked: Boolean(char.houseRules?.allowDuplicateSkills),
				onchange: (e) => {
					session.update((c) => ({
						...c,
						houseRules: { ...(c.houseRules ?? {}), allowDuplicateSkills: e.target.checked },
					}));
					ctx.rerender();
				},
			}),
			el("span", { text: "House rule: allow picking skills another source already granted" }),
		]),
	].filter(Boolean));
}

/** Ability-score grants: 2024 puts them on the background, 2014 on the species. */
function abilityGrants(char) {
	const grants = [];
	const bg = getBackground(char.backgroundId);
	const species = getSpecies(char.speciesId);

	if (bg?.ability) grants.push({ from: "background", label: bg.name, ...bg.ability });
	if (species?.ability) grants.push({ from: "species", label: species.name, ...species.ability });

	return grants;
}

/* ------------------------------------------------------------------ *
 * Step 1 - Class
 * ------------------------------------------------------------------ */

const classStep = {
	id: "class",
	title: "Class",
	blurb: "What you do in a fight, and out of one.",

	render(ctx) {
		const { session } = ctx;
		const char = session.character;
		const entry = classEntry(char);
		const list = filterEntries(db.classes, pickerOpts(char))
			.sort((a, b) => a.name.localeCompare(b.name));

		const selected = entry ? getClass(entry.classId) : null;

		const nodes = [];

		nodes.push(section("Choose a class", "This drives your hit points, saving throws, weapons and armour.",
			el("div.pick-grid", {}, list.map((cls) =>
				card({
					title: cls.name,
					subtitle: `d${cls.hitDie} hit die · ${(cls.primaryAbility ?? []).map((a) => a.toUpperCase()).join("/") || "—"}`,
					blurb: cls.blurb,
					meta: [
						`Saves: ${(cls.savingThrows ?? []).map((s) => s.toUpperCase()).join(", ")}`,
						cls.srd ? "SRD" : cls.source,
					],
					badge: cls.casterProgression ? "Caster" : null,
					selected: entry?.classId === cls.id,
					onSelect: () => {
						session.update((c) => ({
							...c,
							classes: [{
								classId: cls.id,
								subclassId: null,
								levels: entry?.levels ?? 1,
								hitDiceRolled: [],
							}],
							// Only the class's own picks reset; background and species grants stay.
							skillChoices: { ...(c.skillChoices ?? {}), class: [] },
							optionalFeaturePicks: [],
							equipment: [],
						}));
						ctx.rerender();
					},
					onInfo: () => showClassDetail(cls),
				}),
			)),
		));

		if (selected) {
			// Level
			nodes.push(section("Level", "Build at any level. Everything below updates to match.",
				el("div.level-row", {}, [
					el("input.level-input", {
						type: "number", min: 1, max: 20,
						value: entry.levels ?? 1,
						oninput: (e) => {
							const lvl = Math.max(1, Math.min(20, Number(e.target.value) || 1));
							session.update((c) => ({
								...c,
								classes: [{ ...c.classes[0], levels: lvl }],
							}));
							ctx.rerender();
						},
					}),
					el("span.level-row__note", {
						text: `Proficiency bonus ${rules.formatMod(rules.proficiencyBonus(char))} · Hit die d${selected.hitDie}`,
					}),
				]),
			));

			// Subclass, once the class level reaches its subclass level
			const subLevel = selected.subclassLevel ?? 3;
			if ((entry.levels ?? 1) >= subLevel) {
				const subs = selected.subclasses ?? [];
				nodes.push(section(selected.subclassTitle ?? "Subclass",
					`Unlocked at level ${subLevel}.`,
					subs.length
						? el("div.pick-grid", {}, subs.map((sub) =>
							card({
								title: sub.name,
								subtitle: sub.source,
								blurb: sub.blurb,
								selected: entry.subclassId === sub.id,
								onSelect: () => {
									session.update((c) => ({
										...c,
										classes: [{ ...c.classes[0], subclassId: sub.id }],
									}));
									ctx.rerender();
								},
								onInfo: () => showSubclassDetail(sub),
							}),
						))
						: notice("No subclasses available for this class in the loaded data.", "warn"),
				));
			} else {
				nodes.push(notice(`${selected.subclassTitle ?? "Subclass"} is chosen at level ${subLevel}.`));
			}

			// Fighting styles and similar picks driven by featProgression
			nodes.push(...optionalFeatureSections(ctx, selected, entry));

			// Class skill choices
			nodes.push(...skillChoiceSections(ctx, selected));
		}

		return nodes;
	},

	isComplete(char) {
		const entry = classEntry(char);
		if (!entry?.classId) return false;
		const cls = getClass(entry.classId);
		if (!cls) return false;
		if ((entry.levels ?? 1) >= (cls.subclassLevel ?? 3) && cls.subclasses?.length && !entry.subclassId) {
			return false;
		}
		return true;
	},
};

/** Renders skill pickers for each `choose N from [...]` the class grants. */
function skillChoiceSections(ctx, cls) {
	return (cls.skillChoices ?? []).map((choice) =>
		skillPicker(ctx, {
			bucket: "class",
			title: `${cls.name} skills`,
			choice,
			hint: `Choose ${choice.count ?? 1}. Skills your background or species already granted are greyed out.`,
		}),
	);
}

/**
 * Choose a feat for a trait that grants one (the 2024 Human's Versatile).
 *
 * Feats are filtered to the category the trait calls for -- an Origin feat here
 * is not the same list as a General feat at level 4 -- and prerequisites are
 * respected unless the character has the house rule turned on.
 */
function featPicker(ctx, choice) {
	const { session } = ctx;
	const char = session.character;
	const category = choice.featCategory ?? "origin";

	const pool = filterEntries(db.feats, pickerOpts(char))
		.filter((f) => f.category === category)
		.filter((f) => char.houseRules?.ignoreFeatPrerequisites || allowedByPrerequisite(f, char))
		.sort((a, b) => a.name.localeCompare(b.name));

	const picked = char.featChoices?.[choice.id] ?? null;

	if (!pool.length) {
		return section(choice.name, choice.prompt,
			notice(`No ${category} feats found in the loaded data.`, "warn"));
	}

	return section(choice.name, choice.prompt ?? `Choose one ${category} feat.`, [
		!picked && notice("You have not chosen this feat yet.", "warn"),
		el("div.pick-grid.pick-grid--compact", {}, pool.map((f) =>
			card({
				title: f.name,
				subtitle: f.prerequisite ? `Requires ${f.prerequisite}` : null,
				blurb: f.blurb,
				meta: [f.srd ? "SRD" : f.source],
				selected: picked === f.name,
				onSelect: () => {
					session.update((c) => ({
						...c,
						featChoices: { ...(c.featChoices ?? {}), [choice.id]: f.name },
					}));
					ctx.rerender();
				},
				onInfo: () => modal(f.name, el("div", {}, [
					el("p.muted", {
						text: [f.category, f.prerequisite ? `Requires ${f.prerequisite}` : null, f.source]
							.filter(Boolean).join(" · "),
					}),
					rulesHtml(f.html),
				])),
			}),
		)),
	].filter(Boolean));
}

/** Fighting styles, invocations, metamagic: anything in featProgression/optionalfeatureProgression. */
function optionalFeatureSections(ctx, cls, entry) {
	const { session } = ctx;
	const char = session.character;
	const out = [];
	const level = entry.levels ?? 1;

	const progressions = [
		...(cls.featProgression ?? []).map((p) => ({ ...p, kind: "feat" })),
		...(cls.optionalfeatureProgression ?? []).map((p) => ({ ...p, kind: "optionalfeature" })),
	];

	for (const prog of progressions) {
		// How many picks are unlocked at this level.
		const unlocked = Object.entries(prog.progression ?? {})
			.filter(([lvl]) => Number(lvl) <= level)
			.reduce((max, [, n]) => Math.max(max, Number(n)), 0);
		if (!unlocked) continue;

		const categories = (prog.category ?? prog.featureType ?? []).map(String);
		out.push(el("div.pending-picks", {}, [
			section(prog.name ?? "Choices",
				`Choose ${unlocked}. Loaded from ${categories.join(", ") || "the rules"}.`,
				optionalFeaturePicker(ctx, prog, unlocked, categories),
			),
		]));
	}

	return out;
}

/**
 * Some feats are gated to one class -- Blessed Warrior is a Paladin fighting
 * style, Druidic Warrior a Ranger one. The prerequisite is stored as prose
 * ("When Gaining the Level 2 Paladin Fighting Style Feature"), so we look for
 * another class's name in it and hide the feat when we find one.
 */
function allowedByPrerequisite(feat, char) {
	const prereq = feat.prerequisite;
	if (!prereq) return true;

	const myClasses = (char.classes ?? [])
		.map((c) => getClass(c.classId)?.name?.toLowerCase())
		.filter(Boolean);

	for (const other of db.classes) {
		const name = other.name.toLowerCase();
		if (myClasses.includes(name)) continue;
		if (new RegExp(`\\b${name}\\b`, "i").test(prereq)) return false;
	}
	return true;
}

/**
 * Feats and optional features live in two different datasets. Fighting styles
 * are feats with category FS; invocations and maneuvers are optional features.
 */
function optionalFeaturePicker(ctx, prog, count, categories) {
	const { session } = ctx;
	const char = session.character;
	const container = el("div.async-slot", {}, [el("p.muted", { text: "Loading options…" })]);

	const CATEGORY_TO_FEAT = { FS: "fighting-style", EB: "epic-boon", O: "origin", G: "general" };

	(async () => {
		let options = [];

		const featCats = categories.map((c) => CATEGORY_TO_FEAT[c]).filter(Boolean);
		if (featCats.length) {
			options = filterEntries(db.feats, pickerOpts(char))
				.filter((f) => featCats.includes(f.category))
				.filter((f) => allowedByPrerequisite(f, char))
				.map((f) => ({ id: f.name, label: f.name, hint: f.blurb, html: f.html }));
		} else {
			const data = await ensure("optional-features");
			const wanted = categories.map((c) => c.toLowerCase());
			options = filterEntries(data, pickerOpts(char))
				.filter((f) => (f.rawTypes ?? []).some((t) => wanted.includes(String(t).toLowerCase())))
				.map((f) => ({ id: f.name, label: f.name, hint: f.blurb, html: f.html }));
		}

		if (!options.length) {
			container.replaceChildren(notice("No matching options in the loaded data.", "warn"));
			return;
		}

		const picked = (char.optionalFeaturePicks ?? []).filter((n) => options.some((o) => o.id === n));

		container.replaceChildren(
			choiceList({
				options,
				selected: picked,
				max: count,
				onChange: (names) => {
					const others = (char.optionalFeaturePicks ?? []).filter(
						(n) => !options.some((o) => o.id === n),
					);
					session.update((c) => ({ ...c, optionalFeaturePicks: [...others, ...names] }));
					ctx.rerender();
				},
				// A "?" on each row, instead of a list of links underneath.
				onInfo: (opt) => modal(opt.label, rulesHtml(opt.html)),
			}),
		);
	})();

	return container;
}

function showClassDetail(cls) {
	const body = el("div", {}, [
		el("p.muted", { text: `${cls.source}${cls.page ? ` p.${cls.page}` : ""} · ${cls.edition} rules` }),
		el("dl.stat-list", {}, [
			el("dt", { text: "Hit die" }), el("dd", { text: `d${cls.hitDie}` }),
			el("dt", { text: "Saving throws" }), el("dd", { text: (cls.savingThrows ?? []).map((s) => s.toUpperCase()).join(", ") }),
			el("dt", { text: "Armour" }), el("dd", { text: (cls.armorTraining ?? []).join(", ") || "None" }),
			el("dt", { text: "Weapons" }), el("dd", { text: (cls.weaponProficiencies ?? []).join(", ") || "None" }),
		]),
		el("h4", { text: "Features by level" }),
		el("div.feature-list", {}, (cls.levels ?? [])
			.filter((l) => l.features?.length)
			.map((l) => el("div.feature-row", {}, [
				el("span.feature-row__level", { text: `L${l.level}` }),
				el("div.feature-row__body", {}, [
					el("strong", { text: l.features.map((f) => f.name).join(", ") }),
				]),
			])),
		),
	]);
	modal(cls.name, body);
}

function showSubclassDetail(sub) {
	modal(sub.name, el("div", {}, [
		el("p.muted", { text: sub.source }),
		...(sub.levels ?? []).flatMap((l) =>
			(l.features ?? []).map((f) => el("div.feature-block", {}, [
				el("h4", { text: `${f.name} (level ${l.level})` }),
				rulesHtml(f.html),
			])),
		),
	]));
}

/* ------------------------------------------------------------------ *
 * Step 2 - Species
 * ------------------------------------------------------------------ */

const speciesStep = {
	id: "species",
	title: "Species",
	blurb: "Where you came from, and what that gives you.",

	render(ctx) {
		const { session } = ctx;
		const char = session.character;
		const list = filterEntries(db.species, pickerOpts(char))
			.sort((a, b) => a.name.localeCompare(b.name));
		const selected = getSpecies(char.speciesId);

		const nodes = [
			section("Choose a species", char.edition === "2024"
				? "In the 2024 rules your species gives traits only. Ability score increases come from your background."
				: "In the 2014 rules your species also grants ability score increases.",
				el("div.pick-grid", {}, list.map((sp) =>
					card({
						title: sp.name,
						subtitle: `${(sp.size ?? []).map(sizeName).join(" or ") || "Medium"} · ${sp.speed?.walk ?? 30} ft`,
						blurb: sp.blurb,
						meta: [
							sp.darkvision ? `Darkvision ${sp.darkvision} ft` : null,
							(sp.resist ?? []).length ? `Resist ${sp.resist.join(", ")}` : null,
							sp.srd ? "SRD" : sp.source,
						].filter(Boolean),
						selected: char.speciesId === sp.id,
						onSelect: () => {
							session.update((c) => ({
								...c,
								speciesId: sp.id,
								speciesChoices: {},
								lineageId: null,
								size: (sp.size ?? ["M"])[0],
								// Only the species' own picks reset.
								skillChoices: { ...(c.skillChoices ?? {}), species: [] },
								featChoices: {},
							}));
							ctx.rerender();
						},
						onInfo: () => showSpeciesDetail(sp),
					}),
				)),
			),
		];

		if (selected) {
			// Required in-trait picks: Elven Lineage, Draconic Ancestry, ...
			// Feat-type choices are rendered separately by featPicker below.
			for (const choice of (selected.choices ?? []).filter((c) => c.options?.length)) {
				nodes.push(section(choice.name, choice.prompt,
					el("div.pick-grid.pick-grid--compact", {}, (choice.options ?? []).map((opt) =>
						card({
							title: opt.name,
							blurb: stripHtml(opt.html),
							selected: char.speciesChoices?.[choice.id] === opt.id,
							onSelect: () => {
								session.update((c) => ({
									...c,
									speciesChoices: { ...c.speciesChoices, [choice.id]: opt.id },
								}));
								ctx.rerender();
							},
							onInfo: () => modal(opt.name, rulesHtml(opt.html)),
						}),
					)),
				));
			}

			// 2014-style subraces
			if (selected.lineages?.length) {
				nodes.push(section("Subrace", "Choose one.",
					el("div.pick-grid.pick-grid--compact", {}, selected.lineages.map((l) =>
						card({
							title: l.name,
							subtitle: l.source,
							blurb: l.blurb,
							selected: char.lineageId === l.id,
							onSelect: () => {
								session.update((c) => ({ ...c, lineageId: l.id }));
								ctx.rerender();
							},
							onInfo: () => modal(l.name, rulesHtml(l.html)),
						}),
					)),
				));
			}

			// Size, when the species offers a choice
			if ((selected.size ?? []).length > 1) {
				nodes.push(section("Size", "This species can be either size.",
					el("div.btn-row", {}, selected.size.map((s) =>
						el("button.toggle-btn", {
							type: "button",
							class: char.size === s ? "is-active" : "",
							text: sizeName(s),
							onclick: () => { session.update({ size: s }); ctx.rerender(); },
						}),
					)),
				));
			}

			// Species skill choices (Elf Keen Senses, Human Skillful)
			for (const choice of selected.skillProficiencies?.choices ?? []) {
				nodes.push(skillPicker(ctx, {
					bucket: "species",
					title: `${selected.name} skill`,
					choice,
				}));
			}

			// Species-granted feats: the 2024 Human's Versatile trait is an
			// Origin feat of your choice, which nothing else prompts for.
			for (const choice of (selected.choices ?? []).filter((c) => c.type === "feat")) {
				nodes.push(featPicker(ctx, choice));
			}

			nodes.push(section("Traits", null,
				el("div.trait-list", {}, (selected.traits ?? []).map((t) =>
					el("div.trait", {}, [
						el("h4.trait__name", { text: t.name }),
						rulesHtml(t.html),
					]),
				)),
			));
		}

		return nodes;
	},

	isComplete(char) {
		const sp = getSpecies(char.speciesId);
		if (!sp) return false;
		for (const choice of sp.choices ?? []) {
			// Lineage picks and feat picks are stored separately.
			const done = choice.type === "feat"
				? Boolean(char.featChoices?.[choice.id])
				: Boolean(char.speciesChoices?.[choice.id]);
			if (!done) return false;
		}
		if (sp.lineages?.length && !char.lineageId) return false;
		// A species skill choice that has not been made yet is not complete.
		for (const choice of sp.skillProficiencies?.choices ?? []) {
			if ((char.skillChoices?.species ?? []).length < (choice.count ?? 1)) return false;
		}
		return true;
	},
};

const SIZE_NAMES = { T: "Tiny", S: "Small", M: "Medium", L: "Large", H: "Huge", G: "Gargantuan" };
const sizeName = (s) => SIZE_NAMES[s] ?? s;
const stripHtml = (h) => String(h ?? "").replace(/<[^>]+>/g, "").trim();

function showSpeciesDetail(sp) {
	modal(sp.name, el("div", {}, [
		el("p.muted", { text: `${sp.source}${sp.page ? ` p.${sp.page}` : ""}` }),
		sp.blurb && el("p", { text: sp.blurb }),
		...(sp.traits ?? []).map((t) => el("div.feature-block", {}, [
			el("h4", { text: t.name }),
			rulesHtml(t.html),
		])),
	]));
}

/* ------------------------------------------------------------------ *
 * Step 3 - Background
 * ------------------------------------------------------------------ */

/**
 * The languages section.
 *
 * It lives on the Background step because that is where languages come from in
 * both editions -- 2014 through species and background, 2024 through the origin
 * rules that the background step already explains.
 *
 * Every grant is listed with where it came from, and a language already known
 * cannot be chosen again: taking Elvish twice because the species gave it and
 * the background offered it is the classic wasted pick.
 */
function languageSection(ctx) {
	const { session } = ctx;
	const char = session.character;
	const state = rules.languages(char);

	const pool = (db.reference?.languages ?? [])
		.filter((l) => !l.edition || l.edition === (char.edition ?? "2024"))
		// Standard languages first; the rare and exotic ones still appear, since a
		// DM may well allow them.
		.sort((a, b) => {
			const rank = (x) => (x.type === "standard" ? 0 : x.type === "rare" || x.type === "exotic" ? 1 : 2);
			return rank(a) - rank(b) || a.name.localeCompare(b.name);
		});

	const known = new Set(state.known.map((l) => l.name.toLowerCase()));

	const nodes = [
		// What is already spoken, and why.
		el("div.lang-known", {}, state.known.length
			? state.known.map((l) =>
				el("span.lang-chip", {}, [
					refLink(l.name, `language|${l.name}|`),
					el("span.lang-chip__src", { text: l.source }),
				]))
			: [el("span.muted", { text: "None yet." })]),
	];

	// One picker per outstanding grant.
	for (const grant of state.pending) {
		const picked = grant.bucket.startsWith("feat:")
			? (char.languageChoices?.feat?.[grant.bucket.slice(5)] ?? [])
			: (char.languageChoices?.[grant.bucket] ?? []);

		const write = (ids) => {
			session.update((c) => {
				const lc = { ...(c.languageChoices ?? {}) };
				if (grant.bucket.startsWith("feat:")) {
					lc.feat = { ...(lc.feat ?? {}), [grant.bucket.slice(5)]: ids };
				} else {
					lc[grant.bucket] = ids;
				}
				return { ...c, languageChoices: lc };
			});
			ctx.rerender();
		};

		nodes.push(section(
			`${grant.source}: choose ${grant.total} language${grant.total === 1 ? "" : "s"}`,
			grant.count < grant.total
				? `${grant.count} still to choose.`
				: null,
			choiceList({
				options: pool.map((l) => ({
					id: l.name,
					label: l.name,
					hint: known.has(l.name.toLowerCase()) && !picked.includes(l.name)
						? "already known"
						: (l.type ?? ""),
				})),
				selected: picked,
				max: grant.total,
				// Known languages are shown greyed rather than hidden, so it is clear
				// why they cannot be taken again.
				disabledIds: new Set(
					[...known]
						.map((lower) => pool.find((l) => l.name.toLowerCase() === lower)?.name)
						.filter((nm) => nm && !picked.includes(nm)),
				),
				onChange: write,
				onInfo: (opt) => showReference(`language|${opt.label}|`),
			}),
		));
	}

	if (!state.pending.length) {
		nodes.push(el("p.muted", { text: "Nothing left to choose." }));
	}

	return nodes;
}

const backgroundStep = {
	id: "background",
	title: "Background",
	blurb: "Your life before adventuring, and the skills it left you.",

	render(ctx) {
		const { session } = ctx;
		const char = session.character;
		const list = filterEntries(db.backgrounds, pickerOpts(char))
			.sort((a, b) => a.name.localeCompare(b.name));
		const selected = getBackground(char.backgroundId);

		const nodes = [
			section("Choose a background",
				char.edition === "2024"
					? "In the 2024 rules this grants your ability score increases, an origin feat, two skills and a tool."
					: "This grants skills, tools and a little starting equipment.",
				el("div.pick-grid", {}, list.map((bg) =>
					card({
						title: bg.name,
						subtitle: (bg.skillProficiencies?.fixed ?? [])
							.map((s) => skillById(s)?.name ?? s).join(", "),
						blurb: bg.blurb,
						meta: [
							bg.feats?.length ? `Feat: ${bg.feats[0].name}` : null,
							bg.ability?.choices?.length ? "Ability increases" : null,
							bg.srd ? "SRD" : bg.source,
						].filter(Boolean),
						selected: char.backgroundId === bg.id,
						onSelect: () => {
							// The background's skills are a fixed grant derived from the
							// data, so nothing is stored for them -- and the class and
							// species picks are left exactly as they were.
							session.update((c) => ({
								...c,
								backgroundId: bg.id,
								abilityBonuses: { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 },
								abilityAssignment: {},
								equipment: [],
							}));
							ctx.rerender();
						},
						onInfo: () => modal(bg.name, el("div", {}, [
							el("p.muted", { text: bg.source }),
							rulesHtml(bg.html),
						])),
					}),
				)),
			),
		];

		if (selected) {
			const granted = selected.skillProficiencies?.fixed ?? [];
			if (granted.length) {
				nodes.push(section("Granted skills", null,
					el("div.chip-row", {}, granted.map((s) =>
						el("span.chip.chip--granted", { text: skillById(s)?.name ?? s }),
					)),
				));
			}

			const toolNodes = toolProficiencySections(ctx, selected);
			if (toolNodes.length) nodes.push(...toolNodes);

			// The origin feat is granted outright, so it is shown in full rather
			// than hidden behind a chip: it is part of the character now.
			if (selected.feats?.length) {
				nodes.push(section("Origin feat",
					"Granted automatically by this background. It already counts toward your character.",
					selected.feats.map((f) => {
						const feat = db.feats.find(
							(x) => x.name === f.name && x.edition === (char.edition ?? "2024"),
						) ?? db.feats.find((x) => x.name === f.name);

						if (!feat) {
							return notice(`${f.name} is not in the loaded database, so its text cannot be shown.`, "warn");
						}
						return el("div.trait", {}, [
							el("h4.trait__name", { text: feat.name }),
							feat.prerequisite && el("p.muted", { text: `Requires ${feat.prerequisite}` }),
							rulesHtml(feat.html),
						].filter(Boolean));
					}),
				));
			}
		}

		// Languages are part of your origin in both editions, so they belong here
		// rather than on a step of their own.
		nodes.push(section("Languages",
			(char.edition ?? "2024") === "2024"
				? "Every character speaks Common plus two more languages of their choice. Species and backgrounds grant no languages under the 2024 rules."
				: "Your species and background decide these.",
			languageSection(ctx)));

		return nodes;
	},

	isComplete: (char) => Boolean(char.backgroundId),
};

const titleCase = (s) => String(s).replace(/\b\w/g, (c) => c.toUpperCase()).replace(/-/g, " ");

/**
 * Tool grants come in two shapes: a named tool the background simply gives you,
 * and a category pick such as "any Gaming Set". The category members live in the
 * itemGroups table of reference.json, so that file is pulled on demand.
 */
function toolProficiencySections(ctx, owner) {
	const { session } = ctx;
	const char = session.character;
	const fixed = owner.toolProficiencies?.fixed ?? [];
	const choices = owner.toolProficiencies?.choices ?? [];
	const out = [];

	if (fixed.length) {
		out.push(section("Tool proficiency", null,
			el("div.chip-row", {}, fixed.map((t) => el("span.chip.chip--granted", { text: t }))),
		));
	}

	for (const choice of choices) {
		if (choice.from !== "category" || !choice.category) continue;

		const host = el("div.async-slot", {}, [el("p.muted", { text: "Loading options…" })]);
		out.push(section(`${choice.category} proficiency`, `Choose ${choice.count ?? 1}.`, host));

		(async () => {
			const ref = await ensure("reference");
			const group = (ref.itemGroups ?? []).find(
				(g) => g.name.toLowerCase() === choice.category.toLowerCase()
					&& g.edition === (char.edition ?? "2024"),
			) ?? (ref.itemGroups ?? []).find(
				(g) => g.name.toLowerCase() === choice.category.toLowerCase(),
			);

			if (!group?.members?.length) {
				host.replaceChildren(notice(`No ${choice.category} options found in the loaded data.`, "warn"));
				return;
			}

			const memberNames = group.members.map((m) => m.name);
			const picked = (char.toolProficiencies ?? []).filter((t) => memberNames.includes(t));

			host.replaceChildren(choiceList({
				options: group.members.map((m) => ({ id: m.name, label: m.name })),
				selected: picked,
				max: choice.count ?? 1,
				onChange: (names) => {
					const others = (char.toolProficiencies ?? []).filter((t) => !memberNames.includes(t));
					session.update((c) => ({ ...c, toolProficiencies: [...others, ...names] }));
					ctx.rerender();
				},
				onInfo: (opt) => showReference(`item|${opt.label}|`),
			}));
		})();
	}

	return out;
}

/* ------------------------------------------------------------------ *
 * Step 4 - Ability scores
 * ------------------------------------------------------------------ */

const abilitiesStep = {
	id: "abilities",
	title: "Abilities",
	blurb: "The six numbers everything else derives from.",

	render(ctx) {
		const { session } = ctx;
		const char = session.character;
		const methods = db.rules?.abilityScoreMethods ?? [];
		const method = methods.find((m) => m.id === char.abilityMethod) ?? methods[0];
		const abilities = db.rules?.abilities ?? [];

		const nodes = [
			section("How do you want to generate scores?", null,
				el("div.pick-grid.pick-grid--compact", {}, methods.map((m) =>
					card({
						title: m.name,
						blurb: m.desc,
						selected: char.abilityMethod === m.id,
						onSelect: () => {
							session.update({
								abilityMethod: m.id,
								baseAbilities: m.id === "point-buy"
									? { str: 8, dex: 8, con: 8, int: 8, wis: 8, cha: 8 }
									: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
								rolledScores: [],
							});
							ctx.rerender();
						},
					}),
				)),
			),
		];

		if (method?.id === "standard-array") nodes.push(standardArrayEditor(ctx, method));
		else if (method?.id === "point-buy") nodes.push(pointBuyEditor(ctx, method));
		else if (method?.id === "roll") nodes.push(rollEditor(ctx, method));
		else nodes.push(manualEditor(ctx));

		// Ability increases from background (2024) or species (2014)
		const grants = abilityGrants(char);
		if (grants.length) {
			nodes.push(...grants.map((g) => abilityGrantEditor(ctx, g)));
		}

		// Final totals
		const scores = rules.abilityScores(char);
		const mods = rules.abilityMods(char);
		nodes.push(section("Final scores", null,
			el("div.ability-summary", {}, abilities.map((a) =>
				el("div.ability-summary__cell", {}, [
					el("span.ability-summary__abbr", { text: a.short }),
					el("span.ability-summary__score", { text: scores[a.id] ?? 10 }),
					el("span.ability-summary__mod", { text: rules.formatMod(mods[a.id] ?? 0) }),
				]),
			)),
		));

		return nodes;
	},

	isComplete(char) {
		const grants = abilityGrants(char);
		const assigned = Object.values(char.abilityBonuses ?? {}).reduce((a, b) => a + b, 0);
		const expected = grants.reduce((sum, g) =>
			sum + (g.choices ?? []).reduce((s, c) =>
				s + (c.kind === "weighted" ? (c.weights ?? []).reduce((x, y) => x + y, 0) : (c.count ?? 0) * (c.amount ?? 1)), 0), 0);
		return expected === 0 || assigned === expected;
	},
};

/** Drag-free assignment: each ability gets a dropdown of the remaining values. */
function standardArrayEditor(ctx, method) {
	const { session } = ctx;
	const char = session.character;
	const abilities = db.rules?.abilities ?? [];
	const array = method.array ?? [15, 14, 13, 12, 10, 8];

	const used = abilities
		.map((a) => char.baseAbilities?.[a.id])
		.filter((v) => array.includes(v));

	return section("Assign the standard array",
		`Assign ${array.join(", ")} — one value per ability.`,
		el("div.assign-grid", {}, abilities.map((a) => {
			const current = char.baseAbilities?.[a.id];
			// Values still free, plus whatever this ability already holds.
			const remaining = [...array];
			for (const v of used) {
				if (v === current) continue;
				const i = remaining.indexOf(v);
				if (i !== -1) remaining.splice(i, 1);
			}

			return field(a.name,
				el("select.assign-select", {
					onchange: (e) => {
						const val = e.target.value === "" ? 10 : Number(e.target.value);
						session.update((c) => ({
							...c,
							baseAbilities: { ...c.baseAbilities, [a.id]: val },
						}));
						ctx.rerender();
					},
				}, [
					el("option", { value: "", text: "—", selected: !array.includes(current) }),
					...[...new Set(remaining)].sort((x, y) => y - x).map((v) =>
						el("option", { value: v, text: v, selected: v === current }),
					),
				]),
			);
		})),
	);
}

function pointBuyEditor(ctx, method) {
	const { session } = ctx;
	const char = session.character;
	const abilities = db.rules?.abilities ?? [];
	const cost = method.cost ?? {};
	const budget = method.points ?? 27;

	const spent = abilities.reduce(
		(sum, a) => sum + (cost[String(char.baseAbilities?.[a.id] ?? 8)] ?? 0), 0,
	);
	const left = budget - spent;

	return section("Point buy",
		`${left} of ${budget} points remaining. Scores run 8 to 15 before racial or background increases.`,
		el("div.assign-grid", {}, abilities.map((a) => {
			const score = char.baseAbilities?.[a.id] ?? 8;
			const canInc = score < (method.max ?? 15) && (cost[String(score + 1)] - cost[String(score)]) <= left;
			const canDec = score > (method.min ?? 8);

			return el("div.pointbuy-row", {}, [
				el("span.pointbuy-row__label", { text: a.name }),
				el("div.stepper", {}, [
					el("button.stepper__btn", {
						type: "button", text: "−", disabled: !canDec,
						onclick: () => {
							session.update((c) => ({
								...c,
								baseAbilities: { ...c.baseAbilities, [a.id]: score - 1 },
							}));
							ctx.rerender();
						},
					}),
					el("span.stepper__value", { text: score }),
					el("button.stepper__btn", {
						type: "button", text: "+", disabled: !canInc,
						onclick: () => {
							session.update((c) => ({
								...c,
								baseAbilities: { ...c.baseAbilities, [a.id]: score + 1 },
							}));
							ctx.rerender();
						},
					}),
				]),
				el("span.pointbuy-row__cost", { text: `${cost[String(score)] ?? 0} pts` }),
			]);
		})),
	);
}

function rollEditor(ctx) {
	const { session } = ctx;
	const char = session.character;
	const abilities = db.rules?.abilities ?? [];
	const rolled = char.rolledScores ?? [];

	const roll4d6 = () => {
		const dice = Array.from({ length: 4 }, () => 1 + Math.floor(Math.random() * 6))
			.sort((a, b) => b - a);
		return { total: dice[0] + dice[1] + dice[2], dice };
	};

	return section("Roll 4d6, drop the lowest",
		rolled.length ? "Assign your rolls below." : "Roll six sets, then assign them.",
		el("div", {}, [
			el("div.btn-row", {}, [
				el("button.btn.btn--primary", {
					type: "button",
					text: rolled.length ? "Roll again" : "Roll six sets",
					onclick: () => {
						const sets = Array.from({ length: 6 }, roll4d6);
						session.update({
							rolledScores: sets.map((s) => s.total),
							baseAbilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
						});
						toast(`Rolled: ${sets.map((s) => s.total).join(", ")}`);
						ctx.rerender();
					},
				}),
				rolled.length > 0 && el("span.roll-summary", { text: `Rolled: ${rolled.join(", ")}` }),
			]),
			rolled.length > 0 && el("div.assign-grid", {}, abilities.map((a) => {
				const current = char.baseAbilities?.[a.id];
				const used = abilities.map((x) => char.baseAbilities?.[x.id]);
				const remaining = [...rolled];
				for (const v of used) {
					if (v === current) continue;
					const i = remaining.indexOf(v);
					if (i !== -1) remaining.splice(i, 1);
				}
				return field(a.name,
					el("select.assign-select", {
						onchange: (e) => {
							session.update((c) => ({
								...c,
								baseAbilities: { ...c.baseAbilities, [a.id]: Number(e.target.value) || 10 },
							}));
							ctx.rerender();
						},
					}, [
						el("option", { value: "", text: "—" }),
						...remaining.map((v, i) =>
							el("option", { value: v, text: v, selected: v === current && i === remaining.indexOf(current) }),
						),
					]),
				);
			})),
		]),
	);
}

function manualEditor(ctx) {
	const { session } = ctx;
	const char = session.character;
	const abilities = db.rules?.abilities ?? [];

	return section("Enter scores", "Type the six numbers directly.",
		el("div.assign-grid", {}, abilities.map((a) =>
			field(a.name,
				el("input.assign-input", {
					type: "number", min: 1, max: 30,
					value: char.baseAbilities?.[a.id] ?? 10,
					oninput: debounce((e) => {
						session.update((c) => ({
							...c,
							baseAbilities: { ...c.baseAbilities, [a.id]: Number(e.target.value) || 10 },
						}));
						ctx.rerender();
					}, 400),
				}),
			),
		)),
	);
}

/**
 * Recomputes abilityBonuses from every grant's stored assignment.
 *
 * Assignments are kept as { mode, slots } per grant rather than as raw bonuses,
 * because the same ability can receive a bonus from more than one slot and the
 * totals alone cannot be unpicked back into "which dropdown held what".
 */
function recomputeAbilityBonuses(char) {
	const totals = { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 };

	for (const grant of abilityGrants(char)) {
		for (const [ability, value] of Object.entries(grant.fixed ?? {})) {
			totals[ability] = (totals[ability] ?? 0) + value;
		}

		const assignment = char.abilityAssignment?.[grant.from];
		const choice = (grant.choices ?? [])[assignment?.mode ?? 0];
		if (!choice) continue;

		const slots = assignment?.slots ?? [];
		if (choice.kind === "weighted") {
			(choice.weights ?? []).forEach((weight, i) => {
				const ability = slots[i];
				if (ability) totals[ability] = (totals[ability] ?? 0) + weight;
			});
		} else {
			slots.forEach((ability) => {
				if (ability) totals[ability] = (totals[ability] ?? 0) + (choice.amount ?? 1);
			});
		}
	}
	return totals;
}

/**
 * Assign the ability increases a background (2024) or species (2014) grants.
 *
 * A background usually offers two mutually exclusive spreads -- +2/+1 across two
 * abilities, or +1/+1/+1 across three -- so these are presented as a choice of
 * spread first, then one dropdown per point slot.
 */
function abilityGrantEditor(ctx, grant) {
	const { session } = ctx;
	const char = session.character;
	const abilities = db.rules?.abilities ?? [];
	const choices = grant.choices ?? [];

	const assignment = char.abilityAssignment?.[grant.from] ?? { mode: 0, slots: [] };
	const mode = Math.min(assignment.mode ?? 0, Math.max(0, choices.length - 1));
	const choice = choices[mode];
	const slots = assignment.slots ?? [];

	const commit = (next) => {
		session.update((c) => {
			const merged = {
				...c,
				abilityAssignment: { ...(c.abilityAssignment ?? {}), [grant.from]: next },
			};
			return { ...merged, abilityBonuses: recomputeAbilityBonuses(merged) };
		});
		ctx.rerender();
	};

	const nodes = [];

	// Fixed bonuses are not chosen, just shown.
	const fixed = Object.entries(grant.fixed ?? {});
	if (fixed.length) {
		nodes.push(el("div.chip-row", {}, fixed.map(([k, v]) =>
			el("span.chip.chip--granted", { text: `${k.toUpperCase()} ${rules.formatMod(v)}` }),
		)));
	}

	// Spread selector, when the grant offers more than one.
	if (choices.length > 1) {
		nodes.push(el("div.btn-row", {}, choices.map((c, i) =>
			el("button.toggle-btn", {
				type: "button",
				class: i === mode ? "is-active" : "",
				text: describeSpread(c),
				onclick: () => commit({ mode: i, slots: [] }),
			}),
		)));
	}

	if (!choice) {
		return section(`Ability increases from your ${grant.from}`, grant.label, nodes);
	}

	// House rule: many tables let you put the increases on any ability rather
	// than the three the background prints.
	const freeAssignment = Boolean(char.houseRules?.freeAbilityAssignment);
	const pool = freeAssignment
		? abilities.map((a) => a.id)
		: (choice.from?.length ? choice.from : abilities.map((a) => a.id));
	const slotCount = choice.kind === "weighted"
		? (choice.weights ?? []).length
		: (choice.count ?? 1);

	nodes.push(el("div.assign-grid", {}, Array.from({ length: slotCount }, (_, i) => {
		const weight = choice.kind === "weighted" ? choice.weights[i] : (choice.amount ?? 1);
		return field(`${rules.formatMod(weight)} to`,
			el("select.assign-select", {
				onchange: (e) => {
					const next = [...slots];
					next[i] = e.target.value || null;
					commit({ mode, slots: next });
				},
			}, [
				el("option", { value: "", text: "—", selected: !slots[i] }),
				...pool.map((id) => {
					const a = abilities.find((x) => x.id === id);
					// The same ability cannot take two slots from one grant.
					const takenElsewhere = slots.some((s, j) => s === id && j !== i);
					return el("option", {
						value: id,
						text: a?.name ?? id,
						disabled: takenElsewhere,
						selected: slots[i] === id,
					});
				}),
			]),
		);
	})));

	const assigned = slots.filter(Boolean).length;
	if (assigned < slotCount) {
		nodes.push(el("p.muted", { text: `${slotCount - assigned} still to assign.` }));
	}

	// The toggle sits here because this is where the restriction is felt.
	nodes.push(el("label.house-rule-toggle", {}, [
		el("input", {
			type: "checkbox",
			checked: freeAssignment,
			onchange: (e) => {
				session.update((c) => ({
					...c,
					houseRules: { ...(c.houseRules ?? {}), freeAbilityAssignment: e.target.checked },
					// The old picks may point at abilities outside the new pool.
					abilityAssignment: {},
					abilityBonuses: { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 },
				}));
				ctx.rerender();
			},
		}),
		el("span", {
			text: `House rule: put these increases on any ability, not just ${
				(choice.from ?? []).map((a) => a.toUpperCase()).join(", ") || "the listed ones"
			}`,
		}),
	]));

	return section(`Ability increases from your ${grant.from}`, grant.label, nodes);
}

/** "+2 / +1" or "+1 to three abilities", for the spread selector buttons. */
function describeSpread(choice) {
	if (choice.kind !== "weighted") {
		return `${rules.formatMod(choice.amount ?? 1)} to ${choice.count ?? 1}`;
	}
	const weights = choice.weights ?? [];
	if (weights.length === 3 && weights.every((w) => w === 1)) return "+1 / +1 / +1";
	return weights.map((w) => rules.formatMod(w)).join(" / ");
}


/* ------------------------------------------------------------------ *
 * Step 5 - Equipment
 * ------------------------------------------------------------------ */

const equipmentStep = {
	id: "equipment",
	title: "Equipment",
	blurb: "What you carry into the first room.",

	render(ctx) {
		const { session } = ctx;
		const char = session.character;
		const cls = getClass(classEntry(char)?.classId);
		const bg = getBackground(char.backgroundId);
		const nodes = [];

		const applyPack = (source, option) => {
			const items = (option.items ?? []).map((it) => {
				const item = getItemByRef(it.ref, char.edition);
				return {
					itemId: item?.id ?? null,
					name: item?.name ?? it.name,
					quantity: it.quantity ?? 1,
					equipped: Boolean(item?.armor || item?.weapon),
					source,
				};
			});
			session.update((c) => ({
				...c,
				equipment: [...(c.equipment ?? []).filter((e) => e.source !== source), ...items],
				currency: { ...c.currency, gp: (c.currency?.gp ?? 0) + (option.gold ?? 0) },
				equipmentChoice: { ...(c.equipmentChoice ?? {}), [source]: option.key },
			}));
			ctx.rerender();
		};

		for (const [source, owner] of [["class", cls], ["background", bg]]) {
			const options = owner?.startingEquipment;
			if (!options?.length) continue;

			nodes.push(section(`${owner.name} equipment`, "Choose one option.",
				el("div.pick-grid.pick-grid--compact", {}, options.map((opt) =>
					card({
						title: `Option ${opt.key}`,
						blurb: [
							...(opt.items ?? []).map((i) => (i.quantity > 1 ? `${i.name} x${i.quantity}` : i.name)),
							opt.gold ? gp(opt.gold) : null,
						].filter(Boolean).join(", ") || "Nothing",
						selected: char.equipmentChoice?.[source] === opt.key,
						onSelect: () => applyPack(source, opt),
					}),
				)),
			));
		}

		// Current inventory
		nodes.push(section("Your pack",
			`${(char.equipment ?? []).length} items · ${rules.totalWeight(char).toFixed(1)} lb of ${rules.carryingCapacity(char).capacity} lb capacity`,
			el("div.inventory", {}, [
				...(char.equipment ?? []).map((entry, i) =>
					el("div.inventory__row", {}, [
						el("input.inventory__qty", {
							type: "number", min: 1, value: entry.quantity ?? 1,
							oninput: (e) => {
								const q = Math.max(1, Number(e.target.value) || 1);
								session.update((c) => {
									const next = [...c.equipment];
									next[i] = { ...next[i], quantity: q };
									return { ...c, equipment: next };
								});
								ctx.rerender();
							},
						}),
						el("span.inventory__name", {}, [itemLink(entry.name)]),
						el("label.inventory__equip", {}, [
							el("input", {
								type: "checkbox", checked: Boolean(entry.equipped),
								onchange: (e) => {
									session.update((c) => {
										const next = [...c.equipment];
										next[i] = { ...next[i], equipped: e.target.checked };
										return { ...c, equipment: next };
									});
									ctx.rerender();
								},
							}),
							// "In hand" rather than "equipped": Dueling cares whether you
							// are actually holding a second weapon, not whether you own one.
							el("span", { text: itemFor(entry)?.armor || itemFor(entry)?.type === "S" ? "worn" : "in hand" }),
						]),
						// Versatile weapons can be held either way, and that choice
						// changes both the damage die and which styles apply.
						gripControl(ctx, entry, i),
						// Attunement only applies to magic items, and only three at a time.
						entry.magic && el("label.inventory__equip", {}, [
							el("input", {
								type: "checkbox",
								checked: Boolean(entry.attuned),
								disabled: !entry.attuned && attunedCount(char) >= ATTUNEMENT_LIMIT,
								onchange: (e) => {
									session.update((c) => {
										const next = [...c.equipment];
										next[i] = { ...next[i], attuned: e.target.checked };
										return { ...c, equipment: next };
									});
									ctx.rerender();
								},
							}),
							el("span", { text: "attuned" }),
						]),
						// A pack is a shopping convenience: open it up into the things
						// actually inside it.
						isUnpackable(entry) && el("button.inventory__act", {
							type: "button", text: "unpack",
							title: `Replace with its contents: ${packSummary(entry)}`,
							onclick: () => {
								session.update((c) => unpack(c, i));
								toast(`${entry.name} unpacked.`);
								ctx.rerender();
							},
						}),

						// "A Holy Symbol" needs to become an Amulet, Emblem or Reliquary.
						itemFor(entry)?.isGroup && el("button.inventory__act", {
							type: "button", text: "choose",
							title: `Pick which ${entry.name} you carry`,
							onclick: () => groupChoiceDialog(session, i, () => ctx.rerender()),
						}),

						el("button.inventory__act", {
							type: "button", text: "sell",
							title: itemValueGp(entry)
								? `Listed at ${itemValueGp(entry)} gp each`
								: "No listed price; sell at a figure you set",
							onclick: () => sellDialog(session, i, () => ctx.rerender()),
						}),

						el("button.inventory__remove", {
							type: "button", text: "×", title: "Remove without selling",
							onclick: () => {
								session.update((c) => ({
									...c,
									equipment: c.equipment.filter((_, j) => j !== i),
								}));
								ctx.rerender();
							},
						}),
					]),
				),
				!(char.equipment ?? []).length && el("p.muted", { text: "Nothing yet. Pick a pack above or add items below." }),
			]),
		));

		nodes.push(section("Add an item", null, itemSearch(ctx)));
		nodes.push(section("Magic items and full item list",
			"Searches everything, magic and mundane, across both editions. Attuned items are capped at three.",
			magicItemSearch(ctx)));

		nodes.push(section("Items your DM invented",
			"Anything made here belongs to this character, and behaves like a printed item: it can be equipped, attacked with, sold, and its uses are tracked with your class features.",
			customItemList(session, () => ctx.rerender())));

		nodes.push(section("Money", null,
			el("div.currency-row", {}, (db.rules?.currencies ?? []).map((cur) =>
				field(cur.name,
					el("input.currency-input", {
						type: "number", min: 0,
						value: char.currency?.[cur.id] ?? 0,
						oninput: (e) => {
							session.update((c) => ({
								...c,
								currency: { ...c.currency, [cur.id]: Number(e.target.value) || 0 },
							}));
						},
					}),
				),
			)),
		));

		return nodes;
	},

	isComplete: () => true,
};

/** Resolve the catalogue item behind an inventory row. */
const itemFor = (entry) => (entry?.itemId ? getItem(entry.itemId) : null);

/**
 * One/two-handed selector, shown only for weapons where it is a real choice.
 * A Two-Handed weapon has no choice; a Versatile one does, and that decision
 * drives the damage die as well as Dueling and Great Weapon Fighting.
 */
function gripControl(ctx, entry, index) {
	const { session } = ctx;
	const item = itemFor(entry);
	if (!item?.weapon || !entry.equipped) return null;

	const props = (item.properties ?? []).map((p) => p.toLowerCase());
	if (!props.includes("versatile")) return null;

	const hasShield = rules.shieldInHand(session.character);
	const grip = rules.gripFor(entry, item, { hasShield });

	return el("div.grip-toggle", {}, [
		...["one-handed", "two-handed"].map((option) => {
			// A shield fills the off hand, so two-handed is not a real option.
			const blocked = hasShield && option === "two-handed";
			return el("button.grip-toggle__btn", {
				type: "button",
				class: [grip === option ? "is-active" : "", blocked ? "is-blocked" : ""].filter(Boolean).join(" "),
				disabled: blocked,
				text: option === "one-handed" ? `1H ${item.damage}` : `2H ${item.versatileDamage}`,
				title: blocked
					? "Not while a shield is in your off hand"
					: option === "one-handed"
						? "Held in one hand: leaves a hand free and enables Dueling"
						: "Held in two hands: bigger damage die and enables Great Weapon Fighting",
				onclick: () => {
					session.update((c) => {
						const next = [...c.equipment];
						next[index] = { ...next[index], grip: option };
						return { ...c, equipment: next };
					});
					ctx.rerender();
				},
			});
		}),
		hasShield && el("span.grip-toggle__note", { text: "shield in off hand" }),
	].filter(Boolean));
}

/** Type-ahead over the equipment list. */
function itemSearch(ctx) {
	const { session } = ctx;
	const char = session.character;
	const results = el("div.search-results");
	const input = el("input.search-input", {
		type: "search",
		placeholder: "Search weapons, armour, gear…",
		oninput: debounce((e) => run(e.target.value), 200),
	});

	const run = (query) => {
		const q = query.trim().toLowerCase();
		if (q.length < 2) { results.replaceChildren(); return; }

		const pool = filterEntries(db.equipment, editionOpts(char));
		const hits = pool.filter((i) => i.name.toLowerCase().includes(q)).slice(0, 25);

		results.replaceChildren(...hits.map((item) =>
			el("button.search-hit", {
				type: "button",
				onclick: () => {
					session.update((c) => ({
						...c,
						equipment: [...(c.equipment ?? []), {
							itemId: item.id,
							name: item.name,
							quantity: 1,
							equipped: false,
							source: "manual",
						}],
					}));
					toast(`Added ${item.name}`);
					ctx.rerender();
				},
			}, [
				el("span.search-hit__name", { text: item.name }),
				el("span.search-hit__meta", {
					text: [
						item.damage ? `${item.damage} ${item.damageType ?? ""}`.trim() : null,
						item.ac ? `AC ${item.ac}` : null,
						item.costGp != null ? gp(item.costGp) : null,
						item.weight ? `${item.weight} lb` : null,
					].filter(Boolean).join(" · "),
				}),
			]),
		));
		if (!hits.length) results.replaceChildren(el("p.muted", { text: "No matches." }));
	};

	return el("div", {}, [input, results]);
}

/**
 * Magic item search. Kept separate from the mundane gear search because the
 * magic list is ~2400 entries and lives in its own lazily-loaded file, and
 * because attunement needs tracking: a character can attune to three items.
 */
function magicItemSearch(ctx) {
	const { session } = ctx;
	const host = el("div.async-slot", {}, [
		el("button.btn", {
			type: "button",
			text: "Load magic items",
			onclick: async (e) => {
				e.target.replaceWith(el("p.muted", { text: "Loading…" }));
				await Promise.all([ensure("magic-items"), ensure("magic-variants")]);
				host.replaceChildren(buildMagicSearch(ctx));
			},
		}),
	]);
	// Already loaded from an earlier visit to this step.
	if (db.magicItems) host.replaceChildren(buildMagicSearch(ctx));
	return host;
}

const ATTUNEMENT_LIMIT = 3;

function attunedCount(char) {
	return (char.equipment ?? []).filter((e) => e.attuned).length;
}

function buildMagicSearch(ctx) {
	const { session } = ctx;
	const char = session.character;
	const results = el("div.search-results");

	const attuned = attunedCount(char);
	const status = el("p.muted", {
		text: `Attuned to ${attuned} of ${ATTUNEMENT_LIMIT} items.`,
	});

	const run = (query) => {
		const q = query.trim().toLowerCase();
		if (q.length < 2) { results.replaceChildren(); return; }

		// Magic items are searched across BOTH editions on purpose: a 2024
		// character still uses the 2014 DMG items, and most tables mix them.
		const hits = db.magicItems
			.filter((i) => i.name.toLowerCase().includes(q))
			.slice(0, 30);

		results.replaceChildren(...hits.map((item) =>
			el("button.search-hit", {
				type: "button",
				onclick: () => {
					session.update((c) => ({
						...c,
						equipment: [...(c.equipment ?? []), {
							itemId: item.id,
							name: item.name,
							quantity: 1,
							equipped: false,
							attuned: false,
							magic: true,
							source: "manual",
						}],
					}));
					toast(`Added ${item.name}`);
					ctx.rerender();
				},
			}, [
				el("span.search-hit__name", { text: item.name }),
				el("span.search-hit__meta", {
					text: [
						item.rarity,
						item.reqAttune ? "attunement" : null,
						item.typeName,
						item.source,
					].filter(Boolean).join(" · "),
				}),
				el("span.pick-card__info", {
					role: "button", tabindex: "0", text: "read",
					onclick: (e) => {
						e.stopPropagation();
						modal(item.name, el("div", {}, [
							el("p.muted", {
								text: [item.rarity, item.reqAttune ? "requires attunement" : null, item.source]
									.filter(Boolean).join(" · "),
							}),
							rulesHtml(itemDescription(item)),
						]));
					},
				}),
			]),
		));
		if (!hits.length) results.replaceChildren(el("p.muted", { text: "No matches." }));
	};

	return el("div", {}, [
		status,
		el("input.search-input", {
			type: "search",
			placeholder: "Search magic items…",
			oninput: debounce((e) => run(e.target.value), 200),
		}),
		results,
	]);
}

/* ------------------------------------------------------------------ *
 * Step 6 - Spells
 * ------------------------------------------------------------------ */

const spellsStep = {
	id: "spells",
	title: "Spells",
	blurb: "Your cantrips and prepared spells, per casting class.",

	isRelevant(char) {
		return Boolean(rules.spellcasting(char));
	},

	render(ctx) {
		// Render synchronously whenever the spell file is already cached, which it
		// is on every re-render after the first. An async placeholder would leave
		// the step momentarily empty, and a container with no content cannot hold
		// a scroll position -- so picking a spell would jump the page to the top.
		if (db.spells) return buildSpellStep(ctx, db.spells);

		const host = el("div", {}, [el("p.muted", { text: "Loading spells…" })]);
		(async () => {
			const spells = await ensure("spells");
			host.replaceChildren(...buildSpellStep(ctx, spells));
		})();
		return [host];
	},

	isComplete(char) {
		const sc = rules.spellcasting(char);
		if (!sc) return true;
		// Complete once every class has filled its cantrip and prepared quota.
		return sc.classes.every((c) => {
			const chosen = rules.classSpells(char, c.classId);
			const cantripsOk = c.cantripsKnown == null || chosen.cantrips.length >= c.cantripsKnown;
			const limit = c.preparedLimit ?? c.spellsKnownLimit;
			const preparedOk = limit == null || chosen.prepared.length >= limit;
			const bookOk = c.spellbookLimit == null || chosen.known.length > 0;
			return cantripsOk && preparedOk && bookOk;
		});
	},
};

/** Builds the Spells step. Split out so it can run synchronously once cached. */
function buildSpellStep(ctx, spells) {
	const char = ctx.session.character;
	const sc = rules.spellcasting(char);
	if (!sc) return [notice("This character has no spellcasting.", "warn")];

	const nodes = [
		slotOverview(sc),
		...spellVariantSections(ctx),
		grantedSpellSection(char),
	].filter(Boolean);

	// One block per casting class, each with its own limits and list.
	for (const caster of sc.classes) {
		nodes.push(...classSpellSection(ctx, spells, caster, sc));
	}
	return nodes.filter(Boolean);
}

/** Shared slot pool, shown once above the per-class lists. */
function slotOverview(sc) {
	const rows = [];

	if (sc.slots.length) {
		rows.push(el("div.slot-row", {}, sc.slots.map((n, i) =>
			el("div.slot-box", {}, [
				el("span.slot-box__level", { text: `L${i + 1}` }),
				el("span.slot-box__count", { text: n }),
			]),
		)));
	}

	if (sc.pact) {
		rows.push(el("p.muted", {
			text: `Pact Magic (${sc.pact.className}): ${sc.pact.count} slot${sc.pact.count === 1 ? "" : "s"} `
				+ `at level ${sc.pact.level}, recovered on a Short Rest. This is a separate pool.`,
		}));
	}

	const hint = sc.multiclass
		? `Multiclassed caster: effective caster level ${sc.effectiveCasterLevel}. `
			+ "Slots are shared across all your casting classes, but each class prepares from its own list."
		: "Slots refresh on a Long Rest.";

	return section("Spell slots", hint, rows.length ? rows : notice("No spell slots at this level.", "warn"));
}

/**
 * Picks between the variants of a subclass's granted spell list.
 *
 * The 2024 Circle of the Land grants a different set per terrain, so until a
 * terrain is chosen the app cannot say which spells the Druid actually has.
 */
function spellVariantSections(ctx) {
	const { session } = ctx;
	const char = session.character;

	return rules.spellVariantChoices(char).map((choice) =>
		section(`${choice.sourceName} spell list`,
			"Choose which list applies. It decides the spells you always have prepared.",
			[
				!choice.chosen && notice("Not chosen yet, so no spells are granted.", "warn"),
				el("div.btn-row", {}, choice.variants.map((name) =>
					el("button.toggle-btn", {
						type: "button",
						class: choice.chosen === name ? "is-active" : "",
						text: name,
						onclick: () => {
							session.update((c) => ({
								...c,
								spellVariants: { ...(c.spellVariants ?? {}), [choice.classId]: name },
							}));
							ctx.rerender();
						},
					}),
				)),
			].filter(Boolean),
		),
	);
}

/**
 * Spells the character already has for free, with a clickable source badge.
 *
 * This sits above the pickers deliberately: seeing "Prestidigitation (S)" here
 * first is what stops a player spending one of their own cantrip picks on a
 * spell their species already gave them.
 */
function grantedSpellSection(char) {
	const granted = rules.grantedSpells(char);
	if (!granted.length) return null;

	const available = granted.filter((g) => g.available);
	const later = granted.filter((g) => !g.available);

	const row = (g) => el("span.granted-spell", {}, [
		el("button.spell-link", {
			type: "button", text: g.name, title: `Read ${g.name}`,
			onclick: () => showSpell(g.id ?? g.name),
		}),
		// The badge names the origin and opens it.
		g.ref && el("button.granted-spell__badge", {
			type: "button",
			text: sourceBadge(g.ref),
			title: `From ${g.source} — click to read`,
			onclick: () => showReference(g.ref),
		}),
		el("span.granted-spell__from", {
			text: grantLabel(g),
		}),
	].filter(Boolean));

	return section("Spells you already have",
		"Granted by your species, background, feats, or your domain, oath or circle. "
		+ "These do not count against your cantrips known or prepared limits, so you "
		+ "do not need to pick them again. S species · B background · F feat · D subclass.",
		[
			available.length > 0 && el("div.granted-list", {}, available.map(row)),
			later.length > 0 && el("div", {}, [
				el("p.muted", { text: "Unlocks as you level:" }),
				el("div.granted-list", {}, later.map((g) => el("span.granted-spell.is-locked", {}, [
					el("span.spell-link", { text: g.name }),
					el("span.granted-spell__from", { text: `${g.source} · level ${g.unlockLevel}` }),
				]))),
			]),
		].filter(Boolean),
	);
}

/**
 * A one-letter badge for where a granted spell came from.
 *   S species · B background · F feat · C class · D subclass (domain/oath/circle)
 */
function sourceBadge(ref) {
	const tag = String(ref ?? "").split("|")[0];
	if (tag === "race") return "S";
	if (tag === "feat") return "F";
	if (tag === "background") return "B";
	if (tag === "class") return "C";
	if (tag === "subclassFeature" || tag === "classFeature") return "D";
	return "?";
}

/** "Life Domain" or "Fey Wanderer · 1/day each", so the terms are not lost. */
function grantLabel(g) {
	const extras = [
		g.kind && g.kind !== "prepared" ? g.kind : null,
		g.note ?? null,
	].filter(Boolean);
	return extras.length ? `${g.source} · ${extras.join(" ")}` : g.source;
}

/** Cantrip and spell pickers for one casting class. */
function classSpellSection(ctx, allSpells, caster, sc) {
	const { session } = ctx;
	const char = session.character;
	const classSlug = caster.className.toLowerCase();

	const pool = filterEntries(allSpells, editionOpts(char))
		.filter((sp) => (sp.classes ?? []).includes(classSlug));

	const chosen = rules.classSpells(char, caster.classId);
	const nodes = [];

	const title = caster.subclassName
		? `${caster.className} (${caster.subclassName})`
		: caster.className;

	nodes.push(section(`${title} spellcasting`, null,
		el("div.stat-strip", {}, [
			statBox("Save DC", caster.saveDc),
			statBox("Attack", rules.formatMod(caster.attackBonus)),
			statBox("Ability", caster.ability.toUpperCase()),
			caster.cantripsKnown != null && statBox("Cantrips", `${chosen.cantrips.length}/${caster.cantripsKnown}`),
			caster.spellbookLimit != null
				&& statBox("Spellbook", `${chosen.known.length}/${caster.spellbookLimit}`),
			(caster.preparedLimit ?? caster.spellsKnownLimit) != null
				&& statBox(caster.preparedLimit != null ? "Prepared" : "Known",
					`${chosen.prepared.length}/${caster.preparedLimit ?? caster.spellsKnownLimit}`),
		].filter(Boolean)),
	));

	if (!pool.length) {
		nodes.push(notice(`No ${caster.className} spells found in the ${char.edition} data.`, "warn"));
		return nodes;
	}

	// Cantrips are always available and do not use slots.
	const cantrips = pool.filter((sp) => sp.level === 0);
	if (cantrips.length && caster.cantripsKnown) {
		nodes.push(spellPicker(ctx, {
			classId: caster.classId,
			bucket: "cantrips",
			title: `${caster.className} cantrips`,
			limit: caster.cantripsKnown,
			spells: cantrips,
			hint: "Always available, and they do not spend a slot.",
		}));
	}

	// Levelled spells, capped at the highest slot level available.
	const maxLevel = Math.max(
		sc.slots.length,
		sc.pact && caster.isPact ? sc.pact.level : 0,
	);
	const levelled = pool.filter((sp) => sp.level > 0 && sp.level <= Math.max(1, maxLevel));
	const limit = caster.preparedLimit ?? caster.spellsKnownLimit;

	// A Wizard learns spells into a spellbook first and prepares only from it.
	// Every other class prepares straight from the class list.
	if (caster.spellbookLimit != null) {
		nodes.push(spellPicker(ctx, {
			classId: caster.classId,
			bucket: "known",
			title: `${caster.className} ${caster.spellbookLabel?.toLowerCase() ?? "spellbook"}`,
			limit: caster.spellbookLimit,
			spells: levelled,
			hint: `Spells written in your book. You start with ${
				caster.levels === 1 ? "six" : "six plus two per level"
			}, and can only prepare from these.`,
		}));

		const inBook = new Set(chosen.known);
		const preparable = levelled.filter((sp) => inBook.has(sp.id));

		nodes.push(spellPicker(ctx, {
			classId: caster.classId,
			bucket: "prepared",
			title: `${caster.className} prepared spells`,
			limit,
			spells: preparable,
			hint: preparable.length
				? "Chosen from your spellbook. Swap these on a Long Rest."
				: "Add spells to your spellbook first.",
			emptyMessage: "Nothing in your spellbook yet — pick some above.",
		}));

		return nodes;
	}

	nodes.push(spellPicker(ctx, {
		classId: caster.classId,
		bucket: "prepared",
		title: caster.preparedLimit != null
			? `${caster.className} prepared spells`
			: `${caster.className} spells known`,
		limit,
		spells: levelled,
		hint: maxLevel
			? `Up to level ${maxLevel}. Grouped by spell level.`
			: "No levelled slots yet.",
	}));

	return nodes;
}

/**
 * Grouped, collapsible spell picker with a hard limit.
 *
 * Selections are stored per class so a multiclassed caster's lists never mix,
 * and the limit is enforced rather than merely displayed: over-selecting is the
 * single easiest way to build an illegal character by accident.
 */
function spellPicker(ctx, { classId, bucket, title, limit, spells, hint, emptyMessage }) {
	const { session } = ctx;
	const char = session.character;
	const chosen = rules.classSpells(char, classId)[bucket] ?? [];
	const atLimit = limit != null && chosen.length >= limit;

	if (!spells.length) {
		return section(title, hint, notice(emptyMessage ?? "Nothing available here yet.", "warn"));
	}

	const byLevel = new Map();
	for (const sp of spells) {
		if (!byLevel.has(sp.level)) byLevel.set(sp.level, []);
		byLevel.get(sp.level).push(sp);
	}

	// Spells already granted for free by a species, feat, domain or oath. Choosing
	// one again spends a pick on something you already have.
	const grantedElsewhere = new Map();
	for (const g of rules.grantedSpells(char)) {
		if (g.available) grantedElsewhere.set(g.id, g.source);
	}

	const toggle = (id) => {
		const current = rules.classSpells(char, classId)[bucket] ?? [];
		const has = current.includes(id);
		if (!has && grantedElsewhere.has(id)) {
			toast(`${grantedElsewhere.get(id)} already grants this.`);
			return;
		}
		if (!has && limit != null && current.length >= limit) {
			toast(`You can only have ${limit}. Remove one first.`);
			return;
		}
		const next = has ? current.filter((x) => x !== id) : [...current, id];
		session.update((c) => {
			const bucketState = { ...(c.spellsByClass?.[classId] ?? {}), [bucket]: next };
			// Removing a spell from the spellbook must also unprepare it, or the
			// sheet would show a prepared spell the character no longer knows.
			if (bucket === "known" && has) {
				bucketState.prepared = (bucketState.prepared ?? []).filter((x) => x !== id);
			}
			return {
				...c,
				spellsByClass: { ...(c.spellsByClass ?? {}), [classId]: bucketState },
			};
		});
		ctx.rerender();
	};

	const header = limit != null
		? `${chosen.length} of ${limit} chosen`
		: `${chosen.length} chosen`;

	return section(title, [hint, header].filter(Boolean).join(" · "), [
		atLimit && notice(`You have reached your limit of ${limit}. Deselect one to swap.`),
		el("div.spell-levels", {}, [...byLevel.entries()]
			.sort((a, b) => a[0] - b[0])
			.map(([level, list]) => {
				const chosenHere = list.filter((sp) => chosen.includes(sp.id)).length;
				return el("details.spell-level", { open: level <= 1 || chosenHere > 0 }, [
					el("summary", {
						text: `${level === 0 ? "Cantrips" : `Level ${level}`}`
							+ ` — ${list.length} available${chosenHere ? `, ${chosenHere} selected` : ""}`,
					}),
					el("div.spell-grid", {}, list
						.sort((a, b) => a.name.localeCompare(b.name))
						.map((sp) => spellChip(
							sp,
							chosen.includes(sp.id),
							atLimit,
							() => toggle(sp.id),
							grantedElsewhere.get(sp.id) ?? null,
						))),
				]);
			})),
	].filter(Boolean));
}

/**
 * One selectable spell, with a shortcut to its full description.
 *
 * `grantedBy` marks a spell the character already has for free. It is shown
 * greyed with its source rather than hidden, so the reason is visible.
 */
function spellChip(sp, isChosen, atLimit, onToggle, grantedBy = null) {
	const blocked = !isChosen && Boolean(grantedBy);
	return el("label.spell-chip", {
		class: [
			isChosen ? "is-chosen" : "",
			blocked ? "is-granted" : "",
			!isChosen && !blocked && atLimit ? "is-disabled" : "",
		].filter(Boolean).join(" "),
		title: blocked
			? `${grantedBy} already grants this spell`
			: [
				sp.concentration ? "Concentration" : null,
				sp.ritual ? "Ritual" : null,
				sp.school,
			].filter(Boolean).join(" · "),
	}, [
		el("input", {
			type: "checkbox",
			checked: isChosen,
			disabled: blocked || (!isChosen && atLimit),
			onchange: onToggle,
		}),
		el("span.spell-chip__name", { text: sp.name }),
		sp.concentration && el("span.spell-chip__tag", { text: "C", title: "Concentration" }),
		sp.ritual && el("span.spell-chip__tag", { text: "R", title: "Ritual" }),
		// Every spell name in the app opens its description.
		infoButton(() => showSpell(sp), sp.name),
	].filter(Boolean));
}

/* ------------------------------------------------------------------ *
 * Step - Forms & Companions
 *
 * Druids pick Wild Shape forms from the Beast stat blocks; Beast Masters and
 * similar subclasses pick a companion stat block. Both are creatures rather
 * than class features, so they get their own step, shown only when the
 * character actually has a feature that calls for one.
 * ------------------------------------------------------------------ */

/** CR is written as a fraction at the table, not a decimal. */
const crLabel = (n) => ({ 0: "0", 0.125: "1/8", 0.25: "1/4", 0.5: "1/2" }[n] ?? String(n));

/** Wild Shape's pool widens as the Druid levels: CR and movement restrictions lift. */
function wildShapeLimits(level) {
	// 2024 Druid: CR 1/4 and no Fly Speed at level 2; swim allowed at 4; fly at 8.
	if (level >= 8) return { maxCr: 1, allowFly: true, allowSwim: true, known: 8 };
	if (level >= 4) return { maxCr: 0.5, allowFly: false, allowSwim: true, known: 6 };
	return { maxCr: 0.25, allowFly: false, allowSwim: false, known: 4 };
}

/** Features whose text points at a companion stat block the player must choose. */
function companionChoices(char) {
	const out = [];
	for (const entry of char.classes ?? []) {
		const cls = getClass(entry.classId);
		if (!cls) continue;
		const level = entry.levels ?? 1;

		const scan = (levels, sourceName) => {
			for (const block of levels ?? []) {
				if (block.level > level) continue;
				for (const f of block.features ?? []) {
					if ((f.creatureRefs ?? []).length > 1) {
						out.push({ feature: f, source: sourceName });
					}
				}
			}
		};

		scan(cls.levels, cls.name);
		const sub = getSubclass(entry.classId, entry.subclassId);
		if (sub) scan(sub.levels, sub.name);
	}
	return out;
}

const hasWildShape = (char) =>
	(char.classes ?? []).some((entry) => {
		const cls = getClass(entry.classId);
		return (cls?.levels ?? []).some(
			(l) => l.level <= (entry.levels ?? 1)
				&& (l.features ?? []).some((f) => /^wild shape$/i.test(f.name)),
		);
	});

const companionsStep = {
	id: "companions",
	title: "Forms & Companions",
	blurb: "The stat blocks you bring to the table alongside your own.",

	isRelevant: (char) => hasWildShape(char) || companionChoices(char).length > 0,

	render(ctx) {
		// Same reasoning as the Spells step: synchronous once cached, so a pick
		// does not lose the scroll position.
		if (db.creatures) return buildCompanionStep(ctx);

		const host = el("div", {}, [el("p.muted", { text: "Loading stat blocks…" })]);
		(async () => {
			await ensure("creatures");
			host.replaceChildren(...buildCompanionStep(ctx));
		})();
		return [host];
	},

	isComplete: () => true,
};

/** Builds the Forms & Companions step. */
function buildCompanionStep(ctx) {
	const { session } = ctx;
	const char = session.character;
	const nodes = [];

	// --- Wild Shape ------------------------------------------------
	if (hasWildShape(char)) {
		const druid = (char.classes ?? []).find((e) => /druid/i.test(getClass(e.classId)?.name ?? ""));
		const level = druid?.levels ?? rules.totalLevel(char);
		const limits = wildShapeLimits(level);

		const unrestricted = Boolean(char.houseRules?.unrestrictedWildShape);
		const pool = (db.creatures ?? [])
			.filter((c) => c.role === "beast")
			.filter((c) => c.edition === (char.edition ?? "2024"))
			.filter((c) => unrestricted || (c.crValue ?? 0) <= limits.maxCr)
			.filter((c) => unrestricted || limits.allowFly || !c.hasFlySpeed)
			.filter((c) => unrestricted || limits.allowSwim || !c.hasSwimSpeed)
			.sort((a, b) => a.name.localeCompare(b.name));

		const chosen = char.wildShapeForms ?? [];

		nodes.push(section("Wild Shape forms",
			`Know ${limits.known} forms. At Druid level ${level} the pool is Beasts of CR ${crLabel(limits.maxCr)} or lower`
			+ `${limits.allowFly ? "" : ", with no Fly Speed"}${limits.allowSwim ? "" : " and no Swim Speed"}.`,
			pool.length
				? el("div.choice-list", {}, pool.map((c) => {
					const isChosen = chosen.includes(c.id);
					const atLimit = !isChosen && chosen.length >= limits.known;
					return el("label.choice", {
						class: [isChosen ? "is-chosen" : "", atLimit ? "is-disabled" : ""].filter(Boolean).join(" "),
					}, [
						el("input", {
							type: "checkbox", checked: isChosen, disabled: atLimit,
							onchange: () => {
								const next = isChosen
									? chosen.filter((x) => x !== c.id)
									: [...chosen, c.id];
								session.update({ wildShapeForms: next });
								ctx.rerender();
							},
						}),
						el("span.choice__body", {}, [
							el("span.choice__label", { text: c.name }),
							el("span.choice__hint", { text: creatureSubtitle(c) }),
						]),
						infoButton(() => showCreature(c.id), c.name),
					]);
				}))
				: notice("No Beast stat blocks matched. Check that creatures.json was generated.", "warn"),
		));

		if (chosen.length > limits.known) {
			nodes.push(notice(`You have ${chosen.length} forms selected but know only ${limits.known}.`, "warn"));
		}

		nodes.push(el("label.house-rule-toggle", {}, [
			el("input", {
				type: "checkbox",
				checked: unrestricted,
				onchange: (e) => {
					session.update((c) => ({
						...c,
						houseRules: { ...(c.houseRules ?? {}), unrestrictedWildShape: e.target.checked },
					}));
					ctx.rerender();
				},
			}),
			el("span", { text: "House rule: show every Beast, ignoring the CR and movement limits" }),
		]));
	}

	// --- Companions -------------------------------------------------
	for (const { feature, source } of companionChoices(char)) {
		const picked = char.companions?.[feature.name];
		nodes.push(section(feature.name, `From ${source}. Choose the stat block.`,
			el("div.pick-grid.pick-grid--compact", {}, feature.creatureRefs.map((ref) => {
				const c = findCreature(ref);
				return card({
					title: ref.name,
					subtitle: c ? creatureSubtitle(c) : "stat block not found",
					blurb: c ? (c.actions ?? []).map((a) => a.name).join(", ") : "",
					selected: picked === (c?.id ?? ref.id),
					onSelect: () => {
						session.update((ch) => ({
							...ch,
							companions: { ...(ch.companions ?? {}), [feature.name]: c?.id ?? ref.id },
						}));
						ctx.rerender();
					},
					onInfo: () => showCreature(c?.id ?? ref),
				});
			})),
		));

		if (picked) {
			const c = findCreature(picked);
			if (c) nodes.push(section(null, null, statBlock(c)));
		}
	}

	// --- Summons from known spells -----------------------------------
	const summonSpells = (db.spells ?? []).filter(
		(sp) => (sp.creatureRefs ?? []).length
			&& [...(char.spells?.prepared ?? []), ...(char.spells?.cantrips ?? [])].includes(sp.id),
	);
	if (summonSpells.length) {
		nodes.push(section("Stat blocks from your spells",
			"Spells you have selected that summon or create a creature.",
			el("div.summon-list", {}, summonSpells.map((sp) =>
				el("div.summon-row", {}, [
					el("span.summon-row__spell", { text: sp.name }),
					creatureRefLinks(sp.creatureRefs),
				]),
			)),
		));
	}

	return nodes.filter(Boolean);
}

/* ------------------------------------------------------------------ *
 * Step 7 - Details
 * ------------------------------------------------------------------ */

const detailsStep = {
	id: "details",
	title: "Details",
	blurb: "Name, alignment, and the human touches.",

	render(ctx) {
		const { session } = ctx;
		const char = session.character;

		const text = (label, key, opts = {}) =>
			field(label,
				el(opts.multiline ? "textarea.detail-input" : "input.detail-input", {
					value: key.startsWith("details.")
						? (char.details?.[key.slice(8)] ?? "")
						: (char[key] ?? ""),
					placeholder: opts.placeholder ?? "",
					rows: opts.multiline ? 3 : undefined,
					oninput: debounce((e) => {
						const v = e.target.value;
						if (key.startsWith("details.")) {
							session.update((c) => ({
								...c,
								details: { ...c.details, [key.slice(8)]: v },
							}));
						} else {
							session.update({ [key]: v });
						}
						ctx.onNameChange?.();
					}, 300),
				}),
			);

		return [
			section("The basics", null, el("div.detail-grid", {}, [
				text("Character name", "name", { placeholder: "Who are they?" }),
				text("Player name", "details.playerName"),
				field("Alignment",
					el("select.detail-input", {
						onchange: (e) => session.update((c) => ({
							...c, details: { ...c.details, alignment: e.target.value },
						})),
					}, [
						el("option", { value: "", text: "—" }),
						...(db.rules?.alignments ?? []).map((a) =>
							el("option", { value: a, text: a, selected: char.details?.alignment === a }),
						),
					]),
				),
			])),
			section("Roleplaying", "Optional, but it is what makes them yours.",
				el("div.detail-grid", {}, [
					text("Appearance", "details.appearance", { multiline: true }),
					text("Personality traits", "details.personality", { multiline: true }),
					text("Ideals", "details.ideals", { multiline: true }),
					text("Bonds", "details.bonds", { multiline: true }),
					text("Flaws", "details.flaws", { multiline: true }),
					text("Backstory", "details.backstory", { multiline: true }),
				]),
			),
		];
	},

	isComplete: (char) => Boolean(char.name?.trim()),
};

/* ------------------------------------------------------------------ *
 * Step order
 * ------------------------------------------------------------------ */

export const STEPS = [
	classStep,
	speciesStep,
	backgroundStep,
	abilitiesStep,
	equipmentStep,
	spellsStep,
	companionsStep,
	detailsStep,
];

/** Steps that apply to this character, in order. */
export const relevantSteps = (char) =>
	STEPS.filter((s) => (s.isRelevant ? s.isRelevant(char) : true));
