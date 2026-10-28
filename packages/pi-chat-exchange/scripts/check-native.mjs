#!/usr/bin/env node
/** Static Native compatibility and distribution checks. No downloads or installs. */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const cargoPath = join(root, "native", "ce-sqlite", "Cargo.toml");
const compatPath = join(root, "src", "storage", "native-compat.ts");
const cargo = readFileSync(cargoPath, "utf8");
const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"$/m)?.[1];
if (cargoVersion === undefined || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(cargoVersion)) {
  errors.push("native/ce-sqlite/Cargo.toml: version must be canonical SemVer");
}
const compat = ts.createSourceFile(compatPath, readFileSync(compatPath, "utf8"), ts.ScriptTarget.ES2023, true);
let defaultVersion;
let abiVersion;
function visit(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    if (node.name.text === "NATIVE_DEFAULT_VERSION" && ts.isStringLiteral(node.initializer)) defaultVersion = node.initializer.text;
    if (node.name.text === "NATIVE_ABI_VERSION" && ts.isNumericLiteral(node.initializer)) abiVersion = Number(node.initializer.text);
  }
  ts.forEachChild(node, visit);
}
visit(compat);
if (defaultVersion !== cargoVersion) errors.push(`Native version mismatch: Cargo ${cargoVersion} vs NATIVE_DEFAULT_VERSION ${defaultVersion}`);
if (abiVersion !== 1) errors.push(`Native ABI must remain 1 for this compatibility line, got ${abiVersion}`);
if (compat.text.includes("latest")) errors.push("native-compat.ts: latest is not an allowed runtime selector");
for (const match of compat.text.matchAll(/asset:\s*nativeAssetName\(([^)]+)\)/g)) {
  if (!match[1].includes("NATIVE_DEFAULT_VERSION")) errors.push(`native-compat.ts: asset must use the explicit version: ${match[0]}`);
}
let packageJson;
try {
  packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
} catch (error) {
  errors.push(`package.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
}
const files = packageJson?.files ?? [];
for (const pattern of files) {
  if (/\.node$|\.dylib$|\.so(?:\.\d+)*$|\.dll$/.test(pattern)) errors.push(`package.json files must not include Native binary: ${pattern}`);
}
for (const required of ["native/ce-sqlite/Cargo.toml", "native/ce-sqlite/build.rs", "native/ce-sqlite/rust-toolchain.toml", "native/ce-sqlite/src/lib.rs"]) {
  if (!existsSync(join(root, required)) || !statSync(join(root, required)).isFile()) errors.push(`missing Native source file: ${required}`);
}
if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exit(1);
}
console.log(`Native compatibility checks passed (middleware ${cargoVersion}, ABI ${abiVersion}, npm file patterns exclude explicit Native binaries; verify the packed archive separately)`);
