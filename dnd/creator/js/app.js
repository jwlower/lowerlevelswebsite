/**
 * app.js - bootstrap, routing and the screens that are not wizard steps:
 * the character roster, the wizard shell, and the level-up flow.
 */

import { loadCore, db, getClass, getSubclass, filterEntries, ensure, addLocalHomebrew, localHomebrew, removeLocalHomebrew } from "./data.js";
import * as state from "./state.js";
import { el, mount, section, field, modal, notice, toast, card, choiceList } from "./ui.js";
import { relevantSteps, STEPS } from "./wizard.js";
import { renderSheet } from "./sheet.js";
import { installGlossary } from "./glossary.js";
import * as rules from "./rules.js";

const root = document.getElementById("creator-root");

let session = null;
let currentStepIndex = 0;

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

(async function boot() {
	mount(root, el("div.loading", {}, [
		el("div.loading__spinner"),
		el("p", { text: "Loading the rules database…" }),
	]));

	try {
		await loadCore();
	} catch (err) {
		mount(root, el("div.fatal", {}, [
			el("h2", { text: "Could not load the rules database" }),
			el("p", { text: err.message }),
			el("p.muted", {
				text: "The creator reads JSON from dnd/creator/data/. Generate it with tools/extract-5etools.mjs, and make sure you are opening this page over http:// rather than file:// — browsers block fetch on file URLs.",
			}),
		]));
		return;
	}

	// Highlighted terms in rules text become clickable everywhere, including
	// inside modals, from this one listener.
	installGlossary();

	showRoster();
})();

/* ------------------------------------------------------------------ *
 * Roster
 * ------------------------------------------------------------------ */

function showRoster() {
	session = null;
	const characters = state.listCharacters();
	const meta = db.meta ?? {};

	mount(root, el("div.screen.screen--roster", {}, [
		el("div.roster__head", {}, [
			el("div", {}, [
				el("h2.screen__title", { text: "Characters" }),
				el("p.screen__hint", {
					text: characters.length
						? `${characters.length} saved on this device.`
						: "Nothing saved yet on this device.",
				}),
			]),
			el("div.btn-row", {}, [
				el("button.btn.btn--primary", {
					type: "button", text: "New character", onclick: startNewCharacter,
				}),
				el("button.btn", { type: "button", text: "Import", onclick: importFlow }),
				characters.length > 0 && el("button.btn", {
					type: "button", text: "Export all", onclick: () => state.exportRoster(),
				}),
				el("button.btn", { type: "button", text: "Homebrew", onclick: homebrewFlow }),
			].filter(Boolean)),
		]),

		characters.length
			? el("div.roster__grid", {}, characters.map(rosterCard))
			: el("div.empty-state", {}, [
				el("p", { text: "Create your first character to get started." }),
				el("p.muted", {
					text: "Characters are saved in this browser. Use Export to move one to another device or hand it to your DM.",
				}),
			]),

		el("footer.roster__footer", {}, [
			el("p.muted", {
				text: `Rules database: ${meta.tier === "srd" ? "SRD only" : "full local build"} · `
					+ `${meta.counts?.["classes.json"] ?? 0} classes, ${meta.counts?.["species.json"] ?? 0} species, `
					+ `${meta.counts?.["spells.json"] ?? 0} spells`,
			}),
		]),
	]));
}

function rosterCard(char) {
	const cls = getClass(char.classes?.[0]?.classId);
	const level = rules.totalLevel(char);

	return el("article.roster-card", {}, [
		el("button.roster-card__main", {
			type: "button",
			onclick: () => openCharacter(char.id, "sheet"),
		}, [
			el("h3.roster-card__name", { text: char.name || "Unnamed character" }),
			el("p.roster-card__meta", {
				text: [cls?.name, `Level ${level}`, char.edition].filter(Boolean).join(" · "),
			}),
			el("p.roster-card__date", {
				text: `Updated ${new Date(char.updatedAt).toLocaleDateString()}`,
			}),
		]),
		el("div.roster-card__actions", {}, [
			el("button.icon-btn", {
				type: "button", text: "Edit", title: "Edit",
				onclick: () => openCharacter(char.id, "wizard"),
			}),
			el("button.icon-btn", {
				type: "button", text: "Copy", title: "Duplicate",
				onclick: () => { state.duplicateCharacter(char.id); showRoster(); },
			}),
			el("button.icon-btn", {
				type: "button", text: "Save", title: "Export JSON",
				onclick: () => state.exportCharacter(char),
			}),
			el("button.icon-btn.icon-btn--danger", {
				type: "button", text: "Delete", title: "Delete",
				onclick: () => confirmDelete(char),
			}),
		]),
	]);
}

