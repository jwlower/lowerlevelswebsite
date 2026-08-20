/**
 * rules.js - the derived-stat engine.
 *
 * Everything the sheet shows is computed from the character state plus the
 * rules database. Nothing derived is ever stored on the character, so changing
 * a class, species or ability score re-derives the whole sheet automatically.
 *
 * A note on completeness: 5etools stores rules *text*, not rules *logic*. Traits
 * like Dwarven Toughness read as prose, with no machine-readable "+1 HP per
 * level" field. Effects that matter numerically are therefore declared in
 * effects.js and matched by name, and every derived number can be overridden by
 * hand on the sheet. Anything not modelled shows up in the text, so nothing is
 * silently lost.
 */

import { db, getSpecies, getClass, getBackground, getSubclass, getItem, allSkills } from "./data.js";
import { effectsFor, attackRulesFor } from "./effects.js";

/* ------------------------------------------------------------------ *
 * Basics
 * ------------------------------------------------------------------ */

export const modifier = (score) => Math.floor((Number(score ?? 10) - 10) / 2);

export const formatMod = (n) => (n >= 0 ? `+${n}` : `${n}`);

export const totalLevel = (char) =>
	(char.classes ?? []).reduce((sum, c) => sum + (c.levels ?? 0), 0) || 1;

export function proficiencyBonus(char) {
	const lvl = Math.min(20, Math.max(1, totalLevel(char)));
	return db.rules?.proficiencyBonusByLevel?.[lvl - 1] ?? Math.floor((lvl - 1) / 4) + 2;
}

/** The character's primary class is whichever they took first. */
export const primaryClass = (char) => getClass(char.classes?.[0]?.classId);

/* ------------------------------------------------------------------ *
 * Ability scores
 * ------------------------------------------------------------------ */

/**
 * Final score = base (array/point-buy/roll) + background bonus + ASI/feat bumps.
 * Capped at 20 unless an effect raises the ceiling.
 */
export function abilityScores(char) {
	const out = {};
	for (const { id } of db.rules?.abilities ?? []) {
		const base = Number(char.baseAbilities?.[id] ?? 10);
		const bg = Number(char.abilityBonuses?.[id] ?? 0);
		const asi = Number(char.asiBonuses?.[id] ?? 0);
		const fromFeats = featAbilityBonuses(char)[id] ?? 0;
		const eff = effectSum(char, "abilityScore", id);
		const cap = 20 + effectSum(char, "abilityScoreMax", id);
		out[id] = Math.min(cap, base + bg + asi + fromFeats + eff);
	}
	return out;
}

export function abilityMods(char) {
	const scores = abilityScores(char);
	const out = {};
	for (const k of Object.keys(scores)) out[k] = modifier(scores[k]);
	return out;
}

/* ------------------------------------------------------------------ *
 * Effects layer
 *
 * effects.js returns a flat list of { type, target, value } for the character's
 * species traits, lineage pick, feats, class features and subclass. This keeps
 * the numeric bits of prose-only rules in one auditable place.
 * ------------------------------------------------------------------ */

function activeEffects(char) {
	return effectsFor(char);
}

function effectSum(char, type, target = null) {
	return activeEffects(char)
		.filter((e) => e.type === type && (target === null || e.target === target))
		.reduce((sum, e) => sum + (Number(e.value) || 0), 0);
}

function effectMax(char, type, target = null) {
	const vals = activeEffects(char)
		.filter((e) => e.type === type && (target === null || e.target === target))
		.map((e) => Number(e.value) || 0);
	return vals.length ? Math.max(...vals) : 0;
}

/* ------------------------------------------------------------------ *
 * Hit points
 * ------------------------------------------------------------------ */

/** Average HP gained per level after 1st, the standard "take the average" rule. */
export const averageHpPerLevel = (hitDie) => Math.floor(hitDie / 2) + 1;

/**
 * Level 1 grants the full hit die. Later levels use either the rolled value or
 * the fixed average, plus the Constitution modifier each time.
 */
export function hitPoints(char) {
	if (char.hp?.overrideMax != null && char.hp.overrideMax !== "") {
		const max = Number(char.hp.overrideMax);
		return { max, breakdown: [{ label: "Manual override", value: max }] };
	}

	const con = abilityMods(char).con ?? 0;
	const breakdown = [];
	let max = 0;
	let levelsCounted = 0;

	for (const entry of char.classes ?? []) {
		const cls = getClass(entry.classId);
		if (!cls) continue;
		const die = cls.hitDie ?? 8;

		for (let i = 0; i < (entry.levels ?? 0); i++) {
			levelsCounted++;
			const isFirstLevelOverall = levelsCounted === 1;
			let gained;
			if (isFirstLevelOverall) {
				gained = die;
				breakdown.push({ label: `${cls.name} 1 (max d${die})`, value: die });
			} else {
				const rolled = entry.hitDiceRolled?.[i];
				gained = rolled != null ? Number(rolled) : averageHpPerLevel(die);
				breakdown.push({
					label: `${cls.name} ${i + 1} (${rolled != null ? `rolled ${rolled}` : `avg d${die}`})`,
					value: gained,
				});
			}
			max += gained;
		}
	}

	const conTotal = con * levelsCounted;
	max += conTotal;
	breakdown.push({ label: `CON ${formatMod(con)} x ${levelsCounted} levels`, value: conTotal });

	// Per-level bonuses such as Dwarven Toughness or the Tough feat.
	const perLevel = effectSum(char, "hpPerLevel");
	if (perLevel) {
		const bonus = perLevel * levelsCounted;
		max += bonus;
		breakdown.push({ label: `Bonus ${formatMod(perLevel)}/level`, value: bonus });
	}
	const flat = effectSum(char, "hpBonus");
	if (flat) {
		max += flat;
		breakdown.push({ label: "Bonus HP", value: flat });
	}

	// A flat bonus entered by hand: Aid, a DM's reward, a homebrew boon. Kept
	// separate from overrideMax so the class total still tracks levelling up.
	const bonusMax = Number(char.hp?.bonusMax ?? 0);
	if (bonusMax) {
		max += bonusMax;
		breakdown.push({ label: "Bonus maximum (by hand)", value: bonusMax });
	}

	return { max: Math.max(1, max), breakdown };
}

/** Hit dice available, grouped by die size across multiclassed levels. */
export function hitDice(char) {
	const pool = {};
	for (const entry of char.classes ?? []) {
		const cls = getClass(entry.classId);
		if (!cls) continue;
		const key = `d${cls.hitDie}`;
		pool[key] = (pool[key] ?? 0) + (entry.levels ?? 0);
	}
	return pool;
}

/* ------------------------------------------------------------------ *
 * Armour class
 * ------------------------------------------------------------------ */

const ARMOR_TYPES = { LA: "light", MA: "medium", HA: "heavy" };

/**
 * Uses the best of: worn armour, or any unarmoured-defence effect. Shields and
 * flat AC bonuses stack on top of whichever base wins.
 */
