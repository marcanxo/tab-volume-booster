// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 marcanxo
//
// background.js - service worker / orchestrator.
//
// Per tab it decides between two boost paths and routes gain to the right one:
//   element mode  → in-page content script hook (fullscreen PRESERVED)
//   capture mode  → offscreen tabCapture engine  (universal; fullscreen disabled while boosting)
//
// The choice comes from a non-destructive probe (content.js assess()). We only engage
// the in-page hook on elements that pass the pre-check, so we never silence a tab.
//
// Per-tab state lives in chrome.storage.session: clears on browser close, wiped on tab close.

const TABGAIN = (id) => `tabgain:${id}`;   // number
const TABMODE = (id) => `tabmode:${id}`;   // { mode:'element'|'capture'|'paused', frameId?, conflict? }
const TABFS  = (id) => `tabfs:${id}`;      // bool: user prefers fullscreen over capture for this tab
const ACTIVE_KEY = "active";               // array of tabIds with a live CAPTURE graph
const LIMITER_KEY = "useLimiter";          // storage.local, global pref

// auto-restore-after-reload tuning. status:'complete' fires before YouTube attaches its
// <video>/blob, so we re-probe a few times instead of falling back to capture on the first miss.
const RESTORE_ATTEMPTS = 8;
const RESTORE_DELAY_MS = 400;

// "Off" = exactly unity (1.0×): no gain processing, so we release (and capture mode hands fullscreen
// back). Any other level - boosting (>1) OR attenuating (<1, e.g. ducking a backing track under a
// guitar) - engages the graph. TABGAIN is only ever stored at a non-unity level.
const isUnity = (g) => Math.abs(g - 1) < 1e-6;
const isActiveGain = (g) => typeof g === "number" && !isUnity(g);

const sget = async (k) => (await chrome.storage.session.get(k))[k];
const sset = (k, v) => chrome.storage.session.set({ [k]: v });
const sdel = (k) => chrome.storage.session.remove(k);

// ---- capture-mode bookkeeping ----
// All mutations of the shared active list go through one chain: mark/unmark are read-modify-writes
// on a single storage key and get called from serialized AND unserialized paths (trackEnded,
// captureFailed, tab close) - interleaving them could resurrect or lose entries.
let activeChain = Promise.resolve();
function withActiveLock(fn) {
  const p = activeChain.then(fn, fn);
  activeChain = p.then(() => {}, () => {});
  return p;
}
async function getActive() { const l = await sget(ACTIVE_KEY); return Array.isArray(l) ? l : []; }
const setActive = (l) => sset(ACTIVE_KEY, l);
const markActive = (id) => withActiveLock(async () => {
  const l = await getActive();
  if (!l.includes(id)) { l.push(id); await setActive(l); }
});
const unmarkActive = (id) => withActiveLock(async () => {
  await setActive((await getActive()).filter((x) => x !== id));
});

// ---- offscreen document (capture engine host) ----
let offscreenSetup = null;
async function offscreenExists() {
  if (chrome.offscreen.hasDocument) return chrome.offscreen.hasDocument();
  const c = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  return c.length > 0;
}
async function ensureOffscreen() {
  if (await offscreenExists()) return false;
  if (offscreenSetup) { await offscreenSetup; return false; }
  offscreenSetup = chrome.offscreen
    .createDocument({ url: "offscreen.html", reasons: ["USER_MEDIA"], justification: "Apply gain to captured tab audio." })
    .finally(() => { offscreenSetup = null; });
  await offscreenSetup;
  return true;
}
// .catch: when no offscreen doc exists yet (e.g. a 'stop' for a never-captured tab, or on tab close),
// this message has no receiver and rejects with "Receiving end does not exist" - harmless, so swallow it.
const toOffscreen = (m) => chrome.runtime.sendMessage({ target: "offscreen", ...m }).catch(() => {});

// ---- content script ----
async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content.js"] });
  } catch (_) { /* some frames (chrome://, pdf viewer, store) can't be injected */ }
}
const toFrame = (tabId, frameId, m) =>
  chrome.tabs.sendMessage(tabId, m, frameId != null ? { frameId } : undefined).catch(() => null);