function confirmDelete(char) {
	const close = modal("Delete character?", el("div", {}, [
		el("p", { text: `"${char.name || "Unnamed character"}" will be removed from this device. This cannot be undone.` }),
		el("div.btn-row", {}, [
			el("button.btn.btn--danger", {
				type: "button", text: "Delete",
				onclick: () => { state.deleteCharacter(char.id); close(); showRoster(); },
			}),
			el("button.btn", { type: "button", text: "Cancel", onclick: () => close() }),
		]),
	]));
}

function importFlow() {
	const input = el("input", {
		type: "file", accept: ".json,application/json",
		onchange: async (e) => {
			const file = e.target.files?.[0];
			if (!file) return;
			try {
				const added = state.importCharacters(JSON.parse(await file.text()));
				toast(`Imported ${added.length} character${added.length === 1 ? "" : "s"}`);
				showRoster();
			} catch (err) {
				modal("Import failed", el("p", { text: err.message }));
			}
		},
	});
	input.click();
}

/* ------------------------------------------------------------------ *
 * Homebrew
 *
 * Custom content can arrive two ways: dropped into dnd/creator/homebrew/ on the
 * server (shared by everyone on the LAN), or imported here on one device. This
 * dialog manages the second kind and reports what the first kind loaded.
 * ------------------------------------------------------------------ */

function homebrewFlow() {
	const body = el("div");

	const render = () => {
		const local = localHomebrew();
		const fileLoaded = (db.homebrewSources ?? []).filter(
			(n) => !local.some((b) => (b.name ?? "") === n),
		);

		mount(body, el("div", {}, [
			el("p.muted", {
				text: "Add your own classes, subclasses, species, backgrounds, feats, spells, "
					+ "magic items or equipment. Imported files are merged into the pickers and "
					+ "badged as homebrew.",
			}),

			fileLoaded.length > 0 && el("div", {}, [
				el("h5", { text: "Loaded from the server" }),
				el("div.homebrew-list", {}, fileLoaded.map((n) =>
					el("div.homebrew-row", {}, [
						el("span", { text: n }),
						el("span.muted", { text: "from homebrew/" }),
					]),
				)),
			]),

			el("h5", { text: "On this device" }),
			local.length
				? el("div.homebrew-list", {}, local.map((b) =>
					el("div.homebrew-row", {}, [
						el("span", { text: b.name ?? "Unnamed" }),
						el("button.icon-btn.icon-btn--danger", {
							type: "button", text: "Remove",
							onclick: () => {
								removeLocalHomebrew(b.name);
								toast("Removed. Reload to apply.");
								render();
							},
						}),
					]),
				))
				: el("p.muted", { text: "Nothing imported on this device yet." }),

			el("div.btn-row", {}, [
				el("button.btn.btn--primary", {
					type: "button", text: "Import homebrew JSON", onclick: importHomebrewFile,
				}),
				el("button.btn", {
					type: "button", text: "Download template", onclick: downloadHomebrewTemplate,
				}),
			]),
		]));
	};

	render();
	modal("Homebrew", body);
}

function importHomebrewFile() {
	const input = el("input", {
		type: "file", accept: ".json,application/json",
		onchange: async (e) => {
			const file = e.target.files?.[0];
			if (!file) return;
			try {
				const bundle = JSON.parse(await file.text());
				if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
					throw new Error("Expected a JSON object with a name and content arrays.");
				}
				bundle.name = bundle.name ?? file.name.replace(/\.json$/i, "");
				const summary = addLocalHomebrew(bundle);
				const parts = Object.entries(summary).map(([k, n]) => `${n} ${k}`);
				toast(parts.length ? `Imported ${parts.join(", ")}` : "Imported (nothing recognised)");
				showRoster();
			} catch (err) {
				modal("Import failed", el("div", {}, [
					el("p", { text: err.message }),
					el("p.muted", { text: "Use Download template to see the expected shape." }),
				]));
			}
		},
	});
	input.click();
}

