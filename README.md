# Lower Levels Tabletop Hub

A personal TTRPG site for one-shots, session reports, house rules, and resources across D&D 2024, Monster of the Week, and Borg-like games. Free and shareable.

**Live site:** hosted on Neocities  
**Local dev:** `python -m http.server 8000` from the project root, then open `http://localhost:8000`

> You need a local server because the browser blocks `fetch()` on plain `file://` URLs.

---

## Site structure

```
/
├── index.html                  Homepage: about blurb, announcements, game hubs, recent blog posts
├── post.html                   Universal blog post renderer (reads ?p=slug, renders Markdown)
├── styles.css                  All styles: one file for the whole site
├── announcements.json          Short dated activity posts shown on the homepage
│
├── posts/
│   ├── posts.json              Blog post manifest: one entry per post, newest first
│   └── YYYY-MM-DD-slug.md      Blog post content files
│
├── resources/
│   ├── index.html              Resource hub: Google Drive/PDF links with category filter
│   └── resources.json          Resource entries
│
├── recommended/
│   ├── index.html              Curated links to other people's content
│   └── recommended.json        Recommendation entries
│
├── blog/
│   └── index.html              Blog archive: all posts, newest first, with tag filter
│
├── dnd/
│   ├── index.html              D&D 2024 hub
│   ├── posts.json              D&D document links
│   ├── character-creator.html  Guided character builder (see below)
│   └── creator/                Its CSS, JS modules, and generated rules database
│
├── motw/
│   ├── index.html              Monster of the Week hub
│   └── posts.json              MotW document links
│
├── borg/
│   ├── index.html              Borg-Likes hub
│   ├── pirate-borg-posts.json  Pirate Borg document links
│   └── orc-borg-posts.json     Orc Borg document links
│
├── scripts/
│   └── posts.js                Shared post-feed loader used by all pages
│
└── tools/
    └── extract-5etools.mjs     Builds the character creator's rules database
```

---

## Writing a blog post (2 steps)

### Step 1: create the Markdown file

Create `posts/YYYY-MM-DD-your-title.md`. Use this frontmatter at the top:

```markdown
---
title: Your Post Title
date: 2026-04-15
excerpt: One sentence shown in listings and on the homepage.
tags: [general, motw]
type: blog
---

Your post content here. Standard Markdown works: **bold**, *italic*,
## headings, [links](https://example.com), lists, blockquotes, etc.
```

**For a session report**, add `type: session` and the extra fields:

```markdown
---
title: "Session: MotW at the Gaming Club"
date: 2026-04-15
excerpt: Four hunters, one very confused werewolf.
tags: [motw, session-report]
type: session
system: Monster of the Week
players: 4
duration: 3h
---
```

### Step 2: add one entry to `posts/posts.json`

```json
{
  "title": "Your Post Title",
  "date": "2026-04-15",
  "excerpt": "One sentence shown in listings.",
  "slug": "2026-04-15-your-title",
  "tags": ["general"],
  "type": "blog"
}
```

The slug must match the filename (without `.md`). That's it: the homepage feed, blog archive, and tag filters all update automatically.

---

## Adding a document link (Google Drive / PDF)

Add an entry to `resources/resources.json`:

```json
{
  "title": "My One-Shot Title",
  "date": "2026-04-15",
  "description": "A short blurb about what this document is.",
  "link": "https://docs.google.com/...",
  "category": "dnd"
}
```

Valid categories: `dnd` · `motw` · `borg` · `general`

To add a doc to a specific game page instead, add it to that game's `posts.json` (e.g. `dnd/posts.json`) using the same format but without `category`.

---

## Adding an announcement

Add an entry to `announcements.json` at the root:

```json
{
  "title": "Game Night This Friday",
  "date": "2026-04-15",
  "body": "Short description of the event.",
  "link": "https://optional-rsvp-link"
}
```

Announcements appear on the homepage above the Games section. The `link` field is optional.

---

## Adding a recommended link

Add an entry to `recommended/recommended.json`:

```json
{
  "title": "Link Title",
  "url": "https://...",
  "description": "Why this is worth visiting.",
  "category": "official",
  "system": "motw"
}
```

