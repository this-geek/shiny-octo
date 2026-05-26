# cart-transform load test

Closes PLAN.md Phase 1D's last checkbox: p95 < 5ms for a 200-line cart
against a 10-tier config.

## Two layers

| Layer | Where | When | Asserts |
|---|---|---|---|
| Pure-JS bench | `src/load.test.ts` | every PR via vitest | algorithmic regressions; Node V8 p95 < 1ms |
| `function-runner` smoke | manual, see below | once before pilot | Shopify QuickJS runtime p95 < 5ms |

The CI-resident vitest bench catches the failure modes we actually expect
(an accidental quadratic pass over `lines × tiers`, an unbounded JSON
allocation, a new lookup baked into the Function). It does **not**
certify production latency — that's the prod-faithful smoke below.

## Manual prod-faithful smoke

Run once before promoting the Function to a production pilot, and again
any time the Function's algorithm changes materially.

1. Install the Shopify CLI (see `MANUAL_STEPS.md §1`).
2. Build the Function bundle:
   ```sh
   pnpm --filter @b2b/function-cart-transform exec shopify app function build
   ```
   This writes `dist/function.wasm` (or the JS-runtime equivalent) under
   `extensions/functions/cart-transform/`.
3. Generate a representative input:
   ```sh
   node --input-type=module -e "
   import('./src/load.test.ts'); // re-exports the generator
   " > /tmp/load-input.json
   ```
   (Or copy the `buildInput()` body from `src/load.test.ts` into a small
   script that prints `JSON.stringify(buildInput())`.)
4. Run `function-runner` 1000 times and measure:
   ```sh
   for i in $(seq 1 1000); do
     /usr/bin/time -f "%e" \
       function-runner -f dist/function.wasm \
       < /tmp/load-input.json > /dev/null
   done | sort -n | awk 'BEGIN {c=0} {a[c++]=$1} END {print a[int(c*0.95)]}'
   ```
5. Confirm the printed p95 is < 5ms. Record the value in the pilot
   sign-off note for the merchant.

When `function-runner` becomes available as a Shopify-supplied GitHub
Action, this manual step folds back into CI. Until then it stays manual.
