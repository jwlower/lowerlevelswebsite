/**
 * ui.js - small DOM helpers shared by every screen.
 *
 * No framework. Screens build DOM nodes with el() and swap them into a mount
 * point, which keeps the whole app dependency-free and fast to load on a phone.
 */

/**
 * Create an element.
 *   el("div.card", { onclick }, [child, "text"])
 * The tag string supports .class and #id shorthand.
 */
export function el(spec, props = {}, children = []) {
	const [tagPart, ...classParts] = String(spec).split(".");
	const [tag, id] = tagPart.split("#");
	const node = document.createElement(tag || "div");
	if (id) node.id = id;
	if (classParts.length) node.className = classParts.join(" ");

	for (const [key, value] of Object.entries(props ?? {})) {
		if (value == null || value === false) continue;
		if (key === "class") node.className = [node.className, value].filter(Boolean).join(" ");
		else if (key === "html") node.innerHTML = value;
		else if (key === "text") node.textContent = value;
		else if (key === "dataset") Object.assign(node.dataset, value);
		else if (key.startsWith("on") && typeof value === "function") {
			node.addEventListener(key.slice(2).toLowerCase(), value);
		} else if (key in node && key !== "list") {
			try { node[key] = value; } catch { node.setAttribute(key, value); }
		} else {
			node.setAttribute(key, value === true ? "" : value);
		}
	}

	for (const child of [children].flat(Infinity)) {
		if (child == null || child === false) continue;
		node.append(child instanceof Node ? child : document.createTextNode(String(child)));
	}
	return node;
}

export const clear = (node) => {
	while (node.firstChild) node.removeChild(node.firstChild);
	return node;
};

export const mount = (node, ...children) => {
	clear(node);
	node.append(...children.flat(Infinity).filter(Boolean));
	return node;
};

