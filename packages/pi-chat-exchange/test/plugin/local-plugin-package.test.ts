import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, chmodSync, constants, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(import.meta.dirname, "../..");
const pluginRoot = resolve(packageRoot, "plugin/pi-chat-exchange");
const stagedRoot = resolve(packageRoot, ".plugin-build/pi-chat-exchange");
const packageManifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as { version: string };
const archivePath = resolve(packageRoot, `.plugin-build/pi-chat-exchange-${packageManifest.version}.zip`);
const marketplaceRoot = resolve(packageRoot, ".plugin-build/marketplace");
const packageVerificationEnabled = process.env.CE_PLUGIN_PACKAGE_TEST === "1";
const chatgptDesktopPath = "/usr/bin:/bin:/usr/sbin:/sbin";

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(pluginRoot, relativePath), "utf8")) as Record<string, unknown>;
}

function listTree(root: string, relative = ""): string[] {
  return readdirSync(resolve(root, relative)).flatMap((name) => {
    const next = relative === "" ? name : `${relative}/${name}`;
    const stat = lstatSync(resolve(root, next));
    expect(stat.isSymbolicLink(), `unexpected symlink: ${next}`).toBe(false);
    return stat.isDirectory() ? [next, ...listTree(root, next)] : [next];
  });
}

