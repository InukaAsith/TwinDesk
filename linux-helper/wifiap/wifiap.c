// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// twindesk-wifiap: a second interface on the Wi-Fi adapter for hosting Wi-Fi Direct (linux/wifi.js)
// while the adapter stays on its own network, for adapters that can be a station and an access
// point at once (nl80211's interface combinations). Plain nl80211 over generic netlink, no libnl.
//   twindesk-wifiap check <dev>  "yes" when <dev>'s adapter can do both at once, else "no" (no privileges needed)
//   twindesk-wifiap add <dev>    an access point interface on <dev>'s adapter, beside it: prints its ifindex
//   twindesk-wifiap del <dev>    removes it
//   twindesk-wifiap bletimeout   every Bluetooth adapter: an LE link we open survives 5 s of silence
//                                (the kernel's default is 420 ms: a phone or a Mac busy with Wi-Fi for
//                                half a second dropped TwinDesk's link; Android and macOS use ~5 s)
//   twindesk-wifiap version      WIFIAP_VERSION (linux/wifi.js installs it again when it differs)
// It's created as twdap0 with an address of its own (<dev>'s, locally administered), and found by
// that address after: udev may rename it (wlx<address> on USB adapters).
// add, del and bletimeout need CAP_NET_ADMIN: installed once as root (linux/wifi.js setup(), through
// pkexec) at /usr/local/libexec/twindesk-wifiap with that capability. It does nothing else: only
// that one interface, only an access point, only on an adapter that already has a Wi-Fi interface;
// and only that one Bluetooth default, only to that value.
#include <dirent.h>
#include <errno.h>
#include <linux/genetlink.h>
#include <linux/netlink.h>
#include <linux/nl80211.h>
#include <net/if.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#define VIF "twdap0"
#define WIFIAP_VERSION "3"
#define BUF 65536

static int sock = -1;
static uint32_t seq = 1;
static uint16_t family;

typedef struct {
  struct nlmsghdr n;
  struct genlmsghdr g;
  char attrs[1024];
} Req;

static void put(Req *r, uint16_t type, const void *data, uint16_t len) {
  struct nlattr *a = (struct nlattr *)((char *)r + NLMSG_ALIGN(r->n.nlmsg_len));
  a->nla_type = type;
  a->nla_len = (uint16_t)(NLA_HDRLEN + len);
  if (len) memcpy((char *)a + NLA_HDRLEN, data, len);
  r->n.nlmsg_len = NLMSG_ALIGN(r->n.nlmsg_len) + NLA_ALIGN(a->nla_len);
}

static void put32(Req *r, uint16_t type, uint32_t v) { put(r, type, &v, 4); }

static void start(Req *r, uint16_t fam, uint8_t cmd, uint16_t flags) {
  memset(r, 0, sizeof *r);
  r->n.nlmsg_len = NLMSG_LENGTH(GENL_HDRLEN);
  r->n.nlmsg_type = fam;
  r->n.nlmsg_flags = (uint16_t)(NLM_F_REQUEST | NLM_F_ACK | flags);
  r->n.nlmsg_seq = ++seq;
  r->g.cmd = cmd;
  r->g.version = 1;
}

// Sends r; each reply message goes to fn (until the ack or the dump's end). 0 or -errno.
static int talk(Req *r, void (*fn)(struct genlmsghdr *g, int len, void *ctx), void *ctx) {
  if (send(sock, r, r->n.nlmsg_len, 0) < 0) return -errno;
  static char buf[BUF];
  for (;;) {
    ssize_t n = recv(sock, buf, sizeof buf, 0);
    if (n < 0) {
      if (errno == EINTR) continue;
      return -errno;
    }
    for (struct nlmsghdr *h = (struct nlmsghdr *)buf; NLMSG_OK(h, (unsigned)n); h = NLMSG_NEXT(h, n)) {
      if (h->nlmsg_seq != r->n.nlmsg_seq) continue;
      if (h->nlmsg_type == NLMSG_DONE) return 0;
      if (h->nlmsg_type == NLMSG_ERROR) {
        struct nlmsgerr *e = NLMSG_DATA(h);
        return e->error; // 0: the ack
      }
      if (fn) fn(NLMSG_DATA(h), (int)(h->nlmsg_len - NLMSG_HDRLEN), ctx);
    }
  }
}

