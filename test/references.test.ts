import { expect, test } from "bun:test";
import type { AutocompleteProvider } from "@oh-my-pi/pi-tui";
import { applyOps } from "../src/model.ts";
import { referenceProvider, referenceSuggestions } from "../src/references.ts";

const agenda = applyOps(undefined, [
	{
		op: "set",
		title: "Auth",
		items: [
			{ title: "Storage", status: "decided", decision: "DB" },
			{ title: "Refresh", items: [{ title: "Rotation" }, { title: "Revocation" }] },
			{ title: "SSO", status: "parked" },
		],
	},
	{ op: "focus", id: "2.2" },
])!;

test("only a bracket followed by digits at the end of a token is a reference", () => {
	expect(referenceSuggestions(agenda, "see [2")?.prefix).toBe("[2");
	expect(referenceSuggestions(agenda, "[")?.prefix).toBe("[");
	expect(referenceSuggestions(agenda, "arr[2")).toBeNull();
	expect(referenceSuggestions(agenda, "see [x")).toBeNull();
	expect(referenceSuggestions(agenda, "see [9")).toBeNull();
});

test("current item first, then open/parked, then closed; filtered by typed id", () => {
	expect(referenceSuggestions(agenda, "[")!.items.map(item => item.value)).toEqual([
		"[2.2]",
		"[2]",
		"[2.1]",
		"[3]",
		"[1]",
	]);
	expect(referenceSuggestions(agenda, "about [2.")!.items.map(item => item.value)).toEqual(["[2.2]", "[2.1]"]);
});

test("picking an item replaces the typed prefix and absorbs a closing bracket", () => {
	const fallback = { applyCompletion: () => ({ lines: ["fallback"], cursorLine: 0, cursorCol: 0 }) };
	const provider = referenceProvider(() => agenda)(fallback as unknown as AutocompleteProvider);
	const item = { value: "[2.1]", label: "[2.1] Rotation" };
	expect(provider.applyCompletion(["see [2 now"], 0, 6, item, "[2")).toEqual({
		lines: ["see [2.1] now"],
		cursorLine: 0,
		cursorCol: 9,
	});
	expect(provider.applyCompletion(["see [2] now"], 0, 6, item, "[2").lines).toEqual(["see [2.1] now"]);
	// Anything that is not an agenda reference goes to the wrapped provider.
	expect(provider.applyCompletion(["@src"], 0, 4, { value: "@src/", label: "src/" }, "@src").lines).toEqual(["fallback"]);
});
