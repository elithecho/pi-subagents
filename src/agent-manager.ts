/** Tracks reusable child sessions and schedules every prompt turn. */
import { randomUUID } from "node:crypto";
import type { Model } from "@mariozechner/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { resumeAgent, runAgent, type ToolActivity } from "./agent-runner.js";
import { logger } from "./logger.js";
import type { AgentInvocation, AgentRecord, AgentTurnSnapshot, IsolationMode, SubagentType, ThinkingLevel } from "./types.js";
import { addUsage } from "./usage.js";
import { checkpointWorktree, cleanupWorktree, createWorktree, pruneWorktrees } from "./worktree.js";

export type OnAgentComplete = (record: AgentRecord, turn: AgentTurnSnapshot) => void;
export type OnAgentStart = (record: AgentRecord) => void;
export type OnAgentCompact = (record: AgentRecord, info: CompactionInfo) => void;
export type CompactionInfo = { reason: "manual" | "threshold" | "overflow"; tokensBefore: number };
const DEFAULT_MAX_CONCURRENT = 4;

interface SpawnOptions {
  description: string;
  model?: Model<any>;
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  isBackground?: boolean;
  bypassQueue?: boolean;
  isolation?: IsolationMode;
  invocation?: AgentInvocation;
  signal?: AbortSignal;
  onToolActivity?: (activity: ToolActivity) => void;
  onTextDelta?: (delta: string, fullText: string) => void;
  onSessionCreated?: (session: AgentSession) => void;
  onTurnEnd?: (turnCount: number) => void;
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  onCompaction?: (info: CompactionInfo) => void;
}
interface Runtime { pi: ExtensionAPI; ctx: ExtensionContext; type: SubagentType; options: SpawnOptions; background: boolean; worktreeCwd?: string }
interface WorkItem { id: string; generation: number; prompt: string; initial: boolean; signal?: AbortSignal; bypassQueue?: boolean; background: boolean; startedAt?: number; detachSignal?: () => void; notify?: boolean; quiesced?: boolean; checkpointed?: boolean; propagateStartupFailure?: boolean }
interface Deferred { promise: Promise<string>; resolve: (value: string) => void; settled: boolean }

export class AgentManager {
  private agents = new Map<string, AgentRecord>();
  private runtimes = new Map<string, Runtime>();
  private queue: WorkItem[] = [];
  private deferred = new Map<string, Deferred>();
  private active = new Set<string>();
  private activeItems = new Map<string, WorkItem>();
  private activeTasks = new Map<string, Promise<void>>();
  private snapshots = new Map<string, AgentTurnSnapshot>();
  private onComplete?: OnAgentComplete;
  private onStart?: OnAgentStart;
  private onCompact?: OnAgentCompact;
  private maxConcurrent: number;
  /** Compatibility handle only; no idle-record cleanup is performed. */
  private cleanupInterval: ReturnType<typeof setInterval>;

  constructor(onComplete?: OnAgentComplete, maxConcurrent = DEFAULT_MAX_CONCURRENT, onStart?: OnAgentStart, onCompact?: OnAgentCompact) {
    this.onComplete = onComplete;
    this.onStart = onStart;
    this.onCompact = onCompact;
    this.maxConcurrent = maxConcurrent;
    this.cleanupInterval = setInterval(() => {}, 60 * 60_000);
    this.cleanupInterval.unref();
  }

  setMaxConcurrent(n: number) { this.maxConcurrent = Math.max(1, n); this.drainQueue(); }
  getMaxConcurrent(): number { return this.maxConcurrent; }

  spawn(pi: ExtensionAPI, ctx: ExtensionContext, type: SubagentType, prompt: string, options: SpawnOptions): string {
    const id = randomUUID().slice(0, 17);
    const abortController = new AbortController();
    const background = options.isBackground === true;
    const record: AgentRecord = {
      id, type, description: options.description,
      phase: background ? "queued" : "working",
      status: background ? "queued" : "running",
      generation: 1, turnResults: new Map(), consumedGenerations: new Set(),
      toolUses: 0, startedAt: Date.now(), abortController,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 }, compactionCount: 0,
      conversationId: ctx.sessionManager?.getSessionId?.() ?? undefined,
      invocation: options.invocation,
    };
    this.agents.set(id, record);
    this.runtimes.set(id, { pi, ctx, type, options, background });

