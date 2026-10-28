package com.example.netcheck.domain

/**
 * FR-09: turn a ping summary plus site reachability into one of four buckets.
 *
 * The thresholds are the documented defaults. They are named constants, not
 * magic numbers in a branch, so a settings screen can replace them later without
 * touching the classification logic.
 */
object QualityClassifier {
    private const val EXCELLENT_MAX_AVG_MS = 50.0
    private const val GOOD_MAX_AVG_MS = 100.0
    private const val FAIR_MAX_AVG_MS = 200.0

    private const val EXCELLENT_MAX_LOSS = 0.0
    private const val GOOD_MAX_LOSS = 2.0
    private const val FAIR_MAX_LOSS = 5.0

    fun classify(ping: PingStats?, connected: Boolean): Quality {
        if (!connected) return Quality.POOR
        val avg = ping?.avgMs ?: return Quality.POOR
        val loss = ping.packetLossPercent

        return when {
            avg < EXCELLENT_MAX_AVG_MS && loss <= EXCELLENT_MAX_LOSS -> Quality.EXCELLENT
            avg < GOOD_MAX_AVG_MS && loss < GOOD_MAX_LOSS -> Quality.GOOD
            avg < FAIR_MAX_AVG_MS && loss < FAIR_MAX_LOSS -> Quality.FAIR
            else -> Quality.POOR
        }
    }
}
