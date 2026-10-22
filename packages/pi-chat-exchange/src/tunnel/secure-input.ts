/**
 * CE custom masked secret input hosted through Pi 1.3.0 `ctx.ui.custom()`.
 * Pi 1.3.0 does not provide a native PasswordInput / SecretInput.
 *
 * Scope and non-goals (PHASE-A-DESIGN-v2 §3, B1.1 handoff):
 * - The secret is captured by a dedicated `ui.custom` component and handed to
 *   exactly ONE sink: the injected credential writer. It is never passed to
 *   `ui.input`, the main editor, `pasteToEditor`, `notify`, `sendMessage`,
 *   `appendEntry`, a log, a tool result, or the resolved outcome value.
 * - Rendering emits fixed labels plus a mask only. Errors are fixed strings;
 *   an underlying writer failure (which can embed the secret in its message)
 *   is suppressed down to a closed `CE_TUNNEL_*` code.
 * - Pi 1.3.0 `ui.custom` has NO built-in abort or timeout (verified against
 *   dist/core/extensions/types.d.ts:121 and the interactive-mode `done`
 *   handling), so this module implements both and keeps ONE idempotent finish
 *   for submit / Escape / Ctrl-C / timeout / external abort / dispose.
 * - `ctx.mode === "tui"` is required: `hasUI` is also true for RPC, where a
 *   custom terminal component cannot be shown (docs/extensions.md, "UI and
 *   modes"). Non-TUI never silently degrades to a plaintext path; it refuses
 *   with `CE_TUNNEL_INPUT_UNAVAILABLE`.
 *
 * Honest limitation: masking prevents shoulder-surfing and terminal echo. It
 * is NOT memory erasure. JavaScript strings are immutable, so this module
 * cannot promise complete zeroization; it only drops its own references and
 * clears its buffer at finish/dispose. Terminal paste buffers, crash dumps,
 * and terminal recording remain independent exposure surfaces. Malicious
 * same-process extensions and process-level observation are not isolated by it.
 */
import { sanitizeTerminalText } from "@narumitw/pi-tui-kit";
import { TunnelRefusal, type TunnelRefusalCode } from "./codes.js";

/** Narrow key-decoding surface injected by the host. The contract gate forbids
 * `src/` from importing `@earendil-works/*`; the Pi runtime supplies these
 * primitives through `pi-extension/tui-keys.ts` so the domain stays decoupled.
 * Keys are plain key tokens; matchers stay closed and ASCII. */
export interface TunnelKeyProtocol {
  readonly escape: string;
  readonly ctrlC: string;
  readonly ctrlU: string;
  readonly enter: string;
  readonly backspace: string;
  matches(data: string, key: string): boolean;
  decodePrintable(data: string): string | undefined;
  isKeyRelease(data: string): boolean;
}

/** Narrow structural view of the pi-tui handle we actually use. */
export interface SecureInputTuiView {
  requestRender?(): void;
}

/** Narrow structural view of a pi-tui component (dist/tui.d.ts:68–103). */
export interface SecureInputComponentView {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate(): void;
  dispose?(): void;
}

/**
 * The `ui.custom` surface. Declared as an explicit `| undefined` property so a
 * host whose own narrow view marks `custom` optional stays assignable under
 * `exactOptionalPropertyTypes`.
 */
export type SecureInputCustomFn = <T>(
  factory: (
    tui: SecureInputTuiView,
    theme: unknown,
    keybindings: unknown,
    done: (result: T) => void,
  ) => SecureInputComponentView,
  options?: { readonly overlay?: boolean },
) => Promise<T>;

export interface SecureInputUiView {
  custom?: SecureInputCustomFn | undefined;
}

export interface SecureInputContextView {
  readonly mode: string;
  readonly ui: SecureInputUiView;
}

/** The sole sink for a captured secret. */
export interface SecretWriter {
  store(secret: string): Promise<void>;
}

