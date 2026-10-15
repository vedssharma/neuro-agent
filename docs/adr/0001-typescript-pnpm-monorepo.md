# 0001. TypeScript (strict, ESM) in a pnpm monorepo

- Status: accepted
- Date: 2026-10-15

## Context

The harness is built from scratch in TypeScript and will have separable concerns (core loop, memory, providers, tools, evals, CLI) that contributors may want to depend on independently.

## Decision

- TypeScript with `strict` plus `noUncheckedIndexedAccess`, ESM only, Node >= 20.
- pnpm workspaces; one package per concern under `packages/`, built with `tsc -b` project references.
- Vitest runs against source via aliases; ESLint (flat config) and Prettier for style.

## Consequences

Fast tests without a build step; clear package boundaries; contributors need pnpm. Bundling (e.g. for the CLI) can be added later without changing package layout.
