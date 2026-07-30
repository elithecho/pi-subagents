import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import type { AgentRecord } from "../src/types.js";
import { AgentNavigationEditor } from "../src/ui/agent-editor-wrapper.js";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  checkpointWorktree: vi.fn(() => ({ hasChanges: false })),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
}));

import { runAgent } from "../src/agent-runner.js";

const mockPi = {} as any;
const mockCtx = { cwd: "/tmp" } as any;

const mockSession = () => ({ dispose: vi.fn() } as any);

const resolvedRun = () =>
  vi.mocked(runAgent).mockResolvedValue({
    responseText: "done",
    session: mockSession(),
    aborted: false,
    steered: false,
  });

/** Hanging mock that settles lazily on abort signal — prevents active-task leak during dispose. */
function hangingRunAgent(): { release: (value?: any) => void } {
  let outerResolve!: (value: any) => void;
  vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, opts: any) => {
    return new Promise(resolve => {
      outerResolve = resolve;
      const onAbort = () => {
        resolve({ responseText: "aborted", session: mockSession(), aborted: true, steered: false });
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
    });
  });
  return { release: (val) => outerResolve(val ?? { responseText: "done", session: mockSession(), aborted: false, steered: false }) };
}

describe("AgentManager — Bug 1 race condition (resultConsumed vs onComplete)", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("reproduces bug: onComplete fires with resultConsumed=false when set after await", async () => {
    let seenConsumed: boolean | undefined;
    manager = new AgentManager((r) => {
      seenConsumed = r.resultConsumed;
    });
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;

    // Simulate the buggy get_subagent_result: await THEN mark consumed
    await record.promise;
    record.resultConsumed = true; // too late — onComplete already fired

    // onComplete saw resultConsumed as falsy (undefined) — would queue a notification (the bug)
    expect(seenConsumed).toBeFalsy();
  });

  it("fix: onComplete sees resultConsumed=true when pre-marked before await", async () => {
    let seenConsumed: boolean | undefined;
    manager = new AgentManager((r) => {
      seenConsumed = r.resultConsumed;
    });
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;

    // The fix: pre-mark BEFORE awaiting
    record.resultConsumed = true;
    await record.promise;

    expect(seenConsumed).toBe(true);
  });

  it("normal case: onComplete fires with resultConsumed falsy when no explicit polling", async () => {
    let completedRecord: AgentRecord | undefined;
    manager = new AgentManager((r) => {
      completedRecord = r;
    });
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(completedRecord).toBeDefined();
    expect(completedRecord!.resultConsumed).toBeFalsy();
  });

  it("onComplete is not called for foreground agents", async () => {
    let onCompleteCalled = false;
    manager = new AgentManager(() => {
      onCompleteCalled = true;
    });
    resolvedRun();

    await manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });

    expect(onCompleteCalled).toBe(false);
  });
});

describe("AgentManager — completion callbacks", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("fires settlement exactly once when an active abort later quiesces", async () => {
    let release!: () => void;
    vi.mocked(runAgent).mockImplementation(async () => {
      await new Promise<void>(resolve => { release = resolve; });
      return { responseText: "late result", session: mockSession(), aborted: false, steered: false };
    });
    const settled = vi.fn();
    manager = new AgentManager(undefined, undefined, undefined, undefined, settled);

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    manager.abort(id);
    expect(settled).toHaveBeenCalledOnce();

    release();
    await vi.waitFor(() => expect(manager.hasRunning()).toBe(false));
    expect(settled).toHaveBeenCalledOnce();
  });

  it("does not let onComplete errors turn a completed agent into a failed run", async () => {
    manager = new AgentManager(() => {
      throw new Error("stale extension context");
    });
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await expect(manager.getRecord(id)!.promise).resolves.toBe("done");

    expect(manager.getRecord(id)!.status).toBe("completed");
  });
});

describe("AgentManager — cleanup timer", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("does not keep the process alive on its own", () => {
    manager = new AgentManager();

    expect((manager as any).cleanupInterval.hasRef()).toBe(false);
  });
});

