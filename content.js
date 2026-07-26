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

  function makeLimiter(ctx) {
    const c = ctx.createDynamicsCompressor();
    c.threshold.value = -3; c.knee.value = 0; c.ratio.value = 20;
    c.attack.value = 0.003; c.release.value = 0.25;
    return c;
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
  function measure(timeout = 1200) {
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
          if (peak > 0.0008) return res({ signal: true, rms: peak });
          if (performance.now() - t0 > timeout) return res({ signal: false, rms: peak });
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
  // one-shot and closing a ctx silences its element FOREVER, so a retired graph is parked at
  // unity (transparent) with its ctx kept OPEN, and re-adopted by engage() if its element comes
  // back (theater-mode re-parenting, episode flip that reuses the node, a long detach). Bounded:
  // beyond 3 parked graphs the oldest is closed for real - its element is long gone by then.
  const retired = [];
  function retireCurrent() {
    try { if (S.mo) S.mo.disconnect(); } catch (_) {}
    if (S.ctx) {
      try {
        S.gain.gain.setTargetAtTime(1, S.ctx.currentTime, 0.02);
        S.limiter.ratio.setTargetAtTime(1, S.ctx.currentTime, 0.02);
        S.limiter.threshold.setTargetAtTime(0, S.ctx.currentTime, 0.02);
      } catch (_) {}
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
        try { g.ctx.close(); } catch (_) {}
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
  let lastGestureAt = -100000;
  let gestureUrgentLeft = 0;
  let gestureArmed = false; // engage() found a suspended AudioContext; retry on the next gesture
  const GESTURE_WINDOW = 1000;
  const noteGesture = (e) => {
    if (!e.isTrusted || (e.type === "keydown" && e.repeat)) return;
    lastGestureAt = performance.now();
    gestureUrgentLeft = 2;
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
  const swapMo = new MutationObserver((muts) => { if (touchesMedia(muts)) pingNavigated(); });
  swapMo.observe(document.documentElement, {
    childList: true, subtree: true, attributes: true, attributeFilter: ["src"]
  });
  // Unmutes are INVISIBLE to the observer above: muted/volume are properties, not attributes.
  // volumechange doesn't bubble, but a CAPTURE listener on an ancestor still sees it - one
  // document-level listener covers every media element, present or future. Urgent only when the
  // element just became actionable (audibly playing); wiggles on muted/paused elements take the
  // churn path. Our own hooked element is skipped: its gain node already applies.
  document.addEventListener("volumechange", (e) => {
    const el = e.target;
    if (!el || el.tagName !== "VIDEO" && el.tagName !== "AUDIO") return;
    if (el === S.el) return;
    pingNavigated(!el.muted && el.volume > 0 && !el.paused);
  }, true);
  // SPA route changes that fire DOM-visible events. (history.pushState is invisible
  // from this isolated world - the worker catches those via tabs.onUpdated url changes.)
  window.addEventListener("popstate", pingNavigated);
  window.addEventListener("hashchange", pingNavigated);

  async function engage(gain, useLimiter) {
    S.useLimiter = useLimiter !== false;

    // Already hooked → normally just update gain (no re-hook, no disconnect click). But first
    // check the page didn't move on to a NEW element while keeping the old node in the DOM
    // (a player that builds a fresh <video> per episode): updating the idle old hook would
    // leave the actually-playing element unboosted. Only switch on clear evidence.
    if (S.engaged && S.ctx) {
      const cur = S.el;
      const next = pickElement();
      const curIdle = !cur || !cur.isConnected || cur.paused || cur.ended;
      const nextPlaying = !!next && next !== cur && !next.paused && !next.ended && next.readyState >= 2;
      // AUDIBLE is required: muted autoplaying elements (hero loops, hover previews) must never
      // steal the hook from a merely-paused main video - that would be sticky, since the loop
      // keeps "playing" forever and the real player would resume at native volume.
      const nextAudible = nextPlaying && !next.muted && next.volume > 0;
      // HOOKABLE is required too: an audible cross-origin ad video during an ad break would
      // otherwise open the gate, retire the content's live hook, and then be REFUSED by the
      // fresh path's assess - content unboosted, worker falling back to capture (fullscreen
      // lost) for the ad's lifetime. Unhookable interlopers just play at native volume.
      const nextHookable = nextAudible && assess(next).safe;
      if (!(curIdle && nextHookable)) {
        // A fresh episode's video often autoplays MUTED and unmutes a beat later. The document-
        // level volumechange capture listener (below the swapMo setup) re-pings the moment any
        // element's volume state changes, so nothing needs to be armed per element here.
        S.gain.gain.setTargetAtTime(gain, S.ctx.currentTime, 0.02);
        applyLimiter(S.useLimiter, false);
        return { ok: true, engaged: true };
      }
      retireCurrent(); // park the idle hook at unity and fall through to hook the live element
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

    let ctx;
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

    // Final pre-hook re-check: the probe/resume awaits above can take up to CHAIN_TOTAL_MAX (a
    // late joiner re-arms the redirect probe's deadline) plus the resume wait, so several
    // seconds, and a player may rotate its src meanwhile (ad stitching). The one-shot hook lands
    // on the ELEMENT, so it must still show exactly what was assessed - otherwise refuse; the
    // next engage re-gates the new src.
    const a2 = assess(el);
    if (!a2.safe || (el.currentSrc || el.src || "") !== probedSrc) {
      try { ctx.close(); } catch (_) {}
      return { ok: false, reason: "src-changed" };
    }

    let src;
    try { src = ctx.createMediaElementSource(el); }
    catch { try { ctx.close(); } catch (_) {} return { ok: false, reason: "already-hooked" }; }

    S.ctx = ctx; S.src = src; S.el = el;
    S.gain = ctx.createGain(); S.gain.gain.value = gain;
    S.limiter = makeLimiter(ctx);
    S.analyser = ctx.createAnalyser(); S.analyser.fftSize = 256;
    // Static graph - the limiter is ALWAYS in the path (src→gain→limiter→analyser→destination);
    // it's toggled by ramping its ratio, never by rewiring, so toggling can't click.
    S.src.connect(S.gain);
    S.gain.connect(S.limiter);
    S.limiter.connect(S.analyser);
    S.analyser.connect(ctx.destination); // analyser is a passthrough → also feeds output
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
  function stop() {
    if (!S.engaged || !S.ctx) return { ok: true };
    try {
      S.gain.gain.setTargetAtTime(1, S.ctx.currentTime, 0.02);
      applyLimiter(false, false);
    } catch (_) {}
    return { ok: true };
  }

  // engage/stop run strictly one at a time in this frame: two concurrent engages could both pass
  // the S.engaged check and race createMediaElementSource - the loser would throw and be
  // misreported as an 'already-hooked' CONFLICT, making the worker stack capture on top of the
  // live element hook (double gain). The queue makes the second call see the first one's result.
  let cmdChain = Promise.resolve();
  function enqueue(fn) {
    const p = cmdChain.then(fn, fn);
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
        .then(sendResponse)
        .catch(() => { try { sendResponse({ ok: false, reason: "error" }); } catch (_) {} });
      return true;
    }
    if (msg.cmd === "stop") {
      enqueue(async () => stop())
        .then(sendResponse)
        .catch(() => { try { sendResponse({ ok: true }); } catch (_) {} });
      return true;
    }
  });
})();