#define EACH(a, start, len) for (struct nlattr *a = (struct nlattr *)(start); (char *)a + NLA_HDRLEN <= (char *)(start) + (len) && a->nla_len >= NLA_HDRLEN && (char *)a + a->nla_len <= (char *)(start) + (len); a = (struct nlattr *)((char *)a + NLA_ALIGN(a->nla_len)))
#define DATA(a) ((void *)((char *)(a) + NLA_HDRLEN))
#define LEN(a) ((int)(a)->nla_len - NLA_HDRLEN)
#define TYPE(a) ((a)->nla_type & NLA_TYPE_MASK)

static void on_family(struct genlmsghdr *g, int len, void *ctx) {
  EACH(a, (char *)g + GENL_HDRLEN, len - GENL_HDRLEN)
    if (TYPE(a) == CTRL_ATTR_FAMILY_ID) *(uint16_t *)ctx = *(uint16_t *)DATA(a);
}

static int open_nl80211(void) {
  sock = socket(AF_NETLINK, SOCK_RAW | SOCK_CLOEXEC, NETLINK_GENERIC);
  if (sock < 0) return -errno;
  struct sockaddr_nl me = { .nl_family = AF_NETLINK };
  if (bind(sock, (struct sockaddr *)&me, sizeof me) < 0) return -errno;
  int big = BUF;
  setsockopt(sock, SOL_SOCKET, SO_RCVBUF, &big, sizeof big);
  Req r;
  start(&r, GENL_ID_CTRL, CTRL_CMD_GETFAMILY, 0);
  put(&r, CTRL_ATTR_FAMILY_NAME, "nl80211", 8);
  int e = talk(&r, on_family, &family);
  return e ? e : family ? 0 : -ENOENT;
}

// <dev>'s adapter (wiphy) and address.
typedef struct { int wiphy; unsigned char mac[6]; int iftype; int ifindex; } Iface;

static void on_iface(struct genlmsghdr *g, int len, void *ctx) {
  Iface *f = ctx;
  EACH(a, (char *)g + GENL_HDRLEN, len - GENL_HDRLEN) {
    if (TYPE(a) == NL80211_ATTR_WIPHY && LEN(a) >= 4) f->wiphy = (int)*(uint32_t *)DATA(a);
    if (TYPE(a) == NL80211_ATTR_MAC && LEN(a) >= 6) memcpy(f->mac, DATA(a), 6);
    if (TYPE(a) == NL80211_ATTR_IFTYPE && LEN(a) >= 4) f->iftype = (int)*(uint32_t *)DATA(a);
    if (TYPE(a) == NL80211_ATTR_IFINDEX && LEN(a) >= 4) f->ifindex = (int)*(uint32_t *)DATA(a);
  }
}

static int iface(const char *dev, Iface *f) {
  unsigned idx = if_nametoindex(dev);
  if (!idx) return -ENODEV;
  memset(f, 0, sizeof *f);
  f->wiphy = -1;
  Req r;
  start(&r, family, NL80211_CMD_GET_INTERFACE, 0);
  put32(&r, NL80211_ATTR_IFINDEX, idx);
  int e = talk(&r, on_iface, f);
  return e ? e : f->wiphy < 0 ? -ENODEV : 0;
}

// ---- check: a station and an access point at once ----

typedef struct { int wiphy; int both; } Combo;

static int has_type(struct nlattr *types, int t) {
  EACH(a, DATA(types), LEN(types)) if (TYPE(a) == t) return 1;
  return 0;
}

static void on_wiphy(struct genlmsghdr *g, int len, void *ctx) {
  Combo *c = ctx;
  char *attrs = (char *)g + GENL_HDRLEN;
  int alen = len - GENL_HDRLEN, wiphy = -1;
  EACH(a, attrs, alen) if (TYPE(a) == NL80211_ATTR_WIPHY && LEN(a) >= 4) wiphy = (int)*(uint32_t *)DATA(a);
  if (wiphy != c->wiphy) return;
  EACH(a, attrs, alen) {
    if (TYPE(a) != NL80211_ATTR_INTERFACE_COMBINATIONS) continue;
    EACH(comb, DATA(a), LEN(a)) {
      int maxnum = 0;
      struct nlattr *lim[16];
      int nl = 0;
      EACH(x, DATA(comb), LEN(comb)) {
        if (TYPE(x) == NL80211_IFACE_COMB_MAXNUM && LEN(x) >= 4) maxnum = (int)*(uint32_t *)DATA(x);
        if (TYPE(x) == NL80211_IFACE_COMB_LIMITS) EACH(l, DATA(x), LEN(x)) if (nl < 16) lim[nl++] = l;
      }
      if (maxnum < 2) continue;
      int max[16] = { 0 }, sta[16] = { 0 }, ap[16] = { 0 };
      for (int i = 0; i < nl; i++) {
        EACH(y, DATA(lim[i]), LEN(lim[i])) {
          if (TYPE(y) == NL80211_IFACE_LIMIT_MAX && LEN(y) >= 4) max[i] = (int)*(uint32_t *)DATA(y);
          if (TYPE(y) == NL80211_IFACE_LIMIT_TYPES) {
            sta[i] = has_type(y, NL80211_IFTYPE_STATION);
            ap[i] = has_type(y, NL80211_IFTYPE_AP);
          }
        }
      }
      for (int i = 0; i < nl; i++)
        for (int j = 0; j < nl; j++)
          if (sta[i] && ap[j] && max[i] >= 1 && max[j] >= 1 && (i != j || max[i] >= 2)) c->both = 1;
    }
  }
}

