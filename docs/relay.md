# Your own relay

TwinDesk connects devices on the same network, over a USB cable, over Bluetooth, or through Tailscale. **Your own relay** adds one more way: a phone away from your computer's network connects through a small server that you run yourself. It is off until you add one, and nothing is sent anywhere before that.

## What the relay sees

- The relay only joins two connections and copies bytes between them.
- The session inside is TwinDesk's usual one: TLS with your computer's pinned certificate and the pairing's token. The relay can't read it or change it.
- The relay can't tell which devices are talking. The computer is known to it only by an id derived from the certificate.
- It keeps nothing on disk.

## Run it

You need Node 16 or later on a machine that both devices can reach, for example a small cloud server, or a home server with a forwarded port.

```
node relay/twindesk-relay.js --port 47100 --key "choose-a-secret"
```

The key is optional, but use one: only devices given the same key can use your relay. The environment variables `RELAY_PORT`, `RELAY_KEY` and `RELAY_HOST` work too.

Run the relay on another machine, not on the computer itself.

## Add it

1. On the computer, go to **General › Your own relay**.
2. Enter the address (for example `relay.example.com:47100`) and the key, then click **Save**. The row says when the computer is connected to the relay.
3. Connect the phone once on the same network. It learns about the relay from the computer.

After that, when the phone can't see the computer on its network, every other connection attempt goes through the relay. Remove the address on the computer and the phone forgets it at the next connection.

## Cost

While an address is set, the computer keeps one idle connection to the relay and sends a ping each minute. The phone does nothing until it needs the relay. Without an address, nothing runs.