Valid categories: `official` · `tools` · `creators` · `community`  
Valid systems: `dnd` · `motw` · `borg` · `general`

---

## Tags

Tags are free-form strings in the `tags` array of each `posts.json` entry. Whatever tags you use will automatically appear as filter buttons on the Blog and Resources pages. Suggested conventions:

| Tag | Use for |
|---|---|
| `general` | Posts not tied to a specific system |
| `dnd` | D&D 2024 content |
| `motw` | Monster of the Week content |
| `borg` | Pirate Borg / Orc Borg content |
| `session-report` | Play session write-ups |
| `con` | Convention or public event reports |
| `house-rules` | Rule modifications |
| `one-shot` | Standalone adventure content |

---

## Future hosting

The site is plain HTML/CSS/JS with no build step: it runs anywhere that serves static files. When moving off Neocities:

- **GitHub Pages / Cloudflare Pages / Netlify**: free, deploy by pushing to git. No changes needed to the site.
- **Adding a build step later**: the `.md` files in `posts/` use standard frontmatter compatible with Hugo, Eleventy, and Jekyll. Migrating to an SSG later means pointing it at the existing files, not rewriting them.

---

## Character Creator

A guided D&D character builder at `dnd/character-creator.html`. Pick a class,
species, background, abilities and gear step by step, level up, and print a
paper sheet. It supports both rulesets: **2024 (5.5e)** and **2014 (5e)**.

It is pure static HTML/CSS/JS like the rest of the site — no build step, no
server, no dependencies. Characters save to the browser's localStorage, with
JSON export/import to move one between devices.

### Running it on your LAN

From the project root:

```bash
python tools/dev-server.py 8000
```

Then on any device on the same network, open `http://<your-ip>:8000/dnd/character-creator.html`.
Find your IP with `ipconfig` on Windows or `ip addr` on Linux.

**Use this instead of `python -m http.server`.** Browsers cache ES modules and
JSON aggressively, and with a plain static server an edit to a `.js` file often
leaves the old version running — which looks exactly like your change not
working. `tools/dev-server.py` sends `no-store` on everything, so a refresh
always loads current files. It also binds all interfaces for the LAN and pins
the JavaScript MIME type, which some Windows registry setups get wrong.

> The creator needs `http://`, not `file://` — browsers block `fetch()` on file URLs.

### Generating the rules database

