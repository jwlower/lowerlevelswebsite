# Continuation prompt — D&D character creator

Paste everything below into a new session.

---

I'm continuing work on the D&D character creator at `dnd/creator/` in this repo
(`C:\Users\jlowe\Documents\LowerLevelsWebsite\lowerlevelswebsite`). It's a pure static
ES-module app (no build step, localStorage persistence) modelled on OrcPub and the 5e
Character Creator mobile app, meant to be hosted on my LAN so my group can build and level
characters and print paper sheets. The rules database is extracted from my 5etools dump by
`tools/extract-5etools.mjs`.

## First thing to do

**There is one known bug I had just introduced and not yet fixed:** `sheet.js` now calls
`choiceList(...)` (in the new `expertiseDialog`) but `choiceList` is **not** in its import
list from `./ui.js`. Add it, then reload and check the console. Verify the other new
sheet.js helpers have their imports too (`notice`, `toast`, `modal`, `refLink`,
`showReference` should already be there).

## How to work in this codebase

- **Dev server:** already configured. `mcp__Claude_Browser__preview_start` with
  `{name: "lowerlevels"}` (port 8123, serves with `Cache-Control: no-store` via
  `tools/dev-server.py` — that no-store header is essential, browser module caching
  repeatedly looked like phantom bugs).
- **Page:** `http://localhost:8123/dnd/character-creator.html`. Reload with a cache-buster
  (`location.href = "/dnd/character-creator.html?v=" + Date.now()`).
- **Screenshots don't work** in my setup (the Browser pane isn't displayed, so the page
  isn't compositing). Verify with `read_page`, `get_page_text`, and `javascript_tool`
  instead — driving the UI from `javascript_tool` with `await new Promise(r=>setTimeout(...))`
  between clicks works well.
- **`read_console_messages` returns a stale buffer.** Errors from earlier loads persist.
  Stamp it (`console.log("MARKER")`) before trusting what you see.
- **Editing files:** bash heredocs break on apostrophes in this environment. Write a
  Node patch script into the scratchpad with the Write tool, then run it with `node`. Two
  traps that bit me repeatedly:
  - `data.js` and `creator.css` are **CRLF**; the other JS files are **LF**. Normalise to
    LF, patch, then restore. (There's a reusable `edit(file, pairs)` helper in the
    scratchpad patch scripts.)
  - Regex escapes get eaten passing through template literals — `\d` became `d`,
    `\b` became a literal 0x08 byte. Both caused silent wrong behaviour. Use
    `String.raw` and grep the result afterwards.
  - `sheet.js` uses `×` (U+00D7) and `·` (U+00B7), not `x` and `.` — match exactly.
- **Rebuild the database** after any extractor change:
  ```
  node tools/extract-5etools.mjs --src "C:/Users/jlowe/Downloads/5etools-src-main/5etools-src-main/data" --out dnd/creator/data --tier full
  ```
  `dnd/creator/data/` is gitignored (full non-SRD book text — never publish it; use
  `--tier srd` for anything that reaches Neocities).

## Done and verified this session

1. **Rests, HP, hit dice, feature uses.** New `dnd/creator/js/rest.js`. Short rest spends
   hit dice one at a time with real rolls plus CON; long rest restores HP, all slots, all
   feature uses, and half your hit dice (biggest first). New `rules.hitDicePool`,
   `rules.hitDiceRegainedOnLongRest`, `rules.featureResources`. New "Uses" box on the sheet
   with a clickable box per use, colour-coded by which rest refills it. Verified end to end
   on a Wizard 5: spent a d6 for +3 HP, dice 5/5 → 4/5, long rest put everything back.
