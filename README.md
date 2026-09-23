# Tab Volume Booster

[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/lcbedgoeigfomodfdiepidklaoplonii?label=Chrome%20Web%20Store&color=4285F4)](https://chromewebstore.google.com/detail/lcbedgoeigfomodfdiepidklaoplonii)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)

A Manifest V3 Chrome extension that makes any tab **louder (up to 6×) or quieter (down to silence)** - and keeps native fullscreen working whenever it can.

It's a *hybrid*: per tab it automatically picks the boosting method that preserves fullscreen, and only falls back to tab-capture when it has to.

---

## Features

- **Boost _and_ reduce.** One centered slider: **1× = off** sits in the middle. Drag **right** to boost (up to **6×**), drag **left** to make it quieter (down to **0× = silent**). The whole left half is the quiet range with fine ~0.01 steps, so you can dial in something like `0.05×` - handy for ducking a backing track under a live instrument.
- **Fullscreen preserved by default.** On YouTube, Twitch and most HTML5 sites it hooks the page's own media element, so native fullscreen keeps working while boosting.
- **Per-tab memory.** Each tab remembers its own level while it's open (including across YouTube's autoplay/next-video). Closing the tab forgets it. Nothing is shared between tabs.
- **Save a level for a site (opt-in).** Press *save* in the popup and every new tab you open on that site starts at that level (see [Usage](#usage)). Saved levels stay on your device and are forgotten with one click.
- **Survives reload.** After an F5 the level re-applies automatically - no need to reopen the popup (see [Notes](#notes--limits) for the exceptions).
- **Handles player element swaps.** When a site replaces its `<video>` (e.g. ad → content) - or swaps the whole player `<iframe>` on a "next episode" transition without a page load - the boost re-attaches to the new element.
- **Conflict handling.** If the page already routes its player through its own audio processing (or another app/extension does), you get a clear choice: boost via capture, or keep native fullscreen with no boost.
- **Built-in limiter.** Tames distortion on hard boosts; toggle is click-free.
- **One-click reset** back to 1× (off), which also forgets a level saved for the site.
- **Localized.** The popup ships in 14 languages, auto-selected from your browser's language. Adding another is a single JSON file - see [TRANSLATING.md](TRANSLATING.md).
- **Private.** Nothing is uploaded: no analytics, no accounts, no third parties. Stored on your device only: each tab's level, the method in use and your fullscreen preference (forgotten when the tab closes), the levels you saved for sites, plus the limiter preference. (The one request it ever makes is a same-origin redirect check against the site you're on - see [Privacy](#privacy).)

---

## The two modes

The little pill under the readout shows which mode the current tab is using:

- **Fullscreen mode** (green) - hooks the page's own `<video>`/`<audio>` via Web Audio (`createMediaElementSource → gain → limiter`). No tab capture, so Chrome keeps the Fullscreen API available. Used on YouTube and most standard HTML5 video.
- **Capture mode** (amber) - falls back to `chrome.tabCapture` when the element can't be hooked (DRM such as Netflix/Spotify, cross-origin media without CORS, or sites with no media element). Works on almost anything, but Chrome disables fullscreen while a tab is captured - drop to **1×** to get fullscreen back.

The mode is chosen by a **non-destructive pre-check** (source origin / `crossOrigin` attribute / DRM state / whether an `AudioContext` can run). `createMediaElementSource` is one-shot and irreversible, so the extension only ever hooks elements that pass the pre-check, and can't silence a tab by mistake.

---

## Install

### From the Chrome Web Store (recommended)

**[➜ Install Tab Volume Booster](https://chromewebstore.google.com/detail/lcbedgoeigfomodfdiepidklaoplonii)** - one click, and updates arrive automatically.

What changed in each version: [CHANGELOG.md](CHANGELOG.md).

### From source (load unpacked)

You can always install straight from source - no store needed (requires Chrome 116+):

1. Download or `git clone` this repo to a permanent folder (don't delete it afterward - Chrome loads it from there).
2. Go to `chrome://extensions`.
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and select the folder containing `manifest.json`.
5. Pin the icon, open a normal page with audio, and click it.

---

## Usage

- **Slider:** centered at **1× (off)**. Right = louder (→ 6×), left = quieter (→ 0× silent). Readout heats blue → amber → red when boosting and turns cyan when reducing.
- **Reset:** the `reset` button (top-right of the popup) snaps back to 1× / off, and forgets a level saved for the site.
- **Save for this site:** the row under the limiter names the site you're on. *save* keeps the current level for it: every new tab you open on that site (a new tab, a typed address, a link from elsewhere) starts at that level, while a reload or a link within the site keeps whatever the tab has. Whatever you set in a tab afterwards stays that tab's own, and a level a tab only got from the saved one is left behind when the tab moves on to another site. The button reads *forget* once the slider sits on the saved level. Subdomains count as their own site (music.youtube.com is not youtube.com).
- **Limiter:** ON tames distortion on hard boosts; OFF = raw gain.
- **Prefer fullscreen** (appears only on a conflict): when the page (or another app) already processes the tab's audio itself, the pill reads *"Capture mode · conflict"*. Leave the toggle OFF to boost anyway via capture (fullscreen off), or turn it ON to keep native fullscreen and pause the boost (*"Fullscreen kept · boost paused"*). Remembered per tab.

---

## Permissions - and why each is needed

| Permission | Why |
|---|---|
| `tabCapture` | Capture a tab's audio for the fallback (Capture mode) boost. |
| `offscreen` | Host the audio engine for capture mode (MV3 service workers can't run Web Audio directly). |
| `scripting` | Inject the in-page hook on demand for Fullscreen mode. |
| `storage` | Remember your per-tab level, the levels you saved for sites, and the limiter preference (local only). |
| `activeTab` | Act on the current tab when you use the popup. |
| `host_permissions: <all_urls>` | So the in-page hook can run on whatever site you choose to boost. It runs only in tabs that have a level: injected when you open the popup or move the slider, when a tab arrives on a site you saved a level for, and re-injected automatically after a reload or player swap while that tab's level is set. It never runs anywhere else. |

---

## Notes & limits

- **DRM sites** (Netflix, Disney+, Spotify web, Prime, etc.) can't be adjusted in-page, so they're boosted via capture mode instead - fullscreen is unavailable there while boosted.
- **Loud, hot-mastered tracks** stop getting louder past ~2× with the limiter on - that's the limiter protecting your ears/headphones, not a bug. The upper range is headroom for quiet sources (a low podcast, an old upload). Turn the limiter off for raw gain.
- **Reload auto-restore** is audible on its own on high-engagement sites like YouTube (Chrome's autoplay policy lets their audio resume without a click). On rarely-visited sites Chrome needs a click first: the level returns with your first click or key press on the page, or when you reopen the popup. Capture-mode tabs need the popup reopened. A level saved for a site lands in a new tab the same way: on its own on high-engagement sites, with the first click elsewhere, and on capture-mode sites when you open the popup.
- **Browser pages** (`chrome://`, the Web Store, other extensions) can't be boosted and the popup says so.
- **After an update**, a tab that was already open keeps the previous version attached to its player until the tab is reloaded (Chrome allows one such attachment per player). Meanwhile it is boosted through capture mode, and the popup says so: reload the tab to get fullscreen back.
- Only **one capture per tab** exists in Chrome, so if another capture/booster extension already grabbed a tab, capture mode there will fail.

---

## How it's built

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest. |
| `background.js` | Service worker / orchestrator: picks the mode per tab, routes gain, restores after reload/element-swap. |
| `content.js` | Injected on demand - the in-page (Fullscreen-mode) Web Audio hook. |
| `offscreen.js` + `offscreen.html` | The capture-mode audio engine (gain + limiter). |
| `popup.html` + `popup.js` | The UI. |
| `_locales/*/messages.json` | UI translations (Chrome i18n). |

---

## Translations

The UI ships in English, German, Spanish, Brazilian Portuguese, French, Italian, Polish, Russian, Turkish, Japanese, Korean, Simplified Chinese, Hindi and Indonesian. Chrome picks the language automatically from the browser's UI language; English is the fallback.

Missing yours, or spotted awkward wording? Adding or fixing a language is a single JSON file - see [TRANSLATING.md](TRANSLATING.md).

---

## Privacy

This extension collects **no data** and uploads **nothing**. It stores only your per-tab settings (level, method in use, fullscreen preference, and which saved site the tab is on; forgotten when the tab closes), the levels you chose to save for sites (the site's host name and the level, until you forget them), the limiter on/off preference and the time of the last install or update, using Chrome's on-device storage.

It makes exactly one kind of network request: for **same-origin media URLs**, a `Range: bytes=0-0` request to that media file, to check whether the URL redirects to another host. That check is required because hooking cross-origin media would silence the tab permanently, and the redirect is invisible from the page. It runs when the extension is about to hook a media element, and ahead of time whenever it inspects a tab you have adjusted (opening the popup, moving the slider, re-applying after a reload or player swap): at most two media files per inspection and eight per page load, only for media that has already started loading. It goes to whichever origin serves that media (the site you're on, or an embedded player's own host), the response is discarded, media on other origins is never requested, and nothing is ever sent to us or to a third party. See [PRIVACY.md](PRIVACY.md).

---

## License

Copyright (C) 2026 marcanxo

This program is free software: you can redistribute it and/or modify it under the
terms of the **GNU General Public License** as published by the Free Software
Foundation, either **version 3** of the License, or (at your option) any later version.

It is distributed in the hope that it will be useful, but **WITHOUT ANY WARRANTY** -
without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR
PURPOSE. See the [`LICENSE`](LICENSE) file (full GPL v3 text) or
<https://www.gnu.org/licenses/gpl-3.0.html> for details.
