#pragma once
/* modified_md5.c only asks for fabs(sin(i + 1)) * 2^32 with i in 0..63: the MD5 constants (shim.c). */
double sin(double x);
double fabs(double x);
