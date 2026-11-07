/* TwinDesk — GPL-3.0. The few C library pieces playfair needs, and its door for JavaScript (fairplay.js). */
#include <stdint.h>
#include "playfair.h"
typedef __SIZE_TYPE__ size_t;

void *memcpy(void *d, const void *s, size_t n) { unsigned char *a = d; const unsigned char *b = s; while (n--) *a++ = *b++; return d; }
void *memset(void *d, int c, size_t n) { unsigned char *a = d; while (n--) *a++ = (unsigned char)c; return d; }

/* floor(2^32 * |sin(n)|) for n = 1..64 (RFC 1321): sin(n) gives back (K + 0.5) / 2^32, so the
   caller's (1LL << 32) * fabs(sin(n)) truncates to exactly K. */
static const uint32_t K[64] = {
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
};
double sin(double x) { int n = (int)x; if (n < 1 || n > 64) return 0; return ((double)K[n - 1] + 0.5) / 4294967296.0; }
double fabs(double x) { return x < 0 ? -x : x; }

/* 164 bytes of the fp-setup key message, 72 of the SETUP's ekey, then the 16-byte key out. */
static unsigned char io[164 + 72 + 16];
unsigned char *td_io(void) { return io; }
void td_decrypt(void) { playfair_decrypt(io, io + 164, io + 236); }