The creator reads JSON from `dnd/creator/data/`, which is **not committed**.
Generate it from a [5etools](https://github.com/5etools-mirror-3/5etools-src)
data directory:

```bash
node tools/extract-5etools.mjs --src "C:/path/to/5etools-src/data" --tier full
```

This writes species, classes, subclasses, backgrounds, feats, optional features,
equipment, spells and rules reference into `dnd/creator/data/`. Bestiary,
adventures and DM tooling are skipped — character creation only.

**Two tiers, and why it matters:**

| Tier | Contents | Use for |
|---|---|---|
| `--tier full` | Everything in the 5etools dump, all books | Your LAN, from books you own |
| `--tier srd` | Only material flagged as SRD (CC BY 4.0) | Anything published publicly |

The full build contains complete non-SRD book text. `/dnd/creator/data/` is in
`.gitignore` so it never reaches the public repo or Neocities by accident. For
the public site, build the SRD tier to a separate folder and ship that instead:

```bash
node tools/extract-5etools.mjs --src "C:/path/to/5etools-src/data" --out dnd/creator/data-srd --tier srd
```

### How it fits together

```
dnd/
├── character-creator.html      Page shell
└── creator/
    ├── creator.css             Theme + print stylesheet
    ├── data/                   Generated database (gitignored)
    ├── homebrew/               Your own content, shared by everyone on the server
    └── js/
        ├── app.js              Boot, routing, roster, level-up, homebrew manager
        ├── wizard.js           The creation steps
        ├── sheet.js            Character sheet + print layout
        ├── rules.js            Derived stats: HP, AC, saves, skills, slots
        ├── effects.js          Numeric hooks for prose-only rules
        ├── statblock.js        Wild Shape forms, companions, summoned creatures
        ├── state.js            Character record + localStorage
        ├── data.js             Database loading, homebrew merging, lookup
        └── ui.js               DOM helpers
```

### Creatures: Wild Shape, companions and summons

These are creature stat blocks rather than class features, so they get their own
step, shown only when the character has a feature that needs one:

- **Wild Shape** — the Druid picks forms from the Beast pool. The list narrows
  itself by Druid level: CR 1/4 and no flying at level 2, widening to CR 1 with
  flight at level 8.
- **Companions** — the Beast Master picks Beast of the Land / Sea / Sky. The
  chosen stat block prints on the sheet.
- **Summons** — spells like *Summon Elemental* link straight to the stat block
  they conjure (Elemental Spirit), including the ones whose AC and HP scale with
  spell level.

The extractor pulls creatures **on demand**: whatever the extracted spells and
class features actually reference, plus the Wild Shape beast pool. The rest of
the 18 MB bestiary is left behind, since this is a player tool, not a DM one.

### Rolling dice

Any dice expression is clickable and rolls in a small popover next to it, rather
than a modal — rolling happens mid-sentence while reading a spell, not as a task
you break off to do. That covers spell damage, weapon damage, healing, hit dice
and stat block attacks, plus the sheet's own numbers: skills, saves and
initiative are `1d20 + modifier` and roll from the sheet.

The popover shows each individual die (natural maximums in green, 1s in red),
the modifier, and the total. Buttons adapt to what was clicked:

- **d20 rolls** offer **Adv** and **Dis**, which roll twice and report both dice
  and which was kept ("rolled 5 and 9, kept 9")
- **Damage rolls** offer **Crit**, which doubles the dice and not the modifier

Expressions it only partly understands ("1d6 per level") still roll the dice they
found and say so, rather than guessing at the rest.

### Attack range and reach

The attacks table has a **Range** column, because it is a number you look up
constantly. Three cases, and a weapon can be two at once:

| Weapon | Shows | Why |
|---|---|---|
| Longsword | `5 ft` | Plain melee reach |
| Glaive | `10 ft` | Has the Reach property |
| Longbow | `150/600 ft` | Normal range, then long range at Disadvantage |
| Javelin | `5 ft · 30/120 thrown` | Both: melee reach **and** a throw range |

Hovering gives the long form — *"Reach 5 ft in melee, or thrown 30 ft (up to 120
ft with Disadvantage)"* — since the second number means Disadvantage rather than
simply "further". The same label appears in **Worn & held** next to the damage,
which is where you are standing when you decide whether to throw the thing.

### Clickable weapon properties

Every property and mastery in the attacks table is a chip that opens its rules
text: Finesse, Thrown, Light, Versatile, and the 2024 masteries (Nick, Graze,
Vex…). Masteries are outlined in yellow to distinguish them from properties, and
the wording matches the character's edition — a 2014 character gets the 2014
Finesse text, a 2024 one gets the rewrite.

### The "?" icon

Anywhere a choice needs explaining, it gets a small circular **?** beside it
rather than a sentence-shaped link elsewhere on the page. One affordance, used
for fighting styles, invocations, metamagic, skills, tool choices, spells, Wild
Shape forms and the picks recorded on the sheet.

It comes from `infoButton()` in `ui.js`, so adding it to a new picker is one
argument: pass `onInfo` to `choiceList` and every row gets one.

### Clickable equipment and proficiencies

Items behave exactly like spells: every equipment name, attack name and loadout
entry opens its card — cost, weight, damage, properties, attunement. Tools work
too, since they are items.

Proficiencies are clickable where the data supports it. Tools and languages have
their own entries, so each one opens. Armour and weapon *categories* ("light",
"martial") have no entry of their own, so the row label links to the rule that
governs them — *Armor Training* and *Weapon* — rather than pretending each word
is a lookup that will fail.

### Clickable rules references

Every highlighted term in rules text opens its own entry: skills, conditions,
spells, feats, items, weapon masteries, and the whole 2024 rules glossary
(Advantage, Bonus Action, Long Rest and the rest). This works everywhere,
including inside a window that a reference already opened, so you can follow a
chain from a background to its origin feat to the condition that feat mentions.

