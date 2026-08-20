/**
 * effects.js - numeric hooks for rules that exist only as prose.
 *
 * 5etools stores rules text, not rules logic: Dwarven Toughness is a paragraph,
 * not a "+1 HP per level" field. Rather than guess by parsing English, the
 * handful of traits, feats and features that change a derived number are
 * declared here by name.
 *
 * This list is deliberately small and easy to extend. Anything not listed still
 * shows up in full on the sheet as feature text, so nothing is lost -- it just
 * is not auto-totalled. Every derived number also has a manual override on the
 * sheet, which is the escape hatch for homebrew and for anything missed here.
 *
 * To add one: give the exact feature name as it appears in the data, plus the
 * effects it grants. `edition` is optional and narrows the match when the 2014
 * and 2024 versions of a feature differ.
 */

import { db, getSpecies, getClass, getSubclass, getBackground } from "./data.js";
import { grantedFeats } from "./rules.js";

/**
 * Effect types consumed by rules.js:
 *   hpPerLevel, hpBonus          - hit points
 *   acBonus, unarmoredDefense    - armour class
 *   speedBonus, darkvision       - movement and senses
 *   initiativeBonus              - initiative
 *   passivePerception            - passive scores
 *   skillBonus, saveBonus        - keyed by skill/ability id
 *   abilityScore, abilityScoreMax- keyed by ability id
 *   spellSaveDc, spellAttackBonus, attackBonus
 *   mediumArmorDexCap            - raises the medium-armour DEX cap
 *   carryMultiplier              - Powerful Build and similar
 */
const EFFECT_RULES = [
	/* --- Species traits --------------------------------------------- */
	{
		name: "Dwarven Toughness",
		effects: [{ type: "hpPerLevel", value: 1 }],
	},
	{
		name: "Powerful Build",
		effects: [{ type: "carryMultiplier", value: 2 }],
	},

	/* --- Species lineage picks ---------------------------------------
	 * The 2024 lineages are printed as a table inside the species entry, so
	 * their numeric parts (Wood Elf's extra speed, Drow's longer Darkvision)
	 * exist only as prose and have to be declared here.
	 */
	{
		name: "Wood Elf",
		edition: "2024",
		effects: [{ type: "speedBonus", value: 5 }],
	},
	{
		name: "Drow",
		edition: "2024",
		effects: [{ type: "darkvision", value: 120 }],
	},

	/* --- Feats ------------------------------------------------------- */
	{
		name: "Tough",
		effects: [{ type: "hpPerLevel", value: 2 }],
	},
	{
		name: "Durable",
		edition: "2024",
		effects: [{ type: "hpPerLevel", value: 1 }],
	},
	{
		name: "Observant",
		edition: "2014",
		effects: [{ type: "passivePerception", value: 5 }],
	},
	{
		name: "Medium Armor Master",
		effects: [{ type: "mediumArmorDexCap", value: 1 }],
	},
	{
		name: "Mobile",
		effects: [{ type: "speedBonus", value: 10 }],
	},
	{
		name: "Squat Nimbleness",
		effects: [{ type: "speedBonus", value: 5 }],
	},

	/* --- Class features ---------------------------------------------- */
	{
		name: "Unarmored Defense",
		className: "Barbarian",
		effects: [{ type: "unarmoredDefense", base: 10, ability: "con", label: "Unarmoured Defence" }],
	},
	{
		name: "Unarmored Defense",
		className: "Monk",
		effects: [{ type: "unarmoredDefense", base: 10, ability: "wis", label: "Unarmoured Defence" }],
	},
	{
		name: "Unarmored Movement",
		className: "Monk",
		// Scales with level; the table on the sheet shows the exact value.
		scaling: (level) =>
			level >= 18 ? 30 : level >= 14 ? 25 : level >= 10 ? 20 : level >= 6 ? 15 : level >= 2 ? 10 : 0,
		effectType: "speedBonus",
	},
	{
		name: "Fast Movement",
		className: "Barbarian",
		effects: [{ type: "speedBonus", value: 10 }],
	},
	{
		name: "Draconic Resilience",
		effects: [
			{ type: "hpPerLevel", value: 1 },
			{ type: "unarmoredDefense", base: 13, ability: null, label: "Draconic Resilience" },
		],
	},

	/* --- Fighting styles --------------------------------------------- */
	{
		name: "Defense",
		effects: [{ type: "acBonus", value: 1 }],
	},
];

