// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
using System;
using System.Runtime.InteropServices;

namespace MacShare
{
    static class CursorImages
    {
        internal struct Shape
        {
            public int Width, Height, HotX, HotY;
            public bool Blank;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct ICONINFO
        {
            [MarshalAs(UnmanagedType.Bool)] public bool icon;
            public uint hotX, hotY;
            public IntPtr mask, color;
        }
        [StructLayout(LayoutKind.Sequential)]
        struct BITMAP
        {
            public int type, width, height, stride;
            public ushort planes, bitsPerPixel;
            public IntPtr bits;
        }
        [DllImport("user32.dll")] static extern bool GetIconInfo(IntPtr cursor, out ICONINFO info);
        [DllImport("gdi32.dll", EntryPoint = "GetObjectW")] static extern int GetObject(IntPtr bitmap, int size, out BITMAP info);
        [DllImport("gdi32.dll")] static extern int GetBitmapBits(IntPtr bitmap, int count, byte[] bits);
        [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr bitmap);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern IntPtr LoadImage(IntPtr instance, string file, uint type, int width, int height, uint flags);
        [DllImport("user32.dll")] internal static extern IntPtr CopyIcon(IntPtr image);
        [DllImport("user32.dll")] internal static extern bool DestroyCursor(IntPtr cursor);
        [DllImport("user32.dll")] static extern IntPtr CreateCursor(IntPtr instance, int x, int y, int width, int height, byte[] andMask, byte[] xorMask);

        internal static bool Read(IntPtr cursor, out Shape shape)
        {
            shape = new Shape();
            ICONINFO info;
            if (cursor == IntPtr.Zero || !GetIconInfo(cursor, out info)) return false;
            try
            {
                BITMAP bitmap;
                bool color = info.color != IntPtr.Zero;
                if (GetObject(color ? info.color : info.mask, Marshal.SizeOf(typeof(BITMAP)), out bitmap) == 0) return false;
                int height = color ? bitmap.height : bitmap.height / 2;
                if (bitmap.width <= 0 || bitmap.width > 1024 || height <= 0 || height > 1024) return false;
                shape.Width = bitmap.width; shape.Height = height;
                shape.HotX = (int)info.hotX; shape.HotY = (int)info.hotY;
                // Our hidden cursors are monochrome, with an all-AND/no-XOR image and a zero hotspot.
                if (!color && info.hotX == 0 && info.hotY == 0 && bitmap.stride > 0 && bitmap.stride <= 1024)
                {
                    byte[] bits = new byte[bitmap.stride * bitmap.height];
                    if (GetBitmapBits(info.mask, bits.Length, bits) == bits.Length)
                    {
                        shape.Blank = true;
                        for (int y = 0; y < height && shape.Blank; y++)
                            for (int x = 0; x < bitmap.width; x++)
                            {
                                int bit = 128 >> (x % 8), at = y * bitmap.stride + x / 8;
                                if ((bits[at] & bit) == 0 || (bits[at + height * bitmap.stride] & bit) != 0) { shape.Blank = false; break; }
                            }
                    }
                }
                return true;
            }
            finally
            {
                if (info.mask != IntPtr.Zero) DeleteObject(info.mask);
                if (info.color != IntPtr.Zero) DeleteObject(info.color);
            }
        }

        internal static IntPtr Blank(Shape shape)
        {
            int length = ((shape.Width + 15) / 16) * 2 * shape.Height;
            byte[] andMask = new byte[length], xorMask = new byte[length];
            for (int i = 0; i < length; i++) andMask[i] = 255;
            return CreateCursor(IntPtr.Zero, 0, 0, shape.Width, shape.Height, andMask, xorMask);
        }
    }
}
