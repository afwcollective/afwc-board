/* AFWC draft upload — the CLOUDFLARE pipeline.
 *
 * The Express app uses public/js/upload.js: post the file, the server converts
 * it. This file is the Worker's replacement for BOTH that script AND the whole
 * of src/services/ingest/, because PORT-CLOUDFLARE.md §6 moves conversion here.
 * A Worker on the free plan has ~10 ms of CPU per request; mammoth on a chapter
 * is seconds. Your laptop has the seconds. So it does the work.
 *
 * views/drafts/new.ejs is SHARED between the two stacks and renders its scripts
 * from `pageJs`, which each router supplies. Nothing in the template knows which
 * app is serving it, and neither script touches the other's page.
 *
 * TWO FORMS, ONE SCRIPT. #upload-form (views/drafts/new.ejs) creates a draft;
 * #swap-form (views/drafts/edit.ejs) REPLACES THE FILE under one that already
 * exists. Steps 2–4 below are literally the same three routes in both cases —
 * worker/src/routes/drafts.js makes /pages, /finalize and /fail swap-aware on
 * the server side, writing to the staging tables while a swap is in flight — so
 * the only thing that differs is step 1's URL, and that is read off the form's
 * own action attribute. Nothing here knows which of the two it is running, and
 * a page never has both.
 *
 * ------------------------------------------------------------ THE PROTOCOL ---
 *
 *   1. POST <form action>            multipart, the ORIGINAL file(s) + metadata.
 *                                    /drafts for a new draft, /drafts/:id/file
 *                                    to replace one.
 *                                    → 201/202 { id }  (draft is 'processing')
 *   2. convert, right here, in this tab
 *   3. POST /drafts/:id/pages        JSON batches, ≤150 KB and ≤12 pages each.
 *                                    docx/text only — the server re-sanitizes
 *                                    every page before it stores it.
 *   4. POST /drafts/:id/finalize     { page_count, sizes? }. The server counts
 *                                    its own rows and only then flips 'ready'.
 *   ×. POST /drafts/:id/fail         { reason } if anything above throws. The
 *                                    reason is a KEY, not a sentence — the
 *                                    server owns what a member reads.
 *
 * Close the tab in the middle and the draft stays 'processing' and is swept,
 * exactly as an interrupted Express ingest was.
 *
 * -------------------------------------------------------- WHAT EACH KIND DOES
 *
 *   .docx   mammoth (vendored) → HTML with data: URI figures → clean → paginate
 *   .md     marked (vendored), gfm + breaks:false → clean → paginate
 *   .txt    the paragraph/verse heuristic from src/services/ingest/text.js
 *           → clean → paginate
 *   .pdf    pdf.js (already vendored for the reader) for numPages and each
 *           page's intrinsic size. Parse only, never render — same as Node did.
 *   images  createImageBitmap for width/height. The bytes and the ORDER are
 *           already the server's business; this only measures.
 *
 * Pagination is public/vendor/afwc/paginate.js — literally the same file
 * src/services/paginate.js requires in Node, so page boundaries cannot fork.
 *
 * ------------------------------------------------ WHAT cleanHtml() IS AND ISN'T
 *
 * cleanHtml() below is a CONVENIENCE, not a security boundary. Its only job is
 * to make the paginator see roughly what will end up stored, so a .docx full of
 * tables does not paginate on boundaries the server is about to delete. THE
 * TRUST BOUNDARY IS THE SERVER: worker/src/routes/drafts.js runs the real
 * sanitize-html allowlist over every page on the way in, and would do so
 * whether or not this function existed. Nothing here is relied upon by anything.
 */
