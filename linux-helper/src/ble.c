// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Bluetooth LE (shared/protocol.js P.BLE) through BlueZ on D-Bus, for a device that isn't on this
// computer's network; the same commands and events as windows-helper's Ble.cs:
//   host:   a GATT application that advertises the TwinDesk service. A guest reads INFO, says
//           hello on CTRL, opens a pipe and writes UP; we notify DOWN. Commands bleStart {info},
//           bleStop, bleCtrl {dev, msg}, bleSend {dev, data}; events ble.state, ble.guest,
//           ble.open, ble.data, ble.close, ble.gone, ble.invite, ble.sent.
//   guest:  scan for the service, read INFO, open a pipe to a host. bleScan {on}, bleOpen {dev,
//           hello}, bleSend, bleClose {dev}; events ble.found, ble.opened, ble.data, ble.close,
//           ble.gone, ble.invite, ble.sent.
//   phones: the same as a guest for phones that advertise P.BLE.PHONE_SERVICE, the link kept up
//           between pipes. blpScan, blpLink {dev, hello}, blpOpen, blpEnd, blpDrop, blpSend;
//           events blp.* (found, linked, want, opened, data, sent, close, gone).
// main joins each pipe to the session's socket (shared/blepipe.js). Devices are keyed by their
// Bluetooth address in hex (AABBCCDDEEFF), as Ble.cs's guest does.
//
// Its own thread with a GLib main loop (scanning, signals, the GATT objects we host), started by
// the first ble*/blp* command. Where we connect, the LE link is our own (an L2CAP ATT socket, GATT
// spoken here): BlueZ's Device1.Connect would bring up classic Bluetooth and its profiles on a
// device it knows that way, and a Mac would ask to pair. Each pipe has a thread that connects and
// then writes in order, and its link a reader thread for notifications. BlueZ sends a hosted
// characteristic's notifications to every subscribed device and says nothing when one went out,
// so the host serves one guest's pipe at a time and paces its notifications (NOTIFY_US_PER_BYTE).
#include "helper.h"
#ifdef HAVE_BLE
#include <errno.h>
#include <fcntl.h>
#include <gio/gio.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#define U_SERVICE "b7f30001-2c4e-4d1a-9a57-3e8c2f6d0a91"
#define U_INFO "b7f30002-2c4e-4d1a-9a57-3e8c2f6d0a91"
#define U_CTRL "b7f30003-2c4e-4d1a-9a57-3e8c2f6d0a91"
#define U_UP "b7f30004-2c4e-4d1a-9a57-3e8c2f6d0a91"
#define U_DOWN "b7f30005-2c4e-4d1a-9a57-3e8c2f6d0a91"
#define U_PHONE "b7f30006-2c4e-4d1a-9a57-3e8c2f6d0a91"

#define APP "/com/twindesk/ble"
#define SVC_PATH APP "/service0"
#define ADV_PATH APP "/adv0"
#define GATT "org.bluez.GattCharacteristic1"
#define DEVICE "org.bluez.Device1"
#define PROPS "org.freedesktop.DBus.Properties"

#define MERGE 8192 // a backlog goes out in writes / notifications this big, not one per message
#define CALL_MS 20000
#define NOTIFY_US_PER_BYTE 10 // ~100 KB/s: BlueZ queues notifications without end otherwise
#define NOTIFY_MIN_US 2000

enum { C_INFO, C_CTRL, C_UP, C_DOWN, C_N };
static const char *CHR_UUID[C_N] = { U_INFO, U_CTRL, U_UP, U_DOWN };
static const char *CHR_FLAGS[C_N][3] = { { "read" }, { "write", "notify" }, { "write", "write-without-response" }, { "notify" } };

static GMainContext *ctx;
static GDBusConnection *bus;
static char adapter[64]; // its object path, '' when there's none
static GMutex mu; // the tables below, and everything in them
static GDBusNodeInfo *node; // introspection of what we export
static gboolean started;

// ---- events ----

static void jesc(GString *s, const char *v) {
  g_string_append_c(s, '"');
  for (const unsigned char *p = (const unsigned char *)v; *p; p++) {
    if (*p == '"' || *p == '\\') { g_string_append_c(s, '\\'); g_string_append_c(s, (char)*p); }
    else if (*p < 0x20) g_string_append_printf(s, "\\u%04x", *p);
    else g_string_append_c(s, (char)*p);
  }
  g_string_append_c(s, '"');
}

// {"event": name, "dev": dev, k: v}; raw: v is JSON already (one line), else a string.
static void event(const char *name, const char *dev, const char *k, const char *v, int raw) {
  GString *s = g_string_new("{\"event\":");
  jesc(s, name);
  if (dev) { g_string_append(s, ",\"dev\":"); jesc(s, dev); }
  if (k && v) {
    g_string_append_printf(s, ",\"%s\":", k);
    if (raw) g_string_append(s, v); else jesc(s, v);
  }
  g_string_append_c(s, '}');
  emit(s->str);
  g_string_free(s, TRUE);
}

static void event_num(const char *name, const char *dev, const char *k, long v) {
  char n[32];
  snprintf(n, sizeof n, "%ld", v);
  event(name, dev, k, n, 1);
}

static void event_data(const char *name, const char *dev, const guint8 *data, gsize n) {
  gchar *b = g_base64_encode(data, n);
  event(name, dev, "data", b, 0);
  g_free(b);
}

static void reply(double id, const char *error) {
  if (id <= 0) return;
  GString *s = g_string_new("");
  g_string_append_printf(s, "{\"id\":%.0f,\"ok\":%s", id, error ? "false" : "true");
  if (error) { g_string_append(s, ",\"error\":"); jesc(s, error); }
  g_string_append_c(s, '}');
  emit(s->str);
  g_string_free(s, TRUE);
}

// ---- BlueZ helpers (any thread) ----

// "/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF" -> "AABBCCDDEEFF" (out: 13 bytes); 0 if it isn't one.
static int dev_of(const char *path, char *out) {
  const char *d = path ? strstr(path, "/dev_") : NULL;
  if (!d || strlen(d + 5) < 17) return 0;
  d += 5;
  int n = 0;
  for (int i = 0; i < 17 && n < 12; i++) if (d[i] != '_') out[n++] = d[i];
  out[n] = 0;
  return n == 12 && (d[17] == 0 || d[17] == '/');
}

static void path_of(const char *dev, char *out, size_t cap) {
  snprintf(out, cap, "%s/dev_%.2s_%.2s_%.2s_%.2s_%.2s_%.2s", adapter, dev, dev + 2, dev + 4, dev + 6, dev + 8, dev + 10);
}

static GVariant *call(const char *path, const char *iface, const char *method, GVariant *args, const char *ret, GError **err) {
  return g_dbus_connection_call_sync(bus, "org.bluez", path, iface, method, args, ret ? G_VARIANT_TYPE(ret) : NULL,
                                     G_DBUS_CALL_FLAGS_NONE, CALL_MS, NULL, err);
}

static GVariant *prop(const char *path, const char *iface, const char *name) {
  GVariant *r = call(path, PROPS, "Get", g_variant_new("(ss)", iface, name), "(v)", NULL);
  if (!r) return NULL;
  GVariant *v;
  g_variant_get(r, "(v)", &v);
  g_variant_unref(r);
  return v;
}

static GVariant *managed(void) {
  return call("/", "org.freedesktop.DBus.ObjectManager", "GetManagedObjects", NULL, "(a{oa{sa{sv}}})", NULL);
}

static void find_adapter(void) {
  adapter[0] = 0;
  GVariant *r = managed();
  if (!r) return;
  GVariantIter *it;
  const char *path;
  GVariant *ifaces;
  g_variant_get(r, "(a{oa{sa{sv}}})", &it);
  while (g_variant_iter_next(it, "{&o@a{sa{sv}}}", &path, &ifaces)) {
    if (!adapter[0] && g_variant_lookup_value(ifaces, "org.bluez.Adapter1", NULL)) g_strlcpy(adapter, path, sizeof adapter);
    g_variant_unref(ifaces);
  }
  g_variant_iter_free(it);
  g_variant_unref(r);
}

static int powered(void) {
  GVariant *v = adapter[0] ? prop(adapter, "org.bluez.Adapter1", "Powered") : NULL;
  int on = v && g_variant_get_boolean(v);
  if (v) g_variant_unref(v);
  return on;
}

static const char *no_radio(void) {
  return !adapter[0] ? "unsupported" : powered() ? NULL : "off";
}

static GVariant *bytes_v(const void *data, gsize n) {
  return g_variant_new_fixed_array(G_VARIANT_TYPE_BYTE, data, n, 1);
}

