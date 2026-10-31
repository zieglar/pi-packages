// Preserve CE's existing legacy IDs and the official namespaced form verbatim.
// The final assertion requires the actual end, unlike `$` before a trailing newline.
export const TUNNEL_ID_PATTERN = /^tunnel_(?:[A-Za-z0-9]{8,}|[a-z0-9]{4}_[a-z0-9]{32})(?![\s\S])/;
