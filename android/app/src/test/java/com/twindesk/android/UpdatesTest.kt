package com.twindesk.android

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdatesTest {
    private fun rel(tag: String, pre: Boolean = false, draft: Boolean = false) =
        JSONObject().put("tag_name", tag).put("prerelease", pre).put("draft", draft)

    @Test fun preReleasesAreNumbered() {
        assertTrue(Updates.compare("2.1.10-pr1", "2.1.9") > 0)
        assertTrue(Updates.compare("2.1.10-pr2", "2.1.10-pr10") < 0)
        assertTrue(Updates.compare("2.1.10", "2.1.10-pr10") > 0)
        assertTrue(Updates.compare("2.2.0", "2.1.99-pr5") > 0)
        assertEquals(0, Updates.compare("v2.1.1", "2.1.1"))
    }

    @Test fun channelByBuild() {
        assertEquals("beta", Updates.channelFor("", "2.1.10-pr1"))
        assertEquals("stable", Updates.channelFor("", "2.1.10"))
        assertEquals("stable", Updates.channelFor("stable", "2.1.10-pr1"))
        assertEquals("beta", Updates.channelFor("beta", "2.1.10"))
    }

    @Test fun whichRelease() {
        val list = JSONArray()
            .put(rel("v2.1.2")).put(rel("v2.2.0-pr3", pre = true)).put(rel("v2.3.0", draft = true))
            .put(rel("v2.2.0-pr10", pre = true)).put(rel("v2.1.9"))
        assertEquals("v2.1.9", Updates.pickRelease(list, false)!!.getString("tag_name"))
        assertEquals("v2.2.0-pr10", Updates.pickRelease(list, true)!!.getString("tag_name"))
        assertNull(Updates.pickRelease(JSONArray(), true))
    }

    @Test fun apkKeepsItsDigest() {
        val assets = JSONArray()
            .put(JSONObject().put("name", "TwinDesk-2.2.0-full.apk").put("browser_download_url", "u1").put("size", 5).put("digest", "sha256:" + "a".repeat(64)))
            .put(JSONObject().put("name", "TwinDesk-2.2.0.apk").put("browser_download_url", "u2").put("size", 6))
        val standard = Updates.pickApk(assets, false)
        assertNotNull(standard)
        assertEquals("u2", standard!!.url)
        assertEquals("sha256:" + "a".repeat(64), Updates.pickApk(assets, true)!!.digest)
    }

    @Test fun meshApkNamesAreFound() {
        val assets = JSONArray()
            .put(JSONObject().put("name", "TwinDesk-Mesh-2.2.0-full.apk").put("browser_download_url", "m1").put("size", 5))
            .put(JSONObject().put("name", "TwinDesk-Mesh-2.2.0.apk").put("browser_download_url", "m2").put("size", 6))
        assertEquals("m2", Updates.pickApk(assets, false)!!.url)
        assertEquals("m1", Updates.pickApk(assets, true)!!.url)
    }
}