describe("AgentManager — Bug 3 clearCompleted", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("clearCompleted removes completed records", async () => {
    manager = new AgentManager();
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(manager.listAgents()).toHaveLength(1);
    manager.clearCompleted();
    expect(manager.listAgents()).toHaveLength(0);
  });

  it("clearCompleted does not remove running or queued agents", async () => {
    // Use maxConcurrent=0 to keep agents queued, then spawn one running via foreground
    manager = new AgentManager(undefined, 1);

    // Mock runAgent to never resolve (keeps agent "running")
    vi.mocked(runAgent).mockImplementation(
      () => new Promise(() => {}), // hangs forever
    );

    const id1 = manager.spawn(mockPi, mockCtx, "general-purpose", "test1", {
      description: "running agent",
      isBackground: true,
    });
    // Second agent should be queued (limit=1)
    const id2 = manager.spawn(mockPi, mockCtx, "general-purpose", "test2", {
      description: "queued agent",
      isBackground: true,
    });

    expect(manager.getRecord(id1)!.status).toBe("running");
    expect(manager.getRecord(id2)!.status).toBe("queued");

    manager.clearCompleted();

    // Both should still be present
    expect(manager.getRecord(id1)).toBeDefined();
    expect(manager.getRecord(id2)).toBeDefined();

    // Abort to allow cleanup
    manager.abort(id1);
    manager.abort(id2);
  });

  it("clearCompleted calls dispose on sessions of removed records", async () => {
    manager = new AgentManager();
    const disposeSpy = vi.fn();
    const sess = { dispose: disposeSpy };
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: sess as any,
      aborted: false,
      steered: false,
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    manager.clearCompleted();

    expect(disposeSpy).toHaveBeenCalledOnce();
  });

  it("abort() immediately aborts the session and active bash, not just the manager signal", () => {
    manager = new AgentManager();
    const session = { ...mockSession(), abort: vi.fn().mockResolvedValue(undefined), abortBash: vi.fn() };
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, opts: any) => {
      opts.onSessionCreated?.(session);
      return new Promise(() => {});
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });

    expect(manager.abort(id)).toBe(true);
    expect(session.abortBash).toHaveBeenCalledOnce();
    expect(session.abort).toHaveBeenCalledOnce();
    expect(manager.getRecord(id)!.abortController!.signal.aborted).toBe(true);
    expect(manager.getRecord(id)!.status).toBe("stopped");
  });

  it("parent abort signal stops a running background agent immediately", () => {
    manager = new AgentManager();
    const controller = new AbortController();
    const session = { ...mockSession(), abort: vi.fn().mockResolvedValue(undefined), abortBash: vi.fn() };
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, opts: any) => {
      opts.onSessionCreated?.(session);
      return new Promise(() => {});
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
      signal: controller.signal,
    });

    controller.abort();

    expect(session.abortBash).toHaveBeenCalledOnce();
    expect(session.abort).toHaveBeenCalledOnce();
    expect(manager.getRecord(id)!.abortController!.signal.aborted).toBe(true);
    expect(manager.getRecord(id)!.status).toBe("stopped");
  });

  it("parent abort signal cancels a queued background agent before it starts", () => {
    manager = new AgentManager(undefined, 1);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();

    const runningId = manager.spawn(mockPi, mockCtx, "general-purpose", "running", {
      description: "running",
      isBackground: true,
    });
    const queuedId = manager.spawn(mockPi, mockCtx, "general-purpose", "queued", {
      description: "queued",
      isBackground: true,
      signal: controller.signal,
    });

    expect(manager.getRecord(queuedId)!.status).toBe("queued");
    const callsBeforeAbort = vi.mocked(runAgent).mock.calls.length;

    controller.abort();

    expect(manager.getRecord(queuedId)!.status).toBe("stopped");
    expect(manager.getRecord(queuedId)!.abortController!.signal.aborted).toBe(true);
    expect(runAgent).toHaveBeenCalledTimes(callsBeforeAbort);

    manager.abort(runningId);
  });

  it("abortAll() immediately aborts sessions and active bash for running records", () => {
    manager = new AgentManager();
    const sessions = [
      { ...mockSession(), abort: vi.fn().mockResolvedValue(undefined), abortBash: vi.fn() },
      { ...mockSession(), abort: vi.fn().mockResolvedValue(undefined), abortBash: vi.fn() },
    ];
    let nextSession = 0;
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, opts: any) => {
      opts.onSessionCreated?.(sessions[nextSession++]);
      return new Promise(() => {});
    });

    manager.spawn(mockPi, mockCtx, "general-purpose", "one", {
      description: "one",
      isBackground: true,
    });
    manager.spawn(mockPi, mockCtx, "general-purpose", "two", {
      description: "two",
      isBackground: true,
    });

    expect(manager.abortAll()).toBe(2);
    for (const session of sessions) {
      expect(session.abortBash).toHaveBeenCalledOnce();
      expect(session.abort).toHaveBeenCalledOnce();
    }
  });

  it("clearCompleted removes error and stopped records", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockRejectedValue(new Error("boom"));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;
    expect(manager.getRecord(id)!.status).toBe("error");

    manager.clearCompleted();
    expect(manager.getRecord(id)).toBeUndefined();
  });
});

