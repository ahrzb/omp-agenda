import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { Container, Text, type TUI } from "@oh-my-pi/pi-tui";
import {
	type Agenda,
	AgendaError,
	applyOps,
	isSettled,
	MORE_MARKER,
	progress,
	type Op,
	STATUSES,
	toMarkdown,
} from "./model.ts";
import {
	AgendaViewer,
	AgendaWidget,
	agendaMarkdownTheme,
	EXPAND_KEY,
	FULLSCREEN_KEY,
	PARTIAL_MAX_LINES,
} from "./view.ts";
import { agendaHistory, type SavedState } from "./history.ts";
import { autoOpenOnBracket, commandArgumentCompletions, referenceProvider } from "./references.ts";

const ENTRY_TYPE = "omp-agenda.state";
const WIDGET_KEY = "omp-agenda";

interface AgendaEntry {
	agenda: Agenda | null;
}

const TOOL_DESCRIPTION = `Keep a discussion agenda pinned at the bottom of the user's screen. It exists to help the user follow and engage with a complex discussion: what is being decided, where the conversation is right now, and what has been settled. Topics can have sub-items, a status (${STATUSES.join(" | ")}), a one-line decision, and markdown \`details\` (text, tables, mermaid diagrams, code). Tag every code fence with its language (\`\`\`ts, \`\`\`sql, \`\`\`bash) so it gets syntax highlighting. The current agenda is included in your system prompt on every turn.

When the user expands the pinned agenda they see only the start of the current topic's details, so write details in two parts: first the main points (2-4 lines of plain prose or bullets: the question, the options, your lean), then a line containing only \`${MORE_MARKER}\`, then everything bulky (tables, mermaid diagrams, long background). Below that line only appears in the full-screen view. Without the line, or if the part above it is long, the expanded view shows the first ${PARTIAL_MAX_LINES} rendered lines. Shape (for an unrelated topic): "Redis is faster to adopt; Postgres LISTEN avoids a new service.\\n- Lean: Postgres until load says otherwise\\n${MORE_MARKER}\\n| | Redis | Postgres |\\n|---|---|---|\\n…".

Only start an agenda when the user asks for one ("pin this", "make an agenda", "track these points"); don't create one on your own. New topics start open. Whenever the user agrees to an option, even in passing alongside other requests, mark that topic status=decided with a one-line \`decision\` in the same call. Keep \`focus\` on the topic under discussion and add sub-items or details as they come up. When nothing is left open the pinned line shows "all done"; remove the agenda with op=clear once the discussion has moved on, when it no longer helps, or when the user asks. Ids are stable dotted numbers ("2", "2.1") and are never reused. In chat, both you and the user refer to items in square brackets: [2.1].

\`ops\` apply in order, all or nothing. \`set\` replaces the whole agenda (topics may carry one level of sub-items); \`add\` appends a topic, or a sub-item under \`parent\`; \`update\` changes fields, and an empty string clears decision or details. Replaced and cleared agendas are not lost: the user can pin an earlier one again with \`/agenda history\`.`;

const SYSTEM_PROMPT_PREAMBLE = `The user keeps the following discussion agenda pinned on screen. Treat it as the shared record of this discussion: keep it accurate with the \`agenda\` tool (focus, decisions, new sub-items) as the conversation moves. The user refers to items in square brackets, like [2.1]; write references the same way.`;

const SETTLED_NOTE = `Nothing on the agenda is open any more; the pinned line shows "all done". If the user's message is about something other than this discussion, first call the agenda tool with op=clear, then answer. If the discussion continues, reopen or add topics instead.`;

