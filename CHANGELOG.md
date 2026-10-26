# Changelog

What each release brings, in plain terms. Versions match the ones published on the
[Chrome Web Store](https://chromewebstore.google.com/detail/lcbedgoeigfomodfdiepidklaoplonii).

## 1.2.3 - 2026-10-26

- **Reddit and other players built from web components.** Many players keep their video inside a
  web component: Reddit's feed, mux-player, media-chrome and similar. The extension finds these
  players and adjusts them in the page, with fullscreen kept. A clip gets your level from its
  first sound, whether it starts with a click, a key, the page's own autoplay or as the next clip
  of a feed.
- **Feeds that mix clips the extension can and cannot adjust in the page.** Some feeds serve part
  of their clips from servers that do not allow adjusting them in the page (Reddit, 9GAG). Those
  clips go through tab capture once you have opened the popup in that tab. While such clips keep
  coming, the tab stays in capture mode, so every clip starts at your level and the tab does not
  switch modes from clip to clip.
- **Ad frames do not take the level.** A hidden ad video in a frame of its own (9GAG) does not
  count as the page's player while the page's own clip plays. The popup shows capture mode, and
  the level reaches what you hear.
- **The slider works on an ad that plays.** When an ad plays that the extension cannot adjust in
  the page, moving the slider adjusts it through tab capture. Once the video itself plays again,
  the tab returns to fullscreen mode.
- **A saved level reaches a video that already plays.** When the extension arrives on a page
  whose video started first (a new YouTube tab, players that autoplay), it takes that video at
  once. On TikTok this means a saved level applies without opening the popup. TikTok's own
  loudness balancing between clips is then off in that tab.
- **Clips you scroll back to.** A clip you return to in a feed plays at your level again. Paused
  clips that wait in a feed cost no processing.
- **Back-to-back clips.** A feed clip that starts a moment before the previous one stops gets your
  level from its first sound.
- **One level, never two.** The in-page adjustment and tab capture never apply at the same time,
  so a level cannot multiply.
- **Less background work.** Without the popup's permission for tab capture, the extension does not
  try capture again and again. Pages built from web components are searched in small steps, so
  scrolling stays smooth.

## 1.2.2 - 2026-09-30

- **Security hardening.** Every part of the extension checks where a command comes from. The
  popup's commands are accepted only from the popup. The capture engine listens only to the
  extension's own background worker. The list of sites you saved a level for is readable by the
  extension itself only, not by the small script it places in pages you adjust. An ordinary web
  page cannot reach any of these paths. The checks cover a page that exploits a flaw in Chrome
  itself.

## 1.2.1 - 2026-09-24

The first Chrome Web Store release of the 1.2 line. It includes everything listed under 1.2.0.

- **No false "conflict" after an update.** A tab that is open while the extension updates still
  has the previous version attached to its player. Chrome allows only one such attachment per
  player until the page reloads. The popup says what happens in that case: the boost runs through
  tab capture for now, and reloading the tab brings fullscreen back. It does not blame the page
  with "already handles its own audio, or another app does".
- **Live streams on sites like Twitch are adjusted in-page.** Their players take the stream from
  a media handle instead of a file address. The extension recognizes such players as safe to
  adjust in-page, so they stay out of tab capture. Fullscreen keeps working while boosted. A
  level saved for the site reaches a new tab without opening the popup. If Chrome has not yet let
  the site play sound, it arrives with your first click on the page.
- **Saving a level leaves other open tabs alone.** A tab that is already on the site when you
  save a level for it in another tab keeps its own level, as intended. Its next video or reload
  does not switch it to the saved level. The saved level is for tabs that arrive on the site
  afterwards.
- **A saved level is in place the instant the player starts.** For a player in the page itself,
  the page knows the level before the player exists and applies it in the same instant playback
  begins, so a stream does not start at full volume on a tab saved below 1×. The level also
  returns faster after a reload for the same reason. Some live-stream players are told to play
  before their stream is attached. The extension catches those the moment the sound actually
  starts, so such a tab does not keep playing at native volume until you open the popup.

## 1.2.0 - 2026-09-23

- **Save a level for a site.** Set the slider and press *save* in the new row under the limiter.
  Every new tab you open on that site then starts at that level. On sites Chrome lets play sound
  without a click (YouTube and the like), this happens right away. Elsewhere it happens with your
  first click on the page. On sites that need capture mode it happens as soon as you open the
  popup. Whatever you set in a tab afterwards stays that tab's own, like any other per-tab level.
  A level a tab only got from the saved one stays behind when the tab moves on to another site.
  *forget* (or *reset*) drops the saved level again. Saved levels stay on your device.
- **A popup opened while a page is still loading waits for it.** It shows the confirmed status
  as soon as the page has settled, never a guessed one. It also applies the level itself wherever
  that is still needed. The automatic re-apply cannot start a capture on its own. On sites that
  need capture mode, the level therefore arrives with this first popup, not only with a second
  one. Pages whose player only capture can reach, such as DRM, settle as soon as the player
  starts. The extension does not spend many seconds
  searching them for a directly adjustable player.

## 1.1.9 - 2026-09-08

- **No dead slider on sites Chrome has not yet allowed to play sound.** On a site you rarely
  visit, you may set a level before your first click on the page, or reload a page with a stored
  level. Chrome's permission to play sound may then never come on its own. The extension waits
  only a moment for it, then steps back and applies the level with your first click. The tab
  does not stay stuck until you navigate away.
- **The audible player wins across frames.** Some pages run a large muted background loop next
  to the real player in an embedded frame. What you can hear takes priority, in every frame. The
  boost does not land on the silent loop while the popup shows everything as fine.
- **Capture mode bookkeeping.** The extension checks with its audio engine first instead of
  trusting its own notes. A rare timing mix-up cannot make every slider move fail on a captured
  tab until you reset it. A late failure report cannot wipe a working setting. A reset takes
  effect even if the extension is interrupted halfway.
- **The popup's reset button and limiter switch work right after opening**, not only once the
  first status has come back. An early reset click takes effect and is not overridden afterwards.
- **Documentation:** the privacy policy and README describe more precisely when the extension
  runs in a tab and when its one redirect check happens. They list all per-tab settings it keeps.

## 1.1.8 - 2026-08-16

- **A muted video cannot hold on to the boost.** Some pages keep a silent clip looping in the
  background, such as a preview or a decorative animation. When that clip grabs the boost first,
  the boost moves on to whatever is audible. The video you actually watch does not play at native
  volume while the popup claims everything is fine.
- **Pressing play on an already unmuted video applies the boost.** A paused video that was never
  muted gives no other signal when it starts. The extension reacts to the start itself, so such a
  video does not simply play at native volume.
- **After the extension updates itself, leftover copies in open tabs stand down.** Chrome updates
  extensions in the background. A page that loaded under the previous version keeps a leftover
  boost running that the new version cannot control. In the worst case the two stack and double
  the volume. The leftover detects the situation and returns the tab to native volume.
- **The status shown in the popup is confirmed, not assumed.** Capture mode reports success only
  once the capture has actually started. A capture that fails to start does not show as an active
  boost.
- **Navigating back to a page does not revive a boost you turned off.** Chrome restores pages
  from a cache when you press back. The restored page checks with the extension instead of
  resuming its cached state.
- **The popup takes input from its first moment.** Moving the slider or pressing an arrow key
  right after opening takes effect. An early arrow key cannot reset the stored level to 1.0 for
  good.

## 1.1.7 - 2026-07-30

- **Clicking a muted video applies the boost instantly.** The level is set inside the click
  itself, before the site unmutes the video. Nothing plays at the wrong volume first, however
  briefly. Feeds that unmute the next clip by themselves while you scroll are covered the same
  way. The level does not wait for a roundtrip through the background worker, which takes around
  200ms and is audible mainly on tabs turned down.
- **A dead capture stream cannot leave the slider broken for good.** A capture stream can die at
  an unlucky moment, for example when switching to the next episode. Volume changes then go to an
  audio engine that has shut down, and reloading the page does not help. The extension notices
  this and starts over. The first slider move repairs such a tab.
- **Clearer wording when a page processes its own audio.** Some sites route their video sound
  through their own processing. The note leads with what matters: the boost is on, and only
  fullscreen is unavailable. It does not blame "another app" and send you hunting for a program
  that does not exist.
- **Limits on what a page can make the extension do.** Hooks are created at a bounded rate and in
  a bounded count per page. A misbehaving site cannot pile up audio processing behind the scenes.

## 1.1.6 - 2026-07-28

- **The popup shows the installed version** and links to the source code on GitHub. You can
  check at a glance which build you are running and read exactly what it does.

## 1.1.5 - 2026-07-26

- **The boost applies about three times faster after you click a muted video.** On feeds where
  videos autoplay muted and only unmute when clicked, the stored level lands in roughly 200ms. It
  stays that fast no matter how many videos you click in a row. An anti-flood throttle that runs
  out of budget would otherwise hold the level back for up to two seconds. That is loud and
  unpleasant on tabs turned *down*. Signals that come from a real user gesture bypass the
  throttle. They have their own small allowance, so the protection against pages faking activity
  still holds.
- **A burst of signals collapsing into one message cannot use up the whole throttle budget.** Such
  a burst would otherwise delay the *next* genuine signal by up to two seconds. The issue affects
  1.1.4.
- **The privacy policy states the one network request.** The extension makes exactly one: a same-origin range request to the media file you
  are already playing. That request detects a redirect that would otherwise silence the tab
  permanently. Nothing is uploaded and no data leaves your device. See [PRIVACY.md](PRIVACY.md).

## 1.1.4 - 2026-07-18

- **The boost survives ad breaks.** Moving the slider while an ad plays from a different source
  keeps the boost on your video. The ad, which the extension cannot control, does not take the
  boost over. Your video stays boosted and fullscreen stays available for the rest of the session.
- **No slowdown on DRM sites** that also contain an ordinary media element. Routine page activity
  does not send the extension into a repeating check that never succeeds.

## 1.1.3 - 2026-07-17

- **Clicking a muted video always applies the boost.** Unmuting changes nothing the extension can
  observe. The workaround for this arms itself in every case, including the circumstances a busy
  feed often skips. The result does not depend on timing.

## 1.1.2 - 2026-07-10

- **The boost re-applies noticeably faster** when a page swaps its player or a video becomes
  audible.

## 1.1.1 - 2026-07-07

- Numerous fixes from a full review of the codebase. A video cannot be silenced for good. After a
  page reload or a player swap, the boost is neither lost nor applied twice.

## 1.1.0 - 2026-07-06

- **Speaks 14 languages**, picked automatically from your browser's language. Adding another is a
  single JSON file, see [TRANSLATING.md](TRANSLATING.md).

## 1.0.1 - 2026-07-05

- **The boost survives "next episode" transitions** on sites that swap the player without
  reloading the page. It is not silently lost, and the video does not play unboosted while the
  popup shows a level.

## 1.0.0 - 2026-06-17

- First release. Per-tab volume from 0x to 6x with a centered slider, a built-in limiter, native
  fullscreen preserved wherever the page's own audio can be adjusted, and tab capture as the
  fallback everywhere else.