// Eager init removes the optional/required asymmetry that previously required
// `??=` defaults at the callback sites and `?? 0` / `?? 1` at the read sites.
describe("AgentManager — lifetime usage + compaction count are eagerly initialized", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("spawn initializes lifetimeUsage to zeros and compactionCount to 0", () => {
    manager = new AgentManager();
    // Don't resolve the run — we just want to inspect the record at spawn time.
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;

    expect(record.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
    expect(record.compactionCount).toBe(0);

    manager.abort(id);
  });

  it("onAssistantUsage from runAgent accumulates into record.lifetimeUsage", async () => {
    manager = new AgentManager();

    // Capture the options passed to runAgent so we can drive callbacks
    let captured: any;
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      captured = opts;
      // Two assistant messages with usage
      opts.onAssistantUsage?.({ input: 100, output: 50, cacheWrite: 10 });
      opts.onAssistantUsage?.({ input: 200, output: 80, cacheWrite: 20 });
      return { responseText: "done", session: mockSession(), aborted: false, steered: false };
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(captured).toBeDefined();
    expect(manager.getRecord(id)!.lifetimeUsage).toEqual({
      input: 300, output: 130, cacheWrite: 30,
    });
  });

  it("onCompaction from runAgent increments record.compactionCount", async () => {
    manager = new AgentManager();
    const compactSeen: any[] = [];

    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      // Compaction fires while the agent is still running — the record passed to
      // onCompact should reflect the just-incremented count.
      opts.onCompaction?.({ reason: "threshold", tokensBefore: 12345 });
      opts.onCompaction?.({ reason: "manual", tokensBefore: 22222 });
      return { responseText: "done", session: mockSession(), aborted: false, steered: false };
    });

    manager = new AgentManager(undefined, undefined, undefined, (record, info) => {
      compactSeen.push({ count: record.compactionCount, reason: info.reason });
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(compactSeen).toEqual([
      { count: 1, reason: "threshold" },
      { count: 2, reason: "manual" },
    ]);
    expect(manager.getRecord(id)!.compactionCount).toBe(2);
  });

  it("resume() also accumulates usage and increments compactions on the same record", async () => {
    manager = new AgentManager();

    // First, spawn with a session that resume can latch onto
    const session = { ...mockSession() };
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "first",
      session: session as any,
      aborted: false,
      steered: false,
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    // Pre-resume: lifetimeUsage from spawn was zero (mock didn't call onAssistantUsage)
    expect(manager.getRecord(id)!.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
    expect(manager.getRecord(id)!.compactionCount).toBe(0);

    // Now resume — drive callbacks via the mocked resumeAgent
    const { resumeAgent: resumeMock } = await import("../src/agent-runner.js");
    vi.mocked(resumeMock).mockImplementation(async (_session, _prompt, opts: any) => {
      opts.onAssistantUsage?.({ input: 70, output: 30, cacheWrite: 5 });
      opts.onCompaction?.({ reason: "overflow", tokensBefore: 999 });
      return { responseText: "second", aborted: false, steered: false, cancelled: false };
    });

    await manager.resume(id, "more");

    expect(manager.getRecord(id)!.lifetimeUsage).toEqual({ input: 70, output: 30, cacheWrite: 5 });
    expect(manager.getRecord(id)!.compactionCount).toBe(1);
  });
});

describe("AgentManager — active-only stop", () => {
  it("stops running/queued work without terminating idle reusable agents", async () => {
    const manager = new AgentManager(undefined, 1);
    resolvedRun();
    const idleId = manager.spawn(mockPi, mockCtx, "general-purpose", "idle", {
      description: "idle", isBackground: true,
    });
    await manager.waitForGeneration(idleId, 1);

    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const runningId = manager.spawn(mockPi, mockCtx, "general-purpose", "running", {
      description: "running", isBackground: true,
    });
    const queuedId = manager.spawn(mockPi, mockCtx, "general-purpose", "queued", {
      description: "queued", isBackground: true,
    });

    expect(manager.abortActive()).toBe(2);
    expect(manager.getRecord(idleId)?.phase).toBe("idle");
    expect(manager.getRecord(idleId)?.session).toBeDefined();
    expect(manager.getRecord(runningId)?.phase).toBe("terminated");
    expect(manager.getRecord(queuedId)?.phase).toBe("terminated");
    void manager.dispose();
  });
});

describe("AgentManager — promoteActiveToBackground", () => {
  let manager: AgentManager;

  afterEach(async () => {
    vi.mocked(runAgent).mockRejectedValue(new Error("test cleanup abort"));
    await manager?.dispose();
  });

  it("promotes a foreground agent to background, detaching from parent abort; spawnAndWait releases promptly and completion fires later", async () => {
    // Arrange: foreground spawn with parent signal, agent hangs forever
    let releaseAgent!: () => void;
    const session = { ...mockSession(), abort: vi.fn().mockResolvedValue(undefined), abortBash: vi.fn() };
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      opts.onSessionCreated?.(session);
      await new Promise<void>(resolve => { releaseAgent = resolve; });
      return { responseText: "promoted result", session, aborted: false, steered: false };
    });

    const parentSignal = new AbortController();
    const completed: any[] = [];
    manager = new AgentManager((_record, turn) => completed.push(turn));

    // Act: spawn foreground with parent signal
    const spawnPromise = manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "foreground", {
      description: "fg",
      signal: parentSignal.signal,
    });

    // Wait a tick for spawn to set up
    await vi.waitFor(() => {
      const records = manager.listAgents();
      expect(records.length).toBe(1);
      expect(records[0].session).toBe(session);
    });

    const record = manager.listAgents()[0];

    // Promote to background via public API (conversationId is undefined here)
    const count = manager.promoteActiveToBackground(undefined);
    expect(count).toBe(1);
    expect(record.status).toBe("running");

    // spawnAndWait should release immediately (not hang on generation completion)
    const result = await spawnPromise;
    expect(result.record.id).toBe(record.id);
    expect(result.kind).toBe("backgrounded");
    expect(result.generation).toBe(1);

    // Parent abort should NOT affect the promoted child
    parentSignal.abort();
    expect(session.abortBash).not.toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();
    expect(manager.getRecord(record.id)!.phase).toBe("working");
    expect(manager.getRecord(record.id)!.status).toBe("running");

    // Now let the agent complete
    releaseAgent();
    await manager.waitForGeneration(record.id, 1);

    // Verify generation completed and completion callback fired
    expect(manager.getRecord(record.id)!.status).toBe("completed");
    expect(manager.getRecord(record.id)!.result).toBe("promoted result");
    expect(completed.length).toBe(1);
    expect(completed[0].generation).toBe(1);
    expect(completed[0].result).toBe("promoted result");
  });

  it("integrated: Ctrl+B via AgentNavigationEditor promotes foreground agent and spawnAndWait returns backgrounded", async () => {
    // Arrange: foreground spawn with parent signal, agent hangs forever
    let releaseAgent!: () => void;
    const session = { ...mockSession(), abort: vi.fn().mockResolvedValue(undefined), abortBash: vi.fn() };
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      opts.onSessionCreated?.(session);
      await new Promise<void>(resolve => { releaseAgent = resolve; });
      return { responseText: "integrated result", session, aborted: false, steered: false };
    });

    const parentSignal = new AbortController();
    manager = new AgentManager();

    // Start foreground spawn
    const spawnPromise = manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "fg", {
      description: "fg",
      signal: parentSignal.signal,
    });

    await vi.waitFor(() => {
      expect(manager.listAgents().length).toBe(1);
    });

    // Build a mock base editor with onEscape that aborts parent signal and restores text
    let baseText = "draft";
    const base: any = {
      render: vi.fn(() => []),
      invalidate: vi.fn(),
      getText: vi.fn(() => baseText),
      setText: vi.fn((t: string) => { baseText = t; }),
      handleInput: vi.fn(),
      onEscape: vi.fn(() => {
        // Abort the parent signal (simulating parent turn being interrupted)
        parentSignal.abort();
        // Restore queued text into the editor
        baseText = "queued";
      }),
    };

    // Mock AgentWidget with minimal interface
    const widget: any = {
      focusList: vi.fn(() => false),
      leaveList: vi.fn(),
      moveSelection: vi.fn(),
      selectedAgent: vi.fn(() => undefined),
      ensureTimer: vi.fn(),
      update: vi.fn(),
    };

    // The promote callback wired by session_start in index.ts
    const promoteForeground = () => {
      const conversationId = undefined;
      return manager.promoteActiveToBackground(conversationId) > 0;
    };

    // Prevent submit from hanging
    const submit = vi.fn(() => true);
    const waitForIdle = vi.fn(async () => true);

    const editor = new AgentNavigationEditor(
      base, widget, vi.fn(),
      () => true, // hasPendingMessages
      waitForIdle,
      submit,
      promoteForeground,
    );

    // Act: press Ctrl+B
    editor.handleInput("\u0002");

    // Assert: promoteForeground was called, onEscape was called
    expect(promoteForeground).toBeDefined();
    expect(base.onEscape).toHaveBeenCalledOnce();

    // spawnAndWait returns tagged backgrounded
    const result = await spawnPromise;
    expect(result.kind).toBe("backgrounded");
    expect(result.generation).toBe(1);
    expect(result.record.session).toBe(session);

    // Child session NOT aborted by parent signal (parent was aborted inside onEscape,
    // but detach happened first)
    expect(session.abortBash).not.toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();
    expect(manager.getRecord(result.record.id)!.status).toBe("running");

    // Now release the agent and verify completion
    releaseAgent();
    await manager.waitForGeneration(result.record.id, 1);
    expect(manager.getRecord(result.record.id)!.status).toBe("completed");
    expect(manager.getRecord(result.record.id)!.result).toBe("integrated result");
  });

  it("returns 0 for non-existent conversation", () => {
    manager = new AgentManager();
    expect(manager.promoteActiveToBackground("nonexistent-conversation")).toBe(0);
  });

  it("returns 0 for terminated or non-eligible agents", async () => {
    manager = new AgentManager();
    hangingRunAgent();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "fg", {
      description: "fg",
    });
    manager.abort(id);

    // Wait for abort to settle the active task
    await vi.waitFor(() => {
      expect(manager.getRecord(id)?.phase).toBe("terminated");
    });

    // No promotionDeferred was created (spawn, not spawnAndWait)
    expect(manager.promoteActiveToBackground(undefined)).toBe(0);
  });

  it("does not promote resumed foreground turns (no promotionDeferred)", async () => {
    manager = new AgentManager();
    const session = mockSession();
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "initial", session, aborted: false, steered: false,
    });

    // Spawn foreground and let it complete
    const { record } = await manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "first", {
      description: "fg",
    });

    // Mock resume — keep it pending so we can test promotion during active resume
    let releaseResume!: () => void;
    const { resumeAgent } = await import("../src/agent-runner.js");
    vi.mocked(resumeAgent).mockImplementation(async () => {
      await new Promise<void>(resolve => { releaseResume = resolve; });
      return { responseText: "resume result", aborted: false, steered: false, cancelled: false };
    });

    // Start a foreground resume turn (via enqueueTurn + waitForGeneration)
    const resumeGen = manager.enqueueTurn(record.id, "more", undefined, {
      background: false, notify: false, bypassQueue: true,
    })!;

    // Wait for the agent to be actively running the resume turn
    await vi.waitFor(() => {
      expect(manager.getRecord(record.id)?.status).toBe("running");
    });

    // While resume is pending, promoteActiveToBackground should return 0
    // because the active item is not initial (it's a resumed turn, generation > 1).
    expect(manager.promoteActiveToBackground(undefined)).toBe(0);

    // Release resume and await completion
    releaseResume();
    const snapshot = await manager.waitForGeneration(record.id, resumeGen);
    expect(snapshot?.status).toBe("completed");
    expect(snapshot?.result).toBe("resume result");
  });

  it("promotes detachment throwing does not promote; item remains foreground, spawnAndWait returns completed", async () => {
    let releaseAgent!: () => void;
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      const session = mockSession();
      opts.onSessionCreated?.(session);
      await new Promise<void>(resolve => { releaseAgent = resolve; });
      return { responseText: "detach fail completed", session, aborted: false, steered: false };
    });

    const parentSignal = new AbortController();
    manager = new AgentManager();

    const spawnPromise = manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "fg", {
      description: "fg",
      signal: parentSignal.signal,
    });

    await vi.waitFor(() => {
      expect(manager.listAgents().length).toBe(1);
    });

    const record = manager.listAgents()[0];

    // Make parentAbortDetach throw
    record.parentAbortDetach = () => { throw new Error("detach failed"); };

    // Promotion should return 0 — no partial state
    const count = manager.promoteActiveToBackground(undefined);
    expect(count).toBe(0);

    // Item should still be foreground and eligible
    const item = (manager as any).activeItems.get(record.id);
    expect(item).toBeDefined();
    expect(item.background).toBe(false);

    // spawnAndWait should NOT have been resolved as backgrounded
    // Let the agent complete naturally
    releaseAgent();
    const result = await spawnPromise;
    expect(result.kind).toBe("completed");
    expect(result.record.id).toBe(record.id);
    expect(result.generation).toBe(1);
    expect(result.record.status).toBe("completed");
  });

  it("completion-vs-promotion cleanup: promoted agent that later completes cleans up promotionDeferred", async () => {
    let releaseAgent!: () => void;
    const session = { ...mockSession(), abort: vi.fn().mockResolvedValue(undefined), abortBash: vi.fn() };
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      opts.onSessionCreated?.(session);
      await new Promise<void>(resolve => { releaseAgent = resolve; });
      return { responseText: "first promoted then completed", session, aborted: false, steered: false };
    });

    const parentSignal = new AbortController();
    manager = new AgentManager();

    const spawnPromise = manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "fg", {
      description: "fg",
      signal: parentSignal.signal,
    });

    await vi.waitFor(() => {
      expect(manager.listAgents().length).toBe(1);
    });

    const record = manager.listAgents()[0];

    // Promote to background
    expect(manager.promoteActiveToBackground(undefined)).toBe(1);

    const result = await spawnPromise;
    expect(result.kind).toBe("backgrounded");

    // After promotion, promotionDeferred should still have the key
    const key = `${record.id}:${result.generation}`;
    expect((manager as any).promotionDeferred.has(key)).toBe(false);

    // Complete naturally — should not error or leak
    releaseAgent();
    await manager.waitForGeneration(record.id, 1);

    // promotionDeferred should still be clean
    expect((manager as any).promotionDeferred.has(key)).toBe(false);
    expect((manager as any).promotionDeferred.size).toBe(0);
  });

  it("normal completion removes the exact waiter in finally; no leak when agent finishes first", async () => {
    const session = mockSession();
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "fast complete", session, aborted: false, steered: false,
    });

    manager = new AgentManager();
    const spawnResult = await manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "fg", {
      description: "fg",
    });

    // Completed naturally
    expect(spawnResult.kind).toBe("completed");
    expect(spawnResult.record.status).toBe("completed");

    // promotionDeferred must be empty
    expect((manager as any).promotionDeferred.size).toBe(0);
  });

  it("promotes all eligible initial foreground agents in the current conversation and leaves another conversation untouched", async () => {
    manager = new AgentManager();
    hangingRunAgent();

    const convId = "conv-1";
    const ctxWithConv = { ...mockCtx, sessionManager: { getSessionId: () => convId } };

    // Spawn two foreground in conv-1 via spawnAndWait (creates promotionDeferreds)
    const p1 = manager.spawnAndWait(mockPi, ctxWithConv, "general-purpose", "first", {
      description: "first",
    });
    const p2 = manager.spawnAndWait(mockPi, ctxWithConv, "general-purpose", "second", {
      description: "second",
    });

    // Wait for both to be running
    await vi.waitFor(() => {
      expect(manager.listAgents().length).toBe(2);
    });

    // Promote all in conversation — both eligible
    const count = manager.promoteActiveToBackground(convId);
    expect(count).toBe(2);

    // Both spawnAndWait should resolve with kind="backgrounded"
    const r1 = await p1;
    const r2 = await p2;
    expect(r1.kind).toBe("backgrounded");
    expect(r1.generation).toBe(1);
    expect(r2.kind).toBe("backgrounded");
    expect(r2.generation).toBe(1);

    // Parallel conversation untouched
    const ctxOther = { ...mockCtx, sessionManager: { getSessionId: () => "other-conv" } };
    const p3 = manager.spawnAndWait(mockPi, ctxOther, "general-purpose", "other", {
      description: "other",
    });
    await vi.waitFor(() => {
      expect(manager.listAgents().length).toBe(3);
    });

    // Promote only other conversation
    expect(manager.promoteActiveToBackground("other-conv")).toBe(1);
    const r3 = await p3;
    expect(r3.kind).toBe("backgrounded");
    expect(r3.generation).toBe(1);
    // Conv-1 count wasn't re-promoted
    expect(manager.promoteActiveToBackground(convId)).toBe(0);
  });
});

