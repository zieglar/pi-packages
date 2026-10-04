# Alpha 1 durable resume safety

Phase 1B.2 persists only authoritative task state, checkpoint summaries, safe route/account representations, workspace metadata and digests, suspension policy, recovery counters, and fenced lease metadata. It never persists credentials, provider bodies, prompts, transcripts, hidden reasoning, or workspace file contents.

`FilesystemDurableTaskStore` uses path containment and symlink defenses, atomic replacement with a bounded prior-state backup, restrictive permissions, and fail-closed corruption/version handling. Workspace capture is inspection-only (`git rev-parse`, `git status`, and `git ls-files`); it does not reset, stash, rebase, checkout, restore, or overwrite a worktree.

## Crash-safety matrix

| Crash point | Restart behavior | Duplicate risk | Result |
|---|---|---|---|
| checkpoint before `suspended` | Authoritative state is loaded or corruption fails closed | bounded | Tested by durable-store atomic/corruption tests |
| lease acquired | Expired claim is reclaimed at higher generation; stale holder is fenced | fenced | Tested in memory, filesystem, and child-process lease tests |
| `resuming` before drift | Restore to `suspended`, then deterministic re-entry under lease | fenced | Tested by pre-launch resuming restart regression |
| drift before launch intent | Recapture and classify again; `CONFLICTING_DRIFT` blocks before intent | fenced | Tested by disposable-Git Process A → B integration |
| launch intent before launch | `launching` is blocked as ambiguous | no blind replay | Tested by launching-intent restart regression |
| launch before durable acknowledgement | Outcome is residual ambiguity; task blocks and is never silently replayed | must not silently duplicate | Explicit limitation and launcher-failure test coverage |
| completion before lease release | Durable `running`/`launched` state wins; later startup ignores it | fenced | Tested by Process A → B restart and fenced sequential writes |

Wayforge provides **at-most-once replay protection after the durable launch intent**, not exactly-once external continuation delivery. A process crash after an external launch but before durable acknowledgement is intentionally fail-closed.

## Isolated dogfood

The Alpha 1 process integrations use temporary filesystem roots and disposable Git repositories only. They make no provider traffic and do not read or mutate production `~/.pi`. The positive flow persists a typed synthetic suspension in Process A and resumes once in Process B. The negative flow records Process A's real workspace checkpoint, preserves an external task-owned-file modification, then proves Process B blocks on conflicting drift with no continuation marker.