The extractor tags each cross-reference with its type and source
(`data-ref="skill|Insight|XPHB"`), and one delegated listener resolves it against
whichever dataset owns it, pulling that file only if the term is actually
clicked. Categories that are not part of character creation (deities, hazards,
random tables) say so plainly rather than failing silently.

### Two modes: Build and Play

The creator has two modes, because they are two different jobs.

**Build mode** is the wizard: choosing a class, species and background, picking
spells, levelling up, changing your mind. Everything is a decision.

**Play mode** is what you keep open at the table: everything already chosen, laid
out to be used, with nothing left to decide. Slots are clickable, HP is editable,
features are one tap from their rules text.

Play mode has two pages, switched with tabs:

| Page | Holds |
|---|---|
| **Character** | Abilities, saves, skills, AC, HP, attacks, equipment, features |
| **Spells** | Per-class DCs and limits, the slot tracker, granted spells, and the full list by level |

A caster gets both. **Print emits both pages**, with the spell sheet starting a
new sheet of paper — the same split a printed character sheet uses, and for the
same reason: a caster's spell list does not fit beside their armour class.

### Spells

The spellbook is built for the table, not just for creation:

- **Slots are clickable.** Each level shows a row of pips; click an open one to
  spend it, click a spent one to get it back. Short rest restores Pact Magic,
  Long rest restores everything.
- **Limits come from the class table.** The 2024 rules replaced "level + ability
  modifier" with a flat Prepared Spells number, so a Wizard 5 prepares **9**, not
  5. Cantrips known are read the same way.
- **The Wizard has a spellbook, other classes do not.** A Wizard learns spells
  into a book (six at 1st level, two more per level) and can only prepare from
  it — so a Wizard 5 has a 14-spell book and prepares 9 of them, while a Sorcerer
  5 just prepares 6 straight off the list. Removing a spell from the book
  unprepares it automatically.
- **Multiclassing shares slots but not lists.** A Cleric 3 / Wizard 2 gets one
  pool of 4/3/2 slots from an effective caster level of 5, while preparing 6
  Cleric spells against WIS and 5 Wizard spells against INT. Half- and
  third-caster levels round **up** in the 2024 rules and **down** in 2014, and a
  single-class caster reads its own table so a 2024 Paladin correctly gets slots
  at 1st level.
- **Granted spells are in the list.** Spells from a species, background, feat,
  or a domain / oath / circle appear in their own table on the spell sheet,
  grouped by spell level and using the same columns as the class lists, each row
  naming its origin with a clickable badge — **S** species, **B** background,
  **F** feat, **D** subclass. They do not count against your prepared limit.
- **Subclass spells are level-gated per class.** A Life Domain Cleric gains Aid
  and Bless at Cleric 3 and Aura of Life at Cleric 7. For a multiclassed
  character these gate on the *class* level, not the total: a Cleric 3 / Fighter 5
  gets the Cleric-3 spells, not the Cleric-5 ones.
- **Variant lists are chosen.** The 2024 Circle of the Land grants a different
  set per terrain, so the Spells step asks which, and grants nothing until you
  answer.
- **Granted spells are marked.** A High Elf's Prestidigitation shows in a "Spells
  you already have" section with a clickable **S** badge naming the lineage, and
  it does not count against your cantrips known — which stops you spending a pick
  on something you already have. Level gates are respected, so Misty Step appears
  as unlocking at 5th.
- **Every spell name opens its card**: casting time, range, components, duration,
  classes, full text, and a link to any stat block it summons.

### Feats, and everything they cascade into

An Ability Score Improvement offers **Raise scores** or **Take a feat**, and a
feat is never just text on the sheet — every mechanical consequence applies:

| Feat | What cascades |
|---|---|
| **Resilient** | +1 to the chosen ability **and** proficiency in its saving throw. A WIS save goes from +1 to +3 |
| **Magic Initiate** | Two cantrips and a 1/day spell from the chosen class list, added to the spell sheet with an **F** badge |
| **Skilled** | Three skill proficiencies, attributed to the feat in the skill sources |
| **Tough** | +2 HP per level, retroactively |
| **Fighting Initiate** | A fighting style, which then feeds the conditional attack evaluation |

