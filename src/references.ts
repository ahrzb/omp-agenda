import type { AutocompleteProviderFactory } from "@oh-my-pi/pi-coding-agent";
import type {
	AutocompleteItem,
	AutocompleteProvider,
	ModelMentionCompletion,
} from "@oh-my-pi/pi-coding-agent/autocomplete/autocomplete";
import { type Agenda, type Item, isClosed } from "./model.ts";

/** An agenda reference being typed: `[`, `[2`, `[2.1` at the end of a token. */
const REFERENCE_PREFIX = /(?:^|[\s(])(\[[\d.]*)$/;

const GLYPH: Record<Item["status"], string> = { open: "○", decided: "●", parked: "◌", dropped: "✕" };

/**
 * Items whose id starts with `typed`: the current item first (so it is preselected), then open and
 * parked items, then closed ones, each in document order.
 */
function matchingItems(agenda: Agenda, typed: string): Item[] {
	const all: Item[] = [];
	const walk = (items: readonly Item[]) => {
		for (const item of items) {
			all.push(item);
			walk(item.items);
		}
	};
	walk(agenda.items);
	const rank = (item: Item) => (item.id === agenda.focus ? 0 : isClosed(item) ? 2 : 1);
	return all.filter(item => item.id.startsWith(typed)).sort((a, b) => rank(a) - rank(b));
}

function itemChoice(agenda: Agenda, item: Item, value: string): AutocompleteItem {
	return {
		value,
		label: `[${item.id}] ${item.title}`,
		icon: GLYPH[item.status],
		description: item.id === agenda.focus ? "current" : (item.decision ?? item.status),
	};
}

/** Picker items for a partially typed `[id` reference at the end of `textBeforeCursor`. */
export function referenceSuggestions(
	agenda: Agenda,
	textBeforeCursor: string,
): { items: AutocompleteItem[]; prefix: string } | null {
	const prefix = REFERENCE_PREFIX.exec(textBeforeCursor)?.[1];
	if (prefix === undefined) return null;
	const matches = matchingItems(agenda, prefix.slice(1));
	if (matches.length === 0) return null;
	return { prefix, items: matches.map(item => itemChoice(agenda, item, `[${item.id}]`)) };
}

const SUBCOMMANDS = [
	{ name: "focus", description: "change the current topic", needsAgenda: true },
	{ name: "history", description: "pin an earlier agenda again", needsAgenda: false },
	{ name: "clear", description: "drop the agenda", needsAgenda: true },
] as const;

/**
 * Completions for everything typed after `/agenda `: the subcommands, then item ids after `focus `.
 * Values replace the whole argument text.
 */
export function commandArgumentCompletions(agenda: Agenda | undefined, argumentText: string): AutocompleteItem[] | null {
	const focus = /^focus\s+(\S*)$/.exec(argumentText);
	if (focus) {
		if (!agenda) return null;
		const items = matchingItems(agenda, focus[1]!).map(item => itemChoice(agenda, item, `focus ${item.id}`));
		return items.length > 0 ? items : null;
	}
	if (/\s/.test(argumentText)) return null;
	const items = SUBCOMMANDS.filter(command => command.name.startsWith(argumentText) && (agenda || !command.needsAgenda)).map(
		command => ({
			// `focus` keeps a trailing space so the id list follows straight away.
			value: command.name === "focus" ? "focus " : command.name,
			label: command.name,
			description: command.description,
		}),
	);
	return items.length > 0 ? items : null;
}

/**
 * Wraps the editor's provider so `[`, `[2` or `[2.1` gets a picker of agenda items (on Tab).
 * Everything else is delegated unchanged.
 */
export function referenceProvider(getAgenda: () => Agenda | undefined): AutocompleteProviderFactory {
	return (current: AutocompleteProvider): AutocompleteProvider => {
		const ours = async (lines: string[], cursorLine: number, cursorCol: number) => {
			const agenda = getAgenda();
			return agenda ? referenceSuggestions(agenda, (lines[cursorLine] ?? "").slice(0, cursorCol)) : null;
		};
		const wrapped: AutocompleteProvider = {
			getSuggestions: async (lines, cursorLine, cursorCol, signal, onPartial) =>
				(await ours(lines, cursorLine, cursorCol)) ??
				current.getSuggestions(lines, cursorLine, cursorCol, signal, onPartial),
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
		if (current.trySyncModelMentionCompletion) {
			wrapped.trySyncModelMentionCompletion = (lines, cursorLine, cursorCol): ModelMentionCompletion => {
				const agenda = getAgenda();
				if (!agenda || !BRACKET_TOKEN.test((lines[cursorLine] ?? "").slice(0, cursorCol))) {
					return current.trySyncModelMentionCompletion!(lines, cursorLine, cursorCol);
				}
				// A `[…` token is ours: it must not fall through to the model-mention list.
				return { kind: "unhandled" };
			};
		}
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
