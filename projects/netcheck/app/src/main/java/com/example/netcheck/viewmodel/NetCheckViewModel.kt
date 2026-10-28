package com.example.netcheck.viewmodel

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.example.netcheck.data.AppDatabase
import com.example.netcheck.data.TestRecord
import com.example.netcheck.domain.ConnectionType
import com.example.netcheck.domain.Defaults
import com.example.netcheck.domain.NetworkSnapshot
import com.example.netcheck.domain.PingStats
import com.example.netcheck.domain.Quality
import com.example.netcheck.domain.QualityClassifier
import com.example.netcheck.domain.SiteResult
import com.example.netcheck.network.NetworkInfoProvider
import com.example.netcheck.network.PingTester
import com.example.netcheck.network.SiteChecker
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Everything the two tabs render. [running], [saved] and [error] are UI state,
 * not measurements, which is why they live beside the results rather than inside
 * [PingStats].
 */
data class UiState(
    val network: NetworkSnapshot = NetworkSnapshot(),
    val ping: PingStats? = null,
    val sites: List<SiteResult> = emptyList(),
    val quality: Quality? = null,
    val running: Boolean = false,
    val saved: Boolean = false,
    val error: String? = null,
) {
    val hasResult: Boolean get() = ping != null || sites.isNotEmpty()
}

/**
 * MVVM with a single unidirectional flow: the UI reads [state] and calls the
 * functions below, nothing else. Network work is launched on viewModelScope, so
 * leaving the screen cancels it and nothing is left holding a socket.
 */
class NetCheckViewModel(application: Application) : AndroidViewModel(application) {

    private val networkInfoProvider = NetworkInfoProvider(application)
    private val pingTester = PingTester()
    private val siteChecker = SiteChecker()
    private val dao = AppDatabase.get(application).testRecordDao()

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    /** FR-07: Room drives the history tab, newest first. */
    val history: StateFlow<List<TestRecord>> = dao.observeNewestFirst()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    private var testJob: Job? = null

    /** FR-11: network changes refresh the first card without user action. */
    private val networkRegistration = networkInfoProvider.observe { refreshNetwork() }

    init {
        refreshNetwork()
    }

    fun refreshNetwork() {
        _state.update { it.copy(network = networkInfoProvider.snapshot()) }
    }

    /**
     * FR-03 / FR-05 / FR-10: one press runs the TCP ping and every site probe
     * concurrently, each on its own IO dispatcher, and publishes one result set.
     */
    fun runTest() {
        if (_state.value.running) return // a second press must not stack tests
        testJob = viewModelScope.launch {
            _state.update {
                it.copy(running = true, saved = false, error = null, ping = null, sites = emptyList(), quality = null)
            }
            refreshNetwork()
            val snapshot = _state.value.network
            if (snapshot.type == ConnectionType.NONE) {
                // Documented offline behaviour: report it, never crash.
                _state.update {
                    it.copy(running = false, error = OFFLINE_MESSAGE, quality = Quality.POOR)
                }
                return@launch
            }

            try {
                val (ping, sites) = coroutineScope {
                    val pingDeferred = async { pingTester.run(Defaults.PING_HOST) }
                    val sitesDeferred = async { siteChecker.checkAll(Defaults.SITES) }
                    pingDeferred.await() to sitesDeferred.await()
                }
                _state.update {
                    it.copy(
                        running = false,
                        ping = ping,
                        sites = sites,
                        quality = QualityClassifier.classify(ping, connected = true),
                    )
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _state.update { it.copy(running = false, error = e.javaClass.simpleName) }
            }
        }
    }

    /** FR-06: only a finished, unsaved result can be stored. */
    fun saveResult() {
        val current = _state.value
        val ping = current.ping ?: return
        if (current.running || current.saved) return
        viewModelScope.launch {
            dao.insert(
                TestRecord(
                    timestamp = System.currentTimeMillis(),
                    connectionType = current.network.type.name,
                    pingAvgMs = ping.avgMs,
                    jitterMs = ping.jitterMs,
                    packetLossPercent = ping.packetLossPercent,
                    sitesOk = current.sites.count { it.success },
                    sitesTotal = current.sites.size,
                )
            )
            _state.update { it.copy(saved = true) }
        }
    }

    /** FR-08. */
    fun clearHistory() {
        viewModelScope.launch { dao.clearAll() }
    }

    override fun onCleared() {
        super.onCleared()
        testJob?.cancel()
        networkRegistration?.unregister()
    }

    private companion object {
        const val OFFLINE_MESSAGE = "بدون اتصال به شبکه"
    }
}
