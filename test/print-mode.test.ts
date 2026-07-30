import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return {
    ...actual,
    runAgent: vi.fn(),
    resumeAgent: vi.fn(),
  };
});

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

function makePi() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();
  const eventHandlers = new Map<string, any>();

  return {
    pi: {
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn((tool: any) => {
        tools.set(tool.name, tool);
      }),
      registerCommand: vi.fn(),
      on: vi.fn((event: string, handler: any) => {
        handlers.set(event, handler);
      }),
      events: {
        emit: vi.fn(),
        on: vi.fn((event: string, handler: any) => {
          eventHandlers.set(event, handler);
          return vi.fn();
        }),
      },
      appendEntry: vi.fn(),
      sendMessage: vi.fn(() => {
        throw new Error("stale extension context");
      }),
    } as any,
    tools,
    handlers,
    eventHandlers,
  };
}

function makeHeadlessCtx() {
  return {
    hasUI: false,
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    },
    cwd: "/tmp",
    model: undefined,
    modelRegistry: {
      find: vi.fn(),
      getAvailable: vi.fn(() => []),
    },
    sessionManager: {
      getSessionId: vi.fn(() => "session-1"),
      getBranch: vi.fn(() => []),
    },
    getSystemPrompt: vi.fn(() => "parent prompt"),
  } as any;
}

