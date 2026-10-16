# Baseline comparison (simulated, standard)

Provider `simulated` · model `simulated` · scale `standard` · seed 1 · window 4000 tokens · 2026-10-15

> Simulated model: a deterministic reader that answers only from facts visible in its prompt, with a hard 16000-token context limit. Scores measure what each context strategy delivers to the model, not language-model quality. Wall-clock times are for the harness only.

## Overall

| Strategy        | Accuracy | Task success | Stale answers | Tokens / task | Model calls / task | Cost / task | Wall-clock / task | Errors | Recall@k | Retrieval precision |
| --------------- | -------: | -----------: | ------------: | ------------: | -----------------: | ----------: | ----------------: | -----: | -------: | ------------------: |
| full-transcript |      23% |           0% |            0% |       176,411 |               31.3 |     $0.0000 |            7.2 ms |     80 |        – |                   – |
| sliding-window  |       0% |           0% |            0% |       123,265 |               31.5 |     $0.0000 |            4.5 ms |      5 |        – |                   – |
| summary-buffer  |      46% |           0% |            0% |       113,982 |               31.5 |     $0.0000 |            4.6 ms |      5 |        – |                   – |
| vector-rag      |      92% |          75% |            0% |       119,980 |               31.5 |     $0.0000 |           16.3 ms |      5 |     100% |                 31% |

## Accuracy by suite

| Strategy        | long-horizon | recall | update | interference |
| --------------- | -----------: | -----: | -----: | -----------: |
| full-transcript |           0% |     0% |     0% |          50% |
| sliding-window  |           0% |     0% |     0% |           0% |
| summary-buffer  |           0% |    50% |    50% |          50% |
| vector-rag      |           0% |   100% |   100% |         100% |

## Tokens per task by suite

| Strategy        | long-horizon |  recall |  update | interference |
| --------------- | -----------: | ------: | ------: | -----------: |
| full-transcript |       98,015 | 218,641 | 216,599 |      172,387 |
| sliding-window  |      107,911 | 139,085 | 132,723 |      113,340 |
| summary-buffer  |      107,911 | 121,547 | 116,410 |      110,059 |
| vector-rag      |      110,285 | 133,548 | 126,841 |      109,245 |

## Same session vs. a new session

| Strategy        | Probes in the same session | Probes in a later session |
| --------------- | -------------------------: | ------------------------: |
| full-transcript |                        43% |                        0% |
| sliding-window  |                         0% |                        0% |
| summary-buffer  |                        86% |                        0% |
| vector-rag      |                        86% |                      100% |

## Errors

- **full-transcript**: 80 failed requests in 15 tasks, e.g. long-horizon-1 s1: prompt is 16157 tokens, over the 16000-token context window
- **sliding-window**: 5 failed requests in 5 tasks, e.g. long-horizon-1 s1: prompt is 16793 tokens, over the 16000-token context window
- **summary-buffer**: 5 failed requests in 5 tasks, e.g. long-horizon-1 s1: prompt is 16793 tokens, over the 16000-token context window
- **vector-rag**: 5 failed requests in 5 tasks, e.g. long-horizon-1 s1: prompt is 17066 tokens, over the 16000-token context window
