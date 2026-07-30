import { describe, expect, it, vi } from "vitest";
import { AgentNavigationEditor, wrapEditorFactory } from "../src/ui/agent-editor-wrapper.js";

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

  it("dequeues and immediately submits restored text", async () => {
    const base = Object.assign(baseEditor(), {
      actionHandlers: new Map([["dequeue", vi.fn(() => { base.setText("queued"); })]]),
    });
    const submit = vi.fn(() => true);
    const editor = new AgentNavigationEditor(base, widget(), vi.fn(), () => true, undefined, submit, vi.fn(() => true));

    editor.handleInput("\u0002");
    // Drain microtask queue so dequeueAndSubmit settles
    await Promise.resolve();

    expect(base.actionHandlers.get("dequeue")).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledWith("queued");
    // Editor cleared on successful submission
    expect(base.getText()).toBe("");
    expect(base.handleInput).not.toHaveBeenCalled();
  });

  it("releases list focus before dequeue", () => {
    const order: string[] = [];
    const base = Object.assign(baseEditor(), {
      actionHandlers: new Map([["dequeue", vi.fn(() => {
        order.push("dequeue");
        base.setText("queued");
      })]]),
    });
    const agents = widget();
    agents.leaveList.mockImplementation(() => { order.push("leave"); });
    const editor = new AgentNavigationEditor(base, agents, vi.fn(), () => true, undefined, () => false, vi.fn(() => true));
    editor.handleInput("\u001b[B");

    editor.handleInput("\u0002");

    expect(order).toEqual(["leave", "dequeue"]);
  });

  it("does not clear restored text when user edits during async submission", async () => {
    const base = Object.assign(baseEditor(), {
      actionHandlers: new Map([["dequeue", vi.fn(() => { base.setText("queued"); })]]),
    });
    let acknowledge!: (submitted: boolean) => void;
    const submit = vi.fn(() => new Promise<boolean>(resolve => { acknowledge = resolve; }));
    const editor = new AgentNavigationEditor(
      base, widget(), vi.fn(), () => true, undefined, submit, vi.fn(() => true),
    );

    editor.handleInput("\u0002");
    // submit called immediately with restored text
    expect(submit).toHaveBeenCalledWith("queued");
    // User edits the text while submission is in-flight
    base.setText("edited by user");

    acknowledge(true);
    await Promise.resolve();

    // Editor retains user's edit instead of clearing
    expect(base.getText()).toBe("edited by user");
  });

  it.each([
    ["rejected", async () => false],
    ["failed", async () => { throw new Error("send failed"); }],
  ])("retains restored text when submission is %s", async (_label, result) => {
    const base = Object.assign(baseEditor(), {
      actionHandlers: new Map([["dequeue", vi.fn(() => { base.setText("queued"); })]]),
    });
    const submit = vi.fn(result);
    const editor = new AgentNavigationEditor(base, widget(), vi.fn(), () => true, undefined, submit, vi.fn(() => true));

    editor.handleInput("\u0002");
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());

    expect(base.getText()).toBe("queued");
  });



  it("ignores repeated Ctrl+B while the transition is active", async () => {
    const base = Object.assign(baseEditor(), {
      actionHandlers: new Map([["dequeue", vi.fn(() => { base.setText("queued"); })]]),
    });
    const submit = vi.fn(() => true);
    const editor = new AgentNavigationEditor(
      base, widget(), vi.fn(), () => true, undefined, submit, vi.fn(() => true),
    );

    editor.handleInput("\u0002");
    editor.handleInput("\u0002");
    expect(base.actionHandlers.get("dequeue")).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledOnce();
    // Drain microtask queue so dequeueAndSubmit settles
    await Promise.resolve();
    expect(base.getText()).toBe("");
  });

  it("calls promoteForegroundAgent before dequeue during Ctrl+B with pending messages", async () => {
    const base = Object.assign(baseEditor(), {
      actionHandlers: new Map([["dequeue", vi.fn(() => { base.setText("queued"); })]]),
    });
    const promote = vi.fn(() => true);
    const editor = new AgentNavigationEditor(
      base, widget(), vi.fn(), () => true, undefined, vi.fn(() => true), promote,
    );

    editor.handleInput("\u0002");

    expect(promote).toHaveBeenCalledOnce();
    expect(base.actionHandlers.get("dequeue")).toHaveBeenCalledOnce();
    expect(promote.mock.invocationCallOrder[0]).toBeLessThan(
      base.actionHandlers.get("dequeue").mock.invocationCallOrder[0]
    );
  });

  it("delegates Ctrl+B when promoteForegroundAgent returns false (no eligible agent)", () => {
    const base = Object.assign(baseEditor(), {
      actionHandlers: new Map([["dequeue", vi.fn()]]),
    });
    const promote = vi.fn(() => false);
    const editor = new AgentNavigationEditor(
      base, widget(), vi.fn(), () => true, undefined, () => false, promote,
    );

    editor.handleInput("\u0002");

    // Promotion returned false — delegate to base, no dequeue
    expect(promote).toHaveBeenCalledOnce();
    expect(base.handleInput).toHaveBeenCalledWith("\u0002");
  });

  it("delegates Ctrl+B when promoteForegroundAgent throws (fail-closed)", () => {
    const base = Object.assign(baseEditor(), {
      actionHandlers: new Map([["dequeue", vi.fn()]]),
    });
    const promote = vi.fn(() => { throw new Error("promotion failed"); });
    const editor = new AgentNavigationEditor(
      base, widget(), vi.fn(), () => true, undefined, () => false, promote,
    );

    editor.handleInput("\u0002");

    // Promotion threw — delegate to base, no dequeue
    expect(promote).toHaveBeenCalledOnce();
    expect(base.handleInput).toHaveBeenCalledWith("\u0002");
  });

  it("delegates Ctrl+B unchanged when no messages are pending", () => {
    const base = baseEditor();
    const editor = new AgentNavigationEditor(base, widget(), vi.fn(), () => false);

    editor.handleInput("\u0002");

    expect(base.handleInput).toHaveBeenCalledWith("\u0002");
  });

  it("delegates Ctrl+B when dequeue is unavailable", () => {
    const base = baseEditor();
    const editor = new AgentNavigationEditor(base, widget(), vi.fn(), () => true);

    editor.handleInput("\u0002");

    expect(base.handleInput).toHaveBeenCalledWith("\u0002");
  });

  it("does not submit when dequeue leaves text unchanged", () => {
    const base = Object.assign(baseEditor("draft"), {
      actionHandlers: new Map([["dequeue", vi.fn()]]),
    });
    const submit = vi.fn(() => true);
    const editor = new AgentNavigationEditor(base, widget(), vi.fn(), () => true, undefined, submit, vi.fn(() => true));

    editor.handleInput("\u0002");

    expect(base.actionHandlers.get("dequeue")).toHaveBeenCalledOnce();
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

  describe("compatibility and edge cases", () => {
    it("does not invoke deprecated waitForIdle callback during Ctrl+B", async () => {
      const base = Object.assign(baseEditor(), {
        actionHandlers: new Map([["dequeue", vi.fn(() => { base.setText("queued"); })]]),
      });
      const waitForIdle = vi.fn(async () => true);
      const submit = vi.fn(() => true);
      const editor = new AgentNavigationEditor(
        base, widget(), vi.fn(), () => true, waitForIdle, submit, vi.fn(() => true),
      );

      editor.handleInput("\u0002");
      await Promise.resolve();

      // deprecated waitForIdle must never be called
      expect(waitForIdle).not.toHaveBeenCalled();
      // dequeue and submit still happen
      expect(base.actionHandlers.get("dequeue")).toHaveBeenCalledOnce();
      expect(submit).toHaveBeenCalledWith("queued");
    });

    it("does not delegate Ctrl+B to base after successful promotion when dequeue throws", async () => {
      const base = Object.assign(baseEditor(), {
        actionHandlers: new Map([["dequeue", vi.fn(() => { throw new Error("dequeue failed"); })]]),
      });
      const submit = vi.fn(() => true);
      const editor = new AgentNavigationEditor(
        base, widget(), vi.fn(), () => true, undefined, submit, vi.fn(() => true),
      );

      editor.handleInput("\u0002");
      await Promise.resolve();

      // base.handleInput must NOT be called (no delegation to conflicting Ctrl+B)
      expect(base.handleInput).not.toHaveBeenCalled();
      // submit not called (dequeue threw before reading text)
      expect(submit).not.toHaveBeenCalled();
    });

    it("preserves restored text when dequeue handler throws after partial modification", async () => {
      let text = "initial";
      const base = {
        render: vi.fn(() => []), invalidate: vi.fn(),
        getText: vi.fn(() => text), setText: vi.fn((t: string) => { text = t; }),
        handleInput: vi.fn(),
        actionHandlers: new Map([["dequeue", vi.fn(() => {
          text = "partially-restored";
          throw new Error("dequeue crash");
        })]]),
      } as any;
      const submit = vi.fn(() => true);
      const editor = new AgentNavigationEditor(
        base, widget(), vi.fn(), () => true, undefined, submit, vi.fn(() => true),
      );

      editor.handleInput("\u0002");
      await Promise.resolve();

      // restored text survives the throw, available for user to see/retry
      expect(text).toBe("partially-restored");
      expect(base.handleInput).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
    });

    it("uses the \"dequeue\" action key from actionHandlers", () => {
      const base = Object.assign(baseEditor(), {
        actionHandlers: new Map([["dequeue", vi.fn(() => { base.setText("queued"); })]]),
      });
      const editor = new AgentNavigationEditor(
        base, widget(), vi.fn(), () => true, undefined, vi.fn(() => true), vi.fn(() => true),
      );

      editor.handleInput("\u0002");

      // The framework AppAction type uses "dequeue" (not "app.message.dequeue")
      expect(base.actionHandlers.get("dequeue")).toHaveBeenCalledOnce();
    });

    it("clears editor on synchronous submit success after dequeue", async () => {
      const base = Object.assign(baseEditor(), {
        actionHandlers: new Map([["dequeue", vi.fn(() => { base.setText("queued"); })]]),
      });
      const submit = vi.fn(() => true);
      const editor = new AgentNavigationEditor(
        base, widget(), vi.fn(), () => true, undefined, submit, vi.fn(() => true),
      );

      editor.handleInput("\u0002");
      await Promise.resolve();

      // pi.sendUserMessage returns void — synchronous true is the strongest
      // available acceptance signal. Duplicate submission is prevented by the
      // editor-cleared guard.
      expect(base.getText()).toBe("");
    });

    describe("wrapEditorFactory positional wiring", () => {
      it("passes submitRestoredMessage at position 6 and promoteForegroundAgent at position 7", async () => {
        const base = Object.assign(baseEditor(), {
          actionHandlers: new Map([["dequeue", vi.fn(() => { base.setText("queued"); })]]),
        });
        const submit = vi.fn(() => true);
        const promote = vi.fn(() => true);

        // Simulate the production call pattern:
        // (previous, widget, openAgent, hasPending, waitForIdle, submit, promote)
        const wrapped = wrapEditorFactory(
          undefined,
          widget(),
          vi.fn(),
          () => true,           // hasPendingMessages
          undefined,            // waitForIdle (deprecated, unused)
          submit,               // submitRestoredMessage
          promote,              // promoteForegroundAgent
        );
        const editor = wrapped({} as any, {} as any, {} as any) as AgentNavigationEditor;
        // Inject the base editor into the wrapper's inner editor
        (editor as any).base = base;

        editor.handleInput("\u0002");
        await Promise.resolve();

        // If submit is in slot 6, it's called as submitRestoredMessage
        expect(submit).toHaveBeenCalledWith("queued");
        // If promote is in slot 7, it's called as promoteForegroundAgent
        expect(promote).toHaveBeenCalledOnce();
        expect(base.actionHandlers.get("dequeue")).toHaveBeenCalledOnce();
      });

      it("accepts deprecated waitForIdle at position 5 without creating a field", () => {
        const submit = vi.fn(() => true);

        const wrapped = wrapEditorFactory(
          undefined,
          widget(),
          vi.fn(),
          () => true,
          undefined,  // deprecated — accepted but no field created
          submit,
          vi.fn(() => true),
        );
        const editor = wrapped({} as any, {} as any, {} as any) as any;

        // Parameter was accepted without error — no field created on instance
        expect(editor._waitForIdle).toBeUndefined();
      });
    });
  });
});
