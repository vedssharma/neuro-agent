# Context strategy comparison (simulated, standard)

Provider `simulated` · model `simulated` · scale `standard` · seed 1 · window 4000 tokens · 2026-10-26

> Simulated model: a deterministic reader that answers only from facts visible in its prompt, with a hard 16000-token context limit. Scores measure what each context strategy delivers to the model, not language-model quality. Wall-clock times are for the harness only.

## Overall

| Strategy          | Accuracy | Task success | Stale answers | Tokens / task | Model calls / task | Cost / task | Wall-clock / task | Errors | Recall@k | Retrieval precision |
| ----------------- | -------: | -----------: | ------------: | ------------: | -----------------: | ----------: | ----------------: | -----: | -------: | ------------------: |
| full-transcript   |      16% |           0% |            0% |       199,612 |               37.0 |     $0.0000 |            5.6 ms |     80 |        – |                   – |
| sliding-window    |       0% |           0% |            0% |       129,762 |               37.2 |     $0.0000 |            3.1 ms |      5 |        – |                   – |
| summary-buffer    |      32% |           0% |            0% |       118,627 |               37.2 |     $0.0000 |            4.2 ms |      5 |        – |                   – |
| vector-rag        |      91% |          80% |            0% |       131,220 |               37.2 |     $0.0000 |           19.3 ms |      5 |      96% |                 28% |
| working-memory    |     100% |         100% |            0% |       119,920 |               37.7 |     $0.0000 |            115 ms |      0 |     100% |                 45% |
| wm-no-chunking    |      95% |          83% |            0% |       130,000 |               37.2 |     $0.0000 |            107 ms |      5 |     100% |                 45% |
| wm-recency-gate   |      68% |          50% |            0% |       115,615 |               37.7 |     $0.0000 |            109 ms |      0 |      67% |                 24% |
| wm-no-activation  |      37% |          17% |            0% |       116,436 |               37.7 |     $0.0000 |           91.8 ms |      0 |      33% |                 14% |
| long-term-memory  |     100% |         100% |            0% |       119,769 |               37.7 |     $0.0000 |            133 ms |      0 |     100% |                 47% |
| ltm-vector-only   |     100% |         100% |            0% |       119,630 |               37.7 |     $0.0000 |            124 ms |      0 |     100% |                 55% |
| ltm-episodes-only |      86% |          83% |            0% |       119,862 |               37.7 |     $0.0000 |            137 ms |      0 |      86% |                 38% |

## Accuracy by suite

| Strategy          | long-horizon | recall | update | interference | multi-session | dense-interference |
| ----------------- | -----------: | -----: | -----: | -----------: | ------------: | -----------------: |
| full-transcript   |           0% |     0% |     0% |          50% |            0% |                 0% |
| sliding-window    |           0% |     0% |     0% |           0% |            0% |                 0% |
| summary-buffer    |           0% |    50% |    50% |          50% |            0% |                 0% |
| vector-rag        |           0% |   100% |   100% |         100% |          100% |                80% |
| working-memory    |         100% |   100% |   100% |         100% |          100% |               100% |
| wm-no-chunking    |           0% |   100% |   100% |         100% |          100% |               100% |
| wm-recency-gate   |         100% |    50% |    50% |          50% |          100% |               100% |
| wm-no-activation  |         100% |    50% |    50% |          50% |            0% |                 0% |
| long-term-memory  |         100% |   100% |   100% |         100% |          100% |               100% |
| ltm-vector-only   |         100% |   100% |   100% |         100% |          100% |               100% |
| ltm-episodes-only |         100% |   100% |   100% |         100% |          100% |                35% |

## Tokens per task by suite

| Strategy          | long-horizon |  recall |  update | interference | multi-session | dense-interference |
| ----------------- | -----------: | ------: | ------: | -----------: | ------------: | -----------------: |
| full-transcript   |       98,015 | 218,641 | 216,599 |      172,387 |       454,858 |             37,174 |
| sliding-window    |      107,911 | 139,085 | 132,723 |      113,340 |       248,339 |             37,174 |
| summary-buffer    |      107,911 | 121,547 | 116,410 |      110,059 |       218,660 |             37,174 |
| vector-rag        |      110,285 | 133,548 | 126,841 |      109,245 |       246,609 |             60,792 |
| working-memory    |       48,766 | 134,311 | 127,701 |      112,385 |       250,919 |             45,436 |
| wm-no-chunking    |      109,249 | 134,311 | 127,701 |      112,385 |       250,919 |             45,436 |
| wm-recency-gate   |       48,766 | 127,528 | 121,623 |      111,247 |       239,092 |             45,436 |
| wm-no-activation  |       48,766 | 133,571 | 127,025 |      111,524 |       238,278 |             39,452 |
| long-term-memory  |       48,766 | 134,343 | 127,649 |      112,169 |       250,710 |             44,978 |
| ltm-vector-only   |       48,766 | 134,310 | 127,649 |      112,177 |       251,006 |             43,870 |
| ltm-episodes-only |       48,766 | 134,347 | 127,633 |      112,334 |       251,078 |             45,015 |

## Same session vs. a new session

| Strategy          | Probes in the same session | Probes in a later session |
| ----------------- | -------------------------: | ------------------------: |
| full-transcript   |                        43% |                        0% |
| sliding-window    |                         0% |                        0% |
| summary-buffer    |                        86% |                        0% |
| vector-rag        |                        86% |                       93% |
| working-memory    |                       100% |                      100% |
| wm-no-chunking    |                        86% |                      100% |
| wm-recency-gate   |                        14% |                      100% |
| wm-no-activation  |                       100% |                        0% |
| long-term-memory  |                       100% |                      100% |
| ltm-vector-only   |                       100% |                      100% |
| ltm-episodes-only |                       100% |                       78% |

## Errors

- **full-transcript**: 80 failed requests in 15 tasks, e.g. long-horizon-1 s1: prompt is 16157 tokens, over the 16000-token context window
- **sliding-window**: 5 failed requests in 5 tasks, e.g. long-horizon-1 s1: prompt is 16793 tokens, over the 16000-token context window
- **summary-buffer**: 5 failed requests in 5 tasks, e.g. long-horizon-1 s1: prompt is 16793 tokens, over the 16000-token context window
- **vector-rag**: 5 failed requests in 5 tasks, e.g. long-horizon-1 s1: prompt is 17066 tokens, over the 16000-token context window
- **wm-no-chunking**: 5 failed requests in 5 tasks, e.g. long-horizon-1 s1: prompt is 16896 tokens, over the 16000-token context window
