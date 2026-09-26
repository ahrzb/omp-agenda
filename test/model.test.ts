import { describe, expect, test } from "bun:test";
import { AgendaError, applyOps, find, toMarkdown } from "../src/model.ts";

const base = () =>
	applyOps(undefined, [
		{
			op: "set",
			title: "Auth rework",
			items: [
				{ title: "Session storage", status: "decided", decision: "DB" },
				{ title: "Token refresh", items: [{ title: "Rotation" }, { title: "Revocation" }] },
				{ title: "SSO rollout" },
			],
		},
	])!;

describe("applyOps", () => {
	test("set numbers topics and sub-items and focuses the first open topic", () => {
		const agenda = base();
		expect(agenda.items.map(item => item.id)).toEqual(["1", "2", "3"]);
		expect(agenda.items[1]!.items.map(item => item.id)).toEqual(["2.1", "2.2"]);
		expect(agenda.focus).toBe("2");
	});

	test("ids stay stable and are never reused after removal", () => {
		const agenda = applyOps(base(), [
			{ op: "remove", id: "2" },
			{ op: "add", title: "Audit log" },
			{ op: "add", title: "Scopes", parent: "3" },
		])!;
		expect(agenda.items.map(item => item.id)).toEqual(["1", "3", "4"]);
		expect(find(agenda, "3.1").item.title).toBe("Scopes");
	});

	test("removing an ancestor of the focused item clears focus", () => {
		const agenda = applyOps(base(), [
			{ op: "focus", id: "2.2" },
			{ op: "remove", id: "2" },
		])!;
		expect(agenda.focus).toBeUndefined();
	});

	test("id prefix does not match a sibling with a longer number", () => {
		const ops = Array.from({ length: 10 }, (_, index) => ({ op: "add" as const, title: `t${index + 4}` }));
		const agenda = applyOps(base(), ops)!;
		expect(() => find(agenda, "1.1")).toThrow(AgendaError);
		expect(find(agenda, "12").item.title).toBe("t12");
	});

	test("a failing op leaves the agenda untouched", () => {
		const before = base();
		const snapshot = structuredClone(before);
		expect(() =>
			applyOps(before, [
				{ op: "update", id: "3", status: "decided" },
				{ op: "update", id: "9", status: "decided" },
			]),
		).toThrow('ops[1] (update): no item with id "9"');
		expect(before).toEqual(snapshot);
	});

	test("an empty string clears decision", () => {
		const agenda = applyOps(base(), [{ op: "update", id: "1", status: "open", decision: "" }])!;
		expect(find(agenda, "1").item).not.toHaveProperty("decision");
	});

	test("ops other than set need an existing agenda", () => {
		expect(() => applyOps(undefined, [{ op: "add", title: "x" }])).toThrow("start one with op=set");
	});
});

test("toMarkdown marks the current topic and includes details only on request", () => {
	const agenda = applyOps(base(), [{ op: "update", id: "2.1", details: "Sliding window\nor fixed?" }])!;
	const withDetails = toMarkdown(agenda, { details: true });
	expect(withDetails).toContain("- [open] 2 Token refresh  ← current");
	expect(withDetails).toContain("    Sliding window\n    or fixed?");
	expect(toMarkdown(agenda, { details: false })).not.toContain("Sliding window");
});
