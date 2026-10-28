package com.example.netcheck.domain

/** The connection kinds the UI can name. NONE means "no active network". */
enum class ConnectionType { WIFI, CELLULAR, ETHERNET, VPN, NONE }

/** A point-in-time reading of the active network, as shown in the first card. */
data class NetworkSnapshot(
    val type: ConnectionType = ConnectionType.NONE,
    val validated: Boolean = false,
    val metered: Boolean = false,
    /** Device-reported link estimates in kbit/s, null when the OS reports none. */
    val downstreamKbps: Int? = null,
    val upstreamKbps: Int? = null,
)

/**
 * TCP-ping aggregates.
 *
 * [sent] is the number of samples attempted and [received] the number that
 * completed inside the timeout, so loss is derivable rather than guessed.
 * The measurement values are null when nothing succeeded.
 */
data class PingStats(
    val sent: Int,
    val received: Int,
    val avgMs: Double?,
    val minMs: Double?,
    val maxMs: Double?,
    val jitterMs: Double?,
    val packetLossPercent: Double,
)

/** Outcome of one HTTP HEAD probe. [elapsedMs] is wall time for the request. */
data class SiteResult(
    val url: String,
    val success: Boolean,
    val statusCode: Int?,
    val elapsedMs: Long,
    val error: String? = null,
)

/** FR-09 quality buckets. Thresholds live in [QualityClassifier] and are defaults. */
enum class Quality { EXCELLENT, GOOD, FAIR, POOR }

/**
 * v1 has no settings screen (FR-13 is the next version), so the targets are
 * compile-time defaults. The objects are plain data so a future DataStore-backed
 * settings layer can supply the same shape.
 */
object Defaults {
    const val PING_HOST = "one.one.one.one"
    const val PING_PORT = 443
    const val PING_SAMPLES = 5
    const val PING_TIMEOUT_MS = 2_000
    const val SITE_TIMEOUT_MS = 5_000

    val SITES: List<String> = listOf(
        "https://www.google.com",
        "https://www.cloudflare.com",
        "https://www.wikipedia.org",
    )
}