export const escapeHtml = (s) =>
	String(s ?? "").replace(/[&<>"']/g, (c) =>
		({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/* ------------------------------------------------------------------ *
 * Shared components
 * ------------------------------------------------------------------ */

/** A selectable option card used by every picker step. */
export function card({ title, subtitle, blurb, meta = [], selected = false, badge, onSelect, onInfo }) {
	return el("button.pick-card", {
		type: "button",
		class: selected ? "is-selected" : "",
		"aria-pressed": String(selected),
		onclick: onSelect,
	}, [
		el("div.pick-card__head", {}, [
			el("span.pick-card__title", { text: title }),
			badge && el("span.pick-card__badge", { text: badge }),
		]),
		subtitle && el("div.pick-card__subtitle", { text: subtitle }),
		blurb && el("p.pick-card__blurb", { text: blurb }),
		meta.length > 0 && el("div.pick-card__meta", {}, meta.map((m) => el("span.chip", { text: m }))),
		onInfo && el("span.pick-card__info", {
			role: "button",
			tabindex: "0",
			text: "Details",
			onclick: (e) => { e.stopPropagation(); onInfo(); },
			onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); e.preventDefault(); onInfo(); } },
		}),
	]);
}

/**
 * The circular "?" that opens an explanation.
 *
 * Used wherever a choice needs one, so the affordance is identical everywhere:
 * a small icon beside the thing it explains, rather than a sentence-shaped link
 * somewhere else on the page.
 */
export function infoButton(onClick, label = "this") {
	return el("button.info-btn", {
		type: "button",
		text: "?",
		title: `What is ${label}?`,
		"aria-label": `What is ${label}?`,
		onclick: (e) => { e.preventDefault(); e.stopPropagation(); onClick(); },
	});
}

/** Section wrapper with a heading and optional hint line. */
export function section(title, hint, children) {
	return el("section.step-section", {}, [
		title && el("h3.step-section__title", { text: title }),
		hint && el("p.step-section__hint", { text: hint }),
		...[children].flat(Infinity).filter(Boolean),
	]);
}

/** Labelled field wrapper. */
export function field(label, control, hint) {
	return el("label.field", {}, [
		el("span.field__label", { text: label }),
		control,
		hint && el("span.field__hint", { text: hint }),
	]);
}

/* ------------------------------------------------------------------ *
 * Modals
 *
 * References open on top of each other -- a background leads to its origin
 * feat, which mentions a condition -- so the stack is managed explicitly:
 * only the bottom window dims the page, each one above is offset slightly so
 * the stack is legible, and every window is fully opaque so text never shows
 * through from the one behind.
 * ------------------------------------------------------------------ */

const modalStack = [];

/** Re-apply depth attributes after anything opens or closes. */
function restackModals() {
	modalStack.forEach((overlay, i) => {
		overlay.dataset.depth = String(i);
		overlay.classList.toggle("is-backdrop", i === 0);
		// Cascade, but stop drifting after a few so it never walks off screen.
		const step = Math.min(i, 4);
		overlay.style.setProperty("--modal-offset", `${step * 18}px`);
		// Only the topmost window takes pointer events for its backdrop click.
		overlay.classList.toggle("is-top", i === modalStack.length - 1);
	});
}

/**
 * A modal dialog. Returns a close function.
 * Escape and the backdrop close the TOP window only, so a stack unwinds one
 * layer at a time rather than all at once.
 */
export function modal(title, contentNode) {
	const close = () => {
		const i = modalStack.indexOf(overlay);
		if (i !== -1) modalStack.splice(i, 1);
		overlay.remove();
		document.removeEventListener("keydown", onKey);
		restackModals();
	};

	const overlay = el("div.modal-overlay", {
		onclick: (e) => {
			// Only the top window responds, and only to its own backdrop.
			if (e.target === overlay && modalStack[modalStack.length - 1] === overlay) close();
		},
	}, [
		el("div.modal", { role: "dialog", "aria-modal": "true", "aria-label": title }, [
			el("header.modal__head", {}, [
				el("h3.modal__title", { text: title }),
				el("button.modal__close", { type: "button", text: "Close", onclick: close }),
			]),
			el("div.modal__body", {}, [contentNode]),
		]),
	]);

	const onKey = (e) => {
		if (e.key !== "Escape") return;
		if (modalStack[modalStack.length - 1] !== overlay) return;
		close();
	};

	document.addEventListener("keydown", onKey);
	// Mount inside the themed container, not on <body>. Every colour token and
	// control style is scoped to .creator, so a modal parented to <body> loses
	// all of them -- which is why the panels rendered unstyled and see-through.
	// position: fixed still covers the viewport from in here.
	(document.querySelector(".creator") ?? document.body).append(overlay);
	modalStack.push(overlay);
	restackModals();
	return close;
}

/** Close every open window. Used when navigating to another screen. */
export function closeAllModals() {
	while (modalStack.length) {
		const overlay = modalStack.pop();
		overlay.remove();
	}
}

/** Renders the pre-sanitised rules HTML produced by the extractor. */
export function rulesHtml(html) {
	return el("div.rules-text", { html: html ?? "" });
}

/** Small inline notice. */
export const notice = (text, kind = "info") => el(`div.notice.notice--${kind}`, { text });

/** Toast confirmation, auto-dismissing. */
export function toast(message) {
	const node = el("div.toast", { text: message });
    document.body.append(node);
	setTimeout(() => node.classList.add("is-out"), 2200);
	setTimeout(() => node.remove(), 2600);
}

/** Checkbox / radio list where the caller controls the selection limit. */
export function choiceList({ options, selected, max = 1, onChange, disabledIds = new Set(), onInfo }) {
	const chosen = new Set(selected ?? []);
	const single = max === 1;

	const list = el("div.choice-list", {},
		options.map((opt) => {
			const isChosen = chosen.has(opt.id);
			const locked = disabledIds.has(opt.id) && !isChosen;
			const atLimit = !isChosen && chosen.size >= max;

			return el("label.choice", {
				class: [isChosen ? "is-chosen" : "", locked ? "is-locked" : "", atLimit ? "is-disabled" : ""].filter(Boolean).join(" "),
			}, [
				el("input", {
					type: single ? "radio" : "checkbox",
					name: single ? `choice-${Math.random().toString(36).slice(2)}` : undefined,
					checked: isChosen,
					disabled: locked || (atLimit && !single),
					onchange: () => {
						if (single) onChange([opt.id]);
						else {
							if (chosen.has(opt.id)) chosen.delete(opt.id);
							else if (chosen.size < max) chosen.add(opt.id);
							onChange([...chosen]);
						}
					},
				}),
				el("span.choice__body", {}, [
					el("span.choice__label", { text: opt.label }),
					opt.hint && el("span.choice__hint", { text: opt.hint }),
				]),
				locked && el("span.choice__lock", { text: "already have" }),
				// Sits beside the option it explains.
				onInfo && infoButton(() => onInfo(opt), opt.label),
			]);
		}),
	);
	return list;
}

/** Small labelled stat tile, used for save DCs, slot counts and the like. */
export const statBox = (label, value) =>
	el("div.stat-box", {}, [
		el("span.stat-box__label", { text: label }),
		el("span.stat-box__value", { text: value }),
	]);

/**
 * A clickable reference to a named thing, resolved by the glossary.
 *
 * Uses the same `.rr-ref[data-ref]` contract as rules text, so the one delegated
 * listener handles it and no screen needs its own lookup. Items, languages and
 * rules entries all come through here, which is why equipment on the sheet
 * behaves exactly like a spell name does.
 */
export function refLink(text, ref, { title, className = "" } = {}) {
	if (!ref) return el("span", { text });
	return el(`span.rr-ref${className ? `.${className}` : ""}`, {
		dataset: { ref },
		role: "button",
		tabindex: "0",
		title: title ?? `What is ${text}?`,
		text,
	});
}

/** Shorthand for an item, which is the most common case. */
export const itemLink = (name, extra = {}) =>
	refLink(name, `item|${name}|`, { title: `Read ${name}`, ...extra });

/**
 * A row of clickable weapon properties and masteries.
 *
 * "Thrown", "Finesse" and "Nick" are rules with real text behind them, and they
 * are exactly the things you forget mid-fight. Each becomes a chip that opens
 * its entry, using the same delegated glossary listener as rules text.
 */
export function propertyChips(properties = [], masteries = [], edition = "2024") {
	const source = edition === "2014" ? "PHB" : "XPHB";
	const chips = [
		...masteries.map((name) => ({ name, ref: `itemMastery|${name}|${source}`, kind: "mastery" })),
		...properties.map((name) => ({ name, ref: `property|${name}|${source}`, kind: "property" })),
	];
	if (!chips.length) return null;

	return el("span.prop-chips", {}, chips.map((chip) =>
		el("span.prop-chip.rr-ref", {
			class: chip.kind === "mastery" ? "prop-chip--mastery" : "",
			dataset: { ref: chip.ref },
			role: "button",
			tabindex: "0",
			title: `${chip.name} — click to read`,
			text: chip.name,
		}),
	));
}

/** Debounce helper for text inputs. */
export function debounce(fn, ms = 250) {
	let t;
	return (...args) => {
		clearTimeout(t);
		t = setTimeout(() => fn(...args), ms);
	};
}

/** Formats a gp amount for display. */
export const gp = (n) => `${Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} gp`;
