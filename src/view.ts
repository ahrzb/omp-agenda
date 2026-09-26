import type { Theme, ThemeColor } from "@oh-my-pi/pi-coding-agent";
import type { Component, KeyId, MarkdownTheme, TUI } from "@oh-my-pi/pi-tui";
import {
	applyBackgroundToLine,
	Markdown,
	matchesKey,
	replaceTabs,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui";
import {
	type Agenda,
	find,
	isClosed,
	type Item,
	isWithin,
	isSettled,
	progress,
	STATUSES,
	type Status,
	splitDetails,
} from "./model.ts";

/** Key ids like `alt+g`; set before omp starts, because shortcuts are fixed when the extension loads. */
function keyFromEnv(name: string, fallback: KeyId): KeyId {
	const value = process.env[name]?.trim().toLowerCase();
	return value ? (value as KeyId) : fallback;
}
export const EXPAND_KEY = keyFromEnv("OMP_AGENDA_EXPAND_KEY", "alt+g");
export const FULLSCREEN_KEY = keyFromEnv("OMP_AGENDA_FULLSCREEN_KEY", "alt+shift+g");
/** Most topic ids the pinned line lists; beyond this it shows a window around the current topic. */
export const MAX_CHIPS = 7;

const GLYPH: Record<Status, string> = { open: "○", decided: "●", parked: "◌", dropped: "✕" };
const COLOR: Record<Status, ThemeColor> = { open: "muted", decided: "success", parked: "warning", dropped: "dim" };
/** Expanded widget never takes more than this share of the terminal. */
const EXPANDED_MAX_ROWS_RATIO = 0.45;
/** Automatic cap on an item's partial view (rendered lines) when the model's break line comes late or not at all. */
export const PARTIAL_MAX_LINES = 8;

/** One-line summary of an item: glyph, id, title, decision / status tag, sub-item progress. */
function itemLine(item: Item, theme: Theme, focus: string | undefined, bold: boolean): string {
	let title = item.title;
	if (item.id === focus) title = theme.fg("accent", theme.bold(title));
	else if (item.status === "dropped") title = theme.fg("dim", title);
	else if (bold) title = theme.bold(title);
	let line = `${theme.fg(COLOR[item.status], GLYPH[item.status])} ${theme.fg("dim", item.id)} ${title}`;
	if (item.decision) line += theme.fg("dim", " → ") + theme.fg("success", item.decision);
	if (item.status === "parked" || item.status === "dropped") line += theme.fg("dim", ` · ${item.status}`);
	if (item.items.length > 0) {
		const { closed, total } = progress(item.items);
		line += theme.fg("dim", ` · ${closed}/${total}`);
	}
	return replaceTabs(line);
}

function renderMarkdown(text: string, width: number, md: MarkdownTheme): readonly string[] {
	return new Markdown(text, 0, 0, md).render(Math.max(10, width));
}

/**
 * omp's markdown theme, with one change: code the highlighter leaves uncolored (untagged fences, or a
 * language it doesn't know) gets the theme's code-block color instead of reading like prose.
 */
export function agendaMarkdownTheme(md: MarkdownTheme, theme: Theme): MarkdownTheme {
	return {
		...md,
		highlightCode: (code, lang) => {
			const lines = md.highlightCode?.(code, lang) ?? code.split("\n");
			if (lines.some(line => line.includes("\x1b["))) return lines;
			return lines.map(line => theme.fg("mdCodeBlock", line));
		},
	};
}

/**
 * Header row: `Agenda  title  ○2 [○3·●○] ◌4  Current topic › 3.2 Sub-item        1/4 · alt+g ▾`.
 * Every open or parked topic is a status glyph + id; decided and dropped topics are left out (the
 * counter on the right still counts them). The current topic sits on a highlighted chip with its
 * sub-items' status dots, and its name follows the ids.
 */
function headerLine(agenda: Agenda, theme: Theme, width: number, expanded: boolean): string {
	const focused = agenda.focus === undefined ? undefined : find(agenda, agenda.focus);
	const focusTop = focused ? (focused.path[0] ?? focused.item) : undefined;
	const shown = agenda.items.filter(item => item === focusTop || !isClosed(item));
	// Past MAX_CHIPS ids the line stops being scannable: keep a window around the current topic
	// and count the rest on each side.
	let start = 0;
	if (shown.length > MAX_CHIPS) {
		const at = focusTop ? shown.indexOf(focusTop) : 0;
		start = Math.min(Math.max(0, at - Math.floor(MAX_CHIPS / 2)), shown.length - MAX_CHIPS);
	}
	const windowed = shown.slice(start, start + MAX_CHIPS);
	const before = start;
	const after = shown.length - start - windowed.length;
	let chips = windowed
		.map(item => {
			const glyph = theme.fg(COLOR[item.status], GLYPH[item.status]);
			if (item !== focusTop) return glyph + theme.fg("dim", item.id);
			let chip = glyph + theme.fg("accent", theme.bold(item.id));
			// Sub-items' statuses; the one on the focus path is in the accent color.
			if (item.items.length > 0) {
				const dots = item.items.map(child => {
					const color = focused && isWithin(focused.item.id, child.id) ? "accent" : COLOR[child.status];
					return theme.fg(color, GLYPH[child.status]);
				});
				chip += theme.fg("dim", "·") + dots.join("");
			}
			// A background chip finds the current topic at a glance, even where bold is not rendered.
			return theme.bg("selectedBg", ` ${chip} `);
		})
		.join(" ");
	if (before > 0) chips = `${theme.fg("dim", `+${before} ‹`)} ${chips}`;
	if (after > 0) chips += ` ${theme.fg("dim", `› +${after}`)}`;
	if (isSettled(agenda)) {
		// Nothing left to discuss: replace the ids with a done marker; parked items are still owed.
		const parked = flatten(agenda.items).filter(item => item.status === "parked").length;
		chips = theme.fg("success", "✓ all done") + (parked > 0 ? theme.fg("dim", ` · ${parked} parked`) : "");
	} else if (focused && focusTop && !expanded) {
		// Expanded mode names the topic in its body, so the header keeps only the ids.
		const name =
			focused.path.length === 0 ? focusTop.title : `${focusTop.title} › ${focused.item.id} ${focused.item.title}`;
		chips += `  ${theme.fg("accent", name)}`;
	}
	const { closed, total } = progress(agenda.items);
	const right = theme.fg("dim", `${closed}/${total} · ${EXPAND_KEY} ${expanded ? "▴" : "▾"}`);
	// A brighter chip than the band, so the widget is recognizable even on near-black status backgrounds.
	const label = theme.bg("selectedBg", theme.fg("accent", theme.bold(" Agenda ")));
	const candidates = [`${label} ${theme.fg("muted", agenda.title)}  ${chips}`, `${label} ${chips}`];
	const room = width - visibleWidth(right) - 2;
	const left = candidates.find(candidate => visibleWidth(candidate) <= room);
	if (left) return left + " ".repeat(width - visibleWidth(left) - visibleWidth(right)) + right;
	if (room >= 12) return `${truncateToWidth(candidates[1]!, room)}  ${right}`;
	return truncateToWidth(candidates[1]!, width);
}

/** Trailing marker on a heading whose content (details or sub-items) the current view hides. */
function hiddenMark(theme: Theme): string {
	return theme.fg("muted", " …");
}

/**
 * The partial view of an item's details: the text above the model's `<!-- more -->` line, capped at
 * PARTIAL_MAX_LINES rendered lines. The cap prefers the last paragraph/table boundary before the limit.
 */
function partialLines(item: Item, md: MarkdownTheme, prefix: string, width: number): { lines: string[]; cut: boolean } {
	if (!item.details) return { lines: [], cut: false };
	const { partial, marked } = splitDetails(item.details);
	let rendered = partial ? [...renderMarkdown(partial, width - visibleWidth(prefix), md)] : [];
	while (rendered.length > 0 && !rendered.at(-1)!.trim()) rendered.pop();
	let cut = marked;
	if (rendered.length > PARTIAL_MAX_LINES) {
		const boundary = rendered.slice(0, PARTIAL_MAX_LINES + 1).findLastIndex(line => !line.trim());
		rendered = rendered.slice(0, boundary > 0 ? boundary : PARTIAL_MAX_LINES);
		cut = true;
	}
	return { lines: rendered.filter(line => line.trim()).map(line => prefix + line), cut };
}

/**
 * Sub-item tree; only items on the path to `focus` open up to show their summary and children.
 * Headings with anything left unshown get the hidden marker; `hid` records whether any did.
 */
function subTree(
	items: readonly Item[],
	theme: Theme,
	md: MarkdownTheme,
	focus: string | undefined,
	prefix: string,
	width: number,
	hid: { found: boolean },
): string[] {
	const lines: string[] = [];
	items.forEach((child, index) => {
		const last = index === items.length - 1;
		const branch = theme.fg("dim", `${last ? theme.tree.last : theme.tree.branch} `);
		const open = focus !== undefined && isWithin(focus, child.id);
		const inner = prefix + (last ? "   " : theme.fg("dim", `${theme.tree.vertical}  `));
		const partial = open ? partialLines(child, md, inner, width) : undefined;
		const hidden = partial ? partial.cut : !!child.details || child.items.length > 0;
		if (hidden) hid.found = true;
		lines.push(`${prefix}${branch}${itemLine(child, theme, focus, false)}${hidden ? hiddenMark(theme) : ""}`);
		if (!partial) return;
		lines.push(...partial.lines);
		lines.push(...subTree(child.items, theme, md, focus, inner, width, hid));
	});
	return lines;
}

/**
 * Sticky widget above the editor: one header row; expanded adds the current topic's partial view and sub-items.
 * Every row carries an accent bar and a background band so it reads as UI chrome, not transcript.
 */
export class AgendaWidget implements Component {
	#cache: { width: number; rows: number; lines: string[] } | undefined;

	constructor(
		private readonly agenda: Agenda,
		private readonly expanded: boolean,
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly md: MarkdownTheme,
	) {}

	render(width: number): readonly string[] {
		const rows = this.tui.terminal.rows;
		if (this.#cache?.width === width && this.#cache.rows === rows) return this.#cache.lines;
		const { theme } = this;
		// Bar + space on the left, one space of right margin.
		const inner = Math.max(1, width - 3);
		const lines = [headerLine(this.agenda, theme, inner, this.expanded)];
		if (this.expanded) {
			const body = this.#body(inner);
			const max = Math.max(3, Math.floor(rows * EXPANDED_MAX_ROWS_RATIO) - 1);
			if (body.length > max) {
				const hidden = body.length - (max - 1);
				body.length = max - 1;
				body.push(theme.fg("dim", `  … ${hidden} more lines · ${FULLSCREEN_KEY} full view`));
			}
			lines.push(...body);
		}
		const bar = theme.fg("accent", "▌");
		const band = (text: string) => theme.bg("statusLineBg", text);
		// applyBackgroundToLine survives bg-only resets; mermaid output also emits full resets.
		const open = band("\x01").split("\x01")[0]!;
		const out = lines.map(line =>
			applyBackgroundToLine(
				`${bar} ${truncateToWidth(line, inner)}`.replace(/\x1b\[0?m/g, reset => reset + open),
				width,
				band,
			),
		);
		this.#cache = { width, rows, lines: out };
		return out;
	}

	invalidate(): void {
		this.#cache = undefined;
	}

	#body(width: number): string[] {
		const { agenda, theme, md } = this;
		if (agenda.items.length === 0) return [theme.fg("dim", "  (empty)")];
		const hid = { found: false };
		const lines: string[] = [];
		if (agenda.focus === undefined) {
			lines.push(...subTree(agenda.items, theme, md, undefined, " ", width, hid));
		} else {
			const { item, path } = find(agenda, agenda.focus);
			const topic = path[0] ?? item;
			const partial = partialLines(topic, md, "   ", width);
			if (partial.cut) hid.found = true;
			lines.push(` ${itemLine(topic, theme, agenda.focus, true)}${partial.cut ? hiddenMark(theme) : ""}`);
			lines.push(...partial.lines);
			lines.push(...subTree(topic.items, theme, md, agenda.focus, "   ", width, hid));
		}
		if (hid.found) lines.push(`${hiddenMark(theme)} ${theme.fg("dim", `more in full view · ${FULLSCREEN_KEY}`)}`);
		return lines;
	}
}

type Visibility = "overview" | "contents" | "all";
const NEXT_VISIBILITY: Record<Visibility, Visibility> = { overview: "contents", contents: "all", all: "overview" };

interface Document {
	width: number;
	lines: string[];
	/** Visible headings in document order, with their line index. */
	headings: { id: string; line: number }[];
}

function flatten(items: readonly Item[]): Item[] {
	return items.flatMap(item => [item, ...flatten(item.items)]);
}

/**
 * Full-screen, read-only outline of every topic with org-mode style controls:
 * Tab cycles the heading under the cursor (folded → children → subtree),
 * Shift+Tab cycles everything (overview → contents → show all), and the cursor moves
 * between headings. It opens on the current topic with everything else collapsed.
 */
export class AgendaViewer implements Component {
	#scroll = 0;
	#cursor: string | undefined;
	/** Scroll the cursor heading into view on the next render. */
	#reveal = true;
	/** The viewport was paged; pull the cursor into it on the next render. */
	#followScroll = false;
	#doc: Document | undefined;
	/** Headings whose details and sub-items are hidden. */
	#folded = new Set<string>();
	/** Unfolded headings whose own details are hidden (org's CHILDREN / CONTENTS states). */
	#bodyHidden = new Set<string>();
	#visibility: Visibility = "all";
	/** `d` switches to a page listing only decided items, one line each. */
	#decisionsPage = false;
	#decisionsScroll = 0;

	constructor(
		private readonly agenda: Agenda,
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly md: MarkdownTheme,
		private readonly close: () => void,
	) {
		this.#cursor = agenda.focus ?? agenda.items[0]?.id;
		if (agenda.focus === undefined) return;
		// Collapse all but the current item: other headings fold, ancestors show only their
		// sub-item headings (so the current item stays in context), the current item shows everything.
		for (const item of flatten(agenda.items)) this.#folded.add(item.id);
		const { item, path } = find(agenda, agenda.focus);
		for (const ancestor of path) {
			this.#folded.delete(ancestor.id);
			this.#bodyHidden.add(ancestor.id);
		}
		for (const entry of flatten([item])) this.#folded.delete(entry.id);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q" || matchesKey(data, FULLSCREEN_KEY)) {
			this.close();
			return;
		}
		if (data === "d") {
			this.#decisionsPage = !this.#decisionsPage;
			this.tui.requestRender();
			return;
		}
		if (this.#decisionsPage) {
			this.#scrollDecisions(data);
			return;
		}
		const headings = this.#doc?.headings ?? [];
		const at = headings.findIndex(heading => heading.id === this.#cursor);
		const located = this.#cursor === undefined ? undefined : find(this.agenda, this.#cursor);
		const page = Math.max(1, this.#bodyHeight() - 1);
		if (matchesKey(data, "tab")) {
			if (located) this.#cycle(located.item);
		} else if (matchesKey(data, "shift+tab")) this.#cycleAll();
		else if (matchesKey(data, "down") || data === "j" || data === "n") this.#moveTo(headings[at + 1]?.id);
		else if (matchesKey(data, "up") || data === "k" || data === "p") this.#moveTo(headings[at - 1]?.id);
		else if (data === "f") this.#moveTo(located?.siblings[located.index + 1]?.id);
		else if (data === "b") this.#moveTo(located?.siblings[located.index - 1]?.id);
		else if (data === "u") this.#moveTo(located?.path.at(-1)?.id);
		else if (matchesKey(data, "home") || data === "g") this.#moveTo(headings[0]?.id);
		else if (matchesKey(data, "end") || data === "G") this.#moveTo(headings.at(-1)?.id);
		else if (matchesKey(data, "pageDown") || matchesKey(data, "space")) this.#page(page);
		else if (matchesKey(data, "pageUp")) this.#page(-page);
		else return;
		this.tui.requestRender();
	}

	render(width: number): readonly string[] {
		if (this.#decisionsPage) return this.#renderDecisions(width);
		const { theme } = this;
		const doc = this.#document(width);
		const height = this.#bodyHeight();
		const visible = new Set(doc.headings.map(heading => heading.id));
		// Folding hid the cursor: fall back to its nearest visible ancestor.
		let cursor = this.#cursor;
		while (cursor !== undefined && !visible.has(cursor)) {
			cursor = cursor.includes(".") ? cursor.slice(0, cursor.lastIndexOf(".")) : undefined;
		}
		this.#cursor = cursor ?? doc.headings[0]?.id;
		let cursorLine = doc.headings.find(heading => heading.id === this.#cursor)?.line ?? 0;
		if (this.#reveal) {
			this.#reveal = false;
			if (cursorLine < this.#scroll || cursorLine >= this.#scroll + height) {
				this.#scroll = cursorLine;
				// Bring the top-level topic's heading into view too, when it fits, so a sub-item never looks orphaned.
				const topId = this.#cursor === undefined ? undefined : find(this.agenda, this.#cursor).path[0]?.id;
				const topLine = doc.headings.find(heading => heading.id === topId)?.line;
				if (topLine !== undefined && cursorLine - topLine < height) this.#scroll = topLine;
			}
		}
		const maxScroll = Math.max(0, doc.lines.length - height);
		this.#scroll = Math.min(Math.max(0, this.#scroll), maxScroll);
		if (this.#followScroll) {
			this.#followScroll = false;
			if (cursorLine < this.#scroll || cursorLine >= this.#scroll + height) {
				const top =
					doc.headings.find(heading => heading.line >= this.#scroll && heading.line < this.#scroll + height) ??
					doc.headings.findLast(heading => heading.line <= this.#scroll);
				if (top) ({ id: this.#cursor, line: cursorLine } = top);
			}
		}

		const { closed, total } = progress(this.agenda.items);
		const title = `${theme.fg("accent", theme.bold("Agenda"))} ${theme.bold(this.agenda.title)}`;
		const legend = [
			...STATUSES.map(status => `${theme.fg(COLOR[status], GLYPH[status])} ${theme.fg("dim", status)}`),
			theme.fg("accent", "current"),
			`${theme.fg("muted", "…")} ${theme.fg("dim", "hidden")}`,
		].join("  ");
		let right = `${legend}   ${theme.fg("dim", `${closed}/${total} closed`)}`;
		if (visibleWidth(title) + visibleWidth(right) + 3 > width) right = theme.fg("dim", `${closed}/${total} closed`);
		const gap = Math.max(1, width - 2 - visibleWidth(title) - visibleWidth(right));
		const body: string[] = [];
		for (let line = this.#scroll; line < this.#scroll + height; line++) {
			const text = doc.lines[line];
			if (text === undefined) body.push("");
			else if (line !== cursorLine) body.push(`  ${text}`);
			else {
				const row = truncateToWidth(`${theme.fg("accent", "›")} ${text}`, width);
				body.push(theme.bg("selectedBg", row + " ".repeat(Math.max(0, width - visibleWidth(row)))));
			}
		}
		const position = maxScroll === 0 ? "all" : `${Math.round((this.#scroll / maxScroll) * 100)}%`;
		const footer = theme.fg(
			"dim",
			`tab fold · S-tab ${NEXT_VISIBILITY[this.#visibility]} · ↑↓/np heading · f/b sibling · u up · space/pgup page · d decisions · q close · ${position}`,
		);
		return [
			` ${title}${" ".repeat(gap)}${right}`,
			this.#contextRule(doc, width),
			...body,
			` ${footer}`,
		].map(line => truncateToWidth(line, width));
	}

	invalidate(): void {
		this.#doc = undefined;
	}

	/**
	 * Every decided item in document order: `● 2.1  Title → decision`, sub-items indented under their
	 * parents. Long lines wrap under the title so no decision is cut off.
	 */
	#decisionLines(width: number): { lines: string[]; count: number } {
		const { theme } = this;
		const decided: { item: Item; depth: number }[] = [];
		const walk = (items: readonly Item[], depth: number) => {
			for (const item of items) {
				if (item.status === "decided") decided.push({ item, depth });
				walk(item.items, depth + 1);
			}
		};
		walk(this.agenda.items, 0);
		if (decided.length === 0) return { lines: [theme.fg("dim", "Nothing decided yet.")], count: 0 };
		const idWidth = Math.max(...decided.map(({ item, depth }) => item.id.length + depth * 2));
		const lines = decided.flatMap(({ item, depth }) => {
			const id = `${"  ".repeat(depth)}${item.id}`.padEnd(idWidth);
			let text = item.title;
			if (item.decision) text += theme.fg("dim", " → ") + theme.fg("success", item.decision);
			// Row = 2 margin + glyph + space + id + 2 spaces; continuation rows align with the title.
			const indent = " ".repeat(2 + idWidth + 2);
			const [first = "", ...rest] = wrapTextWithAnsi(replaceTabs(text), Math.max(10, width - 2 - indent.length));
			return [`${theme.fg("success", GLYPH.decided)} ${theme.fg("dim", id)}  ${first}`, ...rest.map(line => indent + line)];
		});
		return { lines, count: decided.length };
	}

	#scrollDecisions(data: string): void {
		const page = Math.max(1, this.#bodyHeight() - 1);
		if (matchesKey(data, "down") || data === "j" || data === "n") this.#decisionsScroll += 1;
		else if (matchesKey(data, "up") || data === "k" || data === "p") this.#decisionsScroll -= 1;
		else if (matchesKey(data, "pageDown") || matchesKey(data, "space")) this.#decisionsScroll += page;
		else if (matchesKey(data, "pageUp")) this.#decisionsScroll -= page;
		else if (matchesKey(data, "home") || data === "g") this.#decisionsScroll = 0;
		else if (matchesKey(data, "end") || data === "G") this.#decisionsScroll = Number.MAX_SAFE_INTEGER;
		else return;
		this.tui.requestRender();
	}

	#renderDecisions(width: number): readonly string[] {
		const { theme } = this;
		const { lines, count } = this.#decisionLines(width);
		const height = this.#bodyHeight();
		const maxScroll = Math.max(0, lines.length - height);
		this.#decisionsScroll = Math.min(Math.max(0, this.#decisionsScroll), maxScroll);
		const title = `${theme.fg("accent", theme.bold("Agenda"))} ${theme.bold(this.agenda.title)} ${theme.fg("muted", "· decisions")}`;
		const right = theme.fg("dim", `${count} decided`);
		const gap = Math.max(1, width - 2 - visibleWidth(title) - visibleWidth(right));
		const body = lines.slice(this.#decisionsScroll, this.#decisionsScroll + height).map(line => `  ${line}`);
		while (body.length < height) body.push("");
		const position = maxScroll === 0 ? "all" : `${Math.round((this.#decisionsScroll / maxScroll) * 100)}%`;
		const footer = theme.fg("dim", `d back to outline · ↑↓/jk scroll · space/pgup page · q close · ${position}`);
		return [
			` ${title}${" ".repeat(gap)}${right}`,
			theme.fg("borderMuted", "─".repeat(width)),
			...body,
			` ${footer}`,
		].map(line => truncateToWidth(line, width));
	}

	#bodyHeight(): number {
		return Math.max(1, this.tui.terminal.rows - 3);
	}

	/**
	 * Divider under the title. When the top of the viewport is inside an item whose heading (or
	 * whose parents' headings) scrolled off, it names them: `── 1 When does… › 1.1 Agent… ─────`.
	 */
	#contextRule(doc: Document, width: number): string {
		const { theme } = this;
		const top = doc.headings.findLast(heading => heading.line <= this.#scroll);
		let crumb: Item[] = [];
		if (top) {
			const { item, path } = find(this.agenda, top.id);
			crumb = top.line < this.#scroll ? [...path, item] : path;
		}
		if (crumb.length === 0) return theme.fg("borderMuted", "─".repeat(width));
		const label = truncateToWidth(` ${crumb.map(item => `${item.id} ${item.title}`).join(" › ")} › `, width - 6);
		const rest = Math.max(0, width - 2 - visibleWidth(label));
		return theme.fg("borderMuted", "──") + theme.fg("muted", label) + theme.fg("borderMuted", "─".repeat(rest));
	}

	#moveTo(id: string | undefined): void {
		if (id === undefined) return;
		this.#cursor = id;
		this.#reveal = true;
	}

	#page(delta: number): void {
		this.#scroll += delta;
		this.#followScroll = true;
	}

	/** org-cycle: FOLDED → CHILDREN → SUBTREE → FOLDED (CHILDREN is skipped for items without sub-items). */
	#cycle(item: Item): void {
		const hasChildren = item.items.length > 0;
		if (!hasChildren && !item.details) return;
		if (this.#folded.has(item.id)) {
			this.#folded.delete(item.id);
			if (hasChildren) {
				this.#bodyHidden.add(item.id);
				for (const child of item.items) this.#folded.add(child.id);
			} else {
				this.#bodyHidden.delete(item.id);
			}
		} else if (this.#fullyShown(item)) {
			this.#folded.add(item.id);
		} else {
			for (const entry of flatten([item])) {
				this.#folded.delete(entry.id);
				this.#bodyHidden.delete(entry.id);
			}
		}
		this.#doc = undefined;
		this.#reveal = true;
	}

	#fullyShown(item: Item): boolean {
		const text = item.details;
		if (item.items.length === 0 && !text) return true;
		if (this.#folded.has(item.id)) return false;
		if (text && this.#bodyHidden.has(item.id)) return false;
		return item.items.every(child => this.#fullyShown(child));
	}

	/** org-global-cycle: OVERVIEW (top level only) → CONTENTS (all headings) → SHOW ALL. */
	#cycleAll(): void {
		this.#visibility = NEXT_VISIBILITY[this.#visibility];
		this.#folded.clear();
		this.#bodyHidden.clear();
		for (const item of flatten(this.agenda.items)) {
			if (this.#visibility === "overview") this.#folded.add(item.id);
			if (this.#visibility === "contents") this.#bodyHidden.add(item.id);
		}
		this.#doc = undefined;
		this.#reveal = true;
	}

	#document(width: number): Document {
		if (this.#doc?.width === width) return this.#doc;
		const { theme, agenda } = this;
		const lines: string[] = [];
		const headings: Document["headings"] = [];
		const walk = (items: readonly Item[], depth: number) => {
			const indent = "  ".repeat(depth);
			for (const item of items) {
				const folded = this.#folded.has(item.id);
				const text = item.details && splitDetails(item.details).full;
				const bodyHidden = !!text && this.#bodyHidden.has(item.id);
				const hasContent = item.items.length > 0 || !!text;
				const marker = !hasContent ? " " : folded ? "▸" : "▾";
				const heading = lines.length;
				headings.push({ id: item.id, line: heading });
				let line = `${indent}${theme.fg("dim", marker)} ${itemLine(item, theme, agenda.focus, depth === 0)}`;
				// Like org's ellipsis: anything under this heading that is not on screen.
				if (folded ? hasContent : bodyHidden) line += hiddenMark(theme);
				// A folded heading that contains the current item says so, so it can be found without unfolding.
				const focus = agenda.focus;
				if (folded && focus !== undefined && focus !== item.id && isWithin(focus, item.id)) {
					line += theme.fg("accent", ` · current ${focus}`);
				}
				lines.push(line);
				if (!folded) {
					if (text && !bodyHidden) {
						for (const rendered of renderMarkdown(text, width - indent.length - 6, this.md)) {
							lines.push(`${indent}    ${rendered}`);
						}
					}
					walk(item.items, depth + 1);
				}
				// Separate top-level topics only when something is shown beneath the heading.
				if (depth === 0 && lines.length - heading > 1) lines.push("");
			}
		};
		walk(agenda.items, 0);
		if (lines.length === 0) lines.push(theme.fg("dim", "(no topics yet)"));
		this.#doc = { width, lines, headings };
		return this.#doc;
	}
}
