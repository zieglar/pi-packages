import { readFileSync, statSync } from "node:fs";
import { normalize } from "node:path";

// Homebrew's two-line shim preserves PID/lstart across exec. Only exact forms
// backed by the script can participate in process ownership matching.
export interface WrapperIdentityEvidence {
  /** No-argument absolute shebang; ambiguous interpreter arguments yield no form. */
  readonly shellPrefix?: string | undefined;
  /** Literal path, not realpath: exec exposes this spelling in process argv. */
  readonly execTarget?: string | undefined;
}

const MAX_WRAPPER_BYTES = 4096;
const SHEBANG_RE = /^#!(\/[^\s\u0000]+)$/;
// Double quotes still expand dollars and backticks; those are not literal paths.
const WRAPPER_EXEC_RE = /^exec "(\/[^"\\\r\n\u0000$`]+)" "\$@"$/;

export function resolveWrapperIdentityEvidence(
  clientPath: string,
  validateExecTarget?: (target: string) => void,
): WrapperIdentityEvidence | undefined {
  let text: string;
  try {
    const stat = statSync(clientPath);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_WRAPPER_BYTES) return undefined;
    text = readFileSync(clientPath, "utf8");
  } catch {
    return undefined;
  }
  if (!text.startsWith("#!")) return {};
  const lines = text.split("\n");
  const shebang = SHEBANG_RE.exec((lines[0] ?? "").replace(/\r$/, ""));
  const shellPrefix = shebang !== null && /^[ -~]+$/.test(shebang[1]!) && normalize(shebang[1]!) === shebang[1]!
    ? shebang[1]!
    : undefined;
  const evidence: { shellPrefix?: string | undefined; execTarget?: string | undefined } =
    shellPrefix === undefined ? {} : { shellPrefix };
  // The entire body must be one strict exec line, with only comments/blanks
  // alongside it. Heredocs, extra statements and ambiguous argv yield no target.
  const meaningful = lines.slice(1).filter((line) => {
    const trimmed = line.trim();
    return trimmed !== "" && !trimmed.startsWith("#");
  });
  if (meaningful.length !== 1) return evidence;
  const execMatch = WRAPPER_EXEC_RE.exec(meaningful[0]!);
  if (execMatch === null) return evidence;
  const target = execMatch[1]!;
  if (!/^[ -~]+$/.test(target) || normalize(target) !== target) return evidence;
  // Admission must reject an invalid literal target before the identity-only
  // parser can omit it. Do not replace the argv spelling with its canonical path.
  validateExecTarget?.(target);
  try {
    if (!statSync(target).isFile()) return evidence;
  } catch {
    return evidence;
  }
  evidence.execTarget = target;
  return evidence;
}
