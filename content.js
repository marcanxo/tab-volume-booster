// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 marcanxo
//
// content.js — runs INSIDE the page (and each frame). The fullscreen-preserving path.
//
// It hooks the page's own media element via createMediaElementSource and routes it
// through gain → [limiter] → analyser → destination. No tabCapture is used, so Chrome
// never flags the tab as captured and the Fullscreen API stays available.
//
// SAFETY: createMediaElementSource is one-shot and destructive — hooking a CORS-tainted
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

  // Choose the most likely "real" media element: prefer playing, then audible, then biggest.
  function pickElement() {
    const els = Array.from(document.querySelectorAll("video, audio"));
    if (!els.length) return null;
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
    return scored[0].el;
  }

  // Non-destructive: decide if this element is safe to hook WITHOUT touching it.
  function assess(el) {
    if (el.mediaKeys) return { safe: false, reason: "drm" };
    const src = el.currentSrc || el.src || "";
    if (!src) return { safe: false, reason: "no-src" };
    if (/^(blob:|data:|mediastream:)/.test(src)) return { safe: true, reason: "blob" };
    try {
      const u = new URL(src, location.href);
      if (u.origin === location.origin) return { safe: true, reason: "same-origin" };
      if (el.crossOrigin === "anonymous" || el.crossOrigin === "use-credentials")
        return { safe: true, reason: "cors-enabled" };
      return { safe: false, reason: "cross-origin-no-cors" };
    } catch {
      return { safe: false, reason: "bad-url" };
    }
  }

  // Toggle the limiter by RAMPING its compression ratio (20:1 on → 1:1 off) rather than disconnecting
  // nodes. ratio 1 → slope 1/ratio = 1 → the compressor is an identity transfer (no gain change, flat
  // response): level/frequency-transparent. (Caveat: a DynamicsCompressor keeps a fixed ~6ms pre-delay
  // even when bypassed — imperceptible, and the price of click-free toggling, since an AudioParam ramp
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
        requestAnimationFrame(tick);
      })();
    });
  }

  // Fully release our graph so a later engage() will hook a FRESH element instead of no-opping on
  // the dead one. Used when the player swaps its <video> out from under us. Safe to close the
  // context here because the old element is gone — nothing audible is routed through it anymore.
  function teardown() {
    try { if (S.mo) S.mo.disconnect(); } catch (_) {}
    try { S.src && S.src.disconnect(); } catch (_) {}
    try { S.gain && S.gain.disconnect(); } catch (_) {}
    try { S.limiter && S.limiter.disconnect(); } catch (_) {}
    try { S.analyser && S.analyser.disconnect(); } catch (_) {}
    try { S.ctx && S.ctx.close(); } catch (_) {}
    S.ctx = S.src = S.gain = S.limiter = S.analyser = S.el = S.mo = null;
    S.engaged = false;
  }

  function watchElement(el) {
    try { if (S.mo) S.mo.disconnect(); } catch (_) {}
    let pending = false;
    S.mo = new MutationObserver(() => {
      // el.isConnected (not document.contains): an element re-parented INTO a shadow root is still
      // live and audible, but document.contains() reports false for it — tearing down then would
      // close the ctx and permanently silence it (the hook is one-shot).
      if (pending || el.isConnected) return;
      // The element left the DOM — but a player may be DETACHING then RE-ATTACHING the same node
      // (SPA reconciliation, theater/fullscreen re-parenting). Closing the context now would
      // permanently silence a same-node re-attach (createMediaElementSource is one-shot), so wait
      // a turn and only act if it's really gone.
      pending = true;
      setTimeout(() => {
        pending = false;
        if (el.isConnected) return; // came back → keep the live graph, keep watching
        // Genuinely replaced. Tear down the dead graph (so the next engage hooks the NEW element
        // rather than updating gain on the removed one), then ask the worker to re-engage.
        teardown();
        try { chrome.runtime.sendMessage({ type: "elementLost" }); } catch (_) {}
      }, 150);
    });
    S.mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  async function engage(gain, useLimiter) {
    S.useLimiter = useLimiter !== false;

    // Already hooked → just update gain + ramp the limiter (no re-hook, no disconnect click).
    if (S.engaged && S.ctx) {
      S.gain.gain.setTargetAtTime(gain, S.ctx.currentTime, 0.02);
      applyLimiter(S.useLimiter, false);
      return { ok: true, engaged: true };
    }

    const el = pickElement();
    if (!el) return { ok: false, reason: "no-element" };

    const a = assess(el);
    if (!a.safe) return { ok: false, reason: a.reason };

    let ctx;
    try { ctx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch { return { ok: false, reason: "no-audiocontext" }; }

    // Confirm the context can actually RUN before hooking — hooking into a suspended
    // context would silence the element. If it won't run, bail (nothing hooked yet).
    try { await ctx.resume(); } catch (_) {}
    if (ctx.state !== "running") await new Promise((r) => setTimeout(r, 150));
    if (ctx.state !== "running") {
      try { ctx.close(); } catch (_) {}
      return { ok: false, reason: "suspended" };
    }

    let src;
    try { src = ctx.createMediaElementSource(el); }
    catch { try { ctx.close(); } catch (_) {} return { ok: false, reason: "already-hooked" }; }

    S.ctx = ctx; S.src = src; S.el = el;
    S.gain = ctx.createGain(); S.gain.gain.value = gain;
    S.limiter = makeLimiter(ctx);
    S.analyser = ctx.createAnalyser(); S.analyser.fftSize = 256;
    // Static graph — the limiter is ALWAYS in the path (src→gain→limiter→analyser→destination);
    // it's toggled by ramping its ratio, never by rewiring, so toggling can't click.
    S.src.connect(S.gain);
    S.gain.connect(S.limiter);
    S.limiter.connect(S.analyser);
    S.analyser.connect(ctx.destination); // analyser is a passthrough → also feeds output
    applyLimiter(S.useLimiter, true);
    S.engaged = true;
    watchElement(el);

    const m = await measure();
    return { ok: true, engaged: true, signal: m.signal };
  }

  // 1.0× / off: ramp to a unity passthrough — gain 1 and the limiter bypassed (ratio 1), so it's
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

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.cmd) return;

    if (msg.cmd === "probe") {
      // Non-destructive capability report. Frames with no element stay silent.
      const el = pickElement();
      if (!el) return;
      const a = assess(el);
      const r = el.getBoundingClientRect();
      try {
        chrome.runtime.sendMessage({
          type: "frameCandidate",
          cand: {
            hasElement: true,
            safe: a.safe,
            reason: a.reason,
            area: Math.max(0, r.width) * Math.max(0, r.height),
            playing: !el.paused && !el.ended && el.readyState >= 2
          }
        });
      } catch (_) {}
      return; // reported via separate message, no response
    }

    if (msg.cmd === "engage") {
      // The .catch guarantees a response even if engage throws — otherwise the worker's await
      // would hang forever (it holds the 'restoring' lock during reload-restores).
      engage(msg.gain, msg.useLimiter)
        .then(sendResponse)
        .catch(() => { try { sendResponse({ ok: false, reason: "error" }); } catch (_) {} });
      return true;
    }
    if (msg.cmd === "stop") { sendResponse(stop()); return true; }
  });
})();
