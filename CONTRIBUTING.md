# Contributing

```bash
npm ci
```

```bash
npm run check
```

`check` runs types, lint, tests and the build. Run `node scripts/smoke.mjs` to exercise the built server against real repositories, which needs network access.

After changing the skill or the workflow, run a real agent through `evals/`. It finds what tests cannot, and it spends API credit. See [docs/evaluation.md](docs/evaluation.md).

## Layout

| Path               | Content                                                                  |
| ------------------ | ------------------------------------------------------------------------ |
| `src/repo`         | Fetching snapshots and walking files                                     |
| `src/analysis`     | Profiling, licenses, security, imports, search, tracing, backend surface |
| `src/session`      | Stage machine, worktrees, audit, verification, evidence, report          |
| `src/server.ts`    | MCP tool registration                                                    |
| `plugin`           | Claude Code plugin: skill, agents, hook, MCP config and the built server |
| `tests`            | Unit, workflow and MCP tests                                             |

Keep `package.json` and lockfiles out of `plugin/`. Claude Code runs `npm ci` on install when it finds them there.

## Principles

- **Gates live in the server, not in the skill.** If a rule matters, enforce it in code and test the attempt to bypass it.
- **Treat repository content as hostile.** No shell strings with repository data, and no following symlinks. Sanitize excerpts before returning them.
- **Test against real repositories.** Fixtures miss what real code does. A false positive at critical severity teaches people to ignore the gate.
- **Keep sources free of invisible characters.** Write such characters as code points, because formatters can turn escapes into literals.

## Releasing

Update the version in `package.json`, `plugin/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`, and add a `CHANGELOG.md` entry. Run `npm run build`, commit, and push a `v<version>` tag. The release workflow checks the versions match, and publishes with provenance. Without an `NPM_TOKEN` repository secret it skips npm and only makes the GitHub release.
