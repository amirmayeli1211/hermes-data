package com.example.netcheck.network

import com.example.netcheck.domain.Defaults
import com.example.netcheck.domain.PingStats
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import kotlin.math.abs

/**
 * Latency measurement without ICMP and without root (FR-03): the time a TCP
 * handshake takes to [port] on the target host.
 *
 * Every blocking call runs on [Dispatchers.IO] and the host name is resolved
 * before the timer starts, so DNS time is never part of the reported RTT. A
 * sample that cannot resolve or does not connect inside the timeout is dropped,
 * which is what makes it a lost packet rather than a slow one.
 */
class PingTester(
    private val samples: Int = Defaults.PING_SAMPLES,
    private val port: Int = Defaults.PING_PORT,
    private val timeoutMs: Int = Defaults.PING_TIMEOUT_MS,
) {

    suspend fun run(host: String): PingStats = withContext(Dispatchers.IO) {
        val rtts = ArrayList<Double>(samples)
        repeat(samples) {
            measureOnce(host)?.let(rtts::add)
        }
        buildStats(samples, rtts)
    }

    private fun measureOnce(host: String): Double? {
        return try {
            val address: InetAddress = InetAddress.getByName(host) // DNS, outside the timer
            val startedAt = System.nanoTime()
            Socket().use { socket ->
                socket.connect(InetSocketAddress(address, port), timeoutMs)
            }
            (System.nanoTime() - startedAt) / 1_000_000.0
        } catch (_: Exception) {
            // Unresolvable name, refused port and timeout are all one lost sample.
            null
        }
    }

    companion object {
        /**
         * FR-04, kept pure so it is unit-testable without a network:
         * average/min/max of the successful samples, jitter as the mean absolute
         * difference between consecutive samples, and loss from sent vs received.
         * No successful sample means 100% loss.
         */
        fun buildStats(sent: Int, rtts: List<Double>): PingStats {
            val received = rtts.size
            val loss = if (sent <= 0 || received == 0) {
                100.0
            } else {
                (sent - received) * 100.0 / sent
            }

            if (received == 0) {
                return PingStats(
                    sent = sent,
                    received = 0,
                    avgMs = null,
                    minMs = null,
                    maxMs = null,
                    jitterMs = null,
                    packetLossPercent = loss,
                )
            }

            // Jitter needs two samples to be a difference at all.
            val jitter = if (received < 2) {
                null
            } else {
                rtts.zipWithNext { a, b -> abs(b - a) }.average()
            }

            return PingStats(
                sent = sent,
                received = received,
                avgMs = rtts.average(),
                minMs = rtts.min(),
                maxMs = rtts.max(),
                jitterMs = jitter,
                packetLossPercent = loss,
            )
        }
    }
}