export function armorClass(char) {
	if (char.acOverride != null && char.acOverride !== "") {
		return { total: Number(char.acOverride), source: "Manual override", breakdown: [] };
	}

	const mods = abilityMods(char);
	const dex = mods.dex ?? 0;
	const equipped = (char.equipment ?? []).filter((e) => e.equipped);

	const candidates = [];

	// Worn armour
	for (const entry of equipped) {
		const item = getItem(entry.itemId);
		if (!item?.armor || !item.ac) continue;
		const kind = ARMOR_TYPES[item.type];
		if (!kind) continue;
		let total = item.ac;
		let note = `${item.name} (${item.ac})`;
		if (kind === "light") {
			total += dex;
			note += ` + DEX ${formatMod(dex)}`;
		} else if (kind === "medium") {
			const capped = Math.min(dex, 2 + effectSum(char, "mediumArmorDexCap"));
			total += capped;
			note += ` + DEX ${formatMod(capped)} (capped)`;
		}
		candidates.push({ total, source: note });
	}

	// Unarmoured defence (Barbarian, Monk, Draconic Sorcerer, ...)
	for (const e of activeEffects(char).filter((x) => x.type === "unarmoredDefense")) {
		const extra = e.ability ? (mods[e.ability] ?? 0) : 0;
		candidates.push({
			total: (e.base ?? 10) + dex + extra,
			source: `${e.label} (${e.base ?? 10} + DEX ${formatMod(dex)}${e.ability ? ` + ${e.ability.toUpperCase()} ${formatMod(extra)}` : ""})`,
		});
	}

	// Nothing worn and no special defence: plain 10 + DEX.
	if (!candidates.length) {
		candidates.push({ total: 10 + dex, source: `Unarmoured (10 + DEX ${formatMod(dex)})` });
	}

	const best = candidates.reduce((a, b) => (b.total > a.total ? b : a));

	let total = best.total;
	const breakdown = [{ label: best.source, value: best.total }];

	// Shields
	for (const entry of equipped) {
		const item = getItem(entry.itemId);
		if (item?.type === "S") {
			const bonus = item.ac ?? 2;
			total += bonus;
			breakdown.push({ label: item.name, value: bonus });
		}
	}

	// A +1 breastplate or +1 shield adds on top of whatever it is worth plainly.
	for (const entry of equipped) {
		const item = getItem(entry.itemId);
		const bonus = itemAcBonus(item);
		if (!bonus) continue;
		total += bonus;
		breakdown.push({ label: `${item.name} enchantment`, value: bonus });
	}

	const bonusAc = effectSum(char, "acBonus");
	if (bonusAc) {
		total += bonusAc;
		breakdown.push({ label: "Other bonuses", value: bonusAc });
	}

	return { total, source: best.source, breakdown };
}

/* ------------------------------------------------------------------ *
 * Proficiencies, saves and skills
 * ------------------------------------------------------------------ */

/** Saving throw proficiencies come from the first class only, per multiclass rules. */
export function saveProficiencies(char) {
	const first = primaryClass(char);
	// Class saves, plus anything a feat granted (Resilient).
	return new Set([
		...(first?.savingThrows ?? []),
		...featSaveProficiencies(char),
	]);
}

export function savingThrows(char) {
	const mods = abilityMods(char);
	const pb = proficiencyBonus(char);
	const profs = saveProficiencies(char);
	const out = {};
	for (const { id, name, short } of db.rules?.abilities ?? []) {
		const proficient = profs.has(id);
		out[id] = {
			id, name, short,
			proficient,
			value: (mods[id] ?? 0) + (proficient ? pb : 0) + effectSum(char, "saveBonus", id),
		};
	}
	return out;
}

/**
 * Where each skill proficiency came from.
 *
 * Returns a Map of skillId -> [source labels], so the UI can lock a skill that
 * another source already granted and flag it when two sources overlap. Keeping
 * the provenance is the whole point: a flat list cannot tell you that picking
 * Insight as a Fighter is wasted because the background already gave it.
 */
export function skillSources(char) {
	const map = new Map();
	const add = (skillId, label) => {
		if (!skillId) return;
		if (!map.has(skillId)) map.set(skillId, []);
		const list = map.get(skillId);
		if (!list.includes(label)) list.push(label);
	};

	const bg = getBackground(char.backgroundId);
	for (const s of bg?.skillProficiencies?.fixed ?? []) add(s, bg.name);

	const species = getSpecies(char.speciesId);
	for (const s of species?.skillProficiencies?.fixed ?? []) add(s, species.name);

	const lineage = selectedLineage(char);
	for (const s of lineage?.skillProficiencies?.fixed ?? []) add(s, lineage.name);

	const cls = primaryClass(char);
	for (const s of cls?.skillsFixed ?? []) add(s, cls.name);

	// Feats can grant skills, either outright or by choice (Skilled, Prodigy).
	for (const feat of grantedFeats(char)) {
		const entry = db.feats?.find((f) => f.name === feat.name);
		for (const s of entry?.skillProficiencies?.fixed ?? []) add(s, feat.name);
		for (const s of char.featOptions?.[feat.name]?.skills ?? []) add(s, feat.name);
	}

	const LABELS = { class: cls?.name ?? "Class", species: species?.name ?? "Species", feat: "Feat" };
	for (const [bucket, ids] of Object.entries(char.skillChoices ?? {})) {
		for (const id of ids ?? []) add(id, LABELS[bucket] ?? bucket);
	}

	for (const s of char.extraSkills ?? []) add(s, "Added manually");

	return map;
}

/** Flat set of every skill the character is proficient in. */
export const skillProficiencySet = (char) => new Set(skillSources(char).keys());

/** Skills granted by more than one source, which means one pick is wasted. */
export function duplicateSkills(char) {
	const out = [];
	for (const [skillId, sources] of skillSources(char)) {
		if (sources.length > 1) out.push({ skillId, sources });
	}
	return out;
}

/**
 * Ability increases the character's feats grant.
 *
 * A feat can raise a score outright (rare) or make you choose which to raise
 * (Resilient, Fey-Touched, and the Ability Score Improvement feat itself). The
 * choice is stored per feat so retaking a repeatable feat does not overwrite the
 * earlier one.
 */
export function featAbilityBonuses(char) {
	const totals = { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 };

	for (const held of grantedFeats(char)) {
		const feat = (db.feats ?? []).find((f) => f.name === held.name);
		const mech = feat?.mechanics;
		if (!mech) continue;

		for (const [k, v] of Object.entries(mech.fixedAbility ?? {})) {
			totals[k] = (totals[k] ?? 0) + v;
		}
		for (const [k, v] of Object.entries(char.featOptions?.[held.name]?.ability ?? {})) {
			totals[k] = (totals[k] ?? 0) + Number(v || 0);
		}
	}
	return totals;
}

/** Saving throws a feat grants proficiency in -- Resilient's whole point. */
export function featSaveProficiencies(char) {
	const out = new Set();
	for (const held of grantedFeats(char)) {
		for (const ability of char.featOptions?.[held.name]?.saves ?? []) out.add(ability);
	}
	return out;
}

/**
 * What a feat still needs the player to decide.
 *
 * Returned as a list of pending questions so the UI can render them and say
 * plainly when something is unfinished, rather than silently applying half a
 * feat.
 */
export function featPendingChoices(char, featName) {
	const feat = (db.feats ?? []).find((f) => f.name === featName);
	const mech = feat?.mechanics;
	if (!mech) return [];

	const chosen = char.featOptions?.[featName] ?? {};
	const pending = [];

	// Ability increases. Several feats offer alternative spreads (+2 to one, or
	// +1 to two), so the total points are what matter.
	const abilitySpread = (mech.abilityChoices ?? [])[0];
	if (abilitySpread) {
		const wanted = (abilitySpread.amount ?? 1) * (abilitySpread.count ?? 1);
		const got = Object.values(chosen.ability ?? {}).reduce((a, b) => a + Number(b || 0), 0);
		if (got < wanted) {
			pending.push({ kind: "ability", need: wanted - got, from: abilitySpread.from });
		}
	}

	for (const save of mech.saveChoices ?? []) {
		if (!(chosen.saves ?? []).length) pending.push({ kind: "save", from: save.from });
	}

	for (const skill of mech.skillChoices ?? []) {
		const got = (chosen.skills ?? []).length;
		if (got < (skill.count ?? 1)) {
			pending.push({ kind: "skill", need: (skill.count ?? 1) - got, from: skill.from });
		}
	}

	// A feat offering alternative spell packages needs the package chosen first.
	if ((mech.spellVariants ?? []).length > 1 && !chosen.variant) {
		pending.push({ kind: "variant", from: mech.spellVariants });
	}

	for (const spellChoice of mech.spellChoices ?? []) {
		if (spellChoice.variant && spellChoice.variant !== chosen.variant) continue;
		const key = spellChoiceKey(spellChoice);
		const got = (chosen.spells?.[key] ?? []).length;
		if (got < (spellChoice.count ?? 1)) {
			pending.push({
				kind: "spell", key,
				need: (spellChoice.count ?? 1) - got,
				filter: spellChoice.filter,
				note: spellChoice.note ?? null,
			});
		}
	}

	return pending;
}