/* ------------------------------------------------------------------ *
 * Conditional attack effects
 *
 * Some features change an attack only in certain circumstances. Dueling gives
 * +2 damage "when you're holding a Melee weapon in one hand and no other
 * weapons" -- so with a Glaive and a Longsword both in hand it does nothing,
 * and with only the Longsword in one hand it applies.
 *
 * Each rule therefore carries a predicate over the attack's context plus a
 * plain-English `requires` line. rules.js evaluates them per weapon and reports
 * both the ones that fired AND the ones that did not, with the reason -- which
 * is the only way a player can tell "this is broken" from "you're holding two
 * weapons".
 *
 * Context passed to applies():
 *   isMelee, isRanged      the weapon's kind
 *   grip                   "one-handed" | "two-handed"
 *   properties             lowercased property names, e.g. ["versatile"]
 *   otherWeaponsInHand     how many OTHER weapons are marked in hand
 *   hasShield              a shield is equipped
 *   abilityMod             the modifier already being added
 * ------------------------------------------------------------------ */

const ATTACK_RULES = [
	{
		name: "Dueling",
		kind: "damage",
		value: 2,
		requires: "a Melee weapon in one hand, and no other weapon in hand",
		applies: (ctx) =>
			ctx.isMelee && ctx.grip === "one-handed" && ctx.otherWeaponsInHand === 0,
		explain: (ctx) => {
			if (!ctx.isMelee) return "this is not a Melee weapon";
			if (ctx.grip !== "one-handed") return "this weapon is being held in two hands";
			return `you have ${ctx.otherWeaponsInHand} other weapon${ctx.otherWeaponsInHand === 1 ? "" : "s"} in hand`;
		},
	},
	{
		name: "Archery",
		kind: "attack",
		value: 2,
		requires: "a Ranged weapon",
		applies: (ctx) => ctx.isRanged,
		explain: () => "this is not a Ranged weapon",
	},
	{
		name: "Thrown Weapon Fighting",
		kind: "damage",
		value: 2,
		requires: "a weapon with the Thrown property, on a ranged attack",
		applies: (ctx) => ctx.properties.includes("thrown"),
		explain: () => "this weapon does not have the Thrown property",
	},
	{
		name: "Great Weapon Fighting",
		kind: "note",
		note: "Treat any 1 or 2 on a damage die as a 3",
		requires: "a Melee weapon held in two hands with the Two-Handed or Versatile property",
		applies: (ctx) =>
			ctx.isMelee && ctx.grip === "two-handed"
			&& (ctx.properties.includes("two-handed") || ctx.properties.includes("versatile")),
		explain: (ctx) => {
			if (!ctx.isMelee) return "this is not a Melee weapon";
			if (ctx.grip !== "two-handed") return "this weapon is being held in one hand";
			return "this weapon is neither Two-Handed nor Versatile";
		},
	},
	{
		name: "Two-Weapon Fighting",
		kind: "note",
		note: "Add your ability modifier to the damage of the extra attack",
		requires: "a weapon with the Light property",
		applies: (ctx) => ctx.properties.includes("light"),
		explain: () => "this weapon does not have the Light property",
	},
	{
		name: "Unarmed Fighting",
		kind: "note",
		note: "Your Unarmed Strike can deal 1d6 + STR Bludgeoning damage instead",
		requires: "an Unarmed Strike",
		applies: (ctx) => ctx.isUnarmed,
		explain: () => "this applies to Unarmed Strikes, not weapons",
	},

	/* --- Feats with conditional attack numbers ----------------------- */
	{
		name: "Great Weapon Master",
		kind: "note",
		note: "Once per turn on a hit, add your Proficiency Bonus to the damage",
		requires: "a Heavy Melee weapon",
		applies: (ctx) => ctx.isMelee && ctx.properties.includes("heavy"),
		explain: (ctx) =>
			ctx.isMelee ? "this weapon does not have the Heavy property" : "this is not a Melee weapon",
	},
	{
		name: "Polearm Master",
		kind: "note",
		note: "Bonus Action attack with the butt end for 1d4 + ability modifier",
		requires: "a Glaive, Halberd, Quarterstaff or Spear",
		applies: (ctx) => ["glaive", "halberd", "quarterstaff", "spear"].includes(ctx.weaponName),
		explain: () => "this is not a Glaive, Halberd, Quarterstaff or Spear",
	},
	{
		name: "Sharpshooter",
		kind: "note",
		note: "Ignore Long range penalties and half/three-quarters Cover",
		requires: "a Ranged weapon",
		applies: (ctx) => ctx.isRanged,
		explain: () => "this is not a Ranged weapon",
	},
];

