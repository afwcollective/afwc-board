'use strict';
/*
 * Confirm-before-submit, CSP edition.
 *
 * script-src 'self' silently ignores inline onsubmit="return confirm(...)"
 * handlers, so any form that wants a confirmation carries a data-confirm
 * attribute instead and this one capturing listener does the asking.
 * Loaded from layout.ejs on every page.
 */
document.addEventListener('submit', function (e) {
  var form = e.target && e.target.closest ? e.target.closest('form[data-confirm]') : null;
  if (form && !window.confirm(form.getAttribute('data-confirm'))) {
    e.preventDefault();
    e.stopPropagation();
  }
}, true);
