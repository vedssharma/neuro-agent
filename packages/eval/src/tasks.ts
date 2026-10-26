/**
 * Synthetic, seeded benchmark tasks. Each task is a scripted conversation
 * (one or more sessions of user turns); some turns are probes with an
 * expected answer. Facts are phrased "the <key> is <value>" so they can be
 * graded by exact match, by a live model or by the simulated reader.
 */

export const SUITES = [
  "long-horizon",
  "recall",
  "update",
  "interference",
  "multi-session",
  "dense-interference",
] as const;
export type Suite = (typeof SUITES)[number];

export interface Probe {
  /** Graded correct when the reply contains this (case-insensitive). */
  answer: string;
  /** Superseded values; a reply containing one of these (and not the answer) is stale. */
  stale?: string[];
  /** Whether a recalled memory containing the answer counts as relevant (retrieval metrics). */
  retrievable: boolean;
}

export interface Turn {
  user: string;
  probe?: Probe;
}

export interface BenchmarkTask {
  id: string;
  suite: Suite;
  description: string;
  /** Each session starts a fresh agent; only long-term memory carries over. */
  sessions: Turn[][];
  /** Files placed in the task's workspace. */
  files?: Record<string, string>;
  /** Model calls allowed per request. */
  maxTurns?: number;
}

export interface Scale {
  tasksPerSuite: number;
  /** Filler turns between a fact and its probe. */
  fillerTurns: number;
  /** Approximate tokens per filler turn. */
  fillerTokens: number;
  files: number;
  fileTokens: number;
  lockers: number;
  /** Facts per message in the dense-interference suite. */
  denseFacts: number;
  /** Sessions (one building each) in the dense-interference suite. */
  denseSessions: number;
}

export const SCALES: Record<"small" | "standard", Scale> = {
  small: {
    tasksPerSuite: 2,
    fillerTurns: 6,
    fillerTokens: 150,
    files: 5,
    fileTokens: 150,
    lockers: 12,
    denseFacts: 8,
    denseSessions: 2,
  },
  standard: {
    tasksPerSuite: 5,
    fillerTurns: 30,
    fillerTokens: 600,
    files: 16,
    fileTokens: 1200,
    lockers: 40,
    denseFacts: 24,
    denseSessions: 6,
  },
};

