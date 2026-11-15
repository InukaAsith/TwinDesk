# FAQ

**Is it free?**
Yes, and open source under the GPL-3.0. No account, no subscription, no ads. If you'd like to help,
see [SPONSOR.md](../../SPONSOR.md).

**Does anything go through a server?**
No. Devices talk to each other directly, on your network, Bluetooth, Wi-Fi Direct, a USB cable or
your own Tailscale tailnet. The only internet request is the update check against GitHub's
releases, which you can turn off. Details in [Privacy and security](privacy-and-security.md).

**Can I use it over mobile data?**
Yes, with Tailscale on both devices. TwinDesk dials the computer's Tailscale address when it can't
find it nearby. Without Tailscale, a phone and a computer near each other still connect over
Bluetooth, and TwinDesk brings up Wi-Fi Direct for screens and big files.

**Which devices work together?**
Any two of Mac, Windows, Linux, Android, iPhone, iPad and a browser, and all of them at once with
[Multi-device](../multi-device.md). A Mac and a PC pair exactly like two Macs.

**Do both devices need the same version?**
No, but update both. A newer TwinDesk talks to an older one, and a feature that needs both sides
switches on once both have it. Overview shows the other side's version in red when it's older.

**Why does the Android app need wireless debugging?**
Android lets only privileged apps show the phone's screen, open apps on other displays and inject
touch. Wireless debugging gives TwinDesk that, once, without root. Everything else works without it.

**Why are there two Android APKs?**
Play Protect blocks downloaded apps that read notifications or texts or use Accessibility. The
normal APK leaves those out. The full one has them, and the computer installs it for you over
wireless debugging, keeping your settings.

**Do I need an app on my iPhone?**
No. TwinDesk Web works in Safari at `twindesk.local`. The app adds Share Screen, Photos and staying
connected over Bluetooth.

**Can it control the login screen?**
Not in the normal app. The operating system keeps the login screen, the lock screen and Windows'
UAC prompts away from normal apps.

**Is Electron heavy?**
TwinDesk uses Electron for its windows and media. Input and files run in native code and a separate
process. With the window open and a phone connected, all of TwinDesk used about 147 MB on a MacBook
Air ([more](../../README.md#electron)).

**How do I translate it?**
See [Languages](../i18n.md). Translations are welcome as pull requests.

**Where do I report a bug or a security problem?**
Bugs in [Issues](https://github.com/InukaAsith/TwinDesk/issues), with the log from Open log folder.
Security problems privately, as [SECURITY.md](../../SECURITY.md) says.
