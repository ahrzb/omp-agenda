import { beforeAll, describe, expect, test } from "bun:test";
import { getMarkdownTheme, initThemeSync, theme } from "@oh-my-pi/pi-tui/theme";
import { applyOps } from "../src/model.ts";
import { AgendaViewer, AgendaWidget, agendaMarkdownTheme } from "../src/view.ts";

beforeAll(() => initThemeSync());

const TAB = "\t";
const SHIFT_TAB = "\x1b[Z";

function open(focus: string, rows = 40) {
	const agenda = applyOps(undefined, [
		{
			op: "set",
			title: "Auth",
			items: [
				{ title: "Storage", status: "decided", decision: "DB", details: "Storage notes" },
				{
					title: "Refresh",
					details: "Refresh notes",
					items: [{ title: "Rotation", details: "Rotation notes" }, { title: "Revocation" }],
				},
				{ title: "SSO" },
			],
		},
		{ op: "focus", id: focus },
	])!;
	const viewer = new AgendaViewer(agenda, { terminal: { rows }, requestRender() {} } as never, theme, getMarkdownTheme(), () => {});
	const screen = () => viewer.render(80).map(line => Bun.stripANSI(line).trimEnd());
	const body = () => screen().slice(2, -1).filter(Boolean);
	const cursor = () => body().find(line => line.startsWith("›"));
	const press = (...keys: string[]) => {
		screen();
		for (const key of keys) {
			viewer.handleInput(key);
			screen();
		}
	};
	return { screen, body, cursor, press };
}

test("opens collapsed except the current item, with the cursor on it", () => {
	const view = open("2.1");
	const text = view.body().join("\n");
	expect(view.cursor()).toContain("2.1 Rotation");
	expect(text).toContain("Rotation notes");
	// Other topics fold to their heading with the hidden marker; the parent shows only sub-item headings.
	expect(view.body()[0]).toMatch(/▸ ● 1 Storage → DB …$/);
	expect(text).not.toContain("Storage notes");
	expect(text).not.toContain("Refresh notes");
	expect(text).toMatch(/▾ ○ 2 Refresh · 0\/2 …/);
	expect(text).toContain("2.2 Revocation");
	expect(text).toContain("3 SSO");
});

test("opens scrolled so the current topic is visible", () => {
	const view = open("3", 5);
	expect(view.cursor()).toContain("3 SSO");
});

test("opening on a sub-item keeps its parent heading in view", () => {
	const view = open("2.1", 5);
	const lines = view.body();
	expect(lines.findIndex(line => line.includes("2 Refresh"))).toBeLessThan(lines.findIndex(line => line.startsWith("›")));
});

test("when the parent heading is scrolled off, the divider names it", () => {
	const view = open("2.1", 5);
	view.press(" ");
	expect(view.cursor()).toContain("2.1 Rotation");
	expect(view.body().join("\n")).not.toContain("2 Refresh");
	expect(view.screen()[1]).toMatch(/^── 2 Refresh › ─+$/);
});

test("tab cycles subtree → folded → children → subtree", () => {
	const view = open("2");
	view.press(TAB);
	expect(view.body().join("\n")).not.toContain("Rotation");
	expect(view.cursor()).toContain("▸");

	view.press(TAB);
	const children = view.body().join("\n");
	expect(children).toContain("2.1 Rotation");
	expect(children).not.toContain("Refresh notes");
	expect(children).not.toContain("Rotation notes");
	expect(view.cursor()).toMatch(/…$/);

	view.press(TAB);
	expect(view.body().join("\n")).toContain("Refresh notes");
	expect(view.body().join("\n")).toContain("Rotation notes");
});

test("shift+tab overview hides sub-items and moves the cursor to the visible parent", () => {
	const view = open("2.1");
	view.press(SHIFT_TAB);
	const lines = view.body();
	expect(lines).toHaveLength(3);
	expect(view.cursor()).toContain("2 Refresh");

	view.press(SHIFT_TAB);
	expect(view.body().join("\n")).toContain("2.1 Rotation");
	expect(view.body().join("\n")).not.toContain("notes");

	view.press(SHIFT_TAB);
	expect(view.body().join("\n")).toContain("Rotation notes");
});

