/* AFWC sprint timer — shared engine (no DOM).
 *
 * Owns the timer's state machine and persistence; timer.js (the full /timer
 * page) and timer-widget.js (the floating chip, on every leader page) each
 * render their own markup from it. Loaded once per page — see the guard at
 * the bottom — before either consumer's script runs.
 *
 * Timing model: a phase has an `anchor` epoch (ms) and a `durationMs`. The
 * remaining time is always recomputed from `Date.now() - anchor`, never a
 * decrementing counter, so it stays correct through a throttled/backgrounded
 * tab, a page navigation, or a reload — restore-from-storage plus this model
 * means the display just picks up where it should be.
 *
 * Cross-tab: the full state is persisted under one localStorage key on every
 * change. Other tabs pick it up via the 'storage' event. Two tabs racing to
 * detect the same phase-end is possible (both tick off the same anchor); the
 * tab whose write actually lands is the one that fires the chime/notification
 * — see the reconcile check in tick(). Not a perfect distributed lock, but
 * good enough for a handful of tabs open on one laptop.
 */
(function () {
  'use strict';

  if (window.AFWCTimer) return; // already initialized by an earlier script tag

  var STORAGE_KEY = 'afwc-timer-v1';
  var TICK_MS = 250;

  var MANUAL_PRESETS = { sprint: [15, 20, 25, 30], break: [5, 10, 15] };
  var AUTO_TOTALS = [90, 120, 150];
  var MANUAL_DEFAULT_MINUTES = { sprint: 20, break: 10 };

  /* ---------------- formatting helpers (pure, shared by both renderers) ---------------- */

  function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  function formatClock(ms) {
    var totalSeconds = Math.max(0, Math.ceil(ms / 1000));
    var m = Math.floor(totalSeconds / 60);
    var s = totalSeconds % 60;
    return pad2(m) + ':' + pad2(s);
  }

  function phaseLabel(snap) {
    if (snap.mode === 'settle') return 'Settling in';
    if (snap.mode === 'sprint') {
      if (snap.auto && snap.auto.sprintIndex) return 'Sprint ' + snap.auto.sprintIndex + ' of ' + snap.auto.sprintTotal;
      return 'Sprint';
    }
    if (snap.mode === 'break') return 'Break';
    return '';
  }

  function titleTag(snap) {
    if (snap.mode === 'settle') return 'SETTLING IN';
    if (snap.mode === 'sprint') return snap.auto && snap.auto.sprintIndex ? 'SPRINT ' + snap.auto.sprintIndex : 'SPRINT';
    if (snap.mode === 'break') return 'BREAK';
    return '';
  }

  function bigLabel(mode) {
    if (mode === 'settle') return 'SETTLING IN';
    if (mode === 'sprint') return 'SPRINT';
    if (mode === 'break') return 'BREAK';
    return '';
  }

  function doneBanner(snap) {
    if (snap.status !== 'done') return null;
    if (snap.doneMode === 'auto') return 'Session complete — nice work.';
    if (snap.doneMode === 'sprint') return 'Sprint done — start a break?';
    if (snap.doneMode === 'break') return 'Break over — pens up?';
    return null;
  }

  /* ---------------- auto plan ----------------
   * Always a 10-minute settle, then sprint(20)/break(10) alternating, ending
   * on a sprint. totalMinutes is always a multiple of 30:
   *   90  = 10 + (20+10)*2 + 20   -> 3 sprints, 2 breaks
   *   120 = 10 + (20+10)*3 + 20   -> 4 sprints, 3 breaks
   *   150 = 10 + (20+10)*4 + 20   -> 5 sprints, 4 breaks
   */
  function buildAutoPlan(totalMinutes) {
    var sprintCount = Math.round(totalMinutes / 30);
    var phases = [{ kind: 'settle', minutes: 10 }];
    for (var i = 1; i <= sprintCount; i++) {
      phases.push({ kind: 'sprint', minutes: 20, sprintIndex: i, sprintTotal: sprintCount });
      if (i < sprintCount) phases.push({ kind: 'break', minutes: 10 });
    }
    return phases;
  }

  /* ---------------- persistence ---------------- */

  function defaultState() {
    return {
      status: 'idle', // idle | running | paused | done
      mode: 'sprint', // sprint | break | settle
      durationMs: MANUAL_DEFAULT_MINUTES.sprint * 60000,
      anchor: null,
      pausedAt: null,
      auto: null, // { totalMinutes, phases, index }
      soundOn: false,
      notifyOn: false,
      manualDefaults: { sprint: MANUAL_DEFAULT_MINUTES.sprint, break: MANUAL_DEFAULT_MINUTES.break },
      doneMode: null,
      updatedAt: 0,
    };
  }

  function normalize(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var d = defaultState();
    var out = {
      status: ['idle', 'running', 'paused', 'done'].indexOf(raw.status) !== -1 ? raw.status : d.status,
      mode: ['sprint', 'break', 'settle'].indexOf(raw.mode) !== -1 ? raw.mode : d.mode,
      durationMs: typeof raw.durationMs === 'number' && raw.durationMs > 0 ? raw.durationMs : d.durationMs,
      anchor: typeof raw.anchor === 'number' ? raw.anchor : null,
      pausedAt: typeof raw.pausedAt === 'number' ? raw.pausedAt : null,
      auto: null,
      soundOn: !!raw.soundOn,
      notifyOn: !!raw.notifyOn,
      manualDefaults: {
        sprint: (raw.manualDefaults && raw.manualDefaults.sprint) || d.manualDefaults.sprint,
        break: (raw.manualDefaults && raw.manualDefaults.break) || d.manualDefaults.break,
      },
      doneMode: ['sprint', 'break', 'auto'].indexOf(raw.doneMode) !== -1 ? raw.doneMode : null,
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
    };
    if (raw.auto && Array.isArray(raw.auto.phases) && raw.auto.phases.length) {
      out.auto = {
        totalMinutes: raw.auto.totalMinutes,
        phases: raw.auto.phases,
        index: typeof raw.auto.index === 'number' ? raw.auto.index : 0,
      };
    }
    return out;
  }

  function loadFromStorage() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return normalize(JSON.parse(raw));
    } catch (e) {
      return null;
    }
  }

  function saveToStorage() {
    state.updatedAt = Date.now();
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      /* private browsing or storage disabled — timer still works, just won't persist */
    }
  }

  /* ---------------- state ---------------- */

  var state = loadFromStorage() || defaultState();
  var subscribers = [];
  var transitionSubscribers = [];
  var intervalId = null;
  var hiddenOverride = null;

  function isHidden() {
    if (hiddenOverride !== null) return hiddenOverride;
    return typeof document !== 'undefined' && document.hidden;
  }

  function computeElapsed() {
    if (state.status === 'running' && state.anchor !== null) return Math.max(0, Date.now() - state.anchor);
    if (state.status === 'paused' && state.anchor !== null && state.pausedAt !== null) {
      return Math.max(0, state.pausedAt - state.anchor);
    }
    return 0;
  }

  function buildSnapshot() {
    var elapsed = computeElapsed();
    var remaining = Math.max(0, state.durationMs - elapsed);
    var pct = state.durationMs > 0 ? Math.min(100, (elapsed / state.durationMs) * 100) : 0;
    var autoInfo = null;
    if (state.auto) {
      var ph = state.auto.phases[state.auto.index] || {};
      autoInfo = {
        totalMinutes: state.auto.totalMinutes,
        index: state.auto.index,
        count: state.auto.phases.length,
        sprintIndex: ph.sprintIndex || null,
        sprintTotal: ph.sprintTotal || null,
      };
    }
    return {
      status: state.status,
      mode: state.mode,
      durationMs: state.durationMs,
      remainingMs: remaining,
      elapsedMs: elapsed,
      pct: pct,
      auto: autoInfo,
      soundOn: state.soundOn,
      notifyOn: state.notifyOn,
      manualDefaults: { sprint: state.manualDefaults.sprint, break: state.manualDefaults.break },
      doneMode: state.doneMode,
    };
  }

  function publish() {
    var snap = buildSnapshot();
    subscribers.forEach(function (fn) {
      try {
        fn(snap);
      } catch (e) {
        /* one bad subscriber shouldn't break the others */
      }
    });
  }

  function emitTransition(payload) {
    transitionSubscribers.forEach(function (fn) {
      try {
        fn(payload);
      } catch (e) {
        /* ditto */
      }
    });
  }

  function startTicker() {
    stopTicker();
    intervalId = window.setInterval(tick, TICK_MS);
  }
  function stopTicker() {
    if (intervalId !== null) {
      window.clearInterval(intervalId);
      intervalId = null;
    }
  }

  /* One phase's worth of transition math. Mutates `state` in place and
   * returns what happened, but does not persist/publish/side-effect — the
   * caller (tick, which may loop this to catch up after a long absence)
   * does that once at the end. */
  function advanceOnePhase() {
    var endedMode = state.mode;
    var endedDurationMs = state.durationMs;
    var wasAuto = !!state.auto;
    var nextMode = null;
    var isSessionComplete = false;

    if (wasAuto && state.auto.index < state.auto.phases.length - 1) {
      var prevAnchor = state.anchor;
      var prevDuration = state.durationMs;
      state.auto.index += 1;
      var nextPhase = state.auto.phases[state.auto.index];
      state.mode = nextPhase.kind;
      state.durationMs = nextPhase.minutes * 60000;
      state.anchor = prevAnchor + prevDuration; // chained, not Date.now() — avoids drift
      state.pausedAt = null;
      state.status = 'running';
      state.doneMode = null;
      nextMode = nextPhase.kind;
    } else if (wasAuto) {
      isSessionComplete = true;
      state.status = 'done';
      state.doneMode = 'auto';
    } else {
      state.status = 'done';
      state.doneMode = endedMode;
    }

    return {
      endedMode: endedMode,
      endedDurationMs: endedDurationMs,
      nextMode: nextMode,
      isSessionComplete: isSessionComplete,
    };
  }

  function tick() {
    if (state.status !== 'running' || state.anchor === null) return;
    if (Date.now() - state.anchor < state.durationMs) {
      publish();
      return;
    }

    // Reconcile against storage before mutating: if another tab already
    // handled this transition, adopt its result instead of doing it again
    // (and firing a second chime/notification).
    var fresh = loadFromStorage();
    if (fresh && fresh.updatedAt !== state.updatedAt) {
      state = fresh;
      publish();
      return;
    }

    var lastResult = null;
    var guard = 0;
    while (state.status === 'running' && state.anchor !== null && Date.now() - state.anchor >= state.durationMs) {
      lastResult = advanceOnePhase();
      if (++guard > 200) break; // safety valve against a runaway loop
      if (state.status !== 'running') break;
    }
    if (!lastResult) {
      publish();
      return;
    }

    saveToStorage();
    publish();
    playChime(lastResult.nextMode === 'sprint');
    maybeNotify(lastResult.endedMode, lastResult.endedDurationMs, lastResult.nextMode, lastResult.isSessionComplete);
    emitTransition({
      endedMode: lastResult.endedMode,
      nextMode: lastResult.nextMode,
      isSessionComplete: lastResult.isSessionComplete,
      remote: false,
    });
  }

  window.addEventListener('storage', function (e) {
    if (e.key !== null && e.key !== STORAGE_KEY) return;
    var fresh = loadFromStorage();
    if (!fresh) return;
    var prevMode = state.mode;
    var prevStatus = state.status;
    state = fresh;
    if (state.status === 'running') startTicker();
    else stopTicker();
    publish();
    if (state.mode !== prevMode || (prevStatus !== 'done' && state.status === 'done')) {
      emitTransition({
        endedMode: prevMode,
        nextMode: state.mode !== prevMode ? state.mode : null,
        isSessionComplete: state.doneMode === 'auto',
        remote: true,
      });
    }
  });

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

  function playChime(rising) {
    if (!state.soundOn) return;
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

  /* ---------------- notifications ---------------- */

  function maybeNotify(endedMode, endedDurationMs, nextMode, isSessionComplete) {
    if (!state.notifyOn) return;
    if (!isHidden()) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    var title, body;
    if (isSessionComplete) {
      title = 'Session complete';
      body = 'Auto session finished — nice work.';
    } else if (endedMode === 'sprint') {
      title = 'Sprint done';
      body = 'Sprint done — ' + formatClock(endedDurationMs) + ' elapsed. Break?';
    } else if (endedMode === 'break') {
      title = 'Break over';
      body = 'Break over. Pens up?';
    } else {
      title = 'Settling done';
      body = 'Settling done — sprint starting.';
    }
    try {
      // eslint-disable-next-line no-new
      new Notification(title, { body: body, tag: 'afwc-timer' });
    } catch (e) {
      /* notifications are a nicety */
    }
  }

  /* ---------------- public actions ---------------- */

  function startManual(mode) {
    if (mode !== 'sprint' && mode !== 'break') return;
    var mins = state.manualDefaults[mode] || MANUAL_DEFAULT_MINUTES[mode];
    state.auto = null;
    state.mode = mode;
    state.durationMs = mins * 60000;
    state.anchor = Date.now();
    state.pausedAt = null;
    state.status = 'running';
    state.doneMode = null;
    saveToStorage();
    publish();
    startTicker();
  }

  function setManualDuration(mode, minutes) {
    if (mode !== 'sprint' && mode !== 'break') return;
    var mins = Math.max(1, Math.min(180, Math.round(Number(minutes) || 0)));
    if (!mins) return;
    state.manualDefaults[mode] = mins;
    saveToStorage();
    publish();
  }

  function startAuto(totalMinutes) {
    if (AUTO_TOTALS.indexOf(totalMinutes) === -1) return;
    var phases = buildAutoPlan(totalMinutes);
    state.auto = { totalMinutes: totalMinutes, phases: phases, index: 0 };
    state.mode = phases[0].kind;
    state.durationMs = phases[0].minutes * 60000;
    state.anchor = Date.now();
    state.pausedAt = null;
    state.status = 'running';
    state.doneMode = null;
    saveToStorage();
    publish();
    startTicker();
  }

  function pause() {
    if (state.status !== 'running') return;
    state.pausedAt = Date.now();
    state.status = 'paused';
    stopTicker();
    saveToStorage();
    publish();
  }

  function resume() {
    if (state.status !== 'paused' || state.anchor === null || state.pausedAt === null) return;
    var elapsed = state.pausedAt - state.anchor;
    state.anchor = Date.now() - elapsed;
    state.pausedAt = null;
    state.status = 'running';
    saveToStorage();
    publish();
    startTicker();
  }

  function extend(ms) {
    if (state.status !== 'running' && state.status !== 'paused') return;
    state.durationMs += ms;
    saveToStorage();
    publish();
  }

  function trim(ms) {
    if (state.status !== 'running' && state.status !== 'paused') return;
    var elapsed = computeElapsed();
    var floor = elapsed + 10000; // never trim below 10s remaining
    state.durationMs = Math.max(floor, state.durationMs - ms);
    saveToStorage();
    publish();
  }

  function reset() {
    stopTicker();
    state.status = 'idle';
    state.mode = 'sprint';
    state.anchor = null;
    state.pausedAt = null;
    state.auto = null;
    state.doneMode = null;
    state.durationMs = state.manualDefaults.sprint * 60000;
    saveToStorage();
    publish();
  }

  function setSound(on) {
    state.soundOn = !!on;
    saveToStorage();
    publish();
  }

  function setNotify(on) {
    state.notifyOn = !!on;
    saveToStorage();
    publish();
    if (on && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission().catch(function () {});
    }
  }

  function subscribe(fn) {
    subscribers.push(fn);
    fn(buildSnapshot());
    return function unsubscribe() {
      var i = subscribers.indexOf(fn);
      if (i !== -1) subscribers.splice(i, 1);
    };
  }

  function onTransition(fn) {
    transitionSubscribers.push(fn);
    return function unsubscribe() {
      var i = transitionSubscribers.indexOf(fn);
      if (i !== -1) transitionSubscribers.splice(i, 1);
    };
  }

  /* ---------------- init ---------------- */

  if (state.status === 'running') {
    tick();
    if (state.status === 'running') startTicker();
  }

  window.AFWCTimer = {
    MANUAL_PRESETS: MANUAL_PRESETS,
    AUTO_TOTALS: AUTO_TOTALS,
    formatClock: formatClock,
    phaseLabel: phaseLabel,
    titleTag: titleTag,
    bigLabel: bigLabel,
    doneBanner: doneBanner,
    getSnapshot: buildSnapshot,
    subscribe: subscribe,
    onTransition: onTransition,
    startManual: startManual,
    setManualDuration: setManualDuration,
    startAuto: startAuto,
    pause: pause,
    resume: resume,
    extend: extend,
    trim: trim,
    reset: reset,
    setSound: setSound,
    setNotify: setNotify,
    warmAudio: warmAudio,
    isHiddenNow: isHidden,
    __debug: {
      setHiddenOverride: function (v) {
        hiddenOverride = v === null ? null : !!v;
      },
      jump: function (seconds) {
        if (state.status === 'running' && state.anchor !== null) {
          state.anchor -= seconds * 1000;
          tick();
        } else if (state.status === 'paused' && state.pausedAt !== null) {
          state.pausedAt += seconds * 1000;
          saveToStorage();
          publish();
        }
      },
      getRawState: function () {
        return JSON.parse(JSON.stringify(state));
      },
    },
  };
})();
