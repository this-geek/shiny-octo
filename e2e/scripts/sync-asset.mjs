#!/usr/bin/env node
// Mirrors the parity-test convention in
// extensions/theme-app-extension/assets/b2b-price.test.js: the e2e suite
// runs against a checked-in copy of the canonical asset so failures show
// real diffs in code review. This script enforces the copy is byte-for-byte
// identical to the canonical file. `--check` (default in pretest) fails
// loudly if they diverge; `--write` updates the copy.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const canonical = resolve(root, '../extensions/theme-app-extension/assets/b2b-price.js');
const fixtureCopy = resolve(root, 'fixtures/b2b-price.js');

const mode = process.argv.includes('--write') ? 'write' : 'check';

const canonicalSrc = readFileSync(canonical, 'utf8');

if (mode === 'write') {
  writeFileSync(fixtureCopy, canonicalSrc);
  console.log(`[sync-asset] wrote ${fixtureCopy}`);
  process.exit(0);
}

let copySrc = '';
try {
  copySrc = readFileSync(fixtureCopy, 'utf8');
} catch {
  // missing file falls through to mismatch
}

if (copySrc !== canonicalSrc) {
  console.error(
    `[sync-asset] e2e fixture copy is stale.\n  canonical: ${canonical}\n  copy:      ${fixtureCopy}\nRun: pnpm --filter @b2b/e2e test:update-fixtures`,
  );
  process.exit(1);
}