// ---- probe: broadcast to frames, aggregate candidate reports, pick the best ----
const probeWaiters = new Map(); // probeId -> { tabId, cands, timer }; keyed per-probe so two
let probeSeq = 0;               //   concurrent probes for one tab (restore loop vs popup) can't clobber
const restoring = new Map();    // tabId -> true|priorMode while an auto-restore loop is in flight
const pendingRekick = new Set(); // tabIds whose element was swapped mid-restore → re-run once after

// ---- per-tab op queue: user actions (setGain / setFsPriority) run strictly in arrival order.
// Without this, a quick slider wiggle (2.0× → 1.0×) runs two setGain calls CONCURRENTLY in the
// worker, and the release can finish before the engage lands - leaving a live boost the popup
// says is off. Serializing per tab makes the last user action always win.
const opChain = new Map(); // tabId -> tail promise
function serialized(tabId, fn) {
  const tail = (opChain.get(tabId) || Promise.resolve()).catch(() => {}).then(fn);
  opChain.set(tabId, tail);
  tail.catch(() => {}).finally(() => { if (opChain.get(tabId) === tail) opChain.delete(tabId); });
  return tail;
}
function pickBest(cands) {
  const safe = cands.filter((c) => c.cand.hasElement && c.cand.safe);
  if (!safe.length) return null;
  safe.sort((a, b) => (b.cand.playing === a.cand.playing ? b.cand.area - a.cand.area : b.cand.playing - a.cand.playing));
  return safe[0]; // { frameId, cand }
}
async function predictMode(tabId) {
  await ensureContentScript(tabId);
  return new Promise((resolve) => {
    const id = ++probeSeq;
    const st = { tabId, cands: [] };
    const settle = () => {
      clearTimeout(st.timer);
      clearTimeout(st.grace);
      probeWaiters.delete(id); // delete OUR entry only - never a concurrent probe's
      const best = pickBest(st.cands);
      resolve(best ? { mode: "element", frameId: best.frameId } : { mode: "capture" });
    };
    probeWaiters.set(id, st);
    st.timer = setTimeout(settle, 350); // ceiling for pages whose frames answer slowly or not at all
    // Early-resolve, deliberately narrow: ONLY an audibly-playing safe element in the TOP frame may
    // settle the window early (after a 50ms grace for stragglers). Anything less - muted previews,
    // ad iframes, any sub-frame - waits the full 350ms exactly as before, because settling early on
    // a fast small frame would EXCLUDE a slower main-player frame from pickBest entirely, and an
    // engage that then SUCCEEDS on the wrong frame is sticky (mode + frameId persist). A top-frame
    // audible playing element losing to a bigger audible iframe answering later is the one case this
    // trades away - two simultaneously audible players is pathological, and the old multi-frame area
    // bias is an accepted residual anyway. This keeps the fast path for the cases that matter
    // (YouTube, X: player in the top frame) at zero behavior change for iframe-player sites.
    st.onCand = (frameId, cand) => {
      // cand.substituted = a stand-in reported because the frame's top-ranked element is
      // unhookable; it may win pickBest after the full window but must never shortcut it.
      if (st.grace || frameId !== 0 || cand.substituted || !(cand.playing && cand.safe && cand.audible)) return;
      st.grace = setTimeout(settle, 50);
    };
    chrome.tabs.sendMessage(tabId, { cmd: "probe" }).catch(() => {}); // broadcasts to all frames
  });
}

const getMode = async (tabId) => (await sget(TABMODE(tabId))) || null;
const setMode = (tabId, info) => sset(TABMODE(tabId), info);
const clearMode = (tabId) => sdel(TABMODE(tabId));

// ---- capture path gain control ----
async function captureSetGain(tabId, gain, useLimiter) {
  const createdFresh = await ensureOffscreen();
  if (createdFresh) await withActiveLock(() => setActive([])); // new doc → no graphs (same lock as mark/unmark)
  const active = await getActive();
  if (active.includes(tabId)) {
    toOffscreen({ cmd: "update", tabId, gain, useLimiter });
  } else {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    toOffscreen({ cmd: "start", tabId, streamId, gain, useLimiter });
    await markActive(tabId);
  }
}
async function captureStop(tabId) { toOffscreen({ cmd: "stop", tabId }); await unmarkActive(tabId); }

