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
