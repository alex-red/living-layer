# Contributing

Thanks for taking a look. Issues and pull requests are both welcome. For anything bigger than a small fix, open an issue first so we can agree on the approach.

## Setup

```sh
bun install
bun run dev
```

You don't need any API keys. Demo mode covers the whole workflow offline.

## Before you open a PR

```sh
bun run check
bun run test:browser   # if you touched the UI
```

`check` runs Prettier, `tsc`, `bun test`, and the web build. CI runs the same commands. The browser tests run Playwright on Node 24 (see `.nvmrc`).

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
bun run bench:scene           # how well a scene is laid out from synthetic photos
bun run bench:fit             # how well item models fit their crops
bun run bench:at main scene   # the scene bench on main, then your tree against it
bun run verify                # all of the above that matters, plus format, types and tests, in one summary
```

Each bench shows how much room every case has left before its target. `--set desk.topCm=3,4,5` tries other furniture measurements without editing code. If you change how something looks on purpose, update its golden picture with `UPDATE_GOLDEN=1 bun test tests/model.test.ts tests/furniture.test.ts`, and check the new PNGs before committing them. [AGENTS.md](AGENTS.md) has more on when to run which.

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