export type SecureInputOutcome =
  | { readonly status: "stored" }
  | { readonly status: "cancelled"; readonly reason: "user" | "timeout" | "aborted" }
  | { readonly status: "refused"; readonly code: TunnelRefusalCode };

export interface SecureInputOptions {
  /** Wall-clock budget for the whole interaction. */
  readonly timeoutMs?: number;
  /** Session teardown / shutdown abort. */
  readonly signal?: AbortSignal;
  /** Host-injected key protocol. Required: there is no Pi import in `src/`. */
  readonly keys: TunnelKeyProtocol;
  /** Optional non-secret caller context rendered above the label. Fixed text
   * supplied by the caller (e.g. a wizard step title); never the secret. */
  readonly preamble?: readonly string[];
}

/** Fixed policy. Not configurable from commands, profiles, or the model. */
export const SECURE_INPUT_LIMITS = Object.freeze({
  /** Maximum accepted secret length in characters. */
  maxLength: 512,
  /** Default interaction timeout. */
  defaultTimeoutMs: 120_000,
  /** Hard cap on buffered bracketed-paste bytes before the paste is refused. */
  maxPasteChars: 4_096,
});

const LABEL = "API key (masked; not echoed, not logged)";
const HINT = "Enter submits · Esc/Ctrl-C cancels · Backspace corrects · Ctrl-U resets";
const REJECTED = "input rejected: 1-512 visible ASCII characters, no spaces";
const MASK_CHAR = "•";
const PROMPT = "> ";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** Visible ASCII only: no space, no control byte, no non-ASCII. */
function isAcceptable(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x21 || code > 0x7e) return false;
  }
  return true;
}

function truncate(line: string, width: number): string {
  if (width <= 0) return "";
  return line.length <= width ? line : line.slice(0, width);
}

type Finish =
  | { readonly kind: "submitted"; readonly secret: string }
  | { readonly kind: "cancelled"; readonly reason: "user" | "timeout" | "aborted" };

const CANCELLED_USER: Finish = Object.freeze({ kind: "cancelled", reason: "user" });
const CANCELLED_ABORTED: Finish = Object.freeze({ kind: "cancelled", reason: "aborted" });

class SecretPrompt implements SecureInputComponentView {
  private buffer = "";
  private pasteBuffer = "";
  private inPaste = false;
  private pasteOverflow = false;
  private rejected = false;
  private finished = false;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private deferredAbort: ReturnType<typeof setTimeout> | undefined;
  private abortListener: (() => void) | undefined;
  private readonly signal: AbortSignal | undefined;
  private readonly keys: TunnelKeyProtocol;
  private readonly preamble: readonly string[];

  constructor(
    private readonly tui: SecureInputTuiView,
    private readonly done: (result: Finish) => void,
    options: SecureInputOptions,
  ) {
    this.keys = options.keys;
    this.preamble = options.preamble ?? [];
    const timeoutMs = options.timeoutMs ?? SECURE_INPUT_LIMITS.defaultTimeoutMs;
    this.timer = setTimeout(() => this.finish({ kind: "cancelled", reason: "timeout" }), Math.max(0, timeoutMs));
    this.timer.unref?.();
    this.signal = options.signal;
    if (this.signal !== undefined) {
      const onAbort = (): void => this.finish({ kind: "cancelled", reason: "aborted" });
      if (this.signal.aborted) {
        // Never call `done` synchronously inside the factory: the runtime has
        // not installed (and therefore cannot dispose) this component yet.
        this.deferredAbort = setTimeout(onAbort, 0);
        this.deferredAbort.unref?.();
      } else {
        this.abortListener = onAbort;
        this.signal.addEventListener("abort", onAbort, { once: true });
      }
    }
  }

  render(width: number): string[] {
    // The preamble is fixed caller text, but it is sanitized anyway: render
    // lines must never carry terminal control sequences.
    const lines = [...this.preamble.map((line) => truncate(sanitizeTerminalText(line), width)), truncate(LABEL, width), truncate(PROMPT + MASK_CHAR.repeat(this.buffer.length), width), truncate(HINT, width)];
    if (this.rejected) lines.push(truncate(REJECTED, width));
    return lines;
  }

