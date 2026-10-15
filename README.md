# neuro-agent

An open-source agent harness, written from scratch in TypeScript, whose **memory works like a human brain**: a tiny attention-gated working memory, fast episodic and slow semantic long-term stores, sleep-like consolidation, cue-driven recall that edits what it touches, and forgetting as a feature.

> **Status:** early development. The baseline agent (Phase 1) and the evaluation harness (Phase 2) are in place; working memory and attention (Phase 3) are next. See the [roadmap](ROADMAP.md) and the [current baseline numbers](docs/evals).

## Why

Most agents treat memory as "a bigger context window" or "a vector database". Human memory is a set of cooperating systems with different speeds and failure modes — and a lot of the intelligence is in how they hand information to each other. Read the research behind the design in [docs/NEUROSCIENCE.md](docs/NEUROSCIENCE.md).

## Try the baseline agent

```sh
pnpm install && pnpm build
export ANTHROPIC_API_KEY=...            # or use --provider openai / ollama
node packages/cli/dist/bin.js           # interactive session in the current directory
node packages/cli/dist/bin.js "summarize README.md"    # one request, then exit
node packages/cli/dist/bin.js trace .neuro/traces/<file>.jsonl   # tokens, cost, tool calls
```

The agent can read, list and search files in its workspace freely; it asks before writing files or running shell commands (`--yes` skips the prompt, `--read-only` removes those tools). Every session is recorded as a JSONL trace under `.neuro/traces/`. Run `neuro --help` for all options, including `--provider openai --base-url ... --model ...` for any OpenAI-compatible server and `--provider ollama` for local models.

## Measure it

```sh
pnpm eval    # runs every benchmark suite against every baseline; report in docs/evals/
```

See [docs/evals](docs/evals/README.md) for what the suites test and how to run them against a live model.

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
