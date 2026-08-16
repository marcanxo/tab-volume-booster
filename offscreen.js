// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 marcanxo
//
// offscreen.js - the audio engine.
//
// Per boosted tab:   MediaStreamSource → GainNode → [DynamicsCompressor limiter] → destination
// The final connect to destination is what keeps the tab audible (capture would
// otherwise mute it). The limiter is wired as a near-brick-wall to keep hard
// boosts from clipping; it can be bypassed from the popup.
//
// When a tab's capture track ends (page reload / cross-site navigation), we tear
// that graph down and tell the worker so its bookkeeping stays accurate.

// tabId -> live graph { ctx, source, gain, limiter, stream }
//        | pending entry { pending:true, latest:{gain,useLimiter}, cancelled } while getUserMedia
//          is in flight - so a 'stop' or 'update' arriving mid-start cancels/retargets it instead
//          of being silently dropped (which used to leave an orphaned live capture).
const graphs = new Map();

function makeLimiter(ctx) {
  const c = ctx.createDynamicsCompressor();
  c.threshold.value = -3;
  c.knee.value = 0;
  c.ratio.value = 20;
  c.attack.value = 0.003;
  c.release.value = 0.25;
  return c;
}

// Toggle the limiter by RAMPING its ratio (20:1 on → 1:1 off) instead of disconnecting nodes.
// ratio 1 → slope 1 → identity transfer (level/frequency-transparent); a DynamicsCompressor keeps a
// fixed ~6ms pre-delay even when bypassed (imperceptible - the price of click-free toggling). The
// limiter stays wired in (source→gain→limiter→destination) at all times.
function applyLimiter(graph, on, immediate) {
  const t = graph.ctx.currentTime;
  if (immediate) {
    graph.limiter.ratio.setValueAtTime(on ? 20 : 1, t);
    graph.limiter.threshold.setValueAtTime(on ? -3 : 0, t);
  } else {
    graph.limiter.ratio.setTargetAtTime(on ? 20 : 1, t, 0.02);
    graph.limiter.threshold.setTargetAtTime(on ? -3 : 0, t, 0.02);
  }
}

// Resolves true once the graph is actually LIVE (or an in-flight start it retargeted goes
// live), false when the capture failed or was cancelled. The worker awaits this: reporting
// 'capture' to the popup before getUserMedia settles would show an amber pill over a boost
// that may never happen.
async function start(tabId, streamId, gain, useLimiter) {
  const existing = graphs.get(tabId);
  if (existing) {
    if (existing.pending) { existing.latest = { gain, useLimiter }; existing.cancelled = false; return existing.done; }
    update(tabId, gain, useLimiter);
    return true;
  }

  // Register the placeholder BEFORE the async capture so concurrent messages see it.
  const entry = { pending: true, latest: { gain, useLimiter }, cancelled: false };
  let settle;
  entry.done = new Promise((r) => { settle = r; });
  graphs.set(tabId, entry);

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
      video: false
    });
  } catch (err) {
    console.error("tab capture failed for tab", tabId, err);
    // Only report if WE are still the active attempt - a superseded/cancelled start's failure
    // must not clobber the bookkeeping of a newer start/graph that replaced it.
    if (graphs.get(tabId) === entry) {
      graphs.delete(tabId);
      try { chrome.runtime.sendMessage({ type: "captureFailed", tabId }).catch(() => {}); } catch (_) {}
    }
    settle(false);
    return false;
  }

  if (entry.cancelled || graphs.get(tabId) !== entry) {
    // A 'stop' (or a replacement start) arrived while capture was starting → don't go live.
    try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    if (graphs.get(tabId) === entry) graphs.delete(tabId);
    settle(false);
    return false;
  }

  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const gainNode = ctx.createGain();
  gainNode.gain.value = entry.latest.gain;   // freshest values - an 'update' may have retargeted us
  const limiter = makeLimiter(ctx);

  const graph = { ctx, source, gain: gainNode, limiter, stream };
  // Static graph - limiter always in the path; toggled by ramping its ratio, never by rewiring.
  source.connect(gainNode);
  gainNode.connect(limiter);
  limiter.connect(ctx.destination);
  applyLimiter(graph, entry.latest.useLimiter, true);
  graphs.set(tabId, graph);

  // Reload / navigation kills the capture track → clean up and notify the worker.
  stream.getAudioTracks().forEach((t) =>
    t.addEventListener("ended", () => {
      if (graphs.get(tabId) !== graph) return; // a successor start/graph owns this tab now
      stop(tabId);
      // Best effort: if this is lost (worker mid-restart), the active list keeps a stale entry.
      // That is why 'update' acks - the stale entry heals on the next slider move either way.
      chrome.runtime.sendMessage({ type: "trackEnded", tabId }).catch(() => {});
    })
  );
  settle(true);
  return true;
}

// Returns whether a graph (or an in-flight start) actually took the update: the worker's active
// list can hold a STALE tab when a trackEnded message was lost, and an update swallowed silently
// would leave that tab's slider dead for the tab's whole life (a reload does not clear the list,
// only closing the tab does). The worker uses the ack to heal the entry and start fresh.
function update(tabId, gain, useLimiter) {
  const g = graphs.get(tabId);
  if (!g) return false;
  // Retargeting an in-flight start: the answer is not known yet - a synchronous ok here would
  // let the worker record mode 'capture' while getUserMedia can still reject, the exact lie the
  // acked start exists to prevent. Hand back the start's own completion instead.
  if (g.pending) { g.latest = { gain, useLimiter }; return g.done; }
  g.gain.gain.setTargetAtTime(gain, g.ctx.currentTime, 0.02);     // smooth, no click
  applyLimiter(g, useLimiter, false);                             // ramped toggle, no click
  return true;
}

function stop(tabId) {
  const g = graphs.get(tabId);
  if (!g) return;
  if (g.pending) { g.cancelled = true; graphs.delete(tabId); return; } // cancel an in-flight start
  // Pop-free release: detach from the map now (so a new start builds fresh), ramp to unity,
  // then tear down once the ramp has settled.
  graphs.delete(tabId);
  try { g.gain.gain.setTargetAtTime(1, g.ctx.currentTime, 0.02); } catch (_) {}
  setTimeout(() => {
    try { g.source.disconnect(); } catch (_) {}
    try { g.gain.disconnect(); } catch (_) {}
    try { g.limiter.disconnect(); } catch (_) {}
    try { g.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    try { g.ctx.close(); } catch (_) {}
  }, 120);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== "offscreen") return;
  if (msg.cmd === "start") {
    // Async ack: resolves only once the capture is genuinely live (or has failed).
    start(msg.tabId, msg.streamId, msg.gain, msg.useLimiter)
      .then((ok) => { try { sendResponse({ ok: !!ok }); } catch (_) {} });
    return true;
  }
  if (msg.cmd === "update") {
    const r = update(msg.tabId, msg.gain, msg.useLimiter);
    if (r && typeof r.then === "function") {
      // pending start retargeted: ack with ITS outcome, once known
      r.then((ok) => { try { sendResponse({ ok: !!ok }); } catch (_) {} });
      return true;
    }
    sendResponse({ ok: r });
    return;
  }
  if (msg.cmd === "stop") stop(msg.tabId);
});
