// b2b-minimums.js — Phase 1F PDP quantity snapper.
//
// UX-only. The cart-validation Function re-checks case_quantity /
// min_order_qty / max_order_qty server-side, so this script is purely a
// nudge to prevent the buyer from hitting a validation error at the
// cart. Logic mirrors the snapQuantity test in b2b-minimums.test.js;
// any change here must be reflected there.

(function () {
  'use strict';

  function snapQuantity(qty, opts) {
    var caseQty = opts.caseQty || null;
    var minQty = opts.minQty || null;
    var maxQty = opts.maxQty || null;

    var q = Math.max(1, Math.floor(Number(qty) || 1));
    if (caseQty) q = Math.ceil(q / caseQty) * caseQty;
    if (minQty && q < minQty) {
      q = caseQty ? Math.ceil(minQty / caseQty) * caseQty : minQty;
    }
    if (maxQty && q > maxQty) {
      q = caseQty ? Math.floor(maxQty / caseQty) * caseQty : maxQty;
    }
    return q;
  }

  function parseOpt(block, name) {
    var raw = block.getAttribute(name);
    var n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function bindInput(input, opts) {
    function handler() {
      var snapped = snapQuantity(input.value, opts);
      if (String(snapped) !== String(input.value)) {
        input.value = String(snapped);
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    input.addEventListener('change', handler);
    input.addEventListener('blur', handler);
  }

  function init() {
    var block = document.querySelector('[data-b2b-minimums-block]');
    if (!block) return;
    if (block.getAttribute('data-customer-is-b2b') !== 'true') return;
    if (block.getAttribute('data-snap-qty') !== 'true') return;

    var opts = {
      caseQty: parseOpt(block, 'data-case-qty'),
      minQty: parseOpt(block, 'data-min-qty'),
      maxQty: parseOpt(block, 'data-max-qty'),
    };

    var inputs = document.querySelectorAll(
      'form[action*="/cart/add"] input[name="quantity"]',
    );
    inputs.forEach(function (input) {
      if (opts.caseQty) input.step = String(opts.caseQty);
      if (opts.minQty) input.min = String(opts.minQty);
      if (opts.maxQty) input.max = String(opts.maxQty);
      bindInput(input, opts);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
