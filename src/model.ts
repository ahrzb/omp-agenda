export const STATUSES = ["open", "decided", "parked", "dropped"] as const;
export type Status = (typeof STATUSES)[number];

export interface Item {
	/** Stable dotted id ("2", "2.1"). Never reused within an agenda, so "point 2" keeps its meaning. */
	id: string;
	title: string;
	status: Status;
	/** One-line outcome, shown next to the title. */
	decision?: string;
	/** Markdown body. A `<!-- more -->` line ends the part shown when the pinned agenda is expanded. */
	details?: string;
	items: Item[];
	/** Next child number to allocate. */
	next: number;
}

export interface Agenda {
	title: string;
	items: Item[];
	next: number;
	/** Id of the topic under discussion. */
	focus?: string;
	/** When `set` created this agenda (ms). Edits keep it, so history can group an agenda's versions. */
	created?: number;
}

export interface ItemInput {
	title: string;
	status?: Status;
	decision?: string;
	details?: string;
	items?: ItemInput[];
}

export interface Op {
	op: "set" | "add" | "update" | "remove" | "focus" | "clear";
	id?: string;
	parent?: string;
	title?: string;
	status?: Status;
	decision?: string;
	details?: string;
	items?: ItemInput[];
}

export class AgendaError extends Error {}

/** Apply ops atomically: either all succeed and the new agenda is returned, or an AgendaError is thrown. */
export function applyOps(current: Agenda | undefined, ops: readonly Op[]): Agenda | undefined {
	let agenda = current ? structuredClone(current) : undefined;
	ops.forEach((op, index) => {
		try {
			agenda = applyOp(agenda, op);
		} catch (error) {
			if (error instanceof AgendaError && ops.length > 1) {
				throw new AgendaError(`ops[${index}] (${op.op}): ${error.message}`);
			}
			throw error;
		}
	});
	return agenda;
}

function applyOp(agenda: Agenda | undefined, op: Op): Agenda | undefined {
	switch (op.op) {
		case "clear":
			return undefined;
		case "set": {
			const title = required(op.title, "title");
			const next: Agenda = { title, items: [], next: 1, created: Date.now() };
			for (const input of op.items ?? []) next.items.push(createItem(input, "", next));
			next.focus = next.items.find(item => item.status === "open")?.id;
			return next;
		}
	}
	if (!agenda) throw new AgendaError("no agenda yet; start one with op=set");
	switch (op.op) {
		case "add": {
			const input: ItemInput = {
				title: required(op.title, "title"),
				status: op.status,
				decision: op.decision,
				details: op.details,
				items: op.items,
			};
			if (op.parent === undefined) {
				agenda.items.push(createItem(input, "", agenda));
			} else {
				const parent = find(agenda, op.parent).item;
				parent.items.push(createItem(input, `${parent.id}.`, parent));
			}
			return agenda;
		}
		case "update": {
			const { item } = find(agenda, required(op.id, "id"));
			if (op.title !== undefined) item.title = required(op.title, "title");
			if (op.status !== undefined) item.status = op.status;
			if (op.decision !== undefined) setOptional(item, "decision", op.decision);
			if (op.details !== undefined) setOptional(item, "details", op.details);
			return agenda;
		}
		case "remove": {
			const id = required(op.id, "id");
			const { siblings, index } = find(agenda, id);
			siblings.splice(index, 1);
			if (agenda.focus !== undefined && isWithin(agenda.focus, id)) agenda.focus = undefined;
			return agenda;
		}
		case "focus": {
			agenda.focus = find(agenda, required(op.id, "id")).item.id;
			return agenda;
		}
	}
}

function required(value: string | undefined, field: string): string {
	const trimmed = value?.trim();
	if (!trimmed) throw new AgendaError(`${field} is required`);
	return trimmed;
}

