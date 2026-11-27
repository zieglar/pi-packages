import { createHash } from "node:crypto";
import type { CeReadResult } from "../dist/endpoints/pi/session-host.js";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { validateFeedbackClassification, validateFeedbackTerminal, type FeedbackAssociation, type OwnershipFeedbackPort } from "./ownership-feedback.js";
import { readNativeInboundPolicy } from "./native-inbound-policy.js";

type DeliveryMode = "followUp" | "steer";
/** Raw trusted metadata. `deliveryMode` is absent for messages created before
 * the mode existed, so the field is optional here and normalized later. */
type MetadataSource = Omit<CeReadResult, "state"> & { readonly deliveryMode?: DeliveryMode };
type Metadata = Omit<CeReadResult, "state"> & { readonly deliveryMode: DeliveryMode };
type Entries = ReadonlyArray<Record<string, unknown>>;
export interface NativeInboundPolicy {
  readonly version: 1;
  readonly enabled: boolean;
  readonly runtimeSessionId: string;
  readonly endpointId: string;
  readonly exchangeId: string;
  readonly from: string;
  readonly activatedAt: string;
  readonly afterAuditSequence: number;
  readonly maxAgeSeconds: number;
}
interface InboundOptions {
  readonly policyPath: string;
  readonly runtimeSessionId: string;
  readonly endpointId: string;
  getSessionId(): string;
  getEntries(): Entries;
  append(customType: string, data: unknown): void;
  listInbox(input: { afterAuditSequence: number; pageSize: number; rawScanLimit: number }): { messages: ReadonlyArray<{ messageId: string; auditSequence: number }>; continuationAuditSequence: number | null; scanBudgetExhausted: boolean };
  readMetadata(input: { messageId: string }): MetadataSource;
  canReceiveTask(messageId: string): boolean;
  wake(input: { messageId: string; auditSequence: number; policyDigest: string; policyRevision: string; deliveryMode: DeliveryMode }): void;
  readonly feedback?: OwnershipFeedbackPort | undefined;
  controlWake?(input: { messageId: string; auditSequence: number; policyDigest: string; policyRevision: string }): void;
  now(): number;
}
export type NativeInboundToolContext = Pick<ExtensionToolContext, "executeTool">;
interface Claim { readonly policyDigest: string; readonly messageId: string; readonly auditSequence: number; readonly admittedAt: number; readonly metadata: Metadata; readonly deliveryMode?: DeliveryMode; readonly association?: FeedbackAssociation }
const metadataKeys = ["messageId", "exchangeId", "from", "to", "payloadDigest", "payloadLength", "createdAt", "auditSequence"] as const;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const time = (text: string) => typeof text === "string" && /(?:Z|[+-]\d{2}:\d{2})$/.test(text) ? Date.parse(text) : NaN;
function failure(code: string): never { throw new Error(code); }
function metadata(input: unknown, policy: NativeInboundPolicy, messageId: string, now: number): Metadata | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  // A missing mode means an old message: keep the legacy followUp delivery.
  // An explicit unsupported mode is refused instead of silently downgraded.
  const deliveryMode = Object.hasOwn(value, "deliveryMode") ? value.deliveryMode : "followUp";
  if (deliveryMode !== "followUp" && deliveryMode !== "steer") return undefined;
  if (value.messageId !== messageId || value.exchangeId !== policy.exchangeId || value.from !== policy.from || value.to !== policy.endpointId ||
    typeof value.payloadDigest !== "string" || !/^[0-9a-f]{64}$/.test(value.payloadDigest) ||
    !Number.isSafeInteger(value.payloadLength) || (value.payloadLength as number) < 1 || (value.payloadLength as number) > 65_536 ||
    !Number.isSafeInteger(value.auditSequence) || (value.auditSequence as number) <= policy.afterAuditSequence) return undefined;
  const created = time(value.createdAt as string);
  if (!Number.isFinite(created) || created < time(policy.activatedAt) || created > now || now - created > policy.maxAgeSeconds * 1000) return undefined;
  // SAFETY: route, scalar fields and creation time were validated above.
  return { ...Object.fromEntries(metadataKeys.map(key => [key, value[key]])), deliveryMode } as Metadata;
}
function historyEntries(entries: Entries): Array<{ customType: string; data: Record<string, unknown> }> {
  if (!Array.isArray(entries)) failure("INBOUND_HISTORY_INVALID");
  const records = entries.filter(entry => entry?.type === "custom" && ["ce-inbound-wake", "ce-inbound-receive", "ce-inbound-feedback", "ce-inbound-feedback-blocked", "ce-inbound-feedback-result"].includes(entry.customType as string));
  if (records.some(entry => !entry.data || typeof entry.data !== "object" || Array.isArray(entry.data))) failure("INBOUND_HISTORY_INVALID");
  return records as Array<{ customType: string; data: Record<string, unknown> }>;
}

