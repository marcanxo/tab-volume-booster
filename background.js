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
// Levels the user saved for a site live in chrome.storage.local: this device, until forgotten.

const TABGAIN = (id) => `tabgain:${id}`;   // number
const TABMODE = (id) => `tabmode:${id}`;   // { mode:'element'|'capture'|'paused', frameId?, conflict? }
const TABFS  = (id) => `tabfs:${id}`;      // bool: user prefers fullscreen over capture for this tab
const TABHOST = (id) => `tabhost:${id}`;   // the saved site the tab is on (kept only while it is on one)
const TABSEED = (id) => `tabseed:${id}`;   // true while the tab's level came from a saved site level, untouched since
const ACTIVE_KEY = "active";               // array of tabIds with a live CAPTURE graph
const LIMITER_KEY = "useLimiter";          // storage.local, global pref
const SITE = (host) => `site:${host}`;     // storage.local: the level saved for that site (number, never unity)

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
const lget = async (k) => (await chrome.storage.local.get(k))[k];
const lset = (k, v) => chrome.storage.local.set({ [k]: v });
const ldel = (k) => chrome.storage.local.remove(k);

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
// An engage that never answers must not hang the worker: the frame runs its commands through one
// chain, so a wedged engage there stalls every later command too, and the awaiting worker op with
// it (content.js bounds its own waits; this is the belt). Past the deadline the frame is told to
// stand down - the stop queues BEHIND the late engage in the frame's chain, so even a hook that
// lands afterwards is unwound - and the engage counts as a refusal, never as a delivery failure.
const ENGAGE_DEADLINE_MS = 10000;
async function engageFrame(tabId, frameId, m) {
  let timer;
  const res = await Promise.race([
    toFrame(tabId, frameId, m),
    new Promise((r) => { timer = setTimeout(() => r({ ok: false, reason: "engage-timeout" }), ENGAGE_DEADLINE_MS); }),
  ]);
  clearTimeout(timer);
  if (res && res.reason === "engage-timeout") toFrame(tabId, null, { cmd: "stop" });
  return res;
}

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
// A candidate no in-page hook can ever take, however long we wait: DRM, a src that cannot be
// parsed, or a PLAYING element with no URL at all (its media comes through srcObject - a
// MediaSource handle, as live-stream players use, or a stream) or from another origin without
// CORS. Only consulted when no safe candidate exists anywhere (a safe one always wins), so an ad
// playing over a hookable content player never counts: the probe reports the player instead.
function unhookableForGood(c) {
  const k = c.cand;
  if (!k.hasElement || k.safe) return false;
  if (k.reason === "drm" || k.reason === "bad-url") return true;
  return k.playing && (k.reason === "no-src" || k.reason === "cross-origin-no-cors");
}
function pickBest(cands) {
  const safe = cands.filter((c) => c.cand.hasElement && c.cand.safe);
  if (!safe.length) return null;
  // Same order as content.js rankElements: playing, then AUDIBLE, then biggest. Across frames the
  // audible check matters just as much - a big muted hero loop in the top frame must not beat the
  // audible player in an iframe, or the boost lands on silence with a green pill over it (and no
  // self-heal: the iframe is never armed, and every re-probe picks the loop again).
  const rank = (c) => (c.cand.playing ? 2 : 0) + (c.cand.audible ? 1 : 0);
  safe.sort((a, b) => rank(b) - rank(a) || b.cand.area - a.cand.area);
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
      // certain: the page's player is there and can only ever be reached by capture, so waiting
      // for a hookable element (the restore loop's patience) cannot pay off.
      resolve(best ? { mode: "element", frameId: best.frameId }
                   : { mode: "capture", certain: st.cands.some(unhookableForGood) });
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
  // Ask the engine FIRST, whatever the active list says: the list can lie in both directions.
  // Entry without a graph - the trackEnded message was lost (worker mid-restart when the capture
  // died on a navigation): an update sent into that void would leave the slider dead for the
  // TAB'S WHOLE LIFE, since a reload clears neither the list nor the tab id; the ack says "no
  // graph", the entry is healed, a fresh start follows. Graph without an entry - an unmark for
  // the OLD stream (trackEnded / captureFailed) landing after a newer start was already marked:
  // Chrome refuses a second stream id for a tab it is still capturing, so going straight to
  // getMediaStreamId would fail every slider move until release; the ack finds that graph.
  const ack = await chrome.runtime
    .sendMessage({ target: "offscreen", cmd: "update", tabId, gain, useLimiter })
    .catch(() => null);
  if (ack && ack.ok) { await markActive(tabId); return; }
  await unmarkActive(tabId);
  // Nothing answered for this tab. Whatever the engine may still hold (a graph mid-ramp after a
  // lost ack, a cancelled start) is torn down NOW, tracks included and acknowledged, so the new
  // stream id below is not refused for a capture that is still winding down.
  await chrome.runtime
    .sendMessage({ target: "offscreen", cmd: "stop", tabId, immediate: true })
    .catch(() => null);
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  // Marked BEFORE the start settles so a concurrent setGain routes into the acked-update path
  // (which retargets the in-flight start) instead of racing a second start. The start itself is
  // AWAITED: getUserMedia can fail asynchronously, and reporting 'capture' before the graph is
  // actually live would leave the popup showing an amber pill over a boost that never happened.
  await markActive(tabId);
  const started = await chrome.runtime
    .sendMessage({ target: "offscreen", cmd: "start", tabId, streamId, gain, useLimiter })
    .catch(() => null);
  if (!started || !started.ok) {
    await unmarkActive(tabId);
    throw new Error("capture start failed");
  }
}
async function captureStop(tabId) { toOffscreen({ cmd: "stop", tabId }); await unmarkActive(tabId); }

