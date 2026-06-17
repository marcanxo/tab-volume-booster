# Tab Volume Booster

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)

A Manifest V3 Chrome extension that makes any tab **louder (up to 6×) or quieter (down to silence)** — and keeps native fullscreen working whenever it can.

It's a *hybrid*: per tab it automatically picks the boosting method that preserves fullscreen, and only falls back to tab-capture when it has to.

---

## Features

- **Boost _and_ reduce.** One centered slider: **1× = off** sits in the middle. Drag **right** to boost (up to **6×**), drag **left** to make it quieter (down to **0× = silent**). The whole left half is the quiet range with fine ~0.01 steps, so you can dial in something like `0.05×` — handy for ducking a backing track under a live instrument (e.g. Chordify).
- **Fullscreen preserved by default.** On YouTube and most HTML5 sites it hooks the page's own media element, so native fullscreen keeps working while boosting.
- **Per-tab memory.** Each tab remembers its own level while it's open (including across YouTube's autoplay/next-video). Closing the tab forgets it. Nothing is shared between tabs.
- **Survives reload.** After an F5 the level re-applies automatically — no need to reopen the popup (see [Notes](#notes--limits) for the exceptions).
- **Handles player element swaps.** When a site replaces its `<video>` (e.g. ad → content), the boost re-attaches to the new element.
- **Conflict handling.** If another app/extension already controls a tab's audio, you get a clear choice: boost via capture, or keep native fullscreen with no boost.
- **Built-in limiter.** Tames distortion on hard boosts; toggle is click-free.
- **One-click reset** back to 1× (off).
- **Private.** No network requests, no analytics, no accounts. The only thing stored is your per-tab level and the limiter preference, in Chrome's on-device extension storage.

---

## The two modes

The little pill under the readout shows which mode the current tab is using:

- **Fullscreen mode** (green) — hooks the page's own `<video>`/`<audio>` via Web Audio (`createMediaElementSource → gain → limiter`). No tab capture, so Chrome keeps the Fullscreen API available. Used on YouTube and most standard HTML5 video.
- **Capture mode** (amber) — falls back to `chrome.tabCapture` when the element can't be hooked (DRM such as Netflix/Spotify, cross-origin media without CORS, or sites with no media element). Works on almost anything, but Chrome disables fullscreen while a tab is captured — drop to **1×** to get fullscreen back.

The mode is chosen by a **non-destructive pre-check** (source origin / `crossOrigin` attribute / DRM state / whether an `AudioContext` can run). `createMediaElementSource` is one-shot and irreversible, so the extension only ever hooks elements that pass the pre-check — it never gambles a tab into silence.

---

## Install (load unpacked)

You can always install straight from source — no store needed (requires Chrome 116+):

1. Download or `git clone` this repo to a permanent folder (don't delete it afterward — Chrome loads it from there).
2. Go to `chrome://extensions`.
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and select the folder containing `manifest.json`.
5. Pin the icon, open a normal page with audio, and click it.

---

## Usage

- **Slider:** centered at **1× (off)**. Right = louder (→ 6×), left = quieter (→ 0× silent). Readout heats blue → amber → red when boosting and turns cyan when reducing.
- **Reset:** the `reset` button (top-right of the popup) snaps back to 1× / off.
- **Limiter:** ON tames distortion on hard boosts; OFF = raw gain.
- **Prefer fullscreen** (appears only on a conflict): when another app already controls the tab's audio, the pill reads *"Capture mode · conflict"*. Leave the toggle OFF to boost anyway via capture (fullscreen off), or turn it ON to keep native fullscreen and pause the boost (*"Fullscreen kept · boost paused"*). Remembered per tab.

---

## Permissions — and why each is needed

| Permission | Why |
|---|---|
| `tabCapture` | Capture a tab's audio for the fallback (Capture mode) boost. |
| `offscreen` | Host the audio engine for capture mode (MV3 service workers can't run Web Audio directly). |
| `scripting` | Inject the in-page hook on demand for Fullscreen mode. |
| `storage` | Remember your per-tab level + the limiter preference (local only). |
| `activeTab` | Act on the current tab when you use the popup. |
| `host_permissions: <all_urls>` | So the in-page hook can run on whatever site you choose to boost. It only acts when you open the popup or move the slider — it does not run on pages you haven't touched. |

---

## Notes & limits

- **DRM audio** (Netflix, Disney+, Spotify web, Prime, etc.) can't be boosted by any method — the browser won't route protected audio through Web Audio or capture.
- **Loud, hot-mastered tracks** stop getting louder past ~2× with the limiter on — that's the limiter protecting your ears/headphones, not a bug. The upper range is headroom for quiet sources (a low podcast, an old upload). Turn the limiter off for raw gain.
- **Reload auto-restore** is audible on its own on high-engagement sites like YouTube (Chrome's autoplay policy lets their audio resume without a click). On rarely-visited sites, and for capture-mode tabs, Chrome requires interaction first — the stored level snaps back the moment you reopen the popup.
- **Browser pages** (`chrome://`, the Web Store, other extensions) can't be boosted and the popup says so.
- Only **one capture per tab** exists in Chrome, so if another capture/booster extension already grabbed a tab, capture mode there will fail.

---

## How it's built

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest. |
| `background.js` | Service worker / orchestrator: picks the mode per tab, routes gain, restores after reload/element-swap. |
| `content.js` | Injected on demand — the in-page (Fullscreen-mode) Web Audio hook. |
| `offscreen.js` + `offscreen.html` | The capture-mode audio engine (gain + limiter). |
| `popup.html` + `popup.js` | The UI. |

---

## Privacy

This extension makes **no network requests** and collects **no data**. It stores only your per-tab volume level and the limiter on/off preference, using Chrome's on-device storage. Nothing is sent anywhere.

---

## License

Copyright (C) 2026 marcanxo

This program is free software: you can redistribute it and/or modify it under the
terms of the **GNU General Public License** as published by the Free Software
Foundation, either **version 3** of the License, or (at your option) any later version.

It is distributed in the hope that it will be useful, but **WITHOUT ANY WARRANTY** —
without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR
PURPOSE. See the [`LICENSE`](LICENSE) file (full GPL v3 text) or
<https://www.gnu.org/licenses/gpl-3.0.html> for details.
