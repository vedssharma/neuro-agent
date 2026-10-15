# neuro-agent

An open-source agent harness, written from scratch in TypeScript, whose **memory works like a human brain**: a tiny attention-gated working memory, fast episodic and slow semantic long-term stores, sleep-like consolidation, cue-driven recall that edits what it touches, and forgetting as a feature.

> **Status:** early development — Phase 0 (foundations) is complete; the agent loop is next. See the [roadmap](ROADMAP.md).

## Why

Most agents treat memory as "a bigger context window" or "a vector database". Human memory is a set of cooperating systems with different speeds and failure modes — and a lot of the intelligence is in how they hand information to each other. Read the research behind the design in [docs/NEUROSCIENCE.md](docs/NEUROSCIENCE.md).

## Development

Requires Node >= 20 and pnpm 10.

```sh
pnpm install
pnpm check            # lint, format check, build, tests
node packages/cli/dist/bin.js --version
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Architecture decisions live in [docs/adr](docs/adr).

## License

MIT