// ---- release (1.0× / off): tear down whichever path, restore fullscreen ----
async function release(tabId) {
  // Intent first: with the level gone, a worker death mid-release cannot leave a stored level
  // that the next reload or popup open would resurrect. Everything after is idempotent cleanup.
  await sdel(TABGAIN(tabId));
  await sdel(TABSEED(tabId));
  // Broadcast the stop to ALL frames, not just the recorded one: TABMODE can be stale or cleared
  // (mid-restore), and a re-probe may have retargeted the mode to a different frame earlier - a
  // hook we engaged anywhere must never survive a release. stop() is idempotent in every frame.
  await toFrame(tabId, null, { cmd: "stop" });
  await captureStop(tabId); // also release capture if it was the active path
  await clearMode(tabId);
}

// ---- once the in-page element hook is unavailable, decide CAPTURE vs PAUSED.
// fsPriority is the per-tab user choice "I'd rather keep native fullscreen than boost via capture".
// conflict = the element is already hooked by another app/page (the case we surface + explain).
async function applyCaptureOrPause(tabId, gain, useLimiter, conflict) {
  const before = JSON.stringify(await getMode(tabId)); // for the compare-and-clear in the catch
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
    // Compare-and-clear: only the record this call started from is dropped. The restore path
    // runs this outside the per-tab queue, and a user action may have recorded a working element
    // hook meanwhile (its captureStop is what cancelled our start) - that record must stay.
    if (JSON.stringify(await getMode(tabId)) === before) await clearMode(tabId);
    return { mode: "none", conflict: !!conflict, failed: true };
  }
}

