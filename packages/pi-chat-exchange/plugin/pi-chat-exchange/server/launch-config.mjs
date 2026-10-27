import { isAbsolute, join, normalize } from "node:path";

export function resolveLauncherConfigPath(argv, accountHome) {
  if (argv.length === 0) {
    return join(accountHome, ".config/pi-chat-exchange/mcp-binding.json");
  }
  if (
    argv.length !== 2 ||
    argv[0] !== "--config" ||
    typeof argv[1] !== "string" ||
    !isAbsolute(argv[1]) ||
    normalize(argv[1]) !== argv[1]
  ) {
    throw new Error("CE_PLUGIN_LAUNCH_INVALID");
  }
  return argv[1];
}
