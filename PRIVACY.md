# Privacy Policy - Tab Volume Booster

_Last updated: 2026-07-25_

**Tab Volume Booster does not collect, store, transmit, share, or sell any personal data.**

## What it does
The extension only changes the audio volume of browser tabs you choose to adjust. All audio
processing happens locally, in real time, on your device.

## Data the extension stores (on your device only)
- **Per-tab volume level** - kept in Chrome's `session` storage and cleared when the tab or the
  browser is closed.
- **Limiter on/off preference** - kept in Chrome's `local` storage.

That's it. These settings never leave your browser.

## Data the extension does NOT do
- ❌ No analytics, tracking, telemetry, or ads.
- ❌ No external servers, accounts, or third-party services. Nothing is ever uploaded.
- ❌ It does not record, save, or transmit any audio, page content, browsing history, or
  personal information.

## The one request it makes (and why)
Before routing a page's own audio through its volume control, the extension must be sure the
media is not cross-origin, because hooking such a source would silence the tab permanently. A
media URL that looks same-origin can still redirect to another host, and that redirect is
invisible from the page. So for **same-origin media URLs only**, the extension asks the site
you are already on for the first byte of that same media file (a `Range: bytes=0-0` request,
answered from cache when possible) purely to see whether it redirects elsewhere. The response
is discarded immediately.

The request goes to whichever origin is serving that media: the site you are on, or, for an
embedded player, that player's own host. It never goes to us or to any analytics or third-party
service, and it carries no information about you beyond the ordinary request your browser would
already make for that file. Media on other origins is never requested this way.

## Permissions, in plain terms
- **Tab audio access / capture** is used solely to re-output the current tab's own audio at your
  chosen volume. The audio is processed locally and never leaves the device.
- **Site access** is needed so the in-page volume control can run on whatever site you choose to
  adjust. It activates only when you open the popup or move the slider, and does nothing on pages
  you haven't interacted with. It never reads or sends page content.

## Contact
Questions or issues: <https://github.com/marcanxo/tab-volume-booster> (open an issue).
