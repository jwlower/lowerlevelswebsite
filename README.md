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
│   └── character-creator.html  WIP character sheet tool
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
└── scripts/
    └── posts.js                Shared post-feed loader used by all pages
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
