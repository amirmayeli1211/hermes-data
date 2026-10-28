package com.example.netcheck

import com.example.netcheck.network.PingTester
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Unit tests for the pure statistics function (documentation section 10).
 * No Android dependency, so `./gradlew test` runs them on the JVM.
 */
class PingStatsTest {

    @Test
    fun `computes average minimum maximum and jitter`() {
        val stats = PingTester.buildStats(sent = 3, rtts = listOf(10.0, 20.0, 40.0))

        assertEquals(3, stats.received)
        assertEquals(23.333, stats.avgMs!!, 0.001)
        assertEquals(10.0, stats.minMs!!, 0.001)
        assertEquals(40.0, stats.maxMs!!, 0.001)
        // mean(|20-10|, |40-20|) = 15 ms
        assertEquals(15.0, stats.jitterMs!!, 0.001)
        assertEquals(0.0, stats.packetLossPercent, 0.001)
    }

    @Test
    fun `reports full packet loss when no sample succeeds`() {
        val stats = PingTester.buildStats(sent = 5, rtts = emptyList())

        assertEquals(0, stats.received)
        assertNull(stats.avgMs)
        assertNull(stats.minMs)
        assertNull(stats.maxMs)
        assertNull(stats.jitterMs)
        assertEquals(100.0, stats.packetLossPercent, 0.001)
    }

    @Test
    fun `counts dropped samples in the loss percentage`() {
        val stats = PingTester.buildStats(sent = 5, rtts = listOf(12.0, 14.0, 16.0))

        assertEquals(3, stats.received)
        assertEquals(40.0, stats.packetLossPercent, 0.001)
    }

    @Test
    fun `jitter needs two samples to be defined`() {
        val stats = PingTester.buildStats(sent = 5, rtts = listOf(25.0))

        assertEquals(25.0, stats.avgMs!!, 0.001)
        assertNull(stats.jitterMs)
    }
}
