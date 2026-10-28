// Test subprocesses only; production module resolution is unchanged.
import { registerHooks } from "node:module";
import { resolve } from "./ts-resolve.mjs";
registerHooks({ resolve });