// ---- ATT over our own LE link ----
// When we connect (guest, phones, reading INFO), the link is ours: an L2CAP socket on the ATT
// channel, LE only, and GATT spoken here. BlueZ's Device1.Connect would pick classic Bluetooth for
// a device it also knows that way (a Mac), connect its profiles (Hands-Free) and make it ask to
// pair; an ATT socket can't. No pairing either way: the TwinDesk characteristics are plain.

#define AF_BT 31
#define BTPROTO_L2CAP_ 0
#define ATT_CID 4
#define LE_PUBLIC 1
#define LE_RANDOM 2
#define ATT_MTU 517
#define ATT_TIMEOUT_US (30 * G_USEC_PER_SEC) // the spec's transaction timeout

struct l2addr {
  sa_family_t family;
  unsigned short psm;
  guint8 bdaddr[6]; // little-endian
  unsigned short cid;
  guint8 type;
}; // the kernel's sockaddr_l2 (its bdaddr_t is 6 bytes, so no padding before cid)

typedef struct Att {
  int fd;
  int mtu;
  GAsyncQueue *rsp; // GBytes: responses to our requests
  GThread *reader;
  volatile gint dead;
  void (*notify)(void *ctx, guint16 handle, const guint8 *d, gsize n); // notifications and indications
  void (*lost)(void *ctx); // the link went
  void *ctx;
} Att;

static char rsp_dead_mark;
#define RSP_DEAD ((GBytes *)&rsp_dead_mark)

static void put16(guint8 *p, guint16 v) { p[0] = v & 0xff; p[1] = v >> 8; }
static guint16 get16(const guint8 *p) { return (guint16)(p[0] | p[1] << 8); }

// "b7f30001-2c4e-..." -> the 16 bytes as they go over the air (little-endian).
static void uuid128(const char *s, guint8 out[16]) {
  guint8 be[16];
  int n = 0;
  for (const char *c = s; *c && n < 32; c++) {
    if (!g_ascii_isxdigit(*c)) continue;
    int v = g_ascii_xdigit_value(*c);
    if (n % 2 == 0) be[n / 2] = (guint8)(v << 4); else be[n / 2] |= (guint8)v;
    n++;
  }
  for (int i = 0; i < 16; i++) out[i] = be[15 - i];
}

static gpointer att_read(gpointer data) {
  Att *a = data;
  guint8 b[ATT_MTU + 8];
  for (;;) {
    ssize_t n = read(a->fd, b, sizeof b);
    if (n <= 0) {
      if (n < 0 && errno == EINTR) continue;
      break;
    }
    guint8 op = b[0];
    if ((op == 0x1B || op == 0x1D) && n >= 3) { // notification / indication
      if (a->notify) a->notify(a->ctx, get16(b + 1), b + 3, (gsize)n - 3);
      if (op == 0x1D) { guint8 c = 0x1E; if (write(a->fd, &c, 1) < 0) break; }
    } else if (op == 0x02 && n >= 3) { // the other side's MTU exchange: ours
      guint8 r[3] = { 0x03 };
      put16(r + 1, ATT_MTU);
      if (write(a->fd, r, 3) < 0) break;
    } else if (op != 0x52 && op != 0xD2 && !(op & 1) && op != 0x1E) { // any other request to us: nothing here
      gboolean find = op == 0x04 || op == 0x06 || op == 0x08 || op == 0x10;
      guint8 r[5] = { 0x01, op, n >= 3 ? b[1] : 0, n >= 3 ? b[2] : 0, find ? 0x0A : 0x06 };
      if (write(a->fd, r, 5) < 0) break;
    } else if (op & 1) { // a response (or an error) to ours
      g_async_queue_push(a->rsp, g_bytes_new(b, (gsize)n));
    }
  }
  g_atomic_int_set(&a->dead, 1);
  g_async_queue_push(a->rsp, RSP_DEAD);
  if (a->lost) a->lost(a->ctx);
  return NULL;
}

// The device's address type, as BlueZ saw it advertise.
static int addr_type(const char *dev) {
  char path[96];
  path_of(dev, path, sizeof path);
  GVariant *v = prop(path, DEVICE, "AddressType");
  int t = v && !strcmp(g_variant_get_string(v, NULL), "random") ? LE_RANDOM : LE_PUBLIC;
  if (v) g_variant_unref(v);
  return t;
}

// An LE link to dev with ATT on it, MTU agreed. NULL (and *why) when it didn't come up.
static Att *att_open(const char *dev, void (*notify)(void *, guint16, const guint8 *, gsize), void (*lost)(void *), void *ctx, const char **why) {
  int fd = socket(AF_BT, SOCK_SEQPACKET | SOCK_CLOEXEC, BTPROTO_L2CAP_);
  if (fd < 0) { *why = "no Bluetooth sockets"; return NULL; }
  struct l2addr me = { .family = AF_BT, .cid = GUINT16_TO_LE(ATT_CID), .type = LE_PUBLIC };
  struct l2addr them = { .family = AF_BT, .cid = GUINT16_TO_LE(ATT_CID), .type = (guint8)addr_type(dev) };
  for (int i = 0; i < 6; i++) {
    char h[3] = { dev[i * 2], dev[i * 2 + 1], 0 };
    them.bdaddr[5 - i] = (guint8)strtol(h, NULL, 16);
  }
  if (bind(fd, (struct sockaddr *)&me, sizeof me) < 0) { close(fd); *why = "bind failed"; return NULL; }
  fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);
  int r = connect(fd, (struct sockaddr *)&them, sizeof them);
  if (r < 0 && errno != EINPROGRESS) {
    // EBUSY: the controller is already connecting or connected to it another way (it connected to
    // us); the error says which, for the log.
    static __thread char msg[64];
    snprintf(msg, sizeof msg, "connect failed: %s", strerror(errno));
    close(fd);
    *why = msg;
    return NULL;
  }
  if (r < 0) {
    struct pollfd p = { fd, POLLOUT, 0 };
    int err = 0;
    socklen_t len = sizeof err;
    if (poll(&p, 1, 15000) <= 0 || getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &len) < 0 || err) {
      close(fd);
      *why = err ? "no answer over Bluetooth" : "timed out";
      return NULL;
    }
  }
  fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) & ~O_NONBLOCK);
  Att *a = g_new0(Att, 1);
  a->fd = fd;
  a->mtu = 23;
  a->rsp = g_async_queue_new();
  a->notify = notify;
  a->lost = lost;
  a->ctx = ctx;
  a->reader = g_thread_new("ble-att", att_read, a);
  return a;
}

// Ends the link and frees it (after its reader is done).
static void att_close(Att *a) {
  if (!a) return;
  shutdown(a->fd, SHUT_RDWR);
  g_thread_join(a->reader);
  close(a->fd);
  GBytes *b;
  while ((b = g_async_queue_try_pop(a->rsp))) if (b != RSP_DEAD) g_bytes_unref(b);
  g_async_queue_unref(a->rsp);
  g_free(a);
}

// One request, its response (expected opcode) in *out. 0 ok, >0 the ATT error code, <0 the link failed.
static int att_req(Att *a, const guint8 *pdu, gsize n, guint8 expect, GBytes **out) {
  if (g_atomic_int_get(&a->dead) || write(a->fd, pdu, n) != (ssize_t)n) return -1;
  for (;;) {
    GBytes *b = g_async_queue_timeout_pop(a->rsp, ATT_TIMEOUT_US);
    if (!b || b == RSP_DEAD) {
      if (b) g_async_queue_push(a->rsp, b); // stays dead for whoever asks next
      return -1;
    }
    gsize len;
    const guint8 *d = g_bytes_get_data(b, &len);
    if (d[0] == 0x01 && len >= 5 && d[1] == pdu[0]) { int e = d[4]; g_bytes_unref(b); return e ? e : 1; }
    if (d[0] == expect) { *out = b; return 0; }
    g_bytes_unref(b); // a late answer to something earlier
  }
}

static void att_mtu(Att *a) {
  guint8 q[3] = { 0x02 };
  put16(q + 1, ATT_MTU);
  GBytes *r = NULL;
  if (att_req(a, q, 3, 0x03, &r) == 0) {
    gsize n;
    const guint8 *d = g_bytes_get_data(r, &n);
    if (n >= 3) a->mtu = MAX(23, MIN(ATT_MTU, get16(d + 1)));
    g_bytes_unref(r);
  }
}

