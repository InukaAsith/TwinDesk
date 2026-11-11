#!/usr/bin/env python3
# TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# A manual test of the signing helper from a terminal (try.sh builds it and runs this): signs in to
# Apple with the Apple ID typed here, signs TwinDesk's latest release and installs it on the
# connected iPhone. The password is read without echo and goes to the helper on stdin only.
#
# In the app the iPhone keeps the signing state (the certificate's key, the anisette identity) and
# the computer nothing. This test has no iPhone app to hand it to, so it keeps it in
# .try-state.json here (0600, not in git) for the next test run to use the same certificate.
# Delete that file when done testing.
import getpass
import json
import os
import subprocess
import sys

here = os.path.dirname(os.path.abspath(__file__))
helper = os.path.join(here, "target", "debug", "twindesk-ios-signer")
if "--ipa" in sys.argv:
    arch = "arm64" if os.uname().machine in ("arm64", "aarch64") else "x64"
    helper = os.path.join(here, "bin", arch, "twindesk-ios-signer")
state_path = os.path.join(here, ".try-state.json")


def once(request):
    out = subprocess.run([helper], input=json.dumps(request) + "\n", capture_output=True, text=True).stdout
    return json.loads(out.strip().splitlines()[-1])


devices = once({"op": "devices"}).get("devices", [])
if not devices:
    sys.exit("No iPhone found: connect it and tap Trust.")
state = {}
if os.path.exists(state_path):
    with open(state_path) as f:
        state = json.load(f)
# Signed in before (the state holds Apple's developer session): no password is asked for.
email, password = state.get("email", ""), None
if state.get("xcode_token") and "--signin" not in sys.argv:
    print("Refreshing with the session kept in .try-state.json (run with --signin to sign in again).")
else:
    email = input("Apple ID: ").strip()
    password = getpass.getpass("Password (not shown): ")

p = subprocess.Popen([helper, "--log"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)


def send(obj):
    p.stdin.write(json.dumps(obj) + "\n")
    p.stdin.flush()


request = {"op": "install", "udid": devices[0]["udid"], "email": email, "state": state}
# --ipa <file>: that IPA in place of TwinDesk's latest release (a build that installs other apps:
# TWINDESK_SIGNER_ANY_IPA=1 ./build.sh, which try.sh then runs from bin/).
if "--ipa" in sys.argv:
    request["ipa"] = os.path.abspath(sys.argv[sys.argv.index("--ipa") + 1])
if password:
    request["password"] = password
send(request)
password = None
for line in p.stdout:
    ev = json.loads(line)
    kind = ev.get("ev")
    if kind == "state":
        fd = os.open(state_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(ev["state"], f)
        print('{"ev":"state"}  (kept in .try-state.json for the next test run)')
    elif kind == "need2fa":
        print(line.strip())
        code = input("Code from your Apple devices (blank to stop): ").strip()
        send({"code": code} if code else {"abort": True})
    elif kind == "needcert":
        print(line.strip())
        serials = input("No free certificate slot. Serials to revoke, comma separated (blank to stop): ").strip()
        send({"revoke": [s.strip() for s in serials.split(",") if s.strip()]} if serials else {"abort": True})
    else:
        print(line.strip())
sys.exit(p.wait())
