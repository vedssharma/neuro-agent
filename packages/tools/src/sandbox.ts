import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export class SandboxError extends Error {
  override name = "SandboxError";
}

const inside = (root: string, target: string) => {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/** Resolves the deepest existing ancestor through symlinks so links can't escape the root. */
function realpathOfExisting(path: string): string {
  let current = path;
  const rest: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync(current), ...rest.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      rest.push(basename(current));
      current = parent;
    }
  }
}

/**
 * Resolves `path` against the workspace root and refuses anything outside it,
 * including escapes through `..` and symlinks.
 */
export function resolveInWorkspace(root: string, path: string): string {
  const realRoot = realpathSync(root);
  const target = resolve(realRoot, path);
  if (!inside(realRoot, target) || !inside(realRoot, realpathOfExisting(target))) {
    throw new SandboxError(`Path is outside the workspace: ${path}`);
  }
  return target;
}

/** Workspace-relative display path. */
export function displayPath(root: string, absolute: string): string {
  return relative(realpathSync(root), absolute) || ".";
}