2. **Extractor: limited-use features.** `normFeatureResource` in the extractor reads use
   counts from the class table column and the recharge clause from the prose. My first pass
   over-matched badly (Weapon Mastery, Spellcasting, Pact Magic flagged as resources;
   `formula undefined`; duplicates) — I tightened it to require an actual
   expend-and-regain clause plus a resolvable count, and it now produces clean output for
   all twelve 2024 classes (Second Wind 3/short, Action Surge 1/short, Channel Divinity
   2/short, Rage 3, Monk's Focus 5, Bardic Inspiration cha/long, etc.).
3. **HP block reworked to my spec.** Top rest bar removed; Short/Long rest buttons moved
   inside the HP block. Standard current/max readout, `−[X]+` adjuster where X is any
   positive integer I type (damage comes off temp HP first), temp HP field, hit dice
   remaining, and clicking the maximum opens a dialog with the full breakdown plus a
   **bonus maximum HP** field (adds to the derived max rather than overriding it, so
   levelling still works). Then resized per my follow-up: bigger "Hit Points" label,
   much bigger current/max, centred, smaller adjuster and temp field.
4. **Every class and background starting-kit item now resolves from the database.** This
   was three separate bugs. `equipment.json` held only 230 items (weapons/armour/tools)
   because `items.json` mixes ordinary gear in with magic items, so packs, lanterns, rope,
   rations, holy symbols and quivers all landed in `magic-items.json` where
   `getItemByRef` never looked — the extractor now splits by *whether an item is actually
   magical*, not by source file (equipment.json is now 1,137 items). Background kits list
   entries as bare strings (`"bedroll|xphb"`) which the normaliser treated as prose,
   losing the item reference. And category refs like `holy-symbol` are item *groups*, now
   emitted as equipment entries carrying `isGroup: true` and their members. Audit script
   (`scratchpad/audit_starting_equipment.cjs`) went from **40 unresolved refs + 68
   unnormalised entries → 0 and 0**; the only remaining no-ref entries are the three
   genuine category choices (Artisan's Tools, Gaming Set, Musical Instrument).
5. **Arcane Recovery is usable.** `slotRecoveryFor` / `slotRecoveryDialog` in `rest.js`,
   with a small declared table (`SLOT_RECOVERY`) because the budget is prose. Offered both
   in the Uses box and inside the short-rest dialog. Verified on a Wizard 5: budget 3
   combined slot levels, picking a 3rd-level slot exhausts it and correctly disables the
   1st- and 2nd-level buttons, confirming restored the slot and marked the feature used.
   Warlock's Magical Cunning is wired to the pact-slot variant.
6. **Extractor: expertise grants.** `normFeatureExpertise` reads them off the prose.
   Verified: Rogue Expertise L1 and L6 (2 each, any proficient skill), Bard L2/L9,
   Ranger Deft Explorer L2 (1) and Expertise L9 (2), Wizard Scholar L2 (1 from an explicit
   list of Arcana/History/Investigation/Medicine/Nature/Religion).

## Answered, no code needed

**Magic Initiate (Cleric)** *is* in the database — both editions, and the 2024 XPHB entry
correctly carries its Cleric / Druid / Wizard spell-list variants with the picker already
built (`feats.js` renders `mech.spellVariants`). The reason I wasn't seeing it: in the 2024
rules Magic Initiate is an **Origin** feat, and `asiFeatOptions` restricts ASI feats to
General ones, which is correct by the book. So it appears at the background origin-feat
step, not at an ASI. In 2014 it's a General feat with all six lists and does appear at ASIs.
If I want it at 2024 ASIs anyway, add a house-rule toggle next to the existing
`houseRules.ignoreFeatPrerequisites` — that was my thinking and it's about ten lines.

## Built but NOT yet verified in the browser

Everything below compiles (`node --check` clean) but has not been exercised. Verify each,
then fix what's broken.

1. **Custom item builder** — new `dnd/creator/js/items.js`, `customItemBuilder()`. Start
   from a real item as a template (inherits damage dice, properties, mastery, weight,
   range) or build blank; set rarity, attack/damage bonus, extra damage, AC bonus,
   attunement, charges with a recharge, weight, value, description. Stored on the character
   as `char.customItems` in exactly the database item shape, and registered via
   `data.setCustomItems` so `getItem` resolves them — meaning attacks, AC, the equipment
   list and item popovers all treat them like printed items with no special cases.
   `app.js` fills the registry on session open and on every update.
2. **`bonusWeapon` / `bonusAc` are now actually applied.** They were extracted but never
   read, so even a database `+1 Longsword` showed no bonus. New `rules.itemAttackBonus` /
   `rules.itemAcBonus`, applied to attack rolls, damage and AC. **Worth testing with a real
   magic item, not just a custom one.**
3. **Item charges appear in the Uses box** alongside class features (`featureResources`
   now walks equipment too).
4. **Unpack** — `isUnpackable` / `unpack` / `packSummary` in `items.js`. Replaces a pack
   with its contents, multiplying quantities (two Explorer's Packs → twenty torches), and
   keeps `{special}` contents ("alms box", "vestments") as plain named lines. Wired into
   both the equipment step and the sheet's equipment box.
5. **Sell at X%** — `sellDialog`. Defaults to 50%, presets for 25/50/100, any rate I type;
   remembers the rate on the character as `char.sellRate`. Proceeds convert to gp/sp/cp so
   fractions aren't rounded away. Quantity selectable when I own several.
6. **Group choice** — `groupChoiceDialog` turns "a Holy Symbol" into a specific Amulet,
   Emblem or Reliquary.
7. **Languages** — `rules.languages(char)` returns `{known, pending}` with a source on each.
   2024: Common plus two chosen (declared here, since it's an origin rule that lives on no
   species or background record). 2014: species fixed + background choices. Feats too —
   the extractor now pulls `languageProficiencies` for feats, giving Linguist 3 choices,
   Fey Teleportation Sylvan, and five others. Picker added to the Background step,
   source-tracked as `char.languageChoices` so a language already known is greyed out
   rather than offered twice.
8. **Manual skill overrides + expertise pickers** — `char.skillOverrides`
   (`{skillId: "none"|"proficient"|"expert"}`) wins over the derived value;
   `rules.skillsFromBuild` and `rules.skillOverrideList` expose what the builder thinks so
   the dialog can show both and offer "put them all back". Overridden skills get a `*` on
   the sheet. Separately, `rules.expertiseGrants` surfaces each expertise-granting feature
   as its own decision keyed `classId:Feature:level` (so a Rogue's L1 and L6 pairs stay
   distinct), filtered to skills I'm actually proficient in, with an unassigned-expertise
   warning on the skills box. **This is where the missing `choiceList` import is.**

## What I asked for that still isn't built

- **Expertise pickers reachable by clicking the feature itself.** I asked for this
  specifically: clicking Scholar (or Rogue/Bard Expertise) in the Features & traits list
  should let me assign it right there. Currently the only route is the Expertise button on
  the skills box. The features block already has a `jump`/timeline mechanism —
  `rules.expertiseGrants` returns a `ref` per grant, so hooking it into `featuresBlock`
  should be straightforward.
- **CSS for the skills/expertise dialogs.** I added styles for the rest, HP, recovery,
  equipment-action, sell, item-builder and language UI, but not for
  `.expertise-dialog`, `.skill-override*`, or `.skill-override-mark`.
- **Verification sweep** of items 1–8 above.

## Standing preferences

- Prefer the circular "?" icon over "What is X?" text links.
- Pop-up backgrounds must be solid (modals mount inside `.creator` so the CSS variables
  resolve — don't move them to `document.body`).
- Nothing derived is ever stored; the sheet re-derives from the character plus the
  database. Only "spent" counters and explicit overrides get written.
- Everything highlighted should be clickable to its blurb (the delegated `.rr-ref`
  listener in `glossary.js`).
- Don't let a control lose scroll position on click, and snap the relevant control into
  view when I click "Change this".
- We play on paper, so the print stylesheet matters: hide interactive chrome, keep the
  pips as tickable boxes.