export default function agendaExtension(pi: ExtensionAPI): void {
	const z = pi.zod;
	let agenda: Agenda | undefined;
	let expanded = false;
	/** The TUI, captured when the widget mounts; used to open the reference picker after `[`. */
	let tui: TUI | undefined;

	const refresh = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (!agenda) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		const snapshot = agenda;
		const isExpanded = expanded;
		ctx.ui.setWidget(
			WIDGET_KEY,
			(widgetTui, theme) => {
				tui = widgetTui;
				return new AgendaWidget(
					snapshot,
					isExpanded,
					widgetTui,
					theme,
					agendaMarkdownTheme(pi.pi.getMarkdownTheme(), theme),
				);
			},
		);
	};

	const commit = (next: Agenda | undefined, ctx: ExtensionContext) => {
		agenda = next;
		pi.appendEntry<AgendaEntry>(ENTRY_TYPE, { agenda: next ?? null });
		refresh(ctx);
	};

	const savedStates = (ctx: ExtensionContext): SavedState[] => {
		const states: SavedState[] = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
				states.push({ timestamp: entry.timestamp, agenda: (entry.data as AgendaEntry | undefined)?.agenda ?? null });
			}
		}
		return states;
	};

	const restore = (_event: unknown, ctx: ExtensionContext) => {
		agenda = savedStates(ctx).at(-1)?.agenda ?? undefined;
		refresh(ctx);
	};

	const showHistory = async (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const past = agendaHistory(savedStates(ctx));
		if (past.length === 0 || (past.length === 1 && past[0]!.current)) {
			ctx.ui.notify("No earlier agendas on this branch", "info");
			return;
		}
		const options = past.map((entry, index) => {
			const { closed, total } = progress(entry.agenda.items);
			const parts = [`${total} topics`, `${closed}/${total} closed`, formatWhen(entry.changed)];
			if (entry.current) parts.push("pinned now");
			return { label: `${index + 1}  ${entry.agenda.title}`, description: parts.join(" · ") };
		});
		const picked = await ctx.ui.select("Agenda history: pick one to pin again", options);
		const entry = past[options.findIndex(option => option.label === picked)];
		if (!entry || entry.current) return;
		// Keep its identity so the restored copy and its old versions stay one entry in the list.
		commit({ ...structuredClone(entry.agenda), created: entry.key }, ctx);
		ctx.ui.notify(`Pinned "${entry.agenda.title}" again`, "info");
	};
	let pickerRegistered = false;
	pi.on("session_start", (event, ctx) => {
		// `[`, `[2` or `[2.1` in the prompt gets a picker of agenda items: on Tab, and on its own after `[`.
		if (ctx.hasUI && ctx.mode === "tui" && !pickerRegistered) {
			pickerRegistered = true;
			ctx.ui.addAutocompleteProvider(referenceProvider(() => agenda));
			ctx.ui.onTerminalInput(
				autoOpenOnBracket({
					hasAgenda: () => agenda !== undefined,
					getEditorText: () => ctx.ui.getEditorText(),
					// injectDebugInput feeds the same pipeline as stdin; it is the only public way to press a key.
					sendKey: () => (tui && typeof tui.injectDebugInput === "function" ? data => tui?.injectDebugInput(data) : undefined),
				}),
			);
		}
		restore(event, ctx);
	});
	pi.on("session_switch", restore);
	pi.on("session_branch", restore);
	pi.on("session_tree", restore);

	pi.on("before_agent_start", event => {
		if (!agenda) return;
		return {
			systemPrompt: [
				...event.systemPrompt,
				[SYSTEM_PROMPT_PREAMBLE, isSettled(agenda) ? SETTLED_NOTE : "", toMarkdown(agenda, { details: true })]
					.filter(Boolean)
					.join("\n\n"),
			],
		};
	});

	const openViewer = async (ctx: ExtensionContext) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		const snapshot = agenda;
		if (!snapshot) {
			ctx.ui.notify("No agenda yet", "info");
			return;
		}
		await ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) =>
				new AgendaViewer(snapshot, tui, theme, agendaMarkdownTheme(pi.pi.getMarkdownTheme(), theme), () => done()),
			{ overlay: true },
		);
	};

	pi.registerShortcut(EXPAND_KEY, {
		description: "Agenda: show/hide the current topic's main points",
		handler: ctx => {
			if (!agenda) return;
			expanded = !expanded;
			refresh(ctx);
		},
	});
	pi.registerShortcut(FULLSCREEN_KEY, {
		description: "Agenda: full-screen view of every topic",
		handler: openViewer,
	});

	pi.registerCommand("agenda", {
		description: "Show the agenda full screen; `/agenda focus <id>`, `/agenda history`, `/agenda clear`",
		getArgumentCompletions: prefix => commandArgumentCompletions(agenda, prefix),
		handler: async (args, ctx) => {
			const [command, ...rest] = args.trim().split(/\s+/);
			if (!command) return openViewer(ctx);
			if (command === "history") return showHistory(ctx);
			if (command === "clear") {
				if (agenda) commit(undefined, ctx);
				return;
			}
			if (command === "focus" && rest.length === 1) {
				try {
					commit(applyOps(agenda, [{ op: "focus", id: rest[0] }]), ctx);
				} catch (error) {
					if (!(error instanceof AgendaError)) throw error;
					ctx.ui.notify(error.message, "error");
				}
				return;
			}
			ctx.ui.notify("Usage: /agenda | /agenda focus <id> | /agenda history | /agenda clear", "warning");
		},
	});

	const status = z.enum(STATUSES);
	const subItem = z.object({
		title: z.string(),
		status: status.optional(),
		decision: z.string().optional(),
		details: z.string().optional().describe(`Markdown; main points, then a \`${MORE_MARKER}\` line, then the rest`),
	});
	const item = z.object({
		title: z.string(),
		status: status.optional(),
		decision: z.string().optional(),
		details: z.string().optional().describe(`Markdown; main points, then a \`${MORE_MARKER}\` line, then the rest`),
		items: z.array(subItem).optional().describe("Sub-items"),
	});
	const op = z.object({
		op: z.enum(["set", "add", "update", "remove", "focus", "clear"]),
		id: z.string().optional().describe("Target item id (update, remove, focus)"),
		parent: z.string().optional().describe("Parent id for add; omit for a top-level topic"),
		title: z.string().optional().describe("Agenda title for set; item title for add/update"),
		status: status.optional(),
		decision: z.string().optional().describe("One-line outcome"),
		details: z
			.string()
			.optional()
			.describe(`Markdown; main points, then a \`${MORE_MARKER}\` line, then tables/diagrams/long text`),
		items: z.array(item).optional().describe("Topics for set; sub-items for add"),
	});

	pi.registerTool({
		name: "agenda",
		label: "Agenda",
		description: TOOL_DESCRIPTION,
		// Discoverable: agendas are created only on request, so the description stays out of sessions that never use one.
		loadMode: "discoverable",
		approval: "read",
		parameters: z.object({ ops: z.array(op).describe("Operations, applied in order") }),
		async execute(_toolCallId, params: { ops: Op[] }, _signal, _onUpdate, ctx) {
			const { ops } = params;
			if (ops.length === 0) {
				return { content: [{ type: "text", text: "ops is empty" }], isError: true };
			}
			let next: Agenda | undefined;
			try {
				next = applyOps(agenda, ops);
			} catch (error) {
				if (!(error instanceof AgendaError)) throw error;
				return { content: [{ type: "text", text: error.message }], isError: true };
			}
			commit(next, ctx);
			let text = next ? toMarkdown(next, { details: false }) : "Agenda cleared.";
			if (next && isSettled(next)) text += `\n\n${SETTLED_NOTE}`;
			return { content: [{ type: "text", text }] };
		},
		renderCall(args: { ops?: Partial<Op>[] } | undefined, _options, theme) {
			const ops = args?.ops ?? [];
			const summary = ops.map(describeOp).join(theme.fg("dim", ", "));
			return new Text(`${theme.fg("toolTitle", theme.bold("agenda"))} ${theme.fg("muted", summary)}`, 0, 0);
		},
		renderResult(result, options, theme) {
			const text = result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
			if (result.isError) return new Text(theme.fg("error", text), 0, 0);
			if (options.expanded) return new Text(theme.fg("toolOutput", text), 0, 0);
			return new Container();
		},
	});
}

function describeOp(op: Partial<Op>): string {
	switch (op.op) {
		case "set":
			return `set "${op.title ?? ""}" (${op.items?.length ?? 0} topics)`;
		case "add":
			return `add "${op.title ?? ""}"${op.parent ? ` under ${op.parent}` : ""}`;
		case "update": {
			let text = `update ${op.id ?? ""}`;
			if (op.status) text += ` ${op.status}`;
			if (op.decision) text += ` → ${op.decision}`;
			return text;
		}
		case "remove":
		case "focus":
			return `${op.op} ${op.id ?? ""}`;
		case "clear":
			return "clear";
		default:
			return "…";
	}
}

/** `14:05` for today, otherwise `Sep 25 14:05`. */
function formatWhen(ms: number): string {
	const date = new Date(ms);
	const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	if (date.toDateString() === new Date().toDateString()) return time;
	return `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}