/** Empty string clears an optional text field. */
function setOptional(item: Item, key: "decision" | "details", value: string): void {
	const trimmed = value.trim();
	if (trimmed) item[key] = trimmed;
	else delete item[key];
}

function createItem(input: ItemInput, prefix: string, owner: { next: number }): Item {
	const id = `${prefix}${owner.next++}`;
	const item: Item = { id, title: required(input.title, "title"), status: input.status ?? "open", items: [], next: 1 };
	if (input.decision?.trim()) item.decision = input.decision.trim();
	if (input.details?.trim()) item.details = input.details.trim();
	for (const child of input.items ?? []) item.items.push(createItem(child, `${id}.`, item));
	return item;
}

/** Whether `id` is `ancestor` or one of its descendants (dotted-id prefix, not string prefix). */
export function isWithin(id: string, ancestor: string): boolean {
	return id === ancestor || id.startsWith(`${ancestor}.`);
}

interface Located {
	item: Item;
	siblings: Item[];
	index: number;
	/** Ancestors from the top level down, excluding the item. */
	path: Item[];
}

export function find(agenda: Agenda, id: string): Located {
	const found = locate(agenda.items, id.trim(), []);
	if (!found) throw new AgendaError(`no item with id "${id}"`);
	return found;
}

function locate(items: Item[], id: string, path: Item[]): Located | undefined {
	for (let index = 0; index < items.length; index++) {
		const item = items[index]!;
		if (item.id === id) return { item, siblings: items, index, path };
		if (isWithin(id, item.id)) return locate(item.items, id, [...path, item]);
	}
	return undefined;
}

export function isClosed(item: Item): boolean {
	return item.status === "decided" || item.status === "dropped";
}

export function progress(items: readonly Item[]): { closed: number; total: number } {
	return { closed: items.filter(isClosed).length, total: items.length };
}

/** Nothing left open anywhere: every item is decided, dropped or parked. */
export function isSettled(agenda: Agenda): boolean {
	const anyOpen = (items: readonly Item[]): boolean =>
		items.some(item => item.status === "open" || anyOpen(item.items));
	return agenda.items.length > 0 && !anyOpen(agenda.items);
}

/** The break line the model places in `details`: above it is the partial view, the rest is full-screen only. */
export const MORE_MARKER = "<!-- more -->";
const MORE_LINE = /^[ \t]*<!--\s*more\s*-->[ \t]*$/im;

/** Split `details` at the first break line. `full` is the whole text without the break line. */
export function splitDetails(details: string): { partial: string; full: string; marked: boolean } {
	const match = MORE_LINE.exec(details);
	if (!match) return { partial: details, full: details, marked: false };
	const before = details.slice(0, match.index).trimEnd();
	const after = details.slice(match.index + match[0].length).trimStart();
	return { partial: before, full: [before, after].filter(Boolean).join("\n\n"), marked: true };
}

/** Markdown rendering for the model: ids, statuses, decisions and (optionally) details. */
export function toMarkdown(agenda: Agenda, options: { details: boolean }): string {
	const lines = [`# Agenda: ${agenda.title}`];
	if (agenda.focus !== undefined) {
		const { item } = find(agenda, agenda.focus);
		lines.push(`Current topic: ${item.id} ${item.title}`);
	}
	lines.push("");
	if (agenda.items.length === 0) lines.push("(no items)");
	const walk = (items: Item[], depth: number) => {
		const indent = "  ".repeat(depth);
		for (const item of items) {
			let line = `${indent}- [${item.status}] ${item.id} ${item.title}`;
			if (item.decision) line += ` — decision: ${item.decision}`;
			if (item.id === agenda.focus) line += "  ← current";
			lines.push(line);
			const text = options.details ? item.details : undefined;
			if (text) {
				for (const line of text.split("\n")) lines.push(line ? `${indent}  ${line}` : "");
			}
			walk(item.items, depth + 1);
		}
	};
	walk(agenda.items, 0);
	return lines.join("\n");
}
