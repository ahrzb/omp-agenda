import type { Agenda } from "./model.ts";

/** One saved `omp-agenda.state` entry on the session branch, oldest first. `null` means cleared. */
export interface SavedState {
	timestamp: string;
	agenda: Agenda | null;
}

export interface PastAgenda {
	/** Identity of the agenda: its `created` stamp, or for older saves the time of its first entry. */
	key: number;
	/** Its latest saved version. */
	agenda: Agenda;
	/** When that version was saved (ms). */
	changed: number;
	/** Whether it is the agenda pinned right now. */
	current: boolean;
}

/**
 * Every distinct agenda on the branch, newest change first. Versions of one agenda share its
 * `created` stamp. Saves from before the stamp existed are grouped by consecutive entries with the
 * same title, split where the agenda was cleared or replaced.
 */
export function agendaHistory(states: readonly SavedState[]): PastAgenda[] {
	const byKey = new Map<number, PastAgenda>();
	let legacy: { key: number; title: string } | undefined;
	let last: number | undefined;
	for (const { timestamp, agenda } of states) {
		const at = Date.parse(timestamp);
		if (!agenda) {
			legacy = undefined;
			last = undefined;
			continue;
		}
		let key = agenda.created;
		if (key === undefined) {
			if (legacy?.title !== agenda.title) legacy = { key: at, title: agenda.title };
			key = legacy.key;
		} else {
			legacy = undefined;
		}
		byKey.set(key, { key, agenda, changed: at, current: false });
		last = key;
	}
	if (last !== undefined) byKey.get(last)!.current = true;
	return [...byKey.values()].sort((a, b) => b.changed - a.changed);
}
