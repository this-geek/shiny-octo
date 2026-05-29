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
