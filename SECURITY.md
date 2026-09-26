# Security Policy

## Supported versions

Only the latest version is supported. Chrome installs updates from the
[Chrome Web Store](https://chromewebstore.google.com/detail/lcbedgoeigfomodfdiepidklaoplonii)
automatically, so a fix reaches every user through a new release.

## Reporting a vulnerability

Please do not report a security problem in a public issue.

Report it privately instead: open the **Security & quality** tab of this repository and choose
**Report a vulnerability**, or go straight to
<https://github.com/marcanxo/tab-volume-booster/security/advisories/new>.

Helpful details:
- what an attacker could do, and under which conditions
- steps to reproduce, ideally with a page that shows the problem
- the extension version (shown at the bottom of the popup) and your Chrome version

The report stays private while a fix is prepared. Once the fix is out on the Chrome Web Store,
the advisory is published, with credit to you if you like.

## What counts

The extension can run on any site you choose to adjust, so anything that abuses that access is in
scope, for example:
- a web page making the extension act on its own, beyond the level you set in the popup
- a web page reading or changing the extension's settings, or running code in its context
- data leaving your device: the extension never sends anything anywhere, see
  [PRIVACY.md](PRIVACY.md)

Bugs in Chrome itself or in the sites you visit are out of scope. Please report those to their
makers.
