// DECISIONS #10: localStorage cache is UX-only. The Function re-resolves
// tier from Company metafield on every cart-transform; never use this
// cache to gate access or make authorization decisions.

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

  function formatPriceCents(cents) {
    var dollars = cents / 100;
    return dollars.toFixed(2);
  }

  function renderTierPrice(block, tier) {
    var basePriceCents = parseInt(block.getAttribute('data-base-price-cents'), 10);
    if (!Number.isFinite(basePriceCents)) return;
    var discountedDollars = applyTierDiscount(basePriceCents / 100, tier.discount_type, tier.discount_value);
    block.textContent = 'Your price: $' + discountedDollars.toFixed(2);
    block.setAttribute('data-tier-applied', String(tier.id));
  }

  function handleBlock(block, ctx) {
    var b2bOnly = block.getAttribute('data-b2b-only') === 'true';
    if (b2bOnly && (!ctx || ctx.b2b === false)) {
      // Defence-in-depth alongside the template-level 404 guard.
      window.location.replace('/collections/all');
      return;
    }
    if (ctx && ctx.tier) {
      renderTierPrice(block, ctx.tier);
    }
  }

  function init() {
    var blocks = document.querySelectorAll('[data-b2b-price-block]');
    if (blocks.length === 0) return;

    var appProxyPath = blocks[0].getAttribute('data-app-proxy-path') || 'apps/b2b';
    var cached = readCache();

    if (cached) {
      blocks.forEach(function (b) { handleBlock(b, cached); });
      return;
    }

    fetchContext(appProxyPath)
      .then(function (ctx) {
        writeCache(ctx);
        blocks.forEach(function (b) { handleBlock(b, ctx); });
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
