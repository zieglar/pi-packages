# CE 0.2.0 license audit (repo-only)

Handoff: HANDOFF-CE-RELEASE-LICENSE-01, upstream evidence extended under HANDOFF-CE-RELEASE-LICENSE-01-R1. Evidence captured 2026-10-27.

## Authority and publication decision

The owner authorized MIT for CE own code only: Copyright (c) 2026 zieglar. No root blanket license applies (docs/licensing.md). Before this delta, the repository root and CE package contained no LICENSE/NOTICE/copyright declarations. The existing source and consumer payload were reviewed for copied/derived third-party declarations; none were found. Historical plans describe the prior missing authority and remain historical, not current release instructions.

`@narumitw/pi-tui-kit@0.66.0` is THIRD-PARTY, not owner code. All dependency bytes/pins, name/version/exports and the lockfile remain unchanged.

**`private: true` removed (owner-authorized condition met).** The two former evidence gaps closed with three distinctly-sourced layers of exact-version evidence, recorded at `/private/tmp/ce-release-license/evidence/upstream/` (R1 additions under `upstream/r1/`, digests in `upstream/r1/99-DIGESTS.txt`):

1. **License DECLARED in the npm package manifest.** `@earendil-works/pi-tui@1.3.0` (SHA-256 1ef7b630…42ef5d) and `@earendil-works/pi-coding-agent@1.3.0` (SHA-256 ae2785e8…d3c0) declare `license: MIT` in both registry metadata and the in-tarball `package.json`. The retained tarballs were proven to be the exact registry artifacts: their sha1/sha512 match `dist.shasum`/`dist.integrity`. A declaration is not a copyright or permission notice.
2. **License TEXT inside the npm tarball: ABSENT** for both items (`tar -tzf | grep -Ei '(^|/)(licen[cs]e|copying|notice)'` exits 1). Upstream packaging omission.
3. **License TEXT in the upstream repository: PRESENT.** github.com/earendil-works/pi tag `v1.3.0` — a lightweight tag resolved by `git ls-remote` and re-confirmed by `git rev-parse` to commit `71023aec1546d6d677a65669c5665c0927ce0dd0` — carries the monorepo root `LICENSE` (git blob `b0a8e9b8…`): the full MIT License with copyright notice `Copyright (c) 2025 Mario Zechner` and the MIT permission notice, saved verbatim as `upstream/r1/upstream-pi-v1.3.0-ROOT-LICENSE.txt` (SHA-256 0457f5bc…13c48).

Applicability of layer 3 to these exact versions is machine-checkable, not inferred: at that commit `packages/tui/package.json` and `packages/coding-agent/package.json` declare exactly `@earendil-works/pi-tui@1.3.0` and `@earendil-works/pi-coding-agent@1.3.0` with `license: MIT`; both in-tarball manifests carry `repository.directory` pointing at exactly those paths; and a recursive search finds no license/copying/notice file anywhere under either package directory at that tag, so the monorepo root `LICENSE` is the governing text. The non-built files shipped in the registry tarballs (READMEs, the coding-agent CHANGELOG, the schemas file list) are byte-identical to the same paths at `v1.3.0`. The `author` field (Mario Zechner) is recorded as metadata only and is **not** used as a substitute for any copyright or permission notice.

Classification moves from 证据不足 to 已验证兼容: the missing text is an upstream packaging omission, not incompatible terms; no upstream copyright line is invented beyond the verbatim root LICENSE. The original 证据不足 record is preserved byte-unchanged in `evidence/audit.json`; the reclassification is recorded separately and timestamped in `evidence/audit-supplement.json`. Recorded but not reconciled: the `v1.3.0` release commit is authored by Armin Ronacher while the LICENSE copyright holder and the `author` fields read Mario Zechner; compiled `dist/` output was not rebuilt from source. CE's tarball bundles none of their code, so no CE-side notice obligation is triggered by this artifact; redistribution of an installed tree or future bundled code still requires re-audit. Publication (push/tag/publish/Release/merge) remains unauthorized this round and requires separate authority.

## Exact dependency scope and evidence

