#!/usr/bin/env node
// Writes dist/build-info.json: the version from package.json and the git
// commit the build came from, shown on the server's pages and /healthz.
//
// The commit is taken from BUILD_COMMIT when set (Docker builds have no .git),
// otherwise from git itself. "dirty" is detected automatically: git compares
// the tracked files with the last commit at build time, so a build made from
// uncommitted changes is marked as modified. With BUILD_COMMIT there is no git
// to ask, so the flag stays off. Runs as part of `npm run build`.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const { version } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));

function git(...args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

let commit = process.env.BUILD_COMMIT?.trim() || null;
let dirty = false;
if (!commit) {
  commit = git('rev-parse', '--short=7', 'HEAD');
  // Only tracked files count: a stray local file doesn't change what runs.
  if (commit) dirty = (git('status', '--porcelain', '--untracked-files=no') ?? '') !== '';
}
if (commit && !/^[0-9a-f]{7,40}$/i.test(commit)) {
  console.warn(`build-info: ignoring commit "${commit}", not a commit hash`);
  commit = null;
}

const info = { version, commit: commit ? commit.slice(0, 7).toLowerCase() : null, dirty };
writeFileSync(new URL('dist/build-info.json', root), JSON.stringify(info, null, 2) + '\n');
console.log(`build-info: ${version}${info.commit ? ` (${info.commit}${dirty ? ', modified' : ''})` : ' (commit unknown)'}`);
