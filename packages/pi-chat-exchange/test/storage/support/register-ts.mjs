// Test subprocesses only; production module resolution is unchanged.
import { register } from "node:module";
register(new URL("./ts-resolve.mjs", import.meta.url));
