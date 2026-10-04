import type { AuthoritativeTaskState } from "./state.js";

type EvidenceReference = AuthoritativeTaskState["evidence"][number];
export type StaleEvidenceReason = "workspace_digest_changed" | "workspace_digest_unbound";

export interface StaleEvidence {
  readonly evidence: EvidenceReference;
  readonly reason: StaleEvidenceReason;
}

export interface EvidenceFreshness {
  readonly valid: readonly EvidenceReference[];
  readonly stale: readonly StaleEvidence[];
}

/** Workspace provenance, not elapsed wall time, is the evidence authority. */
export function partitionEvidenceByWorkspace(
  evidence: readonly EvidenceReference[],
  currentWorkspaceDigest: string,
): EvidenceFreshness {
  const valid: EvidenceReference[] = [];
  const stale: StaleEvidence[] = [];
  for (const reference of evidence) {
    if (reference.validAtWorkspaceDigest === undefined) {
      stale.push({ evidence: reference, reason: "workspace_digest_unbound" });
    } else if (reference.validAtWorkspaceDigest !== currentWorkspaceDigest) {
      stale.push({ evidence: reference, reason: "workspace_digest_changed" });
    } else {
      valid.push(reference);
    }
  }
  return { valid, stale };
}
