// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 marcanxo
//
// content.js - runs INSIDE the page (and each frame). The fullscreen-preserving path.
//
// It hooks the page's own media element via createMediaElementSource and routes it
// through gain → [limiter] → analyser → destination. No tabCapture is used, so Chrome
// never flags the tab as captured and the Fullscreen API stays available.
//
// SAFETY: createMediaElementSource is one-shot and destructive - hooking a CORS-tainted
// element silences it permanently (until reload). So we NEVER hook unless a non-destructive
// pre-check passes (same-origin / blob / CORS-enabled / not DRM) AND the AudioContext is
// actually running. The analyser only *confirms* audio for display; it never decides.
//
// Injected repeatedly via executeScript, so everything is IIFE-scoped and guarded so we
// don't stack duplicate listeners or clobber an existing hook.

(function () {
  if (window.__VB_INIT__) return;
  window.__VB_INIT__ = true;

  const S = {
    ctx: null, src: null, gain: null, limiter: null, analyser: null,
    el: null, engaged: false, useLimiter: true, mo: null
  };

  // The last AudioContext this frame confirmed RUNNING. One context can host any number of
  // graphs, so we keep the proven one instead of building a fresh (and initially SUSPENDED) one
  // per hook: resuming is asynchronous, and on a page with no user activation yet it may not
  // succeed at all. Reusing it is what lets a hook be created synchronously (see preHook).
  let hotCtx = null;
  // A context that is being wired into a new graph right now. It has no graph pointing at it yet,
  // so the reclaim pass below would happily close it - which silences every element on it.
  let ctxPin = null;
  // Elements this frame has ever routed through createMediaElementSource. The hook is one-shot,
  // so a second attempt on the same element throws - and reporting that as 'already-hooked' would
  // tell the user another app owns their player. Ours must never masquerade as someone else's.
  const ours = new WeakSet();

  // A context is only closed once nothing is on it any more.
  function ctxInUse(ctx) {
    return ctx === ctxPin || S.ctx === ctx || retired.some((g) => g.ctx === ctx);
  }

  function makeLimiter(ctx) {
    const c = ctx.createDynamicsCompressor();
    c.threshold.value = -3; c.knee.value = 0; c.ratio.value = 20;
    c.attack.value = 0.003; c.release.value = 0.25;
    return c;
  }

  // ONE wiring block for every fresh hook - the worker's engage AND the in-page gesture/unmute
  // paths. Static graph: the limiter is ALWAYS in the path (src→gain→limiter→analyser→destination),
  // toggled by ramping its ratio rather than rewiring, so toggling can't click; the analyser is a
  // passthrough that also feeds the output. Shared so the synchronous paths can never wire a
  // subtly different (and untested) graph than the one the slow path is verified with.
  function buildGraph(node, el, gain) {
    const ctx = node.context;
    S.ctx = ctx; S.src = node; S.el = el;
    S.gain = ctx.createGain(); S.gain.gain.value = gain;
    S.limiter = makeLimiter(ctx);
    S.analyser = ctx.createAnalyser(); S.analyser.fftSize = 256;
    S.src.connect(S.gain);
    S.gain.connect(S.limiter);
    S.limiter.connect(S.analyser);
    S.analyser.connect(ctx.destination);
  }

  // Rank media elements: prefer playing, then audible, then biggest.
  function rankElements() {
    const els = Array.from(document.querySelectorAll("video, audio"));
    const scored = els.map((el) => {
      const r = el.getBoundingClientRect();
      return {
        el,
        area: Math.max(0, r.width) * Math.max(0, r.height),
        playing: !el.paused && !el.ended && el.readyState >= 2 ? 1 : 0,
        audible: !el.muted && el.volume > 0 ? 1 : 0
      };
    });
    scored.sort((a, b) => b.playing - a.playing || b.audible - a.audible || b.area - a.area);
    return scored;
  }
  // The most likely "real" media element right now.
  function pickElement() {
    const scored = rankElements();
    return scored.length ? scored[0].el : null;
  }

  // Non-destructive: decide if this element is safe to hook WITHOUT touching it.
  function assess(el) {
    if (el.mediaKeys) return { safe: false, reason: "drm" };
    const src = el.currentSrc || el.src || "";
    if (!src) return { safe: false, reason: "no-src" };
    if (/^(blob:|data:|mediastream:)/.test(src)) return { safe: true, reason: "blob" };
    try {
      const u = new URL(src, location.href);
      // Same-origin URLs keep reason 'same-origin' EVEN IF el.crossOrigin is set: the attribute
      // only matters at fetch time, so a page that sets it after load may still be playing a
      // tainted no-cors resource - the redirect probe must stay in the path for these. Worst
      // case the probe refuses a hookable element and we fall back to capture: safe direction
      // (losing fullscreen is recoverable, silencing a tab is not).
      if (u.origin === location.origin) return { safe: true, reason: "same-origin" };
      if (el.crossOrigin === "anonymous" || el.crossOrigin === "use-credentials")
        return { safe: true, reason: "cors-enabled" };
      return { safe: false, reason: "cross-origin-no-cors" };
    } catch {
      return { safe: false, reason: "bad-url" };
    }
  }

  // The URL-string check above can be defeated by a same-origin src that HTTP-redirects to a
  // cross-origin host (common pattern: /media/id redirecting to a presigned CDN URL). The element
  // plays fine natively, but its media data is CORS-tainted and createMediaElementSource would
  // output pure silence, permanently (the hook is one-shot). Redirects are invisible on the
  // element, so before trusting a 'same-origin' verdict we probe the URL with a mode:'same-origin'
  // fetch: it REJECTS on any cross-origin redirect. Any resolved HTTP status counts as clean
  // (only the redirect matters); rejection or a slow server means "don't risk it" (capture instead).
  const chainVerdicts = new Map(); // src -> { p: Promise<boolean>, at, ok: true|false|null, extend }
  const CHAIN_NEG_TTL = 30000;   // a negative is re-tried after this, not cached for the page's life
  const CHAIN_SLICE = 2000;      // how long any single caller is willing to wait
  const CHAIN_TOTAL_MAX = 4000;  // hard ceiling on one probe's lifetime, however many join it
  function sameOriginChainOk(src) {
    const now = performance.now();
    const e = chainVerdicts.get(src);
    // A negative is kept until its TTL, then re-probed: a rejection can be transient (cold server
    // hitting the abort, a blip) and must not disable element mode for the page's life, but
    // deleting it outright made every failing src re-fetch on EVERY probe - a request amplifier
    // aimed at the site.
    if (e && !(e.ok === false && now - e.at > CHAIN_NEG_TTL)) {
      // Still in flight: give the LATE caller its own fresh slice of patience on the SAME
      // request instead of starting a second one. Starting one per caller would multiply
      // requests on exactly the slow origins warming exists for (the restore loop re-probes
      // roughly every 750ms), while inheriting a nearly-spent deadline would hand back a false
      // verdict that the worker treats as terminal (sticky capture mode).
      if (e.ok === null) e.extend(now);
      return e.p;
    }
    const entry = { p: null, at: now, ok: null, extend: null };
    const ctl = new AbortController();
    let kill = null;
    const arm = (from) => {
      clearTimeout(kill);
      const left = Math.min(CHAIN_SLICE, entry.at + CHAIN_TOTAL_MAX - from);
      if (left <= 0) { try { ctl.abort(); } catch (_) {} return; }
      kill = setTimeout(() => { try { ctl.abort(); } catch (_) {} }, left);
    };
    entry.extend = arm;
    arm(now);
    entry.p = (async () => {
      try {
        const res = await fetch(src, {
          mode: "same-origin", credentials: "same-origin", cache: "force-cache",
          headers: { Range: "bytes=0-0" }, signal: ctl.signal
        });
        try { res.body && res.body.cancel(); } catch (_) {}
        return true;
      } catch (_) {
        return false;
      } finally { clearTimeout(kill); }
    })();
    chainVerdicts.set(src, entry);
    entry.p.then((ok) => { entry.ok = ok; });
    return entry.p;
  }

  // Toggle the limiter by RAMPING its compression ratio (20:1 on → 1:1 off) rather than disconnecting
  // nodes. ratio 1 → slope 1/ratio = 1 → the compressor is an identity transfer (no gain change, flat
  // response): level/frequency-transparent. (Caveat: a DynamicsCompressor keeps a fixed ~6ms pre-delay
  // even when bypassed - imperceptible, and the price of click-free toggling, since an AudioParam ramp
  // is smooth where a disconnect/reconnect pops.) The limiter stays wired into the graph at all times.
  function applyLimiter(on, immediate) {
    if (!S.ctx || !S.limiter) return;
    const t = S.ctx.currentTime;
    if (immediate) {
      S.limiter.ratio.setValueAtTime(on ? 20 : 1, t);
      S.limiter.threshold.setValueAtTime(on ? -3 : 0, t);
    } else {
      S.limiter.ratio.setTargetAtTime(on ? 20 : 1, t, 0.02);
      S.limiter.threshold.setTargetAtTime(on ? -3 : 0, t, 0.02);
    }
  }

  // Watch the analyser briefly; resolve true if real signal appears.
  // An element that is muted/zero-volume/paused RIGHT NOW is silent by construction - waiting the
  // full window would only stall the worker's restore lock for a result we already know. The
  // analyser only confirms audio for display (it never decides), so a short look suffices there.
  const measureBudget = (el) => (el.muted || el.volume === 0 || el.paused ? 150 : 1200);
  // full=true watches the WHOLE window and reports the peak instead of settling on the first
  // sign of signal: the early exit fires on the first non-silent frame, which may still be on
  // the gain ramp - useless when the caller wants to judge the LEVEL, not just presence.
  function measure(timeout = 1200, full = false) {
    return new Promise((res) => {
      const buf = new Float32Array(S.analyser.fftSize);
      let peak = 0;
      const t0 = performance.now();
      (function tick() {
        try {
          S.analyser.getFloatTimeDomainData(buf);
          let s = 0;
          for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
          const rms = Math.sqrt(s / buf.length);
          if (rms > peak) peak = rms;
          if (!full && peak > 0.0008) return res({ signal: true, rms: peak });
          if (performance.now() - t0 > timeout) return res({ signal: peak > 0.0008, rms: peak });
        } catch (_) {
          return res({ signal: false, rms: peak }); // graph torn down mid-measure → settle, don't hang
        }
        // setTimeout, NOT requestAnimationFrame: rAF never fires in a hidden tab, so an engage
        // during a background restore would hang here and wedge the worker's restore lock.
        setTimeout(tick, 50);
      })();
    });
  }

  // Retired hooks: elements that were swapped out or superseded. createMediaElementSource is
  // one-shot and disconnecting or closing a graph silences its element FOREVER, so a retired
  // graph stays wired with its ctx kept OPEN, and is re-adopted by engage() if its element comes
  // back (theater-mode re-parenting, episode flip that reuses the node, a long detach). Bounded:
  // beyond 3 parked graphs the oldest is closed for real - its element is long gone by then.
  //
  // A parked graph keeps THE TAB'S LEVEL rather than dropping to unity. The outgoing element is
  // usually idle, but preHook retires on pointerdown - before the site has paused anything - and
  // a ducked tab jumping to native level for even a few frames is exactly the ear-blast this
  // path exists to remove. It is also the right level for an element that comes back: it resumes
  // boosted (or ducked) instead of native. stop() unwinds parked graphs on release.
  const retired = [];
  function retireCurrent() {
    try { if (S.mo) S.mo.disconnect(); } catch (_) {}
    if (S.ctx) {
      retired.push({ ctx: S.ctx, src: S.src, gain: S.gain, limiter: S.limiter, analyser: S.analyser, el: S.el });
      // Reclaim only graphs whose element has really left the DOM: the engage-switch path parks
      // elements that are still attached (merely paused), and closing THEIR ctx would silence
      // them forever if they resume. Connected graphs stay parked at unity - the cap is soft and
      // can grow on pages with many hooked players; that's the safe trade.
      while (retired.length > 3) {
        const idx = retired.findIndex((g) => !g.el || !g.el.isConnected);
        if (idx < 0) break;
        const g = retired.splice(idx, 1)[0];
        try { g.src.disconnect(); } catch (_) {}
        // Graphs share a context now, so closing it here would silence the elements of every
        // OTHER graph on it - permanently, since the hook can't be redone.
        if (!ctxInUse(g.ctx)) {
          try { g.ctx.close(); } catch (_) {}
          if (hotCtx === g.ctx) hotCtx = null;
        }
      }
    }
    S.ctx = S.src = S.gain = S.limiter = S.analyser = S.el = S.mo = null;
    S.engaged = false;
  }

  function watchElement(el) {
    try { if (S.mo) S.mo.disconnect(); } catch (_) {}
    let pending = false;
    S.mo = new MutationObserver(() => {
      // el.isConnected (not document.contains): an element re-parented INTO a shadow root is still
      // live and audible, but document.contains() reports false for it - tearing down then would
      // close the ctx and permanently silence it (the hook is one-shot).
      if (pending || el.isConnected) return;
      // The element left the DOM - but a player may be DETACHING then RE-ATTACHING the same node
      // (SPA reconciliation, theater/fullscreen re-parenting). Closing the context now would
      // permanently silence a same-node re-attach (createMediaElementSource is one-shot), so wait
      // a turn and only act if it's really gone.
      pending = true;
      setTimeout(() => {
        pending = false;
        if (el.isConnected) return; // came back → keep the live graph, keep watching
        if (S.el !== el) return;    // a queued engage already switched hooks - don't retire the successor's live graph
        // Genuinely replaced. Park the graph at unity WITHOUT closing its ctx (a same-node
        // re-attach later would be permanently silent otherwise; engage() re-adopts parked
        // graphs), then ask the worker to re-engage on whatever the page shows now.
        retireCurrent();
        try { chrome.runtime.sendMessage({ type: "elementLost" }); } catch (_) {}
      }, 150);
    });
    S.mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  // --- same-tab transition detection --------------------------------------
  // "Next episode" on many streaming sites swaps the player <iframe> (or its src)
  // WITHOUT a page load and WITHOUT removing anything from the hooked frame's DOM -
  // so neither the reload restore nor the elementLost watcher fires, and the boost
  // silently resets to native 1× while the stored level still says otherwise.
  // Every frame watches its own subtree for media/iframe swaps and nudges the
  // worker, which no-ops instantly unless this tab actually has a level set.
  let navPingTimer = null;
  let navPingAt = 0;       // when the pending send will fire (perf.now() clock)
  let lastNavPing = -2000; // negative: the FIRST ping must not be rate-capped against the frame's time origin
  let urgentBudget = 3;    // urgent escalations left in the current window
  let urgentReset = 0;     // when the budget refills (perf.now() clock)
  // A REAL user gesture is the strongest possible evidence that the signal about to follow is
  // genuine (click-to-unmute is one physical action), so signals attributed to one skip the
  // anti-flood budget and get a near-zero delay. Only e.isTrusted counts: synthetic events grant
  // no user activation, so a page cannot mint attribution.
  // The window ALSO carries its own small allowance. Without it, one click would open 1s in which
  // the only limit is the 20ms floor - a page flapping `muted` could then drive ~50 worker wakes
  // per click, far worse than the flood the budget was written for. Two sends per physical
  // gesture is all a legitimate click-to-unmute needs (the ping, plus one for the churn the
  // site's own handler causes). Key auto-repeat is ignored: holding a key would otherwise hold
  // the window open indefinitely.
  // When the extension is UPDATED or reloaded, this isolated world is orphaned: no message can
  // ever reach it again (stop included), but its WebAudio graphs keep applying the last level,
  // and the NEW world cannot re-hook the same elements (one-shot). Untreated that is a stale,
  // uncontrollable boost - and once the new world falls back to capture, capture gain STACKS on
  // top of it. Orphaning is detectable: chrome.runtime.id reads undefined (or throws) in an
  // invalidated context. Checked at the entry of every event handler that could act; on the
  // first event after the update this world unwinds everything to unity and stands down.
  let dead = false;
  function checkOrphaned() {
    if (dead) return true;
    try { if (chrome.runtime && chrome.runtime.id) return false; } catch (_) {}
    dead = true;
    try { for (const g of retired) unwind(g); } catch (_) {}
    try { if (S.engaged && S.ctx) unwind(S); } catch (_) {}
    armedGain = null;
    try { swapMo.disconnect(); } catch (_) {}
    try { if (S.mo) S.mo.disconnect(); } catch (_) {}
    try {
      window.removeEventListener("pointerdown", noteGesture, true);
      window.removeEventListener("keydown", noteGesture, true);
    } catch (_) {}
    return true;
  }

  let lastGestureAt = -100000;
  let gestureUrgentLeft = 0;
  let gestureArmed = false; // engage() found a suspended AudioContext; retry on the next gesture
  const GESTURE_WINDOW = 1000;
  const noteGesture = (e) => {
    if (checkOrphaned()) return;
    if (!e.isTrusted || (e.type === "keydown" && e.repeat)) return;
    lastGestureAt = performance.now();
    gestureUrgentLeft = 2;
    // Still inside the pointerdown task, ahead of the page's own click handler: the only moment
    // at which the boost can be in place BEFORE the site unmutes. Failures are non-events - the
    // ping below is the same path as before.
    if (e.type === "pointerdown") { try { preHook(e); } catch (_) {} }
    // A gesture is also what unblocks an AudioContext that engage() found suspended, so this is
    // the moment to retry (see armGestureRetry).
    if (gestureArmed) { gestureArmed = false; pingNavigated(true); }
  };
  window.addEventListener("pointerdown", noteGesture, true);
  window.addEventListener("keydown", noteGesture, true);
  function pingNavigated(urgent) {
    // Debounce bursts AND cap the rate: media DOM churn (ad rotations, lazy players) would
    // otherwise wake the MV3 service worker over and over, even when nothing is boosted.
    // urgent === true marks the exact moment a refused engage can finally succeed (an element
    // becoming audibly playing, a first gesture): those skip the churn cooldown and get the
    // 250ms floor - storm protection comes from the token budget below plus the gesture
    // handler's one-shot arming. `=== true` matters: popstate/hashchange pass an Event object
    // here and must stay non-urgent.
    const now = performance.now();
    // Urgency is token-budgeted (3 per rolling 10s per frame): the legit sources fire once per real
    // user interaction, but a hostile page could flap `muted` (or spam events) to re-arm them at the
    // engage roundtrip rate - once the budget is spent, escalations degrade to the churn wait, which
    // is exactly the pre-1.1.2 worker load ceiling.
    const byGesture = urgent === true && gestureUrgentLeft > 0 && now - lastGestureAt < GESTURE_WINDOW;
    // Only TENTATIVE here: whether the budget could cover this. Both allowances are charged
    // further down, for a send we actually schedule. Charging up here (as this did before)
    // let a burst that coalesces into ONE pending send drain all three tokens, so the next
    // genuine urgency - the content video becoming audible after an ad, say - fell back to the
    // 2s churn wait. On a ducked tab that is 2s of native-level audio: the very symptom the
    // gesture fast-path fixes, just on the non-gesture route.
    const byBudget = urgent === true && !byGesture && (now > urgentReset || urgentBudget > 0);
    // 20ms for a gesture-attributed signal: enough to coalesce the burst a single click produces
    // (volumechange + play + the churn the site's own handler causes) into one send, without a
    // wait the user can hear. Ducked tabs would otherwise blast at native level for the delay.
    const wait = byGesture ? 20 : byBudget ? 250 : Math.max(250, 2000 - (now - lastNavPing));
    const at = now + wait;
    if (navPingTimer) {
      if (at >= navPingAt) return; // the pending send fires sooner anyway - it covers this signal
      clearTimeout(navPingTimer);  // urgent: pull the pending send forward, never push it back
    }
    // Spend an allowance only for a send we actually SCHEDULE: signals folded into a pending
    // send above cost nothing, so one click's natural burst can't drain either budget.
    if (byGesture) gestureUrgentLeft--;
    else if (byBudget) {
      if (now > urgentReset) { urgentBudget = 3; urgentReset = now + 10000; }
      urgentBudget--;
    }
    navPingAt = at;
    navPingTimer = setTimeout(() => {
      navPingTimer = null;
      lastNavPing = performance.now();
      try { chrome.runtime.sendMessage({ type: "navigated" }); } catch (_) {}
    }, wait);
  }

  // One-shot: when engage() refused because the AudioContext couldn't run (autoplay policy -
  // fresh frame with no user activation yet), retry after the first gesture in this frame.
  // Activation is per-frame, so this is the earliest it can succeed. The retry rides on
  // noteGesture's listeners rather than adding its own pair: same events, same target, same
  // phase, and running inside noteGesture guarantees the retry ping sees a fresh gesture
  // (a separate listener would depend on registration order to get the fast path).
  function armGestureRetry() { gestureArmed = true; }

  let warmedTotal = 0;              // distinct srcs this frame has ever probed (see the probe handler)
  const WARM_TOTAL_MAX = 8;

  const MEDIA_TAGS = /^(IFRAME|VIDEO|AUDIO)$/;
  function touchesMedia(muts) {
    for (const m of muts) {
      if (m.type === "attributes") {
        if (MEDIA_TAGS.test(m.target.tagName)) return true;
        continue;
      }
      for (const list of [m.addedNodes, m.removedNodes]) {
        for (const n of list) {
          if (n.nodeType !== 1) continue;
          if (MEDIA_TAGS.test(n.tagName)) return true;
          if (n.querySelector && n.querySelector("iframe,video,audio")) return true;
        }
      }
    }
    return false;
  }
  const swapMo = new MutationObserver((muts) => {
    if (checkOrphaned()) return;
    if (touchesMedia(muts)) pingNavigated();
  });
  swapMo.observe(document.documentElement, {
    childList: true, subtree: true, attributes: true, attributeFilter: ["src"]
  });
  // Unmutes are INVISIBLE to the observer above: muted/volume are properties, not attributes.
  // volumechange doesn't bubble, but a CAPTURE listener on an ancestor still sees it - one
  // document-level listener covers every media element, present or future. Urgent only when the
  // element just became actionable (audibly playing); wiggles on muted/paused elements take the
  // churn path. Our own hooked element is skipped: its gain node already applies.
  document.addEventListener("volumechange", (e) => {
    if (checkOrphaned()) return;
    const el = e.target;
    if (!el || el.tagName !== "VIDEO" && el.tagName !== "AUDIO") return;
    if (el === S.el) return;
    const audible = !el.muted && el.volume > 0 && !el.paused;
    // A feed unmuting its next clip on its own: no gesture happened, so preHook never saw this
    // element. Take it here instead of waking the worker and waiting out the roundtrip.
    if (audible && autoHook(el)) return;
    pingNavigated(audible);
  }, true);
  // play() on an ALREADY-UNMUTED element is the volumechange listener's blind twin: pressing
  // play on a second article video (unmuted from the start, just paused) changes neither volume
  // nor the DOM, so without this listener no signal exists at all and the boost simply never
  // arrives. Same treatment: take it in-page when possible, ping otherwise.
  document.addEventListener("play", (e) => {
    if (checkOrphaned()) return;
    const el = e.target;
    if (!el || el.tagName !== "VIDEO" && el.tagName !== "AUDIO") return;
    if (el === S.el) return;
    const audible = !el.muted && el.volume > 0;
    if (audible && autoHook(el)) return;
    pingNavigated(audible);
  }, true);
  // Orphan standdown must not depend on the USER doing something: after an extension update,
  // the dangerous stacking path (new popup re-boost -> new world refused -> capture ON TOP of
  // this world's stale element gain) involves zero in-page events. timeupdate fires several
  // times a second on any playing media, so a boosted world notices its own death within a
  // fraction of a second; the handler is a single boolean check per event while healthy.
  document.addEventListener("timeupdate", () => { checkOrphaned(); }, true);
  // SPA route changes that fire DOM-visible events. (history.pushState is invisible
  // from this isolated world - the worker catches those via tabs.onUpdated url changes.)
  window.addEventListener("popstate", pingNavigated);
  window.addEventListener("hashchange", pingNavigated);
  // Back/forward cache: this document may return from the freezer with its graphs and arming
  // intact - including a boost the user RELEASED while the page slept, which no stop could
  // reach. Ask the worker for the truth; it answers with a stop when nothing should be active,
  // or re-asserts the stored level when it should.
  window.addEventListener("pageshow", (e) => {
    if (!e.persisted || checkOrphaned()) return;
    try { chrome.runtime.sendMessage({ type: "resync" }); } catch (_) {}
  });

  // --- pre-hook -----------------------------------------------------------
  // Normally the boost lands like this: the site unmutes → we notice → the worker is woken →
  // it probes → it sends engage. That roundtrip is about 200ms, and on a tab turned DOWN those
  // 200ms play at full native level, on every single click. The fix is to do the work inside the
  // gesture itself: pointerdown runs before the page's own click handler, so the gain node can
  // already be in place by the time the site unmutes. The element is muted while we hook it, so
  // nothing is audible either way - the boost is simply already there when the sound arrives.
  //
  // Everything here has to be decidable SYNCHRONOUSLY. An await would put us back behind the
  // unmute, and worse, half of these decisions guard a one-shot, irreversible hook. So every
  // uncertainty means: do nothing, and let the ordinary (slower, but fully checked) path handle
  // it. Doing nothing costs 200ms; guessing wrong costs a permanently silent element.
  let armedGain = null;   // level the worker last engaged this frame at (null = not our frame)
  let armedLimiter = true;
  let cmdBusy = 0;        // an engage/stop is mid-flight and owns S

  // A same-origin src is only safe once the redirect probe has cleared it, and that probe is
  // async. Positives are cached for the page's life and the probe handler warms every visible
  // candidate, so by the time the user clicks, the answer is usually already in hand.
  const chainOkNow = (src) => { const e = chainVerdicts.get(src); return !!(e && e.ok === true); };

  // The media element the user is actually pointing at. Nothing beyond the pointer is guessed -
  // the hook is one-shot, so we only ever spend it on an element that is genuinely under it.
  const isMedia = (n) => !!n && (n.tagName === "VIDEO" || n.tagName === "AUDIO");
  // Hit-testing, piercing shadow roots. A player that keeps its video in a shadow root reports
  // only its HOST from document.elementsFromPoint, so without descending we would never find the
  // video behind that player's own click catcher. Open roots only (a closed one is unreachable by
  // design) and shallow, since this runs on the input path.
  function mediaAtPoint(root, x, y, depth, seen) {
    if (seen.has(root)) return null;
    seen.add(root);
    let stack;
    try { stack = root.elementsFromPoint(x, y); } catch (_) { return null; }
    for (const n of stack) if (isMedia(n)) return n;
    if (depth >= 3) return null;
    for (const n of stack) {
      // ShadowRoot.elementsFromPoint also returns the HOST and elements OUTSIDE the queried root
      // (long-standing Chrome quirk), so without the visited set every recursion level would
      // re-descend every other overlapping host: ~N^3 forced hit tests for N stacked open hosts,
      // measured at seconds of jank inside a single pointerdown. The set bounds the whole walk
      // to one visit per root, ~N+1 calls.
      if (!n.shadowRoot || seen.has(n.shadowRoot)) continue;
      const hit = mediaAtPoint(n.shadowRoot, x, y, depth + 1, seen);
      if (hit) return hit;
    }
    return null;
  }
  function mediaUnderPointer(e) {
    // The composed path is the precise answer whenever the media element IS the target or an
    // ancestor of it, and it reaches into shadow trees for free.
    const path = typeof e.composedPath === "function" ? e.composedPath() : [];
    for (const n of path) if (isMedia(n)) return n;
    // Otherwise the target is a transparent cover painted over the video, which is how most real
    // players are built. Then only the point itself knows.
    if (typeof e.clientX !== "number") return null;
    return mediaAtPoint(document, e.clientX, e.clientY, 0, new Set());
  }

  // Everything the one-shot hook needs to be safe, decided without a single await.
  function hookableNow(el) {
    const a = assess(el);
    if (!a.safe) return false;
    if (a.reason === "same-origin" && !chainOkNow(el.currentSrc || el.src || "")) return false;
    return true;
  }

  // Ceiling on IN-PAGE hook minting. Parked graphs of still-connected elements can never be
  // reclaimed (closing their ctx silences them permanently), so on a feed that keeps every
  // clicked video in the DOM each in-page hook grows retired[] by one - and unlike the worker
  // path, the page controls how often the in-page paths fire. Past the ceiling they refuse and
  // the signal falls back to the ping: boosting still works, at worker pace (~200ms) and
  // worker-rate-limited growth, exactly the pre-1.1.7 behavior. Re-adopting a parked graph
  // never grows the list and stays allowed.
  const PARK_MAX = 16;

  // Move the hook onto `el` and apply the armed level. Returns false if the element could not be
  // taken, in which case nothing has been changed.
  function adopt(el) {
    // Was this element hooked before and merely parked (scrolled out and back)? Then re-adopt
    // its graph - a second createMediaElementSource on the same element throws.
    let node = null;
    if (!retired.some((g) => g.el === el)) {
      // Checked BEFORE creating the source node: createMediaElementSource reroutes the element
      // the moment it exists, so bailing after creating it would leave the element silent.
      if (retired.length >= PARK_MAX) return false;
      // Build the source node BEFORE anything is torn down: if the element turns out to be
      // hooked already (by us with a lost graph, or by the page itself), this throws and the
      // live hook is left exactly as it was.
      try { node = hotCtx.createMediaElementSource(el); } catch (_) { return false; }
      ours.add(el);
      // No graph points at that node yet, so the reclaim pass inside retireCurrent could close
      // its context out from under it.
      ctxPin = hotCtx;
    }
    retireCurrent();
    ctxPin = null;
    if (node) {
      buildGraph(node, el, armedGain);
    } else {
      const g = retired.splice(retired.findIndex((x) => x.el === el), 1)[0];
      S.ctx = g.ctx; S.src = g.src; S.gain = g.gain; S.limiter = g.limiter; S.analyser = g.analyser; S.el = g.el;
    }
    // Set, not ramped: the element is silent right now, so there is nothing to glide from, and a
    // ramp would still be climbing when the site unmutes.
    S.useLimiter = armedLimiter;
    try { S.gain.gain.setValueAtTime(armedGain, S.ctx.currentTime); } catch (_) {}
    applyLimiter(armedLimiter, true);
    S.engaged = true;
    watchElement(el);
    return true;
  }

  function preHook(e) {
    // Cheap gates first: this runs on every pointerdown anywhere in the frame, and the element
    // lookup below forces a layout.
    if (armedGain == null || cmdBusy) return;
    if (!hotCtx || hotCtx.state !== "running") return;
    const el = mediaUnderPointer(e);
    if (!el || el === S.el) return; // already ours → the gain node is applying it already
    if (!hookableNow(el)) return;
    adopt(el);
  }

  // Feeds that unmute the next clip BY THEMSELVES as you scroll never reach preHook: there is no
  // pointer event to hang it on. The unmute itself is then the only signal there is, and it
  // arrives in the volumechange listener below. Taking the hook right there is the same trade as
  // preHook, one step later: the gain node lands in the same render quantum the unmute takes
  // effect in, instead of a worker roundtrip later.
  //
  // Budgeted, because unlike a gesture this is a plain property write, which a page can produce
  // at will, and every hook it triggers is one-shot and irreversible. 12 in a rolling 10s is far
  // above any human scrolling rate. Once it is spent the signal degrades to the ping it was
  // before: correct, just back to ~200ms.
  const AUTO_HOOK_WINDOW = 10000;
  let autoHookBudget = 12;
  let autoHookReset = 0;
  function autoHook(el) {
    if (armedGain == null || cmdBusy) return false;
    if (!hotCtx || hotCtx.state !== "running") return false;
    // The same rule the worker's engage switch follows: never take the hook off an element that
    // is still playing AUDIBLY. An ad starting over a running video would otherwise steal it,
    // and unlike a click there is no user intent here to justify that. A muted or zero-volume
    // holder is different: stealing from it is inaudible by definition, and refusing would hold
    // the hook hostage on a silent hero loop while the real media plays at native level - the
    // loop never pauses, so that state would be sticky for the page's whole life.
    const cur = S.el;
    if (S.engaged && cur && cur.isConnected && !cur.paused && !cur.ended && !cur.muted && cur.volume > 0)
      return false;
    if (!hookableNow(el)) return false;
    const now = performance.now();
    if (now > autoHookReset) { autoHookBudget = 12; autoHookReset = now + AUTO_HOOK_WINDOW; }
    if (autoHookBudget <= 0) return false;
    // Charged only for a hook actually MINTED. The budget bounds the irreversible resource (a
    // one-shot createMediaElementSource per element); a failed adopt mints nothing, so it costs
    // nothing - otherwise a page whose own player fades el.volume (its element is foreign-hooked,
    // so every attempt throws) would drain the whole allowance for free and push every genuine
    // unmute back onto the slow path. Refusals above cost nothing for the same reason.
    // Re-adopting a PARKED graph mints nothing (the one-shot was spent long ago), so it is
    // free, like every other non-minting outcome: a feed muting/unmuting between two already-
    // hooked clips must not drain the allowance a genuinely new element will need.
    const parked = retired.some((g) => g.el === el);
    if (!adopt(el)) return false;
    if (!parked) autoHookBudget--;
    return true;
  }

  async function engage(gain, useLimiter) {
    S.useLimiter = useLimiter !== false;
    // The level belongs to the TAB, so every graph in this frame carries it, parked ones
    // included. Their elements are usually idle, but preHook parks on pointerdown - before the
    // site has paused anything - so a parked element can still be audible, and one that resumes
    // later must not come back at a level the user has since moved away from.
    for (const g of retired) setLevel(g, gain, S.useLimiter);

    // Already hooked → normally just update gain (no re-hook, no disconnect click). But first
    // check the page didn't move on to a NEW element while keeping the old node in the DOM
    // (a player that builds a fresh <video> per episode): updating the idle old hook would
    // leave the actually-playing element unboosted. Only switch on clear evidence.
    if (S.engaged && S.ctx) {
      const cur = S.el;
      const next = pickElement();
      // A muted/zero-volume current hook counts as idle: it contributes nothing audible, so
      // handing off is silent - and NOT handing off is the hostage state, because a muted hero
      // loop never pauses and would block the audible media forever (the popup showing green
      // element mode at a level nobody hears). The parked graph keeps the tab level, so if the
      // loop is ever unmuted it resumes correctly.
      const curSilent = !!cur && (cur.muted || cur.volume === 0);
      const curIdle = !cur || !cur.isConnected || cur.paused || cur.ended || curSilent;
      const nextPlaying = !!next && next !== cur && !next.paused && !next.ended && next.readyState >= 2;
      // AUDIBLE is required: muted autoplaying elements (hero loops, hover previews) must never
      // steal the hook from a merely-paused main video - that would be sticky, since the loop
      // keeps "playing" forever and the real player would resume at native volume.
      const nextAudible = nextPlaying && !next.muted && next.volume > 0;
      // HOOKABLE is required too: an audible cross-origin ad video during an ad break would
      // otherwise open the gate, retire the content's live hook, and then be REFUSED by the
      // fresh path's assess - content unboosted, worker falling back to capture (fullscreen
      // lost) for the ad's lifetime. Unhookable interlopers just play at native volume.
      // The redirect verdict is part of hookability HERE, not only after the retire: a
      // same-origin src that 302s cross-origin passes assess, and discovering the refusal
      // only after retireCurrent() would sacrifice the live hook for an element that can never
      // be hooked - terminal capture for the tab. So for same-origin candidates the verdict is
      // AWAITED before anything is torn down; the current hook stays untouched while the probe
      // runs, and a negative simply keeps the fast path (the interloper plays at native volume,
      // the documented tradeoff).
      let nextHookable = false;
      if (nextAudible) {
        const na = assess(next);
        if (na.safe) {
          nextHookable = na.reason !== "same-origin"
            ? true
            : await sameOriginChainOk(next.currentSrc || next.src || "");
        }
      }
      if (!(curIdle && nextHookable)) {
        // A fresh episode's video often autoplays MUTED and unmutes a beat later. The document-
        // level volumechange capture listener (below the swapMo setup) re-pings the moment any
        // element's volume state changes, so nothing needs to be armed per element here.
        S.gain.gain.setTargetAtTime(gain, S.ctx.currentTime, 0.02);
        applyLimiter(S.useLimiter, false);
        return { ok: true, engaged: true };
      }
      // The outgoing graph is parked AS-IS, so it must carry the level of THIS engage, not the
      // one it was last set to: the user may have moved the slider since (say 5.0 down to 1.5),
      // and a non-pointer resume of the old element later (playlist loop, keyboard play, media
      // session) fires no signal that would correct it - it would blast the stale level while
      // the popup shows the new one. The retired-sync loop above ran before this graph joined.
      setLevel(S, gain, S.useLimiter);
      retireCurrent(); // park the outgoing hook at the tab level; fall through to hook the live element
    }

    const el = pickElement();
    if (!el) return { ok: false, reason: "no-element" };

    // If we've hooked this exact element before (swapped out, now back), re-adopt its parked
    // graph - a second createMediaElementSource on the same element would throw.
    const back = retired.findIndex((g) => g.el === el);
    if (back >= 0) {
      const g = retired.splice(back, 1)[0];
      S.ctx = g.ctx; S.src = g.src; S.gain = g.gain; S.limiter = g.limiter; S.analyser = g.analyser; S.el = g.el;
      try { await S.ctx.resume(); } catch (_) {}
      if (S.ctx.state === "running") hotCtx = S.ctx;
      S.gain.gain.setTargetAtTime(gain, S.ctx.currentTime, 0.02);
      applyLimiter(S.useLimiter, false);
      S.engaged = true;
      watchElement(el);
      const mm = await measure(measureBudget(el));
      return { ok: true, engaged: true, signal: mm.signal };
    }

    const a = assess(el);
    if (!a.safe) return { ok: false, reason: a.reason };
    // 'same-origin' by URL alone isn't proof: verify the redirect chain before the one-shot hook.
    const probedSrc = el.currentSrc || el.src || "";
    if (a.reason === "same-origin" && !(await sameOriginChainOk(probedSrc)))
      return { ok: false, reason: "cross-origin-redirect" };

    // Reuse the frame's proven context when there is one. A fresh context starts SUSPENDED, so
    // the resume dance below costs time on every hook and, on a page the autoplay policy hasn't
    // unlocked yet, refuses outright. Reusing a context we already watched reach 'running' skips
    // both - and it is the same reuse that makes the synchronous pre-hook possible.
    let ctx = hotCtx && hotCtx.state === "running" ? hotCtx : null;
    const freshCtx = !ctx;
    if (freshCtx) {
      try { ctx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch { return { ok: false, reason: "no-audiocontext" }; }

      // Confirm the context can actually RUN before hooking - hooking into a suspended
      // context would silence the element. If it won't run, bail (nothing hooked yet).
      try { await ctx.resume(); } catch (_) {}
      if (ctx.state !== "running") await new Promise((r) => setTimeout(r, 150));
      if (ctx.state !== "running") {
        try { ctx.close(); } catch (_) {}
        armGestureRetry(); // first click/key in this frame unlocks audio → auto-retry then
        return { ok: false, reason: "suspended" };
      }
    }

    // Final pre-hook re-check: the probe/resume awaits above can take up to CHAIN_TOTAL_MAX (a
    // late joiner re-arms the redirect probe's deadline) plus the resume wait, so several
    // seconds, and a player may rotate its src meanwhile (ad stitching). The one-shot hook lands
    // on the ELEMENT, so it must still show exactly what was assessed - otherwise refuse; the
    // next engage re-gates the new src.
    const a2 = assess(el);
    if (!a2.safe || (el.currentSrc || el.src || "") !== probedSrc) {
      if (freshCtx) { try { ctx.close(); } catch (_) {} } // a shared context still has graphs on it
      return { ok: false, reason: "src-changed" };
    }

    let src;
    try { src = ctx.createMediaElementSource(el); }
    catch {
      if (freshCtx) { try { ctx.close(); } catch (_) {} }
      // A hook of OURS whose graph is gone (parked, then reclaimed after its element left the
      // DOM). Retrying can't undo a one-shot hook, but it is not the foreign-app conflict the
      // popup explains to the user either - so say which one it is.
      return { ok: false, reason: ours.has(el) ? "own-hook-lost" : "already-hooked" };
    }
    ours.add(el);
    hotCtx = ctx;

    buildGraph(src, el, gain);
    applyLimiter(S.useLimiter, true);
    S.engaged = true;
    watchElement(el);

    const m = await measure(measureBudget(el));
    return { ok: true, engaged: true, signal: m.signal };
  }

  // 1.0× / off: ramp to a unity passthrough - gain 1 and the limiter bypassed (ratio 1), so it's
  // level/frequency-transparent (a constant ~6ms compressor pre-delay remains, but it's imperceptible).
  // createMediaElementSource can't be un-hooked, and closing the context would silence the rerouted
  // element, so we keep the context open at unity. Ramping (not disconnecting) → no click on release.
  function setLevel(g, gain, limiterOn) {
    try {
      g.gain.gain.setTargetAtTime(gain, g.ctx.currentTime, 0.02);
      g.limiter.ratio.setTargetAtTime(limiterOn ? 20 : 1, g.ctx.currentTime, 0.02);
      g.limiter.threshold.setTargetAtTime(limiterOn ? -3 : 0, g.ctx.currentTime, 0.02);
    } catch (_) {}
  }
  const unwind = (g) => setLevel(g, 1, false);
  function stop() {
    armedGain = null; // this frame is no longer the tab's boosted one → no pre-hooking on its own
    // Parked graphs hold the tab's level now, so a release has to reach them too: otherwise an
    // element that resumes later would still be boosted while the popup reads 1.0×.
    for (const g of retired) unwind(g);
    if (!S.engaged || !S.ctx) return { ok: true };
    unwind(S);
    return { ok: true };
  }

  // engage/stop run strictly one at a time in this frame: two concurrent engages could both pass
  // the S.engaged check and race createMediaElementSource - the loser would throw and be
  // misreported as an 'already-hooked' CONFLICT, making the worker stack capture on top of the
  // live element hook (double gain). The queue makes the second call see the first one's result.
  // cmdBusy marks the window in which the queued call owns S: preHook runs OUTSIDE this queue
  // (it has to, a gesture can't wait) and must never retire a graph an in-flight engage is
  // halfway through building.
  let cmdChain = Promise.resolve();
  function enqueue(fn) {
    const run = () => { cmdBusy++; return Promise.resolve().then(fn).finally(() => { cmdBusy--; }); };
    const p = cmdChain.then(run, run);
    cmdChain = p.then(() => {}, () => {});
    return p;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.cmd) return;

    if (msg.cmd === "probe") {
      // Non-destructive capability report. Frames with no element stay silent.
      // Ranked ONCE: rankElements measures every media element, and this handler needs the list
      // three times (winner, safe stand-in, warm loop).
      const ranked = rankElements();
      if (!ranked.length) return;
      let pick = ranked[0];
      let el = pick.el;
      let a = assess(el);
      // If the top pick is unhookable, it may be a transient interloper (a cross-origin ad
      // video playing over the paused content player). Mode prediction should see the best
      // SAFE element when one exists - engage() re-verifies against the live DOM anyway, and
      // pages whose ONLY media is unhookable (DRM) still report that honestly below.
      let substituted = false;
      if (!a.safe) {
        const alt = ranked.find((s) => assess(s.el).safe);
        if (alt) { pick = alt; el = alt.el; a = assess(el); substituted = true; }
      }
      // Warm the redirect check now (fire-and-forget) so a following engage hits the cache.
      // EVERY safe same-origin candidate, not just the winner: the element the user ends up on
      // is often not today's top pick (an ad interloper outranks it, or they click a different
      // post), and a cold verdict costs the engage the probe's full wait.
      // Bounded at 2 new REQUESTS per probe (not candidate slots - counting cache hits would let
      // the top picks permanently consume the budget and never warm the rest) AND at
      // WARM_TOTAL_MAX distinct srcs for this frame's lifetime, since probes are frequent (every
      // popup open, every setGain, once per restore iteration) and a per-probe cap alone would
      // still walk a long gallery. Media the page has not started loading is skipped entirely: a
      // preload="none" gallery would otherwise get credentialed range requests for clips the user
      // never played, which the site may count as views.
      let warmed = 0;
      for (const s of ranked) {
        if (warmed >= 2 || warmedTotal >= WARM_TOTAL_MAX) break;
        const src = s.el.currentSrc;
        if (!src || (s.el.paused && s.el.readyState < 2)) continue;
        const sa = assess(s.el);
        if (!sa.safe || sa.reason !== "same-origin") continue;
        const before = chainVerdicts.get(src);
        sameOriginChainOk(src);
        if (chainVerdicts.get(src) !== before) { warmed++; warmedTotal++; } // a NEW entry = a real request
      }
      try {
        chrome.runtime.sendMessage({
          type: "frameCandidate",
          cand: {
            hasElement: true,
            safe: a.safe,
            reason: a.reason,
            area: pick.area, // already measured by rankElements - no second layout read
            playing: !el.paused && !el.ended && el.readyState >= 2,
            audible: !el.muted && el.volume > 0,
            // a stand-in for an unhookable top pick: fine for mode prediction, but the worker
            // must not let it shortcut the probe window (see predictMode's early-resolve gate)
            substituted
          }
        });
      } catch (_) {}
      return; // reported via separate message, no response
    }

    if (msg.cmd === "engage") {
      // The .catch guarantees a response even if engage throws - otherwise the worker's await
      // would hang forever (it holds the 'restoring' lock during reload-restores).
      enqueue(() => engage(msg.gain, msg.useLimiter))
        .then((res) => {
          // Arm the pre-hook. A successful engage is the worker telling this frame two things:
          // it is the tab's element-mode frame, and this is the level. Only an armed frame may
          // hook on its own - a frame the worker has since routed to capture must not stack an
          // element hook underneath the capture gain (that would be double volume).
          if (res && res.ok) { armedGain = msg.gain; armedLimiter = msg.useLimiter !== false; }
          sendResponse(res);
        })
        .catch(() => { try { sendResponse({ ok: false, reason: "error" }); } catch (_) {} });
      return true;
    }
    if (msg.cmd === "stop") {
      enqueue(async () => stop())
        .then(sendResponse)
        .catch(() => { try { sendResponse({ ok: true }); } catch (_) {} });
      return true;
    }
    if (msg.cmd === "measure") {
      // Read-only look at the LIVE graph: is audio flowing, and how loud after the gain? Unlike
      // engage this never touches the level, so it can verify what the in-page paths (preHook /
      // autoHook) applied on their own - engage would overwrite the very value under test.
      // Queued like the others so it can't read a graph an engage is halfway through replacing.
      enqueue(async () => {
        if (!S.engaged || !S.analyser) return { ok: false, parked: retired.length };
        const m = await measure(600, true);
        return { ok: true, signal: m.signal, rms: m.rms, parked: retired.length };
      })
        .then(sendResponse)
        .catch(() => { try { sendResponse({ ok: false }); } catch (_) {} });
      return true;
    }
  });
})();
