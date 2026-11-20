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
| `POST /v1/task-alert/start` | `{"title": "Build"}` | `{"ok": true, "id": "…32 hex characters…"}` when the connected Android phone permits task alerts |
| `POST /v1/task-alert/finish` | `{"id": "…", "ok": true}` | `{"ok": true}` when the completion was submitted to that same connection |
| `POST /v1/task-alert/cancel` | `{"id": "…"}` | `{"ok": true}`; drops a pending watch without alerting the phone |

```sh
f="$HOME/Library/Application Support/TwinDesk/local-api.json"   # the path under the switch
url=$(jq -r .url "$f"); key=$(jq -r .key "$f")
curl -s -H "Authorization: Bearer $key" "${url}status"
curl -s -H "Authorization: Bearer $key" -H 'Content-Type: application/json' \
  -d '{"paths":["/Users/me/Desktop/report.pdf"]}' "${url}send"
```

## Terminal task alerts on Android

On the Mac, turn on **General › Local API**. On the connected Android phone, turn on
**Notifications › Task alerts** for that paired Mac and allow TwinDesk to post notifications.
Use Node.js to wrap a command with the bundled script and receive an alert when it finishes or fails.

```sh
node "/Applications/TwinDesk.app/Contents/Resources/app/mac/scripts/twindesk-notify.js" \
  --title "Build" -- make
```

The label defaults to `Terminal task` and can contain up to 80 characters. The command runs
locally with its normal input, output, exit code and terminating signal. Only the label and
success or failure are sent to the phone. The script reads the current API address and key
from `~/Library/Application Support/MacShare/local-api.json` for each call.
`MACSHARE_PROFILE` selects the same alternate profile used by the Mac app.

This version watches commands started on a Mac with a direct Android connection. TwinDesk
needs the same authenticated connection from the start of the command until completion.
A watch expires after 24 hours, and the Mac holds up to 32 pending watches. The command still
runs if the API is unavailable or the alert is refused, and the wrapper prints the reason.
Interrupting the wrapper cancels its completion alert. The API confirms submission, and
Android decides whether to show a notification.

## What it refuses

- Anything not from this computer: it listens on 127.0.0.1 only, and the `Host` must be
  `127.0.0.1:<port>` or `localhost:<port>`.
- Anything a browser sends (an `Origin`, `Referer` or `Sec-Fetch-*` header), so a web page can't
  reach it even if it guesses the port.
- A missing or wrong key, a body that isn't JSON, more than 256 KB, paths that aren't absolute or
  don't exist.
