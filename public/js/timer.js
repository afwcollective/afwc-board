/* AFWC writing-sprint timer — full page (/timer).
 *
 * Renders from window.AFWCTimer (public/js/timer-core.js, loaded before this
 * file — see the widget partial included in layout.ejs). No timing logic
 * lives here: this file only reflects core snapshots into the DOM and turns
 * clicks/keys into core calls.
 *
 * Debugging: window.AFWCTimer.__debug.jump(seconds) fast-forwards (or, with
 * a negative number, rewinds) the active phase without waiting in real time.
 */
(function () {
  'use strict';

  var Core = window.AFWCTimer;
  var root = document.querySelector('[data-timer]');
  if (!root || !Core) return;

  var chooserEl = root.querySelector('[data-chooser]');
  var activeEl = root.querySelector('[data-active]');
  var bannerEl = root.querySelector('[data-banner]');

  var clockEl = root.querySelector('[data-clock]');
  var phaseEl = root.querySelector('[data-phase]');
  var progressFill = root.querySelector('[data-progress-fill]');

  var startPauseBtn = root.querySelector('[data-start-pause]');
  var trimBtn = root.querySelector('[data-trim]');
  var extendBtns = Array.prototype.slice.call(root.querySelectorAll('[data-extend]'));
  var resetBtn = root.querySelector('[data-reset]');

  var modeStartBtns = Array.prototype.slice.call(root.querySelectorAll('[data-start-mode]'));
  var modeDurationEls = {
    sprint: root.querySelector('[data-mode-duration="sprint"]'),
    break: root.querySelector('[data-mode-duration="break"]'),
  };
  var modeGroups = {
    sprint: root.querySelector('[data-mode-group="sprint"]'),
    break: root.querySelector('[data-mode-group="break"]'),
  };
  var presetBtns = Array.prototype.slice.call(root.querySelectorAll('[data-preset-mode]'));
  var customInputs = Array.prototype.slice.call(root.querySelectorAll('[data-custom-mode]'));

  var autoToggle = root.querySelector('[data-auto-toggle]');
  var autoPanel = root.querySelector('[data-auto-panel]');
  var autoStartBtns = Array.prototype.slice.call(root.querySelectorAll('[data-auto-start]'));

  var soundToggle = document.querySelector('[data-sound-toggle]');
  var soundLabel = document.querySelector('[data-sound-label]');
  var notifyToggle = document.querySelector('[data-notify-toggle]');
  var notifyLabel = document.querySelector('[data-notify-label]');
  var notifyHint = document.querySelector('[data-notify-hint]');

  var flashEl = document.querySelector('[data-flash]');
  var flashTextEl = document.querySelector('[data-flash-text]');
  var flashTimer = null;

  var originalTitle = document.title;
  var lastSnap = null;

  function notifySupported() {
    return typeof Notification !== 'undefined';
  }

  function updatePresetPressed(mode, minutes) {
    presetBtns.forEach(function (btn) {
      if (btn.getAttribute('data-preset-mode') !== mode) return;
      var pressed = Number(btn.getAttribute('data-preset-value')) === minutes;
      btn.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    });
  }

  function render(snap) {
    lastSnap = snap;
    root.setAttribute('data-status', snap.status);
    root.setAttribute('data-mode', snap.mode);

    var showActive = snap.status === 'running' || snap.status === 'paused';
    activeEl.hidden = !showActive;
    chooserEl.hidden = showActive;

    if (showActive) {
      clockEl.textContent = Core.formatClock(snap.remainingMs);
      phaseEl.textContent = Core.phaseLabel(snap);
      progressFill.style.width = snap.pct + '%';
      startPauseBtn.textContent = snap.status === 'running' ? 'Pause' : 'Resume';
      document.title = Core.formatClock(snap.remainingMs) + ' · ' + Core.titleTag(snap) + ' — AFWC';
    } else {
      document.title = originalTitle;
      var banner = Core.doneBanner(snap);
      if (banner) {
        bannerEl.hidden = false;
        bannerEl.textContent = banner;
      } else {
        bannerEl.hidden = true;
      }
      if (modeDurationEls.sprint) modeDurationEls.sprint.textContent = Core.formatClock(snap.manualDefaults.sprint * 60000);
      if (modeDurationEls.break) modeDurationEls.break.textContent = Core.formatClock(snap.manualDefaults.break * 60000);
      updatePresetPressed('sprint', snap.manualDefaults.sprint);
      updatePresetPressed('break', snap.manualDefaults.break);
      if (modeGroups.sprint) modeGroups.sprint.classList.toggle('is-suggested', snap.doneMode === 'break');
      if (modeGroups.break) modeGroups.break.classList.toggle('is-suggested', snap.doneMode === 'sprint');
    }

    soundToggle.setAttribute('aria-pressed', snap.soundOn ? 'true' : 'false');
    if (soundLabel) soundLabel.textContent = snap.soundOn ? 'Sound on' : 'Sound off';

    var blocked = notifySupported() && Notification.permission === 'denied';
    notifyToggle.disabled = !notifySupported();
    notifyToggle.setAttribute('aria-pressed', snap.notifyOn ? 'true' : 'false');
    if (notifyLabel) notifyLabel.textContent = snap.notifyOn ? 'Notifications on' : 'Notifications off';
    if (notifyHint) notifyHint.hidden = !(blocked || !notifySupported());
  }

  function showFlash(text) {
    if (!text || !flashEl) return;
    flashTextEl.textContent = text;
    flashEl.classList.add('is-active');
    window.clearTimeout(flashTimer);
    flashTimer = window.setTimeout(function () {
      flashEl.classList.remove('is-active');
    }, 1500);
  }

  Core.onTransition(function (info) {
    if (Core.isHiddenNow()) return; // a system notification covers the hidden case
    var text = info.isSessionComplete
      ? 'SESSION COMPLETE'
      : info.nextMode
        ? Core.bigLabel(info.nextMode)
        : info.endedMode
          ? Core.bigLabel(info.endedMode) + ' DONE'
          : '';
    showFlash(text);
  });

  /* ---------------- wire up ---------------- */

  modeStartBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      Core.warmAudio();
      Core.startManual(btn.getAttribute('data-start-mode'));
    });
  });

  presetBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var mode = btn.getAttribute('data-preset-mode');
      var value = Number(btn.getAttribute('data-preset-value'));
      if (value) Core.setManualDuration(mode, value);
    });
  });

  customInputs.forEach(function (input) {
    var mode = input.getAttribute('data-custom-mode');
    function commit() {
      var value = Number(input.value);
      if (value > 0) {
        Core.setManualDuration(mode, value);
        input.value = '';
      }
    }
    input.addEventListener('change', commit);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      }
    });
  });

  if (autoToggle && autoPanel) {
    autoToggle.addEventListener('click', function () {
      var expanded = autoToggle.getAttribute('aria-expanded') === 'true';
      autoToggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
      autoPanel.hidden = expanded;
    });
  }

  autoStartBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      Core.warmAudio();
      Core.startAuto(Number(btn.getAttribute('data-auto-start')));
    });
  });

  startPauseBtn.addEventListener('click', function () {
    Core.warmAudio();
    if (!lastSnap) return;
    if (lastSnap.status === 'running') Core.pause();
    else if (lastSnap.status === 'paused') Core.resume();
  });

  extendBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var minutes = Number(btn.getAttribute('data-extend'));
      Core.extend(minutes * 60000);
    });
  });

  trimBtn.addEventListener('click', function () {
    Core.trim(60000);
  });

  resetBtn.addEventListener('click', function () {
    Core.reset();
  });

  soundToggle.addEventListener('click', function () {
    Core.warmAudio();
    Core.setSound(!(lastSnap && lastSnap.soundOn));
  });

  notifyToggle.addEventListener('click', function () {
    Core.setNotify(!(lastSnap && lastSnap.notifyOn));
  });

  document.addEventListener('keydown', function (e) {
    var el = document.activeElement;
    var tag = el ? el.tagName : '';
    var typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el && el.isContentEditable);
    if (typing) return;

    if (e.code === 'Space' || e.key === ' ') {
      if (!lastSnap || (lastSnap.status !== 'running' && lastSnap.status !== 'paused')) return;
      e.preventDefault();
      Core.warmAudio();
      if (lastSnap.status === 'running') Core.pause();
      else Core.resume();
    } else if (e.key === 'r' || e.key === 'R') {
      Core.reset();
    }
  });

  Core.subscribe(render);
})();
