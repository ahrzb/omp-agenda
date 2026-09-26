import type { AutocompleteProviderFactory } from "@oh-my-pi/pi-coding-agent";
import type { AutocompleteItem, AutocompleteProvider } from "@oh-my-pi/pi-tui";
import { type Agenda, type Item, isClosed } from "./model.ts";

/** An agenda reference being typed: `[`, `[2`, `[2.1` at the end of a token. */
const REFERENCE_PREFIX = /(?:^|[\s(])(\[[\d.]*)$/;

const GLYPH: Record<Item["status"], string> = { open: "○", decided: "●", parked: "◌", dropped: "✕" };

/**
 * Picker items for a partially typed `[id` reference: ids starting with what was typed. The current
 * item comes first (so it is preselected), then open and parked items, then closed ones, each in
 * document order.
 */
export function referenceSuggestions(
	agenda: Agenda,
	textBeforeCursor: string,
): { items: AutocompleteItem[]; prefix: string } | null {
	const prefix = REFERENCE_PREFIX.exec(textBeforeCursor)?.[1];
	if (prefix === undefined) return null;
	const typed = prefix.slice(1);
	const all: Item[] = [];
	const walk = (items: readonly Item[]) => {
		for (const item of items) {
			all.push(item);
			walk(item.items);
		}
	};
	walk(agenda.items);
	const rank = (item: Item) => (item.id === agenda.focus ? 0 : isClosed(item) ? 2 : 1);
	const matches = all.filter(item => item.id.startsWith(typed)).sort((a, b) => rank(a) - rank(b));
	if (matches.length === 0) return null;
	return {
		prefix,
		items: matches.map(item => ({
			value: `[${item.id}]`,
			label: `[${item.id}] ${item.title}`,
			icon: GLYPH[item.status],
			description: item.id === agenda.focus ? "current" : (item.decision ?? item.status),
		})),
	};
}

/**
 * Wraps the editor's provider so `[`, `[2` or `[2.1` gets a picker of agenda items (on Tab, and
 * automatically after `[` via `autoOpenOnBracket`). Everything else is delegated unchanged.
 */
export function referenceProvider(getAgenda: () => Agenda | undefined): AutocompleteProviderFactory {
	return (current: AutocompleteProvider): AutocompleteProvider => {
		const ours = async (lines: string[], cursorLine: number, cursorCol: number) => {
			const agenda = getAgenda();
			return agenda ? referenceSuggestions(agenda, (lines[cursorLine] ?? "").slice(0, cursorCol)) : null;
		};
		const wrapped: AutocompleteProvider = {
			getSuggestions: async (lines, cursorLine, cursorCol, signal) =>
				(await ours(lines, cursorLine, cursorCol)) ?? current.getSuggestions(lines, cursorLine, cursorCol, signal),
			getForceFileSuggestions: async (lines, cursorLine, cursorCol, signal) => {
				const found = await ours(lines, cursorLine, cursorCol);
				if (found) return found;
				// A `[…` token is ours even when nothing matches: never turn it into a file lookup.
				if (BRACKET_TOKEN.test((lines[cursorLine] ?? "").slice(0, cursorCol))) return null;
				if (current.getForceFileSuggestions) {
					return current.getForceFileSuggestions(lines, cursorLine, cursorCol, signal);
				}
				// The wrapped provider had no Tab completion: keep the editor's fallback behaviour.
				if (current.shouldTriggerFileCompletion && !current.shouldTriggerFileCompletion(lines, cursorLine, cursorCol)) {
					return null;
				}
				return current.getSuggestions(lines, cursorLine, cursorCol, signal);
			},
			applyCompletion: (lines, cursorLine, cursorCol, item, prefix) => {
				if (!REFERENCE_PREFIX.test(prefix) || !/^\[[\d.]+\]$/.test(item.value)) {
					return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
				}
				const line = lines[cursorLine] ?? "";
				const before = line.slice(0, cursorCol - prefix.length);
				// Drop a closing bracket the user already typed after the cursor.
				const after = line.slice(cursorCol).replace(/^[\d.]*\]/, "");
				const next = [...lines];
				next[cursorLine] = before + item.value + after;
				return { lines: next, cursorLine, cursorCol: before.length + item.value.length };
			},
		};
		if (current.getInlineHint) wrapped.getInlineHint = current.getInlineHint.bind(current);
		if (current.trySyncSlashCompletion) wrapped.trySyncSlashCompletion = current.trySyncSlashCompletion.bind(current);
		if (current.trySyncInlineReplace) wrapped.trySyncInlineReplace = current.trySyncInlineReplace.bind(current);
		if (current.shouldTriggerFileCompletion) {
			const should = current.shouldTriggerFileCompletion.bind(current);
			wrapped.shouldTriggerFileCompletion = (lines, cursorLine, cursorCol) =>
				REFERENCE_PREFIX.test((lines[cursorLine] ?? "").slice(0, cursorCol)) || should(lines, cursorLine, cursorCol);
		}
		return wrapped;
	};
}

/** A token that starts with `[` at the end of the text before the cursor. */
const BRACKET_TOKEN = /(?:^|[\s(])\[\S*$/;

/**
 * The editor opens suggestion lists by itself only for its own trigger characters. This listens for
 * a typed `[`, and when it landed at the start of a word in the prompt, sends the editor a Tab so the
 * reference picker opens as if the user had pressed it. Returns the terminal-input handler.
 */
export function autoOpenOnBracket(options: {
	hasAgenda: () => boolean;
	getEditorText: () => string;
	/** Feeds keys through the normal input pipeline; undefined until the TUI is known. */
	sendKey: () => ((data: string) => void) | undefined;
}): (data: string) => undefined {
	return data => {
		if (data !== "[" || !options.hasAgenda()) return;
		const send = options.sendKey();
		if (!send) return;
		const before = options.getEditorText();
		// The editor handles the key right after the listeners; check what it did afterwards.
		queueMicrotask(() => {
			const after = options.getEditorText();
			// Exactly one `[` inserted means the prompt had focus (not an overlay or dialog).
			if (after.length !== before.length + 1) return;
			let at = 0;
			while (at < before.length && before[at] === after[at]) at++;
			if (after[at] !== "[" || !BRACKET_TOKEN.test(after.slice(0, at + 1))) return;
			send("\t");
		});
	};
}
