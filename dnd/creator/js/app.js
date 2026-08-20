/**
 * app.js - bootstrap, routing and the screens that are not wizard steps:
 * the character roster, the wizard shell, and the level-up flow.
 */

import { loadCore, db, getClass, getSubclass, filterEntries, ensure, addLocalHomebrew, localHomebrew, removeLocalHomebrew, setCustomItems } from "./data.js";
import * as state from "./state.js";
import { el, mount, section, field, modal, notice, toast, card, choiceList } from "./ui.js";
import { relevantSteps, STEPS } from "./wizard.js";
import { renderSheet } from "./sheet.js";
import { renderSpellSheet } from "./spellsheet.js";
import { installGlossary } from "./glossary.js";
import { installDiceRoller } from "./dice.js";
import { asiFeatOptions, featOptionsEditor, pendingSummary } from "./feats.js";
import * as rules from "./rules.js";

const root = document.getElementById("creator-root");

let session = null;
let currentStepIndex = 0;
// Which step was on screen last time the wizard drew, and where it was scrolled
// to. Every pick re-renders the whole step, so without this the view jumps back
// to the top on each click.
let lastRenderedStepId = null;
// Which page of Play mode is open: the character sheet or the spell sheet.
let playView = "character";
// A section to scroll to and flash once the next wizard render lands. Set when
// arriving from a "Change this" link, so the player is put in front of the exact
// control they came to change rather than at the top of a long step.
let pendingAnchor = null;

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
	// Same for dice expressions: click "8d6" anywhere and it rolls.
	installDiceRoller();

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
			onclick: () => openCharacter(char.id, "play"),
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
				type: "button", text: "Build", title: "Set up or level up",
				onclick: () => openCharacter(char.id, "build"),
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
	// A brand-new character has nothing to play yet, so start in Build mode.
	openCharacter(char.id, "build");
}