(function () {
  'use strict';

  var form = document.getElementById('upload-form') || document.getElementById('swap-form');
  if (!form) return;

  var CSRF = form.getAttribute('data-csrf') || '';
  var MAX_BATCH_BYTES = 140 * 1024; // the server's cap is 150 KB; leave headroom
  var MAX_PAGES_PER_BATCH = 12;
  var MAX_PAGES = 2000;

  var modeInputs = Array.prototype.slice.call(form.querySelectorAll('input[name="mode"]'));
  var panels = Array.prototype.slice.call(form.querySelectorAll('[data-mode-panel]'));
  var fileList = form.querySelector('[data-file-list]');
  var imagesInput = form.querySelector('#images');
  var docInput = form.querySelector('#document');
  var submit = form.querySelector('[data-submit]');
  var progress = form.querySelector('[data-progress]');
  var progressBar = form.querySelector('[data-progress-bar]');
  var progressLabel = form.querySelector('[data-progress-label]');

  /* ---------------- the mode switch (unchanged from upload.js) ------------- */

  function currentMode() {
    var checked = modeInputs.filter(function (i) {
      return i.checked;
    })[0];
    return checked ? checked.value : 'document';
  }

  function syncMode() {
    var mode = currentMode();
    panels.forEach(function (panel) {
      var on = panel.getAttribute('data-mode-panel') === mode;
      panel.hidden = !on;
      // A disabled input is not submitted, which keeps the server's file map clean.
      Array.prototype.forEach.call(panel.querySelectorAll('input[type="file"]'), function (input) {
        input.disabled = !on;
      });
    });
  }

  modeInputs.forEach(function (input) {
    input.addEventListener('change', syncMode);
  });
  syncMode();

  function human(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  if (imagesInput && fileList) {
    imagesInput.addEventListener('change', function () {
      var picked = Array.prototype.slice.call(imagesInput.files || []);
      if (!picked.length) {
        fileList.hidden = true;
        fileList.innerHTML = '';
        return;
      }
      picked.sort(byFilename);
      var total = picked.reduce(function (sum, f) {
        return sum + f.size;
      }, 0);
      fileList.innerHTML =
        picked
          .map(function (f, i) {
            return (
              '<li><span class="fl-n mono">' +
              (i + 1) +
              '</span><span class="fl-name">' +
              f.name.replace(/[&<>"]/g, '') +
              '</span><span class="fl-size mono small">' +
              human(f.size) +
              '</span></li>'
            );
          })
          .join('') +
        '<li class="fl-total"><span class="fl-name">' +
        picked.length +
        ' pages, in this order</span><span class="fl-size mono small">' +
        human(total) +
        '</span></li>';
      fileList.hidden = false;
    });
  }

  /** The server sorts the parts with this comparator too — see attachments.js. */
  function byFilename(a, b) {
    return String(a.name).localeCompare(String(b.name), 'en', {
      numeric: true,
      sensitivity: 'base',
    });
  }

  /* ---------------- progress + errors ---------------- */

  function setProgress(pct, label) {
    if (progress) progress.hidden = false;
    if (progressBar) progressBar.style.width = Math.max(0, Math.min(100, pct)) + '%';
    if (progressLabel) progressLabel.textContent = label;
  }

  function resetProgress() {
    if (submit) submit.disabled = false;
    if (progress) progress.hidden = true;
    if (progressBar) progressBar.style.width = '0%';
  }

  function showErrors(messages) {
    var existing = document.querySelector('.form-errors[data-upload-errors]');
    if (existing) existing.remove();
    var box = document.createElement('div');
    box.className = 'form-errors';
    box.setAttribute('data-upload-errors', '');
    box.setAttribute('role', 'alert');
    box.innerHTML =
      '<p class="form-errors-head">That upload did not go through</p><ul>' +
      messages
        .map(function (m) {
          return '<li>' + String(m).replace(/[&<>]/g, '') + '</li>';
        })
        .join('') +
      '</ul>';
    form.parentNode.insertBefore(box, form);
    box.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  /* ---------------- lazy vendor loading ----------------
   * One <script> per library, only when the chosen file needs it, all from this
   * origin (the CSP is script-src 'self'). Nobody uploading a .txt downloads
   * 620 KB of .docx converter.
   */

  var loaded = Object.create(null);

  function loadScript(src) {
    if (loaded[src]) return loaded[src];
    loaded[src] = new Promise(function (resolve, reject) {
      var el = document.createElement('script');
      el.src = src;
      el.onload = function () {
        resolve();
      };
      el.onerror = function () {
        reject(new Error('could not load ' + src));
      };
      document.head.appendChild(el);
    });
    return loaded[src];
  }

  /* ---------------- the client-side clean (see the header) ---------------- */

  var ALLOWED_TAGS = {
    p: 1, em: 1, strong: 1, b: 1, i: 1, h1: 1, h2: 1, h3: 1,
    blockquote: 1, ul: 1, ol: 1, li: 1, br: 1, hr: 1, a: 1, img: 1,
    code: 1, pre: 1, sup: 1, sub: 1, u: 1, s: 1,
  };
  var ALLOWED_ATTRS = {
    a: { href: 1, title: 1 },
    img: { src: 1, alt: 1, width: 1, height: 1 },
    h1: { id: 1 },
    h2: { id: 1 },
    h3: { id: 1 },
  };
  var DROP_CONTENT = { script: 1, style: 1, textarea: 1, option: 1, noscript: 1 };

  function schemeOk(tag, value) {
    var v = String(value || '').trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(v)) {
      var scheme = v.slice(0, v.indexOf(':')).toLowerCase();
      if (tag === 'img') return scheme === 'data' || scheme === 'http' || scheme === 'https';
      return scheme === 'http' || scheme === 'https' || scheme === 'mailto';
    }
    return !/^\/\//.test(v); // no protocol-relative
  }

  function cleanNode(node, out) {
    for (var child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 3) {
        out.appendChild(child.cloneNode(false));
        continue;
      }
      if (child.nodeType !== 1) continue;
      var tag = child.tagName.toLowerCase();
      if (DROP_CONTENT[tag] === 1) continue;
      if (ALLOWED_TAGS[tag] !== 1) {
        // Not on the list: keep the children, lose the wrapper — sanitize-html's
        // default for a disallowed-but-not-text-dropping tag.
        cleanNode(child, out);
        continue;
      }
      var copy = document.createElement(tag);
      var allowed = ALLOWED_ATTRS[tag] || {};
      Array.prototype.forEach.call(child.attributes, function (attr) {
        var name = attr.name.toLowerCase();
        if (allowed[name] !== 1) return;
        if ((name === 'href' || name === 'src') && !schemeOk(tag, attr.value)) return;
        copy.setAttribute(name, attr.value);
      });
      if (tag === 'a') copy.setAttribute('rel', 'noopener noreferrer nofollow');
      cleanNode(child, copy);
      out.appendChild(copy);
    }
  }

  function cleanHtml(dirty) {
    var doc = new DOMParser().parseFromString(
      '<!doctype html><body>' + String(dirty == null ? '' : dirty),
      'text/html'
    );
    var out = doc.createElement('div');
    cleanNode(doc.body, out);
    return out.innerHTML;
  }

  /* ---------------- .txt → html (port of src/services/ingest/text.js) ------ */

  var WRAP_THRESHOLD = 55;

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function looksHardWrapped(lines) {
    if (lines.length < 2) return false;
    // The last line of a wrapped paragraph is short by definition; ignore it.
    var measured = lines.slice(0, -1);
    var average =
      measured.reduce(function (sum, l) {
        return sum + l.length;
      }, 0) / measured.length;
    return average >= WRAP_THRESHOLD;
  }

  function plainTextToHtml(raw) {
    return raw
      .replace(/\r\n?/g, '\n')
      .split(/\n{2,}/)
      .map(function (block) {
        return block
          .split('\n')
          .map(function (l) {
            return l.trim();
          })
          .filter(Boolean);
      })
      .filter(function (lines) {
        return lines.length;
      })
      .map(function (lines) {
        var joined = looksHardWrapped(lines)
          ? escapeHtml(lines.join(' '))
          : lines.map(escapeHtml).join('<br>');
        return '<p>' + joined + '</p>';
      })
      .join('\n');
  }

  /* ---------------- transport ---------------- */

  function postJson(url, payload) {
    return fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-CSRF-Token': CSRF,
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify(payload),
    }).then(function (r) {
      return r
        .json()
        .catch(function () {
          return {};
        })
        .then(function (json) {
          if (!r.ok || !json.ok) {
            throw new Error(json.error || 'The server refused that (' + r.status + ').');
          }
          return json;
        });
    });
  }

  /** Step 1 — XHR rather than fetch, purely for upload.progress. */
  function postOriginal(payload) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', form.getAttribute('action') || '/drafts', true);
      xhr.setRequestHeader('X-CSRF-Token', CSRF);
      xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
      xhr.setRequestHeader('Accept', 'application/json');

      xhr.upload.addEventListener('progress', function (evt) {
        if (!evt.lengthComputable) return;
        // The upload owns the first half of the bar; conversion owns the rest.
        setProgress(
          Math.round((evt.loaded / evt.total) * 50),
          'Uploading… ' + Math.round((evt.loaded / evt.total) * 100) + '%'
        );
      });

      xhr.addEventListener('load', function () {
        var json = null;
        try {
          json = JSON.parse(xhr.responseText);
        } catch (err) {
          /* fall through to the generic message */
        }
        if (xhr.status >= 200 && xhr.status < 300 && json && json.ok) return resolve(json);
        var err = new Error('upload refused');
        err.errors = (json && json.errors) || ['The server refused that upload. Please try again.'];
        reject(err);
      });
      xhr.addEventListener('error', function () {
        var err = new Error('connection dropped');
        err.errors = ['The connection dropped during the upload. Please try again.'];
        reject(err);
      });

      xhr.send(payload);
    });
  }

  /* ---------------- conversion ---------------- */

  function extOf(name) {
    var base = String(name || '').split(/[\\/]/).pop() || '';
    var dot = base.lastIndexOf('.');
    return dot <= 0 ? '' : base.slice(dot).toLowerCase();
  }

  function readText(file) {
    return file.text().then(function (raw) {
      return raw.replace(/^\uFEFF/, ''); // the BOM, spelled out
    });
  }

  function convertDocx(file) {
    return loadScript('/vendor/mammoth/mammoth.browser.min.js')
      .then(function () {
        return file.arrayBuffer();
      })
      .then(function (buf) {
        // mammoth's default image handler already emits data: URIs, which the
        // house sanitizer allows for <img>; naming it keeps the intent obvious.
        return window.mammoth.convertToHtml(
          { arrayBuffer: buf },
          { convertImage: window.mammoth.images.dataUri }
        );
      })
      .then(function (result) {
        return cleanHtml((result && result.value) || '');
      })
      .catch(function (err) {
        throw tagged(
          err,
          'docx',
          'We could not read that .docx — it may be corrupt, password-protected, or not really a Word file.'
        );
      });
  }

  function convertMarkdown(file) {
    return loadScript('/vendor/marked/marked.min.js')
      .then(function () {
        return readText(file);
      })
      .then(function (raw) {
        // Same options as src/services/ingest/text.js: CommonMark line handling,
        // deliberately NOT the breaks:true the comment box uses.
        return cleanHtml(window.marked.parse(raw, { async: false, gfm: true, breaks: false }));
      })
      .catch(function (err) {
        throw tagged(err, 'text', null);
      });
  }

  function convertPlainText(file) {
    return readText(file)
      .then(function (raw) {
        return cleanHtml(plainTextToHtml(raw));
      })
      .catch(function (err) {
        throw tagged(err, 'text', null);
      });
  }

  /** PDFs: parse only, never render — numPages plus each page's intrinsic size. */
  function measurePdf(file) {
    return file
      .arrayBuffer()
      .then(function (buf) {
        return import('/vendor/pdfjs/pdf.min.mjs').then(function (pdfjsLib) {
          pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
          return pdfjsLib.getDocument({
            data: new Uint8Array(buf),
            isEvalSupported: false,
            standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
          }).promise;
        });
      })
      .then(function (doc) {
        var total = doc.numPages;
        if (!total) throw tagged(new Error('no pages'), 'empty', null);
        if (total > MAX_PAGES) throw tagged(new Error('too many pages'), 'pdf', null);
        var sizes = [];
        var chain = Promise.resolve();
        var _loop = function (n) {
          chain = chain.then(function () {
            return doc
              .getPage(n)
              .then(function (page) {
                var vp = page.getViewport({ scale: 1 });
                sizes.push([Math.round(vp.width), Math.round(vp.height)]);
                page.cleanup();
              })
              .catch(function () {
                // a page we cannot measure still gets a row; the viewer falls back
                sizes.push([null, null]);
              });
          });
        };
        for (var n = 1; n <= total; n += 1) _loop(n);
        return chain.then(function () {
          doc.destroy();
          setProgress(85, 'Read ' + total + ' pages…');
          return { page_count: total, sizes: sizes };
        });
      })
      .catch(function (err) {
        if (err && err.afwcReason) throw err;
        var encrypted = err && (err.name === 'PasswordException' || /password/i.test(err.message || ''));
        throw tagged(err, encrypted ? 'encrypted' : 'pdf', null);
      });
  }

  function measureImages(picked) {
    var sizes = [];
    var chain = Promise.resolve();
    picked.forEach(function (file) {
      chain = chain.then(function () {
        if (typeof createImageBitmap !== 'function') {
          sizes.push([null, null]);
          return undefined;
        }
        return createImageBitmap(file)
          .then(function (bmp) {
            sizes.push([bmp.width, bmp.height]);
            if (bmp.close) bmp.close();
          })
          .catch(function () {
            // unreadable dimensions are survivable — the <img> still renders
            sizes.push([null, null]);
          });
      });
    });
    return chain.then(function () {
      return { page_count: picked.length, sizes: sizes };
    });
  }

  function tagged(err, reason, message) {
    var out = err instanceof Error ? err : new Error(String(err));
    out.afwcReason = reason;
    if (message) out.afwcMessage = message;
    return out;
  }

  /* ---------------- posting the pages ---------------- */

  function sendPages(draftId, pages) {
    var batches = [];
    var current = [];
    var bytes = 0;

    pages.forEach(function (page) {
      var size = (page.content_html || '').length + (page.heading || '').length + 64;
      if (current.length && (bytes + size > MAX_BATCH_BYTES || current.length >= MAX_PAGES_PER_BATCH)) {
        batches.push(current);
        current = [];
        bytes = 0;
      }
      current.push(page);
      bytes += size;
    });
    if (current.length) batches.push(current);

    var done = 0;
    return batches
      .reduce(function (chain, batch) {
        return chain.then(function () {
          return postJson('/drafts/' + draftId + '/pages', { pages: batch }).then(function () {
            done += batch.length;
            setProgress(60 + Math.round((done / pages.length) * 35), 'Saving pages… ' + done + '/' + pages.length);
          });
        });
      }, Promise.resolve())
      .then(function () {
        return pages.length;
      });
  }

  /* ---------------- the run ---------------- */

  function run(mode) {
    var payload = new FormData(form);
    var picked = mode === 'images' ? Array.prototype.slice.call(imagesInput.files).sort(byFilename) : null;
    var file = mode === 'document' ? docInput.files[0] : null;
    var ext = file ? extOf(file.name) : '';

    if (submit) submit.disabled = true;
    setProgress(1, 'Uploading…');

    var draftId = null;

    return postOriginal(payload)
      .then(function (json) {
        draftId = json.id;
        setProgress(55, 'Converting…');

        if (mode === 'images') return measureImages(picked);
        if (ext === '.pdf') return measurePdf(file);

        var html;
        if (ext === '.docx') html = convertDocx(file);
        else if (ext === '.md' || ext === '.markdown') html = convertMarkdown(file);
        else html = convertPlainText(file);

        return html.then(function (clean) {
          var pages;
          try {
            pages = window.AFWCPaginate.paginateHtml(clean);
          } catch (err) {
            throw tagged(err, 'empty', null);
          }
          if (pages.length > MAX_PAGES) throw tagged(new Error('too many pages'), 'empty', null);
          return sendPages(draftId, pages).then(function (count) {
            return { page_count: count, sizes: null };
          });
        });
      })
      .then(function (result) {
        setProgress(96, 'Finishing…');
        return postJson('/drafts/' + draftId + '/finalize', {
          page_count: result.page_count,
          sizes: result.sizes,
        });
      })
      .then(function (json) {
        setProgress(100, 'Ready.');
        window.location.href = json.redirect || '/drafts/' + draftId;
      })
      .catch(function (err) {
        // Before the draft row exists there is nothing to mark; just complain.
        if (!draftId) {
          resetProgress();
          showErrors(err.errors || [err.message || 'That upload did not go through.']);
          return undefined;
        }
        /*
         * After it exists, the draft has to STOP being 'processing' — otherwise
         * the reader spins until the sweep catches it ten minutes later. The
         * reason is a key; the server picks the sentence a member reads.
         */
        return postJson('/drafts/' + draftId + '/fail', { reason: err.afwcReason || 'interrupted' })
          .catch(function () {
            return { redirect: '/drafts/' + draftId };
          })
          .then(function (json) {
            window.location.href = (json && json.redirect) || '/drafts/' + draftId;
          });
      });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();

    var mode = currentMode();
    if (mode === 'document' && docInput && !docInput.files.length) {
      showErrors(['Choose a document file first.']);
      return;
    }
    if (mode === 'images' && imagesInput && !imagesInput.files.length) {
      showErrors(['Choose the page images first.']);
      return;
    }
    if (!window.AFWCPaginate) {
      showErrors(['The uploader did not load completely. Reload the page and try again.']);
      return;
    }

    run(mode);
  });
})();