// The handles of service `svc`'s characteristics (values in val[], their CCCDs in cccd[]; 0: missing).
static const char *att_discover(Att *a, const char *svc, guint16 val[C_N], guint16 cccd[C_N]) {
  guint8 want[16], cu[C_N][16];
  uuid128(svc, want);
  for (int i = 0; i < C_N; i++) { uuid128(CHR_UUID[i], cu[i]); val[i] = cccd[i] = 0; }
  guint16 s0 = 0, s1 = 0;
  for (guint16 at = 1; !s0 && at;) { // primary services (Read By Group Type, 0x2800)
    guint8 q[7] = { 0x10 };
    put16(q + 1, at); put16(q + 3, 0xFFFF); put16(q + 5, 0x2800);
    GBytes *r = NULL;
    int e = att_req(a, q, 7, 0x11, &r);
    if (e) { if (e < 0) return "the link went"; break; }
    gsize n;
    const guint8 *d = g_bytes_get_data(r, &n);
    guint8 L = n > 1 ? d[1] : 0;
    guint16 last = 0;
    for (gsize o = 2; L >= 6 && o + L <= n; o += L) {
      guint16 st = get16(d + o), en = get16(d + o + 2);
      if (L == 20 && !memcmp(d + o + 4, want, 16)) { s0 = st; s1 = en; }
      last = en;
    }
    g_bytes_unref(r);
    at = last && last < 0xFFFF ? (guint16)(last + 1) : 0;
  }
  if (!s0) return "no TwinDesk service";
  guint16 decl[C_N + 1] = { 0 };
  for (guint16 at = s0; at && at <= s1;) { // characteristics (Read By Type, 0x2803)
    guint8 q[7] = { 0x08 };
    put16(q + 1, at); put16(q + 3, s1); put16(q + 5, 0x2803);
    GBytes *r = NULL;
    int e = att_req(a, q, 7, 0x09, &r);
    if (e) { if (e < 0) return "the link went"; break; }
    gsize n;
    const guint8 *d = g_bytes_get_data(r, &n);
    guint8 L = n > 1 ? d[1] : 0;
    guint16 last = 0;
    for (gsize o = 2; L >= 7 && o + L <= n; o += L) {
      last = get16(d + o);
      if (L != 21) continue;
      for (int i = 0; i < C_N; i++) if (!memcmp(d + o + 5, cu[i], 16)) { val[i] = get16(d + o + 3); decl[i] = last; }
    }
    g_bytes_unref(r);
    at = last && last < s1 ? (guint16)(last + 1) : 0;
  }
  // Each notifying characteristic's CCCD (0x2902): between its value and the next declaration.
  for (int i = C_CTRL; i <= C_DOWN; i += 2) {
    if (!val[i]) continue;
    guint16 end = s1;
    for (int k = 0; k < C_N; k++) if (decl[k] > val[i] && decl[k] - 1 < end) end = (guint16)(decl[k] - 1);
    guint8 q[5] = { 0x04 };
    put16(q + 1, (guint16)(val[i] + 1)); put16(q + 3, end);
    GBytes *r = NULL;
    if (val[i] < end && att_req(a, q, 5, 0x05, &r) == 0) {
      gsize n;
      const guint8 *d = g_bytes_get_data(r, &n);
      if (n >= 2 && d[1] == 1)
        for (gsize o = 2; o + 4 <= n; o += 4) if (get16(d + o + 2) == 0x2902) { cccd[i] = get16(d + o); break; }
      g_bytes_unref(r);
    }
  }
  return NULL;
}

// A whole value (Read, then Read Blob while it fills the response).
static gchar *att_read_value(Att *a, guint16 h) {
  GString *s = g_string_new("");
  for (;;) {
    guint8 q[5] = { s->len ? 0x0C : 0x0A };
    put16(q + 1, h);
    put16(q + 3, (guint16)s->len);
    GBytes *r = NULL;
    if (att_req(a, q, s->len ? 5 : 3, s->len ? 0x0D : 0x0B, &r)) break;
    gsize n;
    const guint8 *d = g_bytes_get_data(r, &n);
    g_string_append_len(s, (const char *)d + 1, (gssize)n - 1);
    g_bytes_unref(r);
    if (n - 1 < (gsize)a->mtu - 1 || s->len >= 4096) break;
  }
  return g_string_free(s, FALSE);
}

// A write with response (a lost byte breaks the TLS), value at most the MTU allows. 0 ok, >0 the
// ATT error (refused: not written, so it may go again), <0 no answer (written or not: unknown).
static int att_write_r(Att *a, guint16 h, const void *data, gsize n) {
  guint8 q[ATT_MTU];
  if (n > (gsize)a->mtu - 3) return 0x0d; // invalid attribute value length
  q[0] = 0x12;
  put16(q + 1, h);
  memcpy(q + 3, data, n);
  GBytes *r = NULL;
  int e = att_req(a, q, n + 3, 0x13, &r);
  if (!e) g_bytes_unref(r);
  return e;
}

static int att_write(Att *a, guint16 h, const void *data, gsize n) {
  return att_write_r(a, h, data, n) == 0;
}


// ---- guest and phones: scanning, reading INFO, pipes ----

typedef struct Scanner {
  const char *uuid, *ev; // the service, the events' prefix ("ble." / "blp.")
  int on;
  GHashTable *infos; // dev -> INFO text
  GHashTable *told; // dev -> when ble.found was last said (µs, as a pointer-sized int)
  GHashTable *reading; // dev -> when we started reading its INFO
  GHashTable *pipes; // dev -> Pipe
} Scanner;

static Scanner guest = { U_SERVICE, "ble.", 0, 0, 0, 0, 0 };
static Scanner phones = { U_PHONE, "blp.", 0, 0, 0, 0, 0 };
static GHashTable *uuids; // device path -> 1 guest's service, 2 a phone's (bits), from the advertisements
static gboolean discovering;

// The pipe's queue: bytes for UP, or a CTRL message (opened: say "opened" once it's written).
typedef struct { GBytes *b; int ctrl, opened, last; } Item;
static Item END_ITEM;
#define END (&END_ITEM)

typedef struct Pipe {
  Scanner *sc;
  char dev[16];
  Att *att;
  guint16 h[C_N], cccd[C_N];
  GAsyncQueue *q; // Item
  volatile gint alive;
} Pipe;

static void ev_name(char *out, const Scanner *sc, const char *what) {
  snprintf(out, 24, "%s%s", sc->ev, what);
}

static void sevent(const Scanner *sc, const char *what, const char *dev, const char *k, const char *v) {
  char n[24];
  ev_name(n, sc, what);
  event(n, dev, k, v, 0);
}

static void item_free(Item *it) {
  if (it == END) return;
  if (it->b) g_bytes_unref(it->b);
  g_free(it);
}

static Item *ctrl_item(const char *json, int opened, int last) {
  Item *it = g_new0(Item, 1);
  it->b = g_bytes_new(json, strlen(json));
  it->ctrl = 1;
  it->opened = opened;
  it->last = last;
  return it;
}

// Ends a pipe (mu held): no longer in the table; its thread says close to the peer (tell_peer),
// lets go of the link and frees it.
static void pipe_end(Pipe *p, int tell_peer) {
  if (!g_atomic_int_compare_and_exchange(&p->alive, 1, 0)) return;
  if (g_hash_table_lookup(p->sc->pipes, p->dev) == p) g_hash_table_remove(p->sc->pipes, p->dev);
  if (tell_peer) g_async_queue_push(p->q, ctrl_item("{\"op\":\"close\"}", 0, 1));
  g_async_queue_push(p->q, END);
}

// What waits for UP right after `first`, as one buffer (up to MERGE): each write is a round trip.
static GBytes *merged(Pipe *p, GBytes *first, Item **held) {
  GByteArray *all = NULL;
  Item *next;
  while ((!all || all->len < MERGE) && g_bytes_get_size(first) < MERGE && (next = g_async_queue_try_pop(p->q))) {
    if (next == END || next->ctrl) { *held = next; break; }
    if (!all) all = g_bytes_unref_to_array(g_bytes_ref(first));
    gsize n;
    const guint8 *d = g_bytes_get_data(next->b, &n);
    g_byte_array_append(all, d, (guint)n);
    item_free(next);
  }
  if (!all) return g_bytes_ref(first);
  return g_byte_array_free_to_bytes(all);
}

