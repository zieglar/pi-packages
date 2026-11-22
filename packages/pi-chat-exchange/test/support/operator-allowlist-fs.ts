import type * as Fs from "node:fs";

/** Preserve filesystem/security APIs while faking only this legacy fixture's
 * explicit allowlist and synthetic Store existence. Unknown files stay real. */
export function operatorAllowlistFs(
  actual: typeof Fs,
  document: () => string,
  options: { storeExists?: () => boolean; onRead?: (path: string) => void } = {},
): typeof Fs {
  return {
    ...actual,
    existsSync: path => {
      const name = String(path);
      if (process.env.CE_ALLOWLIST && name === process.env.CE_ALLOWLIST) return true;
      if (name.endsWith(".sqlite")) return options.storeExists?.() ?? true;
      return actual.existsSync(path);
    },
    readFileSync: ((...args: Parameters<typeof Fs.readFileSync>) => {
      const name = String(args[0]);
      options.onRead?.(name);
      if (process.env.CE_ALLOWLIST && name === process.env.CE_ALLOWLIST) return document();
      return actual.readFileSync(...args);
    }) as typeof Fs.readFileSync,
  };
}
