/* AFWC Board — floor-map marker picker (admin meeting form).
 *
 * Turns a click anywhere on views/partials/floormap.ejs into a pair of
 * percentages of the SVG viewBox, writes them into the hidden #map_x / #map_y
 * inputs, and moves the red marker live. Percentages (not user units) are what
 * the meetings table stores, so the drawing can change later without stranding
 * saved markers.
 *
 * No dependencies, no build step. Loaded via pageJs from admin/meeting-form.ejs.
 */
(function () {
  'use strict';

  var VIEW_W = 1000;
  var VIEW_H = 600;

  var svg = document.getElementById('floormap-svg');
  var inputX = document.getElementById('map_x');
  var inputY = document.getElementById('map_y');
  var marker = document.getElementById('fm-marker');
  var readout = document.getElementById('map-readout-value');
  var clearBtn = document.getElementById('map-clear');

  if (!svg || !inputX || !inputY || !marker) return;

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  function place(pctX, pctY) {
    marker.setAttribute('transform', 'translate(' + (pctX / 100) * VIEW_W + ', ' + (pctY / 100) * VIEW_H + ')');
    marker.style.display = '';
    inputX.value = String(pctX);
    inputY.value = String(pctY);
    if (readout) readout.textContent = pctX + '% / ' + pctY + '%';
  }

  function clear() {
    marker.style.display = 'none';
    inputX.value = '';
    inputY.value = '';
    if (readout) readout.textContent = 'not placed';
  }

  /* Percentages come straight off the rendered box: the SVG keeps its viewBox
     aspect ratio (preserveAspectRatio defaults to "xMidYMid meet" and the CSS
     gives it width:100%; height:auto), so box percent === viewBox percent. */
  function fromEvent(evt) {
    var rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    var x = ((evt.clientX - rect.left) / rect.width) * 100;
    var y = ((evt.clientY - rect.top) / rect.height) * 100;
    return {
      x: round2(Math.min(100, Math.max(0, x))),
      y: round2(Math.min(100, Math.max(0, y)))
    };
  }

  svg.addEventListener('click', function (evt) {
    var p = fromEvent(evt);
    if (p) place(p.x, p.y);
  });

  // Keyboard: focus the map, then nudge with the arrows (1% steps, 5% with shift).
  svg.addEventListener('keydown', function (evt) {
    var keys = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    var delta = keys[evt.key];
    if (!delta) return;
    evt.preventDefault();
    var step = evt.shiftKey ? 5 : 1;
    var cx = inputX.value === '' ? 50 : Number(inputX.value);
    var cy = inputY.value === '' ? 50 : Number(inputY.value);
    place(
      round2(Math.min(100, Math.max(0, cx + delta[0] * step))),
      round2(Math.min(100, Math.max(0, cy + delta[1] * step)))
    );
  });

  if (clearBtn) clearBtn.addEventListener('click', clear);
})();
