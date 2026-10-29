import { readFileSync } from "node:fs";
import { loadVerifiedNativeArtifact, nativeCacheRoot, nativeTarget, prepareNativeArtifact } from "../storage/native-artifact.js";
import { NATIVE_COMPAT, parseNativeCompat, type NativeCompat } from "../storage/native-compat.js";
import { readDriverSelection, writeDriverSelection } from "../storage/sqlite-driver-selection.js";

import { assertHostRuntimeEligibility } from "../storage/runtime.js";
export type NativeReadinessState = "READY" | "MISSING" | "UNTRUSTED" | "INCOMPATIBLE" | "INITIALIZATION_FAILED" | "UNSUPPORTED_PLATFORM";
export interface NativeReadiness {
  readonly state: NativeReadinessState;
  readonly code: string;
  readonly reason: string;
  readonly driver: string;
  readonly version: string;
  readonly abiVersion: number;
  readonly sqliteVersion: string | null;
  readonly target: string | null;
}
export interface NativeReadinessOptions {
  readonly root?: string;
  readonly selectionFile?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  /** Qualification fixture only; production always uses the shipped trust anchor. */
  readonly manifest?: NativeCompat;
  readonly fetchImpl?: typeof fetch;
}
export const NATIVE_STARTUP_WARNING = "Chat Exchange: Native Driver is not ready. Messaging is disabled. Run /ce-native to inspect or install the trusted driver.";

const reasons: Record<NativeReadinessState, string> = {
  READY: "Verified Native driver is ready.",
  MISSING: "Trusted Native driver is not cached. Run /ce-native install.",
  UNTRUSTED: "Native artifact or cache failed trust verification.",
  INCOMPATIBLE: "Selected driver or Native identity is incompatible with CE.",
  INITIALIZATION_FAILED: "Native driver initialization failed.",
  UNSUPPORTED_PLATFORM: "Native driver does not support this platform or architecture.",
};
function errorCode(error: unknown): string {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  // Never echo arbitrary loader messages, payloads, or unknown error codes.
  return typeof code === "string" && /^CE_(?:NATIVE_[A-Z_]+|SQLITE_DRIVER_SELECTION_INVALID)$/.test(code)
    ? code : "CE_NATIVE_INITIALIZATION_FAILED";
}
function failureState(code: string): NativeReadinessState {
  if (code === "CE_NATIVE_CACHE_MISSING") return "MISSING";
  if (code === "CE_NATIVE_TARGET_UNSUPPORTED") return "UNSUPPORTED_PLATFORM";
  if (/HASH|UNPINNED|CACHE_UNSAFE|ASSET_INVALID|MANIFEST_INVALID/.test(code)) return "UNTRUSTED";
  if (/ABI|IDENTITY|VERSION|SELECTION|DRIVER_INCOMPATIBLE/.test(code)) return "INCOMPATIBLE";
  return "INITIALIZATION_FAILED";
}
/** Release asset target for a platform pair. Windows has no published Native asset. */
export function nativeTargetName(platform: NodeJS.Platform, arch: string): string | null {
  if (platform === "darwin" && arch === "arm64") return "aarch64-apple-darwin";
  if (platform === "darwin" && arch === "x64") return "x86_64-apple-darwin";
  if (platform === "linux" && arch === "x64") return "x86_64-unknown-linux-gnu";
  if (platform === "linux" && arch === "arm64") return "aarch64-unknown-linux-gnu";
  return null;
}

