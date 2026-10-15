# Contributing to neuro-agent

Thanks for helping! Start with [ROADMAP.md](ROADMAP.md) and [docs/NEUROSCIENCE.md](docs/NEUROSCIENCE.md).

## Setup

Requires Node >= 20 and [pnpm](https://pnpm.io) 10.

```sh
pnpm install
pnpm check   # lint + format check + build + tests
```

Useful scripts: `pnpm build`, `pnpm test`, `pnpm test:watch`, `pnpm lint`, `pnpm format`.

## Layout

| Package                  | Purpose                              |
| ------------------------ | ------------------------------------ |
| `@neuro-agent/core`      | Types, events, agent loop primitives |
| `@neuro-agent/memory`    | Brain-inspired memory systems        |
| `@neuro-agent/providers` | LLM provider adapters                |
| `@neuro-agent/tools`     | Built-in tools                       |
| `@neuro-agent/eval`      | Evaluation harness                   |
| `@neuro-agent/cli`       | The `neuro` command                  |

Tests live in each package's `test/` and run against source (no build needed).

## Principles

- **Evidence over analogy.** A cognitive mechanism must beat a naive baseline in the eval suite, or it doesn't ship.
- Cite sources for neuroscience claims in `docs/NEUROSCIENCE.md`, and say when the science is contested.
- Significant design decisions get an ADR in [`docs/adr`](docs/adr).
- Keep changes small and focused; add tests; run `pnpm check` before pushing.

## Commits & PRs

Use clear, imperative commit messages. Fill in the PR template.
