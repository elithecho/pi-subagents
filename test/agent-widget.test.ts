import { describe, expect, it, vi } from "vitest";
import { AgentWidget, formatSessionTokens } from "../src/ui/agent-widget.js";

describe("AgentWidget list input", () => {
  it("keeps an idle reusable record registered across parent turns", () => {
    const record = { id: "idle", conversationId: "current", phase: "idle", status: "completed", completedAt: 2, startedAt: 1 } as any;
    const manager = { listAgents: () => [record] } as any;
    const setWidget = vi.fn();
    const widget = new AgentWidget(manager, new Map());
    widget.setUICtx({ setWidget, setStatus: vi.fn() } as any);
    widget.setConversationId("current");
    widget.markFinished(record.id);
    widget.ensureTimer();
    widget.update();
    for (let i = 0; i < 5; i++) widget.onTurnStart();

    expect(setWidget).not.toHaveBeenCalledWith("agents", undefined);
    expect((widget as any).widgetInterval).toBeUndefined();

    record.phase = "working";
    widget.ensureTimer();
    widget.update();
    expect((widget as any).widgetInterval).toBeDefined();
    widget.dispose();
  });

  it("counts queued rows omitted by the overflow budget", () => {
    const records = Array.from({ length: 15 }, (_, index) => ({
      id: `q-${index}`, type: "general-purpose", description: `queued ${index}`,
      conversationId: "current", phase: "queued", status: "queued",
      toolUses: 0, startedAt: 1, lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 }, compactionCount: 0,
    })) as any[];
    const manager = { listAgents: () => records } as any;
    const widget = new AgentWidget(manager, new Map());
    widget.setConversationId("current");
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const lines = (widget as any).renderWidget({ terminal: { columns: 120 } }, theme);

    expect(lines.at(-1)).toContain("+5 more (5 queued)");
  });

  it("filters the current conversation and selects with Down/Enter", () => {
    const records = [
      { id: "old", conversationId: "old", phase: "idle" },
      { id: "one", conversationId: "current", phase: "working" },
      { id: "two", conversationId: "current", phase: "idle" },
    ] as any[];
    const manager = { listAgents: (id?: string) => records.filter(r => id == null || r.conversationId === id) } as any;
    const widget = new AgentWidget(manager, new Map());
    widget.setConversationId("current");

    expect(widget.handleListInput("\u001b[B").consumed).toBe(true);
    expect(widget.handleListInput("\r").record?.id).toBe("one");
    widget.handleListInput("\u001b[B");
    expect(widget.handleListInput("\r").record?.id).toBe("two");
  });
});

describe("formatSessionTokens", () => {
  const theme = { fg: (c: string, s: string) => `<${c}>${s}</${c}>`, bold: (s: string) => s };

  it("applies threshold colors (<70 dim, 70–85 warning, ≥85 error)", () => {
    expect(formatSessionTokens(1234, null, theme)).toBe("1.2k token");
    expect(formatSessionTokens(1234, 50, theme)).toBe("1.2k token (<dim>50%</dim>)");
    expect(formatSessionTokens(1234, 70, theme)).toBe("1.2k token (<warning>70%</warning>)");
    expect(formatSessionTokens(1234, 84, theme)).toBe("1.2k token (<warning>84%</warning>)");
    expect(formatSessionTokens(1234, 85, theme)).toBe("1.2k token (<error>85%</error>)");
    expect(formatSessionTokens(1234, 99, theme)).toBe("1.2k token (<error>99%</error>)");
  });

  it("annotates compaction count alongside percent", () => {
    // compactions only (e.g. immediately post-compaction, percent null)
    expect(formatSessionTokens(1234, null, theme, 1)).toBe("1.2k token (<dim>↻1</dim>)");
    expect(formatSessionTokens(1234, null, theme, 3)).toBe("1.2k token (<dim>↻3</dim>)");
    // percent + compactions, joined with ` · `
    expect(formatSessionTokens(1234, 45, theme, 2)).toBe("1.2k token (<dim>45%</dim> · <dim>↻2</dim>)");
    expect(formatSessionTokens(1234, 88, theme, 4)).toBe("1.2k token (<error>88%</error> · <dim>↻4</dim>)");
    // compactions=0 omitted
    expect(formatSessionTokens(1234, 45, theme, 0)).toBe("1.2k token (<dim>45%</dim>)");
  });
});
