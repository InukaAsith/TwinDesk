# Translating TwinDesk

TwinDesk speaks five languages on every app: the computers (Windows, macOS, Linux), Android,
iPhone and iPad, and TwinDesk Web. New languages and fixes to existing ones are welcome.

| Language | Code | Desktop | Android | iPhone | Web | Translated by |
| --- | --- | --- | --- | --- | --- | --- |
| English | `en` | source | source | source | source | |
| 简体中文 (Simplified Chinese) | `zh-CN` | ✓ | ✓ | ✓ | ✓ | |
| Русский (Russian) | `ru` | ✓ | ✓ | ✓ | ✓ | |
| Türkçe (Turkish) | `tr` | ✓ | ✓ | ✓ | ✓ | |
| Português (Brasil) | `pt-BR` | ✓ | ✓ | ✓ | ✓ | Jairo Abreu ([@jairo-ab](https://github.com/jairo-ab), #156) |

Each catalog holds every English message. A missing or empty entry
shows in English, so a partial translation never breaks anything.

## Where the text lives

| App | Catalogs |
| --- | --- |
| Computers | `shared/lang/<code>.js` (English: `shared/lang/en.js`) |
| Android | `android/app/src/main/assets/i18n/<code>.json`; what Android itself shows in `res/values-<code>/strings.xml` |
| iPhone and iPad | `ios/TwinDesk/Lang/<code>.json`; what iOS shows in `<code>.lproj` (`Localizable.strings`, `AppShortcuts.strings`, `InfoPlist.strings`) |
| TwinDesk Web | `web/lang/<code>.js` |

The English text is the key. Translate the value, never the key:

```js
"Type as a hardware keyboard": "Donanım klavyesi gibi yaz",
```

## Rules

- **Keep placeholders as they are.** `{name}`, `{count}`, `{me}` and the rest are filled in later:
  `"Connected to {name}"` → `"{name} cihazına bağlandı"`. Move them anywhere in the sentence.
- **Translate whole sentences.** Don't split a sentence across entries or join two together.
- **Keys with a `|`** (`camera|Back`) give one English word a different meaning in one place.
  Translate only the meaning.
- **Leave these in English:** device names, file paths, protocol names, setting values and product
  names (TwinDesk, ReZume, AirPlay, Tailscale, ADB).
- **Menu paths** (`Phone › Settings › …`) should match the names the pages show in your language.
- **Keep it short** where English is short: labels sit on switches and buttons.

## Adding a string

When you add text to a page, put it through `I18n.t('…')` (desktop and web pages), `tr("…")`
(Android, iPhone), then add the English message to `shared/lang/en.js` and an entry to every other
catalog, in the same place. If you can't translate it, leave the English text as the value and say
so in the pull request; someone who speaks the language will follow up.

## Adding a language

1. Copy `shared/lang/en.js` to `shared/lang/<code>.js` and translate the values. Do the same for the
   Android, iPhone and web catalogs (the JSON files start from an existing language's file).
2. Add the language, its own name and its flag to the language pickers (General › Language on each
   app) and to the system-language matching. `docs/i18n.md` lists every place.
3. Run the tests below and open a pull request. You are credited in the changelog and here.

## Checking your work

```sh
node shared/test/i18n.js            # every catalog: keys, placeholders, fallback
node shared/test/i18n-integration.js
node shared/test/android-i18n.js
node shared/test/ios-i18n.js
node shared/test/web-i18n.js
```

`docs/i18n.md` has the full list, including the Electron tests that open the real pages in every
language, and how the runtime picks a language.
