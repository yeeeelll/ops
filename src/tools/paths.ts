import path from 'node:path';
import { config } from '../config.js';

export interface PathCheck {
  ok: boolean;
  resolved: string;
  readonly: boolean;
  reason?: string;
}

export function checkPath(input: string, requireWrite = false): PathCheck {
  const resolved = path.resolve(input);
  const allowedRoots = config.tools.allowedPaths;
  if (allowedRoots.length === 0) {
    return { ok: false, resolved, readonly: true, reason: 'ALLOWED_PATHS is empty' };
  }
  const inAllowed = allowedRoots.some((root) => isInside(resolved, root));
  if (!inAllowed) {
    return {
      ok: false,
      resolved,
      readonly: true,
      reason: `path outside ALLOWED_PATHS: ${resolved}`,
    };
  }
  const readonly = config.tools.readonlyPaths.some((root) => isInside(resolved, root));
  if (requireWrite && readonly) {
    return { ok: false, resolved, readonly, reason: `path is read-only: ${resolved}` };
  }
  return { ok: true, resolved, readonly };
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
