# Local API

General › Local API lets your own scripts and tools on the same computer use TwinDesk: send files
to the connected device and put text on the clipboard. It's off until you switch it on, on the
Mac, Windows and Linux (one-to-one, not Multi-device yet).

## Where it is

While it's on, TwinDesk writes `local-api.json` in its own folder (the path is shown under the
switch), readable only by you:

```json
{ "url": "http://127.0.0.1:52817/v1/", "port": 52817, "key": "…48 hex characters…" }
```

The port and the key change every time it starts, so read the file each time. Switching it off
removes the file and closes the port.

## Calls

Every call needs `Authorization: Bearer <key>`. Bodies are JSON (`Content-Type: application/json`).

| Call | Body | Answer |
|---|---|---|
| `GET /v1/status` | | `{"connected": true, "device": "Pixel"}` |
| `POST /v1/send` | `{"paths": ["/full/path/a.pdf", …]}` | `{"ok": true, "status": "sent"}`, or `"queued"` when the device isn't connected and Keep files to send is on |
| `POST /v1/clipboard` | `{"text": "…"}` | `{"ok": true}`; it then goes to the other device by Clipboard's own rules |

```sh
f="$HOME/Library/Application Support/TwinDesk/local-api.json"   # the path under the switch
url=$(jq -r .url "$f"); key=$(jq -r .key "$f")
curl -s -H "Authorization: Bearer $key" "${url}status"
curl -s -H "Authorization: Bearer $key" -H 'Content-Type: application/json' \
  -d '{"paths":["/Users/me/Desktop/report.pdf"]}' "${url}send"
```

## What it refuses

- Anything not from this computer: it listens on 127.0.0.1 only, and the `Host` must be
  `127.0.0.1:<port>` or `localhost:<port>`.
- Anything a browser sends (an `Origin`, `Referer` or `Sec-Fetch-*` header), so a web page can't
  reach it even if it guesses the port.
- A missing or wrong key, a body that isn't JSON, more than 256 KB, paths that aren't absolute or
  don't exist.
