# Neuroscience Research Notes

This document summarizes the neuroscience that motivates neuro-agent's design, and maps each finding to a concrete mechanism in the harness. It is a _design inspiration_, not a claim that we are simulating a brain. Where the science is contested we say so; where we are making an engineering analogy we say that too.

> **Sourcing note.** Findings below were gathered from web searches of the primary literature and reviews (linked in [References](#references)), supplemented by well-established textbook results. Several search results were secondary summaries; before citing specifics in papers or docs, verify against the primary source.

---

## 1. The big picture: memory is a set of cooperating systems

The brain does not have "a memory". It has several systems with different speeds, capacities, and failure modes, and much of the intelligence lives in how they hand information to each other.

| Human system      | What it does                                            | Timescale        | Capacity               |
| ----------------- | ------------------------------------------------------- | ---------------- | ---------------------- |
| Sensory memory    | Raw, high-fidelity buffer of incoming input             | ~0.25–4 s        | Large, decays fast     |
| Working memory    | Actively held, manipulated information; the "workbench" | seconds–minutes  | Very small (~4 chunks) |
| Episodic memory   | Specific events, bound to time/place/context            | minutes–lifetime | Large                  |
| Semantic memory   | Facts, concepts, schemas, abstracted from episodes      | lifetime         | Very large             |
| Procedural memory | Skills and habits, expressed through performance        | lifetime         | Large                  |

## 2. Working memory: small, attention-gated, and chunked

- **Capacity is tiny.** Cowan's model separates a large _activated portion of long-term memory_ from a small **focus of attention** holding ~**4 chunks**. Classic "7±2" spans are inflated by chunking and rehearsal; the true core limit is lower. Oberauer refines this with a nested single-item focus used to select the one chunk currently being processed.
- **Baddeley's model** adds a central executive, phonological loop, visuospatial sketchpad, and (from 2000) the **episodic buffer** — a limited-capacity store that integrates information from several sources and _links working memory to long-term memory_.
- **Chunking** is how experts beat the limit: a chess master holds one "pattern", a novice holds many pieces.

**Design implications:** the LLM context window is our working memory. Like the brain's, it should be treated as a _scarce, curated_ resource, not a dumping ground. A "focus" region (current goal + a few active chunks) should sit inside a larger "activated" region (recently retrieved long-term items). Information should be stored as _chunks_ (summaries/schemas), not raw transcripts.

## 3. Complementary Learning Systems (CLS): why there are two long-term stores

McClelland, McNaughton & O'Reilly's Complementary Learning Systems theory (updated by Kumaran, Hassabis & McClelland, 2016) is the most important idea for this project:

- The **hippocampus** learns _fast_ using **sparse, pattern-separated** representations → good for storing individual episodes without overwriting each other.
- The **neocortex** learns _slowly_ using **distributed, overlapping** representations → good for extracting statistical structure (semantics, schemas) across many episodes.
- Hippocampal memories are **replayed** to the neocortex over time (largely during sleep and rest), gradually integrating them. Doing this slowly and interleaved with old knowledge avoids **catastrophic interference** — the same problem fine-tuning an LLM on new data causes.

**Design implications:** two long-term stores with different write policies — a fast, append-mostly **episodic store** and a slow, consolidated **semantic store** — plus an offline **consolidation process** that replays episodes into the semantic store, interleaved with existing knowledge.

## 4. The hippocampus: indexing, pattern separation, pattern completion

- **Pattern separation** (dentate gyrus): similar inputs are mapped to _distinct_ sparse codes, so similar experiences ("where I parked today" vs. "yesterday") don't blur together.
- **Pattern completion** (CA3, a recurrent auto-associative network): a _partial cue_ reactivates the full stored ensemble. This is why a smell can bring back an entire scene.
- **Indexing theory** (Teyler & DiScenna): the hippocampus stores a compact _index_ that points to distributed cortical patterns rather than the content itself.
- _Caveat:_ the neat DG = separation / CA3 = completion split is a textbook simplification; recordings (e.g. Knierim & Neunuebel, 2016) suggest CA3 can do either depending on input and attractor strength.

**Design implications:** retrieval should be **cue-based and associative**, tolerant of partial/noisy cues (embeddings + graph links), while _writes_ should deliberately keep near-duplicate episodes distinguishable (store distinguishing context, don't merge on similarity alone). Episodes act as **indices** pointing at richer artifacts (files, transcripts, tool outputs).

## 5. Consolidation: sleep, replay, and "what to keep"

- During non-REM sleep and quiet rest, hippocampal **sharp-wave ripples** replay recent experience, coordinated with cortical spindles; disrupting ripples impairs later memory. A 2025 _Nature_ study found recent and older memories are replayed in _different sleep sub-states_, apparently to **limit interference** between new and old traces.
- Whether replay _drives_ memory transformation or merely reflects prior encoding is still debated.
- Consolidation is **selective**: salient, rewarded, emotional, or schema-relevant events are preferentially kept. **Schema-consistent** information integrates faster into cortex.
- Consolidation also **transforms**: episodic detail is gradually abstracted ("gist"); some details are lost, structure is gained.

**Design implications:** a background **"sleep" process** (idle time, session end, or budget threshold) that replays recent episodes, scores them for salience, extracts facts/schemas into semantic memory, compresses or drops the rest, and interleaves old memories to prevent drift. Make old/new replay explicit and separate.

## 6. Reconsolidation: retrieval makes memory editable

Nader, Schafe & LeDoux (2000) showed that retrieving a consolidated memory returns it to a **labile** state requiring **restabilization**; interfering during that window (they used a protein-synthesis inhibitor) disrupts the memory, while waiting ~6 h does not. Later work (Lee, Nader & Schiller 2017; Kida 2020; Schwabe et al. 2014 for humans) shows:

- Destabilization has **boundary conditions** (retrieval duration, memory strength, memory age, and prediction error/novelty).
- The adaptive function is likely **updating**: incorporating new information into old memories.
- There are replication difficulties in human/clinical settings.

**Design implications:** retrieving a memory should _open a write window_. If the current situation contradicts or extends the retrieved memory (a prediction error), the memory is revised and re-stored — with versioning. This is how the agent corrects stale beliefs instead of accumulating contradictions.

## 7. Forgetting is a feature

- Ebbinghaus (1885; replicated by Murre & Dros, 2015): retention falls steeply, then flattens. Group-averaged power-law curves can arise from per-item exponential decay with varying strength.
- Forgetting is not just passive decay. Evidence supports **active, regulated forgetting** (e.g. dopamine-driven "forgetting cells" acting through Rac1/cofilin pathways) and **reduced engram accessibility** rather than erasure — which would explain why some forgotten memories can be recovered with the right cue (Ryan & Frankland, 2022).
- **Spacing and retrieval practice** strengthen memory far more than re-reading.

**Design implications:** every memory has a **strength** that decays with time and is boosted by retrieval (spaced-repetition-like). Low-strength items become _inaccessible_ (archived, not deleted) so they can be revived by a strong cue. Forgetting keeps retrieval fast and relevant.

## 8. Attention, salience, emotion, and prediction

- **Predictive processing / free-energy** views treat the brain as a prediction machine; **prediction error** weighted by **precision** is what gets attention and drives learning. Surprise is the signal to update. (Critics, e.g. Ransom et al. 2020, argue affective salience can capture attention even where precision is low, so prediction error alone is insufficient — emotion/value is a separate axis.)
- The **amygdala** and neuromodulators (dopamine, noradrenaline) tag events as important, boosting consolidation of emotional or rewarding experiences. (Our search found little primary material on this link; it is textbook-level and should be verified before citation.)

**Design implications:** a **salience/"amygdala" scorer** at encoding time combining surprise (prediction error vs. expectation), task relevance, outcome value (success/failure, user correction/feedback), and explicit user emphasis. Salience gates what gets written and how strongly.

## 9. Procedural memory and habits

The basal ganglia and cerebellum support skills and habits: slow to acquire, fast and low-effort to execute, largely outside conscious working memory. (Our search returned little primary material here; this is textbook knowledge.)

**Design implications:** a **procedural store** of learned workflows/skills. Repeated successful action sequences are _compiled_ into reusable routines (macros/tools/prompts) that run with minimal context cost — moving from deliberate (System 2) to habitual (System 1) execution.

## 10. Executive control, the default mode network, and global workspace

- The **prefrontal / frontoparietal control network** selects goals, gates what enters working memory, and manages other networks.
- The **default mode network** is active during rest, introspection, planning, and memory-based simulation, and is anticorrelated with externally focused control networks — though it also contributes in some demanding task switches.
- **Global workspace theory** (Baars, Dehaene) proposes a limited-capacity "broadcast" stage where specialized modules compete for access and winners are shared system-wide.

**Design implications:** an **executive** that sets goals and gates context admission; a **workspace** where specialist modules (retrieval, planning, tool use) compete and the winner is broadcast into context; and an idle-time **default-mode loop** for reflection, consolidation, and simulation of future scenarios.

---

## Mapping summary

| Brain concept                        | neuro-agent mechanism                                           |
| ------------------------------------ | --------------------------------------------------------------- |
| Sensory buffer                       | Raw event/tool-output buffer with fast decay                    |
| Working memory / focus of attention  | Managed context window with a small "focus" region              |
| Chunking                             | Summaries, schemas, and compiled references instead of raw text |
| Hippocampus (fast, sparse)           | Episodic store with pattern-separated writes                    |
| Neocortex (slow, distributed)        | Semantic store: facts, concepts, knowledge graph                |
| Pattern completion                   | Cue-based associative retrieval from partial cues               |
| Sleep replay                         | Background consolidation job                                    |
| Reconsolidation                      | Retrieval opens a versioned, editable window                    |
| Forgetting curve / active forgetting | Strength decay + archival, revivable by strong cue              |
| Amygdala / neuromodulators           | Salience scorer gating encoding                                 |
| Prediction error                     | Surprise signal driving attention and updates                   |
| Basal ganglia habits                 | Procedural store / compiled skills                              |
| Prefrontal executive                 | Goal manager + context-admission gate                           |
| Global workspace                     | Competitive broadcast of module outputs into context            |
| Default mode network                 | Idle-time reflection and simulation loop                        |

## References

- O'Reilly, Bhattacharyya, Howard & Ketz (2011), _Complementary Learning Systems_, Cognitive Science — see [overview](https://api.philpapers.org/rec/ORECLS).
- Kumaran, Hassabis & McClelland (2016), _What Learning Systems do Intelligent Agents Need? Complementary Learning Systems Theory Updated_ — [PDF](https://web.stanford.edu/~jlmcc/papers/KumaranHassabisMcClelland16FinalMS.pdf).
- Cowan (2001), _The magical number 4 in short-term memory_; Baddeley (2000), _The episodic buffer_; Oberauer's embedded-processes model — see [Working memory (Wikipedia)](https://en.wikipedia.org/wiki/Working_memory) for an overview.
- Knierim & Neunuebel (2016), _Tracking the flow of hippocampal computation: Pattern separation, pattern completion, and attractor dynamics_ — [PDF](https://sites.krieger.jhu.edu/knierim-lab/files/2019/04/KnierimNeunuebel2015.pdf); Rolls (2015) — [PDF](https://www.oxcns.org/papers/550%20Rolls%202015%20Pattern%20separation,%20completion,%20and%20categorisation%20in%20the%20hippocampus%20and%20neocortex.pdf).
- Carr, Jadhav & Frank (2011), _Hippocampal replay in the awake state_ — [PDF](https://cenl.ucsd.edu/Jclub/Carr%282011%29_NarureReview_Hippo_Consolidation.pdf); sleep-microstructure replay, _Nature_ 2025 — [summary](https://ideas.repec.org/a/nat/nature/v637y2025i8048d10.1038_s41586-024-08340-w.html).
- Lee, Nader & Schiller (2017), _An update on memory reconsolidation updating_, TICS — [record](https://research.birmingham.ac.uk/en/publications/an-update-on-memory-reconsolidation-updating); Kida (2020), Proc. Japan Acad. B — [article](https://www.jstage.jst.go.jp/article/pjab/96/3/96_PJA9603B-02/_html/-char/en); Schwabe, Nader & Pruessner (2014) — [PDF](https://www.psy.uni-hamburg.de/arbeitsbereiche/kognitionspsychologie/publikationen/schwabe2014-biolpsychiatry.pdf).
- Ryan & Frankland (2022), _Forgetting as a form of adaptive engram cell plasticity_ — [PMC9302596](https://pmc.ncbi.nlm.nih.gov/articles/PMC9302596); active-forgetting review — [PMC5657245](https://pmc.ncbi.nlm.nih.gov/articles/PMC5657245).
- Ransom et al. (2020), _Affect-biased attention and predictive processing_, Cognition — [PDF](https://mclab.psych.ubc.ca/wp-content/uploads/2020/06/Ransom_etal_ABA__PredictiveCoding_Cognition2020.pdf).
- Default mode / control networks — [PMC9290753](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9290753/), [eLife 06481](https://elifesciences.org/articles/06481v1).
- Sumers, Yao, Narasimhan & Griffiths, _Cognitive Architectures for Language Agents (CoALA)_ — [arXiv 2309.02427](https://arxiv.org/pdf/2309.02427). Also relevant prior art (not directly verified in our searches): MemGPT, Generative Agents (Park et al., 2023).
