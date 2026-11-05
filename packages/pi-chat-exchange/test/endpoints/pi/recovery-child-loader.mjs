// Node's type stripping leaves .js specifiers intact in the unbuilt extension.
// Limit this test-only resolver to extension-local files; compiled Host/Store
// modules still load directly from dist.
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.includes("/pi-extension/") && specifier.startsWith("./") && specifier.endsWith(".js")) {
    const target = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
    if (existsSync(fileURLToPath(target))) return nextResolve(target.href, context);
  }
  return nextResolve(specifier, context);
} });
