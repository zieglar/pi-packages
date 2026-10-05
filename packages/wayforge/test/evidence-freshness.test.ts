import { describe, expect, it } from "vitest";
import {
  latestValidationEvidenceByWorkspace,
  partitionEvidenceByWorkspace,
} from "../src/durable/evidence-freshness.js";
import type { AuthoritativeTaskState } from "../src/durable/state.js";

type Evidence = AuthoritativeTaskState["evidence"][number];
const evidence = (id: string, digest: string | undefined, recordedAtMs: number): Evidence => ({
  evidenceId: id,
  kind: "command",
  summary: `${id} passed`,
  recordedAtMs,
  ...(digest === undefined ? {} : { validAtWorkspaceDigest: digest }),
});

describe("partitionEvidenceByWorkspace", () => {
  it("keeps evidence authoritative solely when its workspace digest matches", () => {
    const result = partitionEvidenceByWorkspace(
      [evidence("matching-old", "digest-current", 1), evidence("matching-future", "digest-current", 999_999)],
      "digest-current",
    );
    expect(result.valid.map((entry) => entry.evidenceId)).toEqual(["matching-old", "matching-future"]);
    expect(result.stale).toEqual([]);
  });

  it("invalidates changed-digest and unbound evidence without mutating source records", () => {
    const source = [evidence("stale", "digest-before", 100), evidence("unbound", undefined, 200)];
    const snapshot = JSON.stringify(source);
    const result = partitionEvidenceByWorkspace(source, "digest-after");
    expect(result.valid).toEqual([]);
    expect(result.stale).toEqual([
      { evidence: source[0], reason: "workspace_digest_changed" },
      { evidence: source[1], reason: "workspace_digest_unbound" },
    ]);
    expect(JSON.stringify(source)).toBe(snapshot);
  });

  it("selects only the latest typed validation per name without parsing summaries", () => {
    const source: Evidence[] = [
      { ...evidence("old", "digest-current", 1), validation: { name: "test", ok: false } },
      { ...evidence("legacy", "digest-current", 9), summary: "test: pass" },
      { ...evidence("new", "digest-current", 2), validation: { name: "test", ok: true } },
      { ...evidence("lint", "digest-before", 3), validation: { name: "lint", ok: true } },
    ];
    const result = latestValidationEvidenceByWorkspace(source, "digest-current");
    expect(result.valid.map((entry) => entry.evidenceId)).toEqual(["new"]);
    expect(result.stale.map((entry) => entry.evidence.evidenceId)).toEqual(["lint"]);
  });
});