// ---- main entry: set a tab's boost level ----
async function setGain(tabId, gain, useLimiter) {
  if (isUnity(gain)) { await release(tabId); return { mode: "none" }; } // unity = off (boost & attenuate both engage)

  // A level the user changes is the tab's own from here on and travels with the tab. A re-apply
  // of the same level (the popup does one on open) is not a change and keeps a seeded level seeded.
  if ((await sget(TABGAIN(tabId))) !== gain) await sdel(TABSEED(tabId));
  await sset(TABGAIN(tabId), gain);

  let info = await getMode(tabId);
  if (!info) { info = await predictMode(tabId); await setMode(tabId, info); }

  // Element mode preserves fullscreen AND boosts, so always prefer it when the probe allows.
  if (info.mode === "element") {
    let res = await engageFrame(tabId, info.frameId, { cmd: "engage", gain, useLimiter });
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
      res = await engageFrame(tabId, fresh.frameId, { cmd: "engage", gain, useLimiter });
    }
    if (res && res.ok) {
      // The tab may have been in CAPTURE mode before this probe picked element (a hookable player
      // appeared after a "next episode" swap): never leave the offscreen graph applying its gain
      // UNDER the fresh element hook - the two would stack to double volume. Unconditional: the
      // active list can miss a live graph (see captureSetGain), and a stop without one is a no-op.
      await captureStop(tabId);
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
  const site = await siteInfo(tabId);             // { host, saved } for the popup's site row
  // If a restore is in flight, don't launch a competing probe or commit a premature mode - let
  // the restore settle. Flag it: the popup then waits for the pass to end (afterRestore) instead
  // of applying on its own. The mode shown meanwhile is the tab's mode from before the pass when
  // there was one; otherwise none at all (the popup keeps "Checking…"), never a guess.
  if (restoring.has(tabId)) {
    const p = restoring.get(tabId);                   // stashed prior mode (or `true` very briefly)
    const pm = p && typeof p === "object" ? p : null;
    return { mode: pm ? pm.mode : undefined, conflict: !!(pm && pm.conflict), gain, fsPriority, restoring: true, ...site };
  }
  let info = await getMode(tabId);
  // Display-only prediction - deliberately NOT persisted. A pre-load "capture" guess would stick
  // in TABMODE and route a later boost straight to capture (fullscreen lost) even though the
  // player has long since attached a hookable element; setGain re-probes fresh instead.
  if (!info) info = await predictMode(tabId);
  return { mode: info.mode, conflict: !!info.conflict, gain, fsPriority, ...site };
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
    // bookkeeping so the active list / mode never claim a graph that doesn't exist - but only a
    // CAPTURE record: this arrives outside the per-tab queue, and a failed start for an old
    // stream must not wipe an element mode that a newer user action has recorded meanwhile.
    unmarkActive(msg.tabId);
    getMode(msg.tabId).then((m) => { if (m && m.mode === "capture") return clearMode(msg.tabId); }).catch(() => {});
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

  if (msg.type === "resync") {
    // A frame came back from the back/forward cache with its old graphs and arming intact. If
    // the tab has no active level any more (the user released while the page slept - that stop
    // could not reach a frozen document), shut the resurrected boost down; otherwise re-assert
    // the stored level through the ordinary restore machinery.
    const tabId = sender.tab && sender.tab.id;
    if (tabId == null) return;
    serialized(tabId, async () => {
      const g = await sget(TABGAIN(tabId));
      if (!isActiveGain(g)) {
        await toFrame(tabId, null, { cmd: "stop" });
        await clearMode(tabId);
      } else {
        kickRestore(tabId, true);
      }
    });
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

  if (msg.type === "afterRestore") {
    afterRestore(msg.tabId).then(sendResponse).catch(() => sendResponse({ mode: "none", failed: true }));
    return true;
  }

  if (msg.type === "siteSave") {
    siteSave(msg.tabId, msg.level).then(sendResponse).catch(() => sendResponse({ host: null, saved: null }));
    return true;
  }

  if (msg.type === "siteForget") {
    siteForget(msg.tabId).then(sendResponse).catch(() => sendResponse({ host: null, saved: null }));
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
    await sdel(TABHOST(tabId));
    await sdel(TABSEED(tabId));
    await clearMode(tabId);
    await unmarkActive(tabId);
    toOffscreen({ cmd: "stop", tabId });
  });
});

// ---- saved site levels ----
// Opt-in, per site, explicit: the user presses "save" in the popup and the level of that moment is
// kept for the site (storage.local: this device, until forgotten). It is applied when a tab ARRIVES
// on the site - a new tab, a typed address, a link from elsewhere - and never on a reload or an
// in-site navigation, so whatever the user then sets in the tab stays the tab's own, as before.
// Applying goes through the ordinary restore machinery below, with its platform limits: audible
// without a click only where the autoplay policy lets a fresh AudioContext run, otherwise with the
// first gesture on the page (the frame's one-shot retry); capture-mode sites wait for the popup,
// since no capture grant exists without it.
// Which site a tab is on is noted (TABHOST) only while the tab is on a site with a saved level:
// that note is what tells a reload or an in-site navigation from a new visit. Tabs anywhere else
// leave no trace of where they are.

