# Documentation editing skills

These project skills are installed as text only. Pi discovers `.pi/skills/<name>/SKILL.md`; use `/reload` in an interactive session, then `/skill:humanizer` or `/skill:qu-ai-wei`. Reading the installed `SKILL.md` also applies its instructions within a documentation task.

| Skill | Upstream | Pinned revision | License | Installed files |
|---|---|---|---|---|
| humanizer | https://github.com/blader/humanizer | `0ef9fe5bc3572734fd3ae6c448fe00a30cd5dcf0` | MIT, copyright 2025 Siqi Chen | `SKILL.md`, `LICENSE` |
| qu-ai-wei | https://github.com/LifelongLazyLearner/qu-ai-wei | `1d32e803f091ec90808a69683ebf49e8a970a5e7` | MIT, copyright 2026 @LifelongLazyLearner | `SKILL.md`, `LICENSE`, `references/*.md` |

The upstream scripts, CI workflows, plugin manifests and assets are not installed. Humanizer's optional Python validator uses the Python standard library; its upstream CI also installs third-party CLIs. Qu-ai-wei's optional validation shell scripts use shell/Python tooling and include an `npx skills` discovery check; its blind-review preparation uses Python's standard library. None of these scripts was executed. Neither installed skill needs an executable or network dependency to edit prose.

For CE documentation, apply humanizer to the English draft and qu-ai-wei to the already translated Simplified Chinese draft as an embedded editorial step. Preserve code blocks, inline code, CLI commands, paths, configuration keys, versions, hashes, URLs, error codes, licenses and safety semantics exactly. Technical accuracy and evidence scope take priority over style. Do not invent experiences, examples or promotional claims. After editing, compare protected spans against the draft and review both languages for fact drift.

These skills affect only this project. Do not install them globally or copy them into a Public export as part of a documentation-only export. Updates require another source/license review and a new pinned revision.
