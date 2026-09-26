import { expect, test } from "bun:test";
import { agendaHistory, type SavedState } from "../src/history.ts";
import type { Agenda } from "../src/model.ts";

const agenda = (title: string, created?: number, topics = 1): Agenda => ({
	title,
	items: Array.from({ length: topics }, (_, index) => ({ id: `${index + 1}`, title: "t", status: "open", items: [], next: 1 })),
	next: topics + 1,
	...(created === undefined ? {} : { created }),
});
const at = (minute: number, state: Agenda | null): SavedState => ({
	timestamp: new Date(Date.UTC(2026, 8, 26, 10, minute)).toISOString(),
	agenda: state,
});

test("versions of one agenda collapse to its latest; newest change first; current marked", () => {
	const past = agendaHistory([
		at(0, agenda("Auth", 1, 1)),
		at(1, agenda("Auth", 1, 2)),
		at(2, agenda("Cache", 2)),
		at(3, agenda("Cache", 2, 3)),
	]);
	expect(past.map(entry => [entry.agenda.title, entry.agenda.items.length, entry.current])).toEqual([
		["Cache", 3, true],
		["Auth", 2, false],
	]);
});

test("restoring an old agenda (same created stamp) moves it to the top instead of duplicating it", () => {
	const past = agendaHistory([at(0, agenda("Auth", 1)), at(1, agenda("Cache", 2)), at(2, agenda("Auth", 1))]);
	expect(past.map(entry => [entry.agenda.title, entry.current])).toEqual([
		["Auth", true],
		["Cache", false],
	]);
});

test("a cleared agenda stays in the list, and nothing is current after a clear", () => {
	const past = agendaHistory([at(0, agenda("Auth", 1)), at(1, null)]);
	expect(past).toHaveLength(1);
	expect(past[0]!.current).toBe(false);
});

test("unstamped saves split where the title changes or the agenda was cleared", () => {
	const past = agendaHistory([
		at(0, agenda("Auth")),
		at(1, agenda("Auth", undefined, 2)),
		at(2, agenda("Cache")),
		at(3, null),
		at(4, agenda("Cache")),
	]);
	expect(past.map(entry => [entry.agenda.title, entry.agenda.items.length])).toEqual([
		["Cache", 1],
		["Cache", 1],
		["Auth", 2],
	]);
	// The key is the first entry's time, which is what a restore stamps as `created`.
	expect(past[2]!.key).toBe(Date.parse(at(0, null).timestamp));
});
