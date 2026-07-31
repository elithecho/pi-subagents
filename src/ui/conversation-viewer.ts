/**
 * conversation-viewer.ts — Live conversation overlay for viewing agent sessions.
 *
 * Displays a scrollable, live-updating view of an agent's conversation.
 * Subscribes to session events for real-time streaming updates.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { type Component, Editor, matchesKey, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { extractText } from "../context.js";
import type { AgentRecord } from "../types.js";
import { getLifetimeTotal, getSessionContextPercent } from "../usage.js";
import type { Theme } from "./agent-widget.js";
import { type AgentActivity, buildInvocationTags, describeActivity, formatDuration, formatSessionTokens, getDisplayName, getPromptModeLabel } from "./agent-widget.js";

/** Base lines consumed by chrome: top border + header + header sep + footer sep + footer + bottom border. */
const CHROME_LINES_BASE = 9;
const MIN_VIEWPORT = 3;
/** Height ceiling shared by the overlay's `maxHeight` and the viewer's internal viewport cap. */
export const VIEWPORT_HEIGHT_PCT = 70;

export class ConversationViewer implements Component {
  private scrollOffset = 0;
  private autoScroll = true;
  private unsubscribe: (() => void) | undefined;
  private lastInnerW = 0;
  private closed = false;
  private composer: Editor;
  private sendError: string | undefined;

  constructor(
    private tui: TUI,
    private session: AgentSession | undefined,
    private record: AgentRecord,
    private activity: AgentActivity | undefined,
    private theme: Theme,
    private done: (result: undefined) => void,
    private onStop?: (record: AgentRecord) => boolean,
    private onSend?: (message: string) => number | undefined,
  ) {
    this.composer = new Editor(tui, {
      borderColor: (s: string) => theme.fg("border", s),
      selectList: (theme as any).selectList,
    });
    this.composer.onSubmit = (text) => {
      if (!text.trim()) return;
      const generation = this.onSend?.(text);
      if (generation == null) {
        // Editor clears before invoking onSubmit; restore rejected drafts.
        this.composer.setText(text);
        this.sendError = "Agent is no longer accepting messages.";
      } else {
        this.sendError = undefined;
        this.composer.setText("");
        this.autoScroll = true;
      }
      this.tui.requestRender();
    };
    this.unsubscribe = session?.subscribe(() => {
      if (this.closed) return;
      this.tui.requestRender();
    });
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+b")) {
      this.closed = true;
      this.done(undefined);
      return;
    }

    if (matchesKey(data, "ctrl+x") && this.canStop()) {
      this.onStop?.(this.record);
      this.tui.requestRender();
      return;
    }