  invalidate(): void {
    // Nothing is cached: every line is rebuilt from fixed text plus a mask.
  }

  /**
   * Dispose is an OUTCOME, not just a cleanup: the runtime's `ui.custom`
   * promise only settles through `done`, so a component that is unmounted by a
   * session teardown (or any other external dispose) before submit/cancel must
   * still finish exactly once. Not doing so left the caller awaiting forever.
   *
   * This stays safe when the runtime disposes re-entrantly from inside `done`:
   * `finish` flips `finished` BEFORE calling `done`, so the nested dispose is a
   * pure cleanup and `done` is never invoked twice.
   */
  dispose(): void {
    this.disposed = true;
    this.finish({ kind: "cancelled", reason: "aborted" });
    this.buffer = "";
    this.pasteBuffer = "";
    this.inPaste = false;
    this.clearResources();
  }

  handleInput(data: string): void {
    if (this.finished || this.disposed || data === "") return;
    // A standalone cancel key remains an action even if a paste never closes.
    // Control bytes inside a framed paste are content and fail atomic validation.
    // The native helper uses a substring heuristic: scope it to terminal
    // sequences outside paste so valid ASCII such as ":3u" is never dropped.
    if (!this.inPaste && data.startsWith("\x1b") && this.keys.isKeyRelease(data)) return;
    if (this.keys.matches(data, this.keys.escape) || this.keys.matches(data, this.keys.ctrlC)) {
      this.finish(CANCELLED_USER);
      return;
    }
    if (this.inPaste || data.includes(PASTE_START)) {
      this.handlePasteChunk(data);
      return;
    }
    if (this.keys.matches(data, this.keys.enter) || data === "\n") {
      this.submit();
      return;
    }
    if (this.keys.matches(data, this.keys.backspace) || data === "\b") {
      this.buffer = this.buffer.slice(0, -1);
      this.rejected = false;
      this.requestRender();
      return;
    }
    if (this.keys.matches(data, this.keys.ctrlU)) {
      this.buffer = "";
      this.rejected = false;
      this.requestRender();
      return;
    }
    const printable = this.keys.decodePrintable(data);
    // Ignore navigation/modifier sequences, never insert their escape payload.
    if (data.startsWith("\x1b") && printable === undefined) return;
    this.append(printable ?? data);
  }

  private handlePasteChunk(data: string): void {
    let chunk = data;
    if (!this.inPaste) {
      this.inPaste = true;
      this.pasteBuffer = "";
      this.pasteOverflow = false;
      chunk = chunk.slice(chunk.indexOf(PASTE_START) + PASTE_START.length);
    }
    const endIndex = (this.pasteBuffer + chunk).indexOf(PASTE_END);
    if (endIndex === -1) {
      if (this.pasteBuffer.length + chunk.length > SECURE_INPUT_LIMITS.maxPasteChars) {
        // Keep consuming until the frame closes, but never accept the content.
        this.pasteOverflow = true;
        this.pasteBuffer = "";
        return;
      }
      this.pasteBuffer += chunk;
      return;
    }
    const combined = this.pasteBuffer + chunk;
    const content = combined.slice(0, endIndex);
    const remaining = combined.slice(endIndex + PASTE_END.length);
    const overflowed = this.pasteOverflow;
    this.pasteBuffer = "";
    this.inPaste = false;
    this.pasteOverflow = false;
    // Atomic validation: a paste is accepted as ONE unit or not at all. A
    // pasted newline is content, never a submit.
    if (overflowed || !this.acceptPaste(content)) {
      this.rejected = true;
      this.requestRender();
    }
    if (remaining !== "") this.handleInput(remaining);
  }

  private acceptPaste(content: string): boolean {
    if (this.rejected || content === "" || !isAcceptable(content)) return false;
    if (this.buffer.length + content.length > SECURE_INPUT_LIMITS.maxLength) return false;
    this.buffer += content;
    this.rejected = false;
    this.requestRender();
    return true;
  }

