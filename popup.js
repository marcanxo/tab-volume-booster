// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 marcanxo
//
// popup.js
//
// On open: ask the worker to prepare the tab (non-destructive probe + restore level),
// show the predicted mode, and re-apply the boost if one was set. The mode pill turns
// green ("Fullscreen mode") when the in-page hook is in play, amber ("Capture mode")
// when it fell back to tab capture (fullscreen disabled while boosting).

const MIN = 0.0;        // slider floor: below 1.0× attenuates (ducks the audio); 0 = silent
const UNITY = 1.0;      // exactly 1.0× = off (no processing)
const MAX = 6.0;
const LIMITER_KEY = "useLimiter";
const isUnity = (g) => Math.abs(g - UNITY) < 1e-6;

// i18n: with default_locale set, getMessage falls back to English automatically;
// the || k guard only covers a key missing from en/ too (shows the key, not blank UI).
const t = (k) => chrome.i18n.getMessage(k) || k;

// Localize the static markup (elements tagged data-i18n / data-i18n-title / data-i18n-aria).
// The English text in the HTML stays in place as the no-JS-visible default.
function applyI18n() {
  document.documentElement.dir = chrome.i18n.getMessage("@@bidi_dir") || "ltr";
  for (const el of document.querySelectorAll("[data-i18n]")) {
    const m = chrome.i18n.getMessage(el.dataset.i18n);
    if (m) el.textContent = m;
  }
  for (const el of document.querySelectorAll("[data-i18n-title]")) {
    const m = chrome.i18n.getMessage(el.dataset.i18nTitle);
    if (m) el.title = m;
  }
  for (const el of document.querySelectorAll("[data-i18n-aria]")) {
    const m = chrome.i18n.getMessage(el.dataset.i18nAria);
    if (m) el.setAttribute("aria-label", m);
  }
}

// The slider is POSITION-based (0..POS_MAX) so unity sits dead-center: the quiet range (0→1×) gets
// the whole LEFT half with fine ~0.01 steps, and boost (1→6×) gets the right half. That's what makes
// precise low levels (e.g. 0.05×) dialable instead of jumping straight from 0.1× to 0× (mute).
const POS_MAX = 1000;
const HALF = POS_MAX / 2;
function gainFromPos(pos) {
  return pos <= HALF
    ? Math.round((pos / HALF) * 100) / 100                                  // 0..1× in 0.01 steps
    : Math.round((UNITY + ((pos - HALF) / HALF) * (MAX - UNITY)) * 10) / 10; // 1..6× in 0.1 steps
}
function posFromGain(g) {
  return g <= UNITY
    ? Math.round(g * HALF)
    : Math.round(HALF + ((g - UNITY) / (MAX - UNITY)) * HALF);
}
// readout: 2 decimals when attenuating (0.05×), 1 when boosting (3.0×); trailing zeros trimmed
const fmtGain = (g) => (g < UNITY ? String(parseFloat(g.toFixed(2))) : g.toFixed(1));

const els = {
  body: document.body,
  readout: document.getElementById("readout"),
  sub: document.getElementById("sub"),
  slider: document.getElementById("slider"),
  limiter: document.getElementById("limiter"),
  mode: document.getElementById("mode"),
  modeText: document.getElementById("modeText"),
  fsRow: document.getElementById("fsRow"),
  fsToggle: document.getElementById("fsToggle"),
  conflictMsg: document.getElementById("conflictMsg"),
  reset: document.getElementById("reset")
};

let tab = null;
let useLimiter = true;
let fsPriority = false; // per-tab "prefer fullscreen over capture" (only meaningful on a conflict)
let paused = false;     // in 'paused' mode the slider value is a stored target, NOT an active boost

function canBoost(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return false;
    const h = u.hostname;
    if (h === "chrome.google.com" || h === "chromewebstore.google.com") return false;
    return true;
  } catch { return false; }
}