test("heading motion: next, sibling, parent", () => {
	const view = open("1");
	view.press(SHIFT_TAB, SHIFT_TAB); // contents: every heading visible
	view.press("n");
	expect(view.cursor()).toContain("2 Refresh");
	view.press("n");
	expect(view.cursor()).toContain("2.1 Rotation");
	view.press("f");
	expect(view.cursor()).toContain("2.2 Revocation");
	view.press("f");
	expect(view.cursor()).toContain("2.2 Revocation");
	view.press("u");
	expect(view.cursor()).toContain("2 Refresh");
	view.press("f");
	expect(view.cursor()).toContain("3 SSO");
	view.press("b", "b");
	expect(view.cursor()).toContain("1 Storage");
});

test("collapsed line: closed topics hidden, current topic on a chip with its sub-item dots, then its name", () => {
	const agenda = applyOps(undefined, [
		{
			op: "set",
			title: "Auth",
			items: [
				{ title: "Storage", status: "decided", items: [{ title: "Engine" }] },
				{ title: "Refresh", items: [{ title: "Rotation", status: "decided" }, { title: "Revocation" }] },
				{ title: "SSO", status: "parked" },
				{ title: "Legacy", status: "dropped" },
			],
		},
		{ op: "focus", id: "2.2" },
	])!;
	const tui = { terminal: { rows: 40 } } as never;
	const raw = new AgendaWidget(agenda, false, tui, theme, getMarkdownTheme()).render(100)[0]!;
	const line = Bun.stripANSI(raw);
	expect(line).toMatch(/ ○2·●○  ◌3  Refresh › 2\.2 Revocation/);
	expect(line).not.toMatch(/[●✕][14]/);
	expect(line).toContain("2/4");
	expect(raw).toContain(theme.bg("selectedBg", "\x01").split("\x01")[0]!);
});

test("collapsed line says all done once nothing is open, and counts what is still parked", () => {
	const tui = { terminal: { rows: 40 } } as never;
	const line = (items: Parameters<typeof applyOps>[1][number]["items"]) =>
		Bun.stripANSI(
			new AgendaWidget(applyOps(undefined, [{ op: "set", title: "Auth", items }])!, false, tui, theme, getMarkdownTheme()).render(100)[0]!,
		);
	expect(line([{ title: "A", status: "decided" }, { title: "B", status: "dropped" }])).toMatch(/Auth {2}✓ all done +2\/2/);
	expect(line([{ title: "A", status: "decided" }, { title: "B", status: "parked" }])).toContain("✓ all done · 1 parked");
	// An open sub-item under a decided topic still counts as unfinished.
	expect(line([{ title: "A", status: "decided", items: [{ title: "A1" }] }])).not.toContain("all done");
});

test("full screen: a folded heading containing the current item names it", () => {
	const view = open("2.1");
	view.press(SHIFT_TAB);
	const [storage, refresh] = view.body();
	expect(refresh).toMatch(/2 Refresh · 0\/2 … · current 2\.1$/);
	expect(storage).not.toContain("current");
});

describe("partial view: break line and line cap", () => {
	const tui = { terminal: { rows: 60 }, requestRender() {} } as never;
	const expanded = (details: string, rotation = "Rotation gist\n\n<!-- more -->\n\nRotation chart") => {
		const agenda = applyOps(undefined, [
			{
				op: "set",
				title: "Auth",
				items: [{ title: "Refresh", details, items: [{ title: "Rotation", details: rotation }, { title: "Revocation" }] }],
			},
			{ op: "focus", id: "1.1" },
		])!;
		return new AgendaWidget(agenda, true, tui, theme, getMarkdownTheme())
			.render(100)
			.slice(1)
			.map(line => Bun.stripANSI(line).trim());
	};

	test("shows the text above the break line and marks the hidden rest", () => {
		expect(expanded("Refresh gist\n<!-- more -->\nRefresh table")).toEqual([
			"▌  ○ 1 Refresh · 0/2 …",
			"▌    Refresh gist",
			"▌    ├─ ○ 1.1 Rotation …",
			"▌    │  Rotation gist",
			"▌    └─ ○ 1.2 Revocation",
			"▌  … more in full view · alt+shift+g",
		]);
	});

	test("short details without a break line show in full, unmarked", () => {
		const body = expanded("Just a gist", "Short");
		expect(body[0]).toBe("▌  ○ 1 Refresh · 0/2");
		expect(body).toContain("▌    Just a gist");
		expect(body.at(-1)).not.toContain("more in full view");
	});

	test("long details are capped at a block boundary within the line limit", () => {
		const paragraphs = Array.from({ length: 6 }, (_, index) => `Paragraph ${index + 1}`).join("\n\n");
		const body = expanded(paragraphs, "Short");
		const shown = body.filter(line => /Paragraph \d/.test(line));
		expect(shown.length).toBeGreaterThan(0);
		expect(shown.length).toBeLessThan(6);
		expect(shown.at(-1)).toBe(`▌    Paragraph ${shown.length}`);
		expect(body[0]).toMatch(/…$/);
	});

	test("full-screen view shows everything, without the break line", () => {
		const agenda = applyOps(undefined, [
			{ op: "set", title: "Auth", items: [{ title: "Refresh", details: "Refresh gist\n<!-- more -->\nRefresh table" }] },
		])!;
		const text = new AgendaViewer(agenda, tui, theme, getMarkdownTheme(), () => {})
			.render(100)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(text).toMatch(/Refresh gist[\s\S]*Refresh table/);
		expect(text).not.toContain("more -->");
	});
});

