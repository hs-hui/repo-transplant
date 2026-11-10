# Changelog

## 1.0.4

- Added full compatibility and installation documentation for Codex, OpenCode, Cursor, Windsurf, and any standard MCP-compliant coding agent.
- Added autonomous / auto-approve mode: pass `auto_approve: true` in `transplant_record_plan` or `transplant_create_workspace`, or set environment variable `RT_AUTO_APPROVE=1`, to proceed directly to workspace creation and implementation without pausing for manual approval dialogs when the user asks to continue (e.g. "계속 진행해").
- `transplant_approve` now accepts `auto_approve: true` or affirmative user confirmation strings to proceed seamlessly without requiring a modal dialog.
- Defaulted `allowAttested` to true on non-dialog MCP clients so overrides and high findings do not block agents that lack custom dialog elicitation.

## 1.0.3

Found by feeding real go, cargo, dotnet, Python and Node runner output to the checks.

- A test command that runs `go test` needs `-v`. Plain `go test` prints the same line for a package whose tests were all skipped and one that passed. `repo_profile` suggests `go test -v ./...`.
- A `dotnet test` run where every test was skipped, there were no tests, or the filter matched nothing no longer passes. The summary is read in any language, and commands run with `DOTNET_CLI_UI_LANGUAGE=en`.
- Cargo and VSTest failures are named, so a failure the base already has can be told from a new one. Cargo names carry the rerun hint of their target, which tells the crates of a workspace apart.
- The prompt hook recognizes `owner/repo 에 있는`, and reads `src/app.ts의` as a path, not a repository.

## 1.0.2

- The gates no longer depend on the trace alone. The whole-repository scan is kept for the session, and a flagged file the plan leaves out needs `out_of_scope_reason`, shown at approval and in the report.
- Files a plan cites are matched to the repository listing and rescanned. A spelling such as `./src/a.js` cannot skip the gate, and a citation the scan cannot read is refused.
- A selected or cited file is read in full whatever its size. UTF-16 is decoded, and binary data under a text extension blocks approval.
- Files the feature imports stay gated even when they are shared across the repository.
- Copying from a left-out file is a high finding, counted across all changed files. A license header that conflicts with the source or target is too.
- TOML manifests and `composer.json` are compared after parsing, and a manifest that does not parse is a high finding.
- A package that keeps its version but gains a git, path or registry source is a high finding, and so is a change to `[patch]`, `replace` and similar keys in a planned manifest.
- Files that steer a build, such as `.cargo/config.toml`, `build.rs`, `go.work` and `Directory.Build.props`, need `sensitive_paths_reason`.
- More dependency spellings are read: pyproject optional dependencies and groups, Poetry groups, Pipfile dev packages, Cargo workspace and target tables, Gradle named arguments, Gemfile hash rockets, and every remote form of an npm specifier.
- The scan and the snapshot share one 500,000-file limit, and a file the scan was asked for but could not list is reported.
- The whole-repository license check covers tests and stylesheets too, with no limit on the number of files.
- Tracing follows Android module layouts, nested Go modules, Java and Kotlin wildcard and static imports, Rust `use` groups and `super` chains, and Python one-line, semicolon and backslash imports.
- A run where no test ran, or every test was skipped, no longer passes. That covers Go's `[no tests to run]` and all-skipped vitest, Jest, pytest, node:test, unittest and cargo runs, and `go test -v`. Plain `go test` prints nothing to tell a skip from a pass.
- A skipped test is not evidence. A manual criterion can only be left open for a person, a visual one needs `screenshot_path` naming a real image, and the approval summary and report show how each criterion is checked.
- Go failures carry their package, so a new failure cannot pass as an old one with the same name.
- npm, pnpm, yarn and bun installs need `--ignore-scripts` or `install_scripts_reason`.
- Commands cannot set forbidden variables in their text, and `env` keys must be plain names. Database hosts are found in driver URLs, `-hHOST` and keyword strings.
- Cancelling a run stops waiting for services, and a shutdown stops running commands and containers, including when a client closes stdin.
- The scanner reads past invisible characters and whitespace padding, recognizes `iwr | iex`, `irm`, interpreters that run what is piped to them and every short form of PowerShell's encoded flag, and keeps hidden characters in bundled paths at high. File reads show every invisible character except those emoji and Persian need.
- Destructive SQL and open CORS split across lines are caught. So are added tests that do not run and dependencies removed without saying so.
- An unreadable LICENSE no longer lets a manifest decide, and a dual license needs the text of the branch it picks. `license_check` refuses paths outside the repository.
- Commits keep bytes that are not UTF-8. A commit whose save failed is claimed on retry, a failed run recorded after the report stops the commit, and a report stops if files change while it is written.
- `gc.recentObjectsHook` counts as a change to git settings, a link replaced by a plain file counts as a change, and git no longer reads a config from a shared temp path.
- Reports and notices refuse to write through links, and `visual_compare` writes only over PNG files.
- An instant dialog answer is no longer taken for a person's, a client with no form dialog falls back to the user's words, and an unanswered dialog no longer counts as a refusal.
- `repo_read_file` stays within `RT_MAX_OUTPUT_CHARS` and says where to continue. Two servers can no longer overwrite each other's session.
- Downloads and `repo_clone_target` follow the size limit, a failed clone leaves nothing behind, and refs with slashes keep their subdirectory.
- The scanner treats binary files, UTF-32 and random bytes behind a byte order mark as unreadable, and blocks them when selected. A lone carriage return in a change is a high finding.
- Lockfile hosts are read as URLs, requirements in `requirements/` and constraints files are audited, and Maven, Gradle, NuGet and pyproject dependencies are read in more forms.
- Redirects in a manifest count whether or not the plan lists it.
- License detection reads every license in a file, recognizes `MIT-LICENSE.txt`-style names and `LICENSES/`, and finds SPDX tags in any comment.
- Tracing links same-package files in Java, Kotlin and Go and Rust `tests/` and `examples/` modules, and skips Python docstrings and Rust `super` inside inline modules.
- `suggested_docker_commands` gives Linux commands for a container, and `npx` can no longer fetch `tsc`. Pre-1.0 Cargo and Go versions compare correctly, Rust crate names match across `-` and `_`, Spring routes include the class prefix, and the prompt hook recognizes `owner/repo`.

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
