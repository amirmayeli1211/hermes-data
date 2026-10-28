package com.example.netcheck

import com.example.netcheck.domain.PingStats
import com.example.netcheck.domain.Quality
import com.example.netcheck.domain.QualityClassifier
import org.junit.Assert.assertEquals
import org.junit.Test

/** FR-09 thresholds, including the boundary conditions. */
class QualityClassifierTest {

    private fun stats(avgMs: Double?, loss: Double) = PingStats(
        sent = 5,
        received = if (avgMs == null) 0 else 5,
        avgMs = avgMs,
        minMs = avgMs,
        maxMs = avgMs,
        jitterMs = null,
        packetLossPercent = loss,
    )

    @Test
    fun `classifies excellent good and fair`() {
        assertEquals(Quality.EXCELLENT, QualityClassifier.classify(stats(30.0, 0.0), connected = true))
        assertEquals(Quality.GOOD, QualityClassifier.classify(stats(80.0, 1.0), connected = true))
        assertEquals(Quality.FAIR, QualityClassifier.classify(stats(150.0, 3.0), connected = true))
    }

    @Test
    fun `poor when latency loss or connectivity is outside the fair band`() {
        assertEquals(Quality.POOR, QualityClassifier.classify(stats(250.0, 0.0), connected = true))
        assertEquals(Quality.POOR, QualityClassifier.classify(stats(60.0, 9.0), connected = true))
        assertEquals(Quality.POOR, QualityClassifier.classify(stats(null, 100.0), connected = true))
        assertEquals(Quality.POOR, QualityClassifier.classify(stats(30.0, 0.0), connected = false))
    }
}
