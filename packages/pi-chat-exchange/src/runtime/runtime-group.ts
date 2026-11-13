export const RUNTIME_GROUP_PATTERN = "^[a-z0-9][a-z0-9._-]{0,63}$";

/** Canonicalize the operator-supplied group label before any lookup or write. */
export function normalizeRuntimeGroup(name: string): string {
  const normalized = name.normalize("NFKC").toLowerCase();
  if (!new RegExp(RUNTIME_GROUP_PATTERN).test(normalized)) {
    throw new Error("CE_RUNTIME_BINDING_INVALID");
  }
  return normalized;
}
