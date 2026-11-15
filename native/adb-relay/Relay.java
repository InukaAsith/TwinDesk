// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The phone's end of Mirroring › Skip adbd (mac/scrcpy.js). adb starts it beside scrcpy-server as
// the shell user, and it passes the server's sockets straight to the computer over the Wi-Fi, so the
// picture, sound and input no longer go through adbd and the computer's adb server (and no longer
// wait behind a file being pushed on the same adb connection).
//
//   CLASSPATH=twindesk-relay.jar app_process / com.twindesk.relay.Relay <abstract socket> <count>
//
// stdin: the session's key (32 hex digits, one line), then held open: when it closes (the computer's
// adb shell ended) the relay ends. stdout: "TDRELAY <port>" once it listens on a TCP port of its own.
// Ends too once a passed connection closes, or when nothing has connected for 30 s.
//
// Each TCP connection: the relay sends a random 16-byte salt; both sides take
// HMAC-SHA256(key, salt)[0..16] as that connection's AES-128-GCM key. Then frames each way:
// u32 length, then ciphertext with its 16-byte tag; the nonce is the direction (0 = computer to
// phone, 1 = phone to computer) in byte 0 and a counter in bytes 4..12. The computer's first frame
// is "TDR1": only then does the relay connect to the server's socket, so nothing on the network can
// reach scrcpy-server without the key, and nothing it sends can be read or replayed.
package com.twindesk.relay;

import android.net.LocalSocket;
import android.net.LocalSocketAddress;

import java.io.BufferedReader;
import java.io.DataInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.security.SecureRandom;
import java.util.Arrays;

import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

public final class Relay {
    private static final byte[] HELLO = { 'T', 'D', 'R', '1' };
    private static final int MAX_FRAME = 1 << 20;
    private static volatile boolean passed = false;
    private static volatile long lastAccept = System.currentTimeMillis();

    public static void main(String[] args) throws Exception {
        final String name = args[0];
        final int count = Integer.parseInt(args[1]);
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in));
        String hex = in.readLine();
        if (hex == null || hex.trim().length() != 32) {
            System.err.println("ERROR no key");
            System.exit(2);
        }
        final byte[] key = unhex(hex.trim());
        // The computer's adb shell is gone: nothing else will connect.
        final BufferedReader hold = in;
        daemon(new Runnable() { public void run() {
            try { while (hold.readLine() != null) { } } catch (IOException ignored) { }
            System.exit(0);
        } });

        final ServerSocket ss = new ServerSocket(0, 8);
        System.out.println("TDRELAY " + ss.getLocalPort());
        System.out.flush();
        daemon(new Runnable() { public void run() {
            for (;;) {
                sleep(1000);
                if (!passed && System.currentTimeMillis() - lastAccept > 30000) System.exit(0);
            }
        } });

        final SecureRandom rnd = new SecureRandom();
        int done = 0;
        while (done < count) {
            final Socket s = ss.accept();
            lastAccept = System.currentTimeMillis();
            s.setTcpNoDelay(true);
            // One connection at a time, in order: scrcpy-server takes video, audio, control in turn.
            if (handshakeAndPass(s, name, key, rnd)) done++;
        }
        ss.close();
        // The passes run on their own threads; when one ends, the session is over (exit there).
        for (;;) sleep(60000);
    }

    private static boolean handshakeAndPass(Socket s, String name, byte[] key, SecureRandom rnd) {
        try {
            s.setSoTimeout(5000);
            byte[] salt = new byte[16];
            rnd.nextBytes(salt);
            OutputStream tcpOut = s.getOutputStream();
            tcpOut.write(salt);
            tcpOut.flush();
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(key, "HmacSHA256"));
            final SecretKeySpec k = new SecretKeySpec(Arrays.copyOf(mac.doFinal(salt), 16), "AES");
            final DataInputStream tcpIn = new DataInputStream(s.getInputStream());
            final Opener open = new Opener(k);
            byte[] hello = open.next(tcpIn);
            if (hello == null || !Arrays.equals(hello, HELLO)) throw new IOException("bad hello");
            s.setSoTimeout(0);
            final LocalSocket ls = new LocalSocket();
            try {
                ls.connect(new LocalSocketAddress(name, LocalSocketAddress.Namespace.ABSTRACT));
            } catch (IOException e) { // the server isn't listening yet: the computer tries again
                closeQuietly(s);
                return false;
            }
            passed = true;
            final InputStream lin = ls.getInputStream();
            final OutputStream lout = ls.getOutputStream();
            final Sealer seal = new Sealer(k, tcpOut);
            daemon(new Runnable() { public void run() {
                try {
                    byte[] buf = new byte[64 * 1024];
                    int n;
                    while ((n = lin.read(buf)) > 0) seal.write(buf, n);
                } catch (Exception ignored) { }
                System.exit(0);
            } });
            daemon(new Runnable() { public void run() {
                try {
                    byte[] p;
                    while ((p = open.next(tcpIn)) != null) { lout.write(p); lout.flush(); }
                } catch (Exception ignored) { }
                System.exit(0);
            } });
            return true;
        } catch (Exception e) {
            closeQuietly(s);
            return false;
        }
    }

    // Phone to computer.
    private static final class Sealer {
        private final SecretKeySpec key; private final OutputStream out; private long n = 0;
        Sealer(SecretKeySpec key, OutputStream out) { this.key = key; this.out = out; }
        void write(byte[] p, int len) throws Exception {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(128, nonce(1, n++)));
            byte[] ct = c.doFinal(p, 0, len);
            byte[] f = new byte[4 + ct.length];
            f[0] = (byte) (ct.length >>> 24); f[1] = (byte) (ct.length >>> 16); f[2] = (byte) (ct.length >>> 8); f[3] = (byte) ct.length;
            System.arraycopy(ct, 0, f, 4, ct.length);
            out.write(f);
            out.flush();
        }
    }

    // Computer to phone. null at the end of the stream; throws when a frame isn't the key's.
    private static final class Opener {
        private final SecretKeySpec key; private long n = 0;
        Opener(SecretKeySpec key) { this.key = key; }
        byte[] next(DataInputStream in) throws Exception {
            int len;
            try { len = in.readInt(); } catch (java.io.EOFException e) { return null; }
            if (len < 16 || len > MAX_FRAME) throw new IOException("bad frame");
            byte[] ct = new byte[len];
            in.readFully(ct);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, nonce(0, n++)));
            return c.doFinal(ct);
        }
    }

    private static byte[] nonce(int dir, long n) {
        byte[] b = new byte[12];
        b[0] = (byte) dir;
        for (int i = 0; i < 8; i++) b[11 - i] = (byte) (n >>> (8 * i));
        return b;
    }

    private static byte[] unhex(String s) {
        byte[] b = new byte[s.length() / 2];
        for (int i = 0; i < b.length; i++) b[i] = (byte) Integer.parseInt(s.substring(2 * i, 2 * i + 2), 16);
        return b;
    }

    private static void daemon(Runnable r) {
        Thread t = new Thread(r);
        t.setDaemon(true);
        t.start();
    }

    private static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException ignored) { }
    }

    private static void closeQuietly(Socket s) {
        try { s.close(); } catch (IOException ignored) { }
    }
}
