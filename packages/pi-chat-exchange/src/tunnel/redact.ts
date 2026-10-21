/**
 * Untrusted child diagnostics are NOT safe to forward, even after pattern
 * matching: secrets can be arbitrary, split across chunks, or encoded.
 * B1-FIX deliberately trades all raw diagnostics (including tunnel-id prefixes)
 * for fixed suppression. Structured health evidence has its own allowlisted
 * parser; this function must never attempt to recover diagnostic content.
 * Pure/offline only: no production stdout/stderr consumer is wired in B1.
 */
export interface RedactedOutput {
  readonly text: string;
  /** Legacy field: no raw prefix is retained or truncated anymore. */
  readonly truncated: boolean;
  /** Fixed policy identifiers only, never derived from input content. */
  readonly appliedRules: readonly string[];
}

export function redactChildOutput(input: string): RedactedOutput {
  const nonempty = input !== "";
  return Object.freeze({
    text: nonempty ? "[child output suppressed]" : "",
    truncated: false,
    appliedRules: Object.freeze(nonempty ? ["raw-output-suppressed"] : []),
  });
}
