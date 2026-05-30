// DECISIONS #10: localStorage cache is UX-only. The Function re-resolves
// tier from Company metafield on every cart-transform; never use this
// cache to gate access or make authorization decisions.
//
// Two paths (DECISIONS #21):
//   1. Per-product block [data-b2b-price-block] (PDP): cents-accurate render
//      from the Liquid-emitted base price. Unchanged from Phase 1B.
//   2. Site-wide controller [data-b2b-price-controller]: scans the theme's
//      price containers across collections / search / home / related products
//      and overlays the tier delta on top of the already-rendered price.
//      v1 handles PERCENT tiers only — amount tiers and per-product
//      exclusions need the authoritative /tier-prices map (tracked as v2),
//      so the overlay no-ops for non-percent tiers rather than guess.
//
// Money parsing here (parseMoney/parseAmount/formatLikeOriginal) is mirrored
// byte-for-byte in assets/b2b-price-money.test.js — keep them in lockstep.

(function () {
  'use strict';

  var CACHE_KEY = 'b2b_tier';
  var CACHE_TTL_MS = 5 * 60 * 1000;

  function applyTierDiscount(basePrice, discountType, discountValue) {
    var discounted = basePrice;
    if (discountType === 'percent') {
      discounted = basePrice * (1 - discountValue / 100);
    } else if (discountType === 'amount') {
      discounted = basePrice - discountValue;
    }
    return Math.max(0, discounted);
  }

  function readCache() {
    try {
      var raw = window.localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.expires_at !== 'number') return null;
      if (parsed.expires_at <= Date.now()) return null;
      return parsed;
    } catch (e) {
      return null;
    }
  }

  function writeCache(payload) {
    try {
      var record = Object.assign({}, payload, { expires_at: Date.now() + CACHE_TTL_MS });
      window.localStorage.setItem(CACHE_KEY, JSON.stringify(record));
    } catch (e) {
      // Quota or disabled storage — ignore; UX-only cache.
    }
  }

  function fetchContext(appProxyPath) {
    var path = '/' + String(appProxyPath || 'apps/b2b').replace(/^\/+|\/+$/g, '') + '/tier-context';
    return fetch(path, { credentials: 'same-origin' })
      .then(function (res) {
        if (!res.ok) throw new Error('tier-context ' + res.status);
        return res.json();
      });
  }

  function buildTierMarkup(basePriceCents, discountedDollars, showSavingsBadge) {
    var baseDollars = basePriceCents / 100;
    var savings = baseDollars - discountedDollars;
    var html = '<span class="b2b-tier-price" data-b2b-tier-price>$' + discountedDollars.toFixed(2) + '</span>';
    if (showSavingsBadge && savings > 0) {
      html += ' <span class="b2b-tier-savings" data-b2b-tier-savings>Save $' + savings.toFixed(2) + '</span>';
    }
    return html;
  }

  function renderTierPrice(block, ctx) {
    var basePriceCents = parseInt(block.getAttribute('data-base-price-cents'), 10);
    if (!Number.isFinite(basePriceCents)) return;

    var priceSelector = (block.getAttribute('data-price-selector') || '').trim();
    if (!priceSelector) {
      console.warn('[b2b-price] no price selector configured; skipping tier render');
      return;
    }

    var target = document.querySelector(priceSelector);
    if (!target) {
      console.warn('[b2b-price] price selector matched no element: ' + priceSelector);
      return;
    }

    var showBadge = block.getAttribute('data-show-savings-badge') === 'true';
    var mode = block.getAttribute('data-price-display') || 'alongside';
    var discountedDollars = applyTierDiscount(basePriceCents / 100, ctx.tier.discount_type, ctx.tier.discount_value);
    var markup = buildTierMarkup(basePriceCents, discountedDollars, showBadge);

    if (mode === 'replace') {
      target.innerHTML = markup;
    } else {
      var existing = target.parentNode && target.parentNode.querySelector('[data-b2b-tier-block]');
      if (existing) existing.remove();
      var wrap = document.createElement('div');
      wrap.setAttribute('data-b2b-tier-block', '');
      wrap.className = 'b2b-tier-block';
      wrap.innerHTML = 'Your price: ' + markup;
      target.insertAdjacentElement('afterend', wrap);
    }

    // Mark so the site-wide controller doesn't re-discount the PDP price.
    target.setAttribute('data-b2b-overlaid', '');
    block.setAttribute('data-tier-applied', String(ctx.tier.id));
  }

  function handleBlock(block, ctx) {
    var b2bOnly = block.getAttribute('data-b2b-only') === 'true';
    if (b2bOnly && (!ctx || ctx.b2b === false)) {
      // Defence-in-depth alongside the template-level 404 guard.
      window.location.replace('/collections/all');
      return;
    }
    if (ctx && ctx.tier) {
      renderTierPrice(block, ctx);
    }
  }

  // ---- Site-wide overlay (percent tiers) -----------------------------------

  // Does `sep` act as a decimal point in `s`? Only when it occurs once and is
  // followed by 1-2 trailing digits (e.g. "10.00", "1,5"). Multiple occurrences
  // mean it is a thousands separator.
  function isDecimalSep(s, sep) {
    var i = s.lastIndexOf(sep);
    if (i < 0) return false;
    if (s.indexOf(sep) !== i) return false;
    var trailing = s.length - i - 1;
    return trailing === 1 || trailing === 2;
  }

  // Parse a numeric money token like "1,234.56" / "1.234,56" / "10.00" / "1,000".
  function parseAmount(numStr) {
    var lastDot = numStr.lastIndexOf('.');
    var lastComma = numStr.lastIndexOf(',');
    var decSep = null;
    if (lastDot >= 0 && lastComma >= 0) {
      decSep = lastDot > lastComma ? '.' : ',';
    } else if (lastDot >= 0) {
      decSep = isDecimalSep(numStr, '.') ? '.' : null;
    } else if (lastComma >= 0) {
      decSep = isDecimalSep(numStr, ',') ? ',' : null;
    }
    var normalized;
    if (decSep) {
      var thouSep = decSep === '.' ? ',' : '.';
      normalized = numStr.split(thouSep).join('').replace(decSep, '.');
    } else {
      normalized = numStr.replace(/[.,]/g, '');
    }
    var val = parseFloat(normalized);
    return isFinite(val) ? val : null;
  }

  // Reformat `amount` to match the decimal/grouping style of `numStr`.
  function formatLikeOriginal(amount, numStr) {
    var lastDot = numStr.lastIndexOf('.');
    var lastComma = numStr.lastIndexOf(',');
    var decSep = null;
    var thouSep = '';
    if (lastDot >= 0 && lastComma >= 0) {
      decSep = lastDot > lastComma ? '.' : ',';
      thouSep = decSep === '.' ? ',' : '.';
    } else if (lastDot >= 0 && isDecimalSep(numStr, '.')) {
      decSep = '.';
    } else if (lastComma >= 0 && isDecimalSep(numStr, ',')) {
      decSep = ',';
    } else if (numStr.indexOf(',') >= 0) {
      thouSep = ',';
    } else if (numStr.indexOf('.') >= 0) {
      thouSep = '.';
    }
    var decimals = decSep ? numStr.length - numStr.lastIndexOf(decSep) - 1 : 0;
    var fixed = amount.toFixed(decimals);
    var parts = fixed.split('.');
    var intPart = parts[0];
    var fracPart = parts[1] || '';
    if (thouSep) {
      intPart = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, thouSep);
    }
    return decimals > 0 ? intPart + (decSep || '.') + fracPart : intPart;
  }

  // Pull the first price-like token + its currency prefix out of a string.
  function parseMoney(text) {
    if (!text) return null;
    var m = String(text).match(/\d[\d.,]*\d|\d/);
    if (!m) return null;
    var numStr = m[0];
    var before = String(text).slice(0, m.index);
    var symMatch = before.match(/([^\s\d]+)\s*$/);
    var prefix = symMatch ? symMatch[1] : '';
    var amount = parseAmount(numStr);
    if (amount === null || !isFinite(amount)) return null;
    return { amount: amount, prefix: prefix, numStr: numStr };
  }

  function overlayNode(node, ctx, showBadge, mode) {
    if (node.hasAttribute('data-b2b-overlaid')) return;
    if (node.querySelector && node.querySelector('[data-b2b-tier-price]')) return;
    var parsed = parseMoney(node.textContent || '');
    if (!parsed || parsed.amount <= 0) return;

    var discounted = applyTierDiscount(parsed.amount, ctx.tier.discount_type, ctx.tier.discount_value);
    if (!(discounted < parsed.amount)) return; // 0% or rounding: nothing to show

    var discountedStr = parsed.prefix + formatLikeOriginal(discounted, parsed.numStr);
    var savings = parsed.amount - discounted;
    var savingsStr = parsed.prefix + formatLikeOriginal(savings, parsed.numStr);

    var markup = '<span class="b2b-tier-price" data-b2b-tier-price>' + discountedStr + '</span>';
    if (showBadge && savings > 0) {
      markup += ' <span class="b2b-tier-savings" data-b2b-tier-savings>Save ' + savingsStr + '</span>';
    }

    if (mode === 'replace') {
      node.innerHTML = markup;
    } else {
      var wrap = document.createElement('span');
      wrap.setAttribute('data-b2b-tier-block', '');
      wrap.className = 'b2b-tier-block';
      wrap.innerHTML = ' ' + markup;
      node.appendChild(wrap);
    }
    node.setAttribute('data-b2b-overlaid', '');
  }

  function handleController(controller, ctx) {
    if (!ctx || !ctx.tier) return;
    // v1: only percent tiers can be derived from the displayed price. Amount
    // tiers / exclusions need authoritative per-variant cents (v2 /tier-prices).
    if (ctx.tier.discount_type !== 'percent') return;
    if (!(ctx.tier.discount_value > 0)) return;

    var selector = (controller.getAttribute('data-price-selector') || '').trim();
    if (!selector) return;
    var showBadge = controller.getAttribute('data-show-savings-badge') === 'true';
    var mode = controller.getAttribute('data-price-display') || 'alongside';

    var nodes = document.querySelectorAll(selector);
    for (var i = 0; i < nodes.length; i++) {
      overlayNode(nodes[i], ctx, showBadge, mode);
    }
  }

  function run(ctx) {
    // PDP blocks first so their cents-accurate render marks the main price as
    // overlaid before the controller scans.
    var blocks = document.querySelectorAll('[data-b2b-price-block]');
    blocks.forEach(function (b) { handleBlock(b, ctx); });
    var controllers = document.querySelectorAll('[data-b2b-price-controller]');
    for (var i = 0; i < controllers.length; i++) {
      handleController(controllers[i], ctx);
    }
  }

  function init() {
    var blocks = document.querySelectorAll('[data-b2b-price-block]');
    var controllers = document.querySelectorAll('[data-b2b-price-controller]');
    if (blocks.length === 0 && controllers.length === 0) return;

    var anchor = blocks[0] || controllers[0];
    var appProxyPath = anchor.getAttribute('data-app-proxy-path') || 'apps/b2b';
    var cached = readCache();

    if (cached) {
      run(cached);
      return;
    }

    fetchContext(appProxyPath)
      .then(function (ctx) {
        writeCache(ctx);
        run(ctx);
      })
      .catch(function () {
        // Silent failure — page still works with public price.
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