function supported(options: NativeReadinessOptions): boolean {
  return ["darwin", "linux"].includes(options.platform ?? process.platform)
    && ["arm64", "x64"].includes(options.arch ?? process.arch);
}
export function inspectNativeReadiness(options: NativeReadinessOptions = {}): NativeReadiness {
  let manifest = options.manifest ?? NATIVE_COMPAT;
  let driver = "rust-native";
  let version = manifest.defaultVersion;
  let target: string | null = null;
  try {
    if (!supported(options)) throw Object.assign(new Error(), { code: "CE_NATIVE_TARGET_UNSUPPORTED" });
    // The loader targets this process; injected foreign platforms are diagnostic only.
    const platform = options.platform ?? process.platform;
    const arch = options.arch ?? process.arch;
    target = nativeTargetName(platform, arch);
    const selection = readDriverSelection(options.selectionFile);
    driver = selection.driver;
    version = selection.nativeVersion ?? manifest.defaultVersion;
    if (driver !== "rust-native") throw Object.assign(new Error(), { code: "CE_NATIVE_DRIVER_INCOMPATIBLE" });
    if (selection.manifestFile !== undefined) {
      try { manifest = parseNativeCompat(JSON.parse(readFileSync(selection.manifestFile, "utf8"))); }
      catch { throw Object.assign(new Error(), { code: "CE_NATIVE_MANIFEST_INVALID" }); }
    }
    if (platform !== process.platform || arch !== process.arch) throw Object.assign(new Error(), { code: "CE_NATIVE_TARGET_UNSUPPORTED" });
    const verified = loadVerifiedNativeArtifact({ root: options.root ?? nativeCacheRoot(), version, manifest });
    return { state: "READY", code: "CE_NATIVE_READY", reason: reasons.READY, driver, version,
      abiVersion: verified.info.abiVersion, sqliteVersion: verified.info.sqliteVersion, target };
  } catch (error) {
    const code = errorCode(error); const state = failureState(code);
    return { state, code, reason: reasons[state], driver, version, abiVersion: manifest.abiVersion, sqliteVersion: null, target };
  }
}
/** Revalidate immediately before Tunnel side effects. Artifact presence alone is
 * insufficient: the selected Native module must also pass the production Store admission battery. */
export function assertNativeReadyForTunnel(): NativeReadiness {
  const readiness = inspectNativeReadiness();
  if (readiness.state !== "READY") throw Object.assign(new Error("Native is not ready; run /ce-native before starting Tunnel"), { code: readiness.code });
  assertHostRuntimeEligibility();
  return readiness;
}


export async function runNativeCommand(args: string, options: NativeReadinessOptions = {}): Promise<string> {
  const command = args.trim();
  if (command === "" || command === "status" || command === "verify") return JSON.stringify(inspectNativeReadiness(options), null, 2);
  if (command !== "install" && command !== "repair confirm" && command !== "check-updates") {
    return "Usage: /ce-native [status|install|verify|repair confirm|check-updates]. Repair requires explicit repair confirm.";
  }
  const manifest = options.manifest ?? NATIVE_COMPAT;
  try {
    if (command === "check-updates") {
      // Release metadata is discovery, never an artifact trust anchor or selection input.
      const response = await (options.fetchImpl ?? fetch)(`https://api.github.com/repos/${NATIVE_COMPAT.repository}/releases/latest`, {
        redirect: "error", headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw Object.assign(new Error(), { code: "CE_NATIVE_DISCOVERY_FAILED" });
      const metadata: unknown = await response.json();
      if (typeof metadata !== "object" || metadata === null || !("tag_name" in metadata) || typeof metadata.tag_name !== "string") {
        throw Object.assign(new Error(), { code: "CE_NATIVE_DISCOVERY_FAILED" });
      }
      const differs = metadata.tag_name !== `ce-sqlite-v${manifest.defaultVersion}`;
      return `Current trusted Native version: ${manifest.defaultVersion}. Release discovery ${differs ? "differs; wait for a CE compatibility update" : "matches the trusted version"}. No driver was installed or selected.`;
    }
    if (!supported(options) || (options.platform !== undefined && options.platform !== process.platform)
      || (options.arch !== undefined && options.arch !== process.arch)) throw Object.assign(new Error(), { code: "CE_NATIVE_TARGET_UNSUPPORTED" });
    await prepareNativeArtifact({ root: options.root ?? nativeCacheRoot(), manifest, version: manifest.defaultVersion,
      repairCorrupt: command === "repair confirm",
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }) });
    // Selection changes only after the fixed default artifact has been verified.
    writeDriverSelection({ driver: "rust-native", nativeVersion: manifest.defaultVersion }, options.selectionFile);
    return `Trusted Native ${manifest.defaultVersion} installed and selected. Restart Pi to initialize messaging with the installed driver.`;
  } catch (error) {
    return `Native command failed (${errorCode(error)}). Current selection was not changed.`;
  }
}
