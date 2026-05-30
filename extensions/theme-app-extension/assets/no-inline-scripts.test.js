import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Phase 2 (CSP). Theme app extension blocks render inside the merchant's
// theme, so we can't set CSP for them — but we MUST keep them friendly to a
// merchant who DOES set a strict CSP. That means:
//   • no inline <script>…</script> bodies
//   • no inline event-handler attributes (onclick, onload, etc.)
//   • no javascript: URLs
// External `<script src="…">` and Shopify-managed `{% javascript %}` blocks
// (which Shopify externalises) are fine.

const BLOCKS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'blocks',
);

function liquidFiles() {
  return readdirSync(BLOCKS_DIR)
    .filter(f => f.endsWith('.liquid'))
    .map(f => ({ name: f, body: readFileSync(join(BLOCKS_DIR, f), 'utf8') }));
}

describe('theme-app-extension: no inline scripts (CSP-friendly)', () => {
  it('every block under blocks/ exists', () => {
    expect(liquidFiles().length).toBeGreaterThan(0);
  });

  for (const f of liquidFiles()) {
    describe(f.name, () => {
      it('has no inline <script> bodies (only src= scripts allowed)', () => {
        // Match any <script ...> that does NOT contain `src=`.
        // Captures both `<script>` and `<script type="…">`-style openers.
        const matches = f.body.match(/<script\b(?![^>]*\bsrc=)[^>]*>/gi);
        expect(matches, `inline <script> tags in ${f.name}: ${JSON.stringify(matches)}`).toBeNull();
      });

      it('has no inline event-handler attributes (on*=)', () => {
        // Match `onclick="…"`, `onload='…'`, etc. Exclude data-on… and similar
        // by requiring word-boundary `on<letters>=`.
        const matches = f.body.match(/\son[a-z]+=\s*["']/gi);
        expect(matches, `inline on*= handlers in ${f.name}: ${JSON.stringify(matches)}`).toBeNull();
      });

      it('has no javascript: URLs', () => {
        expect(f.body).not.toMatch(/javascript:/i);
      });
    });
  }
});
