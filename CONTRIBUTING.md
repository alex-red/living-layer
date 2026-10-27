# Contributing

Thanks for taking a look. Issues and pull requests are both welcome. For anything bigger than a small fix, open an issue first so we can agree on the approach.

## Setup

```sh
nvm use        # Node 24, from .nvmrc
npm ci
npm run dev
```

You don't need any API keys. Fixture mode covers the whole workflow offline.

## Before you open a PR

```sh
npm run check
npm run test:browser   # if you touched the UI
```

`check` runs Prettier, `tsc`, the Vitest suite, and a production build. CI runs the same commands.

A few conventions:

- Tests should never reach the network. Pass a mock `fetcher` into `buildApp`, as `tests/core.test.ts` does.
- Dependencies are pinned to exact versions (`.npmrc` sets `save-exact`).
- Don't commit anything from `.data/`, real photos, or `.env`.

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
| `test`     | Adding or fixing tests and fixtures             |
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