The four direct runtime pins were traversed through installed dependencies and optionalDependencies: 100 unique name/version items, no missing required dependencies. The Host peer is inspected separately, not confused with CE bundled code. Optional peer `@cfworker/json-schema` is not installed. Other peers resolve to already enumerated runtime items or the independent Host. The Host dependency tree is a separate host distribution, not CE runtime-dependency redistribution.

The retained pnpm install uses a byte-identical repo pnpm-lock.yaml: SHA-256 `47ff210cafb44a9ac38184fda6504bfb3af6c5deb81d7add7077d40a5461a82d`. Offline existing dependencies were referenced for author tests; no dependency downloads or changes. `pnpm list --prod --depth Infinity --json`, traversal edges, exact installed paths, LICENSE filenames/hashes, verbatim license texts and per-version `npm view <name>@<version> license --json` stdout/stderr are retained at `/private/tmp/ce-release-license/evidence/`. Registry metadata only was fetched. A first query attempt failed before network because npm forbids loading /dev/null as both user/global config; all original outputs are preserved in `registry-first-attempt/`, and the explicit separate-config rerun succeeded for all 101 items.

## Notice reasoning

MIT is a permission grant with copyright and permission notice preservation, not a requirement that dependency copyrights be replaced by CE copyright. ISC and BSD-2/3-Clause notices must likewise remain with dependency copies; Apache-2.0 grok-mermaid retains its own LICENSE and any applicable NOTICE (none present at package root). These are compatible separate dependency licenses, not relicensed under CE MIT. Installed dependency packages carry their own notices except the two @earendil-works items, whose exact-version artifacts omit license text (upstream packaging omission; see the three-layer evidence in the publication-decision section). The TypeScript build emits CE modules with external bare imports; npm pack does not bundle dependency implementations/assets. Thus no third-party code copy in the CE tarball requires an additional CE-shipped notice now. If future bundling or redistribution of an installed tree occurs, preserve each applicable license/copyright/NOTICE and re-audit that artifact.

已验证兼容 means registry declaration plus license-text evidence for this unbundled distribution (installed text, or — for the two @earendil-works items — the exact-version registry tarball declaration plus the upstream v1.3.0 tag root LICENSE text with proven applicability); 需要补充声明 applies to an actual bundled/redistributed copy requiring a missing notice (none found here); 确认不兼容 requires actual contradictory terms (none found). 证据不足 is now an empty class.

## Per-item matrix

