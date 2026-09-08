# Privacy Policy - Tab Volume Booster

_Last updated: 2026-09-08_

**Tab Volume Booster does not collect, store, transmit, share, or sell any personal data.**

## What it does
The extension only changes the audio volume of browser tabs you choose to adjust. All audio
processing happens locally, in real time, on your device.

## Data the extension stores (on your device only)
- **Per-tab settings** - the volume level, which method is in use (in-page hook or tab capture)
  and your "Prefer fullscreen" choice. Kept in Chrome's `session` storage and cleared when the
  tab or the browser is closed.
- **Limiter on/off preference** - kept in Chrome's `local` storage.

That's it. These settings never leave your browser.

## What the extension does not do
- No analytics, tracking, telemetry, or ads.
- No external servers, accounts, or third-party services. Nothing is ever uploaded.
- It does not record, save, or transmit any audio, page content, browsing history, or
  personal information.

## The one request it makes (and why)
Before routing a page's own audio through its volume control, the extension must be sure the
media is not cross-origin, because hooking such a source would silence the tab permanently. A
media URL that looks same-origin can still redirect to another host, and that redirect is
invisible from the page. So for **same-origin media URLs only**, the extension asks the site
you are already on for the first byte of that same media file (a `Range: bytes=0-0` request,
answered from cache when possible) purely to see whether it redirects elsewhere. The response
is discarded immediately.

The check runs when the extension is about to hook a media element, and ahead of time whenever
it inspects a tab you have adjusted (opening the popup, moving the slider, re-applying the level
after a reload or a player swap): at most two media files per inspection and eight per page
load, only for same-origin media that has already started loading. A check that failed is
repeated after 30 seconds at the earliest.

The request goes to whichever origin is serving that media: the site you are on, or, for an
embedded player, that player's own host. It is sent the way the page's own player would send it,
including that site's cookies. It never goes to us or to any analytics or third-party service,
and it carries no information about you beyond the ordinary request your browser would already
make for that file. Media on other origins is never requested this way.

## Permissions, in plain terms
- **Tab audio access / capture** is used solely to re-output the current tab's own audio at your
  chosen volume. The audio is processed locally and never leaves the device.
- **Site access** is needed so the in-page volume control can run on whatever site you choose to
  adjust. It runs only in tabs where you have set a level: it is injected when you open the popup
  or move the slider, and injected again automatically after a reload or a player swap while that
  tab's level is set. It never runs in tabs you have not adjusted, and it never reads or sends
  page content.

## Contact
Questions or issues: <https://github.com/marcanxo/tab-volume-booster> (open an issue).
