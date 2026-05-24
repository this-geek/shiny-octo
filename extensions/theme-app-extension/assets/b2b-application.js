// b2b-application.js — buyer wholesale application form (Phase 1E).
//
// Renders the merchant-configured form (fetched from the App Proxy), saves
// drafts on field blur via signed resume tokens (14-day TTL), and submits
// with the Turnstile token when configured. Document uploads run through
// the same multipart helpers as the asset portal so the same R2 plumbing
// covers both flows.

(function () {
  'use strict';

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function buildField(field, values) {
    var value = values[field.id] != null ? values[field.id] : '';
    var common =
      'id="b2b-field-' + escapeHtml(field.id) + '"' +
      ' name="' + escapeHtml(field.id) + '"' +
      (field.required ? ' required' : '');
    var labelHtml = '<label for="b2b-field-' + escapeHtml(field.id) + '">' +
      escapeHtml(field.label) + (field.required ? ' *' : '') + '</label>';
    var control;
    if (field.type === 'textarea') {
      control = '<textarea ' + common + '>' + escapeHtml(value) + '</textarea>';
    } else if (field.type === 'select') {
      var opts = (field.options || [])
        .map(function (o) {
          return '<option value="' + escapeHtml(o) + '"' +
            (o === value ? ' selected' : '') + '>' + escapeHtml(o) + '</option>';
        })
        .join('');
      control =
        '<select ' + common + '>' +
        '<option value="">— choose —</option>' + opts + '</select>';
    } else if (field.type === 'file') {
      control = '<input type="file" ' + common + ' />';
    } else {
      control =
        '<input type="' + escapeHtml(field.type) + '"' +
        ' ' + common + ' value="' + escapeHtml(value) + '" />';
    }
    return '<div class="b2b-app__row">' + labelHtml + control + '</div>';
  }

  function init(block) {
    var appProxyPath = block.getAttribute('data-app-proxy-path') || 'apps/b2b';
    var base = '/' + appProxyPath.replace(/^\/+/, '');
    var root = block.querySelector('.b2b-app__form-root');
    if (!root) return;

    var config = null;
    var resumeToken = null;
    var values = { fields: {}, documents: [] };
    var autosaveTimer = null;

    function setAutosaveMsg(msg) {
      var el = block.querySelector('.b2b-app__autosave');
      if (el) el.textContent = msg;
    }

    function readForm() {
      var fields = {};
      (config.fields || []).forEach(function (f) {
        if (f.type === 'file') return;
        var el = root.querySelector('#b2b-field-' + f.id);
        if (el) fields[f.id] = el.value;
      });
      var email = (root.querySelector('#b2b-app-email') || {}).value || '';
      var country = (root.querySelector('#b2b-app-country') || {}).value || '';
      var taxId = (root.querySelector('#b2b-app-taxid') || {}).value || '';
      var gst = (root.querySelector('#b2b-app-gst') || {}).value || '';
      var companyName = (root.querySelector('#b2b-app-companyname') || {}).value || '';
      return {
        email: email,
        countryCode: country,
        taxId: taxId,
        gstNumber: gst || undefined,
        companyName: companyName,
        fields: fields,
        documents: values.documents,
      };
    }

    function autosave() {
      var form = readForm();
      var emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email);
      if (!resumeToken && !emailValid) return; // can't open a draft without an email
      var body = { form: form };
      if (resumeToken) body.resume_token = resumeToken;
      else body.email = form.email;
      setAutosaveMsg('Saving…');
      fetch(base + '/application/autosave', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(function (j) {
          resumeToken = j.resume_token;
          setAutosaveMsg('Saved.');
        })
        .catch(function () {
          setAutosaveMsg('Could not save. Will retry on the next change.');
        });
    }

    function scheduleAutosave() {
      if (autosaveTimer) clearTimeout(autosaveTimer);
      autosaveTimer = setTimeout(autosave, 600);
    }

    function attachAutosave() {
      root.querySelectorAll('input, select, textarea').forEach(function (el) {
        el.addEventListener('blur', scheduleAutosave);
      });
    }

    function renderForm() {
      var fieldsHtml = (config.fields || []).map(function (f) {
        return buildField(f, values.fields);
      }).join('');

      var countriesHtml = (config.taxIdCountries || []).map(function (c) {
        return '<option value="' + escapeHtml(c) + '"' +
          (values.countryCode === c ? ' selected' : '') + '>' +
          escapeHtml(c.toUpperCase()) + '</option>';
      }).join('');

      var docHtml = config.requireDocuments
        ? '<div class="b2b-app__row">' +
            '<label>Supporting documents</label>' +
            '<input type="file" id="b2b-app-doc" />' +
            '<ul class="b2b-app__doclist">' +
              values.documents.map(function (d) {
                return '<li>✓ ' + escapeHtml(d.name) + '</li>';
              }).join('') +
            '</ul>' +
          '</div>'
        : '';

      var captchaHtml = config.turnstile && config.turnstile.enabled
        ? '<div class="cf-turnstile" data-sitekey="' + escapeHtml(config.turnstile.siteKey) + '"></div>'
        : '';

      root.innerHTML =
        '<form class="b2b-app__form" autocomplete="on">' +
          '<div class="b2b-app__row">' +
            '<label for="b2b-app-email">Email *</label>' +
            '<input type="email" id="b2b-app-email" required value="' + escapeHtml(values.email || '') + '" />' +
          '</div>' +
          '<div class="b2b-app__row">' +
            '<label for="b2b-app-companyname">Business name *</label>' +
            '<input type="text" id="b2b-app-companyname" required value="' + escapeHtml(values.companyName || '') + '" />' +
          '</div>' +
          '<div class="b2b-app__row">' +
            '<label for="b2b-app-country">Country</label>' +
            '<select id="b2b-app-country">' +
              '<option value="">—</option>' + countriesHtml +
            '</select>' +
          '</div>' +
          '<div class="b2b-app__row">' +
            '<label for="b2b-app-taxid">Tax ID</label>' +
            '<input type="text" id="b2b-app-taxid" value="' + escapeHtml(values.taxId || '') + '" />' +
          '</div>' +
          '<div class="b2b-app__row">' +
            '<label for="b2b-app-gst">GST number (optional)</label>' +
            '<input type="text" id="b2b-app-gst" value="' + escapeHtml(values.gstNumber || '') + '" />' +
          '</div>' +
          fieldsHtml +
          docHtml +
          captchaHtml +
          '<div class="b2b-app__autosave"></div>' +
          '<div class="b2b-app__error"></div>' +
          '<button type="submit" class="b2b-app__submit">Submit application</button>' +
        '</form>';

      attachAutosave();

      var docInput = root.querySelector('#b2b-app-doc');
      if (docInput) docInput.addEventListener('change', uploadDocument);

      root.querySelector('form').addEventListener('submit', onSubmit);
    }

    function uploadDocument(e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      if (!resumeToken) {
        setAutosaveMsg('Please fill in your email first so we can save a draft.');
        return;
      }
      e.target.disabled = true;
      var sessionData = null;
      fetch(base + '/application/document-upload', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resume_token: resumeToken,
          filename: file.name,
          mime_type: file.type || 'application/octet-stream',
          total_size_bytes: file.size,
        }),
      })
        .then(function (res) {
          if (!res.ok) throw new Error('start HTTP ' + res.status);
          return res.json();
        })
        .then(function (start) {
          sessionData = start;
          var partSize = Math.max(5 * 1024 * 1024, start.recommended_part_size || 64 * 1024 * 1024);
          var totalParts = Math.ceil(file.size / partSize);
          var parts = [];
          function uploadPart(i) {
            if (i >= totalParts) return Promise.resolve(parts);
            var slice = file.slice(i * partSize, Math.min(file.size, (i + 1) * partSize));
            return fetch(
              base + '/application/document-upload/' + start.session_id + '/parts/' + (i + 1),
              { method: 'PUT', body: slice, credentials: 'same-origin' },
            )
              .then(function (r) {
                if (!r.ok) throw new Error('part ' + (i + 1) + ' HTTP ' + r.status);
                return r.json();
              })
              .then(function (p) {
                parts.push(p);
                return uploadPart(i + 1);
              });
          }
          return uploadPart(0);
        })
        .then(function (parts) {
          return fetch(
            base + '/application/document-upload/' + sessionData.session_id + '/complete',
            {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ parts: parts }),
            },
          ).then(function (r) {
            if (!r.ok) throw new Error('complete HTTP ' + r.status);
            return r.json();
          });
        })
        .then(function (completed) {
          values.documents.push({
            name: file.name,
            r2_key: completed.key,
            size: completed.total_size_bytes,
            mime: completed.mime_type,
          });
          autosave();
          var list = root.querySelector('.b2b-app__doclist');
          if (list) {
            var li = document.createElement('li');
            li.textContent = '✓ ' + file.name;
            list.appendChild(li);
          }
        })
        .catch(function (err) {
          setAutosaveMsg('Upload failed: ' + err.message);
        })
        .finally(function () {
          e.target.disabled = false;
          e.target.value = '';
        });
    }

    function onSubmit(e) {
      e.preventDefault();
      var btn = root.querySelector('.b2b-app__submit');
      var errEl = root.querySelector('.b2b-app__error');
      errEl.textContent = '';
      btn.disabled = true;

      var form = readForm();
      var body = { form: form };
      if (resumeToken) body.resume_token = resumeToken;
      else body.email = form.email;

      if (config.turnstile && config.turnstile.enabled && window.turnstile) {
        var widget = root.querySelector('.cf-turnstile');
        var tsResp = widget ? widget.querySelector('input[name="cf-turnstile-response"]') : null;
        body.cf_turnstile_response = tsResp ? tsResp.value : null;
      }

      fetch(base + '/application/submit', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then(function (res) {
          return res.json().then(function (j) { return { ok: res.ok, json: j }; });
        })
        .then(function (r) {
          if (!r.ok) throw new Error(r.json.error || 'submit failed');
          root.innerHTML =
            '<div class="b2b-app__success">' +
              '<strong>Application received.</strong>' +
              '<p>Reference: <code>' + escapeHtml(r.json.reference) + '</code></p>' +
              '<p>We will email you when there is an update.</p>' +
            '</div>';
        })
        .catch(function (err) {
          errEl.textContent = err.message;
          btn.disabled = false;
        });
    }

    fetch(base + '/application/form-config', { credentials: 'same-origin' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (j) {
        config = j;
        renderForm();
      })
      .catch(function () {
        root.innerHTML =
          '<p class="b2b-app__error">Could not load the application form. ' +
          'Please refresh or contact us.</p>';
      });
  }

  document.querySelectorAll('[data-b2b-application-block]').forEach(init);
})();