// ---- release (1.0× / off): tear down whichever path, restore fullscreen ----
async function release(tabId) {
  // Broadcast the stop to ALL frames, not just the recorded one: TABMODE can be stale or cleared
  // (mid-restore), and a re-probe may have retargeted the mode to a different frame earlier - a
  // hook we engaged anywhere must never survive a release. stop() is idempotent in every frame.
  await toFrame(tabId, null, { cmd: "stop" });
  await captureStop(tabId); // also release capture if it was the active path
  await sdel(TABGAIN(tabId));
  await clearMode(tabId);
}

// ---- once the in-page element hook is unavailable, decide CAPTURE vs PAUSED.
// fsPriority is the per-tab user choice "I'd rather keep native fullscreen than boost via capture".
// conflict = the element is already hooked by another app/page (the case we surface + explain).
async function applyCaptureOrPause(tabId, gain, useLimiter, conflict) {
  // Whatever happens next, no element hook of OURS may stay hot underneath: a frame retarget or a
  // transient engage failure could otherwise leave element gain AND capture gain stacked (double
  // boost). The broadcast is a no-op in frames without a hook and can't touch a foreign app's hook.
  await toFrame(tabId, null, { cmd: "stop" });
  if ((await sget(TABFS(tabId))) === true) {
    await captureStop(tabId);                       // make sure nothing is capturing the tab
    const info = { mode: "paused", conflict: !!conflict };
    await setMode(tabId, info);
    return info;                                    // fullscreen kept; boost intentionally not applied
  }
  try {
    await captureSetGain(tabId, gain, useLimiter);     // start/refresh capture FIRST…
    const info = { mode: "capture", conflict: !!conflict };
    await setMode(tabId, info);                          // …then record the mode, so it never lies
    return info;
  } catch (_) {
    // Couldn't capture (e.g. the activeTab grant was revoked by a reload, or another app holds the
    // tab). Don't leave a 'capture' mode pointing at a graph that doesn't exist, and don't tell the
    // popup it's capturing - clear the mode and report 'none' so a later popup re-apply re-probes.
    await clearMode(tabId);
    return { mode: "none", conflict: !!conflict, failed: true };
  }
}

// ---- main entry: set a tab's boost level ----
async function setGain(tabId, gain, useLimiter) {
  if (isUnity(gain)) { await release(tabId); return { mode: "none" }; } // unity = off (boost & attenuate both engage)

  await sset(TABGAIN(tabId), gain);

  let info = await getMode(tabId);
  if (!info) { info = await predictMode(tabId); await setMode(tabId, info); }

  // Element mode preserves fullscreen AND boosts, so always prefer it when the probe allows.
  if (info.mode === "element") {
    let res = await toFrame(tabId, info.frameId, { cmd: "engage", gain, useLimiter });
    if (res === null) {
      // Delivery failure (frame gone / no receiver) - NOT a refusal. The player may live in a
      // fresh frame now (SPA replaced its iframe), so re-probe once before abandoning element mode.
      await clearMode(tabId);
      const fresh = await predictMode(tabId);
      await setMode(tabId, fresh);
      if (fresh.mode !== "element") return await applyCaptureOrPause(tabId, gain, useLimiter, false);
      // Retargeting to a different frame: make sure the old frame's hook (if any survived) is
      // parked at unity first - it would otherwise stay hot alongside the new one.
      if (fresh.frameId !== info.frameId) await toFrame(tabId, info.frameId, { cmd: "stop" });
      res = await toFrame(tabId, fresh.frameId, { cmd: "engage", gain, useLimiter });
    }
    if (res && res.ok) {
      // The tab may have been in CAPTURE mode before this probe picked element (a hookable player
      // appeared after a "next episode" swap): never leave the offscreen graph applying its gain
      // UNDER the fresh element hook - the two would stack to double volume.
      if ((await getActive()).includes(tabId)) await captureStop(tabId);
      return { mode: "element", confirmed: !!res.signal };
    }
    // Hook couldn't engage. reason 'already-hooked' = another app/page owns the element (a CONFLICT
    // we explain); other reasons (suspended / cross-origin) are ordinary capture fallbacks.
    return await applyCaptureOrPause(tabId, gain, useLimiter, !!(res && res.reason === "already-hooked"));
  }

  // Already capture/paused → re-evaluate against the current fsPriority, keeping the conflict flag.
  return await applyCaptureOrPause(tabId, gain, useLimiter, !!info.conflict);
}

