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
python -m http.server 8000 --bind 0.0.0.0
```

Then on any device on the same network, open `http://<your-ip>:8000/dnd/character-creator.html`.
Find your IP with `ipconfig` on Windows or `ip addr` on Linux.

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

### Editing from the sheet

Each block on the character sheet has an **edit** link, and every feature has a
**Change this** link that jumps to the wizard step where it was chosen. Feats
granted by a background, picked for a species trait, or taken at level-up each
link back to their own step.

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
