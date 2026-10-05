import type { AuthoritativeTaskState } from "./state.js";

export type EvidenceReference = AuthoritativeTaskState["evidence"][number];
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
/** Latest typed validation per name, partitioned against the current workspace digest. */
export function latestValidationEvidenceByWorkspace(
  evidence: readonly EvidenceReference[],
  currentWorkspaceDigest: string,
): EvidenceFreshness {
  const latest = new Map<string, EvidenceReference>();
  for (const reference of evidence) {
    if (reference.validation === undefined) continue;
    const previous = latest.get(reference.validation.name);
    if (
      previous === undefined ||
      reference.recordedAtMs > previous.recordedAtMs ||
      (reference.recordedAtMs === previous.recordedAtMs && reference.evidenceId > previous.evidenceId)
    ) {
      latest.set(reference.validation.name, reference);
    }
  }
  return partitionEvidenceByWorkspace(
    [...latest.values()].sort((left, right) =>
      (left.validation?.name ?? "").localeCompare(right.validation?.name ?? ""),
    ),
    currentWorkspaceDigest,
  );
}

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
