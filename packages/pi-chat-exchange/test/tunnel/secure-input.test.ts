/**
 * HANDOFF-CE-HOST-09 B1.1 Task 1 — masked TUI credential capture.
 *
 * The module under test is loaded DYNAMICALLY so the first run fails with a
 * real assertion ("module namespace missing"), not a module-resolution crash
 * that would not count as Red evidence.
 *
 * Contract pinned here:
 * - `ctx.mode === "tui"` AND an available `ui.custom` are both required.
 * - the secret reaches ONLY the injected writer; never notify/input/editor/
 *   appendEntry/sendMessage, never the resolved outcome, never a render line.
 * - one idempotent finish for submit / cancel / Ctrl-C / timeout / abort.
 * - bounded single-line visible ASCII; atomic bracketed-paste validation;
 *   a pasted newline never submits.
 */
import { describe, expect, it, vi } from "vitest";

const SENTINEL = "sk-b11-synthetic-canary-0001";

type Done = (result: unknown) => void;
interface ComponentView {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate(): void;
  dispose?(): void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SecureInputModule = any;

const MODULE_SPECIFIER = "../../src/tunnel/secure-input.js";

async function load(): Promise<SecureInputModule | undefined> {
  try {
    return (await import(MODULE_SPECIFIER)) as SecureInputModule;
  } catch {
    return undefined;
  }
}

async function mod(): Promise<SecureInputModule> {
  const loaded = await load();
  expect(loaded, "src/tunnel/secure-input.ts module namespace").toBeDefined();
  expect(typeof loaded.captureTunnelSecret, "captureTunnelSecret export").toBe("function");
  return loaded as SecureInputModule;
}

interface Harness {
  ctx: {
    mode: string;
    hasUI: boolean;
    ui: {
      notify: ReturnType<typeof vi.fn>;
      input: ReturnType<typeof vi.fn>;
      setStatus: ReturnType<typeof vi.fn>;
      pasteToEditor: ReturnType<typeof vi.fn>;
      setEditorText: ReturnType<typeof vi.fn>;
      custom?: (factory: unknown, options?: unknown) => Promise<unknown>;
    };
  };
  component(): ComponentView;
  doneCalls(): number;
  render(): string;
  type(data: string): void;
  installed: Promise<void>;
}

function harness(options: { mode?: string; withCustom?: boolean } = {}): Harness {
  const mode = options.mode ?? "tui";
  let component: ComponentView | undefined;
  let doneCalls = 0;
  let settleInstalled!: () => void;
  const installed = new Promise<void>((resolve) => { settleInstalled = resolve; });
  const requestRender = vi.fn();
  const ui: Harness["ctx"]["ui"] = {
    notify: vi.fn(),
    input: vi.fn(),
    setStatus: vi.fn(),
    pasteToEditor: vi.fn(),
    setEditorText: vi.fn(),
  };
  if (options.withCustom !== false) {
    ui.custom = (factory: unknown) =>
      new Promise((resolve) => {
        const done: Done = (result) => { doneCalls += 1; resolve(result); };
        component = (factory as (tui: unknown, theme: unknown, kb: unknown, done: Done) => ComponentView)(
          { requestRender }, { style: (text: string) => text }, {}, done,
        );
        settleInstalled();
      });
  }
  return {
    ctx: { mode, hasUI: true, ui },
    component: () => {
      if (component === undefined) throw new Error("component was not installed");
      return component;
    },
    doneCalls: () => doneCalls,
    render: () => (component?.render(40) ?? []).join("\n"),
    type: (data: string) => component?.handleInput?.(data),
    installed,
  };
}

function writer(): { store: ReturnType<typeof vi.fn>; stored: string[] } {
  const stored: string[] = [];
  return { store: vi.fn(async (secret: string) => { stored.push(secret); }), stored };
}

describe("B1.1 secure input — availability gates", () => {
  it.each(["print", "rpc", "json", ""])("refuses non-TUI mode %s without opening any component", async (mode) => {
    const api = await mod();
    const h = harness({ mode });
    const w = writer();
    const outcome = await api.captureTunnelSecret(h.ctx, w);
    expect(outcome).toEqual({ status: "refused", code: "CE_TUNNEL_INPUT_UNAVAILABLE" });
    expect(w.store).not.toHaveBeenCalled();
    expect(h.ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("refuses when ui.custom is unavailable even in TUI mode", async () => {
    const api = await mod();
    const h = harness({ withCustom: false });
    const w = writer();
    expect(await api.captureTunnelSecret(h.ctx, w)).toEqual({
      status: "refused",
      code: "CE_TUNNEL_INPUT_UNAVAILABLE",
    });
    expect(w.store).not.toHaveBeenCalled();
  });
});

describe("B1.1 secure input — capture and hand-off", () => {
  it("hands the typed secret to the writer only, and never returns or renders it", async () => {
    const api = await mod();
    const h = harness();
    const w = writer();
    const pending = api.captureTunnelSecret(h.ctx, w);
    await h.installed;
    for (const ch of SENTINEL) h.type(ch);
    const rendered = h.render();
    h.type("\r");
    const outcome = await pending;

    expect(outcome).toEqual({ status: "stored" });
    expect(w.stored).toEqual([SENTINEL]);
    expect(rendered).not.toContain(SENTINEL);
    expect(rendered).not.toContain(SENTINEL.slice(0, 6));
    expect(JSON.stringify(outcome)).not.toContain(SENTINEL);
    expect(h.ctx.ui.notify).not.toHaveBeenCalled();
    expect(h.ctx.ui.input).not.toHaveBeenCalled();
    expect(h.ctx.ui.pasteToEditor).not.toHaveBeenCalled();
    expect(h.ctx.ui.setEditorText).not.toHaveBeenCalled();
    expect(h.doneCalls()).toBe(1);
  });

  it("renders fixed labels, a mask only, and never exceeds the requested width", async () => {
    const api = await mod();
    const h = harness();
    void api.captureTunnelSecret(h.ctx, writer());
    await h.installed;
    for (const ch of "abcdefghij") h.type(ch);
    const lines = h.component().render(24);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(24);
    const joined = lines.join("\n");
    expect(joined).not.toContain("abcdefghij");
    expect(joined).toMatch(/[*•]{10}/);
    h.type("\x1b");
  });

  it.each([
    ["escape", "\x1b"],
    ["ctrl-c", "\x03"],
  ])("%s cancels without storing anything", async (_name, key) => {
    const api = await mod();
    const h = harness();
    const w = writer();
    const pending = api.captureTunnelSecret(h.ctx, w);
    await h.installed;
    for (const ch of SENTINEL) h.type(ch);
    h.type(key);
    expect(await pending).toEqual({ status: "cancelled", reason: "user" });
    expect(w.store).not.toHaveBeenCalled();
  });

  it("finishes exactly once even when more input arrives after submit", async () => {
    const api = await mod();
    const h = harness();
    const w = writer();
    const pending = api.captureTunnelSecret(h.ctx, w);
    await h.installed;
    h.type("a");
    h.type("\r");
    await pending;
    h.type("b");
    h.type("\r");
    h.type("\x1b");
    expect(h.doneCalls()).toBe(1);
    expect(w.store).toHaveBeenCalledTimes(1);
    expect(w.stored).toEqual(["a"]);
  });

  it("ignores an empty submit instead of storing an empty secret", async () => {
    const api = await mod();
    const h = harness();
    const w = writer();
    void api.captureTunnelSecret(h.ctx, w);
    await h.installed;
    h.type("\r");
    expect(h.doneCalls()).toBe(0);
    expect(w.store).not.toHaveBeenCalled();
    h.type("\x1b");
  });

  it("deletes with backspace and rejects over-long input without storing it", async () => {
    const api = await mod();
    const h = harness();
    const w = writer();
    const pending = api.captureTunnelSecret(h.ctx, w);
    await h.installed;
    h.type("ab");
    h.type("\x7f");
    const max = api.SECURE_INPUT_LIMITS.maxLength as number;
    for (let i = 0; i < max + 10; i += 1) h.type("x");
    h.type("\r");
    const outcome = await pending;
    expect(outcome).toEqual({ status: "stored" });
    expect(w.stored[0]?.length).toBe(max);
    expect(w.stored[0]?.startsWith("ax")).toBe(true);
  });
});

describe("B1.1 secure input — paste policy", () => {
  it("accepts a split bracketed paste atomically", async () => {
    const api = await mod();
    const h = harness();
    const w = writer();
    const pending = api.captureTunnelSecret(h.ctx, w);
    await h.installed;
    h.type("\x1b[200~sk-b11-");
    h.type("synthetic-canary-0001");
    h.type("\x1b[201~");
    h.type("\r");
    expect(await pending).toEqual({ status: "stored" });
    expect(w.stored).toEqual([SENTINEL]);
  });

  it.each([
    ["embedded newline", `\x1b[200~${SENTINEL}\nrm -rf /\x1b[201~`],
    ["embedded carriage return", `\x1b[200~${SENTINEL}\r\x1b[201~`],
    ["whitespace", "\x1b[200~has space\x1b[201~"],
    ["control byte", "\x1b[200~bad\x07value\x1b[201~"],
    ["non-ascii", "\x1b[200~clé-secrète\x1b[201~"],
  ])("rejects an invalid paste (%s) atomically and never submits", async (_name, data) => {
    const api = await mod();
    const h = harness();
    const w = writer();
    void api.captureTunnelSecret(h.ctx, w);
    await h.installed;
    h.type(data);
    expect(h.doneCalls()).toBe(0);
    expect(w.store).not.toHaveBeenCalled();
    const rendered = h.render();
    expect(rendered).not.toContain(SENTINEL);
    expect(rendered).not.toContain("rm -rf");
    h.type("\x1b");
  });

  it("rejects an oversized paste without truncating it into the buffer", async () => {
    const api = await mod();
    const h = harness();
    const w = writer();
    const pending = api.captureTunnelSecret(h.ctx, w);
    await h.installed;
    h.type(`\x1b[200~${"y".repeat((api.SECURE_INPUT_LIMITS.maxLength as number) + 1)}\x1b[201~`);
    h.type("z");
    h.type("\r");
    expect(await pending).toEqual({ status: "stored" });
    expect(w.stored).toEqual(["z"]);
  });

  it("does not submit while a paste frame is still open", async () => {
    const api = await mod();
    const h = harness();
    const w = writer();
    void api.captureTunnelSecret(h.ctx, w);
    await h.installed;
    h.type("\x1b[200~abc\n");
    expect(h.doneCalls()).toBe(0);
    expect(w.store).not.toHaveBeenCalled();
    h.type("\x1b[201~");
    expect(h.doneCalls()).toBe(0);
    h.type("\x1b");
  });
});

describe("B1.1 secure input — timeout, abort, writer failure", () => {
  it("times out without storing and reports a fixed reason", async () => {
    const api = await mod();
    const h = harness();
    const w = writer();
    const pending = api.captureTunnelSecret(h.ctx, w, { timeoutMs: 20 });
    await h.installed;
    h.type("abc");
    expect(await pending).toEqual({ status: "cancelled", reason: "timeout" });
    expect(w.store).not.toHaveBeenCalled();
  });

  it("aborts on an external signal (session teardown) without storing", async () => {
    const api = await mod();
    const h = harness();
    const w = writer();
    const controller = new AbortController();
    const pending = api.captureTunnelSecret(h.ctx, w, { signal: controller.signal });
    await h.installed;
    h.type("abc");
    controller.abort();
    expect(await pending).toEqual({ status: "cancelled", reason: "aborted" });
    expect(w.store).not.toHaveBeenCalled();
    expect(h.doneCalls()).toBe(1);
  });

  it("does not start writer.store when abort lands after submit but before handoff", async () => {
    const api = await mod();
    const h = harness();
    const w = writer();
    const controller = new AbortController();
    const pending = api.captureTunnelSecret(h.ctx, w, { signal: controller.signal });
    await h.installed;
    for (const ch of SENTINEL) h.type(ch);
    h.type("\r");
    controller.abort();
    expect(await pending).toEqual({ status: "cancelled", reason: "aborted" });
    expect(w.store).not.toHaveBeenCalled();
    expect(w.stored).toEqual([]);
  });

  it("treats writer.store entry as the commit point and waits for its completion barrier", async () => {
    const api = await mod();
    const h = harness();
    const controller = new AbortController();
    let storeStarted!: () => void;
    let finishStore!: () => void;
    const started = new Promise<void>((resolve) => { storeStarted = resolve; });
    const completion = new Promise<void>((resolve) => { finishStore = resolve; });
    const w = { store: vi.fn(async (_secret: string) => { storeStarted(); await completion; }) };
    const pending = api.captureTunnelSecret(h.ctx, w, { signal: controller.signal });
    await h.installed;
    for (const ch of SENTINEL) h.type(ch);
    h.type("\r");
    await started;
    controller.abort();
    let settled = false;
    void pending.then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled, "writer.store was already entered; cancellation must not pretend rollback").toBe(false);
    finishStore();
    expect(await pending).toEqual({ status: "stored" });
    expect(w.store).toHaveBeenCalledTimes(1);
  });

  it("handles an already-aborted signal after installation, never before", async () => {
    const api = await mod();
    const h = harness();
    const w = writer();
    const controller = new AbortController();
    controller.abort();
    const outcome = await api.captureTunnelSecret(h.ctx, w, { signal: controller.signal });
    expect(outcome).toEqual({ status: "cancelled", reason: "aborted" });
    expect(w.store).not.toHaveBeenCalled();
  });

  it("suppresses a writer failure that embeds the secret and returns a fixed code", async () => {
    const api = await mod();
    const h = harness();
    const failing = {
      store: vi.fn(async (secret: string) => {
        throw new Error(`keychain exploded while storing ${secret}`);
      }),
    };
    const pending = api.captureTunnelSecret(h.ctx, failing);
    await h.installed;
    for (const ch of SENTINEL) h.type(ch);
    h.type("\r");
    const outcome = await pending;
    expect(outcome.status).toBe("refused");
    expect(outcome.code).toBe("CE_TUNNEL_KEYCHAIN_UNAVAILABLE");
    expect(JSON.stringify(outcome)).not.toContain(SENTINEL);
    expect(h.ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("dispose clears the buffer so later input cannot store a secret", async () => {
    const api = await mod();
    const h = harness();
    const w = writer();
    void api.captureTunnelSecret(h.ctx, w);
    await h.installed;
    for (const ch of SENTINEL) h.type(ch);
    h.component().dispose?.();
    h.type("\r");
    expect(w.store).not.toHaveBeenCalled();
    expect(h.render()).not.toContain(SENTINEL);
    h.component().dispose?.();
  });
});
