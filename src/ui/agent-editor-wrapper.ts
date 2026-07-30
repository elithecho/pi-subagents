import { CustomEditor } from "@mariozechner/pi-coding-agent";
import { type EditorComponent, type EditorTheme, isKeyRelease, matchesKey, type TUI } from "@mariozechner/pi-tui";
import type { AgentRecord } from "../types.js";
import type { AgentWidget } from "./agent-widget.js";

export type EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: any) => EditorComponent;

/** Editor-only agent navigation; it never receives input while another overlay owns focus. */
export class AgentNavigationEditor implements EditorComponent {
  private listFocused = false;
  private opening = false;
  private ctrlBTransitionActive = false;

  constructor(
    private base: EditorComponent,
    private widget: AgentWidget,
    private openAgent: (record: AgentRecord) => Promise<void>,
    private hasPendingMessages: () => boolean = () => false,
    /** @deprecated Unused — Ctrl+B no longer waits for idle. Kept for API compatibility only (no field created). */
    _waitForIdle: () => Promise<boolean> = async () => true,
    /**
     * Fire-and-forget submit callback. pi.sendUserMessage returns void (no async ack),
     * so the only acceptance signals are: synchronous return `true` (call was issued)
     * or synchronous throw (message not queued). Return `false` to skip clearing the
     * editor and leave restored text visible for retry.
     */
    private submitRestoredMessage: (text: string) => boolean | Promise<boolean> = () => false,
    /** Callback to promote the running foreground agent to background before Ctrl+B. */
    private promoteForegroundAgent?: () => boolean,
  ) {}

  // Preserve TUI focus/cursor and Kitty key-release behavior through the proxy.
  get focused(): boolean { return "focused" in this.base ? Boolean((this.base as any).focused) : false; }
  set focused(value: boolean) {
    if ("focused" in this.base) (this.base as any).focused = value;
  }
  get wantsKeyRelease(): boolean | undefined { return this.base.wantsKeyRelease; }
  set wantsKeyRelease(value: boolean | undefined) { this.base.wantsKeyRelease = value; }

  // Preserve CustomEditor duck-typed app bindings when wrapping it.
  get actionHandlers() { return (this.base as any).actionHandlers; }
  get onEscape() { return (this.base as any).onEscape; }
  set onEscape(value) { (this.base as any).onEscape = value; }
  get onCtrlD() { return (this.base as any).onCtrlD; }
  set onCtrlD(value) { (this.base as any).onCtrlD = value; }
  get onPasteImage() { return (this.base as any).onPasteImage; }
  set onPasteImage(value) { (this.base as any).onPasteImage = value; }
  get onExtensionShortcut() { return (this.base as any).onExtensionShortcut; }
  set onExtensionShortcut(value) { (this.base as any).onExtensionShortcut = value; }

  get onSubmit() { return this.base.onSubmit; }
  set onSubmit(value) { this.base.onSubmit = value; }
  get onChange() { return this.base.onChange; }
  set onChange(value) { this.base.onChange = value; }
  get borderColor() { return this.base.borderColor; }
  set borderColor(value) { this.base.borderColor = value; }

  render(width: number): string[] { return this.base.render(width); }
  invalidate(): void { this.base.invalidate(); }
  getText(): string { return this.base.getText(); }
  setText(text: string): void { this.base.setText(text); }
  addToHistory(text: string): void { this.base.addToHistory?.(text); }
  insertTextAtCursor(text: string): void { this.base.insertTextAtCursor?.(text); }
  getExpandedText(): string { return this.base.getExpandedText?.() ?? this.base.getText(); }
  setAutocompleteProvider(provider: Parameters<NonNullable<EditorComponent["setAutocompleteProvider"]>>[0]): void {
    this.base.setAutocompleteProvider?.(provider);
  }
  setPaddingX(padding: number): void { this.base.setPaddingX?.(padding); }
  setAutocompleteMaxVisible(maxVisible: number): void { this.base.setAutocompleteMaxVisible?.(maxVisible); }

  handleInput(data: string): void {
    if (isKeyRelease(data)) {
      const ownsRelease = this.base.getText() === "" && (
        (!this.listFocused && matchesKey(data, "down")) ||
        (this.listFocused && (
          matchesKey(data, "up") || matchesKey(data, "down") ||
          matchesKey(data, "enter") || matchesKey(data, "escape")
        ))
      );
      if (!ownsRelease) this.base.handleInput(data);
      return;
    }

    if (matchesKey(data, "ctrl+b")) {
      if (this.ctrlBTransitionActive) return;
      if (this.hasPendingMessages()) {
        const dequeueHandler = this.actionHandlers?.get?.('dequeue');
        if (typeof dequeueHandler === "function") {
          // Promote before dequeue: if no eligible foreground agent or
          // promotion throws, delegate Ctrl+B unchanged (fail-closed).
          let promoted = false;
          try {
            promoted = this.promoteForegroundAgent?.() === true;
          } catch {
            // promotion threw — delegate to base, do not activate transition
            this.base.handleInput(data);
            return;
          }
          if (!promoted) {
            // no eligible foreground agent — delegate to base
            this.base.handleInput(data);
            return;
          }
          this.leaveList();
          this.ctrlBTransitionActive = true;
          void this.dequeueAndSubmit(dequeueHandler);
          return;
        }
      }
    }

    if (this.base.getText() !== "") {
      this.leaveList();
      this.base.handleInput(data);
      return;
    }

    if (!this.listFocused) {
      if (matchesKey(data, "down") && this.widget.focusList()) {
        this.listFocused = true;
        return;
      }
      this.base.handleInput(data);
      return;
    }

    if (matchesKey(data, "escape")) {
      this.leaveList();
      return;
    }
    if (matchesKey(data, "up")) { this.widget.moveSelection(-1); return; }
    if (matchesKey(data, "down")) { this.widget.moveSelection(1); return; }
    if (matchesKey(data, "enter")) {
      const record = this.widget.selectedAgent();
      if (record && !this.opening) {
        this.opening = true;
        void this.openAgent(record).finally(() => { this.opening = false; });
      }
      return;
    }

    this.leaveList();
    this.base.handleInput(data);
  }

  private async dequeueAndSubmit(dequeueHandler: () => void): Promise<void> {
    try {
      const before = this.base.getText();
      dequeueHandler();
      const restored = this.base.getText();
      if (restored.trim() === "" || restored === before) return;

      const submitted = await this.submitRestoredMessage(restored);
      if (submitted && this.base.getText() === restored) this.base.setText("");
    } catch {
      // Submission is fire-and-forget; leave restored text available for retry.
    } finally {
      this.ctrlBTransitionActive = false;
    }
  }

  private leaveList(): void {
    if (!this.listFocused) return;
    this.listFocused = false;
    this.widget.leaveList();
  }
}

export function wrapEditorFactory(
  previous: EditorFactory | undefined,
  widget: AgentWidget,
  openAgent: (record: AgentRecord) => Promise<void>,
  hasPendingMessages: () => boolean = () => false,
  /** @deprecated Unused — Ctrl+B no longer waits for idle. Kept for API compatibility only. */
  _waitForIdle: () => Promise<boolean> = async () => true,
  submitRestoredMessage: (text: string) => boolean | Promise<boolean> = () => false,
  promoteForegroundAgent?: () => boolean,
): EditorFactory {
  return (tui, theme, keybindings) => {
    const base = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
    return new AgentNavigationEditor(base, widget, openAgent, hasPendingMessages, _waitForIdle, submitRestoredMessage, promoteForegroundAgent);
  };
}