static int check(const char *dev) {
  Iface f;
  int e = iface(dev, &f);
  if (e) return e;
  Combo c = { f.wiphy, 0 };
  Req r;
  start(&r, family, NL80211_CMD_GET_WIPHY, NLM_F_DUMP);
  put32(&r, NL80211_ATTR_WIPHY, (uint32_t)f.wiphy);
  put(&r, NL80211_ATTR_SPLIT_WIPHY_DUMP, NULL, 0);
  e = talk(&r, on_wiphy, &c);
  if (e) return e;
  puts(c.both ? "yes" : "no");
  return 0;
}

// ---- add / del ----

// The access point interface's address: the adapter's, locally administered.
static void vif_mac(const unsigned char *dev, unsigned char *mac) {
  memcpy(mac, dev, 6);
  mac[0] |= 0x02;
  if (!memcmp(mac, dev, 6)) mac[5] ^= 0x01;
}

// Every interface with that address on the adapter (one, or a leftover renamed copy too).
typedef struct { int wiphy; unsigned char mac[6]; int found[8]; int n; } Find;

static void on_find(struct genlmsghdr *g, int len, void *ctx) {
  Find *f = ctx;
  Iface x = { .wiphy = -1 };
  on_iface(g, len, &x);
  if (x.wiphy == f->wiphy && !memcmp(x.mac, f->mac, 6) && x.ifindex && f->n < 8) f->found[f->n++] = x.ifindex;
}

static int find(const Iface *dev, Find *f) {
  memset(f, 0, sizeof *f);
  f->wiphy = dev->wiphy;
  vif_mac(dev->mac, f->mac);
  Req r;
  start(&r, family, NL80211_CMD_GET_INTERFACE, NLM_F_DUMP);
  return talk(&r, on_find, f);
}

static int del_index(int idx) {
  Req r;
  start(&r, family, NL80211_CMD_DEL_INTERFACE, 0);
  put32(&r, NL80211_ATTR_IFINDEX, (uint32_t)idx);
  return talk(&r, NULL, NULL);
}

static int add(const char *dev) {
  Iface f;
  int e = iface(dev, &f);
  if (e) return e;
  Find have;
  if ((e = find(&f, &have))) return e;
  if (have.n && have.found[0] == f.ifindex) return -EINVAL; // <dev> is the access point itself
  if (have.n) { // there already
    printf("%d\n", have.found[0]);
    return 0;
  }
  Req r;
  start(&r, family, NL80211_CMD_NEW_INTERFACE, 0);
  put32(&r, NL80211_ATTR_WIPHY, (uint32_t)f.wiphy);
  put(&r, NL80211_ATTR_IFNAME, VIF, sizeof VIF);
  put32(&r, NL80211_ATTR_IFTYPE, NL80211_IFTYPE_AP);
  put(&r, NL80211_ATTR_MAC, have.mac, 6);
  Iface made = { .wiphy = -1 };
  if ((e = talk(&r, on_iface, &made))) return e;
  if (!made.ifindex) made.ifindex = (int)if_nametoindex(VIF);
  printf("%d\n", made.ifindex);
  return 0;
}

static int del(const char *dev) {
  Iface f;
  int e = iface(dev, &f);
  if (e) return e;
  Find have;
  if ((e = find(&f, &have))) return e;
  for (int i = 0; i < have.n; i++) {
    if (have.found[i] == f.ifindex) continue; // never <dev> itself
    if ((e = del_index(have.found[i]))) return e;
  }
  return 0;
}

// ---- bletimeout: the kernel's Bluetooth management socket (mgmt-api.txt) ----

