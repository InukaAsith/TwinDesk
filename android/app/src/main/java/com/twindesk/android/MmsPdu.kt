// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Pictures and group texts from the computer, sent as MMS by this phone (Messages.kt). The phone
// builds the message itself (an M-Send.req in the MMS binary encoding, OMA-TS-MMS_ENC), hands it
// to Android (SmsManager.sendMultimediaMessage), which sends it through the carrier and, TwinDesk
// not being the default texting app, adds it to the conversation. Android's sent result goes back
// to the computer (sms.sent). The picture is shrunk to fit the carrier's MMS size limit first.
package com.twindesk.android

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Bundle
import android.telephony.SmsManager
import java.io.ByteArrayOutputStream

object MmsPdu {
    class Part(val type: String, val name: String, val data: ByteArray)

    const val DEFAULT_LIMIT = 300 * 1024 // carriers' usual MMS limit, when Android doesn't say

    // The carrier's MMS size limit (bytes), as Android reports it.
    fun limit(sm: SmsManager): Int {
        @Suppress("DEPRECATION")
        val b: Bundle? = runCatching { sm.carrierConfigValues }.getOrNull()
        val n = b?.getInt(SmsManager.MMS_CONFIG_MAX_MESSAGE_SIZE, 0) ?: 0
        return if (n in 50 * 1024..2 * 1024 * 1024) n else DEFAULT_LIMIT
    }

    // A picture as a JPEG of at most `budget` bytes: smaller and less sharp until it fits (null: it
    // can't be read). Already small enough JPEGs go as they are.
    fun fit(bytes: ByteArray, budget: Int): ByteArray? {
        val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, o)
        if (o.outWidth <= 0 || o.outHeight <= 0) return null
        if (o.outMimeType == "image/jpeg" && bytes.size <= budget && maxOf(o.outWidth, o.outHeight) <= 2048) return bytes
        var sample = 1
        while (maxOf(o.outWidth, o.outHeight) / (sample * 2) >= 1600) sample *= 2
        val src = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
        // On a white background: a transparent PNG's clear parts aren't black in a JPEG.
        val flat = Bitmap.createBitmap(src.width, src.height, Bitmap.Config.ARGB_8888)
        android.graphics.Canvas(flat).apply { drawColor(android.graphics.Color.WHITE); drawBitmap(src, 0f, 0f, null) }
        var side = minOf(1600, maxOf(flat.width, flat.height))
        var quality = 85
        while (true) {
            val scale = side.toFloat() / maxOf(flat.width, flat.height)
            val b = if (scale >= 1f) flat else Bitmap.createScaledBitmap(flat, maxOf(1, (flat.width * scale).toInt()), maxOf(1, (flat.height * scale).toInt()), true)
            val out = ByteArrayOutputStream()
            b.compress(Bitmap.CompressFormat.JPEG, quality, out)
            if (out.size() <= budget) return out.toByteArray()
            if (side <= 240 && quality <= 40) return null
            if (quality > 60) quality -= 12 else { side = (side * 0.75f).toInt().coerceAtLeast(240); quality = 75 }
        }
    }

    // The M-Send.req: to every address (one MMS to the group), with the text and the picture.
    fun sendReq(to: List<String>, text: String, picture: ByteArray?, txId: String): ByteArray {
        val parts = ArrayList<Part>()
        val smil = StringBuilder("<smil><head><layout><root-layout/>")
        if (picture != null) smil.append("<region id=\"Image\" fit=\"meet\" top=\"0\" left=\"0\" height=\"80%\" width=\"100%\"/>")
        if (text.isNotEmpty()) smil.append("<region id=\"Text\" top=\"80%\" left=\"0\" height=\"20%\" width=\"100%\"/>")
        smil.append("</layout></head><body><par dur=\"5000ms\">")
        if (picture != null) smil.append("<img src=\"image.jpg\" region=\"Image\"/>")
        if (text.isNotEmpty()) smil.append("<text src=\"text.txt\" region=\"Text\"/>")
        smil.append("</par></body></smil>")
        parts.add(Part("application/smil", "smil.xml", smil.toString().toByteArray()))
        if (picture != null) parts.add(Part("image/jpeg", "image.jpg", picture))
        if (text.isNotEmpty()) parts.add(Part("text/plain", "text.txt", text.toByteArray(Charsets.UTF_8)))
        return encode(to, txId, parts)
    }

    fun encode(to: List<String>, txId: String, parts: List<Part>): ByteArray {
        val o = ByteArrayOutputStream()
        o.write(0x8C); o.write(0x80) // X-Mms-Message-Type: m-send-req
        o.write(0x98); text(o, txId) // X-Mms-Transaction-ID
        o.write(0x8D); o.write(0x92) // X-Mms-MMS-Version: 1.2
        o.write(0x89); o.write(0x01); o.write(0x81) // From: insert-address-token (the carrier fills it in)
        for (a in to) { o.write(0x97); text(o, if ('@' in a) a else "$a/TYPE=PLMN") } // To
        o.write(0x8A); o.write(0x80) // X-Mms-Message-Class: personal
        o.write(0x8F); o.write(0x81) // X-Mms-Priority: normal
        o.write(0x86); o.write(0x81) // X-Mms-Delivery-Report: no
        o.write(0x90); o.write(0x81) // X-Mms-Read-Report: no
        // Content-Type (last): multipart/related, type application/smil, start <smil>.
        val ct = ByteArrayOutputStream()
        ct.write(0xB3) // application/vnd.wap.multipart.related
        ct.write(0x8A); text(ct, "<smil>") // start
        ct.write(0x89); text(ct, "application/smil") // type
        o.write(0x84); valueLength(o, ct.size()); ct.writeTo(o)
        uintvar(o, parts.size.toLong())
        for (p in parts) {
            val type = ByteArrayOutputStream()
            when (p.type) {
                "text/plain" -> { type.write(0x83); type.write(0x81); type.write(0xEA) } // charset utf-8
                "image/jpeg" -> type.write(0x9E)
                "image/png" -> type.write(0xA0)
                "image/gif" -> type.write(0x9D)
                else -> text(type, p.type)
            }
            type.write(0x85); text(type, p.name) // name
            val head = ByteArrayOutputStream()
            valueLength(head, type.size()); type.writeTo(head)
            head.write(0xC0); head.write(0x22); head.write("<${p.name.substringBefore('.')}>".toByteArray()); head.write(0) // Content-ID
            head.write(0x8E); text(head, p.name) // Content-Location
            uintvar(o, head.size().toLong()) // HeadersLen: the content type and the headers after it
            uintvar(o, p.data.size.toLong())
            head.writeTo(o)
            o.write(p.data)
        }
        return o.toByteArray()
    }

    private fun text(o: ByteArrayOutputStream, s: String) {
        val b = s.toByteArray(Charsets.UTF_8)
        if (b.isNotEmpty() && (b[0].toInt() and 0xFF) >= 0x80) o.write(0x7F)
        o.write(b); o.write(0)
    }

    private fun valueLength(o: ByteArrayOutputStream, n: Int) {
        if (n <= 30) o.write(n) else { o.write(0x1F); uintvar(o, n.toLong()) }
    }

    fun uintvar(o: ByteArrayOutputStream, v: Long) {
        var n = v
        val tmp = ArrayList<Int>()
        do { tmp.add((n and 0x7F).toInt()); n = n shr 7 } while (n > 0)
        for (i in tmp.indices.reversed()) o.write(tmp[i] or if (i > 0) 0x80 else 0)
    }
}
