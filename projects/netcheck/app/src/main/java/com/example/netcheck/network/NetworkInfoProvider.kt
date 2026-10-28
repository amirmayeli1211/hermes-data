package com.example.netcheck.network

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Build
import com.example.netcheck.domain.ConnectionType
import com.example.netcheck.domain.NetworkSnapshot

/**
 * FR-01, FR-02, FR-12 and the transport half of FR-11.
 *
 * Everything comes from ConnectivityManager; no location permission is used, so
 * the Wi-Fi SSID is intentionally not read (documented limitation for v1).
 */
class NetworkInfoProvider(private val context: Context) {

    private val connectivityManager: ConnectivityManager? =
        context.getSystemService(ConnectivityManager::class.java)

    /** Current network reading. Never throws: every step degrades to "no network". */
    fun snapshot(): NetworkSnapshot {
        val manager = connectivityManager ?: return NetworkSnapshot()
        val network = manager.activeNetwork ?: return NetworkSnapshot()
        val capabilities = manager.getNetworkCapabilities(network) ?: return NetworkSnapshot()

        val type = when {
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> ConnectionType.VPN
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> ConnectionType.WIFI
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> ConnectionType.CELLULAR
            capabilities.hasTransport(ethernetTransport()) -> ConnectionType.ETHERNET
            else -> ConnectionType.NONE
        }

        // VALIDATED means the OS reached the internet on this network, which is
        // stronger than "an interface is up" (captive portals fail this).
        val validated = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
        val metered = !capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)

        return NetworkSnapshot(
            type = type,
            validated = validated,
            metered = metered,
            downstreamKbps = capabilities.linkDownstreamBandwidthKbps.takeIf { it > 0 },
            upstreamKbps = capabilities.linkUpstreamBandwidthKbps.takeIf { it > 0 },
        )
    }

    /**
     * FR-11: observe the default network so the first card updates by itself.
     * Registering a callback needs no permission and survives network switches.
     */
    fun observe(onChange: () -> Unit): NetworkCallbackRegistration? {
        val manager = connectivityManager ?: return null
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = onChange()
            override fun onLost(network: Network) = onChange()
            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) = onChange()
        }
        return try {
            manager.registerDefaultNetworkCallback(callback)
            NetworkCallbackRegistration { manager.unregisterNetworkCallback(callback) }
        } catch (_: Exception) {
            // A security exception here must not take the app down.
            null
        }
    }

    /**
     * TRANSPORT_ETHERNET only exists from API 26; the transport value itself (3)
     * predates it, so older devices read the literal instead of the field and do
     * not hit NoSuchFieldError.
     */
    private fun ethernetTransport(): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NetworkCapabilities.TRANSPORT_ETHERNET
        } else {
            3
        }

    /** Handle for an active registration, so the ViewModel can release it. */
    fun interface NetworkCallbackRegistration {
        fun unregister()
    }
}
