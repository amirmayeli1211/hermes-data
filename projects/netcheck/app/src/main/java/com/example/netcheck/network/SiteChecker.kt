package com.example.netcheck.network

import com.example.netcheck.domain.Defaults
import com.example.netcheck.domain.SiteResult
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL

/**
 * FR-05: is this site reachable, and how fast does it answer.
 *
 * HEAD is used because only the status line is interesting; a body would cost
 * bandwidth for no information. 2xx and 3xx are success, and 405 counts as
 * success too: the server is reachable and merely refuses HEAD (some CDNs do).
 * Anything else is a failure that keeps its HTTP code, so the UI can distinguish
 * "server answered 500" from "no route to host".
 */
class SiteChecker(
    private val timeoutMs: Int = Defaults.SITE_TIMEOUT_MS,
) {

    /** Runs every site in parallel; the caller decides what to do with the list. */
    suspend fun checkAll(urls: List<String>): List<SiteResult> = coroutineScope {
        urls.map { url -> async { check(url) } }.awaitAll()
    }

    suspend fun check(url: String): SiteResult = withContext(Dispatchers.IO) {
        val startedAt = System.nanoTime()
        var connection: HttpURLConnection? = null
        try {
            connection = (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = "HEAD"
                connectTimeout = timeoutMs
                readTimeout = timeoutMs
                instanceFollowRedirects = false
                setRequestProperty("User-Agent", "NetCheck/0.1")
            }
            val code = connection.responseCode
            val elapsed = elapsedMs(startedAt)
            val ok = code in 200..399 || code == 405
            SiteResult(
                url = url,
                success = ok,
                statusCode = code,
                elapsedMs = elapsed,
                error = if (ok) null else "HTTP $code",
            )
        } catch (e: Exception) {
            // FR-09/documentation: the error class name is what the UI reports.
            SiteResult(
                url = url,
                success = false,
                statusCode = null,
                elapsedMs = elapsedMs(startedAt),
                error = e.javaClass.simpleName,
            )
        } finally {
            connection?.disconnect()
        }
    }

    private fun elapsedMs(startedAt: Long): Long = (System.nanoTime() - startedAt) / 1_000_000
}
