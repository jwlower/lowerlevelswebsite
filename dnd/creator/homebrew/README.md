# Homebrew

Drop your own content here and list the filename in `index.json`. Everything in
this folder loads for **everyone** using the LAN server, unlike homebrew
imported through the app's Homebrew button, which stays on one device.

```json
{ "files": ["my-subclasses.json", "party-magic-items.json"] }
```

## File shape

One JSON object. Every collection is optional — include only what you need.

```json
{
  "name": "My Homebrew",

  "spells": [
    {
      "name": "Kestrel's Rebuke",
      "level": 2,
      "school": "Evocation",
      "classes": ["wizard", "sorcerer"],
      "blurb": "One line shown on the picker card.",
      "html": "<p>Full rules text. Basic HTML is fine.</p>"
    }
  ],

  "subclasses": [
    {
      "name": "Order of the Kestrel",
      "classId": "fighter--xphb",
      "blurb": "Shown on the subclass card.",
      "levels": [
        {
          "level": 3,
          "features": [
            { "name": "Kestrel's Eye", "level": 3, "html": "<p>What it does.</p>" }
          ]
        }
      ]
    }
  ],

  "classes":     [],
  "species":     [],
  "backgrounds": [],
  "feats":       [],
  "magicItems":  [],
  "equipment":   [],
  "creatures":   []
}
```

## Notes

- **`classId` on a subclass** must match an existing class id, e.g. `fighter--xphb`
  or `wizard--phb`. The suffix is the source book: `xphb` for 2024, `phb` for 2014.
- **Ids** are generated from the name if you leave `id` out. Set one explicitly if
  you want to update an entry later without creating a duplicate.
- **`edition`** defaults to `"2024"`. Set `"2014"` to have it appear for 2014 characters.
- **`html`** is inserted as-is, so keep it to simple tags (`<p>`, `<ul>`, `<strong>`,
  `<em>`, `<table>`). Only load homebrew you trust — it is code running on your page.
- Entries are badged as homebrew in the UI and never overwritten by
  `tools/extract-5etools.mjs`, which only writes to `../data/`.

To see a working file, use **Homebrew → Download template** in the app.

## Making a number actually calculate

Adding a feature here puts its text on the sheet, but does not change any
derived number. If your homebrew grants something like "+1 HP per level", add a
matching rule to `../js/effects.js`:

```js
{ name: "Kestrel's Eye", effects: [{ type: "acBonus", value: 1 }] },
```

Supported effect types are listed at the top of that file.