/** A stable key for one spell choice within a feat. */
export const spellChoiceKey = (choice) =>
	[choice.variant ?? "", choice.kind, choice.level, choice.filter].join("|");

/**
 * Parses a 5etools spell filter ("level=0|class=Cleric") into something the
 * spell list can be filtered by.
 */
export function parseSpellFilter(filter) {
	const out = { levels: null, classes: null, schools: null };
	for (const part of String(filter ?? "").split("|")) {
		const [key, value] = part.split("=");
		if (!value) continue;
		if (key === "level") out.levels = value.split(";").map(Number).filter(Number.isFinite);
		if (key === "class") out.classes = value.split(";").map((c) => c.trim().toLowerCase());
		if (key === "school") out.schools = value.split(";").map((c) => c.trim().toUpperCase());
	}
	return out;
}

/**
 * Every feat the character has: granted automatically by the background,
 * chosen for a species trait, or taken at level-up.
 */
export function grantedFeats(char) {
	const out = [];

	const bg = getBackground(char.backgroundId);
	for (const f of bg?.feats ?? []) {
		out.push({ name: f.name, from: "background", sourceName: bg.name, automatic: true });
	}

	const species = getSpecies(char.speciesId);
	for (const choice of species?.choices ?? []) {
		if (choice.type !== "feat") continue;
		const picked = char.featChoices?.[choice.id];
		if (picked) out.push({ name: picked, from: "species", sourceName: choice.name });
	}

	for (const name of char.feats ?? []) {
		out.push({ name, from: "level", sourceName: "Level up" });
	}

	return out;
}

/**
 * Features that hand out Expertise, and what has been assigned to each.
 *
 * A Rogue meets this three times over a career (levels 1 and 6, plus a subclass
 * or two), so each grant is keyed by class, feature name and level rather than
 * by name alone -- otherwise the level 6 pair would overwrite the level 1 pair.
 *
 * `options` is what this particular grant may be spent on: either the explicit
 * list the feature names, or every skill the character is proficient in.
 */
export function expertiseGrants(char) {
	const out = [];
	const profs = skillProficiencySet(char);

	const consider = (classId, originName, feature, level) => {
		const grant = feature.expertise;
		if (!grant) return;
		const key = `${classId}:${feature.name}:${level}`;
		const picked = char.expertiseChoices?.[key] ?? [];

		// An explicit list is filtered to the skills actually held, since every
		// one of these features says "in which you have proficiency".
		const all = allSkills();
		const options = grant.from === "proficient"
			? all.filter((s) => profs.has(s.id))
			: all.filter((s) => (grant.from ?? []).some((n) => n.toLowerCase() === s.name.toLowerCase()));

		out.push({
			key,
			feature: feature.name,
			origin: originName,
			level,
			count: grant.count ?? 1,
			// Options the character does not qualify for are still reported, so the
			// UI can say why a listed skill is not offered.
			options: options.filter((s) => profs.has(s.id)),
			ineligible: options.filter((s) => !profs.has(s.id)),
			picked: picked.slice(0, grant.count ?? 1),
			ref: `classFeature|${feature.name}|`,
		});
	};

	for (const entry of char.classes ?? []) {
		const cls = getClass(entry.classId);
		if (!cls) continue;
		const classLevel = entry.levels ?? 0;

		for (const blockLvl of cls.levels ?? []) {
			if (blockLvl.level > classLevel) continue;
			for (const f of blockLvl.features ?? []) consider(entry.classId, cls.name, f, blockLvl.level);
		}
		const sub = getSubclass(entry.classId, entry.subclassId);
		for (const blockLvl of sub?.levels ?? []) {
			if (blockLvl.level > classLevel) continue;
			for (const f of blockLvl.features ?? []) consider(entry.classId, sub.name, f, blockLvl.level);
		}
	}

	return out;
}

/** Every skill with Expertise, and where each came from. */
export function expertiseSources(char) {
	const map = new Map();
	const add = (id, label) => {
		if (!id) return;
		if (!map.has(id)) map.set(id, []);
		if (!map.get(id).includes(label)) map.get(id).push(label);
	};
	for (const g of expertiseGrants(char)) {
		for (const id of g.picked) add(id, `${g.feature} (${g.origin} ${g.level})`);
	}
	for (const id of char.expertise ?? []) add(id, "Added by hand");
	return map;
}

/**
 * What the builder worked out, before any hand override.
 *
 * Kept separate from `skills` so the sheet can show both, and offer to put a
 * manual change back the way the rules had it.
 */
export function skillsFromBuild(char) {
	const profs = skillProficiencySet(char);
	const experts = expertiseSources(char);
	const out = {};
	for (const s of allSkills()) {
		out[s.id] = experts.has(s.id) ? "expert" : profs.has(s.id) ? "proficient" : "none";
	}
	return out;
}

/** Which skills have been set by hand to something other than the build. */
export function skillOverrideList(char) {
	const build = skillsFromBuild(char);
	return Object.entries(char.skillOverrides ?? {})
		.filter(([id, state]) => state && state !== build[id])
		.map(([id, state]) => ({
			id,
			name: allSkills().find((s) => s.id === id)?.name ?? id,
			was: build[id],
			now: state,
		}));
}

export function skills(char) {
	const mods = abilityMods(char);
	const pb = proficiencyBonus(char);
	const build = skillsFromBuild(char);
	const overrides = char.skillOverrides ?? {};

	return allSkills().map((s) => {
		// A hand override wins outright: house rules and DM gifts do not have to
		// justify themselves to the builder.
		const state = overrides[s.id] ?? build[s.id];
		const proficient = state === "proficient" || state === "expert";
		const expert = state === "expert";
		const overridden = Boolean(overrides[s.id]) && overrides[s.id] !== build[s.id];
		const bonus = proficient ? (expert ? pb * 2 : pb) : 0;
		return {
			...s,
			proficient,
			expertise: expert,
			// The sheet marks these, so a surprising number can be explained.
			overridden,
			buildState: build[s.id],
			value: (mods[s.ability] ?? 0) + bonus + effectSum(char, "skillBonus", s.id),
		};
	});
}

export function passivePerception(char) {
	const perception = skills(char).find((s) => s.id === "perception");
	return 10 + (perception?.value ?? 0) + effectSum(char, "passivePerception");
}

export function initiative(char) {
	return (abilityMods(char).dex ?? 0) + effectSum(char, "initiativeBonus");
}

export function speed(char) {
	const species = getSpecies(char.speciesId);
	let base = species?.speed?.walk ?? 30;

	// A lineage pick can change the base (Wood Elf 35 ft).
	const lineage = selectedLineage(char);
	if (lineage?.speed?.walk) base = lineage.speed.walk;

	return base + effectSum(char, "speedBonus");
}

export function darkvision(char) {
	const species = getSpecies(char.speciesId);
	const lineage = selectedLineage(char);
	return Math.max(
		species?.darkvision ?? 0,
		lineage?.darkvision ?? 0,
		effectMax(char, "darkvision"),
	);
}

/** Resolve the species lineage/ancestry option the character picked. */
export function selectedLineage(char) {
	const species = getSpecies(char.speciesId);
	if (!species) return null;
	for (const choice of species.choices ?? []) {
		const pickedId = char.speciesChoices?.[choice.id];
		const opt = choice.options?.find((o) => o.id === pickedId);
		if (opt) return opt;
	}
	// Older species express this as a subrace instead.
	return (species.lineages ?? []).find((l) => l.id === char.lineageId) ?? null;
}

/* ------------------------------------------------------------------ *
 * Spellcasting
 * ------------------------------------------------------------------ */

/**
 * Standard multiclass spell slot table, indexed by effective caster level.
 * Only used when the character actually has two or more casting classes; a
 * single-class caster reads its own table instead, which matters because a
 * 2024 Paladin gets 1st-level slots at level 1 and the multiclass table does not.
 */
