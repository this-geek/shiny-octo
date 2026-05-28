// Phase 1D load test — closes PLAN.md 1D's last checkbox.
//
// The production SLO is p95 < 5ms for a 200-line cart against a 10-tier
// config, executed inside Shopify's Function JavaScript runtime (QuickJS).
// We can't run that runtime in CI without standing up the Shopify CLI plus
// dev-store credentials, so the hermetic bench here drives the same pure
// `run()` function under Node V8 and asserts a tighter budget. V8 is on
// the order of 5-10x faster than QuickJS for this kind of object-mutation
// workload; a Node-budget of 1ms p95 corresponds to a comfortable
// production headroom under the 5ms SLO. The prod-faithful confirmation
// runs once before pilot via Shopify's `function-runner` binary —
// procedure in `LOAD_TEST.md`.
//
// What this protects against: algorithmic regressions (an accidental O(n²)
// pass over `cart.lines × tiers`, a new GraphQL lookup baked into the
// Function, an unbounded JSON stringify). It does NOT certify production
// latency; that's the manual signoff.

import { describe, it, expect } from 'vitest';
import { run, type FunctionInput } from './index.js';

const LINES = 200;
const TIERS = 10;
const ITERATIONS = 1000;
const NODE_P95_BUDGET_MS = 1.0;

function buildInput(): FunctionInput {
  const tiers = Array.from({ length: TIERS }, (_, i) => ({
    id: i + 1,
    name: `Tier ${i + 1}`,
    discount_type: (i % 2 === 0 ? 'percent' : 'amount') as 'percent' | 'amount',
    discount_value: i % 2 === 0 ? 5 + i : 2 + i,
  }));
  const lines = Array.from({ length: LINES }, (_, i) => ({
    id: `gid://shopify/CartLine/${i + 1}`,
    quantity: 1 + (i % 5),
    cost: { amountPerQuantity: { amount: (10 + (i % 50)).toFixed(2) } },
  }));

  return {
    shop: {
      isPlus: { value: 'false' },
      tiersConfig: { value: JSON.stringify({ version: 1, tiers }) },
    },
    cart: {
      lines,
      buyerIdentity: {
        // Match the middle tier so the worst-case `find` lookup runs.
        purchasingCompany: { company: { metafield: { value: String(Math.ceil(TIERS / 2)) } } },
      },
    },
  };
}

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

describe('cart-transform: 200-line × 10-tier load test', () => {
  it('emits one operation per eligible line', () => {
    const result = run(buildInput());
    expect(result.operations.length).toBe(LINES);
  });

  it('p95 under Node V8 stays well below the prod SLO', () => {
    const input = buildInput();
    // Warmup to let V8 settle on a hot path before sampling.
    for (let i = 0; i < 100; i++) run(input);

    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = performance.now();
      run(input);
      samples.push(performance.now() - t0);
    }

    const p50 = percentile(samples, 50);
    const p95 = percentile(samples, 95);
    const p99 = percentile(samples, 99);
    // eslint-disable-next-line no-console
    console.log(
      `[cart-transform load] N=${ITERATIONS} lines=${LINES} tiers=${TIERS} ` +
        `p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms p99=${p99.toFixed(3)}ms`,
    );
    expect(p95).toBeLessThan(NODE_P95_BUDGET_MS);
  });
});