test("full screen marks folded headings that hide content, but not empty ones", () => {
	const view = open("1");
	view.press(SHIFT_TAB);
	const [storage, refresh, sso] = view.body();
	expect(storage).toMatch(/Storage → DB …$/);
	expect(refresh).toMatch(/Refresh · 0\/2 …$/);
	expect(sso).not.toContain("…");
});

test("code blocks: tagged fences keep syntax colors, untagged ones get the code-block color", () => {
	const md = agendaMarkdownTheme(getMarkdownTheme(), theme);
	const agenda = applyOps(undefined, [
		{ op: "set", title: "T", items: [{ title: "Code", details: "```ts\nconst delay = 1;\n```\n\n```\nplain output\n```" }] },
	])!;
	const lines = new AgendaViewer(agenda, { terminal: { rows: 30 }, requestRender() {} } as never, theme, md, () => {}).render(80);
	const ts = lines.find(line => line.includes("delay"))!;
	const plain = lines.find(line => line.includes("plain output"))!;
	// Several distinct foreground colors on the ts line: keyword, identifier, number.
	expect(new Set(ts.match(/\x1b\[38;[0-9;]+m/g)).size).toBeGreaterThan(2);
	expect(plain).toContain(theme.fg("mdCodeBlock", "plain output"));
});

test("d toggles a decisions-only page: decided items one line each, parked and dropped left out", () => {
	const agenda = applyOps(undefined, [
		{
			op: "set",
			title: "Auth",
			items: [
				{ title: "Storage", status: "decided", decision: "DB" },
				{ title: "Refresh", items: [{ title: "Rotation", status: "decided", decision: "every use" }, { title: "Revocation" }] },
				{ title: "SSO", status: "parked" },
				{ title: "Legacy", status: "dropped" },
			],
		},
	])!;
	const viewer = new AgendaViewer(agenda, { terminal: { rows: 20 }, requestRender() {} } as never, theme, getMarkdownTheme(), () => {});
	const screen = () => viewer.render(80).map(line => Bun.stripANSI(line).trimEnd());
	screen();
	viewer.handleInput("d");
	const page = screen();
	expect(page[0]).toMatch(/Auth · decisions +2 decided$/);
	expect(page.slice(2, -1).filter(Boolean)).toEqual(["  ● 1      Storage → DB", "  ●   2.1  Rotation → every use"]);
	viewer.handleInput("d");
	expect(screen().join("\n")).toContain("◌ 3 SSO");
});

test("more than 7 open topics: the pinned line shows a window around the current one and counts the rest", () => {
	const tui = { terminal: { rows: 40 } } as never;
	const items = Array.from({ length: 12 }, (_, index) => ({ title: `T${index + 1}` }));
	const line = (focus: string) => {
		const agenda = applyOps(undefined, [{ op: "set", title: "Big", items }, { op: "focus", id: focus }])!;
		return Bun.stripANSI(new AgendaWidget(agenda, false, tui, theme, getMarkdownTheme()).render(140)[0]!);
	};
	expect(line("1")).toMatch(/ ○1  ○2 ○3 ○4 ○5 ○6 ○7 › \+5  T1 /);
	expect(line("6")).toMatch(/\+2 ‹ ○3 ○4 ○5  ○6  ○7 ○8 ○9 › \+3  T6 /);
	expect(line("12")).toMatch(/\+5 ‹ ○6 ○7 ○8 ○9 ○10 ○11  ○12 {3}T12 /);
});