describe("ChatGPT Desktop local plugin source package", () => {
  it("declares a portable plugin and a local stdio MCP server", () => {
    const manifest = readJson("plugin.json");
    expect(manifest).toMatchObject({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "pi-chat-exchange",
      version: packageManifest.version,
    });
    expect(manifest.version).toBe(packageManifest.version);

    const extensions = manifest.extensions as Record<string, Record<string, Record<string, unknown>>>;
    const pluginInterface = extensions["com.openai"]?.interface;
    expect(pluginInterface?.displayName).toBe("Pi Chat Exchange");
    expect(String(pluginInterface?.shortDescription).length).toBeLessThanOrEqual(30);

    const mcp = readJson("mcp.json");
    expect(mcp).toEqual({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: {},
    });

    const launcher = readFileSync(resolve(pluginRoot, "server/launch.mjs"), "utf8");
    const launcherConfig = readFileSync(resolve(pluginRoot, "server/launch-config.mjs"), "utf8");
    expect(launcherConfig).toContain(".config/pi-chat-exchange/mcp-binding.json");
    expect(launcher).toContain("userInfo().homedir");
    expect(launcher).not.toContain("homedir()");
    expect(launcher).not.toContain("process.env");
  });

  it("ships only a redacted binding example and documents the four-tool surface", () => {
    const templateText = readFileSync(resolve(pluginRoot, "config/binding.example.json"), "utf8");
    const template = JSON.parse(templateText) as Record<string, unknown>;
    expect(template).toMatchObject({
      version: 1,
      payloadRead: { enabled: false },
    });
    expect(templateText).not.toMatch(/cap_[0-9a-f]{16,}/i);
    expect(templateText).not.toMatch(/sk-[A-Za-z0-9_-]{12,}/);
    expect(templateText).not.toContain("/Users/");

    const readme = readFileSync(resolve(pluginRoot, "README.md"), "utf8");
    for (const tool of ["ping", "ce_send", "ce_inbox_list", "ce_read_payload"]) {
      expect(readme).toContain(`\`${tool}\``);
    }
    expect(readme).toContain("~/.config/pi-chat-exchange/mcp-binding.json");
  });

  it("resolves launcher config only from the account home or a strict local CLI override", async () => {
    const module = await import(pathToFileURL(resolve(pluginRoot, "server/launch-config.mjs")).href) as {
      resolveLauncherConfigPath: (argv: string[], accountHome: string) => string;
    };
    expect(module.resolveLauncherConfigPath([], "/home/operator")).toBe(
      "/home/operator/.config/pi-chat-exchange/mcp-binding.json",
    );
    expect(module.resolveLauncherConfigPath(["--config", "/tmp/test-binding.json"], "/home/operator")).toBe(
      "/tmp/test-binding.json",
    );
    expect(() => module.resolveLauncherConfigPath(["--config", "relative.json"], "/home/operator")).toThrow(
      "CE_PLUGIN_LAUNCH_INVALID",
    );
    expect(() => module.resolveLauncherConfigPath(["--other", "/tmp/config.json"], "/home/operator")).toThrow(
      "CE_PLUGIN_LAUNCH_INVALID",
    );
  });

  it.runIf(packageVerificationEnabled)("builds a self-contained single-root ZIP without source or development files", () => {
    const unexpectedSource = resolve(pluginRoot, ".env");
    writeFileSync(unexpectedSource, "TEST_ONLY=not-a-secret\n");
    try {
      expect(() => execFileSync(process.execPath, [resolve(packageRoot, "scripts/package-local-plugin.mjs")], {
        cwd: packageRoot,
        stdio: "pipe",
      })).toThrow();
    } finally {
      rmSync(unexpectedSource, { force: true });
    }

    execFileSync(process.execPath, [resolve(packageRoot, "scripts/package-local-plugin.mjs")], {
      cwd: packageRoot,
      stdio: "pipe",
    });

    const files = listTree(stagedRoot);
    expect(files).toContain("server/dist/bin/mcp-stdio.js");
    expect(files).toContain("server/node_modules/@modelcontextprotocol/sdk/package.json");
    expect(files).toContain("server/node_modules/@sinclair/typebox/package.json");
    expect(files).not.toContain("server/src");
    expect(files).not.toContain("server/test");
    expect(files).not.toContain("server/node_modules/.bin");

    const members = execFileSync("/usr/bin/unzip", ["-Z1", archivePath], {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    })
      .trim()
      .split("\n");
    expect(members.length).toBeGreaterThan(10);
    expect(members.every((member) => member.startsWith("pi-chat-exchange/"))).toBe(true);
    expect(members).toContain("pi-chat-exchange/server/dist/bin/mcp-stdio.js");

    expect(JSON.parse(readFileSync(resolve(marketplaceRoot, ".agents/plugins/marketplace.json"), "utf8"))).toMatchObject({
      name: "pi-chat-exchange-local",
      plugins: [{
        name: "pi-chat-exchange",
        source: { source: "local", path: "./plugins/pi-chat-exchange" },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      }],
    });
    expect(lstatSync(resolve(marketplaceRoot, "plugins/pi-chat-exchange/server/dist/bin/mcp-stdio.js")).isFile()).toBe(true);

    const packagedText = files
      .filter((file) => /\.(?:json|md|mjs)$/.test(file))
      .map((file) => readFileSync(resolve(stagedRoot, file), "utf8"))
      .join("\n");
    expect(packagedText).not.toMatch(/cap_[0-9a-f]{16,}/i);
    expect(packagedText).not.toMatch(/sk-[A-Za-z0-9_-]{12,}/);

    expect(packagedText).not.toContain("/Users/");
    const packagedMcp = JSON.parse(readFileSync(resolve(stagedRoot, "mcp.json"), "utf8"));
    expect(packagedMcp.mcpServers).toEqual({});
    expect(files).toContain("server/configure.mjs");
  }, 60_000);

  it.runIf(packageVerificationEnabled)("omits the redundant pnpm private deployment mirror from packaged servers", () => {
    for (const root of [stagedRoot, resolve(marketplaceRoot, "plugins/pi-chat-exchange")]) {
      expect(existsSync(resolve(root, "server/node_modules/.pnpm"))).toBe(false);
    }
  });

  it.runIf(packageVerificationEnabled)("starts the packaged launcher, discovers four tools, and answers ping", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "ce-plugin-it-"));
    const configDirectory = resolve(root, ".config/pi-chat-exchange");
    mkdirSync(configDirectory, { recursive: true });
    writeFileSync(resolve(configDirectory, "mcp-binding.json"), `${JSON.stringify({
      version: 1,
      store: { directory: resolve(root, "store") },
      exchange: { namespace: "plugin-it", idempotencyKey: "exchange-1" },
      endpoint: { adapter: "mcp", endpointId: "chatgpt-desktop" },
      recipients: [{ adapter: "pi", endpointId: "pi-main" }],
      payloadRead: { enabled: false },
    })}\n`);

    const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [
      resolve(stagedRoot, "server/launch.mjs"),
      "--config",
      resolve(configDirectory, "mcp-binding.json"),
    ], { stdio: ["pipe", "pipe", "pipe"] });
    const stderr: string[] = [];
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => stderr.push(...chunk.split("\n").filter(Boolean)));
    const lines = readline.createInterface({ input: child.stdout });
    const pending = new Map<number, (value: Record<string, unknown>) => void>();
    let nextId = 0;
    lines.on("line", (line) => {
      const message = JSON.parse(line) as Record<string, unknown> & { id?: number };
      if (typeof message.id === "number") pending.get(message.id)?.(message);
    });
    const call = (method: string, params: unknown) => new Promise<Record<string, unknown>>((resolveCall) => {
      const id = nextId++;
      pending.set(id, resolveCall);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

    try {
      await new Promise<void>((resolveReady, rejectReady) => {
        const deadline = setTimeout(
          () => rejectReady(new Error(`packaged server did not start: ${stderr.join(" | ")}`)),
          15_000,
        );
        const poll = () => {
          if (stderr.some((line) => line.startsWith("CE_MCP_STARTED"))) {
            clearTimeout(deadline);
            resolveReady();
          } else if (child.exitCode !== null) {
            clearTimeout(deadline);
            rejectReady(new Error(`packaged server exited: ${stderr.join(" | ")}`));
          } else setTimeout(poll, 25);
        };
        poll();
      });

      await call("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "plugin-package-test", version: "0.0.1" },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      const listed = await call("tools/list", {});
      expect((listed.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)).toEqual([
        "ping",
        "ce_send",
        "ce_inbox_list",
        "ce_read_payload",
      ]);
      const ping = await call("tools/call", { name: "ping", arguments: {} });
      expect((ping.result as { structuredContent: { status: string } }).structuredContent.status).toBe("reachable");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
      }
      lines.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it.runIf(packageVerificationEnabled)("launches the packaged plugin exactly as mcp.json declares under the ChatGPT Desktop PATH", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "ce-plugin-desktop-path-"));
    const localRoot = resolve(root, "local-plugin");
    cpSync(stagedRoot, localRoot, { recursive: true });
    chmodSync(localRoot, 0o700);
    const runtimeRoot = resolve(root, "portable runtime");
    mkdirSync(runtimeRoot, { mode: 0o700 });
    const approvedNodeCommand = resolve(runtimeRoot, "node");
    copyFileSync(process.execPath, approvedNodeCommand);
    chmodSync(approvedNodeCommand, 0o700);
    execFileSync(approvedNodeCommand, [resolve(localRoot, "server/configure.mjs"), "--node", approvedNodeCommand], {
      env: { PATH: "/usr/bin:/bin" }, cwd: localRoot, stdio: "pipe",
    });
    const stagedMcp = JSON.parse(readFileSync(resolve(localRoot, "mcp.json"), "utf8")) as {
      mcpServers: { "pi-chat-exchange": { type: string; command: string; args: string[]; cwd: string } };
    };
    const declared = stagedMcp.mcpServers["pi-chat-exchange"];
    expect(declared.type).toBe("stdio");
    expect(declared.command).toBe(approvedNodeCommand);
    expect(declared.command.startsWith("/")).toBe(true);
    expect(declared.args).toEqual(["${PLUGIN_ROOT}/server/launch.mjs"]);
    expect(declared.cwd).toBe("${PLUGIN_ROOT}");
    const expand = (value: string) => value.replaceAll("${PLUGIN_ROOT}", localRoot);
    const command = expand(declared.command);
    const args = declared.args.map(expand);
    const launchCwd = expand(declared.cwd);
    expect(() => accessSync(command, constants.X_OK)).not.toThrow();

    // The launcher resolves its binding from userInfo().homedir, which ignores
    // $HOME. To keep this regression away from the operator's real store while
    // spawning the exact declared command, args, and cwd, a preload hook
    // redirects only os.userInfo inside the child environment.
    const fakeHome = resolve(root, "home");
    const configDirectory = resolve(fakeHome, ".config/pi-chat-exchange");
    mkdirSync(configDirectory, { recursive: true });
    const storeDirectory = resolve(root, "store");
    writeFileSync(resolve(configDirectory, "mcp-binding.json"), `${JSON.stringify({
      version: 1,
      store: { directory: storeDirectory },
      exchange: { namespace: "plugin-desktop-path", idempotencyKey: "exchange-1" },
      endpoint: { adapter: "mcp", endpointId: "chatgpt-desktop" },
      recipients: [{ adapter: "pi", endpointId: "pi-main" }],
      payloadRead: { enabled: false },
    })}\n`);
    const hookSource = [
      "const os = require(\"node:os\");",
      "const realUserInfo = os.userInfo;",
      `const fakeHome = ${JSON.stringify(fakeHome)};`,
      "os.userInfo = (options) => {",
      "  const info = realUserInfo(options);",
      "  if (typeof info?.homedir !== \"string\") throw new Error(\"CE_TEST_HOOK_FAILED\");",
      "  return { ...info, homedir: fakeHome };",
      "};",
      "if (os.userInfo().homedir !== fakeHome) throw new Error(\"CE_TEST_HOOK_FAILED\");",
    ].join("\n");
    const hookPath = resolve(root, "redirect-user-info.cjs");
    writeFileSync(hookPath, `${hookSource}\n`);

    const child: ChildProcessWithoutNullStreams = spawn(command, args, {
      cwd: launchCwd,
      env: {
        PATH: chatgptDesktopPath,
        HOME: fakeHome,
        NODE_OPTIONS: `--require ${hookPath}`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stderr: string[] = [];
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => stderr.push(...chunk.split("\n").filter(Boolean)));
    const stdoutViolations: string[] = [];
    const lines = readline.createInterface({ input: child.stdout });
    const pending = new Map<number, (value: Record<string, unknown>) => void>();
    let nextId = 0;
    lines.on("line", (line) => {
      if (!line.trim()) return;
      let message: Record<string, unknown> & { id?: number };
      try {
        message = JSON.parse(line) as Record<string, unknown> & { id?: number };
      } catch {
        stdoutViolations.push(line);
        return;
      }
      if (typeof message.id === "number") pending.get(message.id)?.(message);
    });
    const call = (method: string, params: unknown) => new Promise<Record<string, unknown>>((resolveCall) => {
      const id = nextId++;
      pending.set(id, resolveCall);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

    try {
      try {
        await new Promise<void>((resolveReady, rejectReady) => {
          const deadline = setTimeout(
            () => rejectReady(new Error(`declared command did not start under PATH=${chatgptDesktopPath}: ${command} ${args.join(" ")} :: ${stderr.join(" | ")}`)),
            15_000,
          );
          const poll = () => {
            if (stderr.some((line) => line.startsWith("CE_MCP_STARTED"))) {
              clearTimeout(deadline);
              resolveReady();
            } else if (child.exitCode !== null) {
              clearTimeout(deadline);
              rejectReady(new Error(`declared command exited early under PATH=${chatgptDesktopPath}: ${stderr.join(" | ")}`));
            } else setTimeout(poll, 25);
          };
          poll();
        });

        const initialized = await call("initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "plugin-desktop-path-test", version: "0.0.1" },
        });
        expect((initialized.result as { serverInfo: { name: string; version: string } }).serverInfo).toEqual({
          name: "pi-chat-exchange",
          version: packageManifest.version,
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
        const listed = await call("tools/list", {});
        const tools = (listed.result as {
          tools: Array<{ name: string; inputSchema?: { additionalProperties?: boolean } }>;
        }).tools;
        expect(tools.map((tool) => tool.name)).toEqual([
          "ping",
          "ce_send",
          "ce_inbox_list",
          "ce_read_payload",
        ]);
        for (const tool of tools) {
          expect(tool.inputSchema?.additionalProperties, `schema for ${tool.name}`).toBe(false);
        }
        const ping = await call("tools/call", { name: "ping", arguments: {} });
        expect((ping.result as { structuredContent: { status: string } }).structuredContent.status).toBe("reachable");
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
          await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
        }
        lines.close();
      }

      expect(stdoutViolations).toEqual([]);
      expect(existsSync(storeDirectory) && readdirSync(storeDirectory).length > 0).toBe(true);
      expect(JSON.parse(readFileSync(resolve(stagedRoot, "mcp.json"), "utf8")).mcpServers).toEqual({});

      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 300));
      const lingering = execFileSync("/bin/ps", ["-axo", "stat=,command="], { encoding: "utf8" })
        .split("\n")
        .filter((line) => line.includes(localRoot) && !/^\s*Z/.test(line));
      expect(lingering).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