// Notifications on the pipe's link: DOWN is its bytes, CTRL its control messages.
static void pipe_notify(void *ctx, guint16 h, const guint8 *d, gsize n) {
  Pipe *p = ctx;
  if (!g_atomic_int_get(&p->alive)) return;
  if (h == p->h[C_DOWN]) {
    char nm[24];
    ev_name(nm, p->sc, "data");
    event_data(nm, p->dev, d, n);
  } else if (h == p->h[C_CTRL]) {
    gchar *t = g_strndup((const char *)d, n);
    JObj *o = json_parse(t);
    const char *op = jstr(o, "op", "");
    if (!strcmp(op, "invite")) sevent(p->sc, "invite", p->dev, NULL, NULL);
    else if (!strcmp(op, "closed")) sevent(p->sc, "close", p->dev, NULL, NULL);
    else if (!strcmp(op, "want")) sevent(p->sc, "want", p->dev, NULL, NULL); // a phone: open a pipe
    json_free(o);
    g_free(t);
  }
}

static void pipe_lost(void *ctx) {
  Pipe *p = ctx;
  g_mutex_lock(&mu);
  if (g_atomic_int_get(&p->alive)) {
    sevent(p->sc, "gone", p->dev, NULL, NULL);
    pipe_end(p, 0);
  }
  g_mutex_unlock(&mu);
}

// UP / CTRL, in pieces the MTU allows. A piece is sent again only when refused (an ATT error: not
// written). Unanswered, it may have been taken: sent again it arrived twice and broke the TLS, so the
// pipe ends instead (main opens another).
static int pipe_write(Pipe *p, guint16 h, const guint8 *d, gsize n) {
  gsize max = MIN(512, (gsize)p->att->mtu - 3); // an attribute value is at most 512 bytes
  for (gsize i = 0; i < n || (n == 0 && i == 0); i += max) {
    gsize len = MIN(max, n - i);
    int e = 1;
    for (int tries = 0; tries < 5 && e > 0 && !g_atomic_int_get(&p->att->dead); tries++) {
      e = att_write_r(p->att, h, d + i, len);
      if (e > 0) g_usleep(20000);
    }
    if (e) {
      if (e < 0) fprintf(stderr, "[ble] %s: no answer to a write: the pipe ends\n", p->dev);
      return 0;
    }
    if (n == 0) break;
  }
  return 1;
}

typedef struct { Pipe *p; char *hello; int open; } OpenJob;

// The pipe's thread: the link, notifications on, hello (and open), then UP and CTRL in order.
static gpointer pipe_run(gpointer data) {
  OpenJob *j = data;
  Pipe *p = j->p;
  Scanner *sc = p->sc;
  const char *error = NULL;
  p->att = att_open(p->dev, pipe_notify, pipe_lost, p, &error);
  if (p->att) {
    att_mtu(p->att);
    error = att_discover(p->att, sc->uuid, p->h, p->cccd);
    if (!error && (!p->h[C_CTRL] || !p->h[C_UP] || !p->h[C_DOWN] || !p->cccd[C_CTRL] || !p->cccd[C_DOWN])) error = "characteristic missing";
    static const guint8 on[2] = { 1, 0 }; // notifications
    for (int c = C_CTRL; c <= C_DOWN && !error; c += 2) if (!att_write(p->att, p->cccd[c], on, 2)) error = "subscribe failed";
  }
  if (!error) { // hello: {"op":"hello", ...what main sent}
    const char *h = j->hello && j->hello[0] == '{' ? j->hello + 1 : "}";
    gchar *hello = g_strdup_printf("{\"op\":\"hello\"%s%s", strchr(h, '"') ? "," : "", h);
    if (!pipe_write(p, p->h[C_CTRL], (const guint8 *)hello, strlen(hello))) error = "hello failed";
    g_free(hello);
  }
  static const char open_[] = "{\"op\":\"open\"}";
  if (!error && j->open && !pipe_write(p, p->h[C_CTRL], (const guint8 *)open_, sizeof open_ - 1)) error = "open failed";
  g_free(j->hello);
  int opened = j->open;
  g_free(j);
  if (error || !g_atomic_int_get(&p->alive)) {
    if (error) fprintf(stderr, "[ble] open %s: %s\n", p->dev, error);
    g_mutex_lock(&mu);
    if (g_atomic_int_get(&p->alive)) sevent(sc, "close", p->dev, "error", error ? error : "closed");
    pipe_end(p, 0);
    g_mutex_unlock(&mu);
  } else {
    sevent(sc, opened ? "opened" : "linked", p->dev, NULL, NULL);
  }

  Item *it, *held = NULL;
  while ((it = held ? held : g_async_queue_pop(p->q)) != END) {
    held = NULL;
    int live = g_atomic_int_get(&p->alive);
    if (it->ctrl) { // CTRL: open / close; the last close goes out even though the pipe is ending
      if ((live || it->last) && p->att && !g_atomic_int_get(&p->att->dead)) {
        gsize n;
        const guint8 *d = g_bytes_get_data(it->b, &n);
        int ok = pipe_write(p, p->h[C_CTRL], d, n);
        if (it->opened && live) {
          if (ok) sevent(sc, "opened", p->dev, NULL, NULL);
          else sevent(sc, "close", p->dev, "error", "open failed");
        }
      }
      item_free(it);
      continue;
    }
    if (!live) { item_free(it); continue; }
    GBytes *all = merged(p, it->b, &held);
    item_free(it);
    gsize n;
    const guint8 *d = g_bytes_get_data(all, &n);
    if (pipe_write(p, p->h[C_UP], d, n)) {
      char nm[24];
      ev_name(nm, sc, "sent");
      event_num(nm, p->dev, "bytes", (long)n);
    } else if (g_atomic_int_get(&p->alive)) { // a lost chunk breaks the session's TLS: end this pipe, main opens another
      g_mutex_lock(&mu);
      sevent(sc, "close", p->dev, "error", "write failed");
      pipe_end(p, 0);
      g_mutex_unlock(&mu);
    }
    g_bytes_unref(all);
  }
  if (held && held != END) item_free(held);
  while ((it = g_async_queue_try_pop(p->q))) item_free(it);
  att_close(p->att); // the link goes with it (nothing else uses it)
  g_async_queue_unref(p->q);
  g_free(p);
  return NULL;
}

static void pipe_open(Scanner *sc, const char *dev, const char *hello, int open) {
  g_mutex_lock(&mu);
  Pipe *old = g_hash_table_lookup(sc->pipes, dev);
  if (old) pipe_end(old, 1);
  Pipe *p = g_new0(Pipe, 1);
  p->sc = sc;
  g_strlcpy(p->dev, dev, sizeof p->dev);
  p->q = g_async_queue_new();
  p->alive = 1;
  g_hash_table_insert(sc->pipes, g_strdup(dev), p);
  g_mutex_unlock(&mu);
  OpenJob *j = g_new0(OpenJob, 1);
  j->p = p;
  j->hello = g_strdup(hello);
  j->open = open;
  g_thread_unref(g_thread_new("ble-pipe", pipe_run, j));
}

static void pipe_close(Scanner *sc, const char *dev) {
  g_mutex_lock(&mu);
  Pipe *p = g_hash_table_lookup(sc->pipes, dev);
  if (p) pipe_end(p, 1);
  g_mutex_unlock(&mu);
}

static void pipe_send(Scanner *sc, const char *dev, GBytes *b) {
  g_mutex_lock(&mu);
  Pipe *p = g_hash_table_lookup(sc->pipes, dev);
  if (p) {
    Item *it = g_new0(Item, 1);
    it->b = g_bytes_ref(b);
    g_async_queue_push(p->q, it);
  }
  g_mutex_unlock(&mu);
}

// A pipe on a link that's up (a phone's): start one ({op: open}), or end it and keep the link.
static void pipe_ctrl(Scanner *sc, const char *dev, int open) {
  g_mutex_lock(&mu);
  Pipe *p = g_hash_table_lookup(sc->pipes, dev);
  if (p) g_async_queue_push(p->q, ctrl_item(open ? "{\"op\":\"open\"}" : "{\"op\":\"close\"}", open, 0));
  g_mutex_unlock(&mu);
  if (!p && open) sevent(sc, "close", dev, "error", "not linked");
}

typedef struct { Scanner *sc; char dev[16]; } InfoJob;

// Connects for a moment (LE, our own link) to read a device's INFO (ble.found), then lets go.
// One at a time: a controller makes one LE connection at once, and two attempts time each other out.
static GMutex reading_mu;
static gpointer read_info(gpointer data) {
  InfoJob *j = data;
  const char *error = NULL;
  g_mutex_lock(&reading_mu);
  Att *a = att_open(j->dev, NULL, NULL, NULL, &error);
  if (a) {
    guint16 h[C_N], cccd[C_N];
    att_mtu(a);
    error = att_discover(a, j->sc->uuid, h, cccd);
    if (!error && !h[C_INFO]) error = "no INFO";
    if (!error) {
      gchar *info = att_read_value(a, h[C_INFO]);
      if (info[0] == '{') {
        g_mutex_lock(&mu);
        g_hash_table_replace(j->sc->infos, g_strdup(j->dev), g_strdup(info));
        g_hash_table_replace(j->sc->told, g_strdup(j->dev), GSIZE_TO_POINTER((gsize)g_get_monotonic_time()));
        g_mutex_unlock(&mu);
        sevent(j->sc, "found", j->dev, "info", info);
      }
      g_free(info);
    }
    att_close(a);
  }
  g_mutex_unlock(&reading_mu);
  if (error) fprintf(stderr, "[ble] read %s: %s\n", j->dev, error);
  g_free(j);
  return NULL;
}