| Exact item | Registry license | Installed license/notice files | Classification |
|---|---|---|---|
| `@earendil-works/pi-coding-agent@1.3.0` | MIT | **absent** (tarball) — verified via tag `v1.3.0` root LICENSE: MIT, (c) 2025 Mario Zechner | 已验证兼容（上游文本省略注记） |
| `@earendil-works/pi-tui@1.3.0` | MIT | **absent** (tarball) — verified via tag `v1.3.0` root LICENSE: MIT, (c) 2025 Mario Zechner | 已验证兼容（上游文本省略注记） |
| `@hono/node-server@2.1.3` | MIT | LICENSE | 已验证兼容 |
| `@modelcontextprotocol/sdk@1.30.1` | MIT | LICENSE | 已验证兼容 |
| `@narumitw/pi-tui-kit@0.66.0` | MIT | LICENSE | 已验证兼容 |
| `@sinclair/typebox@0.34.52` | MIT | license | 已验证兼容 |
| `accepts@2.0.0` | MIT | LICENSE | 已验证兼容 |
| `ajv@8.20.0` | MIT | LICENSE | 已验证兼容 |
| `ajv-formats@3.0.1` | MIT | LICENSE | 已验证兼容 |
| `body-parser@2.3.0` | MIT | LICENSE | 已验证兼容 |
| `bytes@3.1.2` | MIT | LICENSE | 已验证兼容 |
| `call-bind-apply-helpers@1.0.2` | MIT | LICENSE | 已验证兼容 |
| `call-bound@1.0.4` | MIT | LICENSE | 已验证兼容 |
| `content-disposition@1.1.0` | MIT | LICENSE | 已验证兼容 |
| `content-type@1.0.5` | MIT | LICENSE | 已验证兼容 |
| `content-type@2.1.0` | MIT | LICENSE | 已验证兼容 |
| `cookie@0.7.2` | MIT | LICENSE | 已验证兼容 |
| `cookie-signature@1.2.2` | MIT | LICENSE | 已验证兼容 |
| `cors@2.8.6` | MIT | LICENSE | 已验证兼容 |
| `cross-spawn@7.0.6` | MIT | LICENSE | 已验证兼容 |
| `debug@4.4.3` | MIT | LICENSE | 已验证兼容 |
| `depd@2.0.0` | MIT | LICENSE | 已验证兼容 |
| `diff@9.0.0` | BSD-3-Clause | LICENSE | 已验证兼容 |
| `dunder-proto@1.0.1` | MIT | LICENSE | 已验证兼容 |
| `ee-first@1.1.1` | MIT | LICENSE | 已验证兼容 |
| `encodeurl@2.0.0` | MIT | LICENSE | 已验证兼容 |
| `es-define-property@1.0.1` | MIT | LICENSE | 已验证兼容 |
| `es-errors@1.3.0` | MIT | LICENSE | 已验证兼容 |
| `es-object-atoms@1.1.2` | MIT | LICENSE | 已验证兼容 |
| `escape-html@1.0.3` | MIT | LICENSE | 已验证兼容 |
| `etag@1.8.1` | MIT | LICENSE | 已验证兼容 |
| `eventsource@3.0.7` | MIT | LICENSE | 已验证兼容 |
| `eventsource-parser@3.1.1` | MIT | LICENSE | 已验证兼容 |
| `express@5.2.1` | MIT | LICENSE | 已验证兼容 |
| `express-rate-limit@8.7.0` | MIT | license | 已验证兼容 |
| `fast-deep-equal@3.1.3` | MIT | LICENSE | 已验证兼容 |
| `fast-uri@3.1.8` | BSD-3-Clause | LICENSE | 已验证兼容 |
| `finalhandler@2.1.1` | MIT | LICENSE | 已验证兼容 |
| `forwarded@0.2.0` | MIT | LICENSE | 已验证兼容 |
| `fresh@2.0.0` | MIT | LICENSE | 已验证兼容 |
| `function-bind@1.1.2` | MIT | LICENSE | 已验证兼容 |
| `get-east-asian-width@1.6.0` | MIT | license | 已验证兼容 |
| `get-intrinsic@1.3.0` | MIT | LICENSE | 已验证兼容 |
| `get-proto@1.0.1` | MIT | LICENSE | 已验证兼容 |
| `gopd@1.2.0` | MIT | LICENSE | 已验证兼容 |
| `grok-mermaid@0.2.3` | Apache-2.0 | LICENSE | 已验证兼容 |
| `has-symbols@1.1.0` | MIT | LICENSE | 已验证兼容 |
| `hasown@2.0.4` | MIT | LICENSE | 已验证兼容 |
| `highlight.js@11.12.0` | BSD-3-Clause | LICENSE | 已验证兼容 |
| `hono@4.13.13` | MIT | LICENSE | 已验证兼容 |
| `http-errors@2.0.1` | MIT | LICENSE | 已验证兼容 |
| `iconv-lite@0.7.3` | MIT | LICENSE | 已验证兼容 |
| `inherits@2.0.4` | ISC | LICENSE | 已验证兼容 |
| `ip-address@10.7.3` | MIT | LICENSE | 已验证兼容 |
| `ipaddr.js@1.9.1` | MIT | LICENSE | 已验证兼容 |
| `is-promise@4.0.0` | MIT | LICENSE | 已验证兼容 |
| `isexe@2.0.0` | ISC | LICENSE | 已验证兼容 |
| `jose@6.2.12` | MIT | LICENSE.md | 已验证兼容 |
| `json-schema-traverse@1.0.0` | MIT | LICENSE | 已验证兼容 |
| `json-schema-typed@8.0.2` | BSD-2-Clause | LICENSE.md | 已验证兼容 |
| `marked@18.0.11` | MIT | LICENSE | 已验证兼容 |
| `math-intrinsics@1.1.0` | MIT | LICENSE | 已验证兼容 |
| `media-typer@1.1.1` | MIT | LICENSE | 已验证兼容 |
| `merge-descriptors@2.0.0` | MIT | license | 已验证兼容 |
| `mime-db@1.54.0` | MIT | LICENSE | 已验证兼容 |
| `mime-types@3.0.2` | MIT | LICENSE | 已验证兼容 |
| `ms@2.1.3` | MIT | license.md | 已验证兼容 |
| `negotiator@1.1.0` | MIT | LICENSE | 已验证兼容 |
| `object-assign@4.1.1` | MIT | license | 已验证兼容 |
| `object-inspect@1.13.4` | MIT | LICENSE | 已验证兼容 |
| `on-finished@2.4.1` | MIT | LICENSE | 已验证兼容 |
| `once@1.4.0` | ISC | LICENSE | 已验证兼容 |
| `parseurl@1.3.3` | MIT | LICENSE | 已验证兼容 |
| `path-key@3.1.1` | MIT | license | 已验证兼容 |
| `path-to-regexp@8.4.2` | MIT | LICENSE | 已验证兼容 |
| `pkce-challenge@5.0.1` | MIT | LICENSE | 已验证兼容 |
| `proxy-addr@2.0.8` | MIT | LICENSE | 已验证兼容 |
| `qs@6.16.0` | BSD-3-Clause | LICENSE.md | 已验证兼容 |
| `range-parser@1.3.0` | MIT | LICENSE | 已验证兼容 |
| `raw-body@3.0.2` | MIT | LICENSE | 已验证兼容 |
| `require-from-string@2.0.2` | MIT | license | 已验证兼容 |
| `router@2.2.0` | MIT | LICENSE | 已验证兼容 |
| `safer-buffer@2.1.2` | MIT | LICENSE | 已验证兼容 |
| `send@1.2.1` | MIT | LICENSE | 已验证兼容 |
| `serve-static@2.2.1` | MIT | LICENSE | 已验证兼容 |
| `setprototypeof@1.2.0` | ISC | LICENSE | 已验证兼容 |
| `shebang-command@2.0.0` | MIT | license | 已验证兼容 |
| `shebang-regex@3.0.0` | MIT | license | 已验证兼容 |
| `side-channel@1.1.1` | MIT | LICENSE | 已验证兼容 |
| `side-channel-list@1.0.1` | MIT | LICENSE | 已验证兼容 |
| `side-channel-map@1.0.1` | MIT | LICENSE | 已验证兼容 |
| `side-channel-weakmap@1.0.2` | MIT | LICENSE | 已验证兼容 |
| `statuses@2.0.2` | MIT | LICENSE | 已验证兼容 |
| `toidentifier@1.0.1` | MIT | LICENSE | 已验证兼容 |
| `type-is@2.1.0` | MIT | LICENSE | 已验证兼容 |
| `unpipe@1.0.0` | MIT | LICENSE | 已验证兼容 |
| `vary@1.1.2` | MIT | LICENSE | 已验证兼容 |
| `which@2.0.2` | ISC | LICENSE | 已验证兼容 |
| `wrappy@1.0.2` | ISC | LICENSE | 已验证兼容 |
| `zod@4.6.5` | MIT | LICENSE | 已验证兼容 |
| `zod-to-json-schema@3.25.2` | ISC | LICENSE | 已验证兼容 |

## Artifact and remaining release gates

The new tarball contains 87 files (69 dist JS), including CE LICENSE, compiled runtime, Pi entry and consumer docs. All archive files were compared byte-for-byte to CE's build/source tree; no bundled third-party code/assets were found. The exact inventory and SHA-256 are recorded in the handoff report, not embedded in the artifact itself. The earlier non-bundling finding is not a licensing violation.

The queued `.changeset/ce-e2b-ack-mcp.md` and hardcoded `0.2.0.md` literals are deferred to a future version PR and remain untouched. Support certification stays Pi 1.3.0 / Node 24.21.0 / macOS arm64 (24.22.1 historical only). Cloud transport was verified in prior E2E evidence, not repeated or certified for this new artifact; existing draft cloud NOT_VERIFIED labels remain conservative artifact-specific gates. License-evidence closure is complete as of this delta; independent review of this delta and every explicit release/publish authorization (push, tag, npm publish, GitHub Release, merge to main) remain required.
