package com.gungreeneyes.bananarama

import org.junit.Assert.assertEquals
import org.junit.Test

class PrefsTest {
    @Test fun keyIsOnlyShownMasked() {
        assertEquals("", Prefs.mask(""))
        assertEquals("••••", Prefs.mask("short"))
        assertEquals("AIza••••abcd", Prefs.mask("AIzaSyD-1234567890abcd"))
    }
}
