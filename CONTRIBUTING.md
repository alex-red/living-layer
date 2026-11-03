# Contributing

Thanks for taking a look. Issues and pull requests are both welcome. For anything bigger than a small fix, open an issue first so we can agree on the approach.

## Setup

```sh
bun install
bun run dev
```

You don't need any API keys. Demo mode covers the whole workflow offline.

Nothing reloads by itself while you edit: once code changes, the page shows `Reload now`, which restarts the API server if its code changed and reloads the page.

## Before you open a PR

```sh
bun run ci
bun run test:browser   # if you touched the UI
```

`ci` runs oxfmt, `tsrs` (TypeScript 7.1), `bun test`, and the web build. CI runs the same commands. The browser tests run Playwright on Node 24 (see `.nvmrc`).

A few conventions:

- Tests should never reach the network. Pass a mock `fetcher` into `buildApp`, as `tests/core.test.ts` does.
- Bun is the runtime, package manager, and test runner. Commit `bun.lock`.
- Prefer Bun's built-ins (`bun:sqlite`, `Bun.file`, `bun test`) over adding a package.
- Dependencies are pinned to exact versions (`bunfig.toml` sets `exact`).
- Don't commit anything from `.data/`, real photos, or `.env`.

## Measuring changes

Some changes pass the tests and still make things worse. These scripts show it in seconds, with no server:

```sh
bun run sheet                 # every furniture template, all four turns, as out/prop-sheet.png
bun run bench:room            # how well a room is scanned through its calibrated corner camera
bun run bench:fit             # how well item models fit their crops
bun run bench:at main room    # the room bench on main, then your tree against it
bun run bench:rooms           # captured real rooms laid out again, against their accepted layouts (local only)
bun run draft <run> --relayout  # a stored room draft laid out again with your tree, over its frame
bun run calib --grid          # the room's calibration: fit, the room sizes its marks fit, a grid over a frame
bun run runs [<run>]          # the run log, or one run's steps and pictures in out/runs/
bun run verify                # all of the above that matters, plus format, types and tests, in one summary
bun run verify --at staged    # the same on HEAD and what is staged, in a clean worktree (--at <ref> for a commit)
bun run commit -m "fix: …" -- <files>  # verify those files on HEAD in a clean worktree, then commit just them
bun run commit --hunks <file> --match "…"  # the file's hunks changing a line with that text, as out/<file>.patch
bun run commit -m "fix: …" --patch <patch>  # the same as commit, for just those hunks
```

Each bench shows how much room every case has left before its target. `--set desk.topCm=3,4,5` tries other furniture measurements without editing code. If you change how something looks on purpose, update its golden picture with `UPDATE_GOLDEN=1 bun test tests/model.test.ts tests/furniture.test.ts`, and check the new PNGs before committing them. [AGENTS.md](AGENTS.md) has more on when to run which.

## Committing

Commit with `bun run commit -m "<summary>" [-m "<body>"] -- <files>`. The checkout may be shared with other sessions, so it names its files: it runs `verify` on HEAD with only those files as they are now, in a clean worktree, then commits just them and leaves anything else staged alone. The pre-commit hook refuses other commits. To commit by hand (concluding a merge with conflicts, say), check what is staged and use `COMMIT_ANY=1 git commit …`. `--skip-verify` is for changes verify can't judge, such as docs.

When someone else is editing a file you changed too, commit just your hunks of it. `bun run commit --hunks <file> --match "<text>"` writes the hunks that change a line containing the text (`--match` again for more) to `out/<file>.patch`; check it, then `bun run commit -m "<summary>" --patch out/<file>.patch [-- <files>]`. That verifies HEAD with the patch and any named files on it, then builds the commit in a temporary index, so the working tree and the real index keep everyone else's changes. It refuses a patch that no longer applies to HEAD, or HEAD moving while verify runs: make the patch again.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<optional scope>): <summary>

<optional body: why the change was made>
```

| Type       | Use it for                                      |
| ---------- | ----------------------------------------------- |
| `feat`     | Something a user can now do                     |
| `fix`      | A bug fix                                       |
| `docs`     | Documentation only                              |
| `refactor` | Code changes that don't change behaviour        |
| `test`     | Adding or fixing tests and test data            |
| `perf`     | Making something faster or lighter              |
| `ci`       | GitHub Actions and other CI config              |
| `chore`    | Tooling, dependencies, config, and housekeeping |

Scopes are optional. When one helps, use the part of the repo you touched: `web`, `server`, or `domain`.

Write the summary in lowercase and the imperative mood, with no full stop, and keep it under about 60 characters: `feat(web): add zone editor`, not `Added the zone editor.` Use the body to explain why, not what. For a breaking change, add `!` after the type (`feat(server)!: …`) and explain the break in the body.

Examples:

```
feat: remember a mug and gate the lamp on a drawn zone
fix(server): reject zones saved against a different image
docs: explain how to get a Home Assistant token
chore: bump vite to 7.2.0
```

## Reporting security issues

Please don't open a public issue for security problems. Use GitHub's private vulnerability reporting on this repository instead.
