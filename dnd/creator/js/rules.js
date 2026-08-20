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
		const eff = effectSum(char, "abilityScore", id);
		const cap = 20 + effectSum(char, "abilityScoreMax", id);
		out[id] = Math.min(cap, base + bg + asi + eff);
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
	return new Set(first?.savingThrows ?? []);
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

	// Feats can grant skills (Skilled, Prodigy).
	for (const feat of grantedFeats(char)) {
		const entry = db.feats?.find((f) => f.name === feat.name);
		for (const s of entry?.skillProficiencies?.fixed ?? []) add(s, feat.name);
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

export function skills(char) {
	const mods = abilityMods(char);
	const pb = proficiencyBonus(char);
	const profs = skillProficiencySet(char);
	const expertise = new Set(char.expertise ?? []);

	return allSkills().map((s) => {
		const proficient = profs.has(s.id);
		const expert = expertise.has(s.id);
		const bonus = proficient ? (expert ? pb * 2 : pb) : 0;
		return {
			...s,
			proficient,
			expertise: expert,
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
		languages: char.languages ?? [],
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
export function gripFor(entry, item) {
	const props = (item?.properties ?? []).map((p) => p.toLowerCase());
	if (props.includes("two-handed")) return "two-handed";
	if (entry?.grip === "one-handed" || entry?.grip === "two-handed") return entry.grip;
	// Versatile defaults to two hands, which is how most players use it when a
	// shield is not involved.
	if (props.includes("versatile")) return "two-handed";
	return "one-handed";
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
		const grip = gripFor(entry, item);

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

		const damageMod = abilityMod + bonusDamage;

		return {
			name: item.name,
			ability,
			grip,
			attackBonus: abilityMod + (isProficient ? pb : 0) + bonusAttack + effectSum(char, "attackBonus"),
			damage: dieUsed ? `${dieUsed} ${formatMod(damageMod)}` : "—",
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
			proficient: isProficient,
			isRanged,
			activeEffects: active,
			inactiveEffects: inactive,
		};
	});
}

/* ------------------------------------------------------------------ *
 * Full derived sheet
 * ------------------------------------------------------------------ */

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