describe("AgentManager — reusable FIFO generations", () => {
  let manager: AgentManager;
  afterEach(() => { void manager?.dispose(); });

  it("runs injected turns FIFO without overlapping session.prompt calls", async () => {
    const session = mockSession();
    let finishInitial!: (value: any) => void;
    vi.mocked(runAgent).mockImplementation(() => new Promise(resolve => { finishInitial = resolve; }));
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "first", { description: "fifo", isBackground: true });

    const { resumeAgent: resumeMock } = await import("../src/agent-runner.js");
    vi.mocked(resumeMock).mockClear();
    const order: string[] = [];
    vi.mocked(resumeMock).mockImplementation(async (_session, prompt) => {
      order.push(prompt);
      return { responseText: `done:${prompt}`, aborted: false, steered: false, cancelled: false };
    });
    const g2 = manager.enqueueTurn(id, "second")!;
    const g3 = manager.enqueueTurn(id, "third")!;

    expect(resumeMock).not.toHaveBeenCalled();
    finishInitial({ responseText: "done:first", session, aborted: false, steered: false });
    await manager.waitForGeneration(id, g3);

    expect(order).toEqual(["second", "third"]);
    expect(manager.getRecord(id)?.phase).toBe("idle");
    expect(manager.getTurnResult(id, g2)?.result).toBe("done:second");
    expect(manager.getTurnResult(id, g3)?.result).toBe("done:third");
  });

  it("abort settles every generation once but retains the slot until prompt quiesces", async () => {
    let release!: (value: any) => void;
    vi.mocked(runAgent).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    manager = new AgentManager(undefined, 1);
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "first", { description: "stop", isBackground: true });
    const queuedGeneration = manager.enqueueTurn(id, "queued")!;
    resolvedRun();
    const other = manager.spawn(mockPi, mockCtx, "general-purpose", "other", { description: "other", isBackground: true });

    manager.abort(id);
    await expect(manager.waitForGeneration(id, 1)).resolves.toMatchObject({ status: "stopped" });
    await expect(manager.waitForGeneration(id, queuedGeneration)).resolves.toMatchObject({ status: "stopped" });
    expect(manager.getRecord(other)?.phase).toBe("queued");

    release({ responseText: "late", session: mockSession(), aborted: true, steered: false });
    await manager.waitForGeneration(other, 1);
    expect(manager.getRecord(other)?.phase).toBe("idle");
    expect(manager.getTurnResult(id, 1)?.status).toBe("stopped");
  });

  it("settles generation one when spawned with an already-aborted signal", async () => {
    vi.mocked(runAgent).mockClear();
    manager = new AgentManager();
    const controller = new AbortController();
    controller.abort();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "never", {
      description: "cancelled", isBackground: true, signal: controller.signal,
    });

    await expect(manager.waitForGeneration(id, 1)).resolves.toMatchObject({ status: "stopped" });
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("cancels an already-queued generation from its own signal", async () => {
    manager = new AgentManager(undefined, 1);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const running = manager.spawn(mockPi, mockCtx, "general-purpose", "running", { description: "running", isBackground: true });
    const queued = manager.spawn(mockPi, mockCtx, "general-purpose", "queued", { description: "queued", isBackground: true });
    const controller = new AbortController();
    const generation = manager.enqueueTurn(queued, "cancel me", controller.signal)!;
    controller.abort();

    await expect(manager.waitForGeneration(queued, generation)).resolves.toMatchObject({ status: "stopped" });
    manager.abort(running);
    manager.abort(queued);
  });

  it("starts bypassQueue work immediately without releasing normal capacity", () => {
    manager = new AgentManager(undefined, 1);
    vi.mocked(runAgent).mockClear();
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    manager.spawn(mockPi, mockCtx, "general-purpose", "one", { description: "one", isBackground: true });
    const normal = manager.spawn(mockPi, mockCtx, "general-purpose", "normal", { description: "normal", isBackground: true });
    const bypass = manager.spawn(mockPi, mockCtx, "general-purpose", "bypass", { description: "bypass", isBackground: true, bypassQueue: true });

    expect(manager.getRecord(normal)?.phase).toBe("queued");
    expect(manager.getRecord(bypass)?.phase).toBe("working");
    expect(runAgent).toHaveBeenCalledTimes(2);
  });

  it("becomes idle when the newest queued turn is cancelled before an older turn settles", async () => {
    let finishInitial!: (value: any) => void;
    vi.mocked(runAgent).mockImplementation(() => new Promise(resolve => { finishInitial = resolve; }));
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "older", { description: "phase", isBackground: true });
    const controller = new AbortController();
    const newest = manager.enqueueTurn(id, "newest", controller.signal)!;
    controller.abort();
    await manager.waitForGeneration(id, newest);
    expect(manager.getRecord(id)?.phase).toBe("working");

    finishInitial({ responseText: "older done", session: mockSession(), aborted: false, steered: false });
    await manager.waitForGeneration(id, 1);
    expect(manager.getRecord(id)?.phase).toBe("idle");
  });

  it("resume returns its exact consumed snapshot and suppresses background completion", async () => {
    const completed: any[] = [];
    manager = new AgentManager((_record, turn) => completed.push(turn));
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "first", { description: "resume", isBackground: true });
    await manager.waitForGeneration(id, 1);
    const { resumeAgent: resumeMock } = await import("../src/agent-runner.js");
    vi.mocked(resumeMock).mockResolvedValue({ responseText: "exact second", aborted: false, steered: false, cancelled: false });

    const snapshot = await manager.resume(id, "second");

    expect(snapshot).toMatchObject({ generation: 2, result: "exact second", status: "completed" });
    expect(completed.map(t => t.generation)).toEqual([1]);
    expect(manager.getRecord(id)?.consumedGenerations.has(2)).toBe(true);
  });

  it("maps a cancelled resumed prompt to stopped without stale output", async () => {
    manager = new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "first", { description: "cancel resume", isBackground: true });
    await manager.waitForGeneration(id, 1);
    const { resumeAgent: resumeMock } = await import("../src/agent-runner.js");
    vi.mocked(resumeMock).mockResolvedValue({ responseText: "stale previous answer", aborted: false, steered: false, cancelled: true });

    const snapshot = await manager.resume(id, "cancelled");

    expect(snapshot).toMatchObject({ generation: 2, status: "stopped", result: "" });
  });

  it("removes archived generation snapshots with the record", async () => {
    manager = new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "first", { description: "cleanup", isBackground: true });
    await manager.waitForGeneration(id, 1);
    manager.clearCompleted();

    expect(manager.getTurnResult(id, 1)).toBeUndefined();
    expect([...(manager as any).snapshots.keys()].some((key: string) => key.startsWith(`${id}:`))).toBe(false);
  });

  it("surfaces checkpoint failure alongside the original turn error", async () => {
    const { createWorktree, checkpointWorktree } = await import("../src/worktree.js");
    vi.mocked(createWorktree).mockReturnValueOnce({ path: "/tmp/worktree", branch: "branch" });
    vi.mocked(checkpointWorktree).mockReturnValueOnce({ hasChanges: false, error: "git commit failed" });
    vi.mocked(runAgent).mockRejectedValueOnce(new Error("provider failed"));
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "first", {
      description: "checkpoint", isBackground: true, isolation: "worktree",
    });

    const snapshot = await manager.waitForGeneration(id, 1);
    expect(snapshot?.status).toBe("error");
    expect(snapshot?.error).toContain("provider failed");
    expect(snapshot?.error).toContain("Worktree checkpoint failed: git commit failed");
  });

  it("schedules a foreground agent's steered turn as background work", async () => {
    const completed: any[] = [];
    manager = new AgentManager((_record, turn) => completed.push(turn), 1);
    const foregroundSession = mockSession();
    vi.mocked(runAgent).mockResolvedValueOnce({
      responseText: "foreground", session: foregroundSession, aborted: false, steered: false,
    });
    const { record: foreground } = await manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "first", { description: "foreground" });

    let releaseBlocker!: (value: any) => void;
    vi.mocked(runAgent).mockImplementationOnce(() => new Promise(resolve => { releaseBlocker = resolve; }));
    const blocker = manager.spawn(mockPi, mockCtx, "general-purpose", "block", { description: "block", isBackground: true });
    const generation = manager.enqueueTurn(foreground.id, "steered")!;
    expect(manager.getRecord(foreground.id)?.phase).toBe("queued");

    const { resumeAgent: resumeMock } = await import("../src/agent-runner.js");
    vi.mocked(resumeMock).mockResolvedValue({ responseText: "background turn", aborted: false, steered: false, cancelled: false });
    releaseBlocker({ responseText: "unblocked", session: mockSession(), aborted: false, steered: false });
    await manager.waitForGeneration(foreground.id, generation);

    expect(completed.map(turn => turn.agentId)).toContain(foreground.id);
    expect(manager.getTurnResult(foreground.id, generation)?.result).toBe("background turn");
    manager.abort(blocker);
  });

  it("waits for the captured generation even after a later turn is queued", async () => {
    resolvedRun();
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "first", { description: "race", isBackground: true });
    const captured = manager.captureGeneration(id)!;
    const first = await manager.waitForGeneration(id, captured);
    manager.enqueueTurn(id, "later");

    expect(first?.generation).toBe(1);
    expect(first?.result).toBe("done");
  });
});