function colorFor(gain) {
  if (gain < UNITY) {
    // attenuation (quieter than original) - a calm cyan, brighter as it climbs back toward unity
    const k = Math.max(0, Math.min(1, gain));
    const r = Math.round(70 + (120 - 70) * k);
    const g = Math.round(150 + (190 - 150) * k);
    const b = Math.round(195 + (220 - 195) * k);
    return { accent: `rgb(${r}, ${g}, ${b})`, glow: `rgba(${r}, ${g}, ${b}, ${0.18 + 0.3 * (1 - k)})` };
  }
  // boost - keep the original heat curve, anchored at unity (1× = blue → 6× = red)
  const t = Math.min(1, Math.max(0, (gain - UNITY) / (MAX - UNITY)));
  let r, g, b;
  if (t < 0.5) {
    const k = t / 0.5;
    r = Math.round(110 + (255 - 110) * k);
    g = Math.round(168 + (176 - 168) * k);
    b = Math.round(254 + (64 - 254) * k);
  } else {
    const k = (t - 0.5) / 0.5;
    r = 255;
    g = Math.round(176 + (77 - 176) * k);
    b = Math.round(64 + (77 - 64) * k);
  }
  return { accent: `rgb(${r}, ${g}, ${b})`, glow: `rgba(${r}, ${g}, ${b}, ${0.15 + 0.45 * t})` };
}

function render(gain) {
  els.slider.style.setProperty("--fill", (posFromGain(gain) / POS_MAX) * 100 + "%");
  // Screen readers get the actual multiplier, not the raw 0-1000 track position.
  els.slider.setAttribute("aria-valuetext", fmtGain(gain) + "×");
  els.readout.innerHTML = `${fmtGain(gain)}<span class="x">×</span>`;
  if (paused) {
    // Boost is intentionally NOT applied - show a calm neutral palette, not the hot boost color,
    // so the big readout doesn't imply an active boost (the CSS also dims it via .paused-view).
    document.documentElement.style.setProperty("--accent", "#74e0a6");
    document.documentElement.style.setProperty("--glow", "rgba(116, 224, 166, 0.18)");
  } else {
    const { accent, glow } = colorFor(gain);
    document.documentElement.style.setProperty("--accent", accent);
    document.documentElement.style.setProperty("--glow", glow);
  }
}

function showMode(mode, conflict, fsPref) {
  paused = (mode === "paused");
  els.body.classList.toggle("paused-view", paused);

  // The explanation appears on a real conflict; the "Prefer fullscreen" toggle ALSO whenever the
  // tab is paused - paused means the toggle is what's pausing it, so it must always be escapable
  // (otherwise a tab whose conflict flag was lost would be stuck un-boostable with no UI).
  const showConflict = !!conflict && (mode === "paused" || mode === "capture");
  const showFsRow = paused || showConflict;
  els.fsRow.style.display = showFsRow ? "flex" : "none";
  els.conflictMsg.style.display = showFsRow ? "block" : "none";
  if (showFsRow) els.fsToggle.setAttribute("aria-checked", String(!!fsPref));

  if (mode === "element") {
    els.mode.dataset.state = "element";
    els.modeText.textContent = t("modeElement");
    els.mode.title = t("modeElementTitle");
  } else if (mode === "paused") {
    els.mode.dataset.state = "paused";
    els.modeText.textContent = t("modePaused");
    els.mode.title = conflict ? t("modePausedTitleConflict") : t("modePausedTitlePref");
    els.conflictMsg.textContent = conflict ? t("pausedMsgConflict") : t("pausedMsgPref");
  } else if (mode === "capture") {
    els.mode.dataset.state = "capture";
    els.modeText.textContent = conflict ? t("modeCaptureConflict") : t("modeCapture");
    els.mode.title = conflict ? t("modeCaptureTitleConflict") : t("modeCaptureTitle");
    if (conflict) els.conflictMsg.textContent = t("captureMsgConflict");
  } else if (mode === "none") {
    els.mode.dataset.state = "";          // drop the green/amber styling back to muted
    els.modeText.textContent = t("modeNone");
    els.mode.title = "";
  }
  // undefined → leave the last known label in place.
  render(gainFromPos(parseFloat(els.slider.value)));   // refresh palette (neutral + dimmed while paused)
}

function pushGain(gain) {
  chrome.runtime.sendMessage({ type: "setGain", tabId: tab.id, gain, useLimiter }, (res) => {
    if (!res || !res.mode) return;
    showMode(res.mode, res.conflict, fsPriority);
    // Apply FAILED (e.g. capture grant revoked): the stored target stays on the slider, but
    // nothing is boosting - dim the readout like the paused view so the big hot number
    // doesn't claim an active boost. showMode() above already reset the class for successes.
    if (res.failed === true) els.body.classList.add("paused-view");
  });
}

