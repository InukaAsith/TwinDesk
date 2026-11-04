/* TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
 * tdfast: the input lane in the helpers (docs/protocol.md), the wire of shared/inputlane.js.
 * One lane per process. The callback runs on the lane's thread: hop to your own queue. */
#ifndef TDFAST_H
#define TDFAST_H
#include <stddef.h>
#include <stdint.h>

#define TD_MOVE 1  /* dx, dy: inject this (driven; speed applied, in order with the events) */
#define TD_EVENT 2 /* json, len: an event from the lane, {"es":N,...} */
#define TD_UP 3    /* dx: the RTT in ms */
#define TD_DOWN 4

typedef void (*td_callback)(void *ctx, int32_t kind, double dx, double dy, const uint8_t *json, size_t len);

uint16_t td_bind(void);
int32_t td_start(int32_t role /* 0 host, 1 guest */, const char *key_hex, const char *ip, uint16_t port, td_callback cb, void *ctx);
void td_stop(void);
void td_close(void);
int32_t td_up(void);
double td_rtt_ms(void);
void td_active(int32_t on);
/* driving */
void td_drive_reset(uint32_t route);
int32_t td_move(double dx, double dy, uint32_t *route, uint32_t *mn, double *cx, double *cy);
uint32_t td_fence(uint32_t *route, uint32_t *mn, double *cx, double *cy);
void td_send_event(const uint8_t *json, size_t len, uint32_t es);
/* driven */
void td_driven(uint32_t route, double speed);
void td_hold(int32_t on);
int32_t td_fence_apply(uint32_t route, uint32_t mn, double cx, double cy, double *dx, double *dy);
void td_done(uint32_t es);

#endif
