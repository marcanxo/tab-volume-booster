// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 marcanxo
//
// offscreen.js — the audio engine.
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
//          is in flight — so a 'stop' or 'update' arriving mid-start cancels/retargets it instead
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
// fixed ~6ms pre-delay even when bypassed (imperceptible — the price of click-free toggling). The
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

async function start(tabId, streamId, gain, useLimiter) {
  const existing = graphs.get(tabId);
  if (existing) {
    if (existing.pending) { existing.latest = { gain, useLimiter }; existing.cancelled = false; }
    else update(tabId, gain, useLimiter);
    return;
  }

  // Register the placeholder BEFORE the async capture so concurrent messages see it.
  const entry = { pending: true, latest: { gain, useLimiter }, cancelled: false };
  graphs.set(tabId, entry);

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
      video: false
    });
  } catch (err) {
    console.error("tab capture failed for tab", tabId, err);
    // Only report if WE are still the active attempt — a superseded/cancelled start's failure
    // must not clobber the bookkeeping of a newer start/graph that replaced it.
    if (graphs.get(tabId) === entry) {
      graphs.delete(tabId);
      try { chrome.runtime.sendMessage({ type: "captureFailed", tabId }).catch(() => {}); } catch (_) {}
    }
    return;
  }

  if (entry.cancelled || graphs.get(tabId) !== entry) {
    // A 'stop' (or a replacement start) arrived while capture was starting → don't go live.
    try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    if (graphs.get(tabId) === entry) graphs.delete(tabId);
    return;
  }

  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const gainNode = ctx.createGain();
  gainNode.gain.value = entry.latest.gain;   // freshest values — an 'update' may have retargeted us
  const limiter = makeLimiter(ctx);

  const graph = { ctx, source, gain: gainNode, limiter, stream };
  // Static graph — limiter always in the path; toggled by ramping its ratio, never by rewiring.
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
      chrome.runtime.sendMessage({ type: "trackEnded", tabId });
    })
  );
}

function update(tabId, gain, useLimiter) {
  const g = graphs.get(tabId);
  if (!g) return;
  if (g.pending) { g.latest = { gain, useLimiter }; return; } // retarget the in-flight start
  g.gain.gain.setTargetAtTime(gain, g.ctx.currentTime, 0.02); // smooth, no click
  applyLimiter(g, useLimiter, false);                         // ramped toggle, no click
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

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== "offscreen") return;
  switch (msg.cmd) {
    case "start":  start(msg.tabId, msg.streamId, msg.gain, msg.useLimiter); break;
    case "update": update(msg.tabId, msg.gain, msg.useLimiter); break;
    case "stop":   stop(msg.tabId); break;
  }
});