const MULTICLASS_SLOTS = [
	[2], [3], [4, 2], [4, 3], [4, 3, 2], [4, 3, 3], [4, 3, 3, 1], [4, 3, 3, 2],
	[4, 3, 3, 3, 1], [4, 3, 3, 3, 2], [4, 3, 3, 3, 2, 1], [4, 3, 3, 3, 2, 1],
	[4, 3, 3, 3, 2, 1, 1], [4, 3, 3, 3, 2, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1],
	[4, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1, 1], [4, 3, 3, 3, 3, 1, 1, 1, 1],
	[4, 3, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 3, 2, 2, 1, 1],
];

/**
 * How many caster levels a class contributes when multiclassing.
 *
 * The 2014 rules round half- and third-caster levels DOWN; the 2024 rules round
 * them UP. "artificer" progression rounds up in both, which is how 5etools marks
 * the 2024 Paladin and Ranger.
 */
function casterContribution(progression, levels, edition) {
	const roundUp = edition === "2024";
	switch (progression) {
		case "full": return levels;
		case "artificer": return Math.ceil(levels / 2);
		case "1/2": return roundUp ? Math.ceil(levels / 2) : Math.floor(levels / 2);
		case "1/3": return roundUp ? Math.ceil(levels / 3) : Math.floor(levels / 3);
		default: return 0; // pact magic is a separate track
	}
}

/**
 * Classes that keep a spellbook, and how fast it fills.
 *
 * Most classes prepare straight from their class list: a Sorcerer at level 5
 * picks any 6 Sorcerer spells. A Wizard is different -- it has a *third* bucket.
 * Spells are first learned into the spellbook (six at 1st level, two more per
 * level), and only spells in that book can be prepared. So a Wizard 5 has a
 * 14-spell book and prepares 9 of them, while a Sorcerer 5 just prepares 6.
 *
 * Modelling this matters: without it a Wizard could prepare anything on the
 * list, which is the Sorcerer's rule, not theirs.
 */
const SPELLBOOK_CLASSES = {
	wizard: { start: 6, perLevel: 2, label: "Spellbook" },
};

/** How many spells a spellbook holds at a given class level. */
function spellbookSize(className, levels) {
	const rule = SPELLBOOK_CLASSES[String(className).toLowerCase()];
	if (!rule) return null;
	return rule.start + rule.perLevel * Math.max(0, levels - 1);
}

/** Per-level value from a 20-entry progression array. */
const atLevel = (arr, level) =>
	Array.isArray(arr) ? (arr[Math.min(20, Math.max(1, level)) - 1] ?? 0) : null;

/**
 * Everything the spell UI needs, for one class or several.
 *
 * Each casting class keeps its OWN prepared list and limit, because that is how
 * multiclassing works: a Cleric 3 / Wizard 2 prepares Cleric spells against the
 * Cleric table and Wizard spells against the Wizard table, while sharing one
 * pool of slots.
 */
export function spellcasting(char) {
	const pb = proficiencyBonus(char);
	const mods = abilityMods(char);
	const edition = char.edition ?? "2024";

	const casters = [];
	let effectiveLevel = 0;
	let pactEntry = null;

	for (const entry of char.classes ?? []) {
		const cls = getClass(entry.classId);
		if (!cls) continue;
		const sub = getSubclass(entry.classId, entry.subclassId);
		const levels = entry.levels ?? 0;

		// A subclass can be the thing that grants spellcasting (Eldritch Knight).
		const sc = cls.spellcasting ?? null;
		const subSc = sub?.casterProgression ? { ability: sub.spellcastingAbility, progression: sub.casterProgression } : null;
		const progression = sc?.progression ?? subSc?.progression ?? null;
		const ability = sc?.ability ?? subSc?.ability ?? null;
		if (!progression || !ability) continue;

		const mod = mods[ability] ?? 0;
		const isPact = progression === "pact";

		const record = {
			classId: cls.id,
			className: cls.name,
			subclassName: sub?.name ?? null,
			levels,
			ability,
			abilityMod: mod,
			progression,
			isPact,
			saveDc: 8 + pb + mod + effectSum(char, "spellSaveDc"),
			attackBonus: pb + mod + effectSum(char, "spellAttackBonus"),
			// 2024 prints a flat Prepared Spells count; 2014 known-casters print
			// Spells Known instead. Either way it comes from the class table.
			cantripsKnown: atLevel(sc?.cantripsKnown, levels),
			preparedLimit: atLevel(sc?.preparedCount, levels),
			spellsKnownLimit: atLevel(sc?.spellsKnown, levels),
			// A Wizard prepares only from its spellbook, so that is a separate
			// and larger limit than the prepared count.
			spellbookLimit: spellbookSize(cls.name, levels),
			spellbookLabel: SPELLBOOK_CLASSES[cls.name.toLowerCase()]?.label ?? null,
			ownSlots: sc?.slots ? sc.slots[Math.min(20, Math.max(1, levels)) - 1] ?? null : null,
		};

		if (isPact && sc?.pact) {
			record.pactSlots = atLevel(sc.pact.slots, levels);
			record.pactSlotLevel = atLevel(sc.pact.level, levels);
			pactEntry = record;
		} else {
			effectiveLevel += casterContribution(progression, levels, edition);
		}

		casters.push(record);
	}

	if (!casters.length) return null;

	// Slot pool. One non-pact caster reads its own table; several share the
	// multiclass table.
	const slotCasters = casters.filter((c) => !c.isPact);
	let slots = [];
	if (slotCasters.length === 1 && slotCasters[0].ownSlots) {
		slots = [...slotCasters[0].ownSlots];
	} else if (effectiveLevel > 0) {
		slots = [...(MULTICLASS_SLOTS[Math.min(20, effectiveLevel) - 1] ?? [])];
	}
	// Trim trailing zeros so the tracker only shows slot levels you actually have.
	while (slots.length && !slots[slots.length - 1]) slots.pop();

	const used = char.spellSlotsUsed ?? {};

	return {
		classes: casters,
		multiclass: casters.length > 1,
		effectiveCasterLevel: effectiveLevel,
		slots,
		slotsUsed: slots.map((_, i) => Number(used[String(i + 1)] ?? 0)),
		pact: pactEntry
			? {
				count: pactEntry.pactSlots ?? 0,
				level: pactEntry.pactSlotLevel ?? 1,
				used: Number(char.pactSlotsUsed ?? 0),
				className: pactEntry.className,
			}
			: null,
	};
}

/**
 * Subclasses whose granted spells come in variants the player must choose
 * between -- the 2024 Circle of the Land picks a terrain, and each terrain has
 * its own spell list. Returns the choices that need making.
 */
export function spellVariantChoices(char) {
	const out = [];

	for (const entry of char.classes ?? []) {
		const cls = getClass(entry.classId);
		const sub = getSubclass(entry.classId, entry.subclassId);
		for (const [owner, label] of [[sub, sub?.name], [cls, cls?.name]]) {
			const variants = [...new Set(
				(owner?.spellGrants ?? []).map((g) => g.variant).filter(Boolean),
			)];
			if (variants.length > 1) {
				out.push({
					classId: entry.classId,
					sourceName: label,
					variants,
					chosen: char.spellVariants?.[entry.classId] ?? null,
				});
			}
		}
	}
	return out;
}

/**
 * Spells the character gets for free, and where each came from.
 *
 * These do not come off the class list and do not count against a prepared or
 * cantrips-known limit -- a High Elf's Prestidigitation is granted by the
 * lineage, not chosen as a Wizard cantrip. Showing the origin is the point:
 * otherwise a player cannot tell why a cantrip is on their sheet, or whether
 * spending one of their own picks on it would be wasted.
 *
 * Each entry carries a `ref` so the source is clickable.
 */