The choices a feat demands are asked at the moment it is taken, and the dialog
says what is still outstanding ("Still to choose: 1 ability point, a saving
throw") rather than applying half a feat silently.

Feat mechanics are read from the source data — `ability`, `savingThrowProficiencies`,
`skillToolLanguageProficiencies` and `additionalSpells` are all structured — so
this is not a hand-maintained list of special cases.

### Not offering invalid choices

Throughout, an option that would do nothing is shown greyed with the reason
rather than hidden or silently allowed:

- A **skill** another source already granted: *"already from Vampire Survivor"*,
  with the still-open skills listed
- A **saving throw** you are already proficient in: disabled (a Fighter cannot
  take Resilient (CON))
- An **ability at 20**: disabled, *"already 20; 20 is the maximum"*
- A **non-repeatable feat** you already hold: not offered again
- A **spell your domain already grants**: struck through in the class picker,
  *"Life Domain already grants this spell"* — so a Cleric cannot waste a prepared
  slot on Bless
- A **two-handed grip** while a shield is held: struck through

Showing the reason matters more than hiding the option. A greyed row with an
explanation teaches the rule; a missing row looks like a bug.

### Conditional attack features

Fighting styles and feats that only apply *sometimes* are evaluated per weapon,
against what is actually in your hands. Dueling needs "a Melee weapon in one
hand and no other weapons", so with a Glaive and a Longsword both in hand it
does nothing; sheathe the Glaive and hold the Longsword in one hand and the +2
appears in the damage column.

Crucially the sheet reports the features that **did not** fire and why:

> Dueling needs a Melee weapon in one hand, and no other weapon in hand — this
> weapon is being held in two hands.

That line is the difference between the sheet looking broken and the sheet
teaching the rule. Currently modelled: Dueling, Archery, Great Weapon Fighting,
Two-Weapon Fighting, Thrown Weapon Fighting, Unarmed Fighting, Great Weapon
Master, Polearm Master and Sharpshooter.

Because grip decides several of these, Versatile weapons get a **1H / 2H toggle**
in the inventory, which also switches the damage die (Longsword 1d8 ↔ 1d10). The
"in hand" checkbox means exactly that — what you are holding, not what you own —
since that is what the conditions test.

Adding another one is a single entry in `dnd/creator/js/effects.js`:

```js
{
  name: "Dueling",
  kind: "damage",          // "damage" | "attack" | "note"
  value: 2,
  requires: "a Melee weapon in one hand, and no other weapon in hand",
  applies: (ctx) => ctx.isMelee && ctx.grip === "one-handed" && ctx.otherWeaponsInHand === 0,
  explain: (ctx) => "…why it did not apply…",
}
```

### Shields, grip and the feature timeline

A shield gets its own toggle on the sheet rather than being buried in the
inventory, because it changes two things at once: **+2 AC**, and because it fills
the off hand it forces a Versatile weapon down to its one-handed die. A Longsword
with a shield out is 1d8, not 1d10, and the two-handed option is struck through
while the shield is held. Holding a shield with a Two-Handed weapon is flagged as
illegal in the attacks table.

Features are listed **in the order you acquired them**, grouped by level, because
that is how a sheet gets read at the table. A feature that granted a choice folds
the pick into itself:

> **Fighting Style: Dueling** — Paladin 2
> · *What is Dueling?* → the feat's rules
> · *About Paladin 2* → the Fighting Style feature
> · *Change Fighting Style* → back to the step that sets it

Anything still unchosen is outlined and says how many picks are outstanding.

### House rules

Restrictions the books impose can be relaxed per character. The toggle sits
next to the restriction it lifts, not buried in a settings page:

| House rule | Effect |
|---|---|
| Free ability assignment | Put the background's +2/+1 on any ability, not just its three |
| Allow duplicate skills | Stop greying out skills another source already granted |
| Ignore feat prerequisites | Show every feat regardless of requirements |
| Unrestricted Wild Shape | Show every Beast, ignoring the CR and movement limits |

Skills are tracked **by source** rather than as one flat list, which is what lets
the app say "Insight is already granted by Vampire Survivor, so this pick is
wasted" and suggest what is still open. It also means changing your background
no longer silently discards the skills your class chose.

### Worn & held: changing your loadout mid-session

Play mode has a **Worn & held** panel, because donning armour, raising a shield,
drawing a weapon and switching grip are things you do during a fight, not during
character creation. Each is a single button showing its current state:

| Control | States | Effect |
|---|---|---|
| Armour | worn / off | Sets AC. Donning one suit doffs the others |
| Shield | held / stowed | +2 AC, and occupies your off hand |
| Weapons | drawn / stowed | Only drawn weapons appear in the attacks table |
| Grip | 1H / 2H | Changes the damage die and which styles apply |

Everything re-derives at once, and the cascade is the point. Starting from
nothing on a Paladin with Dueling:

1. **Don Chain Mail** — AC 10 → 16
2. **Draw the Longsword** — defaults to two hands, so Dueling reports *"this
   weapon is being held in two hands"*
3. **Raise the Shield** — AC 16 → **18**, the 2H grip is struck through and
   blocked, the die drops to 1d8, and **Dueling activates**

The panel closes with a plain-language summary of what the current loadout turns
on and what it is holding back, read from the same evaluation the attacks table
uses so the two can never disagree.

### Editing from the sheet

Each block on the character sheet has an **edit** link, and every feature has a
**Change this** link that jumps to the wizard step where it was chosen — and
**scrolls to the exact control**, flashing it so the eye lands on it.

"Change Fighting Style" opens the Class step at the fighting styles, not at the
top of a long page. The anchor is declared per feature rather than guessed from
its name, which matters for the indirect cases: changing **Oath of Devotion**
means changing your subclass, so it aims at the *Paladin Subclass* picker, and
changing **Wood Elf** aims at the *Elven Lineage* picker on the Species step.

Automatic features with nothing to choose (Lay on Hands) simply open their step,
since there is no control to land on.

### Magic items

The magic item search covers **both editions** on purpose, since most tables mix
2014 DMG items with 2024 ones. Attunement is tracked, capped at three.

One wrinkle worth knowing: "+1 Longsword" and "Flame Tongue Greatsword" are not
items in 5etools. They are *variant templates* combined with matching base items
at build time, which is why the extractor generates roughly 6,000 entries from
214 templates. Each template's rules text is stored once in `magic-variants.json`
and referenced, rather than copied into every combination.

### Adding your own content

Custom classes, subclasses, species, backgrounds, feats, spells, magic items and
equipment go in as JSON. Two routes:

| Route | Scope | How |
|---|---|---|
| `dnd/creator/homebrew/*.json` | Everyone on the LAN server | Drop the file in, list it in `homebrew/index.json` |
| **Homebrew** button in the app | One device | Import a JSON file |

Both use the same format. See `dnd/creator/homebrew/README.md` for the full
shape, or click **Homebrew → Download template** in the app for a working file.

A subclass attaches to an existing class by id:

```json
{
  "name": "My Homebrew",
  "subclasses": [
    { "name": "Order of the Kestrel", "classId": "fighter--xphb",
      "levels": [{ "level": 3, "features": [{ "name": "Kestrel's Eye", "html": "<p>…</p>" }] }] }
  ]
}
```

Homebrew entries are badged by source in the pickers, and
`tools/extract-5etools.mjs` never touches them — it only writes to `data/`.

### Adding a rule the creator does not calculate

5etools stores rules *text*, not rules *logic* — Dwarven Toughness is a
paragraph, not a `+1 HP per level` field. Effects that change a derived number
are declared by name in `dnd/creator/js/effects.js`:

```js
{ name: "Dwarven Toughness", effects: [{ type: "hpPerLevel", value: 1 }] },
```

Anything not listed still appears in full as feature text on the sheet; it just
is not auto-totalled. Every derived number (HP, AC) also has a manual override,
which is the escape hatch for homebrew.
