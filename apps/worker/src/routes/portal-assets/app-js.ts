/**
 * Vanilla JS SPA for the buyer-facing dealer portal. Served as a static
 * asset at /proxy/portal/static/app.js. Bundled as a string export to
 * avoid adding a build step to the Worker — at ~200 lines this is cheaper
 * than wiring up esbuild for one file.
 *
 * Reads boot JSON from `<script id="b2b-portal-boot">`, then renders tabs
 * for Assets and Profile, the first-login tour banner, and a download flow
 * that calls /api/assets/download/:id and follows the returned R2 URL.
 */
export const APP_JS = String.raw`(function () {
  'use strict';

  var bootEl = document.getElementById('b2b-portal-boot');
  if (!bootEl) return;
  var boot;
  try {
    boot = JSON.parse(bootEl.textContent || '{}');
  } catch (e) {
    return;
  }
  var proxyBase =
    boot.proxy_base ||
    (window.location.pathname || '').replace(/\/+$/, '') ||
    '/apps/b2b/portal';

  var root = document.getElementById('b2b-portal-root');
  if (!root) return;

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatBytes(n) {
    if (n == null) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
    return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  }

  function api(path, init) {
    return fetch(proxyBase + '/api' + path, Object.assign({ credentials: 'same-origin' }, init || {}));
  }

  root.innerHTML =
    '<div id="b2b-tour" class="b2b-tour" hidden></div>' +
    '<nav id="b2b-tabs" class="b2b-tabs" role="tablist">' +
    '  <button type="button" data-tab="assets" class="active" role="tab">Assets</button>' +
    '  <button type="button" data-tab="profile" role="tab">Profile</button>' +
    '</nav>' +
    '<section id="b2b-panel-assets" class="b2b-panel" role="tabpanel"></section>' +
    '<section id="b2b-panel-profile" class="b2b-panel" role="tabpanel" hidden></section>';

  var profileLoaded = false;

  Array.prototype.forEach.call(root.querySelectorAll('#b2b-tabs button'), function (btn) {
    btn.addEventListener('click', function () {
      var tab = btn.getAttribute('data-tab');
      Array.prototype.forEach.call(root.querySelectorAll('#b2b-tabs button'), function (b) {
        if (b === btn) b.classList.add('active');
        else b.classList.remove('active');
      });
      Array.prototype.forEach.call(root.querySelectorAll('.b2b-panel'), function (p) {
        p.hidden = p.id !== 'b2b-panel-' + tab;
      });
      if (tab === 'profile' && !profileLoaded) loadProfile();
    });
  });

  function renderAssets(panel, assets) {
    if (!assets.length) {
      panel.innerHTML = '<p class="b2b-empty">No assets are available yet.</p>';
      return;
    }
    var html = '<ul class="b2b-asset-list">';
    for (var i = 0; i < assets.length; i++) {
      var a = assets[i];
      var meta = [];
      if (a.mime_type) meta.push(escapeHtml(a.mime_type));
      if (a.file_size_bytes != null) meta.push(formatBytes(a.file_size_bytes));
      var label = a.type === 'link' ? 'Open link' : 'Download';
      html +=
        '<li class="b2b-asset">' +
        '<div class="b2b-asset-title">' + escapeHtml(a.title) + '</div>' +
        (meta.length ? '<div class="b2b-asset-meta">' + meta.join(' · ') + '</div>' : '') +
        (a.description ? '<div class="b2b-asset-desc">' + escapeHtml(a.description) + '</div>' : '') +
        '<button type="button" class="b2b-download"' +
        ' data-id="' + escapeHtml(a.id) + '"' +
        ' data-type="' + escapeHtml(a.type) + '"' +
        ' data-url="' + escapeHtml(a.external_url || '') + '">' + label + '</button>' +
        '</li>';
    }
    html += '</ul>';
    panel.innerHTML = html;
    Array.prototype.forEach.call(panel.querySelectorAll('button.b2b-download'), function (btn) {
      btn.addEventListener('click', function () {
        download(btn.getAttribute('data-id'), btn.getAttribute('data-type'), btn.getAttribute('data-url'));
      });
    });
  }

  function loadAssets() {
    var panel = document.getElementById('b2b-panel-assets');
    panel.innerHTML = '<p class="b2b-loading">Loading assets…</p>';
    api('/assets/list')
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        renderAssets(panel, (data && data.assets) || []);
      })
      .catch(function () {
        panel.innerHTML = '<p class="b2b-error">Could not load assets. Please refresh.</p>';
      });
  }

  function triggerNavigationDownload(id) {
    // Real navigation via a hidden anchor so the browser honours
    // Content-Disposition: attachment on the streaming response. fetch()
    // can't do this — the bytes would just sit in JS memory.
    var href = proxyBase + '/api/assets/download/' + encodeURIComponent(id);
    var a = document.createElement('a');
    a.href = href;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function download(id, type, url) {
    if (type === 'link') {
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
      return;
    }
    // Probe first: same auth + visibility + budget checks as the streaming
    // endpoint, but returns JSON without touching R2 or recording the
    // download. Lets us show in-portal toasts for 403/429 instead of
    // dumping a JSON error page into a new tab.
    api('/assets/download/' + encodeURIComponent(id) + '/probe')
      .then(function (r) {
        if (r.status === 429) {
          window.alert('Monthly download limit reached. Please contact the store.');
          return null;
        }
        if (r.status === 403) {
          window.alert('You no longer have access to this file.');
          return null;
        }
        if (r.status === 404) {
          window.alert('This file is no longer available.');
          return null;
        }
        if (!r.ok) {
          window.alert('Download failed. Please try again.');
          return null;
        }
        return r.json();
      })
      .then(function (data) {
        if (!data) return;
        if (data.kind === 'link' && data.url) {
          window.open(data.url, '_blank', 'noopener,noreferrer');
        } else if (data.kind === 'stream_ready') {
          triggerNavigationDownload(id);
        } else {
          window.alert('Download failed. Please try again.');
        }
      })
      .catch(function () {
        window.alert('Download failed. Please try again.');
      });
  }

  function renderProfile(panel, data) {
    var html = '';
    if (data.tier) {
      var disc =
        data.tier.discount_type === 'percent'
          ? data.tier.discount_value + '% off'
          : data.tier.discount_value + ' off';
      html +=
        '<section class="b2b-tier">' +
        '<h2>Wholesale tier</h2>' +
        '<p><strong>' + escapeHtml(data.tier.name) + '</strong> — ' + escapeHtml(disc) + '</p>' +
        '</section>';
    } else {
      html += '<section class="b2b-tier"><h2>Wholesale tier</h2><p>No tier assigned.</p></section>';
    }
    if (data.company) {
      html += '<section class="b2b-company"><h2>' + escapeHtml(data.company.name) + '</h2>';
      if (data.company.locations && data.company.locations.length) {
        html += '<h3>Locations</h3><ul>';
        for (var i = 0; i < data.company.locations.length; i++) {
          var l = data.company.locations[i];
          html +=
            '<li>' + escapeHtml(l.name) + (l.tax_exempt ? ' — tax-exempt' : '') + '</li>';
        }
        html += '</ul>';
      }
      if (data.company.contacts && data.company.contacts.length) {
        html += '<h3>Team</h3><ul>';
        for (var j = 0; j < data.company.contacts.length; j++) {
          var c = data.company.contacts[j];
          html +=
            '<li>' +
            escapeHtml(c.name || c.email) +
            ' — ' +
            escapeHtml(c.email) +
            (c.is_main ? ' — main contact' : '') +
            '</li>';
        }
        html += '</ul>';
      }
      html += '</section>';
    } else {
      html += '<p>No company information available.</p>';
    }
    panel.innerHTML = html;
  }

  function loadProfile() {
    var panel = document.getElementById('b2b-panel-profile');
    panel.innerHTML = '<p class="b2b-loading">Loading profile…</p>';
    api('/profile')
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        renderProfile(panel, data || {});
        profileLoaded = true;
      })
      .catch(function () {
        panel.innerHTML = '<p class="b2b-error">Could not load profile.</p>';
      });
  }

  function loadTour() {
    api('/tour-status')
      .then(function (r) {
        if (!r.ok) return null;
        return r.json();
      })
      .then(function (data) {
        if (!data || !data.show_tour) return;
        var tour = document.getElementById('b2b-tour');
        var items = '';
        for (var i = 0; i < data.day1_features.length; i++) {
          var f = data.day1_features[i];
          items +=
            '<li><strong>' + escapeHtml(f.title) + '</strong> — ' + escapeHtml(f.description) + '</li>';
        }
        tour.innerHTML =
          '<div class="b2b-tour-inner">' +
          '<h3>Welcome to your dealer portal</h3>' +
          '<ul>' + items + '</ul>' +
          '<button type="button" id="b2b-tour-dismiss">Got it</button>' +
          '</div>';
        tour.hidden = false;
        document.getElementById('b2b-tour-dismiss').addEventListener('click', function () {
          tour.hidden = true;
          api('/tour-dismiss', { method: 'POST' }).catch(function () {});
        });
      })
      .catch(function () {});
  }

  loadAssets();
  loadTour();
})();
`;
