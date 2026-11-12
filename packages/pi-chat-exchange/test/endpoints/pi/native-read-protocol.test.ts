import { expect, it, vi } from "vitest";
import { createNativeReadProtocol } from "../../../pi-extension/native-read-protocol.js";

const raw = () => ({ content: [{ type: "text" as const, text: "exact bytes" }], details: { messageId: "msg_A" } });
const displayed = { content: [{ type: "text" as const, text: "indexed" }], details: { text: "indexed" } };
const outcome = (id: string, isError = false) => ({ toolCall: { type: "toolCall" as const, id, name: "ce_read_payload", arguments: {} }, result: displayed, isError });

it("preserves registered-tool and hook refusals, even after a raw capture", async () => {
  const p = createNativeReadProtocol();
  const executeTool = vi.fn(async () => { p.capture("parent/1", "ce_read_payload", "msg_A", raw()); return outcome("parent/1", true); });
  const result = await p.run("parent", "msg_A", { executeTool }, ctx => ctx.executeTool("ce_read_payload", { messageId: "msg_A" }));
  expect(result).toEqual(outcome("parent/1", true));
  expect(executeTool).toHaveBeenCalledTimes(1);
});

it.each(["parent", "message", "tool", "identity"])("cannot use a capture for another %s", async boundary => {
  const p = createNativeReadProtocol();
  const executeTool = async () => {
    p.capture(boundary === "parent" ? "other/1" : "parent/1", boundary === "tool" ? "ce_read" : "ce_read_payload", boundary === "message" ? "msg_B" : "msg_A", raw());
    return outcome(boundary === "identity" ? "parent/2" : "parent/1");
  };
  const result = await p.run("parent", "msg_A", { executeTool }, ctx => ctx.executeTool("ce_read_payload", { messageId: "msg_A" }));
  expect(result.result).toEqual(displayed);
});

it("does not mistake an ordinary numeric tool ID for a nested scope", async () => {
  const p = createNativeReadProtocol();
  const executeTool = async () => { p.capture("123", "ce_read_payload", "msg_A", raw()); return outcome("123"); };
  const result = await p.run("12", "msg_A", { executeTool }, ctx => ctx.executeTool("ce_read_payload", { messageId: "msg_A" }));
  expect(result.result).toEqual(displayed);
});

it("owns a snapshot before hooks can mutate it and clears the scope on failure", async () => {
  const p = createNativeReadProtocol();
  const executeTool = async () => {
    const original = raw(); p.capture("parent/1", "ce_read_payload", "msg_A", original);
    original.content[0]!.text = "mutated";
    return outcome("parent/1");
  };
  await expect(p.run("parent", "msg_A", { executeTool }, async ctx => {
    expect((await ctx.executeTool("ce_read_payload", { messageId: "msg_A" })).result.content).toEqual(raw().content);
    p.capture("parent/2", "ce_read_payload", "msg_A", raw());
    throw Error("stop");
  })).rejects.toThrow("stop");
  // A subsequent scope cannot pick up an unconsumed payload from the failed call.
  const result = await p.run("parent", "msg_A", { executeTool: async () => outcome("parent/2") }, ctx => ctx.executeTool("ce_read_payload", { messageId: "msg_A" }));
  expect(result.result).toEqual(displayed);
});
