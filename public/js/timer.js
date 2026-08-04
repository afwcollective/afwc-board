/* AFWC writing-sprint timer (/timer).
 *
 * No dependencies, no external requests (CSP is default-src 'self' with no
 * 'unsafe-inline' script-src, so all behavior lives here rather than in an
 * inline <script>).
 *
 * Timing model: a single `anchor` epoch (ms) marks when the running phase
 * plan would have started counting from zero. Every tick recomputes
 * `elapsed = Date.now() - anchor` from scratch — never a decrementing
 * counter — so the display stays correct even if the tab is backgrounded
 * and setInterval gets throttled or skipped for a while.
 *
 * Debugging: window.__afwcTimer.jump(seconds) shifts the anchor to fast
 * forward (or back with a negative number) without waiting in real time —
 * handy from the console to verify phase transitions.
 */
(function () {
  'use strict';

  var root = document.querySelector('[data-timer]');
  if (!root) return;

  var clockEl = root.querySelector('[data-clock]');
  var phaseEl = root.querySelector('[data-phase]');
  var progressFill = root.querySelector('[data-progress-fill]');
  var ticksEl = root.querySelector('[data-ticks]');

  var startPauseBtn = document.querySelector('[data-start-pause]');
  var resetBtn = document.querySelector('[data-reset]');
  var soundToggle = document.querySelector('[data-sound-toggle]');
  var soundLabel = document.querySelector('[data-sound-label]');
  var lengthButtons = Array.prototype.slice.call(document.querySelectorAll('[data-length-value]'));

  var originalTitle = document.title;

  /* ---------------- phase plan ----------------
   * Always a 10-minute settle, then sprint(20)/rest(10) alternating,
   * ending on a sprint. totalMinutes is always a multiple of 30:
   *   90  = 10 + (20+10)*2 + 20   → 3 sprints, 2 rests
   *   120 = 10 + (20+10)*3 + 20   → 4 sprints, 3 rests
   *   150 = 10 + (20+10)*4 + 20   → 5 sprints, 4 rests
   */
  function buildPlan(totalMinutes) {
    var sprintCount = Math.round(totalMinutes / 30);
    var phases = [{ kind: 'settle', minutes: 10 }];
    for (var i = 1; i <= sprintCount; i++) {
      phases.push({ kind: 'sprint', minutes: 20, sprintIndex: i, sprintTotal: sprintCount });
      if (i < sprintCount) phases.push({ kind: 'rest', minutes: 10 });
    }
    phases.forEach(function (p) {
      p.durationSec = p.minutes * 60;
    });
    return phases;
  }

  function phaseLabel(phase) {
    if (phase.kind === 'settle') return 'Settling in';
    if (phase.kind === 'sprint') return 'Sprint ' + phase.sprintIndex + ' of ' + phase.sprintTotal;
    if (phase.kind === 'rest') return 'Break';
    return '';
  }

  function titleTag(phase) {
    if (phase.kind === 'settle') return 'SETTLING IN';
    if (phase.kind === 'sprint') return 'SPRINT ' + phase.sprintIndex;
    if (phase.kind === 'rest') return 'BREAK';
    return '';
  }

  function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  function formatClock(ms) {
    var totalSeconds = Math.max(0, Math.ceil(ms / 1000));
    var m = Math.floor(totalSeconds / 60);
    var s = totalSeconds % 60;
    return pad2(m) + ':' + pad2(s);
  }

  /* ---------------- audio (off by default) ---------------- */

  var audioCtx = null;
  function ensureAudioCtx() {
    if (audioCtx) return audioCtx;
    var Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    try {
      audioCtx = new Ctor();
    } catch (e) {
      audioCtx = null;
    }
    return audioCtx;
  }

  function warmAudio() {
    var ctx = ensureAudioCtx();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(function () {});
  }

  // A quiet two-note chime: rising into a sprint, falling into a break/end.
  function chime(rising) {
    if (!soundOn) return;
    var ctx = ensureAudioCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(function () {});
    try {
      var now = ctx.currentTime;
      var notes = rising ? [523.25, 659.25] : [659.25, 493.88];
      notes.forEach(function (freq, i) {
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        var start = now + i * 0.17;
        var dur = 0.24;
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(0.14, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
        osc.connect(gain).connect(ctx.destination);
        osc.start(start);
        osc.stop(start + dur + 0.02);
      });
    } catch (e) {
      /* audio is a nicety, never let it break the timer */
    }
  }

  /* ---------------- state ---------------- */

  var totalMinutes = 120;
  var plan = buildPlan(totalMinutes);
  var totalDurationSec = sumDuration(plan);
  var currentPhaseIndex = -1;
  var state = 'idle'; // idle | running | paused | done
  var anchor = null; // epoch ms
  var pausedElapsedMs = 0;
  var intervalId = null;
  var soundOn = false;

  try {
    soundOn = window.localStorage.getItem('afwc-timer-sound') === '1';
  } catch (e) {
    soundOn = false;
  }

  function sumDuration(p) {
    return p.reduce(function (sum, phase) {
      return sum + phase.durationSec;
    }, 0);
  }

  function renderTicks() {
    ticksEl.innerHTML = '';
    var acc = 0;
    for (var i = 0; i < plan.length - 1; i++) {
      acc += plan[i].durationSec;
      var tick = document.createElement('div');
      tick.className = 'timer-tick';
      tick.style.left = (acc / totalDurationSec) * 100 + '%';
      ticksEl.appendChild(tick);
    }
  }

  function locatePhase(elapsedSec) {
    var acc = 0;
    for (var i = 0; i < plan.length; i++) {
      var dur = plan[i].durationSec;
      if (elapsedSec < acc + dur || i === plan.length - 1) {
        return { index: i, remainingSec: Math.max(0, acc + dur - elapsedSec) };
      }
      acc += dur;
    }
    return { index: plan.length - 1, remainingSec: 0 };
  }

  function render(elapsedSec) {
    if (elapsedSec >= totalDurationSec) {
      finish();
      return;
    }
    var loc = locatePhase(elapsedSec);
    var phase = plan[loc.index];

    if (loc.index !== currentPhaseIndex) {
      var isFirst = currentPhaseIndex === -1;
      currentPhaseIndex = loc.index;
      root.setAttribute('data-phase-kind', phase.kind);
      phaseEl.textContent = phaseLabel(phase);
      if (!isFirst) chime(phase.kind === 'sprint');
    }

    clockEl.textContent = formatClock(loc.remainingSec * 1000);
    var pct = Math.min(100, (elapsedSec / totalDurationSec) * 100);
    progressFill.style.width = pct + '%';

    if (state === 'running' || state === 'paused') {
      document.title = formatClock(loc.remainingSec * 1000) + ' · ' + titleTag(phase) + ' — AFWC';
    }
  }

  function startInterval() {
    stopInterval();
    intervalId = window.setInterval(tick, 250);
  }
  function stopInterval() {
    if (intervalId !== null) {
      window.clearInterval(intervalId);
      intervalId = null;
    }
  }
  function tick() {
    if (state !== 'running') return;
    render((Date.now() - anchor) / 1000);
  }

  function updateButtons() {
    startPauseBtn.textContent = state === 'running' ? 'Pause' : state === 'paused' ? 'Resume' : 'Start';
  }

  function start() {
    anchor = Date.now();
    pausedElapsedMs = 0;
    currentPhaseIndex = -1;
    state = 'running';
    root.setAttribute('data-state', 'running');
    render(0);
    startInterval();
    updateButtons();
  }

  function pause() {
    if (state !== 'running') return;
    pausedElapsedMs = Date.now() - anchor;
    render(pausedElapsedMs / 1000);
    state = 'paused';
    root.setAttribute('data-state', 'paused');
    stopInterval();
    updateButtons();
  }

  function resume() {
    if (state !== 'paused') return;
    anchor = Date.now() - pausedElapsedMs;
    state = 'running';
    root.setAttribute('data-state', 'running');
    render((Date.now() - anchor) / 1000);
    startInterval();
    updateButtons();
  }

  function finish() {
    stopInterval();
    state = 'done';
    root.setAttribute('data-state', 'done');
    root.setAttribute('data-phase-kind', 'done');
    phaseEl.textContent = 'Session complete — nice work.';
    clockEl.textContent = '00:00';
    progressFill.style.width = '100%';
    document.title = originalTitle;
    chime(false);
    updateButtons();
  }

  function resetTimer() {
    stopInterval();
    state = 'idle';
    anchor = null;
    pausedElapsedMs = 0;
    currentPhaseIndex = -1;
    root.setAttribute('data-state', 'idle');
    root.setAttribute('data-phase-kind', plan[0].kind);
    phaseEl.textContent = phaseLabel(plan[0]);
    clockEl.textContent = formatClock(plan[0].durationSec * 1000);
    progressFill.style.width = '0%';
    document.title = originalTitle;
    updateButtons();
  }

  function toggleStartPause() {
    if (state === 'idle') start();
    else if (state === 'running') pause();
    else if (state === 'paused') resume();
    else if (state === 'done') {
      resetTimer();
      start();
    }
  }

  function setLength(minutes) {
    totalMinutes = minutes;
    plan = buildPlan(minutes);
    totalDurationSec = sumDuration(plan);
    renderTicks();
    lengthButtons.forEach(function (btn) {
      btn.setAttribute('aria-pressed', Number(btn.getAttribute('data-length-value')) === minutes ? 'true' : 'false');
    });
    resetTimer();
  }

  /* ---------------- wire up ---------------- */

  startPauseBtn.addEventListener('click', function () {
    warmAudio();
    toggleStartPause();
  });
  resetBtn.addEventListener('click', resetTimer);

  soundToggle.setAttribute('aria-pressed', soundOn ? 'true' : 'false');
  if (soundLabel) soundLabel.textContent = soundOn ? 'Sound on' : 'Sound off';
  soundToggle.addEventListener('click', function () {
    warmAudio();
    soundOn = !soundOn;
    soundToggle.setAttribute('aria-pressed', soundOn ? 'true' : 'false');
    if (soundLabel) soundLabel.textContent = soundOn ? 'Sound on' : 'Sound off';
    try {
      window.localStorage.setItem('afwc-timer-sound', soundOn ? '1' : '0');
    } catch (e) {
      /* private browsing or storage disabled — sound preference just won't persist */
    }
  });

  lengthButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var v = Number(btn.getAttribute('data-length-value'));
      if (v && v !== totalMinutes) setLength(v);
    });
  });

  document.addEventListener('keydown', function (e) {
    var el = document.activeElement;
    var tag = el ? el.tagName : '';
    var typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el && el.isContentEditable);
    if (typing) return;

    if (e.code === 'Space' || e.key === ' ') {
      e.preventDefault();
      warmAudio();
      toggleStartPause();
    } else if (e.key === 'r' || e.key === 'R') {
      resetTimer();
    }
  });

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && state === 'running') tick();
  });

  // Console/debug hook — see file header. Not used by the page itself.
  window.__afwcTimer = {
    jump: function (seconds) {
      if (state === 'running') {
        anchor -= seconds * 1000;
        render((Date.now() - anchor) / 1000);
      } else if (state === 'paused') {
        pausedElapsedMs += seconds * 1000;
        render(pausedElapsedMs / 1000);
      }
    },
    getState: function () {
      return { state: state, totalMinutes: totalMinutes, currentPhaseIndex: currentPhaseIndex, plan: plan };
    },
  };

  /* ---------------- init ---------------- */

  renderTicks();
  resetTimer();
})();
