/* members.js — two small manners for /admin/members. Progressive enhancement
   only: every form on that page works with this file blocked or absent.

   1. data-confirm="…" on a <form> asks before submitting. The site's CSP is
      script-src 'self' with no 'unsafe-inline', so an onsubmit="" attribute is
      refused by the browser — confirmations have to be bound from a file.
   2. The promote form's "Until date…" date box is hidden until it is the
      chosen term, and only then required. With JS off it simply stays visible.
*/
(function () {
  'use strict';

  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!form || !form.getAttribute) return;
    var message = form.getAttribute('data-confirm');
    if (message && !window.confirm(message)) event.preventDefault();
  });

  function syncTerm(select) {
    var form = select.form;
    if (!form) return;
    var date = form.querySelector('[data-term-date]');
    if (!date) return;
    var wanted = select.value === 'until';
    date.hidden = !wanted;
    date.required = wanted;
    if (!wanted) date.value = '';
  }

  var selects = document.querySelectorAll('[data-term-select]');
  Array.prototype.forEach.call(selects, function (select) {
    syncTerm(select);
    select.addEventListener('change', function () {
      syncTerm(select);
    });
  });
})();