// ---- prepare (popup open): non-destructive predict + restore stored level ----
async function prepare(tabId) {
  const gain = (await sget(TABGAIN(tabId))) ?? 1;
  const fsPriority = (await sget(TABFS(tabId))) === true;
  // If a reload-restore is in flight, don't launch a competing probe or commit a premature mode -
  // let the restore loop settle. Flag it so the popup skips its own re-apply (the loop handles it).
  if (restoring.has(tabId)) {
    const p = restoring.get(tabId);                   // stashed prior mode (or `true` very briefly)
    const pm = p && typeof p === "object" ? p : null;
    return { mode: pm ? pm.mode : "capture", conflict: !!(pm && pm.conflict), gain, fsPriority, restoring: true };
  }
  let info = await getMode(tabId);
  // Display-only prediction - deliberately NOT persisted. A pre-load "capture" guess would stick
  // in TABMODE and route a later boost straight to capture (fullscreen lost) even though the
  // player has long since attached a hookable element; setGain re-probes fresh instead.
  if (!info) info = await predictMode(tabId);
  return { mode: info.mode, conflict: !!info.conflict, gain, fsPriority };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target === "offscreen") return; // not for us

  if (msg.type === "frameCandidate") {
    const tabId = sender.tab && sender.tab.id;
    if (tabId != null) {
      // Fan out to every in-flight probe for this tab (there can be more than one).
      for (const st of probeWaiters.values()) {
        if (st.tabId === tabId) {
          st.cands.push({ frameId: sender.frameId, cand: msg.cand });
          if (st.onCand) st.onCand(sender.frameId, msg.cand);
        }
      }
    }
    return;
  }

  if (msg.type === "trackEnded") { unmarkActive(msg.tabId); return; } // capture stream died (reload)

  if (msg.type === "captureFailed") {
    // Offscreen couldn't open the capture (expired streamId, another capturer, …). Drop the
    // bookkeeping so the active list / mode never claim a graph that doesn't exist.
    unmarkActive(msg.tabId);
    clearMode(msg.tabId);
    return;
  }

  if (msg.type === "elementLost") {
    // The hooked element was removed (player swapped it). content.js has already torn down the
    // dead graph; patiently re-engage on the new element (same machinery as reload-restore).
    // deferIfBusy=true so a swap during an in-flight restore re-runs afterwards instead of dropping.
    const tabId = sender.tab && sender.tab.id;
    if (tabId != null) kickRestore(tabId, true);
    return;
  }

  if (msg.type === "navigated") {
    // Same-tab transition without a page load: a player <iframe> was swapped / re-src'd
    // ("next episode"), an SPA route changed, or a first user gesture just unlocked a frame
    // whose engage was refused as 'suspended'. Re-assert the stored level. kickRestore
    // no-ops after one storage read if this tab isn't at a non-unity level.
    const tabId = sender.tab && sender.tab.id;
    if (tabId != null) kickRestore(tabId, true);
    return;
  }

  if (msg.type === "setFsPriority") {
    // Per-tab "prefer fullscreen over capture" toggle. Re-evaluate the tab from a clean slate.
    serialized(msg.tabId, async () => {
      await sset(TABFS(msg.tabId), !!msg.value);
      await clearMode(msg.tabId);
      const g = await sget(TABGAIN(msg.tabId));
      if (!isActiveGain(g)) return { mode: "none" };
      const pref = await chrome.storage.local.get(LIMITER_KEY);
      return await setGain(msg.tabId, g, pref[LIMITER_KEY] !== false);
    }).then(sendResponse).catch(() => sendResponse({ mode: "none", failed: true }));
    return true;
  }

  if (msg.type === "prepare") {
    prepare(msg.tabId).then(sendResponse).catch(() => sendResponse({ mode: "none", gain: 1 }));
    return true;
  }

  if (msg.type === "setGain") {
    serialized(msg.tabId, () => setGain(msg.tabId, msg.gain, msg.useLimiter))
      .then(sendResponse)
      .catch((err) => { console.error("setGain failed:", err); sendResponse({ mode: "none", failed: true }); });
    return true;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  restoring.delete(tabId);      // forget any in-flight restore bookkeeping for the closed tab
  pendingRekick.delete(tabId);  // (the loop itself self-aborts via its non-unity gain recheck)
  // The storage cleanup runs THROUGH the per-tab op queue: an in-flight setGain would otherwise
  // rewrite tabgain/tabmode right after the deletes, leaking orphaned session entries.
  serialized(tabId, async () => {
    await sdel(TABGAIN(tabId));
    await sdel(TABFS(tabId));
    await clearMode(tabId);
    await unmarkActive(tabId);
    toOffscreen({ cmd: "stop", tabId });
  });
});