export function grantedSpells(char) {
	const level = totalLevel(char);
	const out = [];
	const seen = new Set();

	/**
	 * `gate` is the level the spell unlocks at. Species and background grants gate
	 * on character level; class and subclass grants gate on that class's own
	 * level, which is passed in as `classLevel`.
	 */
	const add = (spellRef, sourceName, sourceRef, gate, opts = {}) => {
		const key = spellRef.name.toLowerCase();
		if (seen.has(key)) return;
		seen.add(key);

		const against = opts.classLevel ?? level;
		out.push({
			id: spellRef.id,
			name: spellRef.name,
			source: sourceName,
			ref: sourceRef,
			unlockLevel: gate ?? 1,
			available: (gate ?? 1) <= against,
			kind: opts.kind ?? "prepared",
			note: opts.note ?? null,
		});
	};

	const species = getSpecies(char.speciesId);
	if (species) {
		const speciesRef = `race|${species.name}|${species.source}`;

		// Spells from the chosen lineage, gated by character level.
		for (const choice of species.choices ?? []) {
			const picked = (choice.options ?? []).find(
				(o) => o.id === char.speciesChoices?.[choice.id],
			);
			if (!picked) continue;
			for (const [gate, refs] of Object.entries(picked.spellsByLevel ?? {})) {
				for (const r of refs) add(r, picked.name, speciesRef, Number(gate));
			}
		}

		// Species-wide grants that are not tied to a lineage (Aasimar's Light,
		// Tiefling's Thaumaturgy). Anything already credited to the lineage is
		// skipped by `seen`.
		const lineageNames = new Set(
			(species.choices ?? []).flatMap((c) =>
				(c.options ?? []).flatMap((o) => (o.spellRefs ?? []).map((r) => r.name.toLowerCase()))),
		);
		for (const r of species.spellRefs ?? []) {
			if (lineageNames.has(r.name.toLowerCase())) continue;
			add(r, species.name, speciesRef, 1);
		}
	}

	// Feats grant spells three ways: named in their text, listed as a fixed
	// grant, or chosen from another class's list (Magic Initiate).
	for (const held of grantedFeats(char)) {
		const feat = (db.feats ?? []).find((f) => f.name === held.name);
		if (!feat) continue;
		const ref = `feat|${feat.name}|${feat.source}`;
		const options = char.featOptions?.[feat.name] ?? {};

		for (const r of feat.spellRefs ?? []) add(r, feat.name, ref, 1);

		for (const grant of feat.mechanics?.spellGrants ?? []) {
			if (grant.variant && grant.variant !== options.variant) continue;
			for (const spellRef of grant.spells) {
				add(spellRef, feat.name, ref, 1, { kind: grant.kind, note: grant.note ?? null });
			}
		}

		// Spells the player picked to satisfy the feat's choices.
		for (const [key, ids] of Object.entries(options.spells ?? {})) {
			const note = key.split("|")[1] === "innate" ? "1/day" : null;
			for (const id of ids) {
				const spell = (db.spells ?? []).find((sp) => sp.id === id);
				if (!spell) continue;
				add({ id: spell.id, name: spell.name, source: spell.source },
					feat.name, ref, 1, { kind: "known", note });
			}
		}
	}

	const bg = getBackground(char.backgroundId);
	for (const r of bg?.spellRefs ?? []) {
		add(r, bg.name, `background|${bg.name}|${bg.source}`, 1);
	}

	// Domain, oath and patron spells. These are granted at a CLASS level rather
	// than a character level, which matters for a multiclassed character: a
	// Cleric 3 / Fighter 5 gets their domain spells at Cleric 3, not at 8.
	for (const entry of char.classes ?? []) {
		const cls = getClass(entry.classId);
		if (!cls) continue;
		const classLevel = entry.levels ?? 0;
		const sub = getSubclass(entry.classId, entry.subclassId);
		const chosenVariant = char.spellVariants?.[entry.classId] ?? null;

		for (const [owner, ref] of [
			[sub, sub ? `subclassFeature|${sub.name}|` : null],
			[cls, `class|${cls.name}|${cls.source}`],
		]) {
			for (const grant of owner?.spellGrants ?? []) {
				// "expanded" widens what you may choose; it grants nothing outright.
				if (grant.kind === "expanded") continue;
				// A variant list only applies once its variant has been picked.
				if (grant.variant && grant.variant !== chosenVariant) continue;

				const label = grant.variant
					? `${owner.name} (${grant.variant})`
					: owner.name;

				for (const spellRef of grant.spells) {
					add(spellRef, label, ref, grant.level, {
						classLevel,
						kind: grant.kind,
						note: grant.note ?? null,
					});
				}
			}
		}
	}

	return out;
}

/** The spells a character has selected for one class. */
export function classSpells(char, classId) {
	const bucket = char.spellsByClass?.[classId] ?? {};
	return {
		cantrips: bucket.cantrips ?? [],
		prepared: bucket.prepared ?? [],
		known: bucket.known ?? [],
	};
}

/** Every spell id the character has, across all classes. */
export function allChosenSpells(char) {
	const out = new Set();
	for (const bucket of Object.values(char.spellsByClass ?? {})) {
		for (const key of ["cantrips", "prepared", "known"]) {
			for (const id of bucket[key] ?? []) out.add(id);
		}
	}
	return [...out];
}

/* ------------------------------------------------------------------ *
 * Features, proficiencies and carrying capacity
 * ------------------------------------------------------------------ */

/** Every class and subclass feature unlocked at the character's current level. */
export function unlockedFeatures(char) {
	const out = [];
	for (const entry of char.classes ?? []) {
		const cls = getClass(entry.classId);
		if (!cls) continue;
		const lvl = entry.levels ?? 0;

		for (const levelBlock of cls.levels ?? []) {
			if (levelBlock.level > lvl) continue;
			for (const f of levelBlock.features ?? []) {
				out.push({ ...f, source: cls.name, kind: "class" });
			}
		}

		const sub = getSubclass(entry.classId, entry.subclassId);
		for (const levelBlock of sub?.levels ?? []) {
			if (levelBlock.level > lvl) continue;
			for (const f of levelBlock.features ?? []) {
				out.push({ ...f, source: sub.name, kind: "subclass" });
			}
		}
	}
	return out.sort((a, b) => (a.level ?? 0) - (b.level ?? 0));
}

/**
 * Choices the player made for a feature that offered them, and where each came
 * from.
 *
 * A Paladin's "Fighting Style: Dueling" is two separate things worth linking:
 * the Dueling feat itself, and the Fighting Style feature at Paladin 2 that
 * granted the pick. Without the second link a player has no route back to
 * change their mind.
 */
export function chosenOptions(char) {
	const out = [];

	for (const entry of char.classes ?? []) {
		const cls = getClass(entry.classId);
		if (!cls) continue;
		const level = entry.levels ?? 0;
		const sub = getSubclass(entry.classId, entry.subclassId);

		const progressions = [
			...(cls.featProgression ?? []),
			...(cls.optionalfeatureProgression ?? []),
			...(sub?.optionalfeatureProgression ?? []),
		];

		for (const prog of progressions) {
			// The earliest level at which this progression grants anything.
			const gates = Object.keys(prog.progression ?? {}).map(Number).filter((n) => n <= level);
			if (!gates.length) continue;
			const grantedAt = Math.min(...gates);

			// How many picks are unlocked, so an unfilled slot can be reported.
			const unlocked = Object.entries(prog.progression ?? {})
				.filter(([lvl]) => Number(lvl) <= level)
				.reduce((max, [, n]) => Math.max(max, Number(n)), 0);

			// Which of the character's picks belong to this progression. Picks are
			// stored by name, so match against the candidate pool by category.
			const categories = (prog.category ?? prog.featureType ?? []).map(String);
			const picks = (char.optionalFeaturePicks ?? []).filter((name) =>
				belongsToProgression(name, categories));

			out.push({
				kind: "option",
				featureName: prog.name ?? "Choice",
				className: cls.name,
				level: grantedAt,
				expected: unlocked,
				picks: picks.map((name) => ({ name, ref: refForOption(name) })),
			});
		}
	}

	// Feats chosen for a species trait (the 2024 Human's Versatile).
	const species = getSpecies(char.speciesId);
	for (const choice of species?.choices ?? []) {
		if (choice.type !== "feat") continue;
		const picked = char.featChoices?.[choice.id];
		out.push({
			kind: "option",
			featureName: choice.name,
			className: species.name,
			level: 1,
			expected: choice.count ?? 1,
			picks: picked ? [{ name: picked, ref: refForOption(picked) }] : [],
		});
	}

	return out;
}

