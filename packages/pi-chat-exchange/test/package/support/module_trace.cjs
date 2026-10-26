// Minimal module-resolution trace preload, reused verbatim from the
// independent distribution verifier (/private/tmp/ce-distribution-fix/final-cf299/trace/trace.cjs).
// Records every CJS/ESM resolution (and load) into CE_TRACE_OUT so the
// installed-host lane can prove every filesystem resolution stayed inside the
// physically installed trees. Recording only — no behaviour change.
const fs = require("node:fs");
const Module = require("node:module");
const OUT = process.env.CE_TRACE_OUT;
const rec = (kind, spec, parent, resolved, err) => {
  fs.appendFileSync(OUT, JSON.stringify({kind, spec, parent, resolved, err}) + "\n");
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (spec, parent, ...rest) {
  try { const r = origResolve.call(this, spec, parent, ...rest); rec("cjs", spec, parent && parent.filename, r, null); return r; }
  catch (e) { rec("cjs", spec, parent && parent.filename, null, String(e.code || e.message)); throw e; }
};
if (typeof Module.registerHooks === "function") {
  Module.registerHooks({
    resolve(spec, ctx, next) {
      try { const r = next(spec, ctx); rec("esm", spec, ctx && ctx.parentURL, r && r.url, null); return r; }
      catch (e) { rec("esm", spec, ctx && ctx.parentURL, null, String(e.code || e.message)); throw e; }
    },
    load(url, ctx, next) { rec("load", url, null, url, null); return next(url, ctx); },
  });
}