async function init() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  tab = active;

  if (!canBoost(tab?.url)) {
    els.body.classList.add("is-blocked");
    els.mode.style.display = "none"; // no probe will run - don't leave the pill on "Checking…"
    return;
  }
  els.sub.textContent = new URL(tab.url).hostname.replace(/^www\./, "") + " · " + t("subThisTab");

  const pref = await chrome.storage.local.get(LIMITER_KEY);
  useLimiter = pref[LIMITER_KEY] !== false;
  els.limiter.setAttribute("aria-checked", String(useLimiter));

  // The slider is live BEFORE the prepare round-trip resolves: prepare can take a beat (probe
  // across frames, worker cold start), and a user who opened the popup to drag immediately
  // would otherwise have their drag silently discarded and the thumb snapped back. tab.id and
  // the limiter pref are known here - that is all pushGain needs.
  let userTouched = false;
  els.slider.addEventListener("input", () => {
    userTouched = true;
    const g = gainFromPos(parseFloat(els.slider.value));
    render(g);
    pushGain(g);
  });
  // The keydown handler must be live in the same window: without it a focused slider handles
  // arrow keys NATIVELY (step 1 of 1000), and gainFromPos of 499..504 rounds to exactly 1.0 -
  // which pushGain treats as a RELEASE, wiping the stored level on a keystroke that was meant
  // to nudge it. Keyboard support: the native step is 1/1000th of the track, so arrow presses
  // would mostly be dead (gain rounds to 0.01/0.1). Step the GAIN directly instead: 0.01 below
  // unity, 0.1 above.
  els.slider.addEventListener("keydown", (e) => {
    const dir = (e.key === "ArrowRight" || e.key === "ArrowUp") ? 1
              : (e.key === "ArrowLeft" || e.key === "ArrowDown") ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    userTouched = true;
    const cur = gainFromPos(parseFloat(els.slider.value));
    const step = (dir < 0 ? cur <= UNITY : cur < UNITY) ? 0.01 : 0.1;
    const g = Math.min(MAX, Math.max(MIN, Math.round((cur + dir * step) * 100) / 100));
    els.slider.value = posFromGain(g);
    render(g);
    pushGain(g);
  });

  // Non-destructive predict + restore (worker probes the page and returns mode + saved level).
  const prep = await new Promise((resolve) =>
    chrome.runtime.sendMessage({ type: "prepare", tabId: tab.id }, (r) => resolve(r || { mode: "none", gain: 1 })) // no worker answer → claim nothing, not "capture"
  );

  fsPriority = !!prep.fsPriority;
  let gain = typeof prep.gain === "number" ? Math.min(MAX, Math.max(MIN, prep.gain)) : UNITY;
  // A drag that happened while prepare was in flight is the newest user intent - never snap the
  // thumb back to the stored level over it.
  if (!userTouched) {
    els.slider.value = posFromGain(gain);
    render(gain);
  }
  showMode(prep.mode, prep.conflict, fsPriority);

  // Re-apply on open (restores the level after a reload; harmless nudge if already running).
  // Skip while a background reload-restore is in flight - it will apply the level, and a
  // competing call here could commit a premature "capture" before the player has loaded.
  // Skip too when the user already dragged: their push is newer than the stored level.
  if (!isUnity(gain) && !prep.restoring && !userTouched) pushGain(gain);

  els.limiter.addEventListener("click", () => {
    useLimiter = !useLimiter;
    els.limiter.setAttribute("aria-checked", String(useLimiter));
    chrome.storage.local.set({ [LIMITER_KEY]: useLimiter });
    const g = gainFromPos(parseFloat(els.slider.value));
    if (!isUnity(g)) pushGain(g); // at 1× nothing is engaged - pushing would just demote the pill
  });

  els.fsToggle.addEventListener("click", () => {
    fsPriority = els.fsToggle.getAttribute("aria-checked") !== "true";
    els.fsToggle.setAttribute("aria-checked", String(fsPriority));
    chrome.runtime.sendMessage({ type: "setFsPriority", tabId: tab.id, value: fsPriority }, (res) => {
      if (!res || !res.mode) return;
      showMode(res.mode, res.conflict, fsPriority);
      if (res.failed === true) els.body.classList.add("paused-view"); // same honest dim as pushGain
    });
  });

  els.reset.addEventListener("click", () => {
    els.slider.value = posFromGain(UNITY);   // snap the thumb to center (1×)
    render(UNITY);
    pushGain(UNITY);                          // setGain(1.0) → release → "Not boosting"
  });
}

applyI18n();
// Straight from the manifest, so the number shown can never drift from the build installed.
document.getElementById("ver").textContent = "v" + chrome.runtime.getManifest().version;
init();
