import { clip, salience, SENTENCE } from "../text.js";
import type { FactKind } from "./types.js";

export interface FactCandidate {
  kind: FactKind;
  subject: string;
  value: string;
  text: string;
}

const STATEMENT = /\bthe ([a-z0-9][a-z0-9 ._'/-]*?) (?:is|are) (?:now |still )?([^.,;\n]+)/gi;
const PREFERENCE =
  /\b(?:I|we) (prefer|like|want|always use|never use|don't use|do not use|avoid)\s+([^.,;\n]+)/gi;

const THIRD_PERSON: Record<string, string> = {
  prefer: "prefers",
  like: "likes",
  want: "wants",
  "always use": "always uses",
  "never use": "never uses",
  "don't use": "doesn't use",
  "do not use": "does not use",
  avoid: "avoids",
};

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Heuristic fact extraction: "the <subject> is <value>" statements and
 * first-person preferences ("I prefer tabs"). A later statement about the same
 * subject supersedes an earlier one. Model-based extraction can replace this.
 */
export function extractFacts(text: string): FactCandidate[] {
  const out = new Map<string, FactCandidate>();
  for (const m of text.matchAll(STATEMENT)) {
    const subject = normalize(m[1]!);
    const value = m[2]!.trim().replace(/[\s"')\]]+$/, "");
    if (subject.split(" ").length > 10 || !value || value.length > 80) continue;
    out.set(subject, { kind: "fact", subject, value, text: `the ${subject} is ${value}` });
  }
  for (const m of text.matchAll(PREFERENCE)) {
    const verb = normalize(m[1]!);
    const object = normalize(m[2]!);
    if (!object || object.length > 80) continue;
    const subject = `preference: ${object}`;
    out.set(subject, {
      kind: "preference",
      subject,
      value: verb,
      text: `the user ${THIRD_PERSON[verb] ?? verb} ${object}`,
    });
  }
  return [...out.values()];
}

const PATH = /(?:^|[\s(`'"])((?:[\w.-]+\/)*[\w-]+\.[a-z0-9]{1,5})(?=$|[\s),`'":;])/gi;
const PROPER = /(?<![.!?]\s|^)\b([A-Z][a-z]{2,})\b/g;
const CODE = /\b([A-Z]{2,}-\d{2,})\b/g;

/**
 * Entities a piece of text mentions: file paths, codes, proper nouns, and the
 * noun phrases of fact subjects ("code for locker 7 in building north" →
 * "code", "locker 7", "building north").
 */
export function extractEntities(text: string, facts: readonly FactCandidate[] = []): string[] {
  const names = new Set<string>();
  for (const m of text.matchAll(PATH)) names.add(m[1]!.toLowerCase());
  for (const m of text.matchAll(CODE)) names.add(m[1]!.toLowerCase());
  for (const m of text.matchAll(PROPER)) names.add(m[1]!.toLowerCase());
  for (const f of facts) for (const part of subjectParts(f.subject)) names.add(part);
  return [...names];
}

/** Noun phrases of a subject, split at prepositions. */
export function subjectParts(subject: string): string[] {
  return subject
    .replace(/^preference: /, "")
    .split(/\b(?:for|of|in|on|at|to|with|from|the)\b/)
    .map((p) => p.trim())
    .filter((p) => p.length > 1);
}

/** A compact index of a long text: its most informative sentences, in order. */
export function indexOf(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text.trim();
  const sentences = text
    .split(SENTENCE)
    .map((s) => s.trim())
    .filter(Boolean);
  const ranked = sentences
    .map((s, i) => ({ s, i, score: salience(s) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i);
  const kept: typeof ranked = [];
  let used = 0;
  for (const x of ranked) {
    if (used + x.s.length + 1 > maxChars) continue;
    kept.push(x);
    used += x.s.length + 1;
  }
  if (kept.length === 0) return clip(text, maxChars);
  return kept
    .sort((a, b) => a.i - b.i)
    .map((x) => x.s)
    .join(" ");
}