/**
 * The attack rules this character actually has, resolved against their features.
 * rules.js decides per weapon whether each one fires.
 */
export function attackRulesFor(char) {
	const owned = ownedFeatures(char);
	const out = [];

	for (const rule of ATTACK_RULES) {
		const match = owned.find((o) => o.name === rule.name);
		if (match) out.push(rule);
	}
	return out;
}

/* ------------------------------------------------------------------ *
 * Collecting what the character actually has
 * ------------------------------------------------------------------ */

/**
 * Gathers every named thing the character possesses, along with the class it
 * came from and the level of that class, so scaling features resolve correctly.
 */
function ownedFeatures(char) {
	const owned = [];
	const edition = char.edition ?? "2024";

	// Species traits and the chosen lineage
	const species = getSpecies(char.speciesId);
	for (const t of species?.traits ?? []) {
		owned.push({ name: t.name, edition: species.edition });
	}
	for (const choice of species?.choices ?? []) {
		const picked = choice.options?.find((o) => o.id === char.speciesChoices?.[choice.id]);
		if (picked) owned.push({ name: picked.name, edition: species.edition });
	}

	// Every feat the character holds, however they got it: granted by the
	// background, chosen for a species trait, or taken at level-up.
	for (const held of grantedFeats(char)) {
		const feat = (db.feats ?? []).find((f) => f.name === held.name);
		owned.push({ name: held.name, edition: feat?.edition ?? edition });
	}

	// Fighting styles and other optional-feature picks stored by name
	for (const name of char.optionalFeaturePicks ?? []) {
		owned.push({ name, edition });
	}

	// Class and subclass features unlocked at the current level
	for (const entry of char.classes ?? []) {
		const cls = getClass(entry.classId);
		if (!cls) continue;
		const lvl = entry.levels ?? 0;

		for (const block of cls.levels ?? []) {
			if (block.level > lvl) continue;
			for (const f of block.features ?? []) {
				owned.push({ name: f.name, className: cls.name, classLevel: lvl, edition: cls.edition });
			}
		}

		const sub = getSubclass(entry.classId, entry.subclassId);
		for (const block of sub?.levels ?? []) {
			if (block.level > lvl) continue;
			for (const f of block.features ?? []) {
				owned.push({ name: f.name, className: cls.name, classLevel: lvl, edition: sub.edition });
			}
		}
	}

	return owned;
}

/** True when a rule entry applies to an owned feature. */
function matches(rule, owned) {
	if (rule.name !== owned.name) return false;
	if (rule.className && rule.className !== owned.className) return false;
	if (rule.edition && rule.edition !== owned.edition) return false;
	return true;
}

/**
 * Returns the flat list of active effects for a character.
 * rules.js sums these by type; unknown types are simply ignored.
 */
export function effectsFor(char) {
	const out = [];
	const owned = ownedFeatures(char);

	for (const owning of owned) {
		for (const rule of EFFECT_RULES) {
			if (!matches(rule, owning)) continue;

			if (rule.scaling && rule.effectType) {
				const value = rule.scaling(owning.classLevel ?? 1);
				if (value) out.push({ type: rule.effectType, value });
				continue;
			}
			for (const e of rule.effects ?? []) out.push({ ...e });
		}
	}

	// Anything the player added by hand on the sheet.
	for (const e of char.customEffects ?? []) out.push({ ...e });

	return out;
}

/** Exposed so the UI can show which automatic effects are in play. */
export function describeEffects(char) {
	return effectsFor(char)
		.filter((e) => e.type !== "attackBonus" || e.value)
		.map((e) => {
			switch (e.type) {
				case "hpPerLevel": return `${e.value >= 0 ? "+" : ""}${e.value} HP per level`;
				case "hpBonus": return `${e.value >= 0 ? "+" : ""}${e.value} HP`;
				case "acBonus": return `${e.value >= 0 ? "+" : ""}${e.value} AC`;
				case "unarmoredDefense": return `${e.label}: ${e.base} + DEX${e.ability ? ` + ${e.ability.toUpperCase()}` : ""}`;
				case "speedBonus": return `${e.value >= 0 ? "+" : ""}${e.value} ft speed`;
				case "carryMultiplier": return `Carrying capacity x${e.value}`;
				case "mediumArmorDexCap": return `Medium armour DEX cap +${e.value}`;
				case "passivePerception": return `${e.value >= 0 ? "+" : ""}${e.value} passive Perception`;
				default: return `${e.type} ${e.value ?? ""}`.trim();
			}
		});
}