// ---- auto-restore boost after a full-document reload / navigation ----
// A reload destroys the in-page graph (element mode) and the capture track; the per-tab gain in
// storage.session survives, but until now nothing re-applied it until the popup was reopened (bug).
// Platform realities baked in (verified against Chrome's docs):
//   • Element mode becomes audible with NO click only where the autoplay policy lets a fresh
//     AudioContext run - i.e. high-MEI origins like youtube.com. content.js refuses to hook a
//     suspended context, so low-MEI sites just wait for the popup (same as before - no regression).
//   • Capture mode can't be restarted here: a top-level reload revokes the activeTab-style capture
//     grant, so getMediaStreamId throws. applyCaptureOrPause then clears the mode (rather than
//     leaving a lie) and the stored level snaps back when the popup is reopened.
//   • status:'complete' fires before the player attaches its <video>/blob, so we retry through all
//     attempts instead of prematurely deciding "capture".
async function restoreAfterLoad(tabId, gain, useLimiter, prior) {
  // A tab that was already CAPTURE/PAUSED (DRM, cross-origin, or a known conflict) won't become
  // element-hookable just by waiting, and re-capturing after a reload usually fails anyway - so
  // don't grind the full loop for it; once there's no hookable element, apply once and stop.
  const priorCapture = !!(prior && (prior.mode === "capture" || prior.mode === "paused"));
  for (let i = 0; i < RESTORE_ATTEMPTS; i++) {
    // Re-read the level EVERY iteration: the user may have released (→ abort) or moved the slider
    // (→ apply the new level, not the one captured when the restore started) mid-loop.
    const g = await sget(TABGAIN(tabId));
    if (!isActiveGain(g)) return; // tab closed / dropped to 1.0× mid-restore → abort
    // The tab itself may have closed mid-loop (the serialized cleanup already ran): bail before
    // setMode/ensureOffscreen can recreate session keys or an idle offscreen doc for a dead tab.
    try { await chrome.tabs.get(tabId); } catch (_) { return; }
    const info = await predictMode(tabId); // re-injects content.js + non-destructive probe
    if (info.mode === "element") {
      await setMode(tabId, info);
      // The probe may have picked a DIFFERENT frame than before the swap: park the previous
      // frame's hook (if it survived) so it can't stay hot alongside the new one.
      if (prior && prior.mode === "element" && prior.frameId != null && prior.frameId !== info.frameId)
        await toFrame(tabId, prior.frameId, { cmd: "stop" });
      const res = await toFrame(tabId, info.frameId, { cmd: "engage", gain: g, useLimiter });
      if (res && res.ok) {
        // Same as setGain: a prior CAPTURE graph must not keep boosting under the new hook.
        if ((await getActive()).includes(tabId)) await captureStop(tabId);
        // Engage takes up to ~1.5s (probe + measure) - re-verify the user didn't release or
        // retarget the level meanwhile; the user's action must always win over the restore.
        const after = await sget(TABGAIN(tabId));
        if (!isActiveGain(after)) { await toFrame(tabId, null, { cmd: "stop" }); await clearMode(tabId); }
        else if (after !== g) await toFrame(tabId, info.frameId, { cmd: "engage", gain: after, useLimiter });
        return;
      }
      // 'already-hooked' = a conflict → resolve to capture/paused (honoring fsPriority) and stop.
      if (res && res.reason === "already-hooked") {
        await applyCaptureOrPause(tabId, g, useLimiter, true);
        await reverifyGain(tabId, g, useLimiter, true);
        return;
      }
      // The element can't be hooked safely (same-origin URL redirecting cross-origin): retrying
      // can't change that - fall back to capture (no conflict), exactly like setGain would.
      if (res && res.reason === "cross-origin-redirect") {
        await applyCaptureOrPause(tabId, g, useLimiter, false);
        await reverifyGain(tabId, g, useLimiter, false);
        return;
      }
      // DRM (or an unparseable src) can't become hookable by waiting either. Without this,
      // a DRM page holding one safe decoy element would keep predicting 'element' via the
      // probe's substitution all 8 iterations - grinding probes and leaving a wrong mode
      // record. ('cross-origin-no-cors' deliberately stays in the wait bucket: during an ad
      // break that's a transient interloper and waiting is exactly right.)
      if (res && (res.reason === "drm" || res.reason === "bad-url")) {
        await applyCaptureOrPause(tabId, g, useLimiter, false);
        await reverifyGain(tabId, g, useLimiter, false);
        return;
      }
      // 'suspended' (low-MEI: won't run without a gesture) can't improve by retrying. Clear the
      // stale element mode so a popup reopen re-probes; don't fall back to capture.
      if (res && res.reason === "suspended") { await clearMode(tabId); return; }
      // "no element yet / player still initializing" → keep waiting.
    } else if (priorCapture) {
      // No hookable element and this tab genuinely needs capture → apply once (honors fsPriority;
      // clears the mode rather than lying if capture can't start, e.g. grant revoked by reload).
      await applyCaptureOrPause(tabId, g, useLimiter, !!(prior && prior.conflict));
      await reverifyGain(tabId, g, useLimiter, !!(prior && prior.conflict));
      return;
    }
    await new Promise((r) => setTimeout(r, RESTORE_DELAY_MS));
  }
  // Exhausted and the tab was ELEMENT before (or had no prior): the player never re-attached a
  // hookable element in time. Do NOT force capture - that would disable native fullscreen on a tab
  // that was fullscreen-friendly. Leave the boost level stored but the mode cleared, so reopening
  // the popup re-probes (and the user can opt into capture there if they actually want it).
  await clearMode(tabId);
}