function openCharacter(id, mode) {
	const char = state.getCharacter(id);
	if (!char) { showRoster(); return; }
	session = state.createSession(char);
	// Custom items are resolved by getItem, so the registry has to be filled
	// before anything derives from the character, and refreshed whenever the
	// list changes.
	setCustomItems(char.customItems ?? []);
	session.subscribe((c) => setCustomItems(c.customItems ?? []));
	currentStepIndex = 0;
	lastRenderedStepId = null;
	playView = "character";
	if (mode === "build") showWizard();
	else showPlay();
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

	// Preserve the reading position and which sections were expanded. The whole
	// step is rebuilt on every selection, so these have to be carried over by
	// hand or the page snaps to the top and collapses everything.
	const previousMain = root.querySelector(".wizard__main");
	const previousScroll = previousMain ? previousMain.scrollTop : 0;
	const wasSameStep = lastRenderedStepId === step.id;
	const disclosureState = captureDisclosures(root);

	const body = el("div.wizard__body", {}, step.render(ctx));

	mount(root, el("div.screen.screen--wizard", {}, [
		el("header.wizard__head", {}, [
			el("button.link-btn", {
				type: "button", text: "← All characters",
				onclick: () => { session.saveNow(); showRoster(); },
			}),
			el("h2.wizard__charname", { text: char.name || "Unnamed character" }),
			el("div.mode-switch", {}, [
				el("button.mode-switch__btn.is-active", {
					type: "button", text: "Build",
					title: "Make choices and level up",
				}),
				el("button.mode-switch__btn", {
					type: "button", text: "Play",
					title: "Use the character at the table",
					onclick: () => { session.saveNow(); showPlay(); },
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
					type: "button", text: "Done — play",
					onclick: () => { session.saveNow(); showPlay(); },
				}),
		]),
	]));

	restoreDisclosures(root, disclosureState);

	// Same step means the player just made a pick: keep them where they were.
	// A different step is a deliberate move, so start at the top.
	const main = root.querySelector(".wizard__main");
	if (main) restoreScroll(main, wasSameStep ? previousScroll : 0);
	lastRenderedStepId = step.id;

	// An anchor overrides the restored position: it is why the player is here.
	if (pendingAnchor && main) {
		scrollToSection(main, pendingAnchor);
		pendingAnchor = null;
	}
}

/**
 * Puts the scroll position back after a re-render.
 *
 * Setting scrollTop is not enough on its own: a step whose data is still loading
 * mounts almost empty, and the browser clamps the value to what currently fits.
 * So the target is re-applied for a few frames while late content arrives, and
 * abandoned as soon as it sticks or the frames run out.
 */
function restoreScroll(main, target) {
	main.scrollTop = target;
	if (!target) return;

	// setTimeout rather than requestAnimationFrame: rAF does not fire in a window
	// that is not compositing, which would silently disable the retries.
	let attempts = 0;
	const settle = () => {
		if (attempts++ > 20) return;
		// Reached it, or the content genuinely is not that tall: stop.
		if (main.scrollTop >= target) return;
		if (main.scrollHeight - main.clientHeight >= target) main.scrollTop = target;
		setTimeout(settle, 25);
	};
	setTimeout(settle, 0);
}

/**
 * Scrolls a named section into view and flashes it.
 *
 * Sections are matched on their heading text, which keeps the deep-link contract
 * to one string and means any step gains the behaviour for free -- no ids to
 * thread through every picker. Steps whose content loads late are retried for a
 * few frames, the same problem the scroll restore has.
 *
 * A near-miss match is accepted ("Fighting Style" finding "Fighting Style feat")
 * because headings carry the class name in some steps.
 */
function scrollToSection(main, title) {
	const wanted = String(title).toLowerCase();

	const find = () => [...main.querySelectorAll(".step-section")].find((node) => {
		const heading = node.querySelector(".step-section__title")?.textContent?.toLowerCase();
		if (!heading) return false;
		return heading === wanted || heading.includes(wanted) || wanted.includes(heading);
	});

	// The first attempt runs synchronously. Deferring everything to
	// requestAnimationFrame means nothing happens at all in a window that is not
	// compositing frames (a background tab, a hidden pane), and retries use
	// setTimeout for the same reason.
	let attempts = 0;
	const attempt = () => {
		const target = find();
		if (target) {
			// Measured with rects rather than offsetTop: the section's offsetParent
			// is not necessarily the scroll container, so offset arithmetic can be
			// off by whatever positioned wrapper sits between them.
			// scrollIntoView is avoided because it would move the window too.
			const targetTop = target.getBoundingClientRect().top;
			const mainTop = main.getBoundingClientRect().top;
			main.scrollTop = Math.max(0, main.scrollTop + targetTop - mainTop - 12);
			target.classList.add("is-flash");
			setTimeout(() => target.classList.remove("is-flash"), 1800);
			return;
		}
		// Content that loads late gets a few more chances.
		if (attempts++ < 20) setTimeout(attempt, 25);
	};
	attempt();
}

/**
 * Records which <details> sections are open, keyed by their summary text.
 *
 * Spell lists and skill groups are disclosure widgets, and a re-render replaces
 * the elements outright -- so an expanded "Level 3" section would silently
 * collapse every time the player ticked a spell.
 */
function captureDisclosures(root) {
	const state = new Map();
	for (const details of root.querySelectorAll("details")) {
		const key = details.querySelector("summary")?.textContent?.trim();
		if (key) state.set(key, details.open);
	}
	return state;
}

/** Re-applies a captured disclosure state after the DOM has been rebuilt. */
function restoreDisclosures(root, state) {
	if (!state?.size) return;
	for (const details of root.querySelectorAll("details")) {
		const key = details.querySelector("summary")?.textContent?.trim();
		if (key && state.has(key)) details.open = state.get(key);
	}
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
 * Play mode
 *
 * Two modes, because they are two different jobs. Build mode is the wizard:
 * making choices, levelling up, changing your mind. Play mode is what you keep
 * open at the table -- everything already chosen, laid out to be used, with
 * nothing to decide. Play mode has two pages, since a caster's spell list does
 * not fit beside their armour class, and a real sheet keeps them separate too.
 * ------------------------------------------------------------------ */

async function showPlay(view = playView) {
	playView = view;
	const char = session.character;

	// Both pages read from lazily-loaded files; pull what this character needs
	// before drawing so nothing renders as a raw id.
	const needed = [];
	if (rules.allChosenSpells(char).length || rules.spellcasting(char)) needed.push(ensure("spells"));
	if (char.wildShapeForms?.length || Object.keys(char.companions ?? {}).length) needed.push(ensure("creatures"));
	if (needed.length) {
		mount(root, el("div.loading", {}, [el("div.loading__spinner"), el("p", { text: "Loading…" })]));
		await Promise.all(needed);
	}

	const isCaster = Boolean(rules.spellcasting(char));

	const sheetPage = renderSheet(session, {
		onEdit: () => showWizard(),
		onLevelUp: () => levelUpFlow(),
		onEditStep: (stepId, anchorTitle) => openStep(stepId, anchorTitle),
		onRerender: () => showPlay(playView),
	});

	// The spell page is always built for a caster, so Print emits both pages.
	const spellPage = isCaster
		? renderSpellSheet(session, {
			onEditStep: (stepId, anchorTitle) => openStep(stepId, anchorTitle),
			onRerender: () => showPlay(playView),
		})
		: null;

	mount(root, el("div.screen.screen--play", {}, [
		el("header.play__nav.no-print", {}, [
			el("button.link-btn", {
				type: "button", text: "← All characters",
				onclick: () => { session.saveNow(); showRoster(); },
			}),
			el("div.mode-switch", {}, [
				el("button.mode-switch__btn", {
					type: "button", text: "Build",
					title: "Make choices and level up",
					onclick: () => { session.saveNow(); showWizard(); },
				}),
				el("button.mode-switch__btn.is-active", {
					type: "button", text: "Play",
					title: "Use the character at the table",
				}),
			]),
			isCaster && el("div.page-tabs", {}, [
				el("button.page-tabs__btn", {
					type: "button", text: "Character",
					class: view === "character" ? "is-active" : "",
					onclick: () => showPlay("character"),
				}),
				el("button.page-tabs__btn", {
					type: "button", text: "Spells",
					class: view === "spells" ? "is-active" : "",
					onclick: () => showPlay("spells"),
				}),
			]),
		].filter(Boolean)),

		// Both pages stay in the DOM: CSS hides the inactive one on screen and
		// shows both when printing, so one Print gives the full sheet.
		el("div.play__page", { class: view === "character" ? "is-active" : "" }, [sheetPage]),
		spellPage && el("div.play__page.play__page--spells", {
			class: view === "spells" ? "is-active" : "",
		}, [spellPage]),
	].filter(Boolean)));
}

/** Kept for the older call sites; Play mode is the character sheet's home. */
const showSheet = () => showPlay("character");

/**
 * Open the wizard at a named step. Used by the "Change this" links on the sheet
 * so a trait can be revisited without hunting through the step bar. If the step
 * does not apply to this character (no spells on a Fighter), fall back to the
 * first step rather than landing on nothing.
 */
function openStep(stepId, anchorTitle = null) {
	const steps = relevantSteps(session.character);
	const index = steps.findIndex((s) => s.id === stepId);
	currentStepIndex = index === -1 ? 0 : index;
	// Matched against section headings after the render, so a link can land on
	// "Fighting Style" rather than the top of the Class step.
	pendingAnchor = anchorTitle;
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
		// An Ability Score Improvement can be spent on a feat instead, which is
		// how most characters actually spend it.
		asiMode: "scores",
		asi: { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 },
		featName: null,
		featOptions: {},
	};

	const die = cls.hitDie ?? 8;
	const conMod = rules.abilityMods(char).con ?? 0;
	const avg = rules.averageHpPerLevel(die);

	const bodyHost = el("div");

	/**
	 * Choosing a feat, then answering whatever it asks.
	 *
	 * The options are edited against a preview of the character with the feat
	 * already taken, so a question like Resilient's saving throw can grey out the
	 * saves you already have.
	 */
	const featPicker = () => {
		const options = asiFeatOptions(char, to);
		if (!options.length) {
			return notice("No feats available at this level in the loaded data.", "warn");
		}

		const preview = draft.featName
			? {
				...char,
				feats: [...(char.feats ?? []), draft.featName],
				featOptions: { ...(char.featOptions ?? {}), [draft.featName]: draft.featOptions },
			}
			: char;

		const pending = draft.featName ? pendingSummary(preview, draft.featName) : null;

		return el("div", {}, [
			el("div.pick-grid.pick-grid--compact", {}, options.map((f) =>
				card({
					title: f.name,
					subtitle: f.prerequisite ? `Requires ${f.prerequisite}` : null,
					blurb: f.blurb,
					meta: [f.srd ? "SRD" : f.source],
					selected: draft.featName === f.name,
					onSelect: () => {
						draft.featName = f.name;
						draft.featOptions = {};
						renderBody();
					},
					onInfo: () => modal(f.name, el("div", {}, [
						el("p.muted", {
							text: [f.category, f.prerequisite ? `Requires ${f.prerequisite}` : null, f.source]
								.filter(Boolean).join(" · "),
						}),
						el("div", { html: f.html ?? "" }),
					])),
				}),
			)),

			// Everything the chosen feat still needs.
			draft.featName && el("div.feat-detail", {}, [
				el("h4", { text: draft.featName }),
				featOptionsEditor(preview, draft.featName, {
					abilities: db.rules?.abilities ?? [],
					onChange: (next) => { draft.featOptions = next; renderBody(); },
				}),
				pending && notice(pending, "warn"),
			].filter(Boolean)),
		].filter(Boolean));
	};

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

			// Ability Score Improvement, or a feat in its place.
			grantsAsi && section("Ability Score Improvement",
				"Raise your scores, or take a feat instead.",
				[
					el("div.mode-switch", {}, [
						el("button.mode-switch__btn", {
							type: "button", text: "Raise scores",
							class: draft.asiMode === "scores" ? "is-active" : "",
							onclick: () => { draft.asiMode = "scores"; renderBody(); },
						}),
						el("button.mode-switch__btn", {
							type: "button", text: "Take a feat",
							class: draft.asiMode === "feat" ? "is-active" : "",
							onclick: () => { draft.asiMode = "feat"; renderBody(); },
						}),
					]),

					draft.asiMode === "scores"
						? el("div", {}, [
							el("p.muted", { text: "Raise one ability by 2, or two abilities by 1 each." }),
							el("div.assign-grid", {}, (db.rules?.abilities ?? []).map((a) =>
								field(a.name,
									el("input.assign-input", {
										type: "number", min: 0, max: 2, value: draft.asi[a.id],
										oninput: (e) => { draft.asi[a.id] = Number(e.target.value) || 0; renderBody(); },
									}),
								),
							)),
							el("p.muted", {
								text: `Allocated ${Object.values(draft.asi).reduce((x, y) => x + y, 0)} of 2 points.`,
							}),
						])
						: featPicker(),
				],
			),
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
					const takingFeat = grantsAsi && draft.asiMode === "feat";

					if (grantsAsi && !takingFeat && asiTotal > 2) { toast("An ASI grants only 2 points."); return; }
					if (needsSubclass && !draft.subclassId) { toast("Choose a subclass first."); return; }
					if (takingFeat && !draft.featName) { toast("Choose a feat, or switch back to raising scores."); return; }

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
						// Only one of the two applies: scores or a feat.
						if (!takingFeat) {
							for (const [k, v] of Object.entries(draft.asi)) asiNext[k] = (asiNext[k] ?? 0) + v;
						}

						const feats = takingFeat ? [...(c.feats ?? []), draft.featName] : (c.feats ?? []);
						const featOptions = takingFeat
							? { ...(c.featOptions ?? {}), [draft.featName]: draft.featOptions }
							: (c.featOptions ?? {});
						const featLevels = takingFeat
							? { ...(c.featLevels ?? {}), [draft.featName]: to }
							: (c.featLevels ?? {});

						return {
							...c, classes: nextClasses, asiBonuses: asiNext,
							feats, featOptions, featLevels,
						};
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
