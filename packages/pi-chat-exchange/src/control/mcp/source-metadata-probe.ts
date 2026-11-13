import { createHmac, randomBytes } from "node:crypto";
import { writeSync } from "node:fs";

export interface SourceMetadataObservation {
  readonly event: "SOURCE_METADATA_OBSERVATION";
  readonly present: boolean;
  readonly type: string;
  readonly digest?: string;
}

export type SourceMetadataProbe = (metadata: unknown) => void;

/** Opt-in is supplied by the trusted launch owner, never tool arguments or _meta. */
export function createSourceMetadataProbe(
  launchDigest: string,
  enabledLaunchDigest: string | undefined = undefined,
  emit: (observation: SourceMetadataObservation) => void = row => { writeSync(2, JSON.stringify(row) + "\n"); },
): SourceMetadataProbe | undefined {
  if (!/^[a-f0-9]{64}$/.test(launchDigest) || enabledLaunchDigest !== launchDigest) return undefined;
  const key = randomBytes(32);
  let consumed = false;
  return metadata => {
    if (consumed) return;
    // Missing/malformed metadata and failed logging still consume this trial.
    consumed = true;
    let observation: SourceMetadataObservation = { event: "SOURCE_METADATA_OBSERVATION", present: false, type: "missing" };
    try {
      if (metadata !== undefined && (metadata === null || typeof metadata !== "object" || Array.isArray(metadata))) {
        observation = { ...observation, type: "invalid-metadata" };
      } else if (metadata !== undefined) {
        const field = Object.getOwnPropertyDescriptor(metadata, "openai/session");
        if (field !== undefined) {
          if (!("value" in field)) observation = { ...observation, present: true, type: "accessor" };
          else {
            const value: unknown = field.value;
            observation = { ...observation, present: true, type: value === null ? "null" : Array.isArray(value) ? "array" : typeof value };
            if (typeof value === "string" && value.length > 0 && value.length <= 4096) {
              // The private key prevents dictionary matching and cross-probe correlation.
              const digest = createHmac("sha256", key)
                .update(JSON.stringify(["ce.source-metadata.v1", launchDigest, value])).digest("hex");
              observation = { ...observation, digest };
            }
          }
        }
      }
    } catch { observation = { ...observation, present: false, type: "unreadable" }; }
    try { emit(observation); } catch { /* Diagnostics must never alter tool behavior. */ }
  };
}
