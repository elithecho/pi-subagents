import { describe, expect, it, vi } from "vitest";
import { AgentNavigationEditor } from "../src/ui/agent-editor-wrapper.js";

function baseEditor(text = "") {
  let value = text;
  return {
    render: vi.fn(() => []), invalidate: vi.fn(),
    getText: vi.fn(() => value), setText: vi.fn((next: string) => { value = next; }),
    handleInput: vi.fn(),
  } as any;
}

function widget() {
  const records = [{ id: "one" }, { id: "two" }] as any[];
  let selected = -1;
  return {
    focusList: vi.fn(() => { selected = 0; return true; }),
    leaveList: vi.fn(() => { selected = -1; }),
    moveSelection: vi.fn((delta: number) => { selected = Math.max(0, Math.min(1, selected + delta)); }),
    selectedAgent: vi.fn(() => selected >= 0 ? records[selected] : undefined),
  } as any;
}

describe("AgentNavigationEditor", () => {
  it("forwards focus and key-release component state", () => {
    const base = Object.assign(baseEditor(), { focused: false, wantsKeyRelease: true });
    const editor = new AgentNavigationEditor(base, widget(), vi.fn());

    editor.focused = true;
    expect(base.focused).toBe(true);
    expect(editor.focused).toBe(true);
    expect(editor.wantsKeyRelease).toBe(true);
    editor.wantsKeyRelease = false;
    expect(base.wantsKeyRelease).toBe(false);
  });

  it("ignores owned Kitty releases and delegates unrelated releases", () => {
    const base = Object.assign(baseEditor(), { focused: true, wantsKeyRelease: true });
    const agents = widget();
    const editor = new AgentNavigationEditor(base, agents, vi.fn());
    editor.handleInput("\u001b[B");

    editor.handleInput("\u001b[1;1:3B");
    expect(agents.moveSelection).not.toHaveBeenCalled();

    const unrelatedRelease = "\u001b[120;1:3u";
    editor.handleInput(unrelatedRelease);
    expect(base.handleInput).toHaveBeenCalledWith(unrelatedRelease);
  });

  it("preserves CustomEditor-style app handler properties", () => {
    const base = Object.assign(baseEditor(), {
      actionHandlers: new Map(), onEscape: vi.fn(), onCtrlD: vi.fn(),
    });
    const editor = new AgentNavigationEditor(base, widget(), vi.fn());

    expect(editor.actionHandlers).toBe(base.actionHandlers);
    expect(editor.onEscape).toBe(base.onEscape);
    const replacement = vi.fn();
    editor.onCtrlD = replacement;
    expect(base.onCtrlD).toBe(replacement);
  });

  it("waits for idle before submitting restored text and clears only after acknowledgement", async () => {
    const base = Object.assign(baseEditor(), {
      onEscape: vi.fn(() => { base.setText("queued"); }),
    });
    let becomeIdle!: (active: boolean) => void;
    let acknowledge!: (submitted: boolean) => void;
    const waitForIdle = vi.fn(() => new Promise<boolean>(resolve => { becomeIdle = resolve; }));
    const submit = vi.fn(() => new Promise<boolean>(resolve => { acknowledge = resolve; }));
    const editor = new AgentNavigationEditor(base, widget(), vi.fn(), () => true, waitForIdle, submit, vi.fn(() => true));

    editor.handleInput("\u0002");

    expect(base.onEscape).toHaveBeenCalledOnce();
    expect(waitForIdle).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
    expect(base.getText()).toBe("queued");

    becomeIdle(true);
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());

    expect(submit).toHaveBeenCalledWith("queued");
    expect(base.getText()).toBe("queued");
    acknowledge(true);
    await vi.waitFor(() => expect(base.getText()).toBe(""));
    expect(base.handleInput).not.toHaveBeenCalled();
  });

  it("releases list focus before interrupting", () => {
    const order: string[] = [];
    const base = Object.assign(baseEditor(), {
      onEscape: vi.fn(() => {
        order.push("escape");
        base.setText("queued");
      }),
    });
    const agents = widget();
    agents.leaveList.mockImplementation(() => { order.push("leave"); });
    const editor = new AgentNavigationEditor(base, agents, vi.fn(), () => true, () => new Promise(() => {}), undefined, vi.fn(() => true));
    editor.handleInput("\u001b[B");

    editor.handleInput("\u0002");

    expect(order).toEqual(["leave", "escape"]);
  });

  it("does not submit restored text changed by the user while waiting", async () => {
    const base = Object.assign(baseEditor(), {
      onEscape: vi.fn(() => { base.setText("queued"); }),
    });
    let becomeIdle!: (active: boolean) => void;
    const submit = vi.fn(() => true);
    const editor = new AgentNavigationEditor(
      base, widget(), vi.fn(), () => true,
      () => new Promise<boolean>(resolve => { becomeIdle = resolve; }), submit, vi.fn(() => true),
    );
    editor.handleInput("\u0002");
    base.setText("edited");

    becomeIdle(true);
    await Promise.resolve();

    expect(submit).not.toHaveBeenCalled();
    expect(base.getText()).toBe("edited");
  });

  it.each([
    ["rejected", async () => false],
    ["failed", async () => { throw new Error("send failed"); }],
  ])("retains restored text when submission is %s", async (_label, result) => {
    const base = Object.assign(baseEditor(), {
      onEscape: vi.fn(() => { base.setText("queued"); }),
    });
    const submit = vi.fn(result);
    const editor = new AgentNavigationEditor(base, widget(), vi.fn(), () => true, async () => true, submit, vi.fn(() => true));

    editor.handleInput("\u0002");
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());

    expect(base.getText()).toBe("queued");
  });

  it("retains restored text and skips submission when the session is no longer active", async () => {
    const base = Object.assign(baseEditor(), {
      onEscape: vi.fn(() => { base.setText("queued"); }),
    });
    const submit = vi.fn(() => true);
    const editor = new AgentNavigationEditor(base, widget(), vi.fn(), () => true, async () => false, submit, vi.fn(() => true));

    editor.handleInput("\u0002");
    await Promise.resolve();

    expect(submit).not.toHaveBeenCalled();
    expect(base.getText()).toBe("queued");
  });

  it("ignores repeated Ctrl+B while the transition is active", async () => {
    const base = Object.assign(baseEditor(), {
      onEscape: vi.fn(() => { base.setText("queued"); }),
    });
    let becomeIdle!: (active: boolean) => void;
    const submit = vi.fn(() => true);
    const editor = new AgentNavigationEditor(
      base, widget(), vi.fn(), () => true,
      () => new Promise<boolean>(resolve => { becomeIdle = resolve; }), submit, vi.fn(() => true),
    );

    editor.handleInput("\u0002");
    editor.handleInput("\u0002");
    expect(base.onEscape).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();

    becomeIdle(true);
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
  });

  it("calls promoteForegroundAgent before onEscape during Ctrl+B with pending messages", async () => {
    const base = Object.assign(baseEditor(), {
      onEscape: vi.fn(() => { base.setText("queued"); }),
    });
    const promote = vi.fn(() => true);
    const editor = new AgentNavigationEditor(
      base, widget(), vi.fn(), () => true,
      async () => true, vi.fn(() => true), promote,
    );

    editor.handleInput("\u0002");

    // promoteForegroundAgent called BEFORE onEscape
    expect(promote).toHaveBeenCalledOnce();
    expect(base.onEscape).toHaveBeenCalledOnce();
    // onEscape called after promote
    expect(promote.mock.invocationCallOrder[0]).toBeLessThan(base.onEscape!.mock.invocationCallOrder[0]);
  });

  it("delegates Ctrl+B when promoteForegroundAgent returns false (no eligible agent)", () => {
    const base = Object.assign(baseEditor(), {
      onEscape: vi.fn(() => { base.setText("queued"); }),
    });
    const promote = vi.fn(() => false);
    const editor = new AgentNavigationEditor(
      base, widget(), vi.fn(), () => true,
      () => new Promise(() => {}), () => false, promote,
    );

    editor.handleInput("\u0002");

    // Promotion returned false — onEscape must NOT be called, delegate to base
    expect(promote).toHaveBeenCalledOnce();
    expect(base.onEscape).not.toHaveBeenCalled();
    expect(base.handleInput).toHaveBeenCalledWith("\u0002");
  });

  it("delegates Ctrl+B when promoteForegroundAgent throws (fail-closed)", () => {
    const base = Object.assign(baseEditor(), {
      onEscape: vi.fn(() => { base.setText("queued"); }),
    });
    const promote = vi.fn(() => { throw new Error("promotion failed"); });
    const editor = new AgentNavigationEditor(
      base, widget(), vi.fn(), () => true,
      () => new Promise(() => {}), () => false, promote,
    );

    editor.handleInput("\u0002");

    // Promotion threw — onEscape must NOT be called, delegate to base
    expect(promote).toHaveBeenCalledOnce();
    expect(base.onEscape).not.toHaveBeenCalled();
    expect(base.handleInput).toHaveBeenCalledWith("\u0002");
  });

  it("delegates Ctrl+B unchanged when no messages are pending", () => {
    const base = baseEditor();
    const editor = new AgentNavigationEditor(base, widget(), vi.fn(), () => false);

    editor.handleInput("\u0002");

    expect(base.handleInput).toHaveBeenCalledWith("\u0002");
  });

  it("delegates Ctrl+B when onEscape is unavailable", () => {
    const base = baseEditor();
    const editor = new AgentNavigationEditor(base, widget(), vi.fn(), () => true);

    editor.handleInput("\u0002");

    expect(base.handleInput).toHaveBeenCalledWith("\u0002");
  });

  it("does not wait or submit when interrupting leaves text unchanged", () => {
    const base = Object.assign(baseEditor("draft"), { onEscape: vi.fn() });
    const waitForIdle = vi.fn(async () => true);
    const submit = vi.fn(() => true);
    const editor = new AgentNavigationEditor(base, widget(), vi.fn(), () => true, waitForIdle, submit, vi.fn(() => true));

    editor.handleInput("\u0002");

    expect(base.onEscape).toHaveBeenCalledOnce();
    expect(waitForIdle).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(base.handleInput).not.toHaveBeenCalled();
  });

  it("delegates unchanged while a parent draft exists", () => {
    const base = baseEditor("draft");
    const agents = widget();
    const editor = new AgentNavigationEditor(base, agents, vi.fn());

    editor.handleInput("\u001b[B");

    expect(base.handleInput).toHaveBeenCalledWith("\u001b[B");
    expect(agents.focusList).not.toHaveBeenCalled();
  });

  it("owns list keys only after empty-editor Down and guards async opening", async () => {
    const base = baseEditor();
    const agents = widget();
    let finish!: () => void;
    const open = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const editor = new AgentNavigationEditor(base, agents, open);

    editor.handleInput("\u001b[B");
    editor.handleInput("\u001b[B");
    editor.handleInput("\r");
    editor.handleInput("\r");

    expect(agents.focusList).toHaveBeenCalledOnce();
    expect(agents.moveSelection).toHaveBeenCalledWith(1);
    expect(open).toHaveBeenCalledOnce();
    expect(base.handleInput).not.toHaveBeenCalled();
    finish();
    await Promise.resolve();

    editor.handleInput("\u001b");
    expect(agents.leaveList).toHaveBeenCalledOnce();
  });

  it("delegates unhandled keys and leaves list focus", () => {
    const base = baseEditor();
    const agents = widget();
    const editor = new AgentNavigationEditor(base, agents, vi.fn());
    editor.handleInput("\u001b[B");

    editor.handleInput("x");

    expect(agents.leaveList).toHaveBeenCalledOnce();
    expect(base.handleInput).toHaveBeenCalledWith("x");
  });
});
