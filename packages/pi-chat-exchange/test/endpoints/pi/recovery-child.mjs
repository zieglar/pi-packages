import fs from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { syncBuiltinESMExports } from "node:module";
import factory from "../../../pi-extension/index.ts";

const [nativeFile, mode] = process.argv.slice(2);
const manager = SessionManager.open(nativeFile);
const nativeId = manager.getSessionId();
const entries = () => manager.getEntries();
const commands = new Map(), events = new Map(), tools = new Map();
const messages = [];
const [, stage, fault, marker] = mode.split(":");
const originalSync = fs.fsyncSync, originalRead = fs.readSync;
let injected = false;
const nativeInode = fs.statSync(nativeFile).ino;
const atStage = fd => !injected && fs.fstatSync(fd).ino === nativeInode && entries().at(-1)?.customType === stage;
if (fault === "fsync") fs.fsyncSync = fd => {
  if (atStage(fd)) { injected = true; throw new Error("injected fsync failure"); }
  return originalSync(fd);
};
if (fault === "tail") fs.readSync = (fd, ...args) => {
  if (atStage(fd)) { injected = true; return 0; }
  return originalRead(fd, ...args);
};
syncBuiltinESMExports();
const ctx = { mode: "tui", hasUI: true, cwd: process.cwd(), sessionManager: {
  getSessionId: () => nativeId, getSessionFile: () => nativeFile,
  getBranch: () => manager.getBranch(), getEntries: entries,
}, ui: { notify: message => messages.push(message), confirm: async () => true } };
factory({ on: (event, handler) => events.set(event, handler), registerCommand: (name, command) => commands.set(name, command.handler),
  registerTool: tool => tools.set(tool.name, tool), appendEntry(customType, data) {
    if (customType === "ce-lifecycle-blocked" && marker === "fail") throw new Error("injected later marker failure");
    manager.appendCustomEntry(customType, data);
    if (fault === "visible" && customType === stage) throw new Error("injected visible-then-throw");
    if (mode === "crash-attempt" && customType === "ce-recovery-attempt") {
      const fd = fs.openSync(nativeFile, "r"); fs.fsyncSync(fd); fs.closeSync(fd);
      process.exit(73); // Deliberately no lifecycle cleanup/finally.
    }
  } });
await events.get("session_start")({ reason: "startup" }, ctx);
const result = await tools.get("ce_inbox_list").execute("child", {}, undefined, undefined, ctx);
console.log(JSON.stringify({ isError: result.isError === true, messages, mappings: entries().filter(e => e.customType === "ce-mapping").length }));
if (mode.startsWith("write-fail:")) process.exit(0); // Unknown writer exits without attempting release.
await events.get("session_shutdown")({ reason: "quit" }, ctx);