// The site a URL belongs to, the way the popup shows it: the host without a leading "www.".
// Subdomains stay separate on purpose (music.youtube.com is not youtube.com). null for anything
// that is not a web page (chrome://, file://, the store), where nothing can be applied anyway.
function hostOf(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    return u.hostname.replace(/^www\./, "") || null;
  } catch (_) { return null; }
}
async function hostOfTab(tabId) {
  try { return hostOf((await chrome.tabs.get(tabId)).url); } catch (_) { return null; }
}
async function savedLevel(host) {
  if (!host) return null;
  const g = await lget(SITE(host));
  return isActiveGain(g) ? g : null;
}
// The level comes from the popup's slider, not from TABGAIN: it is what the user is looking at,
// and the setGain carrying it may still be queued. Saving "off" (unity) is a forget.
async function siteSave(tabId, level) {
  const host = await hostOfTab(tabId);
  if (!host) return { host: null, saved: null };
  if (isActiveGain(level)) {
    await lset(SITE(host), level);
    // The tab is on this site right now: note it, so its next reload is not taken for a new
    // visit that would put the saved level on top of whatever the user sets in the tab.
    if ((await sget(TABHOST(tabId))) === undefined) await sset(TABHOST(tabId), host);
  } else {
    await ldel(SITE(host));
  }
  return { host, saved: await savedLevel(host) };
}
async function siteForget(tabId) {
  const host = await hostOfTab(tabId);
  if (host) await ldel(SITE(host));
  return { host, saved: null };
}
// What the popup shows in its site row. Also notes a tab that sits on a saved site without a note
// (open since before an update, which clears session storage): its next reload must not count as
// a new visit, or the saved level would land on top of the one the user is about to set there.
async function siteInfo(tabId) {
  const host = await hostOfTab(tabId);
  const saved = await savedLevel(host);
  if (saved != null && (await sget(TABHOST(tabId))) === undefined) await sset(TABHOST(tabId), host);
  return { host, saved };
}
// A tab arrives on a site when its host changes. Runs through the per-tab queue, so it can never
// interleave with a user action on the same tab; the restore that applies the level runs after.
async function onArrival(tabId, url) {
  const host = hostOf(url);
  const prev = await sget(TABHOST(tabId));          // the saved site the tab was on, if any
  if (host && host === prev) return;                  // same saved site: a reload or in-site navigation
  // A level this tab only carried because of the site it came from stays behind with that site;
  // a level the user set in the tab themselves travels with the tab, as it always has.
  if ((await sget(TABSEED(tabId))) === true) await release(tabId);
  const saved = await savedLevel(host);
  if (saved == null) {
    if (prev !== undefined) await sdel(TABHOST(tabId)); // off the saved sites: no note kept
    return;
  }
  await sset(TABHOST(tabId), host);
  await sset(TABGAIN(tabId), saved);
  await sset(TABSEED(tabId), true);
  await clearMode(tabId); // whatever mode the previous site settled on says nothing about this one
}

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
    let g = await sget(TABGAIN(tabId));
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
      // The probe took a moment: re-read the level right before acting on it. A release meanwhile
      // (the user, or a tab leaving the site its seeded level belonged to, whose new document the
      // probe may just have found) must not be engaged over, and a level that changed meanwhile
      // is engaged at its new value rather than corrected afterwards.
      g = await sget(TABGAIN(tabId));
      if (!isActiveGain(g)) { await clearMode(tabId); return; }
      const res = await engageFrame(tabId, info.frameId, { cmd: "engage", gain: g, useLimiter });
      if (res && res.ok) {
        // Same as setGain: a prior CAPTURE graph must not keep boosting under the new hook
        // (unconditional - the active list can miss a live graph, a stop without one is a no-op).
        await captureStop(tabId);
        // Engage can take seconds (the redirect probe's deadline, which a late joiner may
        // extend to CHAIN_TOTAL_MAX, plus the resume wait and measure) - re-verify the user
        // didn't release or retarget the level meanwhile; their action must always win.
        const after = await sget(TABGAIN(tabId));
        if (!isActiveGain(after)) { await toFrame(tabId, null, { cmd: "stop" }); await clearMode(tabId); }
        else if (after !== g) await engageFrame(tabId, info.frameId, { cmd: "engage", gain: after, useLimiter });
        return;
      }
      // 'already-hooked' = a conflict → resolve to capture/paused (honoring fsPriority) and stop.
      if (res && res.reason === "already-hooked") {
        await applyCaptureOrPause(tabId, g, useLimiter, true);
        await reverifyGain(tabId, g, useLimiter, true);
        return;
      }
      // The element can't be hooked safely (same-origin URL redirecting cross-origin), or its
      // one-shot hook was ours and is spent ('own-hook-lost'). Retrying can't change either -
      // fall back to capture (no conflict: nobody else owns the element), like setGain would.
      if (res && (res.reason === "cross-origin-redirect" || res.reason === "own-hook-lost")) {
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
      // stale element mode so a popup reopen re-probes; don't fall back to capture. Broadcast a
      // stop FIRST: dropping the mode record also drops the frameId, so this is the last moment
      // the worker can disarm a frame that an earlier engage armed - an armed frame it no longer
      // tracks would keep self-hooking new elements at a level the slider no longer controls.
      // An engage that hit the worker's deadline is treated the same: retrying would only wait
      // out the deadline again, eight times over.
      if (res && (res.reason === "suspended" || res.reason === "engage-timeout")) {
        await toFrame(tabId, null, { cmd: "stop" });
        await clearMode(tabId);
        return;
      }
      // "no element yet / player still initializing" → keep waiting.
    } else if (priorCapture || info.certain) {
      // No hookable element and this tab genuinely needs capture - it did before, or the page's
      // player is one no in-page hook can ever take (DRM, a live stream fed through a MediaSource
      // handle). Apply once (honors fsPriority; clears the mode rather than lying if capture can't
      // start: a reload revokes the grant, and a new visit has none until the popup is opened)
      // and stop. Waiting could not change the answer, and a popup opened meanwhile would wait
      // on a restore that probes the page for many seconds before its own apply may run.
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
  // Same disarm as the 'suspended' exit above: with the mode record goes the frameId, so any
  // frame still armed from an earlier engage must stop self-hooking NOW or it never will.
  await toFrame(tabId, null, { cmd: "stop" });
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

// A popup that opened while a restore was running waits for that pass to settle, then gets what
// a popup opened afterwards would: the mode the restore confirmed, or - where the restore could not
// apply the level - the popup's own apply. That is the case for every page only capture can reach
// (DRM, cross-origin players): a restore never starts a capture on its own, and only an opened popup
// lets one start. Waiters are served at the end of the pass, while it still counts as running, so
// a re-run queued meanwhile starts only afterwards and can never interleave with their apply.
const restoreWaiters = new Map(); // tabId -> [resolve]
function afterRestore(tabId) {
  if (!restoring.has(tabId)) return settleForPopup(tabId);
  return new Promise((resolve) => {
    if (!restoreWaiters.has(tabId)) restoreWaiters.set(tabId, []);
    restoreWaiters.get(tabId).push(resolve);
  });
}
function settleForPopup(tabId) {
  return serialized(tabId, async () => {
    const g = await sget(TABGAIN(tabId));
    if (!isActiveGain(g)) return { mode: "none" };
    const info = await getMode(tabId);
    if (info) return { mode: info.mode, conflict: !!info.conflict }; // the restore applied it
    const pref = await chrome.storage.local.get(LIMITER_KEY);
    return await setGain(tabId, g, pref[LIMITER_KEY] !== false);
  });
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
    restoring.set(tabId, prior || {});    // stash for prepare()'s display while restoring ({} = unknown)
    await clearMode(tabId);                // stale frameId after reload/swap → force a fresh re-probe
    const pref = await chrome.storage.local.get(LIMITER_KEY);
    await restoreAfterLoad(tabId, gain, pref[LIMITER_KEY] !== false, prior);
  } finally {
    for (let w; (w = restoreWaiters.get(tabId)); ) {   // popups that opened mid-pass (afterRestore)
      restoreWaiters.delete(tabId);
      const res = await settleForPopup(tabId).catch(() => ({ mode: "none", failed: true }));
      for (const resolve of w) resolve(res);
    }
    restoring.delete(tabId);
    if (pendingRekick.delete(tabId)) kickRestore(tabId, true); // a swap arrived mid-restore → one more pass
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // status 'complete' = full load finished. changeInfo.url alone = SPA route change
  // (history.pushState) - those never reach 'complete' again, but players swap on them.
  if (changeInfo.status !== "complete" && typeof changeInfo.url !== "string") return;
  if (!tab || !tab.url) return;
  // Arrival first (it may seed or drop the level), then the ordinary restore of whatever level
  // the tab holds now. Pages that are not web pages (chrome://, the store) only register as
  // having left the previous site: nothing runs there.
  serialized(tabId, () => onArrival(tabId, tab.url)).catch(() => {}).then(() => {
    if (/^https?:/.test(tab.url)) kickRestore(tabId, true); // defer-if-busy: a signal arriving mid-restore queues one more pass
  });
});