#define AF_BT 31
#define BTPROTO_HCI 1
#define HCI_CHANNEL_CONTROL 3
#define MGMT_READ_INDEX_LIST 0x0003
#define MGMT_SET_DEF_SYSTEM_CONFIG 0x004c
#define MGMT_EV_CMD_COMPLETE 0x0001
#define MGMT_EV_CMD_STATUS 0x0002
#define LE_SUPERVISION_TIMEOUT 0x001a // default system configuration: in 10 ms units
#define LE_TIMEOUT_10MS 500 // 5 s

struct hci_addr { unsigned short family, dev, channel; };

// One command; its reply's parameters in out (n: their length). Status, or -errno.
static int mgmt(int fd, uint16_t op, uint16_t index, const void *p, uint16_t len, uint8_t *out, int *n) {
  uint8_t req[64] = { op & 0xff, op >> 8, index & 0xff, index >> 8, len & 0xff, len >> 8 };
  memcpy(req + 6, p, len);
  if (write(fd, req, 6 + len) != 6 + len) return -errno;
  for (int tries = 0; tries < 32; tries++) {
    uint8_t b[1024];
    ssize_t got = read(fd, b, sizeof b);
    if (got < 0) return -errno;
    if (got < 9) continue;
    uint16_t ev = b[0] | b[1] << 8, rop = b[6] | b[7] << 8;
    if ((ev != MGMT_EV_CMD_COMPLETE && ev != MGMT_EV_CMD_STATUS) || rop != op) continue; // other events
    if (out && n) {
      *n = (int)got - 9;
      memcpy(out, b + 9, (size_t)*n);
    }
    return b[8];
  }
  return -ETIMEDOUT;
}

static int bletimeout(void) {
  int fd = socket(AF_BT, SOCK_RAW | SOCK_CLOEXEC, BTPROTO_HCI);
  if (fd < 0) return -errno;
  struct hci_addr a = { AF_BT, 0xffff, HCI_CHANNEL_CONTROL };
  if (bind(fd, (struct sockaddr *)&a, sizeof a) < 0) { int e = -errno; close(fd); return e; }
  // The adapters: /sys/class/bluetooth/hciN (mgmt's index list comes back empty without privileges).
  DIR *d = opendir("/sys/class/bluetooth");
  int done = 0, failed = 0;
  struct dirent *e;
  while (d && (e = readdir(d))) {
    unsigned idx;
    char tail;
    if (sscanf(e->d_name, "hci%u%c", &idx, &tail) != 1 || idx > 0xfffe) continue;
    uint8_t tlv[5] = { LE_SUPERVISION_TIMEOUT & 0xff, LE_SUPERVISION_TIMEOUT >> 8, 2, LE_TIMEOUT_10MS & 0xff, LE_TIMEOUT_10MS >> 8 };
    int st = mgmt(fd, MGMT_SET_DEF_SYSTEM_CONFIG, (uint16_t)idx, tlv, sizeof tlv, NULL, NULL);
    if (st) { fprintf(stderr, "hci%u: %s\n", idx, st < 0 ? strerror(-st) : st == 0x14 ? "not permitted" : "refused"); failed = 1; }
    else done++;
  }
  if (d) closedir(d);
  close(fd);
  return failed ? -EPERM : done ? 0 : -ENODEV;
}

static int valid(const char *dev) {
  size_t n = strlen(dev);
  if (!n || n >= IF_NAMESIZE) return 0;
  for (size_t i = 0; i < n; i++) if (dev[i] == '/' || dev[i] <= ' ') return 0;
  return 1;
}

int main(int argc, char **argv) {
  const char *cmd = argc > 1 ? argv[1] : "";
  if (!strcmp(cmd, "version")) {
    puts(WIFIAP_VERSION);
    return 0;
  }
  if (!strcmp(cmd, "bletimeout")) {
    int e = bletimeout();
    if (e) fprintf(stderr, "%s\n", strerror(-e));
    return e ? 1 : 0;
  }
  const char *dev = argc > 2 ? argv[2] : "";
  if ((strcmp(cmd, "check") && strcmp(cmd, "add") && strcmp(cmd, "del")) || !valid(dev)) {
    fprintf(stderr, "usage: twindesk-wifiap check|add|del <wifi device> | bletimeout | version\n");
    return 2;
  }
  int e = open_nl80211();
  if (!e) e = !strcmp(cmd, "check") ? check(dev) : !strcmp(cmd, "add") ? add(dev) : del(dev);
  if (e) {
    fprintf(stderr, "%s\n", strerror(-e));
    return 1;
  }
  return 0;
}
