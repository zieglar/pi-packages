/**
 * Fail-closed provenance guard for the Wayforge extension.
 *
 * Wayforge may coexist only with a Pi session whose routing, multi-account,
 * and advisor capabilities are not already owned by a competing extension.
 * The guard inspects canonical tool/command provenance from the live session
 * and reports actionable diagnostics; it never uninstalls or mutates other
 * extensions.
 */

export interface GuardSourceInfo {
  readonly path?: string;
  readonly source?: string;
}

export interface GuardToolRecord {
  readonly name: string;
  readonly sourceInfo?: GuardSourceInfo;
}

export interface GuardCommandRecord {
  readonly name: string;
  readonly sourceInfo?: GuardSourceInfo;
}

export interface OwnershipGuardInput {
  readonly tools: readonly GuardToolRecord[];
  readonly commands: readonly GuardCommandRecord[];
}

export type OwnershipGuardResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly failures: readonly string[] };

/** Packages whose active presence competes with Wayforge ownership. */
export const COMPETING_OWNER_SOURCES: readonly string[] = [
  "pi-shift-router",
  "pi-multi-account",
  "pi-advisor-flow",
];

/** Tool names Wayforge reserves in this session. */
export const WAYFORGE_TOOL_NAMES: readonly string[] = [
  "wayforge_task_status",
  "wayforge_delegate_workers",
  "wayforge_advise",
  "wayforge_record_validation",
  "wayforge_complete",
  "wayforge_cancel",
  "wayforge_tasks",
];

export const WAYFORGE_COMMAND_NAME = "wayforge";

const WAYFORGE_SOURCE = "wayforge";

function provenance(record: GuardToolRecord | GuardCommandRecord): string {
  const info = record.sourceInfo;
  if (info === undefined) return "unknown source";
  return info.source ?? info.path ?? "unknown source";
}

function isWayforgeOwned(record: GuardToolRecord | GuardCommandRecord): boolean {
  const info = record.sourceInfo;
  if (info === undefined) return false;
  if (info.source === WAYFORGE_SOURCE) return true;
  const path = info.path ?? "";
  return /(^|[/\\])wayforge([/\\.]|$)/i.test(path);
}

function mentionsCompetingSource(record: GuardToolRecord | GuardCommandRecord): string | undefined {
  const info = record.sourceInfo;
  const haystack = [info?.source ?? "", info?.path ?? ""].join(" ");
  return COMPETING_OWNER_SOURCES.find((candidate) => haystack.includes(candidate));
}

export function checkOwnershipGuard(input: OwnershipGuardInput): OwnershipGuardResult {
  const failures: string[] = [];

  for (const tool of input.tools) {
    const competing = mentionsCompetingSource(tool);
    if (competing !== undefined) {
      failures.push(
        `tool "${tool.name}" is owned by competing package "${competing}" (${provenance(tool)}); ` +
          "Wayforge fails closed — disable that extension or remove Wayforge from this session",
      );
      continue;
    }
    if (tool.name.startsWith("wayforge_") && !isWayforgeOwned(tool)) {
      failures.push(
        `reserved tool "${tool.name}" is registered by a foreign source (${provenance(tool)}); ` +
          "Wayforge fails closed — remove the duplicate registration before using Wayforge",
      );
    }
  }

  for (const command of input.commands) {
    const competing = mentionsCompetingSource(command);
    if (competing !== undefined) {
      failures.push(
        `command "/${command.name}" is owned by competing package "${competing}" (${provenance(command)}); ` +
          "Wayforge fails closed — disable that extension or remove Wayforge from this session",
      );
      continue;
    }
    if (command.name === WAYFORGE_COMMAND_NAME && !isWayforgeOwned(command)) {
      failures.push(
        `command "/${WAYFORGE_COMMAND_NAME}" is registered by a foreign source (${provenance(command)}); ` +
          "Wayforge fails closed — remove the duplicate registration before using Wayforge",
      );
    }
  }

  if (failures.length > 0) return { ok: false, failures };
  return { ok: true };
}