// A device advertising a scanner's service was seen.
static void seen(Scanner *sc, const char *dev) {
  if (!sc->on) return;
  gint64 now = g_get_monotonic_time();
  g_mutex_lock(&mu);
  const char *info = g_hash_table_lookup(sc->infos, dev);
  gchar *say = NULL;
  if (info) {
    gint64 last = (gint64)GPOINTER_TO_SIZE(g_hash_table_lookup(sc->told, dev));
    if (now - last >= 3 * G_USEC_PER_SEC) {
      g_hash_table_replace(sc->told, g_strdup(dev), GSIZE_TO_POINTER((gsize)now));
      say = g_strdup(info);
    }
  } else if (g_hash_table_contains(sc->pipes, dev)) { // the link is the pipe's
    g_mutex_unlock(&mu);
    return;
  } else {
    gint64 started_ = (gint64)GPOINTER_TO_SIZE(g_hash_table_lookup(sc->reading, dev));
    // Also: tried and failed lately. Each try is a connection (the desktop says "Connected",
    // "Disconnected" for it), so a device that doesn't answer is asked again only after a minute.
    if (started_ && now - started_ < 60 * G_USEC_PER_SEC) { g_mutex_unlock(&mu); return; }
    g_hash_table_replace(sc->reading, g_strdup(dev), GSIZE_TO_POINTER((gsize)now));
  }
  g_mutex_unlock(&mu);
  if (say) {
    sevent(sc, "found", dev, "info", say);
    g_free(say);
    return;
  }
  InfoJob *j = g_new0(InfoJob, 1);
  j->sc = sc;
  g_strlcpy(j->dev, dev, sizeof j->dev);
  g_thread_unref(g_thread_new("ble-info", read_info, j));
}

static int uuid_bits(GVariant *list) {
  int bits = 0;
  GVariantIter it;
  const char *u;
  g_variant_iter_init(&it, list);
  while (g_variant_iter_next(&it, "&s", &u)) {
    if (!g_ascii_strcasecmp(u, U_SERVICE)) bits |= 1;
    if (!g_ascii_strcasecmp(u, U_PHONE)) bits |= 2;
  }
  return bits;
}

static int has(GVariant *dict, const char *k) {
  GVariant *v = g_variant_lookup_value(dict, k, NULL);
  if (v) g_variant_unref(v);
  return v != NULL;
}

static void device_props(const char *path, GVariant *props, int added) {
  char dev[16];
  if (!dev_of(path, dev)) return;
  GVariant *u = g_variant_lookup_value(props, "UUIDs", G_VARIANT_TYPE("as"));
  if (u) {
    g_hash_table_replace(uuids, g_strdup(path), GINT_TO_POINTER(uuid_bits(u)));
    g_variant_unref(u);
  }
  int bits = GPOINTER_TO_INT(g_hash_table_lookup(uuids, path));
  // An advertisement: a new device, or RSSI / data that changed (DuplicateData).
  if (!added && !u && !has(props, "RSSI") && !has(props, "ManufacturerData") && !has(props, "ServiceData")) return;
  if (bits & 1) seen(&guest, dev);
  if (bits & 2) seen(&phones, dev);
}

static void apply_scan(void) {
  if (!adapter[0]) return;
  int want = guest.on || phones.on;
  if (want) {
    GVariantBuilder ub, fb;
    g_variant_builder_init(&ub, G_VARIANT_TYPE("as"));
    if (guest.on) g_variant_builder_add(&ub, "s", U_SERVICE);
    if (phones.on) g_variant_builder_add(&ub, "s", U_PHONE);
    g_variant_builder_init(&fb, G_VARIANT_TYPE("a{sv}"));
    g_variant_builder_add(&fb, "{sv}", "UUIDs", g_variant_builder_end(&ub));
    g_variant_builder_add(&fb, "{sv}", "Transport", g_variant_new_string("le"));
    g_variant_builder_add(&fb, "{sv}", "DuplicateData", g_variant_new_boolean(TRUE));
    GVariant *r = call(adapter, "org.bluez.Adapter1", "SetDiscoveryFilter", g_variant_new("(@a{sv})", g_variant_builder_end(&fb)), NULL, NULL);
    if (r) g_variant_unref(r);
    if (!discovering) {
      GError *e = NULL;
      r = call(adapter, "org.bluez.Adapter1", "StartDiscovery", NULL, NULL, &e);
      if (r) g_variant_unref(r);
      discovering = !e;
      if (e) { fprintf(stderr, "[ble] scan: %s\n", e->message); g_error_free(e); }
    }
    // Devices BlueZ knows already: their advertising services.
    GVariant *m = managed();
    if (m) {
      GVariantIter *it;
      const char *path;
      GVariant *ifaces;
      g_variant_get(m, "(a{oa{sa{sv}}})", &it);
      while (g_variant_iter_next(it, "{&o@a{sa{sv}}}", &path, &ifaces)) {
        GVariant *d = g_variant_lookup_value(ifaces, DEVICE, NULL);
        if (d) {
          GVariant *u = g_variant_lookup_value(d, "UUIDs", G_VARIANT_TYPE("as"));
          if (u) { g_hash_table_replace(uuids, g_strdup(path), GINT_TO_POINTER(uuid_bits(u))); g_variant_unref(u); }
          g_variant_unref(d);
        }
        g_variant_unref(ifaces);
      }
      g_variant_iter_free(it);
      g_variant_unref(m);
    }
  } else if (discovering) {
    GVariant *r = call(adapter, "org.bluez.Adapter1", "StopDiscovery", NULL, NULL, NULL);
    if (r) g_variant_unref(r);
    discovering = FALSE;
  }
}

static void scan(Scanner *sc, int on) {
  sc->on = on;
  apply_scan();
  if (on) {
    const char *why = no_radio();
    char n[24];
    ev_name(n, sc, "state");
    event(n, NULL, "state", why ? why : discovering ? "on" : "unsupported", 0);
  }
}

// ---- host: our GATT application and advertisement ----

typedef struct Guest {
  char dev[16];
  int mtu;
  GAsyncQueue *q; // Out*
  volatile gint alive;
} Guest;

typedef struct { int chr; GBytes *b; } Out;
static Out GUEST_END;

static GHashTable *guests; // dev -> Guest (devices that wrote to us)
static char *info; // INFO's value
static int notifying[C_N];
static guint reg_ids[2 + C_N + 1]; // the application, the service, its characteristics, the advertisement
static gboolean registered, advertising, host_wanted; // wanted: bleStart until bleStop
static char host_state[16] = "off";

static void host_state_set(const char *s) {
  if (!strcmp(s, host_state)) return;
  g_strlcpy(host_state, s, sizeof host_state);
  event("ble.state", NULL, "state", s, 0);
}

static void chr_path(int i, char *out, size_t cap) { snprintf(out, cap, SVC_PATH "/char%d", i); }

static void notify(int chr, const guint8 *d, gsize n) {
  char path[64];
  chr_path(chr, path, sizeof path);
  GVariantBuilder b;
  g_variant_builder_init(&b, G_VARIANT_TYPE("a{sv}"));
  g_variant_builder_add(&b, "{sv}", "Value", bytes_v(d, n));
  g_dbus_connection_emit_signal(bus, NULL, path, PROPS, "PropertiesChanged",
                                g_variant_new("(sa{sv}as)", GATT, &b, NULL), NULL);
}

