/**
 * Which build this is: the package version and, when known, the git commit.
 * `npm run build` writes dist/build-info.json next to this module (see
 * scripts/build-info.mjs); without it, package.json still gives the version.
 *
 * Shown on every page's footer, in /healthz, in the MCP server info and in the
 * startup log, so people running different copies can tell them apart.
 */

import { readFileSync } from 'node:fs';

export interface BuildInfo {
  version: string;
  /** Short commit hash, or null when the build did not know it. */
  commit: string | null;
  /** Built from a working tree whose tracked files differed from the commit (detected by git at build time). */
  dirty: boolean;
}

function readJson(relative: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function load(): BuildInfo {
  const info = readJson('./build-info.json');
  const pkg = readJson('../package.json');
  const version = typeof info?.['version'] === 'string' ? info['version'] : typeof pkg?.['version'] === 'string' ? pkg['version'] : '0.0.0';
  const commit = typeof info?.['commit'] === 'string' && /^[0-9a-f]{7,40}$/.test(info['commit']) ? info['commit'] : null;
  return { version, commit, dirty: commit !== null && info?.['dirty'] === true };
}

export const BUILD: BuildInfo = load();

/** "0.3.0 (a1b2c3d)", "0.3.0 (a1b2c3d, modified)", or "0.3.0" when the commit is unknown. */
export function versionLabel(build: BuildInfo = BUILD, modified = 'modified'): string {
  if (!build.commit) return build.version;
  return `${build.version} (${build.commit}${build.dirty ? `, ${modified}` : ''})`;
}
