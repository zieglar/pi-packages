import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contractPath = resolve(root, "docs/dh0-residency-contract.md");

function contract(): string {
  expect(existsSync(contractPath), "DH-0 must have a documented architecture contract").toBe(true);
  return readFileSync(contractPath, "utf8");
}

// Independent discovery from production source: adding/renaming a registered
// tool without updating its inventory fails. This proves coverage, not budgets.
function registeredTools(): string[] {
  const path = resolve(root, "src/runtime/extension-tools.ts");
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const names: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "defineTool") {
      const object = node.arguments[0];
      expect(object !== undefined && ts.isObjectLiteralExpression(object), "inspect changed tool registration shape").toBe(true);
      if (object !== undefined && ts.isObjectLiteralExpression(object)) {
        const name = object.properties.find((property) =>
          ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === "name",
        );
        expect(name !== undefined && ts.isPropertyAssignment(name) && ts.isStringLiteral(name.initializer),
          "inspect changed tool name shape").toBe(true);
        if (name !== undefined && ts.isPropertyAssignment(name) && ts.isStringLiteral(name.initializer)) {
          names.push(name.initializer.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect(names.length, "production tool discovery must not pass vacuously").toBeGreaterThan(0);
  return names.sort();
}

describe("DH-0 architecture documentation coverage (not runtime enforcement)", () => {
  it("inventories every production tool exactly once", () => {
    const text = contract();
    const rows = [...text.matchAll(/^\| `(wayforge_[a-z_]+)` \|/gm)].map((match) => match[1] ?? "");
    expect(rows.sort()).toEqual(registeredTools());
  });

  it("is reachable from the normative design constitution", () => {
    contract();
    expect(readFileSync(resolve(root, "DESIGN.md"), "utf8")).toContain("docs/dh0-residency-contract.md");
  });

  it("has resolvable local evidence and test links", () => {
    const links = [...contract().matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => match[1] ?? "");
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      if (/^(?:https?:|#)/.test(link)) continue;
      expect(existsSync(resolve(dirname(contractPath), link.split("#")[0] ?? "")), link).toBe(true);
    }
  });
});
