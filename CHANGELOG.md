# Changelog

What changed in each release, in plain terms. Versions match the ones published on the
[Chrome Web Store](https://chromewebstore.google.com/detail/lcbedgoeigfomodfdiepidklaoplonii).

## 1.2.0 - 2026-09-23

- **Save a level for a site.** Set the slider, press *save* in the new row under the limiter, and
  every new tab you open on that site starts at that level: right away on sites Chrome lets play
  sound without a click (YouTube and the like), otherwise with your first click on the page, and
  on sites that need capture mode as soon as you open the popup. Whatever you set in a tab
  afterwards stays that tab's own, as before, and a level a tab only got from the saved one is
  left behind when the tab moves on to another site. *forget* (or *reset*) drops the saved level
  again. Saved levels stay on your device.
- **A popup opened while a page is still loading now waits for it.** It used to show a guessed
  status at once and leave the rest to the automatic re-apply, which cannot start a capture on its
  own: on sites that need capture mode, the level only arrived once you opened the popup again. The
  popup now shows the confirmed status as soon as the page has settled, and applies the level
  itself wherever that is still needed. Pages whose player can only be reached by capture (DRM,
  or live streams that are not played from a file address) now settle as soon as the player
  starts, instead of being searched for a directly adjustable one for many seconds.

## 1.1.9 - 2026-09-08

- **Fixed: a tab whose slider could go dead on sites Chrome has not yet allowed to play sound.**
  On a site you rarely visit, setting a level before your first click on the page, or reloading
  a page with a stored level, could leave the extension waiting forever for permission that never
  comes; nothing worked in that tab until you navigated away. It now steps back after a moment and
  applies the level with your first click instead.
- **The audible player wins across frames.** On pages with a large muted background loop next to
  the real player in an embedded frame, the boost could land on the silent loop while the popup
  showed everything as fine. What you can hear now takes priority, in every frame.
- **Capture mode bookkeeping.** A rare timing mix-up could make every slider move fail on a
  captured tab until you reset it. The extension now checks with its audio engine first instead
  of trusting its own notes, a late failure report can no longer wipe a working setting, and a
  reset takes effect even if the extension is interrupted halfway.
- **The popup's reset button and limiter switch work right after opening**, not only once the
  first status has come back. An early reset click used to be lost and then overridden.
- **Documentation:** the privacy policy and README now describe more precisely when the extension
  runs in a tab and when its one redirect check happens, and list all per-tab settings it keeps.

## 1.1.8 - 2026-08-16

- **A muted video can no longer hold on to the boost.** Some pages keep a silent clip looping in
  the background (a preview or decorative animation). If that clip grabbed the boost first, the
  video you actually watched played at native volume while the popup claimed everything was fine.
  The boost now moves on to whatever is audible.
- **Pressing play on an already unmuted video now applies the boost.** A paused video that was
  never muted gave no signal at all when started, so it simply played at native volume.
- **After the extension updates itself, old copies in open tabs stand down.** Chrome updates
  extensions in the background; a page loaded before the update kept a leftover boost running
  that the new version could not control. In the worst case the two stacked and doubled the
  volume. The leftover now detects the situation and returns the tab to native volume.
- **The status shown in the popup is now confirmed, not assumed.** Capture mode only reports
  success once the capture has actually started, so a capture that fails to start no longer
  shows as an active boost.
- **Navigating back to a page no longer revives a boost you turned off.** Chrome restores pages
  from a cache when you press back; the restored page now checks with the extension instead of
  resuming its old state.
- **The popup no longer ignores input during its first moments.** Moving the slider or pressing
  an arrow key right after opening was lost, and an early arrow key could even reset the stored
  level to 1.0 for good.

## 1.1.7 - 2026-07-30

- **Clicking a muted video now applies the boost instantly.** The level is set inside the click
  itself, before the site unmutes the video, so nothing plays at the wrong volume first, however
  briefly. Feeds that unmute the next clip by themselves while you scroll are covered the same
  way. Previously this took around 200ms, audible mainly on tabs turned down.
- **Fixed: a tab whose slider could stop working for good.** When a capture stream died at an
  unlucky moment (switching to the next episode, for example), volume changes went to an audio
  engine that no longer existed, and reloading the page did not help. The extension now notices
  and starts over: the first slider move repairs such a tab.
- **Clearer wording when a page already processes its own audio.** The old note blamed "another
  app", sending you hunting for a program that does not exist; some sites route their video
  sound through their own processing. The note now leads with what matters: the boost is on,
  only fullscreen is unavailable.
- **Limits on what a page can make the extension do.** Hooks are created at most at a bounded
  rate and count per page, so a misbehaving site cannot pile up audio processing behind the
  scenes.

## 1.1.6 - 2026-07-28

- **The popup now shows the installed version** and links to the source code on GitHub, so you can
  check at a glance which build you are running and read exactly what it does.

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