  private append(data: string): void {
    // Never silently strip invalid characters or truncate a credential. Reject
    // the whole event and require an explicit correction/reset before submit.
    if (this.rejected || !isAcceptable(data) || this.buffer.length + data.length > SECURE_INPUT_LIMITS.maxLength) {
      this.rejected = true;
    } else {
      this.buffer += data;
    }
    this.requestRender();
  }

  private submit(): void {
    if (this.rejected || this.buffer.length === 0) {
      this.rejected = true;
      this.requestRender();
      return;
    }
    const secret = this.buffer;
    this.finish({ kind: "submitted", secret });
  }

  private finish(result: Finish): void {
    if (this.finished) return;
    this.finished = true;
    this.buffer = "";
    this.pasteBuffer = "";
    this.clearResources();
    this.done(result);
  }

  private clearResources(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.deferredAbort !== undefined) {
      clearTimeout(this.deferredAbort);
      this.deferredAbort = undefined;
    }
    if (this.abortListener !== undefined) {
      this.signal?.removeEventListener("abort", this.abortListener);
      this.abortListener = undefined;
    }
  }

  private requestRender(): void {
    try {
      this.tui.requestRender?.();
    } catch {
      // Rendering is advisory; a render failure must not leak or retry input.
    }
  }
}

function refused(code: TunnelRefusalCode): SecureInputOutcome {
  return Object.freeze({ status: "refused" as const, code });
}

/**
 * Capture one credential through a masked TUI component and hand it to
 * `writer` only. The returned outcome never carries the secret.
 */
export async function captureTunnelSecret(
  ctx: SecureInputContextView,
  writer: SecretWriter,
  options: SecureInputOptions,
): Promise<SecureInputOutcome> {
  if (ctx.mode !== "tui") return refused("CE_TUNNEL_INPUT_UNAVAILABLE");
  const custom = ctx.ui?.custom;
  if (typeof custom !== "function") return refused("CE_TUNNEL_INPUT_UNAVAILABLE");

  // The runtime surface is generic (`custom<T>`); this adapter pins T to the
  // module-private `Finish` so the secret type never escapes this file.
  // SAFETY: `custom<T>` resolves with exactly the value its factory hands to
  // `done`. The only factory installed here is `SecretPrompt`, whose `done`
  // parameter is `(result: Finish) => void`, so the resolved value is always a
  // `Finish`. TypeScript cannot bind the caller-chosen T through
  // `Function.call`, hence the explicit instantiation.
  const open = custom as unknown as (
    factory: (
      tui: SecureInputTuiView,
      theme: unknown,
      keybindings: unknown,
      done: (result: Finish) => void,
    ) => SecureInputComponentView,
  ) => Promise<Finish>;

  let finish: Finish;
  try {
    finish = await open.call(ctx.ui, (tui, _theme, _keybindings, done) => new SecretPrompt(tui, done, options));
  } catch {
    // The component surface itself failed; no secret can have been captured.
    return refused("CE_TUNNEL_INPUT_UNAVAILABLE");
  }
  // Commit boundary: after the UI resolves but before writer.store starts, an
  // abort still prevents persistence. Once writer.store is entered, cancellation
  // cannot claim rollback; the caller waits for that completion barrier.
  if (options.signal?.aborted) {
    finish = CANCELLED_ABORTED;
    return Object.freeze({ status: "cancelled" as const, reason: "aborted" as const });
  }

  if (finish.kind === "cancelled") return Object.freeze({ status: "cancelled" as const, reason: finish.reason });

  try {
    await writer.store(finish.secret);
  } catch (error) {
    // The underlying failure may embed the secret; only a closed code escapes.
    return refused(error instanceof TunnelRefusal ? error.code : "CE_TUNNEL_KEYCHAIN_UNAVAILABLE");
  } finally {
    // Drop this module's own reference. JS strings cannot be wiped.
    finish = CANCELLED_USER;
  }
  return Object.freeze({ status: "stored" as const });
}