// One guest's notifications, in order and paced; what waits for the same characteristic goes as one.
static gpointer guest_run(gpointer data) {
  Guest *g = data;
  Out *o, *held = NULL;
  for (;;) {
    o = held ? held : g_async_queue_pop(g->q);
    held = NULL;
    if (o == &GUEST_END) break;
    GByteArray *all = g_bytes_unref_to_array(o->b);
    int chr = o->chr;
    g_free(o);
    Out *next;
    while (all->len < MERGE && (next = g_async_queue_try_pop(g->q))) {
      if (next == &GUEST_END || next->chr != chr) { held = next; break; }
      gsize n;
      const guint8 *d = g_bytes_get_data(next->b, &n);
      g_byte_array_append(all, d, (guint)n);
      g_bytes_unref(next->b);
      g_free(next);
    }
    gsize max = g->mtu > 23 ? (gsize)g->mtu - 3 : 20;
    if (max > 512) max = 512;
    for (gsize i = 0; i < all->len && g_atomic_int_get(&g->alive); i += max) {
      gsize len = MIN(max, all->len - i);
      notify(chr, all->data + i, len);
      g_usleep(MAX(NOTIFY_MIN_US, (gulong)len * NOTIFY_US_PER_BYTE));
    }
    if (chr == C_DOWN && g_atomic_int_get(&g->alive)) event_num("ble.sent", g->dev, "bytes", (long)all->len);
    g_byte_array_unref(all);
  }
  while ((o = g_async_queue_try_pop(g->q))) if (o != &GUEST_END) { g_bytes_unref(o->b); g_free(o); }
  g_async_queue_unref(g->q);
  g_free(g);
  return NULL;
}

// mu held.
static Guest *guest_of(const char *dev, int mtu) {
  Guest *g = g_hash_table_lookup(guests, dev);
  if (!g) {
    g = g_new0(Guest, 1);
    g_strlcpy(g->dev, dev, sizeof g->dev);
    g->q = g_async_queue_new();
    g->alive = 1;
    g->mtu = 23;
    g_hash_table_insert(guests, g_strdup(dev), g);
    g_thread_unref(g_thread_new("ble-guest", guest_run, g));
  }
  if (mtu > 0) g->mtu = mtu;
  return g;
}

static void guest_end(Guest *g) { // mu held; g leaves the table
  g_atomic_int_set(&g->alive, 0);
  g_async_queue_push(g->q, &GUEST_END);
}

static void guest_flush(Guest *g) { // a new pipe: nothing from the old one goes out
  Out *o;
  GQueue keep = G_QUEUE_INIT;
  while ((o = g_async_queue_try_pop(g->q))) {
    if (o == &GUEST_END) g_queue_push_tail(&keep, o);
    else { g_bytes_unref(o->b); g_free(o); }
  }
  while ((o = g_queue_pop_head(&keep))) g_async_queue_push(g->q, o);
}

static void host_out(const char *dev, int chr, GBytes *b) {
  g_mutex_lock(&mu);
  Guest *g = g_hash_table_lookup(guests, dev);
  if (g) {
    Out *o = g_new0(Out, 1);
    o->chr = chr;
    o->b = g_bytes_ref(b);
    g_async_queue_push(g->q, o);
  }
  g_mutex_unlock(&mu);
}

static void on_ctrl(const char *dev, const char *text) {
  JObj *o = json_parse(text);
  const char *op = jstr(o, "op", "");
  if (!strcmp(op, "hello")) {
    gchar *line = g_strdup(text); // one line: no raw line breaks in what goes to main
    for (char *c = line; *c; c++) if (*c == '\n' || *c == '\r') *c = ' ';
    event("ble.guest", dev, "hello", line, 1);
    g_free(line);
  } else if (!strcmp(op, "open")) {
    g_mutex_lock(&mu);
    Guest *g = g_hash_table_lookup(guests, dev);
    if (g) guest_flush(g);
    g_mutex_unlock(&mu);
    event("ble.open", dev, NULL, NULL, 0);
  } else if (!strcmp(op, "close")) {
    event("ble.close", dev, NULL, NULL, 0);
  } else if (!strcmp(op, "invite")) { // a Mac asks us to connect (BleGuest finds it by id)
    event("ble.invite", dev, "id", jstr(o, "id", ""), 0);
  }
  json_free(o);
}

static int chr_index(const char *path) {
  const char *c = strrchr(path, 'r');
  return g_str_has_prefix(path, SVC_PATH "/char") && c ? atoi(c + 1) : -1;
}

static void method(GDBusConnection *c, const char *sender, const char *path, const char *iface, const char *name,
                   GVariant *args, GDBusMethodInvocation *inv, gpointer data) {
  (void)c; (void)sender; (void)data;
  if (!strcmp(iface, "org.freedesktop.DBus.ObjectManager")) {
    GVariantBuilder objs;
    g_variant_builder_init(&objs, G_VARIANT_TYPE("a{oa{sa{sv}}}"));
    GVariantBuilder ifs, props;
    g_variant_builder_init(&ifs, G_VARIANT_TYPE("a{sa{sv}}"));
    g_variant_builder_init(&props, G_VARIANT_TYPE("a{sv}"));
    g_variant_builder_add(&props, "{sv}", "UUID", g_variant_new_string(U_SERVICE));
    g_variant_builder_add(&props, "{sv}", "Primary", g_variant_new_boolean(TRUE));
    g_variant_builder_add(&ifs, "{s@a{sv}}", "org.bluez.GattService1", g_variant_builder_end(&props));
    g_variant_builder_add(&objs, "{o@a{sa{sv}}}", SVC_PATH, g_variant_builder_end(&ifs));
    for (int i = 0; i < C_N; i++) {
      char p[64];
      chr_path(i, p, sizeof p);
      g_variant_builder_init(&ifs, G_VARIANT_TYPE("a{sa{sv}}"));
      g_variant_builder_init(&props, G_VARIANT_TYPE("a{sv}"));
      g_variant_builder_add(&props, "{sv}", "UUID", g_variant_new_string(CHR_UUID[i]));
      g_variant_builder_add(&props, "{sv}", "Service", g_variant_new_object_path(SVC_PATH));
      GVariantBuilder fl;
      g_variant_builder_init(&fl, G_VARIANT_TYPE("as"));
      for (int f = 0; f < 3 && CHR_FLAGS[i][f]; f++) g_variant_builder_add(&fl, "s", CHR_FLAGS[i][f]);
      g_variant_builder_add(&props, "{sv}", "Flags", g_variant_builder_end(&fl));
      g_variant_builder_add(&ifs, "{s@a{sv}}", GATT, g_variant_builder_end(&props));
      g_variant_builder_add(&objs, "{o@a{sa{sv}}}", p, g_variant_builder_end(&ifs));
    }
    g_dbus_method_invocation_return_value(inv, g_variant_new("(@a{oa{sa{sv}}})", g_variant_builder_end(&objs)));
    return;
  }
  if (!strcmp(iface, "org.bluez.LEAdvertisement1")) { // Release: BlueZ dropped it
    advertising = FALSE;
    host_state_set("off");
    g_dbus_method_invocation_return_value(inv, NULL);
    return;
  }
  int i = chr_index(path);
  if (i < 0 || i >= C_N) { g_dbus_method_invocation_return_dbus_error(inv, "org.bluez.Error.Failed", "no such characteristic"); return; }
  if (!strcmp(name, "ReadValue")) {
    GVariant *opts = g_variant_get_child_value(args, 0);
    guint16 off = 0;
    g_variant_lookup(opts, "offset", "q", &off);
    g_variant_unref(opts);
    const char *v = i == C_INFO && info ? info : "";
    size_t n = strlen(v);
    if (off > n) off = (guint16)n;
    g_dbus_method_invocation_return_value(inv, g_variant_new("(@ay)", bytes_v(v + off, n - off)));
  } else if (!strcmp(name, "WriteValue")) {
    GVariant *val = g_variant_get_child_value(args, 0), *opts = g_variant_get_child_value(args, 1);
    const char *dpath = NULL;
    guint16 mtu = 0;
    g_variant_lookup(opts, "device", "&o", &dpath);
    g_variant_lookup(opts, "mtu", "q", &mtu);
    char dev[16];
    gsize n;
    const guint8 *d = g_variant_get_fixed_array(val, &n, 1);
    if (dpath && dev_of(dpath, dev) && (i == C_CTRL || i == C_UP)) {
      g_mutex_lock(&mu);
      guest_of(dev, mtu);
      g_mutex_unlock(&mu);
      if (i == C_UP) { if (n) event_data("ble.data", dev, d, n); }
      else {
        gchar *t = g_strndup((const char *)d, n);
        on_ctrl(dev, t);
        g_free(t);
      }
    }
    g_variant_unref(val);
    g_variant_unref(opts);
    g_dbus_method_invocation_return_value(inv, NULL);
  } else if (!strcmp(name, "StartNotify") || !strcmp(name, "StopNotify")) {
    notifying[i] = !strcmp(name, "StartNotify");
    g_dbus_method_invocation_return_value(inv, NULL);
  } else {
    g_dbus_method_invocation_return_dbus_error(inv, "org.bluez.Error.NotSupported", "not supported");
  }
}