/** Does a pick name belong to a progression's categories? */
function belongsToProgression(name, categories) {
	const FEAT_CATEGORY = { FS: "fighting-style", EB: "epic-boon", O: "origin", G: "general" };
	const featCats = categories.map((c) => FEAT_CATEGORY[c]).filter(Boolean);

	if (featCats.length) {
		const feat = (db.feats ?? []).find((f) => f.name === name);
		return Boolean(feat && featCats.includes(feat.category));
	}

	const wanted = categories.map((c) => String(c).toLowerCase());
	const opt = (db.optionalFeatures ?? []).find((f) => f.name === name);
	return Boolean(opt && (opt.rawTypes ?? []).some((t) => wanted.includes(String(t).toLowerCase())));
}

/** A glossary reference for a pick, whichever dataset it lives in. */
function refForOption(name) {
	const feat = (db.feats ?? []).find((f) => f.name === name);
	if (feat) return `feat|${feat.name}|${feat.source}`;
	const opt = (db.optionalFeatures ?? []).find((f) => f.name === name);
	if (opt) return `optfeature|${opt.name}|${opt.source}`;
	return null;
}

/**
 * Everything the character has, in the order they got it.
 *
 * Species traits and the background come at creation; class features come at the
 * level printed in the class table; feats and picks come from whichever of those
 * granted them. Sorting by that level is how a player actually reads a sheet --
 * "what did I get at 3rd?" -- rather than by which list the app happens to keep.
 */
export function characterTimeline(char) {
	const rows = [];

	const species = getSpecies(char.speciesId);
	if (species) {
		const ref = `race|${species.name}|${species.source}`;
		for (const t of species.traits ?? []) {
			rows.push({
				level: 1, name: t.name, html: t.html,
				origin: species.name, originRef: ref, step: "species", kind: "trait",
			});
		}
		const lineage = selectedLineage(char);
		if (lineage) {
			// Aim at the picker that chose this lineage, by its own heading.
			const choice = (species.choices ?? []).find((c) =>
				(c.options ?? []).some((o) => o.id === lineage.id));
			rows.push({
				level: 1, name: lineage.name, html: lineage.html,
				origin: `${species.name} lineage`, originRef: ref,
				step: "species", kind: "trait", anchor: choice?.name ?? null,
			});
		}
	}

	const bg = getBackground(char.backgroundId);
	if (bg) {
		rows.push({
			level: 1, name: bg.name, html: bg.html,
			origin: "Background", originRef: `background|${bg.name}|${bg.source}`,
			step: "background", kind: "background",
		});
	}

	// Feats, at the level of whatever granted them.
	for (const held of grantedFeats(char)) {
		const feat = (db.feats ?? []).find((f) => f.name === held.name);
		rows.push({
			level: held.from === "level" ? (char.featLevels?.[held.name] ?? 4) : 1,
			name: held.name,
			html: feat?.html ?? "",
			origin: held.from === "background" ? `${held.sourceName} (granted)` : held.sourceName,
			originRef: feat ? `feat|${feat.name}|${feat.source}` : null,
			step: held.from === "background" ? "background" : held.from === "species" ? "species" : "class",
			kind: "feat",
		});
	}

	// Class and subclass features at their own levels.
	for (const entry of char.classes ?? []) {
		const cls = getClass(entry.classId);
		if (!cls) continue;
		const level = entry.levels ?? 0;

		for (const block of cls.levels ?? []) {
			if (block.level > level) continue;
			for (const f of block.features ?? []) {
				// "Fighter Subclass" is the row that offers the subclass choice.
				const isSubclassGate = new RegExp(`^${cls.name}\\s+Subclass$`, "i").test(f.name);
				rows.push({
					level: block.level, name: f.name, html: f.html,
					origin: `${cls.name} ${block.level}`,
					originRef: `classFeature|${f.name}|`,
					step: "class", kind: "class",
					anchor: isSubclassGate ? (cls.subclassTitle ?? "Subclass") : null,
				});
			}
		}

		const sub = getSubclass(entry.classId, entry.subclassId);
		for (const block of sub?.levels ?? []) {
			if (block.level > level) continue;
			for (const f of block.features ?? []) {
				rows.push({
					level: block.level, name: f.name, html: f.html,
					origin: `${sub.name} ${block.level}`,
					originRef: `subclassFeature|${f.name}|`,
					step: "class", kind: "subclass",
					// A subclass feature is changed by changing the subclass, so
					// aim at that picker rather than searching for the feature name.
					anchor: cls.subclassTitle ?? "Subclass",
				});
			}
		}
	}

	// Picks belong to the feature that granted them. Where that feature is
	// already in the timeline -- "Fighting Style" at Paladin 2 -- fold the pick
	// into it rather than listing the same feature twice.
	for (const opt of chosenOptions(char)) {
		const host = rows.find(
			(r) => r.name === opt.featureName && r.level === opt.level && r.kind !== "choice",
		);

		if (host) {
			host.picks = opt.picks;
			host.expected = opt.expected;
			host.originFeature = opt.featureName;
			host.anchor = opt.featureName;
			continue;
		}

		rows.push({
			level: opt.level,
			name: opt.featureName,
			picks: opt.picks,
			expected: opt.expected,
			origin: `${opt.className} ${opt.level}`,
			originFeature: opt.featureName,
			anchor: opt.featureName,
			step: opt.className === getSpecies(char.speciesId)?.name ? "species" : "class",
			kind: "choice",
			html: "",
		});
	}

	// Stable order: by level, then creation-time things first, then by name.
	const rank = { trait: 0, background: 1, class: 2, subclass: 3, choice: 4, feat: 5 };
	return rows.sort((a, b) =>
		a.level - b.level
		|| (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9)
		|| String(a.name).localeCompare(String(b.name)));
}

/** Combined proficiency lists for the sheet. */
export function proficiencies(char) {
	const cls = primaryClass(char);
	const bg = getBackground(char.backgroundId);

	return {
		armor: cls?.armorTraining ?? [],
		weapons: cls?.weaponProficiencies ?? [],
		tools: [
			...(cls?.toolProficiencies?.fixed ?? []),
			...(bg?.toolProficiencies?.fixed ?? []),
			...(char.toolProficiencies ?? []),
		].filter((v, i, a) => a.indexOf(v) === i),
		languages: languageNames(char),
	};
}

export function carryingCapacity(char) {
	const str = abilityScores(char).str ?? 10;
	const mult = effectSum(char, "carryMultiplier") || 1;
	return { capacity: str * 15 * mult, push: str * 30 * mult };
}

export function totalWeight(char) {
	return (char.equipment ?? []).reduce((sum, e) => {
		const item = getItem(e.itemId);
		return sum + (item?.weight ?? 0) * (e.quantity ?? 1);
	}, 0);
}

/* ------------------------------------------------------------------ *
 * Attacks
 * ------------------------------------------------------------------ */

/**
 * Builds the attack table rows from equipped weapons, choosing the better of
 * STR/DEX for finesse weapons and applying proficiency where the character has
 * the relevant weapon training.
 */
/**
 * How a weapon is being held. Two-Handed weapons have no choice; Versatile ones
 * are the player's call, which is exactly what Dueling and Great Weapon
 * Fighting hinge on, so the equipment step lets them set it.
 */
export function gripFor(entry, item, { hasShield = false } = {}) {
	const props = (item?.properties ?? []).map((p) => p.toLowerCase());
	if (props.includes("two-handed")) return "two-handed";
	// A shield fills the off hand, so a Versatile weapon has to be one-handed.
	if (hasShield && props.includes("versatile")) return "one-handed";
	if (entry?.grip === "one-handed" || entry?.grip === "two-handed") return entry.grip;
	// Versatile otherwise defaults to two hands, which is how most players use it.
	if (props.includes("versatile")) return "two-handed";
	return "one-handed";
}