/** Deny-only history survives revocation or a closed controller. */
export function isNativeFeedback(entries: Entries, messageId: string): boolean {
  return historyEntries(entries).some(entry => entry.data.messageId === messageId &&
    ['ce-inbound-feedback', 'ce-inbound-feedback-blocked', 'ce-inbound-feedback-result'].includes(entry.customType));
}

export function createNativeInbound(options: InboundOptions) {
  let closed = false;
  let watermark: { policyDigest: string; cursor: number } | undefined;
  const history = () => historyEntries(options.getEntries());
  const claim = (messageId: string) => {
    const candidates = history().filter(entry => (entry.customType === "ce-inbound-wake" || entry.customType === "ce-inbound-feedback") && entry.data?.messageId === messageId);
    if (candidates.length !== 1) failure(candidates.length ? "INBOUND_CLAIM_CONFLICT" : "INBOUND_NOT_CLAIMED");
    const data = candidates[0]!.data;
    if (data.version !== 1 || data.runtimeSessionId !== options.runtimeSessionId || data.endpointId !== options.endpointId ||
      typeof data.policyDigest !== "string" || !Number.isSafeInteger(data.auditSequence) || !Number.isSafeInteger(data.admittedAt) || (data.admittedAt as number) > options.now() || !data.metadata || typeof data.metadata !== "object") failure("INBOUND_CLAIM_INVALID");
    // SAFETY: scalar claim fields are validated here; receive validates correlated metadata before use.
    if (candidates[0]!.customType === "ce-inbound-feedback") {
      const association = validateFeedbackClassification(data.association, messageId);
      if (association.kind !== "FEEDBACK") failure("INBOUND_CLAIM_INVALID");
      // SAFETY: claim scalars above and closed association validation establish the persisted claim shape.
      return { ...(data as unknown as Claim), association };
    }
    if (Object.hasOwn(data, "association")) failure("INBOUND_CLAIM_INVALID");
    // SAFETY: scalar claim fields are validated above; receive validates correlated metadata before use.
    return data as unknown as Claim;
  };
  const authorized = (expectedDigest?: string) => {
    if (closed) failure("INBOUND_CLOSED");
    if (options.getSessionId() !== options.runtimeSessionId) failure("INBOUND_SESSION_CHANGED");
    if (typeof process.getuid !== "function") failure("INBOUND_POLICY_INVALID");
    const observed = readNativeInboundPolicy(options.policyPath, { runtimeSessionId: options.runtimeSessionId, endpointId: options.endpointId }, options.now());
    if (!observed || !observed.policy.enabled) { if (expectedDigest) failure("INBOUND_DISABLED"); return undefined; }
    const policy = observed.policy;
    const policyDigest = sha(JSON.stringify(policy));
    if (expectedDigest !== undefined && policyDigest !== expectedDigest) failure("INBOUND_POLICY_CHANGED");
    return { policy, policyDigest, policyRevision: observed.revision };
  };
  const receiveAttempt = (messageId: string) => history().filter(entry => entry.customType === "ce-inbound-receive" && entry.data?.messageId === messageId);
  return {
    feedbackProtocolVersion: 1 as const,
    close() { closed = true; },
    /** Feedback history is deny-only for desktop preparation, including out-of-order terminal records. */
    canPrepareDesktopReply(messageId: string): boolean {
      if (!authorized()) failure("INBOUND_DISABLED");
      return !isNativeFeedback(options.getEntries(), messageId);
    },
    poll() {
      const current = authorized();
      if (!current) return false;
      if (watermark?.policyDigest !== current.policyDigest) watermark = { policyDigest: current.policyDigest, cursor: current.policy.afterAuditSequence };
      const result = options.listInbox({ afterAuditSequence: watermark.cursor, pageSize: 20, rawScanLimit: 200 });
      const records = history();
      for (const candidate of result.messages) {
        if (records.some(entry => entry.data.messageId === candidate.messageId)) continue;
        if (!options.canReceiveTask(candidate.messageId)) continue;
        const admittedAt = options.now();
        const fresh = metadata(options.readMetadata({ messageId: candidate.messageId }), current.policy, candidate.messageId, admittedAt);
        if (!fresh) continue;
        let classification: ReturnType<typeof validateFeedbackClassification> = { kind: "NONE" };
        if (options.feedback) {
          try {
            const { deliveryMode: _deliveryMode, ...feedbackMetadata } = fresh;
            classification = validateFeedbackClassification(options.feedback.classify(feedbackMetadata), candidate.messageId);
          }
          catch { failure("INBOUND_FEEDBACK_UNAVAILABLE"); }
        }
        // Full append history is deny-only across reloads and branch rollback.
        // This is a wake attempt, not a lock or an exactly-once execution guarantee.
        const data = { version: 1, runtimeSessionId: options.runtimeSessionId, endpointId: options.endpointId,
          policyDigest: current.policyDigest, messageId: candidate.messageId, auditSequence: candidate.auditSequence, admittedAt, metadata: fresh, deliveryMode: fresh.deliveryMode };
        if (classification.kind === "BLOCKED") {
          options.append("ce-inbound-feedback-blocked", { ...data, reason: classification.reason });
          continue;
        }
        if (classification.kind === "FEEDBACK") {
          options.append("ce-inbound-feedback", { ...data, association: classification });
          try {
            if (!options.controlWake) failure("INBOUND_FEEDBACK_UNAVAILABLE");
            options.controlWake({ messageId: candidate.messageId, auditSequence: candidate.auditSequence, policyDigest: current.policyDigest, policyRevision: current.policyRevision });
          } catch { failure("INBOUND_FEEDBACK_UNAVAILABLE"); }
          continue;
        }
        options.append("ce-inbound-wake", data);
        try { options.wake({ messageId: candidate.messageId, auditSequence: candidate.auditSequence, policyDigest: current.policyDigest, policyRevision: current.policyRevision, deliveryMode: fresh.deliveryMode }); }
        catch { failure("INBOUND_WAKE_UNKNOWN"); }
      }
      watermark.cursor = Math.max(watermark.cursor, result.continuationAuditSequence ?? watermark.cursor);
      return true;
    },
    /** Re-reads the live policy so a deferred delivery can detect revocation. */
    stillAuthorized(policyDigest: string, policyRevision: string): boolean {
      try {
        if (closed) return false;
        if (options.getSessionId() !== options.runtimeSessionId) return false;
        const current = authorized();
        return current !== undefined && current.policyDigest === policyDigest && current.policyRevision === policyRevision;
      } catch {
        return false;
      }
    },
    /** Deferred wakes must still target the same authorized Message and mode. */
    canDeliver(messageId: string, policyDigest: string, policyRevision: string, mode: DeliveryMode): boolean {
      try {
        const current = authorized(policyDigest);
        if (!current || current.policyRevision !== policyRevision || receiveAttempt(messageId).length || !options.canReceiveTask(messageId)) return false;
        const original = claim(messageId);
        if (original.policyDigest !== policyDigest) return false;
        const expected = metadata(original.metadata, current.policy, messageId, original.admittedAt);
        const actual = metadata(options.readMetadata({ messageId }), current.policy, messageId, original.admittedAt);
        return !!expected && !!actual && expected.deliveryMode === mode && actual.deliveryMode === mode &&
          (original.deliveryMode ?? "followUp") === mode && metadataKeys.every(key => expected[key] === actual[key]);
      } catch { return false; }
    },
    async receive(messageId: string, ctx: NativeInboundToolContext) {
      const current = authorized() ?? failure("INBOUND_DISABLED");
      const records = history();
      if (records.some(entry => entry.data.messageId === messageId && entry.customType === "ce-inbound-feedback-blocked")) failure("INBOUND_FEEDBACK_BLOCKED");
      if (receiveAttempt(messageId).length || records.some(entry => entry.data.messageId === messageId && entry.customType === "ce-inbound-feedback-result")) failure("INBOUND_ALREADY_ATTEMPTED");
      const original = claim(messageId); if (original.policyDigest !== current.policyDigest) failure("INBOUND_POLICY_CHANGED");
      const currentMetadata = metadata(original.metadata, current.policy, messageId, original.admittedAt); if (!currentMetadata) failure("INBOUND_NOT_FRESH");
      const claimedMode = Object.hasOwn(original, "deliveryMode") ? original.deliveryMode : "followUp";
      if (claimedMode !== currentMetadata.deliveryMode) failure("INBOUND_CLAIM_INVALID");
      // Persist before the first uncertain read. Read refusal and crashes are not retried.
      options.append("ce-inbound-receive", { version: 1, runtimeSessionId: options.runtimeSessionId, endpointId: options.endpointId,
        policyDigest: current.policyDigest, messageId, auditSequence: original.auditSequence, status: "STARTED" });
      let code = "INBOUND_READ_UNKNOWN";
      const settle = () => {
        options.append("ce-inbound-receive", { version: 1, runtimeSessionId: options.runtimeSessionId, endpointId: options.endpointId,
          policyDigest: current.policyDigest, messageId, auditSequence: original.auditSequence, status: "STOPPED_NO_REPLAY", code });
      };
      try {
        const read = await ctx.executeTool("ce_read", { messageId }).catch(() => failure(code = "INBOUND_READ_REFUSED"));
        authorized(current.policyDigest); if (read.isError) failure(code = "INBOUND_READ_REFUSED");
        const actual = metadata(read.result.details, current.policy, messageId, original.admittedAt) ?? failure(code = "INBOUND_METADATA_DENIED");
        if (actual.deliveryMode !== currentMetadata.deliveryMode || metadataKeys.some(key => actual[key] !== currentMetadata[key])) failure(code = "INBOUND_METADATA_CHANGED");
        const payload = await ctx.executeTool("ce_read_payload", { messageId }).catch(() => failure(code = "INBOUND_READ_REFUSED"));
        authorized(current.policyDigest); if (payload.isError) failure(code = "INBOUND_READ_REFUSED");
        const readPayload = metadata(payload.result.details, current.policy, messageId, original.admittedAt) ?? failure(code = "INBOUND_METADATA_DENIED");
        if (readPayload.deliveryMode !== actual.deliveryMode || metadataKeys.some(key => readPayload[key] !== actual[key])) failure(code = "INBOUND_METADATA_MISMATCH");
        if (!Array.isArray(payload.result.content)) failure(code = "INBOUND_PAYLOAD_INVALID");
        const part = payload.result.content[1];
        if (part?.type !== "text") failure(code = "INBOUND_PAYLOAD_INVALID");
        const text = part.text;
        if (typeof text !== "string" || Buffer.from(text, "utf8").toString("utf8") !== text || Buffer.byteLength(text) !== actual.payloadLength || sha(text) !== actual.payloadDigest) failure(code = "INBOUND_PAYLOAD_MISMATCH");
        authorized(current.policyDigest);
        options.append("ce-inbound-receive", { version: 1, runtimeSessionId: options.runtimeSessionId, endpointId: options.endpointId,
          policyDigest: current.policyDigest, messageId, auditSequence: original.auditSequence, status: "RETURNED" });
        if (original.association) {
          if (!options.feedback) failure(code = "INBOUND_FEEDBACK_UNAVAILABLE");
          let terminal;
          try {
            const { deliveryMode: _deliveryMode, ...feedbackMetadata } = actual;
            terminal = validateFeedbackTerminal(await options.feedback.consume({ metadata: feedbackMetadata, association: original.association, text }), original.association);
          }
          catch { failure(code = "INBOUND_FEEDBACK_UNAVAILABLE"); }
          options.append("ce-inbound-feedback-result", terminal);
          return terminal;
        }
        return { messageId, metadata: actual, text };
      } catch (error) {
        settle();
        failure(error instanceof Error && /^INBOUND_[A-Z_]+$/.test(error.message) ? error.message : code);
      }
    },
  };
}
