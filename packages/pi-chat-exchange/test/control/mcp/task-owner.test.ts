import { expect, it } from "vitest";
import { callTaskOwner, validRegisteredTaskOwner } from "../../../src/control/mcp/task-owner.js";

const MESSAGE_ID = "msg_01M73NE8XRRBED0ER5QA9RF9JV";
const registration = {
  schemaVersion: 1 as const,
  exchangeId: "exchange-1",
  requestMessageId: "msg_01M73NE8XRRBED0ER5QA9RF9JW",
  messageId: MESSAGE_ID,
  from: "pi/session-a",
  to: "chatgpt/main",
  projectLabel: "Project A",
  taskOwner: "pi/session-a",
  ownerStatus: "REGISTERED" as const,
  probeId: "123e4567-e89b-42d3-a456-426614174000",
};

it("returns only a closed, exact TaskOwner registration", () => {
  expect(validRegisteredTaskOwner(registration)).toBe(true);
  expect(callTaskOwner({ lookup: () => registration }, { messageId: MESSAGE_ID }).structuredContent).toEqual(registration);
  expect(callTaskOwner({ lookup: () => ({ ...registration, messageId: "msg_01M73NE8XRRBED0ER5QA9RF9JX" }) }, { messageId: MESSAGE_ID }).structuredContent)
    .toEqual({ messageId: MESSAGE_ID, ownerStatus: "UNVERIFIED" });
  expect(validRegisteredTaskOwner({ ...registration, runtimeId: "runtime-a" })).toBe(false);
});

it("fails closed without leaking registry errors or accepting authority-shaped arguments", () => {
  expect(callTaskOwner({ lookup: () => { throw new Error("/private/registry secret"); } }, { messageId: MESSAGE_ID }).structuredContent)
    .toEqual({ messageId: MESSAGE_ID, ownerStatus: "UNVERIFIED" });
  for (const args of [
    {},
    { messageId: "bad" },
    { messageId: MESSAGE_ID, taskOwner: "pi/other" },
    { messageId: MESSAGE_ID, runtimeId: "runtime-a" },
    { messageId: MESSAGE_ID, endpointId: "pi/session-a" },
  ]) expect(() => callTaskOwner({ lookup: () => registration }, args)).toThrow("exact messageId required");
});