/** Is a shield currently in hand? Drives AC and the grip of Versatile weapons. */
export function shieldInHand(char) {
	return (char.equipment ?? []).some((e) => {
		if (!e.equipped) return false;
		const item = getItem(e.itemId);
		return item?.type === "S";
	});
}

/** Every shield the character carries, so the sheet can offer a toggle. */
export function shieldsCarried(char) {
	return (char.equipment ?? [])
		.map((entry, index) => ({ entry, index, item: getItem(entry.itemId) }))
		.filter(({ item }) => item?.type === "S");
}

/**
 * How far an attack reaches.
 *
 * Three cases, and a weapon can be two of them at once:
 *   melee            reach 5 ft, or 10 ft with the Reach property
 *   ranged           a normal/long pair, e.g. Longbow 150/600
 *   thrown melee     both -- a Javelin has 5 ft reach AND a 30/120 throw
 *
 * Beyond the long range an attack simply cannot be made; between normal and long
 * it has Disadvantage, which is why both numbers matter and only showing one is
 * not good enough.
 */
function attackReach(item, props) {
	const hasReach = props.includes("reach");
	const isThrown = props.includes("thrown");
	const isRanged = item.type === "R";

	// "150/600" -> [150, 600]
	const pair = typeof item.range === "string" && item.range.includes("/")
		? item.range.split("/").map((n) => Number(n.trim())).filter(Number.isFinite)
		: null;
	const single = !pair && item.range != null && Number.isFinite(Number(item.range))
		? Number(item.range)
		: null;

	const normal = pair ? pair[0] : single;
	const long = pair ? pair[1] : null;

	if (isRanged) {
		return {
			kind: "ranged",
			reach: null,
			normal, long,
			label: long ? `${normal}/${long} ft` : normal != null ? `${normal} ft` : "—",
			detail: long
				? `Normal range ${normal} ft; up to ${long} ft with Disadvantage`
				: `Range ${normal} ft`,
		};
	}

	const reach = hasReach ? 10 : 5;

	if (isThrown && normal != null) {
		return {
			kind: "thrown",
			reach,
			normal, long,
			label: `${reach} ft · ${long ? `${normal}/${long}` : normal} thrown`,
			detail: `Reach ${reach} ft in melee, or thrown ${normal} ft`
				+ (long ? ` (up to ${long} ft with Disadvantage)` : ""),
		};
	}

	return {
		kind: "melee",
		reach,
		normal: null, long: null,
		label: `${reach} ft`,
		detail: hasReach ? "Reach 10 ft (Reach property)" : "Reach 5 ft",
	};
}

/** Range label from an item alone, for lists that have no attack row. */
export function attackReachLabel(item) {
	const props = (item?.properties ?? []).map((x) => String(x).toLowerCase());
	if (!item?.weapon) return null;
	return attackReach(item, props).label;
}

/**
 * Builds the attack table.
 *
 * Beyond the flat maths, every conditional feature the character has is checked
 * against each weapon. Both outcomes are reported: `activeEffects` for the ones
 * that fire, and `inactiveEffects` -- with the reason -- for the ones that do
 * not. Showing why Dueling is off ("you have 1 other weapon in hand") is the
 * difference between the sheet looking broken and the sheet teaching the rule.
 */
/**
 * The attack and damage bonus an item carries.
 *
 * Both the extracted magic items and hand-made ones store this as
 * `bonusWeapon` ("+1"), which is a string because that is how the source data
 * writes it.
 */
export function itemAttackBonus(item) {
	const raw = item?.bonusWeapon ?? item?.bonusWeaponAttack;
	const n = Number(String(raw ?? "").replace("+", ""));
	return Number.isFinite(n) ? n : 0;
}

/** The armour class bonus an item carries, over and above its own AC. */
export function itemAcBonus(item) {
	const n = Number(String(item?.bonusAc ?? "").replace("+", ""));
	return Number.isFinite(n) ? n : 0;
}

export function attacks(char) {
	const mods = abilityMods(char);
	const pb = proficiencyBonus(char);
	const cls = primaryClass(char);
	const trained = new Set((cls?.weaponProficiencies ?? []).map((w) => w.toLowerCase()));
	const attackRules = attackRulesFor(char);

	const inHand = (char.equipment ?? [])
		.filter((e) => e.equipped)
		.map((e) => ({ entry: e, item: getItem(e.itemId) }));

	const weaponsInHand = inHand.filter(({ item }) => item?.weapon);
	const hasShield = inHand.some(({ item }) => item?.type === "S");

	return weaponsInHand.map(({ entry, item }) => {
		const props = (item.properties ?? []).map((p) => p.toLowerCase());
		const finesse = props.includes("finesse");
		const isRanged = item.type === "R";
		const grip = gripFor(entry, item, { hasShield });

		let ability = "str";
		if (isRanged) ability = "dex";
		else if (finesse) ability = (mods.dex ?? 0) > (mods.str ?? 0) ? "dex" : "str";

		const abilityMod = mods[ability] ?? 0;
		const isProficient =
			trained.has(item.weaponCategory ?? "") ||
			trained.has(item.name.toLowerCase()) ||
			trained.has(`${item.name.toLowerCase()}s`);

		// Everything a conditional rule needs to decide about THIS weapon.
		const ctx = {
			weaponName: item.name.toLowerCase(),
			properties: props,
			isMelee: !isRanged,
			isRanged,
			isUnarmed: false,
			grip,
			otherWeaponsInHand: weaponsInHand.length - 1,
			hasShield,
			abilityMod,
		};

		const active = [];
		const inactive = [];
		let bonusAttack = 0;
		let bonusDamage = 0;

		for (const rule of attackRules) {
			if (rule.applies(ctx)) {
				if (rule.kind === "attack") bonusAttack += rule.value ?? 0;
				if (rule.kind === "damage") bonusDamage += rule.value ?? 0;
				active.push({
					name: rule.name,
					detail: rule.kind === "note"
						? rule.note
						: `${formatMod(rule.value ?? 0)} ${rule.kind}`,
				});
			} else {
				inactive.push({
					name: rule.name,
					requires: rule.requires,
					why: rule.explain ? rule.explain(ctx) : "conditions not met",
				});
			}
		}

		// Versatile weapons roll a bigger die in two hands.
		const dieUsed = grip === "two-handed" && item.versatileDamage
			? item.versatileDamage
			: item.damage;

		// A magic weapon adds to both rolls. Extra damage dice ("1d6 fire" from a
		// custom item) ride alongside rather than into the modifier.
		const magic = itemAttackBonus(item);
		const damageMod = abilityMod + bonusDamage + magic;

		return {
			name: item.name,
			ability,
			grip,
			attackBonus: abilityMod + (isProficient ? pb : 0) + bonusAttack + magic
				+ effectSum(char, "attackBonus"),
			magicBonus: magic,
			damage: dieUsed
				? `${dieUsed} ${formatMod(damageMod)}${item.extraDamage ? ` + ${item.extraDamage}` : ""}`
				: "—",
			extraDamage: item.extraDamage ?? null,
			damageDie: dieUsed,
			damageMod,
			abilityMod,
			bonusDamage,
			bonusAttack,
			// Kept so the sheet can note the alternative grip.
			versatile: item.versatileDamage
				? `${item.versatileDamage} ${formatMod(damageMod)}`
				: null,
			damageType: item.damageType ?? "",
			properties: item.properties ?? [],
			mastery: item.mastery ?? [],
			range: item.range,
			reach: attackReach(item, props),
			proficient: isProficient,
			isRanged,
			hasShield,
			// You cannot wield a Two-Handed weapon while holding a shield.
			shieldConflict: hasShield && props.includes("two-handed"),
			activeEffects: active,
			inactiveEffects: inactive,
		};
	});
}

/* ------------------------------------------------------------------ *
 * Full derived sheet
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Rests: hit dice and limited-use features
 * ------------------------------------------------------------------ */

/**
 * The hit dice pool, grouped by die size, with what has been spent.
 *
 * Dice are grouped by SIZE rather than by class because that is how they are
 * spent at the table: a Fighter 3 / Rogue 2 has 3d10 and 2d8 and picks whichever
 * suits the healing needed, not "a Fighter die".
 */