static GVariant *get_prop(GDBusConnection *c, const char *sender, const char *path, const char *iface, const char *name,
                          GError **err, gpointer data) {
  (void)c; (void)sender; (void)data;
  if (!strcmp(iface, "org.bluez.LEAdvertisement1")) {
    if (!strcmp(name, "Type")) return g_variant_new_string("peripheral");
    if (!strcmp(name, "Discoverable")) return g_variant_new_boolean(TRUE);
    if (!strcmp(name, "ServiceUUIDs")) {
      const char *u[] = { U_SERVICE };
      return g_variant_new_strv(u, 1);
    }
  } else if (!strcmp(iface, "org.bluez.GattService1")) {
    if (!strcmp(name, "UUID")) return g_variant_new_string(U_SERVICE);
    if (!strcmp(name, "Primary")) return g_variant_new_boolean(TRUE);
  } else {
    int i = chr_index(path);
    if (i >= 0 && i < C_N) {
      if (!strcmp(name, "UUID")) return g_variant_new_string(CHR_UUID[i]);
      if (!strcmp(name, "Service")) return g_variant_new_object_path(SVC_PATH);
      if (!strcmp(name, "Flags")) {
        const char *f[3];
        int n = 0;
        while (n < 3 && CHR_FLAGS[i][n]) { f[n] = CHR_FLAGS[i][n]; n++; }
        return g_variant_new_strv(f, n);
      }
    }
  }
  g_set_error(err, G_DBUS_ERROR, G_DBUS_ERROR_UNKNOWN_PROPERTY, "no property %s", name);
  return NULL;
}

static const GDBusInterfaceVTable vtable = { method, get_prop, NULL, { 0 } };

static const char XML[] =
  "<node>"
  " <interface name='org.freedesktop.DBus.ObjectManager'>"
  "  <method name='GetManagedObjects'><arg type='a{oa{sa{sv}}}' direction='out'/></method>"
  " </interface>"
  " <interface name='org.bluez.GattService1'>"
  "  <property name='UUID' type='s' access='read'/><property name='Primary' type='b' access='read'/>"
  " </interface>"
  " <interface name='org.bluez.GattCharacteristic1'>"
  "  <method name='ReadValue'><arg type='a{sv}' direction='in'/><arg type='ay' direction='out'/></method>"
  "  <method name='WriteValue'><arg type='ay' direction='in'/><arg type='a{sv}' direction='in'/></method>"
  "  <method name='StartNotify'/><method name='StopNotify'/>"
  "  <property name='UUID' type='s' access='read'/><property name='Service' type='o' access='read'/>"
  "  <property name='Flags' type='as' access='read'/>"
  " </interface>"
  " <interface name='org.bluez.LEAdvertisement1'>"
  "  <method name='Release'/>"
  "  <property name='Type' type='s' access='read'/><property name='ServiceUUIDs' type='as' access='read'/>"
  "  <property name='Discoverable' type='b' access='read'/>"
  " </interface>"
  "</node>";

static int host_gen; // bumped by host_stop: a registration answered after it is stale
static gboolean starting;
static double start_id; // bleStart's, answered once BlueZ has registered everything

// BlueZ calls back into our objects while it registers them (GetManagedObjects, the advertisement's
// properties), so registering never waits on this thread: async, and so is letting go.
static void host_stop(void) {
  host_gen++;
  // Also while a start is still registering: BlueZ finishes it anyway, and the next start's
  // RegisterApplication would fail (AlreadyExists). Our calls reach BlueZ in order.
  if (advertising || starting)
    g_dbus_connection_call(bus, "org.bluez", adapter, "org.bluez.LEAdvertisingManager1", "UnregisterAdvertisement",
                           g_variant_new("(o)", ADV_PATH), NULL, G_DBUS_CALL_FLAGS_NONE, 5000, NULL, NULL, NULL);
  if (registered || starting)
    g_dbus_connection_call(bus, "org.bluez", adapter, "org.bluez.GattManager1", "UnregisterApplication",
                           g_variant_new("(o)", APP), NULL, G_DBUS_CALL_FLAGS_NONE, 5000, NULL, NULL, NULL);
  starting = FALSE;
  advertising = registered = FALSE;
  for (size_t i = 0; i < G_N_ELEMENTS(reg_ids); i++) {
    if (reg_ids[i]) g_dbus_connection_unregister_object(bus, reg_ids[i]);
    reg_ids[i] = 0;
  }
  g_mutex_lock(&mu);
  GHashTableIter it;
  gpointer k, v;
  g_hash_table_iter_init(&it, guests);
  while (g_hash_table_iter_next(&it, &k, &v)) {
    event("ble.gone", k, NULL, NULL, 0);
    guest_end(v);
    g_hash_table_iter_remove(&it);
  }
  g_mutex_unlock(&mu);
  host_state_set("off");
  if (start_id) reply(start_id, "stopped");
  start_id = 0;
}

static void host_failed(GError *e) {
  double id = start_id;
  start_id = 0;
  fprintf(stderr, "[ble] host: %s\n", e->message);
  host_stop();
  host_state_set("unsupported");
  reply(id, e->message);
}

static void adv_done(GObject *src, GAsyncResult *res, gpointer gen) {
  GError *e = NULL;
  GVariant *r = g_dbus_connection_call_finish(G_DBUS_CONNECTION(src), res, &e);
  if (r) g_variant_unref(r);
  if (GPOINTER_TO_INT(gen) != host_gen) { if (e) g_error_free(e); return; }
  starting = FALSE;
  if (e) { host_failed(e); g_error_free(e); return; }
  advertising = TRUE;
  host_state_set("on");
  reply(start_id, NULL);
  start_id = 0;
}

static void app_done(GObject *src, GAsyncResult *res, gpointer gen) {
  GError *e = NULL;
  GVariant *r = g_dbus_connection_call_finish(G_DBUS_CONNECTION(src), res, &e);
  if (r) g_variant_unref(r);
  if (GPOINTER_TO_INT(gen) != host_gen) { if (e) g_error_free(e); return; }
  if (e) { starting = FALSE; host_failed(e); g_error_free(e); return; }
  registered = TRUE;
  GVariantBuilder b;
  g_variant_builder_init(&b, G_VARIANT_TYPE("a{sv}"));
  g_dbus_connection_call(bus, "org.bluez", adapter, "org.bluez.LEAdvertisingManager1", "RegisterAdvertisement",
                         g_variant_new("(o@a{sv})", ADV_PATH, g_variant_builder_end(&b)), NULL, G_DBUS_CALL_FLAGS_NONE,
                         CALL_MS, NULL, adv_done, gen);
}

// Answers `id` itself (now, or once BlueZ has registered it all).
static void host_start(const char *inf, double id) {
  char *was = info;
  info = g_strdup(inf ? inf : "{}");
  g_free(was);
  if ((registered && advertising) || starting) { reply(id, NULL); return; } // a new name: INFO says it from now on
  host_stop();
  const char *why = no_radio();
  if (why) { host_state_set(why); reply(id, !strcmp(why, "off") ? "Bluetooth is off" : "no Bluetooth"); return; }
  GError *e = NULL;
  GDBusInterfaceInfo *om = g_dbus_node_info_lookup_interface(node, "org.freedesktop.DBus.ObjectManager");
  GDBusInterfaceInfo *sv = g_dbus_node_info_lookup_interface(node, "org.bluez.GattService1");
  GDBusInterfaceInfo *ch = g_dbus_node_info_lookup_interface(node, GATT);
  GDBusInterfaceInfo *ad = g_dbus_node_info_lookup_interface(node, "org.bluez.LEAdvertisement1");
  int k = 0;
  reg_ids[k++] = g_dbus_connection_register_object(bus, APP, om, &vtable, NULL, NULL, &e);
  if (!e) reg_ids[k++] = g_dbus_connection_register_object(bus, SVC_PATH, sv, &vtable, NULL, NULL, &e);
  for (int i = 0; i < C_N && !e; i++) {
    char p[64];
    chr_path(i, p, sizeof p);
    reg_ids[k++] = g_dbus_connection_register_object(bus, p, ch, &vtable, NULL, NULL, &e);
  }
  if (!e) reg_ids[k++] = g_dbus_connection_register_object(bus, ADV_PATH, ad, &vtable, NULL, NULL, &e);
  start_id = id;
  if (e) { host_failed(e); g_error_free(e); return; }
  starting = TRUE;
  GVariantBuilder b;
  g_variant_builder_init(&b, G_VARIANT_TYPE("a{sv}"));
  g_dbus_connection_call(bus, "org.bluez", adapter, "org.bluez.GattManager1", "RegisterApplication",
                         g_variant_new("(o@a{sv})", APP, g_variant_builder_end(&b)), NULL, G_DBUS_CALL_FLAGS_NONE,
                         CALL_MS, NULL, app_done, GINT_TO_POINTER(host_gen));
}

