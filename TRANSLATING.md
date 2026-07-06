# Translating Tab Volume Booster

Adding a language is **one JSON file** - no code changes needed. Thank you for contributing!

## How it works

The extension uses Chrome's built-in i18n system. Each language lives in:

```
_locales/<locale-code>/messages.json
```

Chrome picks the language automatically from the user's browser UI language and falls back to English (`_locales/en/`) for anything missing. (Users can't choose a language per extension - that's a Chrome limitation, not ours.)

## Adding a new language

1. Find your locale code in [Chrome's supported locales list](https://developer.chrome.com/docs/extensions/reference/api/i18n#locales)
   (e.g. `nl`, `sv`, `uk`, `ar`, `pt_PT`, `zh_TW` - note the underscore, not a dash).
2. Copy `_locales/en/messages.json` to `_locales/<your-code>/messages.json`.
3. Translate **only the `"message"` values**. Don't change the keys.
   The `"description"` fields are hints for you - you can keep or delete them.
4. Open a pull request. That's it.

## Rules that keep the UI working

- **`appDesc` must be ≤ 132 characters** - Chrome rejects the package otherwise.
- The popup is only **268px wide**: keep the status labels (`modeElement`, `modePaused`, `modeCapture`, `modeCaptureConflict`, `modeNone`) short, ideally under ~30 characters.
- Keep numeric level forms exactly as-is: `1×`, `6x`, `1.0×`, `0×` (Latin digits, same `×`), and keep the ` · ` separator where the English has it.
- `fsLabel` is the visible name of the *Prefer fullscreen* toggle. Three messages quote that name (`pausedMsgConflict`, `pausedMsgPref`, `captureMsgConflict`) - the quoted text there must **exactly match your `fsLabel` translation**, in your language's own quotation marks.
- Don't translate brand names: **Tab Volume Booster**, YouTube, Chrome.

## Improving an existing translation

Native-speaker polish is always welcome - if something reads awkwardly in your language,
just edit the file for your language and open a PR describing what sounded off.

## Testing your translation locally

1. Load the extension unpacked (see [README](README.md#from-source-load-unpacked)).
2. Chrome shows the language of its own UI: `chrome://settings/languages` → move your language
   to the top ("Display Google Chrome in this language") → restart Chrome.
3. Open the popup and check that everything fits and reads naturally.
