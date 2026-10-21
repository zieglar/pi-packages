import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const sourceRoot = new URL("../../../src/", import.meta.url).href;

/** Only fall back for missing relative .js imports within this package's src.
 * Built-ins, dependencies, existing JS files and unrelated errors pass through. */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (error.code !== "ERR_MODULE_NOT_FOUND" ||
        !context.parentURL?.startsWith(sourceRoot) ||
        !(specifier.startsWith("./") || specifier.startsWith("../")) ||
        !specifier.endsWith(".js")) throw error;
    const sibling = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
    if (!sibling.href.startsWith(sourceRoot) || !existsSync(fileURLToPath(sibling))) throw error;
    return nextResolve(sibling.href, context);
  }
}