/** mulberry32: small, fast, seedable PRNG. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rand = () => number;
const pick = <T>(r: Rand, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const int = (r: Rand, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

// Filler never contains "is", so it can't be mistaken for a fact.
const WORDS =
  "meeting notes draft review agenda customer feedback roadmap sprint backlog design budget hiring launch metrics dashboard incident report vendor contract travel schedule lunch office printer coffee weather traffic slides demo onboarding survey newsletter garden recipe holiday podcast article chapter painting bicycle concert museum keyboard monitor".split(
    " ",
  );
const VERBS =
  "covered mentioned discussed reviewed shared postponed moved summarized revisited updated".split(
    " ",
  );

function sentence(r: Rand): string {
  const n = int(r, 6, 12);
  const words = Array.from({ length: n }, (_, i) => (i === 2 ? pick(r, VERBS) : pick(r, WORDS)));
  const s = words.join(" ");
  return s[0]!.toUpperCase() + s.slice(1) + ".";
}

export function filler(r: Rand, tokens: number): string {
  const out: string[] = [];
  let chars = 0;
  while (chars < tokens * 4) {
    const s = sentence(r);
    out.push(s);
    chars += s.length + 1;
  }
  return out.join(" ");
}

const fillerTurn = (r: Rand, tokens: number): Turn => ({
  user: `Some background notes, no action needed: ${filler(r, tokens)}`,
});

const SUBJECTS = [
  "wifi password for the lab",
  "launch date of project kestrel",
  "name of the on-call engineer",
  "deploy region for the api",
  "budget code for the offsite",
  "license key for the build server",
  "room for the design review",
  "vendor for the new laptops",
  "codename of the next release",
  "parking spot for visitors",
];
const NAMES = [
  "Priya",
  "Tomas",
  "Aiko",
  "Marcus",
  "Lena",
  "Diego",
  "Noor",
  "Felix",
  "Ines",
  "Kwame",
];
const REGIONS = ["eu-west-2", "us-east-1", "ap-south-1", "ca-central-1", "sa-east-1"];

function value(r: Rand, subject: string): string {
  if (subject.includes("name")) return pick(r, NAMES);
  if (subject.includes("region")) return pick(r, REGIONS);
  if (subject.includes("date")) return `2027-0${int(r, 1, 9)}-${int(r, 10, 28)}`;
  const letters = "ABCDEFGHJKMNPQRSTUVWXYZ";
  return `${pick(r, letters.split(""))}${pick(r, letters.split(""))}-${int(r, 1000, 9999)}`;
}

function recallTask(r: Rand, s: Scale, i: number): BenchmarkTask {
  const [a, b] = shuffle(r, SUBJECTS).slice(0, 2) as [string, string];
  const va = value(r, a);
  const vb = value(r, b);
  const fill = (n: number) => Array.from({ length: n }, () => fillerTurn(r, s.fillerTokens));
  const probe = (subject: string, answer: string): Turn => ({
    user: `What is the ${subject}?`,
    probe: { answer, retrievable: true },
  });
  return {
    id: `recall-${i + 1}`,
    suite: "recall",
    description:
      "Two facts stated early, probed after many filler turns and again in a new session.",
    sessions: [
      [
        { user: `Please remember this: the ${a} is ${va}.` },
        ...fill(Math.ceil(s.fillerTurns / 2)),
        { user: `One more thing to keep in mind: the ${b} is ${vb}.` },
        ...fill(Math.floor(s.fillerTurns / 2)),
        probe(a, va),
        probe(b, vb),
      ],
      [...fill(2), probe(b, vb), probe(a, va)],
    ],
  };
}

function updateTask(r: Rand, s: Scale, i: number): BenchmarkTask {
  const subject = pick(r, SUBJECTS);
  const v1 = value(r, subject);
  let v2 = value(r, subject);
  while (v2 === v1) v2 = value(r, subject);
  const fill = (n: number) => Array.from({ length: n }, () => fillerTurn(r, s.fillerTokens));
  const probe: Turn = {
    user: `What is the ${subject}?`,
    probe: { answer: v2, stale: [v1], retrievable: true },
  };
  return {
    id: `update-${i + 1}`,
    suite: "update",
    description: "A fact is stated, later corrected, then probed in the same and a new session.",
    sessions: [
      [
        { user: `For the record, the ${subject} is ${v1}.` },
        ...fill(Math.ceil(s.fillerTurns / 2)),
        { user: `Correction, I changed my mind: the ${subject} is now ${v2}.` },
        ...fill(Math.floor(s.fillerTurns / 2)),
        probe,
      ],
      [...fill(2), probe],
    ],
  };
}

function interferenceTask(r: Rand, s: Scale, i: number): BenchmarkTask {
  const codes = new Map<string, string>();
  const turns: Turn[] = [];
  const lockers = shuffle(
    r,
    Array.from({ length: s.lockers }, (_, k) => k + 1),
  );
  for (let k = 0; k < lockers.length; k += 4) {
    const batch = lockers.slice(k, k + 4).map((n) => {
      const code = String(int(r, 1000, 9999));
      const annex = String(int(r, 1000, 9999));
      codes.set(`locker ${n}`, code);
      // A near-duplicate distractor: similar wording, different key.
      return `the code for locker ${n} is ${code}, and the code for locker ${n} annex is ${annex}`;
    });
    turns.push({ user: `Locker codes, please keep track: ${batch.join("; ")}.` });
    turns.push(fillerTurn(r, Math.ceil(s.fillerTokens / 2)));
  }
  const asked = shuffle(r, [...codes.keys()]).slice(0, 3);
  const probes = (keys: string[]): Turn[] =>
    keys.map((key) => ({
      user: `What is the code for ${key}?`,
      probe: { answer: codes.get(key)!, retrievable: true },
    }));
  return {
    id: `interference-${i + 1}`,
    suite: "interference",
    description:
      "Many similar facts (and near-duplicate distractors); a few are probed now and in a new session.",
    sessions: [
      [
        ...turns,
        ...Array.from({ length: Math.ceil(s.fillerTurns / 3) }, () =>
          fillerTurn(r, s.fillerTokens),
        ),
        ...probes(asked),
      ],
      [fillerTurn(r, s.fillerTokens), ...probes([...asked].reverse())],
    ],
  };
}

function longHorizonTask(r: Rand, s: Scale, i: number): BenchmarkTask {
  const files: Record<string, string> = {};
  let total = 0;
  const names: string[] = [];
  for (let k = 1; k <= s.files; k++) {
    const name = `t${i + 1}-f${String(k).padStart(2, "0")}.txt`;
    const v = int(r, 1, 99);
    total += v;
    names.push(name);
    const half = Math.ceil(s.fileTokens / 2);
    files[name] = `${filler(r, half)}\nThe value of ${name} is ${v}.\n${filler(r, half)}\n`;
  }
  return {
    id: `long-horizon-${i + 1}`,
    suite: "long-horizon",
    description: `Read ${s.files} files one tool call at a time and add up a value from each; the reads exceed the window.`,
    sessions: [
      [
        fillerTurn(r, s.fillerTokens),
        {
          user: `Compute the total of the values of ${names.join(", ")}.`,
          probe: { answer: String(total), retrievable: false },
        },
      ],
    ],
    files,
    maxTurns: s.files * 3,
  };
}

function multiSessionTask(r: Rand, s: Scale, i: number): BenchmarkTask {
  const [a, b] = shuffle(r, SUBJECTS).slice(0, 2) as [string, string];
  const va1 = value(r, a);
  let va2 = value(r, a);
  while (va2 === va1) va2 = value(r, a);
  const vb = value(r, b);
  const fill = (n: number) => Array.from({ length: n }, () => fillerTurn(r, s.fillerTokens));
  const third = Math.max(1, Math.round(s.fillerTurns / 3));
  return {
    id: `multi-session-${i + 1}`,
    suite: "multi-session",
    description:
      "Facts stated and corrected across three sessions, probed in a fourth: recall must survive several sessions and prefer the newest value.",
    sessions: [
      [
        { user: `For the record, the ${a} is ${va1}.` },
        ...fill(third),
        { user: `Please remember this: the ${b} is ${vb}.` },
        ...fill(third),
      ],
      [
        ...fill(third),
        { user: `Correction, I changed my mind: the ${a} is now ${va2}.` },
        ...fill(third),
      ],
      [
        ...fill(third),
        { user: `Reminder for later: the ${a} was ${va1} originally, before the change.` },
        ...fill(third),
      ],
      [
        ...fill(2),
        { user: `What is the ${a}?`, probe: { answer: va2, stale: [va1], retrievable: true } },
        { user: `What is the ${b}?`, probe: { answer: vb, retrievable: true } },
      ],
    ],
  };
}

const BUILDINGS = ["north", "south", "east", "west", "central", "annex", "harbor", "hill"];

function denseInterferenceTask(r: Rand, s: Scale, i: number): BenchmarkTask {
  const codes = new Map<string, string>();
  const sessions: Turn[][] = BUILDINGS.slice(0, s.denseSessions).map((building) => {
    const lockers = shuffle(
      r,
      Array.from({ length: s.denseFacts * 2 }, (_, k) => k + 1),
    );
    const turns: Turn[] = [];
    for (let m = 0; m < 2; m++) {
      const facts = lockers.slice(m * s.denseFacts, (m + 1) * s.denseFacts).map((n) => {
        const code = String(int(r, 1000, 9999));
        codes.set(`locker ${n} in building ${building}`, code);
        return `the code for locker ${n} in building ${building} is ${code}`;
      });
      turns.push({
        user: `Building ${building} locker list, please keep track: ${facts.join("; ")}.`,
      });
      turns.push(fillerTurn(r, Math.ceil(s.fillerTokens / 2)));
    }
    return turns;
  });
  const asked = shuffle(r, [...codes.keys()]).slice(0, 4);
  sessions.push([
    fillerTurn(r, s.fillerTokens),
    ...asked.map((key) => ({
      user: `What is the code for ${key}?`,
      probe: { answer: codes.get(key)!, retrievable: true },
    })),
  ]);
  return {
    id: `dense-interference-${i + 1}`,
    suite: "dense-interference",
    description: `${s.denseSessions} sessions each list ${s.denseFacts * 2} locker codes for one building, with the same locker numbers in every building; four codes are probed in a final session.`,
    sessions,
  };
}

function shuffle<T>(r: Rand, xs: readonly T[]): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const GENERATORS: Record<Suite, (r: Rand, s: Scale, i: number) => BenchmarkTask> = {
  "long-horizon": longHorizonTask,
  recall: recallTask,
  update: updateTask,
  interference: interferenceTask,
  "multi-session": multiSessionTask,
  "dense-interference": denseInterferenceTask,
};

/** Builds the benchmark deterministically from a seed. */
export function generateTasks(
  options: {
    seed?: number;
    scale?: Scale;
    suites?: readonly Suite[];
  } = {},
): BenchmarkTask[] {
  const r = rng(options.seed ?? 1);
  const scale = options.scale ?? SCALES.standard;
  const tasks: BenchmarkTask[] = [];
  for (const suite of options.suites ?? SUITES) {
    for (let i = 0; i < scale.tasksPerSuite; i++) tasks.push(GENERATORS[suite](r, scale, i));
  }
  return tasks;
}
