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
  // select.js is injected right before this file. A frame without it waits for the next
  // injection instead of running without the rule. Checked as the real object and kept in a
  // local: a page element with id or name "vbSelect" shows up on window as well (named access).
  if (window.__VB_INIT__ || !(globalThis.vbSelect && typeof globalThis.vbSelect.choose === "function")) return;
  window.__VB_INIT__ = true;
  const select = globalThis.vbSelect;

  const S = {
    ctx: null, src: null, gain: null, limiter: null, analyser: null,
    el: null, engaged: false, useLimiter: true, mo: null
  };

  // The last AudioContext this frame confirmed RUNNING. One context can host any number of
  // graphs, so we keep the proven one instead of building a fresh (and initially SUSPENDED) one
  // per hook: resuming is asynchronous, and on a page with no user activation yet it may not
  // succeed at all. Reusing it is what lets a hook be created synchronously (see preHook).
  let hotCtx = null;
  // Elements this frame has ever routed through createMediaElementSource. The hook is one-shot,
  // so a second attempt on the same element throws - and reporting that as 'already-hooked' would
  // tell the user another app owns their player. Ours must never masquerade as someone else's.
  const ours = new WeakSet();
  // When each element last sounded (played unmuted) in this document. A clip no hook can take
  // that sounded lately can sound again, and that is what keeps a capture in place on a feed that
  // mixes such clips with hookable ones (the worker's sticky capture). It counts for
  // HEARD_WINDOW_MS after it last sounded: an ad element a player keeps after its break ages out.
  const soundedAt = new WeakMap();
  const HEARD_WINDOW_MS = 120000;
  const sounded = (el) => soundedAt.set(el, performance.now());
  // Elements that have played in this document. A content player paused for an ad has, a decoy
  // that took the level while nothing sounded has not (select.js associated).
  const playedMedia = new WeakSet();

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

  // Non-destructive: decide if this element is safe to hook WITHOUT touching it.
  function assess(el) {
    if (el.mediaKeys) return { safe: false, reason: "drm" };
    // Media Source Extensions attached through srcObject - the MediaSource lives in a worker, the
    // way live-stream players run it: no URL at all, but the same demuxer as an MSE blob: URL, fed
    // only with bytes the page itself could read, so it can never be cross-origin tainted
    // (measured on a live-streaming site: the audio flows through the hook). Any OTHER srcObject,
    // a MediaStream, stays unhookable below ('no-src'): its media's origin cannot be checked here.
    if (el.srcObject && Object.prototype.toString.call(el.srcObject) === "[object MediaSourceHandle]")
      return { safe: true, reason: "mse-handle" };
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

  // Every media element of this frame: the document's own first, so they win a tie, then those
  // of every registered shadow root whose host is in the DOM (see "shadow DOM" below). The probe's
  // report and the engage's choice both start from this one collector, so the worker and the
  // engage never decide over different elements.
  // It reads the registry as it stands and never walks the page. Where a full walk is in flight
  // or due, the probe reports once more when it is complete, and an engage that holds no element
  // waits for it first (dueWalk and walked, in "shadow DOM" below).
  function mediaElements() {
    const els = Array.from(document.querySelectorAll("video, audio"));
    for (const r of mediaRoots) {
      if (!r.host.isConnected) { mediaRoots.delete(r); continue; }
      for (const el of r.querySelectorAll("video, audio")) els.push(el);
    }
    return els;
  }

  // assess(), plus what the redirect check has found already: a same-origin URL that redirects
  // to another origin is no safer than one served from there. Held only for the negative's
  // lifetime, so a later check can clear it.
  function verdict(el) {
    const a = assess(el);
    if (a.reason !== "same-origin") return a;
    const e = chainVerdicts.get(el.currentSrc || el.src || "");
    if (e && e.ok === false && performance.now() - e.at <= CHAIN_NEG_TTL) return { safe: false, reason: "cross-origin-redirect" };
    return a;
  }

  // The frame's media elements as select.js reads a candidate, best first. Each entry also
  // carries its element. The hooked element is always among them, also where the collector
  // misses it: a held element that is still connected after its root left the registry (the page
  // moved it into a closed root, whose host then left the DOM and came back, and no walk can enter
  // a closed root again). Left out, it could not count as held, and the rule would move the level
  // off a player the user is listening to.
  // given: the elements walkDue() collected a moment ago, in the same task. One that a microtask of
  // the page took out since is dropped.
  function describe(given) {
    const els = given ? given.filter((el) => el.isConnected) : mediaElements();
    if (S.engaged && S.el && S.el.isConnected && !els.includes(S.el)) els.push(S.el);
    const now = performance.now();
    return els.map((el) => {
      const r = el.getBoundingClientRect();
      const w = Math.max(0, r.width), h = Math.max(0, r.height);
      const a = verdict(el);
      const playing = !el.paused && !el.ended && el.readyState >= 2;
      const audible = !el.muted && el.volume > 0;
      if (playing) playedMedia.add(el);
      if (playing && audible) soundedAt.set(el, now);
      const at = soundedAt.get(el);
      return {
        el, safe: a.safe, reason: a.reason, playing, ended: el.ended, audible,
        area: w * h,
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(w), h: Math.round(h) },
        held: S.engaged && el === S.el && armedGain != null,
        heard: at !== undefined && now - at <= HEARD_WINDOW_MS,
        played: playedMedia.has(el),
        video: el.tagName === "VIDEO",
        frame: "self",
      };
    }).sort(select.byRank);
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
  // one-shot, and an element that plays while its source node is disconnected, or its context
  // closed, is silent and stalls: Chrome stops pulling its audio, so its playback never advances.
  // So no graph is ever let go, no context that has a graph is ever closed, and a retired graph is
  // re-adopted by engage() or an in-page hook if its element comes back (theater-mode
  // re-parenting, episode flip that reuses the node, a feed that puts the same node back when it
  // is scrolled up again).
  //
  // A parked graph keeps THE TAB'S LEVEL rather than dropping to unity. The outgoing element is
  // usually idle, but preHook retires on pointerdown - before the site has paused anything - and
  // a ducked tab jumping to native level for even a few frames is exactly the ear-blast this
  // path exists to remove. It is also the right level for an element that comes back: it resumes
  // boosted (or ducked) instead of native. stop() unwinds parked graphs on release.
  //
  // A parked graph whose element is paused (or has ended) is DORMANT: its source node is
  // disconnected, which takes the graph off the audio thread, and it leaves the parked list. What
  // remembers it is a map keyed by the element, which keeps nothing alive, and a 'play' and a
  // 'playing' listener on the element itself, which hear the element wherever it is: in the
  // document, in any root (closed ones too), or out of the DOM. The first of them to fire puts
  // the source back synchronously, at the level the parked graphs carry at that moment (unity
  // after a release), and the graph is parked again. 'play' comes before any audio. 'playing' is
  // there for a page that stops 'play' before it reaches the element, and wakes the graph a few ms
  // late. Measured on Chrome 157 (2026-10-25, 20 trials each at 1x and 4x CPU, in the DOM and out
  // of it): playback and sound start within 16 ms of play() (median 6 ms at 1x, 10 ms at 4x), the
  // graph's output is at the level from its first sample, and no element stalls. A graph whose
  // element still plays when it is parked (preHook) goes dormant at its element's next pause or
  // unload. An unload by removeAttribute('src') and load() pauses the element without a pause
  // event, so 'emptied' counts as well. A pause whose event never reaches the element sends the
  // graph to sleep at the latest when this frame next takes or gives up a hook.
  const retired = [];
  const dormant = new WeakMap();
  // The level the parked graphs carry, which a graph takes when it wakes: { gain, limiter }, or
  // null for unity with the limiter bypassed. An engage sets it as it syncs the parked graphs, an
  // arm sets the level it arms, and a release or an orphaned world's standdown clears it.
  // armedGain is not that level: an engage changes it only once it is done, which can be seconds
  // after it synced the parked graphs.
  let parkLevel = null;
  function retireCurrent() {
    try { if (S.mo) S.mo.disconnect(); } catch (_) {}
    if (S.ctx) park({ ctx: S.ctx, src: S.src, gain: S.gain, limiter: S.limiter, analyser: S.analyser, el: S.el });
    S.ctx = S.src = S.gain = S.limiter = S.analyser = S.el = S.mo = null;
    S.engaged = false;
    dozePaused();
  }
  // Into the parked list, dormant at once where its element is paused already. The element's
  // pause and emptied listeners send it to sleep later, unless the page has started it again by
  // the time the event arrives.
  function park(g) {
    retired.push(g);
    g.onPause = g.onPause || (() => { if (g.el.paused || g.el.ended) doze(g); });
    g.el.addEventListener("pause", g.onPause, true);
    g.el.addEventListener("emptied", g.onPause, true);
    if (g.el.paused || g.el.ended) doze(g);
  }
  // Out of the parked list, to be the hook again (adopt, engage).
  function unpark(i) {
    const g = retired.splice(i, 1)[0];
    g.el.removeEventListener("pause", g.onPause, true);
    g.el.removeEventListener("emptied", g.onPause, true);
    return g;
  }
  function doze(g) {
    const i = retired.indexOf(g);
    if (i < 0) return;
    unpark(i);
    try { g.src.disconnect(); } catch (_) {}
    dormant.set(g.el, g);
    g.onPlay = g.onPlay || (() => wake(g));
    g.el.addEventListener("play", g.onPlay, true);
    g.el.addEventListener("playing", g.onPlay, true);
  }
  // Every parked graph whose element is paused or has ended goes to sleep. This is the backstop
  // for a pause whose event never reaches the element (a page can stop it on the way). adopt runs
  // it before it checks PARK_MAX, and every retire runs it.
  function dozePaused() {
    for (const g of retired.slice()) if (g.el.paused || g.el.ended) doze(g);
  }
  // In the element's play event, or right before a path takes the element: the source is back
  // on its graph before the element renders any audio, and the graph is parked again.
  function wake(g) {
    if (dormant.get(g.el) !== g) return;
    dormant.delete(g.el);
    g.el.removeEventListener("play", g.onPlay, true);
    g.el.removeEventListener("playing", g.onPlay, true);
    // An orphaned world sets no level and keeps nothing: the element plays at its own level.
    if (checkOrphaned()) {
      try { g.src.connect(g.ctx.destination); } catch (_) {}
      return;
    }
    const lvl = parkLevel;
    const limit = !!lvl && lvl.limiter;
    try {
      // Set, not ramped: nothing has played through the graph since it went dormant.
      const t = g.ctx.currentTime;
      for (const [p, v] of [[g.gain.gain, lvl ? lvl.gain : 1], [g.limiter.ratio, limit ? 20 : 1], [g.limiter.threshold, limit ? -3 : 0]]) {
        p.cancelScheduledValues(t);
        p.setValueAtTime(v, t);
      }
      g.src.connect(g.gain);
    } catch (_) {}
    retired.push(g);
    g.el.addEventListener("pause", g.onPause, true);
    g.el.addEventListener("emptied", g.onPause, true);
  }
  // Where el's parked graph sits in the parked list, after waking it if it is dormant, or -1.
  function parkedAt(el) {
    const d = dormant.get(el);
    if (d) wake(d);
    return retired.findIndex((g) => g.el === el);
  }

  // The trees between an element and the document. Removing an ancestor anywhere on this path
  // disconnects the element, and an observer on the document sees only the outermost step: a
  // player that drops its video inside its own shadow root leaves no record there.
  function treesAbove(el) {
    const out = [];
    let r = el.getRootNode();
    while (isShadowRoot(r)) { out.push(r); r = r.host.getRootNode(); }
    out.push(r === document ? document.documentElement : r);
    return out;
  }
  function watchElement(el) {
    try { if (S.mo) S.mo.disconnect(); } catch (_) {}
    let checking = false;
    let path = [];
    const follow = () => {
      mo.disconnect();
      path = treesAbove(el);
      for (const t of path) { try { mo.observe(t, { childList: true, subtree: true }); } catch (_) {} }
    };
    const moved = () => {
      const now = treesAbove(el);
      return now.length !== path.length || now.some((t, i) => t !== path[i]);
    };
    // Moved into another tree: watch the new path, or a later removal there goes unseen. The new
    // root gets the media listeners as well.
    const rewatch = () => {
      if (S.mo !== mo) return;
      follow();
      listenAt(el);
    };
    const mo = S.mo = new MutationObserver(() => {
      if (checking) return;
      // el.isConnected (not document.contains): an element re-parented INTO a shadow root is still
      // live and audible, but document.contains() reports false for it - tearing down then would
      // close the ctx and permanently silence it (the hook is one-shot).
      if (el.isConnected) {
        if (moved()) rewatch();
        return;
      }
      // The element left the DOM - but a player may be DETACHING then RE-ATTACHING the same node
      // (SPA reconciliation, theater/fullscreen re-parenting). Closing the context now would
      // permanently silence a same-node re-attach (createMediaElementSource is one-shot), so wait
      // a turn and only act if it's really gone.
      checking = true;
      setTimeout(() => {
        checking = false;
        if (el.isConnected) { // came back → keep the live graph, keep watching
          if (S.el === el && moved()) rewatch();
          return;
        }
        if (S.el !== el) return;    // a queued engage already switched hooks - don't retire the successor's live graph
        // Genuinely replaced. Park the graph WITHOUT closing its ctx (a same-node re-attach later
        // would be permanently silent otherwise, and engage() re-adopts parked and dormant
        // graphs), then ask the worker to re-engage on whatever the page shows now.
        retireCurrent();
        try { chrome.runtime.sendMessage({ type: "elementLost" }); } catch (_) {}
      }, 150);
    });
    // The document and every shadow root on the element's way up, 1 to 4 trees on the measured
    // players.
    follow();
    // The hooked element's root carries the media listeners: without them an orphaned world
    // would never see the timeupdate that makes it stand down.
    listenAt(el);
  }
  // Puts the media listeners on el's root. Media that already sound in a root getting them for
  // the first time are missed plays, taken once the hook in progress is done.
  function listenAt(el) {
    if (noteMedia(el)) takeMissed(soundingIn([el.getRootNode()], new Set()), true);
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
    parkLevel = null;
    try { swapMo.disconnect(); } catch (_) {} // one observer: this drops every shadow root as well
    try { if (S.mo) S.mo.disconnect(); } catch (_) {}
    try {
      for (const t of [sweepTimer, pendingTimer, walkTimer, missedTimer]) clearTimeout(t);
      sweepTimer = pendingTimer = walkTimer = missedTimer = null;
      pending.clear();
      missedLater.clear();
      refusedAt.clear();
      mediaRoots.clear();
      cutParts.clear();
      walk = null;
    } catch (_) {}
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
    if (e.type === "pointerdown") {
      try { notePath(e); } catch (_) {}
      try { preHook(e); } catch (_) {}
    }
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
  const REPORT_MAX = 32;            // candidates per probe report, all the worker reads (CAND_MAX)

  const MEDIA_TAGS = /^(IFRAME|VIDEO|AUDIO)$/;
  const SWAP_OPTS = { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] };
  const swapMo = new MutationObserver((muts) => {
    if (checkOrphaned()) return;
    if (scanMutations(muts)) pingNavigated();
  });
  swapMo.observe(document.documentElement, SWAP_OPTS);

  // --- shadow DOM ------------------------------------------------------------
  // Players built from web components keep their <video> inside an open shadow root (measured:
  // every Reddit clip, mux-player, media-chrome). Document queries, observers and listeners do
  // not reach in there, and media events are not composed, so they never leave the root.
  // Every open root this frame meets is therefore registered once: swapMo observes it like the
  // document, and a root that holds media gets the same capture listeners the document has.
  // Observer callbacks cost what changes: one observer serves every root, and an added subtree is
  // walked once. A full walk of the page costs what the page holds, about 25 ms per 62,500
  // elements and 50 ms per 120,000 at 1x CPU, garbage collection of the wrappers it creates in
  // this world included (Chrome 157 on the test machine, traced 2026-10-24). It runs in slices of
  // its own: at injection, after a walk that its budget cut short, and for a probe or an engage
  // where one is due (see walkDue). The walk interval and its backoff are what bound the total.
  // SLICE_MS is the target length of one slice, not a bound: a garbage collection can land in a
  // slice and stretch it.
  // Closed roots cannot be reached from here, and their media stay invisible. While this frame
  // holds no hook, the tab takes the capture route for them, as for any player this frame cannot
  // see. While it holds one, the rule keeps the level on the held element, and a clip in a closed
  // root plays at its own level.
  const SCAN_MAX = 20000;    // elements one observer callback walks, the rest goes to a full walk
  const WALK_MS = 40;        // and the time it may take
  const SLICE_MS = 8;        // the target length of one slice of a full walk
  const WALK_TOTAL_MAX = 500000; // elements one full walk visits at most, all its slices together
  const SWEEP_STALE = 3000;  // while something sounds, a shadow-DOM page is walked at most this often
  const SWEEP_MIN = 1000;    // the interval of full walks starts here
  const SWEEP_GAP_MAX = 30000; // and doubles up to this while walks find no new root with media
  const PROBE_WAIT_MS = 200; // the longest an engage that holds no element waits for a walk
  const PENDING_MAX = 4000;  // undefined elements awaiting their upgrade, the rest wait for a sweep or a click
  const PENDING_LIFE = 8000; // how long each one is rechecked
  // nodeType first: the root node of an element in a detached subtree is that subtree's top
  // element, and an <a href> there has a host property of its own (a hostname string).
  const isShadowRoot = (r) => !!r && r.nodeType === 11 && !!r.host;
  const seenRoots = new WeakSet();   // never iterated, so it keeps no removed player alive
  const listenedRoots = new WeakSet();
  const mediaRoots = new Set();      // roots that hold media, dropped once their host leaves the DOM
  let usesShadow = false;            // this frame has registered a shadow root
  let deepScan = false;              // ...or met a custom element that is not defined yet
  let lastSweep = -Infinity;         // when the last full walk completed
  let sweepGap = SWEEP_MIN;          // the interval of full walks while nothing plays
  let sweepTimer = null;

  // swapMo observes the root like the document. A MutationObserver holds the nodes it observes
  // weakly, so observing every root a long feed creates and drops again keeps none of them alive.
  function registerRoot(root) {
    if (dead || seenRoots.has(root)) return false;
    seenRoots.add(root);
    usesShadow = deepScan = true;
    try { swapMo.observe(root, SWAP_OPTS); } catch (_) {}
    return true;
  }
  // The media listeners go on the element's own root, once per root: about 80 roots of about
  // 2300 on a long Reddit feed. True when the root gets them for the first time: a play in it
  // before this went unheard. A new root that holds media, whichever path met it, sets the
  // interval of full walks back to its start: the page is building players in roots.
  function noteMedia(el) {
    const r = el.getRootNode();
    if (dead || !isShadowRoot(r)) return false;
    registerRoot(r);
    mediaRoots.add(r);
    if (listenedRoots.has(r)) return false;
    listenedRoots.add(r);
    sweepGap = SWEEP_MIN;
    r.addEventListener("volumechange", onVolumeChange, true);
    r.addEventListener("play", onPlayEvent, true);
    r.addEventListener("playing", onPlayingEvent, true);
    r.addEventListener("timeupdate", onTimeUpdate, true);
    r.addEventListener("pause", onPauseEvent, true);
    return true;
  }

  // A missed play: the element started in a root that had no listener yet, or before it was
  // inserted (the events of a detached element reach no listener of the page). It is taken the
  // way its play event would have been.
  const soundingNow = (el) => !el.paused && !el.ended && !el.muted && el.volume > 0;
  function soundingIn(roots, out) {
    for (const r of roots) for (const el of r.querySelectorAll("video, audio")) if (soundingNow(el)) out.add(el);
    return out;
  }
  function missedPlay(el) {
    if (checkOrphaned() || !soundingNow(el)) return;
    if (el.readyState >= 2) playedMedia.add(el); // its 'playing' went unheard as well
    heardPlay(el, false);
  }
  // later: found inside a command (the probe, an engage, a hook being taken), where autoHook
  // refuses or would run inside the hook in progress. Those are taken on a task of their own once
  // the command queue is idle.
  const missedLater = new Set();
  let missedTimer = null;
  function takeMissed(els, later) {
    if (!els.size) return;
    if (!later) { for (const el of els) missedPlay(el); return; }
    for (const el of els) missedLater.add(el);
    if (!missedTimer) missedTimer = setTimeout(flushMissed, 0);
  }
  function flushMissed() {
    missedTimer = null;
    if (dead) return;
    if (cmdBusy) {
      cmdChain.then(() => { if (!missedTimer && !dead) missedTimer = setTimeout(flushMissed, 0); });
      return;
    }
    const els = [...missedLater];
    missedLater.clear();
    for (const el of els) missedPlay(el);
  }

  // A custom element inserted before its definition gets its root at the upgrade, and an upgrade
  // leaves no mutation record anywhere. Such elements are rechecked with backoff for PENDING_LIFE
  // ms, each one once in its life. One timer chain serves them all.
  const pending = new Map();         // element -> when it was first seen undefined
  const pendingOnce = new WeakSet();
  let pendingTimer = null;
  let pendingDelay = 0;
  let rechecking = false;
  function notePending(el) {
    if (pendingOnce.has(el) || pending.size >= PENDING_MAX) return;
    pendingOnce.add(el);
    pending.set(el, performance.now());
    deepScan = true;
    // An element noted while the chain runs waits for its next recheck. Restarting the backoff
    // here would keep it at its shortest for good on a feed that inserts custom elements all the
    // time, and a second timer would start a second chain.
    if (pendingTimer || rechecking) return;
    pendingDelay = 50;
    pendingTimer = setTimeout(recheckPending, pendingDelay);
  }
  function recheckPending() {
    pendingTimer = null;
    if (dead) return;
    const now = performance.now();
    const b = budget(SCAN_MAX);
    const fresh = [];
    let hit = false;
    rechecking = true;
    try {
      for (const [el, at] of pending) {
        const sr = el.shadowRoot;
        if (sr) {
          if (b.n > b.max) break; // spent: the rest waits for the next recheck or the sweep
          pending.delete(el);
          if (!registerRoot(sr)) continue;
          const w = makeWalk(sr, true);
          if (!runWalk(w, b, null)) scheduleSweep(300);
          if (w.hit) hit = true;
          fresh.push(...w.fresh);
        } else if (!el.isConnected || now - at > PENDING_LIFE || el.matches(":defined")) {
          pending.delete(el); // gone, too old, or defined without an open root: nothing more to come
        }
      }
    } finally { rechecking = false; }
    takeMissed(soundingIn(fresh, new Set()), false);
    if (hit) pingNavigated();
    if (pending.size && !dead) {
      pendingDelay = Math.min(pendingDelay * 2, 2000);
      pendingTimer = setTimeout(recheckPending, pendingDelay);
    }
  }

  // One walk over a subtree and every open shadow root below it, resumable so that a full walk
  // can run in slices. TreeWalker, not a recursive querySelectorAll("*"): measured on Reddit the
  // latter has 3 to 4 times the worst case. Every walk draws on a budget of elements and time,
  // which all walks of one observer callback share.
  // Roots are walked last in, first out, once the tree that holds their host is done: the root of
  // a player at the end of a long batch comes first. Descending into each root where its host
  // stands would reach that player only after everything before it.
  const budget = (max, ms) => ({ n: 0, max, deadline: performance.now() + (ms || WALK_MS) });
  // fresh: the roots that got their media listeners during this walk. cut: the subtrees an
  // observer callback left to this walk, where media and iframes count as inserted (cutHit).
  const makeWalk = (start, withPending) => ({ stack: [start], tw: null, el: null, hit: false, fresh: [], withPending, cut: null, cutHit: false });
  // Runs until done (true) or until the budget is spent (false, resumable).
  function runWalk(w, b, visited) {
    for (;;) {
      if (!w.tw) {
        const top = w.stack.pop();
        if (!top) return true;
        w.tw = document.createTreeWalker(top, NodeFilter.SHOW_ELEMENT);
        w.el = top.nodeType === 1 ? top : w.tw.nextNode();
      }
      let el = w.el;
      while (el) {
        if ((++b.n & 255) === 0 && (b.n > b.max || performance.now() > b.deadline)) { w.el = el; return false; }
        if (visited) visited.add(el);
        const tag = el.tagName;
        const media = tag === "VIDEO" || tag === "AUDIO";
        if (media || tag === "IFRAME") {
          if (media && noteMedia(el)) w.fresh.push(el.getRootNode());
          w.hit = true;
          if (w.cut && !w.cutHit && inParts(el, w.cut)) w.cutHit = true;
        }
        const sr = el.shadowRoot;
        if (sr) { registerRoot(sr); w.stack.push(sr); }
        else if (w.withPending && el.localName.indexOf("-") > 0 && el.matches(":not(:defined)")) notePending(el);
        el = w.tw.nextNode();
      }
      w.tw = null;
      w.el = null;
    }
  }
  // Whether el lies in one of these subtrees, counting the hosts of the roots between.
  function inParts(el, parts) {
    if (!parts.size) return false;
    for (let n = el; n; n = n.parentNode || (isShadowRoot(n) ? n.host : null)) if (parts.has(n)) return true;
    return false;
  }

  // The full walk of the page. There is one at a time: the walk at injection is the first, and
  // every later one starts once the one before is complete. Each runs in SLICE_MS slices, every
  // slice a task of its own, and resumes where the last slice stopped: one full walk of a page of
  // 62,500 elements takes about 25 ms (see above), too long for one task on a page the user
  // watches. A walk ends when it is done or has visited WALK_TOTAL_MAX elements, never because a
  // slice ran out, so it reaches the roots behind any light tree.
  // Every walk notes undefined custom elements for the recheck and takes the plays it finds under
  // way in roots that get their listeners from it (missed plays). The walk at injection does as
  // well: the probe that follows the injection reports what the walk registered only where the
  // walk completes inside the worker's window, and a play found later would go unheard.
  let walk = null;
  let walkTimer = null;
  let cutParts = new Set();   // subtrees observer callbacks left to the next full walk
  function startWalk() {
    if (walk || dead) return;
    const w = walk = makeWalk(document, true);
    Object.assign(w, { b: budget(WALK_TOTAL_MAX), restarts: 0, dirty: false, again: false, found: false, waiters: [] });
    w.cut = cutParts;
    cutParts = new Set();
    walkTimer = setTimeout(walkSlice, 0);
  }
  function walkSlice() {
    walkTimer = null;
    const w = walk;
    if (!w || dead) return;
    // The page removed or moved the subtree the walk stopped in (scanMutations), at most three
    // times per walk. A TreeWalker would finish that subtree and report done, or carry on from
    // its new place, and miss the rest either way: the walk starts over from the document.
    if (w.dirty) {
      w.dirty = false;
      w.restarts++;
      w.stack = [document];
      w.tw = w.el = null;
    }
    w.b.deadline = performance.now() + SLICE_MS;
    const done = runWalk(w, w.b, null);
    const fresh = w.fresh.splice(0);
    if (fresh.length) w.found = true;
    // A command in progress refuses autoHook: its missed plays wait until it is done.
    takeMissed(soundingIn(fresh, new Set()), cmdBusy > 0);
    if (!done && w.b.n <= w.b.max) { walkTimer = setTimeout(walkSlice, 0); return; }
    walk = null;
    lastSweep = performance.now();
    sweepGap = w.found ? SWEEP_MIN : Math.min(sweepGap * 2, SWEEP_GAP_MAX);
    // Media or an iframe in a part an observer callback left to this walk would have pinged there.
    if (w.cutHit) pingNavigated();
    for (const f of w.waiters) f();
    if (w.again) startWalk();
  }
  // A walk its budget cut short leaves the rest to a full walk a moment later, once the page has
  // rendered what it inserted. A walk in flight then has one more to follow it, since it may have
  // passed the part already.
  function scheduleSweep(ms) {
    if (sweepTimer || dead) return;
    sweepTimer = setTimeout(() => {
      sweepTimer = null;
      if (walk) walk.again = true;
      else startWalk();
    }, ms);
  }

  // Whether a probe or engage needs a full walk: the backstop for what no observer reports, such
  // as a root attached to a host already in the DOM, a player defined after PENDING_LIFE, or a
  // player root in a frame that had met none when it arrived. While nothing in the frame sounds,
  // the tab may be playing from such a root, and a stale registry would send it to capture: a
  // walk is due once the last one lies further back than the interval. Muted media and media at
  // volume 0 do not count as sounding, so a muted hero loop leaves the backstop in place. The
  // interval starts at SWEEP_MIN and doubles after every walk that registered no new root holding
  // media. It starts over when any path registers one, and when the tab's level changes. While
  // something sounds, a page that uses shadow DOM is walked once the last walk lies further back
  // than both SWEEP_STALE and the interval, so the backoff slows these walks as well.
  // Returns whether a walk is due, and the elements collected to tell (null when no rule needed
  // them).
  function walkDue() {
    const since = performance.now() - lastSweep;
    if (since <= sweepGap) return { due: false, els: null }; // no rule applies, whatever sounds
    const els = mediaElements();
    return { due: !els.some(soundingNow) || (usesShadow && since > SWEEP_STALE), els };
  }
  // The full walk in flight, or the one this call finds due and starts. Without one, the elements
  // walkDue collected, so describe() needs no second query of the page.
  function dueWalk() {
    if (walk || dead) return { w: walk, els: null };
    const d = walkDue();
    if (d.due) startWalk();
    return { w: walk, els: d.els };
  }
  // For an engage that holds no element: resolves once the full walk in flight, or the one this
  // call finds due, is complete, or after PROBE_WAIT_MS, with null, and the engage reads the
  // registry after it. Nothing blocks the page meanwhile, the walk goes on in its slices. With no
  // walk to wait for it resolves at once, with the elements walkDue collected.
  function walked() {
    const { w, els } = dueWalk();
    if (!w) return Promise.resolve(els);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), PROBE_WAIT_MS);
      w.waiters.push(() => { clearTimeout(t); resolve(null); });
    });
  }

  // A trusted pointer's path names every open root it crosses. A root no observer has met yet
  // (attached to a host already in the DOM) is registered here, before the pre-hook looks.
  function notePath(e) {
    let b = null;
    const fresh = [];
    for (const n of e.composedPath()) {
      if (!isShadowRoot(n) || !registerRoot(n)) continue;
      b = b || budget(SCAN_MAX);
      const w = makeWalk(n, true);
      const done = runWalk(w, b, null);
      fresh.push(...w.fresh);
      if (!done) { scheduleSweep(300); break; }
    }
    takeMissed(soundingIn(fresh, new Set()), true);
  }

  // swapMo's records, from the document and from every registered root. True when media or an
  // iframe came, went or changed its src.
  // A frame that has met no shadow root and no undefined custom element yet checks an added
  // subtree with one native querySelector, at the cost of a page without shadow DOM. The query
  // looks for an undefined custom element as well: one sends the subtree to the walk, which notes
  // it, so its upgrade is rechecked. A subtree the query passes over while a full walk is in
  // flight goes to that walk. From the first root or undefined custom element on, added
  // subtrees are walked to register the roots and media they bring, all of one callback within
  // one budget. What the budget cuts goes to a full walk, and gets the native query on the spot,
  // so media or an iframe at the end of a large insertion still signal at once.
  // One gap stays open by decision. A page with no open root and no undefined custom element when
  // the content script arrives, which later inserts an already defined web-component player inside
  // a light wrapper and starts it without a click and without a probe running, plays that clip at
  // native level until the next probe (popup, slider, restore pass) that finds a full walk due
  // (walkDue), or a click on it. Closing it needs a JavaScript walk of every added subtree in
  // every armed frame, measured at 10 to 20 times the cost of this callback on light-DOM pages
  // (YouTube with a level included), a cost the extension does not take on.
  function scanMutations(muts) {
    let hit = false, removed = false, cut = false, b = null, visited = null;
    const fresh = [], missed = new Set();
    for (const m of muts) {
      if (m.type === "attributes") {
        const t = m.target;
        if (MEDIA_TAGS.test(t.tagName)) {
          hit = true;
          if (t.tagName !== "IFRAME" && noteMedia(t)) fresh.push(t.getRootNode());
        }
        continue;
      }
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1 || !n.isConnected) continue;
        const tag = n.tagName;
        if (tag === "VIDEO" || tag === "AUDIO") {
          hit = true;
          if (noteMedia(n)) fresh.push(n.getRootNode());
          // Sounding as it arrives: it started before it was inserted, so its play went unheard.
          if (soundingNow(n)) missed.add(n);
          continue;
        }
        if (tag === "IFRAME") { hit = true; continue; }
        if (!deepScan && !n.shadowRoot && !(n.localName.indexOf("-") > 0 && n.matches(":not(:defined)"))) {
          if (!n.firstElementChild) continue;
          // Once the callback has its hit, only an undefined element is left to look for. Before
          // that, one query finds the first match in document order, and only media or an iframe
          // ahead of an undefined element needs a second one.
          let undef;
          if (hit) undef = n.querySelector(":not(:defined)");
          else {
            undef = n.querySelector("iframe,video,audio,:not(:defined)");
            if (undef && MEDIA_TAGS.test(undef.tagName)) {
              hit = true;
              undef = n.querySelector(":not(:defined)");
            }
          }
          if (!undef) {
            // A full walk in flight may have passed the place this subtree arrived at (the page
            // moved it from ahead of the walk to behind it): the walk takes it at its end.
            if (walk) walk.stack.unshift(n);
            continue;
          }
        }
        visited = visited || new Set();
        if (visited.has(n)) continue; // walked already, below an ancestor added in this batch
        if (cut) {
          cutParts.add(n);
          if (!hit && n.firstElementChild && n.querySelector("iframe,video,audio")) hit = true;
          continue;
        }
        b = b || budget(SCAN_MAX);
        const w = makeWalk(n, true);
        if (!runWalk(w, b, visited)) {
          cut = true;
          cutParts.add(n);
          scheduleSweep(300);
          if (!hit && n.querySelector("iframe,video,audio")) hit = true;
        }
        if (w.hit) hit = true;
        fresh.push(...w.fresh);
      }
      for (const n of m.removedNodes) {
        if (n.nodeType !== 1) continue;
        removed = true;
        // The full walk stopped inside what left. A move leaves a removal record as well.
        if (walk && walk.el && walk.restarts < 3 && n.contains(walk.el)) walk.dirty = true;
        if (!hit && (MEDIA_TAGS.test(n.tagName) || (n.firstElementChild && n.querySelector("iframe,video,audio")))) hit = true;
      }
    }
    // A player removed with its post leaves no media in the light DOM to find above.
    if (removed && mediaRoots.size) {
      for (const r of mediaRoots) if (!r.host.isConnected) { mediaRoots.delete(r); hit = true; }
    }
    takeMissed(soundingIn(fresh, missed), false);
    return hit;
  }
  // (An iframe navigating ITSELF - a player loading the next episode at its own new address -
  // changes nothing the observer above can see, but needs no signal from here: the tab's load
  // state covers sub-frame navigations, so the worker's tabs.onUpdated restore re-probes and
  // re-hooks on its own. Pinned by test s43.)
  // Unmutes are INVISIBLE to the observer above: muted/volume are properties, not attributes.
  // volumechange doesn't bubble, but a CAPTURE listener on an ancestor still sees it - one
  // document-level listener covers every media element, present or future. Urgent only when the
  // element just became actionable (audibly playing); wiggles on muted/paused elements take the
  // churn path. Our own hooked element is skipped: its gain node already applies.
  // Media inside a shadow root get the same handlers on their root (noteMedia), so the heard and
  // played bookkeeping below covers them too. An event the page re-dispatches on the host reaches
  // the document with the host as its target and is dropped by the tag check.
  // firstSight: one handling per event. A light-DOM element slotted into a root that carries the
  // listeners sends its event through that root and on to the document. A second handling would
  // change nothing (the S.el check stops it, its ping folds into the pending one), so this is a
  // safety net for that path, not a fix for anything measured.
  const handledEvents = new WeakSet();
  const firstSight = (e) => {
    if (handledEvents.has(e)) return false;
    handledEvents.add(e);
    return true;
  };
  const onVolumeChange = (e) => {
    if (checkOrphaned() || !firstSight(e)) return;
    const el = e.target;
    if (!el || el.tagName !== "VIDEO" && el.tagName !== "AUDIO") return;
    // A volume write on an element that is not playing makes no sound (an ad SDK setting up its
    // element before the break), so only an unmute of playing media counts as sounding.
    if (!el.muted && el.volume > 0 && !el.paused && !el.ended) sounded(el);
    if (el === S.el && armedGain != null) return; // our hook applies the level (a stopped frame's hook sits at unity)
    const audible = !el.muted && el.volume > 0 && !el.paused;
    // A feed unmuting its next clip on its own: no gesture happened, so preHook never saw this
    // element. Take it here instead of waking the worker and waiting out the roundtrip.
    if (audible && autoHook(el)) return;
    pingNavigated(audible);
  };
  document.addEventListener("volumechange", onVolumeChange, true);
  // play() on an ALREADY-UNMUTED element is the volumechange listener's blind twin: pressing
  // play on a second article video (unmuted from the start, just paused) changes neither volume
  // nor the DOM, so without this listener no signal exists at all and the boost simply never
  // arrives. Same treatment: take it in-page when possible, ping otherwise.
  // One blind spot remains: a player told to play BEFORE its stream is attached. Its 'play'
  // fires with nothing to hook, and a fresh element stays unpaused through the attachment, so no
  // second 'play' ever comes - only 'playing' marks the real start (measured: live-stream players
  // do this). So 'playing' is taken as the missed 'play' for exactly those elements, and for no
  // other: every player with a source at 'play' was handled there, and a second signal for it
  // would only run the restore again (a churn ping per muted autoplay clip, in the worst case).
  const sourcelessPlay = new WeakSet();
  const onPlay = (e, late) => {
    if (checkOrphaned() || !firstSight(e)) return;
    const el = e.target;
    if (!el || el.tagName !== "VIDEO" && el.tagName !== "AUDIO") return;
    heardPlay(el, late);
  };
  // The play itself, shared with the plays a walk finds already under way (missedPlay).
  function heardPlay(el, late) {
    if (late) playedMedia.add(el);
    if (!el.muted && el.volume > 0) sounded(el);
    if (el === S.el && armedGain != null) return; // our hook applies the level (a stopped frame's hook sits at unity)
    if (late) {
      if (!sourcelessPlay.has(el)) {
        if (refusedAt.has(el)) retryRefused(el); // its real start, a moment after a refused 'play'
        return;
      }
      sourcelessPlay.delete(el);
    } else if (!(el.srcObject || el.currentSrc || el.src)) {
      sourcelessPlay.add(el);
    }
    const audible = !el.muted && el.volume > 0;
    if (audible && autoHook(el)) return;
    pingNavigated(audible);
  }
  const onPlayEvent = (e) => onPlay(e, false);
  const onPlayingEvent = (e) => onPlay(e, true);
  document.addEventListener("play", onPlayEvent, true);
  document.addEventListener("playing", onPlayingEvent, true);
  // Orphan standdown must not depend on the USER doing something: after an extension update,
  // the dangerous stacking path (new popup re-boost -> new world refused -> capture ON TOP of
  // this world's stale element gain) involves zero in-page events. timeupdate fires several
  // times a second on any playing media, so a boosted world notices its own death within a
  // fraction of a second; the handler is a single boolean check per event while healthy.
  const onTimeUpdate = () => { checkOrphaned(); };
  document.addEventListener("timeupdate", onTimeUpdate, true);
  // The holder pausing is the moment a clip refused for it can take the hook (retryRefused).
  const onPauseEvent = (e) => {
    if (!refusedAt.size || checkOrphaned() || !firstSight(e)) return;
    if (e.target === S.el) retryRefused(null);
  };
  document.addEventListener("pause", onPauseEvent, true);
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
  let armedGain = null;   // level the worker last engaged, or pre-armed, this frame at (null = not our frame)
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

  // Ceiling on IN-PAGE hook minting, over the parked graphs that are not dormant: those whose
  // element still plays (a muted loop the user clicked away from, say). Unlike the worker path,
  // the page controls how often the in-page paths fire. Each such graph costs the audio thread for
  // as long as its source stays connected, until its element pauses or unloads, in the DOM or out
  // of it: about 0.47% of one core with the whole chain (32 of them, elements and nodes held by
  // references: 14.6 to 15.0% of one core, renderer CPU over 30 s, silent sources, Chrome 157 on
  // the test machine, 2026-10-25). A dormant graph costs nothing measurable: 32 of them read 94 to
  // 169 ms of renderer CPU per 30 s, in the DOM and out of it, against 84 to 132 ms for the same
  // page without them. So dormant graphs take no place here, and a feed whose clips pause or
  // unload one after the other never reaches the ceiling. Past it the in-page paths refuse and the
  // signal falls back to the ping: boosting still works, at worker pace (~200ms) and
  // worker-rate-limited growth. Re-adopting a parked or dormant graph never grows the list and
  // stays allowed.
  const PARK_MAX = 16;

  // Move the hook onto `el` and apply the armed level. Returns false if the element could not be
  // taken, in which case nothing has been changed.
  function adopt(el) {
    // Was this element hooked before and merely parked, or dormant (scrolled out and back)? Then
    // re-adopt its graph: a second createMediaElementSource on the same element throws.
    let node = null;
    if (parkedAt(el) < 0) {
      dozePaused(); // only graphs whose element plays count below
      // Checked BEFORE creating the source node: createMediaElementSource reroutes the element
      // the moment it exists, so bailing after creating it would leave the element silent.
      if (retired.length >= PARK_MAX) return false;
      // Build the source node BEFORE anything is torn down: if the element turns out to be
      // hooked already (by us with a lost graph, or by the page itself), this throws and the
      // live hook is left exactly as it was.
      try { node = hotCtx.createMediaElementSource(el); } catch (_) { return false; }
      ours.add(el);
    }
    retireCurrent();
    if (node) {
      buildGraph(node, el, armedGain);
    } else {
      const g = unpark(retired.findIndex((x) => x.el === el));
      S.ctx = g.ctx; S.src = g.src; S.gain = g.gain; S.limiter = g.limiter; S.analyser = g.analyser; S.el = g.el;
    }
    // Set, not ramped: the element is silent right now, so there is nothing to glide from, and a
    // ramp would still be climbing when the site unmutes.
    S.useLimiter = armedLimiter;
    try { S.gain.gain.setValueAtTime(armedGain, S.ctx.currentTime); } catch (_) {}
    applyLimiter(armedLimiter, true);
    S.engaged = true;
    watchElement(el);
    // Tell the worker which frame holds the hook now - only where it pre-armed this frame
    // ('arm'): it records the frame, so a later retarget or release reaches this hook like any
    // other. A frame armed by an engage is tracked already, and waking the worker for every
    // click or self-unmute there would be pure overhead.
    if (armedByArm) {
      armedByArm = false;
      try { chrome.runtime.sendMessage({ type: "hooked" }); } catch (_) {}
    }
    return true;
  }

  // The worker pre-arms this frame while its restore is still WAITING for the page's player: the
  // level is known, the element is not there yet. Armed, the in-page paths take the player the
  // instant it starts (the 'play' listener below), instead of a probe cadence later - on a tab
  // turned down, the difference between a silent start and a moment of full volume. The context
  // is proven here, once per document: where the autoplay policy refuses it, the first gesture
  // retries through the worker as usual, and the ordinary path serves everything else.
  let armCtxTried = false;
  // Armed by 'arm', not by an engage: only then is a hook this frame takes news to the worker.
  // Cleared by the next engage (the worker tracks the frame from there) and by stop().
  let armedByArm = false;
  async function arm(gain, useLimiter) {
    if (gain !== armedGain) sweepGap = SWEEP_MIN; // a new level: the next probe may walk again
    armedGain = gain;
    armedByArm = true;
    armedLimiter = useLimiter !== false;
    parkLevel = { gain, limiter: armedLimiter };
    // A hook this frame still holds sits at unity after a stop. Armed again, the frame is the
    // tab's element frame at this level, so the held element carries it again right away: a clip
    // that keeps playing would otherwise stay at native volume, since no play event follows.
    if (S.engaged && S.ctx && S.el && S.el.isConnected) {
      S.useLimiter = armedLimiter;
      setLevel(S, gain, armedLimiter);
    }
    if (hotCtx && hotCtx.state === "running") { takeSounding(); return { ok: true, running: true }; }
    if (armCtxTried) return { ok: true, running: false };
    armCtxTried = true;
    let ctx;
    try { ctx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch { return { ok: true, running: false }; }
    await Promise.race([ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 150))]);
    if (ctx.state !== "running") await new Promise((r) => setTimeout(r, 150));
    if (ctx.state !== "running") {
      try { ctx.close(); } catch (_) {}
      armGestureRetry();
      return { ok: true, running: false };
    }
    hotCtx = ctx;
    takeSounding();
    return { ok: true, running: true };
  }
  // The arm lands after the player started: a page that plays before the content script arrives
  // (injection waits for the load event), or a feed's clip that starts while the worker's pass
  // injects. That play found nothing armed, and no second play follows. So once the context runs,
  // a frame whose hook does not sound takes the hookable element that sounds right now (playing,
  // or started and still loading), the one select.js picks among such elements, the way autoHook
  // takes a play: with its budget, its no-steal rule and the 'hooked' report. That runs once this
  // command is done (autoHook refuses while one runs), in a microtask, since a busy page can hold
  // a task back for a long time. A refusal sends no ping: the pass that armed the frame probes
  // next anyway.
  function takeSounding() {
    if (S.engaged && S.el && S.el.isConnected && soundingNow(S.el)) return;
    const els = mediaElements().filter(soundingNow);
    if (!els.length) return;
    const c = select.choose(describe(els).filter((d) => d.safe && soundingNow(d.el)));
    if (!c.pick) return;
    const el = c.pick.el;
    cmdChain.then(() => { if (!dead && el !== S.el && soundingNow(el)) autoHook(el); });
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
    if (S.engaged && cur && cur.isConnected && !cur.paused && !cur.ended && !cur.muted && cur.volume > 0) {
      if (cur !== el && hookableNow(el)) noteRefused(el);
      return false;
    }
    if (!hookableNow(el)) return false;
    const now = performance.now();
    if (now > autoHookReset) { autoHookBudget = 12; autoHookReset = now + AUTO_HOOK_WINDOW; }
    if (autoHookBudget <= 0) return false;
    // Charged only for a hook actually MINTED. The budget bounds the irreversible resource (a
    // one-shot createMediaElementSource per element); a failed adopt mints nothing, so it costs
    // nothing - otherwise a page whose own player fades el.volume (its element is foreign-hooked,
    // so every attempt throws) would drain the whole allowance for free and push every genuine
    // unmute back onto the slow path. Refusals above cost nothing for the same reason.
    // Re-adopting a PARKED or dormant graph mints nothing (the one-shot was spent long ago), so
    // it is free, like every other non-minting outcome: a feed muting/unmuting between two
    // already-hooked clips must not drain the allowance a genuinely new element will need.
    const parked = parkedAt(el) >= 0;
    if (!adopt(el)) return false;
    if (!parked) autoHookBudget--;
    return true;
  }

  // A clip autoHook refused because the held clip still sounded. A feed can start its next clip
  // a few ms before it pauses the one it held (Reddit does in about 4 of 10 transitions), and
  // that clip's play is the signal the refusal spent. Its own 'playing' and the holder's 'pause'
  // are the moments it can take the hook, within REFUSED_RETRY_MS of the refusal. Without them
  // its start plays at native level until the worker's engage, about 300 ms later.
  const REFUSED_RETRY_MS = 2000;
  const refusedAt = new Map(); // element -> when autoHook refused it for a holder that sounded
  function noteRefused(el) {
    const now = performance.now();
    for (const [e, at] of refusedAt) if (now - at > REFUSED_RETRY_MS) refusedAt.delete(e);
    if (!refusedAt.has(el)) refusedAt.set(el, now);
  }
  // only: that element alone (its own 'playing'), otherwise all of them (the holder paused).
  // autoHook refuses again while the holder sounds.
  function retryRefused(only) {
    const now = performance.now();
    for (const [el, at] of refusedAt) {
      if (now - at > REFUSED_RETRY_MS || !el.isConnected) { refusedAt.delete(el); continue; }
      if (only && el !== only) continue;
      if (soundingNow(el) && autoHook(el)) refusedAt.delete(el);
    }
  }

  // A same-origin pick needs the redirect check before its one-shot hook, unless a hook on it
  // exists already: held, or parked.
  const needsChainCheck = (d) => d.reason === "same-origin" && !d.held && !retired.some((g) => g.el === d.el);

  async function engage(gain, useLimiter, since) {
    S.useLimiter = useLimiter !== false;
    // The level belongs to the TAB, so every graph in this frame carries it, parked ones
    // included. Their elements are usually idle, but preHook parks on pointerdown, before the
    // site has paused anything, so a parked element can still be audible, and one that resumes
    // later must not come back at a level the user has since moved away from. Dormant graphs
    // need nothing: they take parkLevel when they wake, set here before anything is awaited, so a
    // clip that wakes while this engage waits on a check gets this level too.
    parkLevel = { gain, limiter: S.useLimiter };
    for (const g of retired) setLevel(g, gain, S.useLimiter);

    // Which element: the rule in select.js, the same one the probe and the worker follow, applied
    // to this frame's elements. The engage therefore takes the element the probe chose, never one
    // the probe passed over (an unhookable clip it would refuse, sending the tab to capture).
    // An engage on a frame that holds a connected element reads the registry as it stands: the
    // level moves at once, and a slider drag is a stream of engages queued one behind the other.
    // A full walk it finds due still starts, so the next probe or engage reads what it registers,
    // and a player the walk finds sounding is taken as a missed play. An engage that holds nothing
    // waits for a walk in flight or due, since its player may sit in a root only that walk
    // reaches. A new level counts as a change of the tab, so the interval of those walks starts
    // over.
    if (gain !== armedGain) sweepGap = SWEEP_MIN;
    const holds = S.engaged && S.el && S.el.isConnected && armedGain != null;
    const own = describe(holds ? dueWalk().els : await walked());
    let c = select.choose(own);
    // The redirect verdict is part of "safe" and is awaited BEFORE anything is torn down: a
    // same-origin src that 302s cross-origin passes assess, and finding that out after the
    // current hook is parked would give up a working hook for an element that can never be
    // hooked. A negative makes the element what it is, unhookable, and the rule runs again.
    for (let i = 0; i < 3 && c.pick && needsChainCheck(c.pick); i++) {
      if (await sameOriginChainOk(c.pick.el.currentSrc || c.pick.el.src || "")) break;
      c.pick.safe = false;
      c.pick.reason = "cross-origin-redirect";
      c = select.choose(own);
    }
    if (!c.pick) {
      // Only capture reaches what plays, or nothing here can be hooked. The reason names what
      // decided it: the sounding element no hook can take, else an element no hook can ever
      // take, never an unrelated one. A hook this frame holds stays as it is: the worker's
      // capture fallback stops it first.
      const why = c.loud || own.find(select.unhookableForGood);
      return { ok: false, reason: why ? why.reason : "no-element" };
    }
    const el = c.pick.el;
    // A stand-in: the pick waits behind a sounding element no hook can take (an ad without CORS
    // over the content player). Every answer says so. A restore pass keeps it, and the content
    // gets the level when the ad ends. A user action tries capture instead (background.js setGain).
    const standIn = c.loud ? { standIn: true, loud: c.loud.reason } : {};

    if (S.engaged && S.ctx) {
      if (el === S.el) {
        // The element hooked already: update the level, no re-hook, no disconnect click. A fresh
        // episode's video that autoplays muted and unmutes a beat later needs nothing armed here:
        // the document-level volumechange listener pings the moment its volume state changes.
        S.gain.gain.setTargetAtTime(gain, S.ctx.currentTime, 0.02);
        applyLimiter(S.useLimiter, false);
        return { ok: true, engaged: true, ...standIn };
      }
      // The rule moved the level to another element. The outgoing graph is parked AS-IS, so it
      // must carry the level of THIS engage, not the one it was last set to: the user may have
      // moved the slider since (say 5.0 down to 1.5), and a resume of the outgoing element later
      // (playlist loop, keyboard play, media session) fires no signal that would correct it.
      // The retired-sync loop above ran before this graph joined.
      setLevel(S, gain, S.useLimiter);
      retireCurrent();
    }

    // An element hooked before (swapped out, now back): re-adopt its parked or dormant graph, since
    // a second createMediaElementSource on the same element would throw.
    const back = parkedAt(el);
    if (back >= 0) {
      const g = unpark(back);
      S.ctx = g.ctx; S.src = g.src; S.gain = g.gain; S.limiter = g.limiter; S.analyser = g.analyser; S.el = g.el;
      // Same bound as the fresh-context path below: a parked context Chrome will not let run
      // again must not hang this engage (the graph is re-adopted either way; the level simply
      // lands once the page is unlocked).
      await Promise.race([S.ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 150))]);
      if (S.ctx.state === "running") hotCtx = S.ctx;
      S.gain.gain.setTargetAtTime(gain, S.ctx.currentTime, 0.02);
      applyLimiter(S.useLimiter, false);
      S.engaged = true;
      watchElement(el);
      const mm = await measure(measureBudget(el));
      return { ok: true, engaged: true, signal: mm.signal, ...standIn };
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
      // The resume promise is never awaited on its own: on a document the autoplay policy has
      // not unlocked, Chrome keeps it pending FOR GOOD (measured: still pending after a later
      // trusted click, since nothing ever calls resume() on this context again). An engage that
      // never answers would wedge this frame's command chain and the worker's await with it -
      // slider dead for the document's life. Bounded, the refusal below runs as designed.
      await Promise.race([ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 150))]);
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
      // A hook of OURS whose graph this frame cannot find. Every graph stays the hook, parked or
      // dormant, so this is a guard, not a path. Retrying can't undo a one-shot hook, but it is
      // not the foreign-app conflict the popup explains to the user either, so say which one it is.
      if (ours.has(el)) return { ok: false, reason: "own-hook-lost" };
      // Nor is a hook left by the PREVIOUS copy of this extension. After an update or a reload
      // the old world stands down, but its one-shot hook stays on the element for the document's
      // life, and this world cannot tell it from a foreign one - except by age: only a document
      // older than the running copy (since = when it was installed) can carry one. The page's own
      // audio processing on such an old document is reported the same way; a reload tells them apart.
      if (since && performance.timeOrigin < since) return { ok: false, reason: "stale-hook" };
      return { ok: false, reason: "already-hooked" };
    }
    ours.add(el);
    hotCtx = ctx;

    buildGraph(src, el, gain);
    applyLimiter(S.useLimiter, true);
    S.engaged = true;
    watchElement(el);

    const m = await measure(measureBudget(el));
    return { ok: true, engaged: true, signal: m.signal, ...standIn };
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
    armedByArm = false;
    parkLevel = null;
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

  // The probe's answer. Non-destructive capability report: every media element of this frame,
  // described the way select.js reads a candidate (the elements themselves stay here). The worker
  // applies the rule over all frames' reports. Frames with no element stay silent, except in the
  // second report of a probe (always): the worker keeps the latest report of each frame, so an
  // empty one replaces a first report whose elements have left the page since.
  function reportCandidates(given, always) {
    if (dead) return;
    const ranked = describe(given);
    if (!ranked.length && !always) return;
    // Warm the redirect check now (fire-and-forget) so a following engage hits the cache.
    // EVERY safe same-origin candidate, not just the winner: the element the user ends up on
    // is often not today's top pick (an ad interloper outranks it, or they click a different
    // post), and a cold verdict costs the engage the probe's full wait.
    // Bounded at 2 new REQUESTS per report, so 4 for a probe that also gets the report of a
    // completed walk (not candidate slots: counting cache hits would let the top picks
    // permanently consume the budget and never warm the rest) AND at WARM_TOTAL_MAX distinct srcs
    // for this frame's lifetime, since probes are frequent (every popup open, every setGain, once
    // per restore iteration) and a per-report cap alone would still walk a long gallery. Media
    // the page has not started loading is skipped entirely: a preload="none" gallery would
    // otherwise get credentialed range requests for clips the user never played, which the site
    // may count as views.
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
      // Capped by rank: a gallery of hundreds would only send what the rule never reaches. The
      // held element and every unhookable clip heard lately go along wherever they rank, in
      // place of the lowest ranked entries: the rule decides around the one, and the worker's
      // sticky capture counts the others, so a long feed must not hide them.
      const sent = new Set(ranked.filter((d) => d.held || (!d.safe && d.heard)).slice(0, REPORT_MAX));
      for (const d of ranked) { if (sent.size >= REPORT_MAX) break; sent.add(d); }
      const cands = ranked.filter((d) => sent.has(d)).map(({ el, ...d }) => d);
      chrome.runtime.sendMessage({ type: "frameCandidates", cands });
    } catch (_) {}
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.cmd) return;

    if (msg.cmd === "probe") {
      // Reported at once from the registry as it stands, through a separate message, with no
      // response. The handler never walks the page and never holds its report for a walk: the
      // worker waits 350 ms for reports, and on a page busy with its own tasks a report held for
      // a walk misses that window. A full walk in flight, or one due and started here, reports
      // once more when it is complete. The worker keeps the latest report of each frame and drops
      // one that comes after its window.
      const { w, els } = dueWalk();
      reportCandidates(els);
      if (w) w.waiters.push(() => reportCandidates(null, true));
      return;
    }

    if (msg.cmd === "engage") {
      // The .catch guarantees a response even if engage throws - otherwise the worker's await
      // would hang forever (it holds the 'restoring' lock during reload-restores).
      enqueue(() => engage(msg.gain, msg.useLimiter, msg.since))
        .then((res) => {
          // Arm the pre-hook. A successful engage is the worker telling this frame two things:
          // it is the tab's element-mode frame, and this is the level. Only an armed frame may
          // hook on its own - a frame the worker has since routed to capture must not stack an
          // element hook underneath the capture gain (that would be double volume).
          if (res && res.ok) { armedGain = msg.gain; armedLimiter = msg.useLimiter !== false; armedByArm = false; }
          sendResponse(res);
        })
        .catch(() => { try { sendResponse({ ok: false, reason: "error" }); } catch (_) {} });
      return true;
    }
    if (msg.cmd === "arm") {
      enqueue(() => arm(msg.gain, msg.useLimiter))
        .then(sendResponse)
        .catch(() => { try { sendResponse({ ok: true, running: false }); } catch (_) {} });
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

  // The walk at injection starts once everything it calls into exists. Its first slice runs in a
  // task of its own, like every other: the injection itself costs what it costs without a walk.
  startWalk();
})();