// ---- signals ----

static void gone(const char *dev) {
  g_mutex_lock(&mu);
  Guest *g = g_hash_table_lookup(guests, dev);
  if (g) {
    guest_end(g);
    g_hash_table_remove(guests, dev);
    event("ble.gone", dev, NULL, NULL, 0);
  }
  Scanner *scs[2] = { &guest, &phones };
  for (int i = 0; i < 2; i++) {
    Pipe *p = g_hash_table_lookup(scs[i]->pipes, dev);
    if (p && g_atomic_int_get(&p->alive)) {
      sevent(scs[i], "gone", dev, NULL, NULL);
      pipe_end(p, 0);
    }
  }
  g_mutex_unlock(&mu);
}

static void on_props(GDBusConnection *c, const char *sender, const char *path, const char *iface, const char *sig,
                     GVariant *params, gpointer data) {
  (void)c; (void)sender; (void)iface; (void)sig; (void)data;
  const char *which;
  GVariant *changed;
  g_variant_get(params, "(&s@a{sv}@as)", &which, &changed, NULL);
  if (!strcmp(which, DEVICE)) {
    gboolean conn;
    char dev[16];
    if (g_variant_lookup(changed, "Connected", "b", &conn) && !conn && dev_of(path, dev)) gone(dev);
    device_props(path, changed, 0);
  } else if (!strcmp(which, "org.bluez.Adapter1") && !strcmp(path, adapter)) {
    gboolean on;
    if (g_variant_lookup(changed, "Powered", "b", &on)) {
      if (!on) {
        if (registered) host_stop();
        host_state_set("off");
        discovering = FALSE;
      } else {
        apply_scan();
        if (host_wanted && !registered && !starting) host_start(info, 0);
      }
    }
  }
  g_variant_unref(changed);
}

static void on_added(GDBusConnection *c, const char *sender, const char *path, const char *iface, const char *sig,
                     GVariant *params, gpointer data) {
  (void)c; (void)sender; (void)path; (void)iface; (void)sig; (void)data;
  const char *obj;
  GVariant *ifaces;
  g_variant_get(params, "(&o@a{sa{sv}})", &obj, &ifaces);
  GVariant *d = g_variant_lookup_value(ifaces, DEVICE, NULL);
  if (d) { device_props(obj, d, 1); g_variant_unref(d); }
  g_variant_unref(ifaces);
}

// ---- commands (the BLE thread) ----

static void command(char *line) {
  JObj *c = json_parse(line);
  g_free(line);
  if (!c) return;
  const char *cmd = jstr(c, "cmd", "");
  const char *dev = jstr(c, "dev", "");
  double id = jnum(c, "id", 0);
  const char *error = NULL;
  if (!bus) error = "no system bus";
  else if (strlen(dev) > 12) error = "bad device";
  else if (!strcmp(cmd, "bleSend") || !strcmp(cmd, "blpSend")) {
    gsize n;
    guchar *d = g_base64_decode(jstr(c, "data", ""), &n);
    GBytes *b = g_bytes_new_take(d, n);
    if (cmd[2] == 'p') pipe_send(&phones, dev, b);
    else {
      g_mutex_lock(&mu);
      int ours = g_hash_table_contains(guests, dev);
      g_mutex_unlock(&mu);
      if (ours) host_out(dev, C_DOWN, b); else pipe_send(&guest, dev, b);
    }
    g_bytes_unref(b);
  } else if (!adapter[0] && (find_adapter(), !adapter[0])) {
    if (g_str_has_suffix(cmd, "Scan") || !strcmp(cmd, "bleStart")) event(cmd[2] == 'p' ? "blp.state" : "ble.state", NULL, "state", "unsupported", 0);
    error = "no Bluetooth";
  } else if (!strcmp(cmd, "bleStart")) {
    host_wanted = TRUE;
    host_start(jstr(c, "info", "{}"), id); // answers by itself
    json_free(c);
    return;
  } else if (!strcmp(cmd, "bleStop")) {
    host_wanted = FALSE;
    host_stop();
  }
  else if (!strcmp(cmd, "bleCtrl")) {
    const char *m = jstr(c, "msg", "{}");
    GBytes *b = g_bytes_new(m, strlen(m));
    host_out(dev, C_CTRL, b);
    g_bytes_unref(b);
  } else if (!strcmp(cmd, "bleScan")) scan(&guest, jbool(c, "on", 0));
  else if (!strcmp(cmd, "bleOpen")) pipe_open(&guest, dev, jstr(c, "hello", "{}"), 1);
  else if (!strcmp(cmd, "bleClose")) pipe_close(&guest, dev);
  else if (!strcmp(cmd, "blpScan")) scan(&phones, jbool(c, "on", 0));
  else if (!strcmp(cmd, "blpLink")) pipe_open(&phones, dev, jstr(c, "hello", "{}"), 0);
  else if (!strcmp(cmd, "blpOpen")) pipe_ctrl(&phones, dev, 1);
  else if (!strcmp(cmd, "blpEnd")) pipe_ctrl(&phones, dev, 0);
  else if (!strcmp(cmd, "blpDrop")) pipe_close(&phones, dev);
  else error = "unknown command";
  reply(id, error);
  json_free(c);
}

static gboolean command_cb(gpointer line) {
  command(line);
  return G_SOURCE_REMOVE;
}

static gpointer run(gpointer data) {
  (void)data;
  g_main_context_push_thread_default(ctx);
  GError *e = NULL;
  bus = g_bus_get_sync(G_BUS_TYPE_SYSTEM, NULL, &e);
  if (e) { fprintf(stderr, "[ble] system bus: %s\n", e->message); g_error_free(e); }
  if (bus) {
    node = g_dbus_node_info_new_for_xml(XML, NULL);
    g_dbus_connection_signal_subscribe(bus, "org.bluez", PROPS, "PropertiesChanged", NULL, NULL, G_DBUS_SIGNAL_FLAGS_NONE, on_props, NULL, NULL);
    g_dbus_connection_signal_subscribe(bus, "org.bluez", "org.freedesktop.DBus.ObjectManager", "InterfacesAdded", NULL, NULL, G_DBUS_SIGNAL_FLAGS_NONE, on_added, NULL, NULL);
    find_adapter();
  }
  GMainLoop *loop = g_main_loop_new(ctx, FALSE);
  g_main_loop_run(loop);
  return NULL;
}

// The main thread: ours when it's a ble*/blp* command (handled on the BLE thread, in order).
int ble_handle(const char *line) {
  if (!strstr(line, "\"cmd\":\"ble") && !strstr(line, "\"cmd\":\"blp")) return 0;
  if (!started) {
    started = TRUE;
    ctx = g_main_context_new();
    guest.infos = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, g_free);
    guest.told = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, NULL);
    guest.reading = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, NULL);
    guest.pipes = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, NULL);
    phones.infos = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, g_free);
    phones.told = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, NULL);
    phones.reading = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, NULL);
    phones.pipes = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, NULL);
    guests = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, NULL);
    uuids = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, NULL);
    g_thread_unref(g_thread_new("ble", run, NULL));
  }
  g_main_context_invoke(ctx, command_cb, g_strdup(line));
  return 1;
}

// Exiting: our LE links go with the process (and BlueZ drops our advertisement, application and
// discovery itself when we go).
void ble_shutdown(void) {}

#else // built without GLib: no Bluetooth

#include <string.h>

int ble_handle(const char *line) {
  if (!strstr(line, "\"cmd\":\"ble") && !strstr(line, "\"cmd\":\"blp")) return 0;
  JObj *c = json_parse(line);
  const char *cmd = jstr(c, "cmd", "");
  if (strstr(cmd, "Scan") || !strcmp(cmd, "bleStart")) emit(cmd[2] == 'p' ? "{\"event\":\"blp.state\",\"state\":\"unsupported\"}" : "{\"event\":\"ble.state\",\"state\":\"unsupported\"}");
  if (jhas(c, "id")) {
    JOut o;
    jo_begin(&o);
    jo_num(&o, "id", jnum(c, "id", 0));
    jo_bool(&o, "ok", 0);
    jo_str(&o, "error", "this helper was built without Bluetooth (libglib2.0-dev)");
    emit(jo_end(&o));
  }
  json_free(c);
  return 1;
}

void ble_shutdown(void) {}

#endif