export function hitDicePool(char) {
	const spent = char.hitDiceUsed ?? {};
	return Object.entries(hitDice(char))
		.map(([die, total]) => {
			const used = Math.min(Number(spent[die] ?? 0), total);
			return { die, faces: Number(die.slice(1)), total, used, available: total - used };
		})
		// Biggest die first: that is the one you reach for.
		.sort((a, b) => b.faces - a.faces);
}

/** Half your total hit dice, rounded down, minimum one -- what a long rest returns. */
export function hitDiceRegainedOnLongRest(char) {
	const total = hitDicePool(char).reduce((n, h) => n + h.total, 0);
	return Math.max(1, Math.floor(total / 2));
}

/**
 * Turns a feature's extracted `resource` into a live counter.
 *
 * The extractor records either a per-level column from the class table
 * (`uses[19]`) or a formula it read out of the prose. Resolving happens here
 * because it depends on the character: proficiency bonus and ability modifiers
 * both move as they level.
 */
function resolveResourceMax(resource, char, classLevel) {
	if (Array.isArray(resource.uses)) {
		return Number(resource.uses[Math.max(0, classLevel - 1)] ?? 0);
	}
	const f = resource.formula;
	if (f === "proficiency") return proficiencyBonus(char);
	if (/^\d+$/.test(String(f))) return Number(f);
	// An ability abbreviation: uses equal to that modifier, minimum one.
	const mods = abilityMods(char);
	if (f && f in mods) return Math.max(1, mods[f]);
	return 0;
}

/**
 * Every limited-use feature the character has, and how many uses are left.
 *
 * This is what makes the rest buttons mean something. Each entry is keyed by
 * class and feature name so a Cleric 3 / Paladin 3 tracks two separate Channel
 * Divinity pools rather than one shared counter.
 *
 * `max` is derived and never stored; only `used` lives on the character, so a
 * level-up widens the pool without any migration.
 */
export function featureResources(char) {
	const spent = char.resourcesUsed ?? {};
	const out = [];

	const add = (classId, origin, feature, classLevel) => {
		if (!feature.resource) return;
		const key = `${classId}:${feature.name}`;
		// A feature reprinted at several levels (Indomitable) appears once.
		if (out.some((r) => r.key === key)) return;
		const max = resolveResourceMax(feature.resource, char, classLevel);
		if (max <= 0) return;
		const used = Math.min(Number(spent[key] ?? 0), max);
		out.push({
			key,
			name: feature.name,
			origin,
			level: feature.level,
			recharge: feature.resource.recharge,
			max,
			used,
			available: max - used,
			ref: `classFeature|${feature.name}|`,
		});
	};

	for (const entry of char.classes ?? []) {
		const cls = getClass(entry.classId);
		if (!cls) continue;
		const classLevel = entry.levels ?? 0;

		for (const blockLvl of cls.levels ?? []) {
			if (blockLvl.level > classLevel) continue;
			for (const f of blockLvl.features ?? []) add(entry.classId, cls.name, f, classLevel);
		}

		const sub = getSubclass(entry.classId, entry.subclassId);
		for (const blockLvl of sub?.levels ?? []) {
			if (blockLvl.level > classLevel) continue;
			for (const f of blockLvl.features ?? []) add(entry.classId, sub.name, f, classLevel);
		}
	}

	// Charged items -- a Wand of Magic Missiles, or whatever the DM invented --
	// are tracked the same way, because at the table they are the same job.
	for (const entry of char.equipment ?? []) {
		const item = getItem(entry.itemId);
		const charges = item?.charges;
		if (!charges?.max) continue;
		const key = `item:${item.id}`;
		if (out.some((r) => r.key === key)) continue;
		const max = Number(charges.max);
		if (!(max > 0)) continue;
		const used = Math.min(Number(spent[key] ?? 0), max);
		out.push({
			key,
			name: item.name,
			origin: item.custom ? "Custom item" : "Item",
			level: null,
			recharge: charges.recharge === "short" ? "short" : "long",
			max,
			used,
			available: max - used,
			ref: `item|${item.name}|`,
		});
	}

	return out.sort((a, b) => a.name.localeCompare(b.name));
}

/* ------------------------------------------------------------------ *
 * Languages
 * ------------------------------------------------------------------ */

/**
 * Everything the character speaks, and everything still to be chosen.
 *
 * The two editions grant languages from different places, which is why this is
 * derived rather than stored:
 *
 *   2014  the species grants fixed languages (Dwarvish, Elvish) and some
 *         backgrounds grant a number of free choices.
 *   2024  languages moved out of species and background entirely. Every
 *         character knows Common plus two more of their choice, as part of
 *         their origin. That rule lives in the PHB's Languages section rather
 *         than on any species or background record, so it is stated here.
 *
 * Feats add to either edition: Linguist grants three, Fey Teleportation grants
 * Sylvan outright.
 */
export function languages(char) {
	const known = [];
	const pending = [];
	const seen = new Set();

	const add = (name, source) => {
		const key = String(name).toLowerCase();
		if (!name || seen.has(key)) return;
		seen.add(key);
		known.push({ name, source });
	};

	/**
	 * A grant of the shape { fixed: [...], choices: [{ count, from }] }.
	 * `picked` is whatever the player has chosen against it so far.
	 */
	const applyGrant = (grant, sourceName, bucket, picked) => {
		if (!grant) return;
		for (const name of grant.fixed ?? []) add(name, sourceName);

		const wanted = (grant.choices ?? []).reduce((n, c) => n + (c.count ?? 1), 0);
		if (!wanted) return;
		for (const name of picked ?? []) add(name, sourceName);
		const short = wanted - (picked ?? []).length;
		if (short > 0) pending.push({ source: sourceName, bucket, count: short, total: wanted });
	};

	// The 2024 origin grant. Common is automatic; the other two are chosen.
	if ((char.edition ?? "2024") === "2024") {
		add("Common", "Origin");
		applyGrant(
			{ choices: [{ count: 2, from: "any" }] },
			"Origin",
			"origin",
			char.languageChoices?.origin,
		);
	}

	const species = getSpecies(char.speciesId);
	if (species) {
		applyGrant(species.languageProficiencies, species.name, "species", char.languageChoices?.species);
	}

	const bg = getBackground(char.backgroundId);
	if (bg) {
		applyGrant(bg.languageProficiencies, bg.name, "background", char.languageChoices?.background);
	}

	for (const held of grantedFeats(char)) {
		const feat = (db.feats ?? []).find((f) => f.name === held.name);
		const grant = feat?.mechanics?.languages;
		if (!grant) continue;
		applyGrant(grant, held.name, `feat:${held.name}`, char.languageChoices?.feat?.[held.name]);
	}

	// Anything added by hand on the sheet.
	for (const name of char.languages ?? []) add(name, "Added by hand");

	return { known, pending };
}

/** The flat list, for the sheet and for the proficiencies block. */
export const languageNames = (char) => languages(char).known.map((l) => l.name);

export function derive(char) {
	const scores = abilityScores(char);
	const mods = abilityMods(char);
	const hp = hitPoints(char);
	return {
		level: totalLevel(char),
		proficiencyBonus: proficiencyBonus(char),
		abilityScores: scores,
		abilityMods: mods,
		hp,
		hitDice: hitDice(char),
		hitDicePool: hitDicePool(char),
		languages: languages(char),
		expertiseGrants: expertiseGrants(char),
		skillOverrides: skillOverrideList(char),
		featureResources: featureResources(char),
		ac: armorClass(char),
		initiative: initiative(char),
		speed: speed(char),
		darkvision: darkvision(char),
		passivePerception: passivePerception(char),
		savingThrows: savingThrows(char),
		skills: skills(char),
		spellcasting: spellcasting(char),
		features: unlockedFeatures(char),
		proficiencies: proficiencies(char),
		attacks: attacks(char),
		carrying: carryingCapacity(char),
		weight: totalWeight(char),
	};
}