// After a restore-path capture apply (which can take a while: offscreen spin-up + getMediaStreamId),
// re-verify the stored level: the user may have released or moved the slider mid-apply, and their
// action must always win over the restore. Mirrors the element branch's post-engage re-check.
async function reverifyGain(tabId, applied, useLimiter, conflict) {
  const after = await sget(TABGAIN(tabId));
  if (!isActiveGain(after)) {
    // Released mid-apply. Tear the paths down but DON'T touch TABGAIN: a concurrent serialized
    // setGain may have re-written it right after our read, and deleting it here would silently
    // wipe the user's newest level (their release already removed the old value itself).
    await toFrame(tabId, null, { cmd: "stop" });
    await captureStop(tabId);
    await clearMode(tabId);
  } else if (after !== applied) {
    await applyCaptureOrPause(tabId, after, useLimiter, conflict);
  }
}

// Shared by reload (onUpdated) and element-swap (elementLost): patiently re-apply the stored boost.
// deferIfBusy=true (element-swap) re-runs once after an in-flight restore instead of being dropped.
async function kickRestore(tabId, deferIfBusy) {
  const gain = await sget(TABGAIN(tabId));
  if (!isActiveGain(gain)) return;         // only tabs at a non-unity level (boosted or attenuated)
  if (restoring.has(tabId)) {              // a restore is already running for this tab…
    if (deferIfBusy) pendingRekick.add(tabId); // …a swap still needs one more pass afterwards
    return;                                // (has-check + set below are ADJACENT - no await between)
  }
  restoring.set(tabId, true);
  try {
    const prior = await getMode(tabId);    // remember element vs capture/paused before we clear it
    restoring.set(tabId, prior || { mode: "capture" }); // stash for prepare()'s display while restoring
    await clearMode(tabId);                // stale frameId after reload/swap → force a fresh re-probe
    const pref = await chrome.storage.local.get(LIMITER_KEY);
    await restoreAfterLoad(tabId, gain, pref[LIMITER_KEY] !== false, prior);
  } finally {
    restoring.delete(tabId);
    if (pendingRekick.delete(tabId)) kickRestore(tabId, true); // a swap arrived mid-restore → one more pass
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // status 'complete' = full load finished. changeInfo.url alone = SPA route change
  // (history.pushState) - those never reach 'complete' again, but players swap on them.
  if (changeInfo.status !== "complete" && typeof changeInfo.url !== "string") return;
  if (!tab || !tab.url || !/^https?:/.test(tab.url)) return;  // skip chrome:// / store / etc.
  kickRestore(tabId, true); // defer-if-busy: a signal arriving mid-restore queues one more pass
});
