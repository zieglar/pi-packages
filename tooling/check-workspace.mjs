#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = resolve(root, "packages");
const allowedPackageDirectories = new Set(["wayforge", "pi-chat-exchange"]);
const requiredScripts = ["typecheck", "test", "check"];
const dependencyFields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const runtimeDependencyFields = ["dependencies", "peerDependencies", "optionalDependencies"];
const sourceExtensions = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"]);
const lockfileNames = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]);
const errors = [];

const packageDirectories = existsSync(packagesRoot)
  ? readdirSync(packagesRoot, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith("."))
      .map((entry) => {
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          errors.push(`packages/${entry.name}: package entries must be real directories`);
          return undefined;
        }
        if (!allowedPackageDirectories.has(entry.name)) {
          errors.push(`packages/${entry.name}: not in the frozen package inventory`);
        }
        return { directoryName: entry.name, root: resolve(packagesRoot, entry.name) };
      })
      .filter(Boolean)
  : [];

const packages = [];
for (const packageDirectory of packageDirectories) {
  const manifestPath = resolve(packageDirectory.root, "package.json");
  if (!existsSync(manifestPath)) {
    errors.push(`packages/${packageDirectory.directoryName}: missing package.json`);
    continue;
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    errors.push(`packages/${packageDirectory.directoryName}/package.json: ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }
  if (typeof manifest.name !== "string" || manifest.name.length === 0) {
    errors.push(`packages/${packageDirectory.directoryName}/package.json: missing package name`);
    continue;
  }
  for (const script of requiredScripts) {
    if (typeof manifest.scripts?.[script] !== "string") {
      errors.push(`${manifest.name}: missing required script ${script}`);
    }
  }
  if (existsSync(resolve(packageDirectory.root, "tsconfig.build.json")) && typeof manifest.scripts?.build !== "string") {
    errors.push(`${manifest.name}: tsconfig.build.json requires a build script`);
  }
  packages.push({ ...packageDirectory, manifest, manifestPath });
}

const packageByName = new Map();
for (const workspacePackage of packages) {
  if (packageByName.has(workspacePackage.manifest.name)) {
    errors.push(`duplicate package name: ${workspacePackage.manifest.name}`);
  }
  packageByName.set(workspacePackage.manifest.name, workspacePackage);
}

for (const workspacePackage of packages) {
  inspectNestedLockfiles(workspacePackage.root, workspacePackage.manifest.name);
  inspectImports(workspacePackage);
  inspectEntryPaths(workspacePackage);
}
inspectRuntimeCycles(packages, packageByName);

if (errors.length > 0) {
  console.error(`WORKSPACE VIOLATIONS (${errors.length}):`);
  for (const error of errors.sort()) console.error(`  - ${error}`);
  process.exitCode = 1;
} else {
  console.log(`WORKSPACE OK: ${packages.length} package${packages.length === 1 ? "" : "s"}; inventory, scripts, locks, imports, entries, and dependency graph valid`);
}

function inspectNestedLockfiles(directory, packageName) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) {
      errors.push(`${packageName}: symbolic link is not allowed in package tree: ${relative(root, path)}`);
    } else if (entry.isDirectory()) {
      inspectNestedLockfiles(path, packageName);
    } else if (lockfileNames.has(entry.name)) {
      errors.push(`${packageName}: nested lockfile is forbidden: ${relative(root, path)}`);
    }
  }
}

function inspectImports(workspacePackage) {
  const declared = new Set(
    dependencyFields.flatMap((field) => Object.keys(workspacePackage.manifest[field] ?? {})),
  );
  for (const directoryName of ["src", "test", "scripts"]) {
    const directory = resolve(workspacePackage.root, directoryName);
    if (!existsSync(directory)) continue;
    for (const file of sourceFiles(directory)) {
      const content = readFileSync(file, "utf8");
      for (const specifier of importSpecifiers(content)) {
        if (specifier.startsWith(".")) {
          const target = resolve(dirname(file), specifier);
          if (!isWithin(workspacePackage.root, target)) {
            errors.push(`${workspacePackage.manifest.name}: relative import escapes package in ${relative(root, file)}: ${specifier}`);
          }
          continue;
        }
        const dependency = [...packageByName.keys()].find(
          (name) => specifier === name || specifier.startsWith(`${name}/`),
        );
        if (!dependency || dependency === workspacePackage.manifest.name) continue;
        if (!declared.has(dependency)) {
          errors.push(`${workspacePackage.manifest.name}: undeclared internal dependency ${dependency} in ${relative(root, file)}`);
        }
        const subpath = specifier.slice(dependency.length + 1);
        if (subpath === "src" || subpath.startsWith("src/") || subpath === "dist" || subpath.startsWith("dist/")) {
          errors.push(`${workspacePackage.manifest.name}: private source/output import in ${relative(root, file)}: ${specifier}`);
        }
      }
    }
  }
}

function inspectEntryPaths(workspacePackage) {
  const entries = new Set();
  collectEntry(workspacePackage.manifest.main, entries);
  collectEntry(workspacePackage.manifest.types, entries);
  collectEntry(workspacePackage.manifest.bin, entries);
  collectEntry(workspacePackage.manifest.exports, entries);
  for (const entry of entries) {
    if (!entry.startsWith("./") || isAbsolute(entry)) {
      errors.push(`${workspacePackage.manifest.name}: entry must be package-relative: ${entry}`);
      continue;
    }
    const target = resolve(workspacePackage.root, entry);
    if (!isWithin(workspacePackage.root, target)) {
      errors.push(`${workspacePackage.manifest.name}: entry escapes package: ${entry}`);
      continue;
    }
    if (!existsSync(target) && !entry.startsWith("./dist/") && entry !== "./dist") {
      errors.push(`${workspacePackage.manifest.name}: entry does not exist: ${entry}`);
    }
    if ((entry.startsWith("./dist/") || entry === "./dist") && typeof workspacePackage.manifest.scripts?.build !== "string") {
      errors.push(`${workspacePackage.manifest.name}: dist entry requires a build script: ${entry}`);
    }
  }
}

function inspectRuntimeCycles(workspacePackages, byName) {
  const graph = new Map(
    workspacePackages.map((workspacePackage) => [
      workspacePackage.manifest.name,
      runtimeDependencyFields
        .flatMap((field) => Object.keys(workspacePackage.manifest[field] ?? {}))
        .filter((name) => byName.has(name)),
    ]),
  );
  const visiting = new Set();
  const visited = new Set();
  const visit = (name, trail) => {
    if (visiting.has(name)) {
      errors.push(`circular runtime dependency: ${[...trail, name].join(" -> ")}`);
      return;
    }
    if (visited.has(name)) return;
    visiting.add(name);
    for (const dependency of graph.get(name) ?? []) visit(dependency, [...trail, name]);
    visiting.delete(name);
    visited.add(name);
  };
  for (const name of graph.keys()) visit(name, []);
}

function sourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.isFile() && sourceExtensions.has(extname(entry.name))) files.push(path);
  }
  return files;
}

function importSpecifiers(content) {
  const specifiers = [];
  const pattern = /(?:\b(?:import|export)\s+(?:[^"']*?\s+from\s*)?|\bimport\s*\(|\brequire\s*\()\s*["']([^"']+)["']/g;
  for (const match of content.matchAll(pattern)) specifiers.push(match[1]);
  return specifiers;
}

function collectEntry(value, entries) {
  if (typeof value === "string") {
    if (!value.startsWith("node:")) entries.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectEntry(item, entries);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectEntry(item, entries);
  }
}

function isWithin(base, target) {
  const path = relative(base, target);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}
