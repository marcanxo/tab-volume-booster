# Changelog

What changed in each release, in plain terms. Versions match the ones published on the
[Chrome Web Store](https://chromewebstore.google.com/detail/lcbedgoeigfomodfdiepidklaoplonii).

## 1.1.5 - 2026-07-26

- **The boost now applies about three times faster after you click a muted video.** On feeds where
  videos autoplay muted and only unmute when clicked, the stored level took up to two seconds to
  take hold, which was loud and unpleasant on tabs turned *down*. It now lands in roughly 200ms,
  and stays that fast no matter how many videos you click in a row. The cause was an anti-flood
  throttle running out of budget; signals that come from a real user gesture now bypass it, with
  their own small allowance so the protection against pages faking activity still holds.
- **Fixed: a burst of signals collapsing into one message could use up the whole throttle budget**,
  delaying the *next* genuine one by up to two seconds. Present since 1.1.4.
- **Privacy policy corrected.** It stated the extension makes no network requests. It makes exactly
  one: a same-origin range request to the media file you are already playing, to detect a redirect
  that would otherwise silence the tab permanently. Nothing is uploaded and no data leaves your
  device, but the old wording was wrong and is now accurate. See [PRIVACY.md](PRIVACY.md).

## 1.1.4 - 2026-07-18

- **The boost survives ad breaks.** Moving the slider while an ad played from a different source
  could hand the boost over to the ad, which the extension cannot control, leaving your video
  unboosted and disabling fullscreen for the rest of the session.
- **Fixed a slowdown on DRM sites** that also contained an ordinary media element: routine page
  activity sent the extension into a repeating check that never succeeded.

## 1.1.3 - 2026-07-17

- **Fixed: clicking a muted video sometimes never applied the boost at all.** Unmuting changes
  nothing the extension could observe, and the previous workaround only armed itself under
  circumstances that a busy feed often skipped, so the result depended on timing.

## 1.1.2 - 2026-07-10

- **The boost re-applies noticeably faster** when a page swaps its player or a video becomes
  audible.

## 1.1.1 - 2026-07-07

- Numerous fixes found in a full review of the codebase, including a case where a video could be
  silenced for good, and several where the boost was lost or applied twice after a page reload or
  a player swap.

## 1.1.0 - 2026-07-06

- **Now speaks 14 languages**, picked automatically from your browser's language. Adding another
  is a single JSON file, see [TRANSLATING.md](TRANSLATING.md).

## 1.0.1 - 2026-07-05

- **Fixed: the boost was silently lost on "next episode" transitions** on sites that swap the
  player without reloading the page. The popup still showed the old level while the video played
  unboosted.

## 1.0.0 - 2026-06-17

- First release. Per-tab volume from 0x to 6x with a centered slider, a built-in limiter, native
  fullscreen preserved wherever the page's own audio can be adjusted, and tab capture as the
  fallback everywhere else.
