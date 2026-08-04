/* AFWC sprint timer — floating widget (every leader page except /timer).
 *
 * Same core (window.AFWCTimer, public/js/timer-core.js) as the full page in
 * timer.js — this file only renders the compact chip + panel and forwards
 * clicks into the shared engine, so pausing here pauses everywhere and vice
 * versa.
 *
 * The chip is suppressed on /timer itself: the full page already shows the
 * same controls, so a second copy floating on top would just be clutter.
 * The <script> tags that load this file are still present on /timer (they
 * live in the widget partial, included on every page), so the early return
 * below is what actually hides it there.
 */
(function () {
  'use strict';

  var Core = window.AFWCTimer;
  var root = document.querySelector('[data-timer-widget]');
  var flashEl = document.querySelector('[data-widget-flash]');
  if (!root || !Core) return;

  if (location.pathname === '/timer' || location.pathname.indexOf('/timer/') === 0) {
    root.style.display = 'none';
    if (flashEl) flashEl.style.display = 'none';
    return;
  }

  var chip = root.querySelector('[data-widget-chip]');
  var chipLabel = root.querySelector('[data-widget-chip-label]');
  var panel = root.querySelector('[data-widget-panel]');
  var closeBtn = root.querySelector('[data-widget-close]');
  var titleEl = root.querySelector('[data-widget-title]');

  var chooserEl = root.querySelector('[data-widget-chooser]');
  var activeEl = root.querySelector('[data-widget-active]');
  var bannerEl = root.querySelector('[data-widget-banner]');

  var clockEl = root.querySelector('[data-widget-clock]');
  var phaseEl = root.querySelector('[data-widget-phase]');
  var progressFill = root.querySelector('[data-widget-progress-fill]');

  var startPauseBtn = root.querySelector('[data-widget-start-pause]');
  var trimBtn = root.querySelector('[data-widget-trim]');
  var extendBtns = Array.prototype.slice.call(root.querySelectorAll('[data-widget-extend]'));
  var resetBtn = root.querySelector('[data-widget-reset]');

  var modeStartBtns = Array.prototype.slice.call(root.querySelectorAll('[data-widget-start-mode]'));
  var modeDurationEls = {
    sprint: root.querySelector('[data-widget-mode-duration="sprint"]'),
    break: root.querySelector('[data-widget-mode-duration="break"]'),
  };
  var modeGroups = {
    sprint: root.querySelector('[data-widget-mode-group="sprint"]'),
    break: root.querySelector('[data-widget-mode-group="break"]'),
  };
  var presetBtns = Array.prototype.slice.call(root.querySelectorAll('[data-widget-preset-mode]'));
  var customInput = root.querySelector('[data-widget-custom]');
  var customTarget = root.querySelector('[data-widget-custom-target]');

  var autoToggle = root.querySelector('[data-widget-auto-toggle]');
  var autoPanel = root.querySelector('[data-widget-auto-panel]');
  var autoStartBtns = Array.prototype.slice.call(root.querySelectorAll('[data-widget-auto-start]'));

  var soundToggle = root.querySelector('[data-widget-sound-toggle]');
  var soundLabel = root.querySelector('[data-widget-sound-label]');
  var notifyToggle = root.querySelector('[data-widget-notify-toggle]');
  var notifyLabel = root.querySelector('[data-widget-notify-label]');
  var notifyHint = root.querySelector('[data-widget-notify-hint]');

  var flashTextEl = document.querySelector('[data-widget-flash-text]');
  var flashTimer = null;

  var lastSnap = null;
  var panelOpen = false;

  function notifySupported() {
    return typeof Notification !== 'undefined';
  }

  function setPanelOpen(open) {
    panelOpen = open;
    panel.hidden = !open;
    chip.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      var focusTarget = chooserEl.hidden ? startPauseBtn : (modeStartBtns[0] || closeBtn);
      if (focusTarget) focusTarget.focus();
    }
  }

  function updatePresetPressed(mode, minutes) {
    presetBtns.forEach(function (btn) {
      if (btn.getAttribute('data-widget-preset-mode') !== mode) return;
      var pressed = Number(btn.getAttribute('data-widget-preset-value')) === minutes;
      btn.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    });
  }

  function render(snap) {
    lastSnap = snap;
    var showActive = snap.status === 'running' || snap.status === 'paused';

    chip.setAttribute('data-status', snap.status);
    if (showActive) {
      chipLabel.textContent = Core.formatClock(snap.remainingMs);
    } else {
      chipLabel.textContent = 'Timer';
    }

    activeEl.hidden = !showActive;
    chooserEl.hidden = showActive;
    titleEl.textContent = showActive ? Core.phaseLabel(snap) : 'Sprint timer';

    if (showActive) {
      clockEl.textContent = Core.formatClock(snap.remainingMs);
      phaseEl.textContent = Core.phaseLabel(snap);
      progressFill.style.width = snap.pct + '%';
      startPauseBtn.textContent = snap.status === 'running' ? 'Pause' : 'Resume';
    } else {
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
    if (notifyLabel) notifyLabel.textContent = snap.notifyOn ? 'Notify on' : 'Notify off';
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
    if (Core.isHiddenNow()) return;
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

  chip.addEventListener('click', function () {
    setPanelOpen(!panelOpen);
  });
  closeBtn.addEventListener('click', function () {
    setPanelOpen(false);
    chip.focus();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && panelOpen) {
      setPanelOpen(false);
      chip.focus();
    }
  });

  document.addEventListener('click', function (e) {
    if (!panelOpen) return;
    if (root.contains(e.target)) return;
    setPanelOpen(false);
  });

  modeStartBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      Core.warmAudio();
      Core.startManual(btn.getAttribute('data-widget-start-mode'));
    });
  });

  presetBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var mode = btn.getAttribute('data-widget-preset-mode');
      var value = Number(btn.getAttribute('data-widget-preset-value'));
      if (value) Core.setManualDuration(mode, value);
    });
  });

  if (customInput && customTarget) {
    function commitCustom() {
      var value = Number(customInput.value);
      if (value > 0) {
        Core.setManualDuration(customTarget.value, value);
        customInput.value = '';
      }
    }
    customInput.addEventListener('change', commitCustom);
    customInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitCustom();
      }
    });
  }

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
      Core.startAuto(Number(btn.getAttribute('data-widget-auto-start')));
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
      var minutes = Number(btn.getAttribute('data-widget-extend'));
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

  setPanelOpen(false);
  Core.subscribe(render);
})();
