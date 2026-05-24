// b2b-assets.js — buyer dealer asset portal (Phase 1C).
//
// All visibility resolution happens server-side in the Worker on every
// list/download call (asset-visibility.ts). This file only renders what the
// server returns; the client is not allowed to enumerate hidden assets.
//
// Downloads stream through the Worker so we can:
//   - enforce per-asset visibility on every request (defence in depth),
//   - log the download with hashed customer + IP,
//   - count it against the monthly bandwidth ceiling (DECISIONS #14).
// R2 URLs are never exposed to the browser.

(function () {
  'use strict';

  function bytesFmt(b) {
    if (!b) return '';
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
    return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function render(root, assets, filterText, filterType) {
    var term = filterText.trim().toLowerCase();
    var filtered = assets.filter(function (a) {
      if (filterType !== 'all' && a.type !== filterType) return false;
      if (!term) return true;
      var hay = (a.title + ' ' + (a.description || '')).toLowerCase();
      return hay.indexOf(term) !== -1;
    });

    if (filtered.length === 0) {
      root.innerHTML = '<p class="b2b-assets__empty">No assets match.</p>';
      return;
    }

    var html = filtered
      .map(function (a) {
        var meta = [a.type, bytesFmt(a.file_size_bytes)].filter(Boolean).join(' · ');
        return (
          '<div class="b2b-assets__item">' +
            '<div>' +
              '<div class="b2b-assets__title">' + escapeHtml(a.title) + '</div>' +
              (a.description
                ? '<div class="b2b-assets__meta">' + escapeHtml(a.description) + '</div>'
                : '') +
              '<div class="b2b-assets__meta">' + escapeHtml(meta) + '</div>' +
            '</div>' +
            '<div><button type="button" data-download-id="' + a.id + '">Download</button></div>' +
          '</div>'
        );
      })
      .join('');
    root.innerHTML = html;
  }

  function init(block) {
    var isB2b = block.getAttribute('data-customer-is-b2b') === 'true';
    if (!isB2b) return;

    var appProxyPath = block.getAttribute('data-app-proxy-path') || 'apps/b2b';
    var listUrl = '/' + appProxyPath.replace(/^\/+/, '') + '/assets/list';
    var dlBase = '/' + appProxyPath.replace(/^\/+/, '') + '/assets/download/';
    var root = block.querySelector('.b2b-assets__root');
    if (!root) return;

    // Filter UI: built once, then render() is called whenever the filter changes.
    var filterEl = document.createElement('div');
    filterEl.className = 'b2b-assets__filter';
    filterEl.innerHTML =
      '<input type="search" placeholder="Search" aria-label="Search assets" />' +
      '<select aria-label="Filter by type">' +
        '<option value="all">All types</option>' +
        '<option value="image">Images</option>' +
        '<option value="pdf">PDFs</option>' +
        '<option value="video">Videos</option>' +
        '<option value="link">Links</option>' +
      '</select>';
    block.insertBefore(filterEl, root);

    var assets = [];
    var input = filterEl.querySelector('input');
    var select = filterEl.querySelector('select');
    function reRender() {
      render(root, assets, input.value, select.value);
    }
    input.addEventListener('input', reRender);
    select.addEventListener('change', reRender);

    root.addEventListener('click', function (e) {
      var btn = e.target;
      if (!(btn && btn.getAttribute && btn.getAttribute('data-download-id'))) return;
      var id = btn.getAttribute('data-download-id');
      btn.disabled = true;
      btn.textContent = 'Preparing…';
      fetch(dlBase + encodeURIComponent(id), {
        method: 'GET',
        credentials: 'same-origin',
      })
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          var ctype = res.headers.get('content-type') || '';
          if (ctype.indexOf('application/json') !== -1) {
            return res.json().then(function (j) {
              if (j && j.url) window.open(j.url, '_blank', 'noopener');
              else throw new Error('no url');
            });
          }
          return res.blob().then(function (blob) {
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = btn.closest('.b2b-assets__item').querySelector(
              '.b2b-assets__title',
            ).textContent;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
          });
        })
        .catch(function (err) {
          btn.textContent = 'Error';
          console.error('b2b-assets download failed', err);
        })
        .finally(function () {
          setTimeout(function () {
            btn.disabled = false;
            if (btn.textContent !== 'Error') btn.textContent = 'Download';
          }, 1500);
        });
    });

    root.innerHTML = '<p class="b2b-assets__empty">Loading…</p>';
    fetch(listUrl, { credentials: 'same-origin' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (j) {
        assets = (j && j.assets) || [];
        reRender();
      })
      .catch(function (err) {
        root.innerHTML = '<p class="b2b-assets__empty">Could not load assets.</p>';
        console.error('b2b-assets list failed', err);
      });
  }

  document.querySelectorAll('[data-b2b-assets-block]').forEach(init);
})();
