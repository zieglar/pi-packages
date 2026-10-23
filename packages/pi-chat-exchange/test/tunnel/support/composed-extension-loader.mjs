// Synthetic process tests only: TS suffix resolution and presentation/transport seams.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const extension = new URL('../../../pi-extension/', import.meta.url).href;
const activation = new URL('../../../dist/tunnel/messaging-activation-ui.js', import.meta.url).href;
const background = new URL('../../../dist/tunnel/background-manager.js', import.meta.url).href;
export async function resolve(specifier, context, next) {
  if (context.parentURL?.startsWith(extension)) {
    const url = new URL(specifier, context.parentURL).href;
    if (url === activation) return { url: 'synthetic:activation', shortCircuit: true };
    if (url === background) return { url: 'synthetic:background', shortCircuit: true };
    if (url.endsWith('.js') && !existsSync(fileURLToPath(url))) {
      const ts = url.slice(0, -3) + '.ts';
      if (ts.startsWith(extension) && existsSync(fileURLToPath(ts))) return next(ts, context);
    }
  }
  return next(specifier, context);
}
export async function load(url, context, next) {
  if (url === 'synthetic:activation') return { format: 'module', shortCircuit: true, source: 'export async function confirmMessagingActivation(ctx, options) { return ctx.ui.confirm("synthetic operator activation", options.view); }' };
  if (url === 'synthetic:background') return { format: 'module', shortCircuit: true, source: `
    export * from ${JSON.stringify(background)};
    import { createBackgroundTunnelManager as actual } from ${JSON.stringify(background)};
    export function createBackgroundTunnelManager(options) { return actual({ ...options,
      listProcesses: async () => ({ kind: 'ok', processes: [] }),
      spawn: () => { throw Error('NO REAL TUNNEL SPAWN'); },
      signal: () => { throw Error('NO REAL TUNNEL SIGNAL'); }
    }); }
  ` };
  return next(url, context);
}