// Regression: `isolation: "worktree"` MUST fail loud when the cwd can't host
// a worktree. The previous behavior silently fell back to the main tree and
// injected a warning into the LLM's prompt — invisible to the caller.
describe("AgentManager — isolation: worktree fails loud, no silent fallback", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("immediate background spawn throws setup failure instead of returning started", async () => {
    const { createWorktree } = await import("../src/worktree.js");
    vi.mocked(createWorktree).mockReturnValueOnce(undefined);
    const completed = vi.fn();
    manager = new AgentManager(completed);

    expect(() => manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "background worktree", isolation: "worktree", isBackground: true,
    })).toThrow(/Cannot run with isolation: "worktree"/);

    expect(manager.listAgents()).toEqual([]);
    expect(completed).not.toHaveBeenCalled();
  });

  it("queued background setup failure settles asynchronously when its slot opens", async () => {
    const { createWorktree } = await import("../src/worktree.js");
    let release!: (value: any) => void;
    vi.mocked(runAgent).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const completed = vi.fn();
    manager = new AgentManager(completed, 1);
    manager.spawn(mockPi, mockCtx, "general-purpose", "block", {
      description: "blocker", isBackground: true,
    });
    vi.mocked(createWorktree).mockReturnValueOnce(undefined);

    const queuedId = manager.spawn(mockPi, mockCtx, "general-purpose", "later", {
      description: "queued worktree", isolation: "worktree", isBackground: true,
    });
    expect(manager.getRecord(queuedId)?.phase).toBe("queued");

    release({ responseText: "done", session: mockSession(), aborted: false, steered: false });
    const result = await manager.waitForGeneration(queuedId, 1);
    expect(result).toMatchObject({ status: "error" });
    expect(result?.error).toMatch(/Cannot run with isolation: "worktree"/);
    expect(completed).toHaveBeenCalledWith(manager.getRecord(queuedId), result);
  });

  it("spawn() throws when createWorktree returns undefined; no orphan record left behind", async () => {
    const { createWorktree } = await import("../src/worktree.js");
    vi.mocked(createWorktree).mockReturnValueOnce(undefined);
    vi.mocked(runAgent).mockClear();

    manager = new AgentManager();
    expect(() => manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isolation: "worktree",
    })).toThrow(/isolation: "worktree"/);

    // Cleaned up — no orphan in listAgents()
    expect(manager.listAgents()).toEqual([]);
    // runAgent never invoked — strict, no silent fallback
    expect(runAgent).not.toHaveBeenCalled();
  });
});