    if (options.signal) {
      const stop = () => {
        if (record.phase === "idle") {
          this.consumeGeneration(id, record.generation);
          record.parentAbortDetach?.();
          record.parentAbortDetach = undefined;
        } else {
          this.abort(id);
        }
      };
      options.signal.addEventListener("abort", stop, { once: true });
      record.parentAbortDetach = () => options.signal?.removeEventListener("abort", stop);
      if (options.signal.aborted) {
        this.createTurn(record, 1);
        record.phase = "terminated";
        this.settleTurn(record, { id, generation: 1, prompt, initial: true, signal: options.signal, background, notify: false }, "stopped", undefined, undefined, false);
        record.parentAbortDetach?.();
        record.parentAbortDetach = undefined;
        return id;
      }
    }

    this.createTurn(record, 1);
    const item: WorkItem = {
      id, generation: 1, prompt, initial: true, signal: abortController.signal,
      background, notify: background, bypassQueue: options.bypassQueue || !background,
    };
    if (!background) {
      this.startItem(item, true);
    } else {
      // A background turn that can acquire a slot during spawn is still an
      // immediate startup. Surface setup errors to the Agent tool. Once spawn
      // returns, queued starts report through their generation as usual.
      item.propagateStartupFailure = true;
      this.queue.push(item);
      try {
        this.drainQueue();
      } catch (err) {
        this.queue = this.queue.filter(queued => queued !== item);
        this.removeRecord(id, record);
        throw err;
      } finally {
        item.propagateStartupFailure = false;
      }
    }
    return id;
  }

  private createTurn(record: AgentRecord, generation: number): Deferred {
    let resolve!: (value: string) => void;
    const promise = new Promise<string>(r => { resolve = r; });
    const d = { promise, resolve, settled: false };
    this.deferred.set(`${record.id}:${generation}`, d);
    record.promise = promise;
    return d;
  }

  /** Queue a separate user turn. Returns its generation immediately. */
  enqueueTurn(
    id: string,
    prompt: string,
    signal?: AbortSignal,
    turn: { background?: boolean; notify?: boolean; bypassQueue?: boolean } = {},
  ): number | undefined {
    const record = this.agents.get(id);
    if (!record || record.phase === "terminated") return undefined;
    const generation = ++record.generation;
    record.resultConsumed = false;
    this.createTurn(record, generation);
    const background = turn.background ?? true;
    const item: WorkItem = {
      id, generation, prompt, initial: false, signal, background,
      notify: turn.notify ?? background,
      bypassQueue: turn.bypassQueue ?? !background,
    };
    if (signal) {
      const cancel = () => this.cancelQueuedTurn(item);
      signal.addEventListener("abort", cancel, { once: true });
      item.detachSignal = () => signal.removeEventListener("abort", cancel);
    }
    this.queue.push(item);
    this.recomputePhase(record);
    if (signal?.aborted) this.cancelQueuedTurn(item);
    else this.drainQueue();
    return generation;
  }

  /** Synchronous resume captures and consumes exactly its own generation. */
  async resume(id: string, prompt: string, signal?: AbortSignal): Promise<AgentTurnSnapshot | undefined> {
    const generation = this.enqueueTurn(id, prompt, signal, {
      background: false, notify: false, bypassQueue: true,
    });
    if (generation == null) return undefined;
    this.consumeGeneration(id, generation);
    return this.waitForGeneration(id, generation);
  }

  private cancelQueuedTurn(item: WorkItem): void {
    const index = this.queue.indexOf(item);
    if (index < 0) return; // already running or settled
    this.queue.splice(index, 1);
    item.detachSignal?.();
    item.detachSignal = undefined;
    const record = this.agents.get(item.id);
    if (record) this.settleTurn(record, item, "stopped", undefined, undefined, false);
    this.drainQueue();
  }

  private recomputePhase(record: AgentRecord): void {
    if (record.phase === "terminated") return;
    record.phase = this.active.has(record.id)
      ? "working"
      : this.queue.some(item => item.id === record.id) ? "queued" : "idle";
  }

  private runningBackgroundCount(): number {
    return [...this.activeItems.values()].filter(item => item.background).length;
  }

  private drainQueue(): void {
    while (true) {
      const hasSlot = this.runningBackgroundCount() < this.maxConcurrent;
      const index = this.queue.findIndex(item => !this.active.has(item.id) && (item.bypassQueue || hasSlot));
      if (index < 0) break;
      const [item] = this.queue.splice(index, 1);
      item.detachSignal?.();
      item.detachSignal = undefined;
      const record = this.agents.get(item.id);
      if (!record || record.phase === "terminated") {
        if (record) this.settleTurn(record, item, "stopped", undefined, undefined, false);
        continue;
      }
      this.startItem(item, item.propagateStartupFailure === true);
    }
  }

  private startItem(item: WorkItem, propagateStartupFailure = false): void {
    const record = this.agents.get(item.id);
    const runtime = this.runtimes.get(item.id);
    if (!record || !runtime || record.phase === "terminated") return;
    if (item.initial && runtime.options.isolation === "worktree") {
      const wt = createWorktree(runtime.ctx.cwd, record.id);
      if (!wt) {
        const message = 'Cannot run with isolation: "worktree" — not a git repo, no commits yet, or `git worktree add` failed.';
        this.settleTurn(record, item, "error", undefined, message, !propagateStartupFailure);
        if (propagateStartupFailure) {
          if (!item.background) this.removeRecord(record.id, record);
          throw new Error(message);
        }
        return;
      }
      record.worktree = wt;
      runtime.worktreeCwd = wt.path;
    }
    item.startedAt = Date.now();
    // Compatibility fields describe the newest generation, not whichever older
    // queued item happens to acquire the session next.
    if (item.generation === record.generation) {
      record.status = "running";
      record.startedAt = item.startedAt;
      record.completedAt = undefined;
      record.result = undefined;
      record.error = undefined;
    }
    this.active.add(record.id);
    this.activeItems.set(record.id, item);
    this.recomputePhase(record);
    this.onStart?.(record);

    const callbacks = {
      onToolActivity: (activity: ToolActivity) => { if (activity.type === "end") record.toolUses++; runtime.options.onToolActivity?.(activity); },
      onTextDelta: runtime.options.onTextDelta,
      onTurnEnd: runtime.options.onTurnEnd,
      onAssistantUsage: (usage: { input: number; output: number; cacheWrite: number }) => { addUsage(record.lifetimeUsage, usage); runtime.options.onAssistantUsage?.(usage); },
      onCompaction: (info: CompactionInfo) => { record.compactionCount++; this.onCompact?.(record, info); runtime.options.onCompaction?.(info); },
    };
    const execution = item.initial
      ? runAgent(runtime.ctx, runtime.type, item.prompt, {
          pi: runtime.pi, agentId: record.id, model: runtime.options.model, maxTurns: runtime.options.maxTurns,
          isolated: runtime.options.isolated, inheritContext: runtime.options.inheritContext,
          thinkingLevel: runtime.options.thinkingLevel, cwd: runtime.worktreeCwd,
          signal: item.signal, ...callbacks,
          onSessionCreated: (session) => { record.session = session; runtime.options.onSessionCreated?.(session); },
        }).then(r => { record.session = r.session; return { text: r.responseText, status: r.aborted ? "aborted" as const : r.steered ? "steered" as const : "completed" as const }; })
      : record.session
        ? resumeAgent(record.session, item.prompt, { ...callbacks, maxTurns: runtime.options.maxTurns, signal: item.signal })
            .then(r => ({ text: r.cancelled ? "" : r.responseText, status: r.cancelled ? "stopped" as const : r.aborted ? "aborted" as const : r.steered ? "steered" as const : "completed" as const }))
        : Promise.reject(new Error("Agent session is not ready"));

    const release = () => {
      item.quiesced = true;
      this.active.delete(record.id);
      this.activeItems.delete(record.id);
    };
    const task = execution
      .then(({ text, status }) => {
        release();
        this.settleTurn(record, item, status, text, undefined, item.notify !== false);
      }, err => {
        release();
        this.settleTurn(record, item, "error", undefined, err instanceof Error ? err.message : String(err), item.notify !== false);
      })
      .finally(() => {
        this.activeTasks.delete(record.id);
        if (record.worktree && item.quiesced && !item.checkpointed) {
          const checkpoint = checkpointWorktree(record.worktree, `${record.description} (turn ${item.generation})`);
          item.checkpointed = true;
          if (checkpoint.hasChanges) record.worktreeResult = checkpoint;
          if (checkpoint.error) {
            const message = `Worktree checkpoint failed: ${checkpoint.error}`;
            record.error = record.error ? `${record.error}\n${message}` : message;
          }
        }
        if (record.phase === "terminated") this.cleanupRecordResources(record);
        this.drainQueue();
      });
    this.activeTasks.set(record.id, task);
  }

  private settleTurn(
    record: AgentRecord,
    item: WorkItem,
    status: AgentTurnSnapshot["status"],
    result?: string,
    error?: string,
    notify = true,
  ): AgentTurnSnapshot {
    const key = `${record.id}:${item.generation}`;
    const existing = this.snapshots.get(key);
    if (existing) return existing;
    if (record.phase === "terminated") status = "stopped";

    if (record.worktree && item.quiesced) {
      const checkpoint = checkpointWorktree(record.worktree, `${record.description} (turn ${item.generation})`);
      item.checkpointed = true;
      if (checkpoint.error) {
        const checkpointError = `Worktree checkpoint failed: ${checkpoint.error}`;
        error = error ? `${error}\n${checkpointError}` : checkpointError;
        status = "error";
      } else if (checkpoint.hasChanges && checkpoint.branch) {
        record.worktreeResult = checkpoint;
        result = (result ?? "") + `\n\n---\nChanges saved to branch \`${checkpoint.branch}\`. Merge with: \`git merge ${checkpoint.branch}\``;
      }
    }

    const completedAt = Date.now();
    const snapshot = Object.freeze({
      agentId: record.id, generation: item.generation, status, result, error,
      startedAt: item.startedAt ?? record.startedAt, completedAt, toolUses: record.toolUses,
      lifetimeUsage: Object.freeze({ ...record.lifetimeUsage }), compactionCount: record.compactionCount,
    });
    this.snapshots.set(key, snapshot);
    record.turnResults.set(item.generation, snapshot);
    if (item.generation === record.generation) {
      record.status = status; record.result = result; record.error = error; record.completedAt = completedAt;
    }
    this.recomputePhase(record);
    if (!item.background) {
      record.parentAbortDetach?.(); record.parentAbortDetach = undefined;
    }
    const deferred = this.deferred.get(key);
    if (deferred && !deferred.settled) {
      deferred.settled = true;
      deferred.resolve(result ?? "");
    }
    if (notify) {
      try { this.onComplete?.(record, snapshot); } catch { /* completion side effects are isolated */ }
    }
    return snapshot;
  }

  async spawnAndWait(pi: ExtensionAPI, ctx: ExtensionContext, type: SubagentType, prompt: string, options: Omit<SpawnOptions, "isBackground">): Promise<AgentRecord> {
    const id = this.spawn(pi, ctx, type, prompt, { ...options, isBackground: false });
    const record = this.agents.get(id)!;
    await record.promise;
    return record;
  }

  getRecord(id: string): AgentRecord | undefined { return this.agents.get(id); }
  listAgents(conversationId?: string): AgentRecord[] {
    return [...this.agents.values()].filter(a => conversationId == null || a.conversationId === conversationId).sort((a, b) => b.startedAt - a.startedAt);
  }
  captureGeneration(id: string): number | undefined { return this.agents.get(id)?.generation; }
  getTurnResult(id: string, generation: number): AgentTurnSnapshot | undefined { return this.snapshots.get(`${id}:${generation}`); }
  async waitForGeneration(id: string, generation: number): Promise<AgentTurnSnapshot | undefined> {
    await this.deferred.get(`${id}:${generation}`)?.promise;
    return this.snapshots.get(`${id}:${generation}`);
  }
  consumeGeneration(id: string, generation: number): void {
    const r = this.agents.get(id); if (!r) return;
    r.consumedGenerations.add(generation); if (generation === r.generation) r.resultConsumed = true;
  }

  abort(id: string): boolean {
    const record = this.agents.get(id);
    if (!record || record.phase === "terminated") return false;
    // Terminal first, then atomically remove this agent's queue. Settling cannot reenter drain.
    record.phase = "terminated"; record.status = "stopped"; record.completedAt = Date.now();
    const removed: WorkItem[] = [];
    const remaining: WorkItem[] = [];
    for (const item of this.queue) (item.id === id ? removed : remaining).push(item);
    this.queue = remaining;
    for (const item of removed) {
      item.detachSignal?.();
      this.settleTurn(record, item, "stopped", undefined, undefined, false);
    }
    const activeItem = this.activeItems.get(id);
    if (activeItem) this.settleTurn(record, activeItem, "stopped");

    record.parentAbortDetach?.(); record.parentAbortDetach = undefined;
    try { record.session?.abortBash(); } catch {}
    try { void record.session?.abort(); } catch {}
    record.abortController?.abort();
    logger.warn("agent-manager", "Agent stopped", { conversationId: record.conversationId, agentId: id });
    // Do not release an active slot here; prompt settlement owns it.
    if (!activeItem) this.cleanupRecordResources(record);
    this.drainQueue();
    return true;
  }

  private cleanupRecordResources(record: AgentRecord): void {
    record.parentAbortDetach?.();
    record.parentAbortDetach = undefined;
    record.outputCleanup?.(); record.outputCleanup = undefined;
    const runtime = this.runtimes.get(record.id);
    if (record.worktree && runtime) {
      try {
        const cleanup = cleanupWorktree(runtime.ctx.cwd, record.worktree, record.description);
        if (cleanup.hasChanges || !record.worktreeResult) record.worktreeResult = cleanup;
      } catch {}
      record.worktree = undefined;
    }
    record.session?.dispose?.(); record.session = undefined;
  }

  private removeRecord(id: string, record: AgentRecord): void {
    this.cleanupRecordResources(record);
    this.agents.delete(id); this.runtimes.delete(id);
    for (const key of this.deferred.keys()) if (key.startsWith(`${id}:`)) this.deferred.delete(key);
    for (const key of this.snapshots.keys()) if (key.startsWith(`${id}:`)) this.snapshots.delete(key);
  }

  /** Session switch cleanup: terminate and dispose every record, including idle. */
  clearCompleted(): void {
    for (const [id, r] of this.agents) {
      if ((r.phase === "idle" || r.phase === "terminated") && !this.active.has(id)) this.removeRecord(id, r);
    }
  }
  hasRunning(): boolean { return [...this.agents.values()].some(r => r.phase === "working" || r.phase === "queued"); }
  /** Stop only records with active or queued work; reusable idle sessions survive. */
  abortActive(): number {
    let count = 0;
    for (const record of [...this.agents.values()]) {
      if ((record.phase === "working" || record.phase === "queued") && this.abort(record.id)) count++;
    }
    return count;
  }
  abortAll(): number { let n = 0; for (const r of [...this.agents.values()]) if (r.phase !== "terminated") { if (this.abort(r.id)) n++; } return n; }
  /** Stop every generation and wait until all underlying prompt executions quiesce. */
  async terminateAll(): Promise<number> {
    const count = this.abortAll();
    while (this.activeTasks.size > 0) await Promise.allSettled([...this.activeTasks.values()]);
    return count;
  }
  async waitForAll(): Promise<void> {
    while (this.queue.length || this.active.size) {
      this.drainQueue();
      const promises = [...this.active].map(id => this.agents.get(id)?.promise).filter(Boolean) as Promise<string>[];
      if (promises.length) await Promise.allSettled(promises); else await Promise.resolve();
    }
  }
  async dispose(): Promise<void> {
    clearInterval(this.cleanupInterval);
    await this.terminateAll();
    for (const [id, r] of [...this.agents]) this.removeRecord(id, r);
    this.queue = [];
    try { pruneWorktrees(process.cwd()); } catch {}
  }
}