describe("print mode background notifications", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("installs and restores editor navigation with setEditorComponent-only UI", async () => {
    const { pi, handlers } = makePi();
    subagentsExtension(pi);
    const ctx = makeHeadlessCtx();
    ctx.ui.setEditorComponent = vi.fn();

    await handlers.get("session_start")?.({ reason: "startup" }, ctx);

    expect(ctx.ui.setEditorComponent).toHaveBeenCalledWith(expect.any(Function));
    await handlers.get("session_shutdown")?.({}, ctx);
    expect(ctx.ui.setEditorComponent).toHaveBeenLastCalledWith(undefined);
  });

  it("refreshes the widget linger after a synchronous resumed completion", async () => {
    const session = { dispose: vi.fn() };
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      opts.onSessionCreated?.(session);
      return { responseText: "first result", session: session as any, aborted: false, steered: false };
    });
    vi.mocked(resumeAgent).mockResolvedValue({
      responseText: "resumed result", aborted: false, steered: false, cancelled: false,
    });

    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);
    const ctx = makeHeadlessCtx();
    const agentTool = tools.get("Agent");
    const first = await agentTool.execute(
      "tool-call-1",
      {
        prompt: "start",
        description: "sync child",
        subagent_type: "general-purpose",
        run_in_background: false,
      },
      undefined,
      undefined,
      ctx,
    );
    const agentId = first.details.agentId;

    // The next parent turn expires the first completion before the same record is resumed.
    await handlers.get("tool_execution_start")?.({}, ctx);

    await agentTool.execute(
      "tool-call-2",
      {
        prompt: "continue",
        description: "sync child",
        subagent_type: "general-purpose",
        resume: agentId,
      },
      undefined,
      undefined,
      ctx,
    );

    const factories = ctx.ui.setWidget.mock.calls.filter((call: any[]) => typeof call[1] === "function");
    const factory = factories.at(-1)?.[1];
    expect(factory).toBeTypeOf("function");
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const rendered = factory({ terminal: { columns: 120 }, requestRender: vi.fn() }, theme);
    expect(rendered.render().join("\n")).toContain("sync child");

    await handlers.get("session_shutdown")?.({}, ctx);
  });

  it("ages a retained pre-session foreground launch failure", async () => {
    vi.mocked(runAgent).mockRejectedValue(new Error("launch failed"));
    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);
    const ctx = makeHeadlessCtx();

    await tools.get("Agent").execute(
      "tool-call-failure",
      {
        prompt: "fail before creating a session",
        description: "failed foreground",
        subagent_type: "general-purpose",
        run_in_background: false,
      },
      undefined,
      undefined,
      ctx,
    );

    const factory = ctx.ui.setWidget.mock.calls
      .filter((call: any[]) => typeof call[1] === "function")
      .at(-1)?.[1];
    expect(factory).toBeTypeOf("function");
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const rendered = factory({ terminal: { columns: 120 }, requestRender: vi.fn() }, theme);
    expect(rendered.render().join("\n")).toContain("failed foreground");

    await handlers.get("tool_execution_start")?.({}, ctx);
    await handlers.get("tool_execution_start")?.({}, ctx);
    expect(rendered.render()).toEqual([]);

    await handlers.get("session_shutdown")?.({}, ctx);
  });

  it("ages a notification-suppressed synchronous RPC completion", async () => {
    const session = { dispose: vi.fn() };
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      opts.onSessionCreated?.(session);
      return { responseText: "rpc done", session: session as any, aborted: false, steered: false };
    });
    const { pi, handlers, eventHandlers } = makePi();
    subagentsExtension(pi);
    const ctx = makeHeadlessCtx();
    await handlers.get("session_start")?.({ reason: "startup" }, ctx);

    await eventHandlers.get("subagents:rpc:spawn")?.({
      requestId: "rpc-1",
      type: "general-purpose",
      prompt: "run synchronously",
      options: { description: "rpc foreground", isBackground: false },
    });
    await vi.waitFor(() => {
      expect(ctx.ui.setWidget.mock.calls.some((call: any[]) => typeof call[1] === "function")).toBe(true);
    });
    const factory = ctx.ui.setWidget.mock.calls
      .filter((call: any[]) => typeof call[1] === "function")
      .at(-1)?.[1];
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const rendered = factory({ terminal: { columns: 120 }, requestRender: vi.fn() }, theme);
    expect(rendered.render().join("\n")).toContain("rpc foreground");

    await handlers.get("tool_execution_start")?.({}, ctx);
    expect(rendered.render()).toEqual([]);

    await handlers.get("session_shutdown")?.({}, ctx);
  });

  it("ages grouped background completions before batch delivery without resetting them later", async () => {
    vi.useFakeTimers();
    const releases: Array<() => void> = [];
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      opts.onSessionCreated?.({ dispose: vi.fn() });
      await new Promise<void>(resolve => releases.push(resolve));
      return { responseText: "done", session: {} as any, aborted: false, steered: false };
    });

    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);
    const ctx = makeHeadlessCtx();
    const agentTool = tools.get("Agent");
    for (const description of ["grouped one", "grouped two"]) {
      await agentTool.execute(
        `tool-${description}`,
        {
          prompt: "finish quickly",
          description,
          subagent_type: "general-purpose",
          run_in_background: true,
        },
        undefined,
        undefined,
        ctx,
      );
    }

    for (const release of releases) release();
    await vi.advanceTimersByTimeAsync(0);

    // A parent turn starts after completion but before the 100ms batch finalizer delivers the group.
    await handlers.get("tool_execution_start")?.({}, ctx);
    const factories = ctx.ui.setWidget.mock.calls.filter((call: any[]) => typeof call[1] === "function");
    const factory = factories.at(-1)?.[1];
    expect(factory).toBeTypeOf("function");
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const rendered = factory({ terminal: { columns: 120 }, requestRender: vi.fn() }, theme);
    expect(rendered.render()).toEqual([]);

    await vi.advanceTimersByTimeAsync(100);
    expect(rendered.render()).toEqual([]);

    await handlers.get("session_shutdown")?.({}, ctx);
  });

  it("background Agent runs are stopped when the parent tool signal aborts", async () => {
    const controller = new AbortController();
    let release!: () => void;
    const stopped = new Promise<void>(resolve => { release = resolve; });
    const session = { dispose: vi.fn(), abort: vi.fn(async () => release()), abortBash: vi.fn() };
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      opts.onSessionCreated?.(session);
      await stopped;
      return { responseText: "", session: session as any, aborted: true, steered: false };
    });

    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);
    await handlers.get("session_start")?.({ reason: "startup" }, makeHeadlessCtx());

    const agentTool = tools.get("Agent");
    await agentTool.execute(
      "tool-call-1",
      {
        prompt: "keep working",
        description: "background child",
        subagent_type: "general-purpose",
        run_in_background: true,
      },
      controller.signal,
      undefined,
      makeHeadlessCtx(),
    );

    controller.abort();

    expect(session.abortBash).toHaveBeenCalledOnce();
    expect(session.abort).toHaveBeenCalledOnce();

    await handlers.get("session_shutdown")?.({}, makeHeadlessCtx());
  });

  it("Escape after a background agent completes suppresses its pending follow-up nudge", async () => {
    const controller = new AbortController();
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });

    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);
    vi.useFakeTimers();

    const agentTool = tools.get("Agent");
    await agentTool.execute(
      "tool-call-1",
      {
        prompt: "reply done",
        description: "tiny child",
        subagent_type: "general-purpose",
        run_in_background: true,
      },
      controller.signal,
      undefined,
      makeHeadlessCtx(),
    );

    await vi.advanceTimersByTimeAsync(100); // smart-join batch debounce schedules the nudge
    controller.abort(); // user pressed Escape after completion, before the delayed nudge fires
    await vi.advanceTimersByTimeAsync(200);

    expect(pi.sendMessage).not.toHaveBeenCalled();

    await handlers.get("session_shutdown")?.({}, makeHeadlessCtx());
  });

  it("ignores stale-context errors from delayed completion nudges", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });

    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);
    vi.useFakeTimers();

    const agentTool = tools.get("Agent");
    await agentTool.execute(
      "tool-call-1",
      {
        prompt: "reply done",
        description: "tiny child",
        subagent_type: "general-purpose",
        run_in_background: true,
      },
      undefined,
      undefined,
      makeHeadlessCtx(),
    );

    await vi.advanceTimersByTimeAsync(100); // smart-join batch debounce
    await vi.advanceTimersByTimeAsync(200); // notification hold window

    expect(pi.sendMessage).toHaveBeenCalled();

    await handlers.get("session_shutdown")?.({}, makeHeadlessCtx());
  });
});
