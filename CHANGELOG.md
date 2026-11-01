# Changelog

## 1.0.1

- Approval works in the Claude desktop app. It declines every dialog without showing it, and the server took that for the user's answer. A decline that fast now falls back to the user's words, like a fast cancel.

## 1.0.0

First release.

- MCP server with 31 tools for fetching, analyzing and transplanting features across repositories.
- Claude Code plugin with the `transplant` skill and the `feature-scout` and `transplant-reviewer` agents.
- Backend support: routes, data models, migrations, secrets, jobs, realtime and external services.
- Server-enforced stages: license and security gates, spec, hash-bound plan approval, git worktree isolation, scope audit, verification and log-backed evidence.
- Upstream checks from provenance records, feasibility scoring and screenshot comparison.
- Reviews read files directly from disk, and checks run in a copy built from exactly those files.
- Verification can run databases and other services on a private Docker network.
- `transplant_baseline` separates failures that already exist from new ones.
- `repo_profile` suggests a container image and services for the project.
- Cancelling a tool call stops its commands, and long tools report progress.
- A plan that changes UI files needs a browser check or a stated reason.
- `transplant_commit` builds a commit from the exact bytes that were reviewed.
- A plan or spec can be replaced after work starts, with new approval and nothing carried over.
- A hook routes requests that name a repository to the skill.
- Evaluated with real Claude Code runs on real repositories. See `docs/evaluation.md`.
- The marketplace installs only `plugin/`, about 2 MB, with no `npm ci`.
- CI runs on Windows, macOS and Linux with Node 20, 22 and 24.