/** A minimal, valid homebrew file showing each supported collection. */
function downloadHomebrewTemplate() {
	const template = {
		name: "My Homebrew",
		spells: [{
			name: "Example Spell",
			level: 1,
			school: "Evocation",
			classes: ["wizard"],
			blurb: "One line shown on the picker card.",
			html: "<p>Full rules text. Basic HTML is fine.</p>",
		}],
		subclasses: [{
			name: "Example Subclass",
			classId: "wizard--xphb",
			blurb: "Shown on the subclass card.",
			levels: [{
				level: 3,
				features: [{ name: "Example Feature", level: 3, html: "<p>What it does.</p>" }],
			}],
		}],
		magicItems: [{
			name: "Example Wondrous Item",
			rarity: "rare",
			reqAttune: true,
			html: "<p>What it does.</p>",
		}],
		feats: [{
			name: "Example Feat",
			category: "general",
			html: "<p>What it does.</p>",
		}],
	};

	const blob = new Blob([JSON.stringify(template, null, 2)], { type: "application/json" });
	const url = URL.createObjectURL(blob);
	const a = el("a", { href: url, download: "homebrew-template.json" });
	document.body.append(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(url);
}

/* ------------------------------------------------------------------ *
 * Opening a character
 * ------------------------------------------------------------------ */

function startNewCharacter() {
	const settings = state.getSettings();
	const char = state.newCharacter({ edition: settings.edition });
	state.saveCharacter(char);
	openCharacter(char.id, "wizard");
}

function openCharacter(id, view) {
	const char = state.getCharacter(id);
	if (!char) { showRoster(); return; }
	session = state.createSession(char);
	currentStepIndex = 0;
	if (view === "sheet") showSheet();
	else showWizard();
}

/* ------------------------------------------------------------------ *
 * Wizard shell
 * ------------------------------------------------------------------ */

function showWizard() {
	const char = session.character;
	const steps = relevantSteps(char);
	currentStepIndex = Math.min(currentStepIndex, steps.length - 1);
	const step = steps[currentStepIndex];

	const ctx = {
		session,
		rerender: () => showWizard(),
		onNameChange: () => {
			const title = root.querySelector(".wizard__charname");
			if (title) title.textContent = session.character.name || "Unnamed character";
		},
	};

	const body = el("div.wizard__body", {}, step.render(ctx));

	mount(root, el("div.screen.screen--wizard", {}, [
		el("header.wizard__head", {}, [
			el("button.link-btn", {
				type: "button", text: "← All characters",
				onclick: () => { session.saveNow(); showRoster(); },
			}),
			el("h2.wizard__charname", { text: char.name || "Unnamed character" }),
			el("div.btn-row", {}, [
				el("button.btn", {
					type: "button", text: "View sheet",
					onclick: () => { session.saveNow(); showSheet(); },
				}),
			]),
		]),

		stepNav(steps, ctx),

		el("div.wizard__main", {}, [
			el("div.wizard__heading", {}, [
				el("h3", { text: step.title }),
				step.blurb && el("p.muted", { text: step.blurb }),
			]),
			body,
		]),

		el("footer.wizard__footer", {}, [
			el("button.btn", {
				type: "button", text: "Back", disabled: currentStepIndex === 0,
				onclick: () => { currentStepIndex--; showWizard(); },
			}),
			el("span.wizard__progress", {
				text: `Step ${currentStepIndex + 1} of ${steps.length}`,
			}),
			currentStepIndex < steps.length - 1
				? el("button.btn.btn--primary", {
					type: "button", text: "Next",
					onclick: () => { currentStepIndex++; showWizard(); },
				})
				: el("button.btn.btn--primary", {
					type: "button", text: "Finish",
					onclick: () => { session.saveNow(); showSheet(); },
				}),
		]),
	]));

	root.querySelector(".wizard__main")?.scrollTo({ top: 0 });
}

function stepNav(steps, ctx) {
	const char = session.character;
	return el("nav.step-nav", {}, steps.map((s, i) => {
		const done = s.isComplete ? s.isComplete(char) : true;
		return el("button.step-nav__item", {
			type: "button",
			class: [
				i === currentStepIndex ? "is-current" : "",
				done ? "is-done" : "",
			].filter(Boolean).join(" "),
			onclick: () => { currentStepIndex = i; showWizard(); },
		}, [
			el("span.step-nav__index", { text: done ? "✓" : String(i + 1) }),
			el("span.step-nav__label", { text: s.title }),
		]);
	}));
}

/* ------------------------------------------------------------------ *
 * Sheet view
 * ------------------------------------------------------------------ */

async function showSheet() {
	const char = session.character;

	// The sheet shows spell names and companion stat blocks, both of which live
	// in lazily-loaded files. Pull them first so nothing renders as a raw id.
	const needed = [];
	if (char.spells?.prepared?.length || char.spells?.cantrips?.length) needed.push(ensure("spells"));
	if (char.wildShapeForms?.length || Object.keys(char.companions ?? {}).length) needed.push(ensure("creatures"));
	if (needed.length) {
		mount(root, el("div.loading", {}, [el("div.loading__spinner"), el("p", { text: "Loading…" })]));
		await Promise.all(needed);
	}

	mount(root, el("div.screen.screen--sheet", {}, [
		el("header.sheet__nav.no-print", {}, [
			el("button.link-btn", {
				type: "button", text: "← All characters",
				onclick: () => { session.saveNow(); showRoster(); },
			}),
		]),
		renderSheet(session, {
			onEdit: () => showWizard(),
			onLevelUp: () => levelUpFlow(),
			onEditStep: (stepId) => openStep(stepId),
		}),
	]));
}

/**
 * Open the wizard at a named step. Used by the "Change this" links on the sheet
 * so a trait can be revisited without hunting through the step bar. If the step
 * does not apply to this character (no spells on a Fighter), fall back to the
 * first step rather than landing on nothing.
 */
function openStep(stepId) {
	const steps = relevantSteps(session.character);
	const index = steps.findIndex((s) => s.id === stepId);
	currentStepIndex = index === -1 ? 0 : index;
	showWizard();
}

/* ------------------------------------------------------------------ *
 * Level up
 *
 * Advances the primary class by one level and walks the decisions that the new
 * level actually creates: hit points, a subclass if this is the level for it,
 * and an ability score improvement or feat where the class grants one.
 * ------------------------------------------------------------------ */

function levelUpFlow() {
	const char = session.character;
	const entry = char.classes?.[0];
	const cls = getClass(entry?.classId);
	if (!cls) { toast("Pick a class first."); return; }

	const from = entry.levels ?? 1;
	const to = from + 1;
	if (to > 20) { toast("Already at level 20."); return; }

	// What the new level brings.
	const newFeatures = (cls.levels ?? [])
		.filter((l) => l.level === to)
		.flatMap((l) => l.features ?? []);
	const needsSubclass = to >= (cls.subclassLevel ?? 3) && !entry.subclassId && cls.subclasses?.length;
	const grantsAsi = newFeatures.some((f) => /ability score improvement/i.test(f.name));

	// Working copy of the decisions, applied only on confirm.
	const draft = {
		hpMode: "average",
		hpRoll: null,
		subclassId: entry.subclassId,
		asi: { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 },
	};

	const die = cls.hitDie ?? 8;
	const conMod = rules.abilityMods(char).con ?? 0;
	const avg = rules.averageHpPerLevel(die);

	const bodyHost = el("div");

	const renderBody = () => {
		const gained = draft.hpMode === "roll"
			? (draft.hpRoll ?? avg)
			: draft.hpMode === "max" ? die : avg;

		mount(bodyHost, el("div", {}, [
			el("p.levelup__summary", {
				text: `${cls.name} ${from} → ${to}. Proficiency bonus ${rules.formatMod(
					db.rules?.proficiencyBonusByLevel?.[to - 1] ?? 2,
				)}.`,
			}),

			// Hit points
			section("Hit points", `d${die} + CON ${rules.formatMod(conMod)}`,
				el("div", {}, [
					el("div.btn-row", {}, [
						...[
							["average", `Average (${avg})`],
							["roll", "Roll it"],
							["max", `Max (${die})`],
						].map(([mode, label]) =>
							el("button.toggle-btn", {
								type: "button",
								class: draft.hpMode === mode ? "is-active" : "",
								text: label,
								onclick: () => {
									draft.hpMode = mode;
									if (mode === "roll") draft.hpRoll = 1 + Math.floor(Math.random() * die);
									renderBody();
								},
							}),
						),
					]),
					draft.hpMode === "roll" && el("p.levelup__roll", {
						text: `Rolled ${draft.hpRoll} on a d${die}.`,
					}),
					el("p.levelup__gain", {
						text: `Gaining ${Math.max(1, gained + conMod)} hit points.`,
					}),
				]),
			),

			// New features
			newFeatures.length > 0 && section("New features", null,
				el("ul.item-list", {}, newFeatures.map((f) =>
					el("li.item-list__row", {}, [
						el("span", { text: f.name }),
						el("button.link-btn", {
							type: "button", text: "read",
							onclick: () => modal(f.name, el("div", { html: f.html })),
						}),
					]),
				)),
			),

			// Subclass
			needsSubclass && section(cls.subclassTitle ?? "Subclass", "Choose one now.",
				el("div.pick-grid.pick-grid--compact", {}, (cls.subclasses ?? []).map((sub) =>
					card({
						title: sub.name,
						blurb: sub.blurb,
						selected: draft.subclassId === sub.id,
						onSelect: () => { draft.subclassId = sub.id; renderBody(); },
					}),
				)),
			),

			// Ability score improvement
			grantsAsi && section("Ability Score Improvement",
				"Raise one ability by 2, or two abilities by 1 each. Taking a feat instead is on the Class step.",
				el("div.assign-grid", {}, (db.rules?.abilities ?? []).map((a) =>
					field(a.name,
						el("input.assign-input", {
							type: "number", min: 0, max: 2, value: draft.asi[a.id],
							oninput: (e) => { draft.asi[a.id] = Number(e.target.value) || 0; renderBody(); },
						}),
					),
				)),
			),

			grantsAsi && el("p.muted", {
				text: `Allocated ${Object.values(draft.asi).reduce((x, y) => x + y, 0)} of 2 points.`,
			}),
		].filter(Boolean)));
	};

	renderBody();

	const close = modal(`Level up to ${to}`, el("div", {}, [
		bodyHost,
		el("div.btn-row.levelup__actions", {}, [
			el("button.btn.btn--primary", {
				type: "button", text: `Confirm level ${to}`,
				onclick: () => {
					const asiTotal = Object.values(draft.asi).reduce((x, y) => x + y, 0);
					if (grantsAsi && asiTotal > 2) { toast("An ASI grants only 2 points."); return; }
					if (needsSubclass && !draft.subclassId) { toast("Choose a subclass first."); return; }

					const rolled = draft.hpMode === "roll" ? draft.hpRoll
						: draft.hpMode === "max" ? die : null;

					session.update((c) => {
						const nextClasses = [...c.classes];
						const e0 = { ...nextClasses[0] };
						const rolls = [...(e0.hitDiceRolled ?? [])];
						// Index within this class's levels; level 1 never rolls.
						rolls[to - 1] = rolled;
						e0.levels = to;
						e0.hitDiceRolled = rolls;
						if (draft.subclassId) e0.subclassId = draft.subclassId;
						nextClasses[0] = e0;

						const asiNext = { ...c.asiBonuses };
						for (const [k, v] of Object.entries(draft.asi)) asiNext[k] = (asiNext[k] ?? 0) + v;

						return { ...c, classes: nextClasses, asiBonuses: asiNext };
					});

					session.saveNow();
					close();
					toast(`Now level ${to}`);
					showSheet();
				},
			}),
			el("button.btn", { type: "button", text: "Cancel", onclick: () => close() }),
		]),
	]));
}