    const totalLines = this.buildContentLines(this.lastInnerW).length;
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, totalLines - viewportHeight);

    if (matchesKey(data, "shift+up")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.autoScroll = false;
    } else if (matchesKey(data, "shift+down")) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, "pageUp")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - viewportHeight);
      this.autoScroll = false;
    } else if (matchesKey(data, "pageDown")) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewportHeight);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, "home")) {
      this.scrollOffset = 0;
      this.autoScroll = false;
    } else if (matchesKey(data, "end")) {
      this.scrollOffset = maxScroll;
      this.autoScroll = true;
    } else {
      this.composer.handleInput(data);
    }
  }

  render(width: number): string[] {
    if (width < 6) return []; // too narrow for any meaningful rendering
    const th = this.theme;
    const innerW = width - 4; // border + padding
    this.lastInnerW = innerW;
    const lines: string[] = [];

    const pad = (s: string, len: number) => {
      const vis = visibleWidth(s);
      return s + " ".repeat(Math.max(0, len - vis));
    };
    const row = (content: string) =>
      th.fg("border", "│") + " " + truncateToWidth(pad(content, innerW), innerW) + " " + th.fg("border", "│");
    const hrTop = th.fg("border", `╭${"─".repeat(width - 2)}╮`);
    const hrBot = th.fg("border", `╰${"─".repeat(width - 2)}╯`);
    const hrMid = row(th.fg("dim", "─".repeat(innerW)));

    // Header
    lines.push(hrTop);
    const name = getDisplayName(this.record.type);
    const modeLabel = getPromptModeLabel(this.record.type);
    const modeTag = modeLabel ? ` ${th.fg("dim", `(${modeLabel})`)}` : "";
    const statusIcon = this.record.status === "running"
      ? th.fg("accent", "●")
      : this.record.status === "completed"
        ? th.fg("success", "✓")
        : this.record.status === "error"
          ? th.fg("error", "✗")
          : th.fg("dim", "○");
    const duration = formatDuration(this.record.startedAt, this.record.completedAt);

    const headerParts: string[] = [duration];
    const toolUses = this.activity?.toolUses ?? this.record.toolUses;
    if (toolUses > 0) headerParts.unshift(`${toolUses} tool${toolUses === 1 ? "" : "s"}`);
    const tokens = getLifetimeTotal(this.activity?.lifetimeUsage);
    if (tokens > 0) {
      const percent = getSessionContextPercent(this.activity?.session);
      headerParts.push(formatSessionTokens(tokens, percent, th, this.record.compactionCount));
    }

    lines.push(row(
      `${statusIcon} ${th.bold(name)}${modeTag}  ${th.fg("muted", this.record.description)} ${th.fg("dim", "·")} ${th.fg("dim", headerParts.join(" · "))}`,
    ));
    const invocationLine = this.invocationLine();
    if (invocationLine) lines.push(row(invocationLine));
    lines.push(hrMid);

    // Content area — rebuild every render (live data, no cache needed)
    const contentLines = this.buildContentLines(innerW);
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, contentLines.length - viewportHeight);

    if (this.autoScroll) {
      this.scrollOffset = maxScroll;
    }

    const visibleStart = Math.min(this.scrollOffset, maxScroll);
    const visible = contentLines.slice(visibleStart, visibleStart + viewportHeight);

    for (let i = 0; i < viewportHeight; i++) {
      lines.push(row(visible[i] ?? ""));
    }

    // Composer
    lines.push(hrMid);
    lines.push(row(th.fg("accent", "Message child")));
    for (const editorLine of this.composer.render(innerW)) lines.push(row(editorLine));
    if (this.sendError) lines.push(row(th.fg("error", this.sendError)));

    // Footer
    lines.push(hrMid);
    const scrollPct = contentLines.length <= viewportHeight
      ? "100%"
      : `${Math.round(((visibleStart + viewportHeight) / contentLines.length) * 100)}%`;
    const footerLeft = th.fg("dim", `${contentLines.length} lines · ${scrollPct}`);
    const stopHint = this.canStop() ? " · Ctrl+X stop" : "";
    const footerRight = th.fg("dim", `Enter send · Shift+Enter newline · Ctrl+B/Esc close${stopHint}`);
    const footerGap = Math.max(1, innerW - visibleWidth(footerLeft) - visibleWidth(footerRight));
    lines.push(row(footerLeft + " ".repeat(footerGap) + footerRight));
    lines.push(hrBot);

    return lines;
  }

  invalidate(): void { /* no cached state to clear */ }

  dispose(): void {
    this.closed = true;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  // ---- Private ----

  private viewportHeight(): number {
    // Cap mirrors the overlay's maxHeight — otherwise the viewer would render
    // more lines than the overlay shows and clip the footer.
    const maxRows = Math.floor((this.tui.terminal.rows * VIEWPORT_HEIGHT_PCT) / 100);
    return Math.max(MIN_VIEWPORT, maxRows - this.chromeLines());
  }

  private chromeLines(): number {
    return CHROME_LINES_BASE + (this.invocationLine() ? 1 : 0) + (this.sendError ? 1 : 0);
  }

  private canStop(): boolean {
    return this.record.phase !== "terminated";
  }

  private invocationLine(): string | undefined {
    const { modelName, tags } = buildInvocationTags(this.record.invocation);
    const parts = modelName ? [modelName, ...tags] : tags;
    if (parts.length === 0) return undefined;
    return this.theme.fg("dim", `  ↳ ${parts.join(" · ")}`);
  }

  private buildContentLines(width: number): string[] {
    if (width <= 0) return [];

    const normalizeTabs = (line: string) => line.replace(/\t/g, "   ");
    const safeLine = (line: string) => truncateToWidth(normalizeTabs(line), width);

    const th = this.theme;
    const messages = (this.session ?? this.record.session)?.messages ?? [];
    const lines: string[] = [];

    if (messages.length === 0) {
      lines.push(th.fg("dim", "(waiting for first message...)"));
      return lines;
    }

    let needsSeparator = false;
    for (const msg of messages) {
      if (msg.role === "user") {
        const text = typeof msg.content === "string"
          ? msg.content
          : extractText(msg.content);
        if (!text.trim()) continue;
        if (needsSeparator) lines.push(th.fg("dim", "───"));
        lines.push(th.fg("accent", "[User]"));
        for (const line of wrapTextWithAnsi(text.trim(), width)) {
          lines.push(line);
        }
      } else if (msg.role === "assistant") {
        const textParts: string[] = [];
        const toolCalls: string[] = [];
        for (const c of msg.content) {
          if (c.type === "text" && c.text) textParts.push(c.text);
          else if (c.type === "toolCall") {
            toolCalls.push((c as any).name ?? (c as any).toolName ?? "unknown");
          }
        }
        if (needsSeparator) lines.push(th.fg("dim", "───"));
        lines.push(th.bold("[Assistant]"));
        if (textParts.length > 0) {
          for (const line of wrapTextWithAnsi(textParts.join("\n").trim(), width)) {
            lines.push(line);
          }
        }
        for (const name of toolCalls) {
          lines.push(safeLine(th.fg("muted", `  [Tool: ${name}]`)));
        }
      } else if (msg.role === "toolResult") {
        const text = extractText(msg.content);
        const truncated = text.length > 500 ? text.slice(0, 500) + "... (truncated)" : text;
        if (!truncated.trim()) continue;
        if (needsSeparator) lines.push(th.fg("dim", "───"));
        lines.push(th.fg("dim", "[Result]"));
        for (const line of wrapTextWithAnsi(truncated.trim(), width)) {
          lines.push(th.fg("dim", line));
        }
      } else if ((msg as any).role === "bashExecution") {
        const bash = msg as any;
        if (needsSeparator) lines.push(th.fg("dim", "───"));
        lines.push(safeLine(th.fg("muted", `  $ ${bash.command}`)));
        if (bash.output?.trim()) {
          const out = bash.output.length > 500
            ? bash.output.slice(0, 500) + "... (truncated)"
            : bash.output;
          for (const line of wrapTextWithAnsi(out.trim(), width)) {
            lines.push(th.fg("dim", line));
          }
        }
      } else {
        continue;
      }
      needsSeparator = true;
    }

    // Streaming indicator for running agents
    if (this.record.status === "running" && this.activity) {
      const act = describeActivity(this.activity.activeTools, this.activity.responseText);
      lines.push("");
      lines.push(safeLine(th.fg("accent", "▍ ") + th.fg("dim", act)));
    }

    return lines.map(safeLine);
  }
}
