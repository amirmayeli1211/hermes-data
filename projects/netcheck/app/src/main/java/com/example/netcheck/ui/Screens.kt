package com.example.netcheck.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.example.netcheck.data.TestRecord
import com.example.netcheck.domain.ConnectionType
import com.example.netcheck.domain.PingStats
import com.example.netcheck.domain.Quality
import com.example.netcheck.domain.SiteResult
import com.example.netcheck.viewmodel.NetCheckViewModel
import com.example.netcheck.viewmodel.UiState
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun NetCheckApp(viewModel: NetCheckViewModel) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val history by viewModel.history.collectAsStateWithLifecycle()
    var selectedTab by remember { mutableIntStateOf(TAB_TEST) }

    Scaffold { innerPadding ->
        Column(modifier = Modifier.fillMaxSize().padding(innerPadding)) {
            TabRow(selectedTabIndex = selectedTab) {
                Tab(
                    selected = selectedTab == TAB_TEST,
                    onClick = { selectedTab = TAB_TEST },
                    text = { Text("تست") },
                )
                Tab(
                    selected = selectedTab == TAB_HISTORY,
                    onClick = { selectedTab = TAB_HISTORY },
                    text = { Text("تاریخچه") },
                )
            }
            when (selectedTab) {
                TAB_TEST -> TestScreen(
                    state = state,
                    onStartTest = viewModel::runTest,
                    onSaveResult = viewModel::saveResult,
                )
                else -> HistoryScreen(history = history, onClearHistory = viewModel::clearHistory)
            }
        }
    }
}

@Composable
private fun TestScreen(
    state: UiState,
    onStartTest: () -> Unit,
    onSaveResult: () -> Unit,
) {
    LazyColumn(
        modifier = Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item { NetworkCard(state) }

        item {
            // The ping and site sections stay empty until a test has run.
            if (state.ping == null && !state.running) {
                EmptySection(title = "تست پینگ", hint = NOT_TESTED_YET)
            } else {
                PingCard(state.ping, state.running)
            }
        }

        item {
            if (state.sites.isEmpty() && !state.running) {
                EmptySection(title = "دسترسی به سایتها", hint = NOT_TESTED_YET)
            } else {
                SitesCard(state.sites, state.running)
            }
        }

        state.quality?.let { quality -> item { QualityCard(quality) } }
        state.error?.let { message -> item { MessageCard(message) } }

        item {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = onStartTest,
                    enabled = !state.running,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(if (state.running) "در حال تست..." else "شروع تست")
                }
                OutlinedButton(
                    onClick = onSaveResult,
                    // Enabled only for a finished result that has not been saved.
                    enabled = state.hasResult && !state.running && !state.saved,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(if (state.saved) "ذخیره شد" else "ذخیره نتیجه")
                }
            }
        }
    }
}

@Composable
private fun NetworkCard(state: UiState) {
    SectionCard(title = "اطلاعات شبکه") {
        InfoRow("نوع اتصال", connectionLabel(state.network.type))
        InfoRow("اعتبارسنجی اینترنت", if (state.network.validated) "بله" else "خیر")
        InfoRow("مصرف محدود (Metered)", if (state.network.metered) "بله" else "خیر")
        val down = state.network.downstreamKbps
        val up = state.network.upstreamKbps
        // FR-12: the OS estimate, presented as an estimate.
        InfoRow(
            "سرعت لینک تخمینی",
            if (down == null && up == null) "نامشخص" else "${kbps(down)} ↓ / ${kbps(up)} ↑",
        )
    }
}

@Composable
private fun PingCard(ping: PingStats?, running: Boolean) {
    SectionCard(title = "تست پینگ") {
        if (ping == null) {
            Text(if (running) "در حال اندازهگیری..." else NOT_TESTED_YET)
            return@SectionCard
        }
        InfoRow("نمونههای موفق", "${ping.received} از ${ping.sent}")
        InfoRow("میانگین", ms(ping.avgMs))
        InfoRow("حداقل", ms(ping.minMs))
        InfoRow("حداکثر", ms(ping.maxMs))
        InfoRow("جیتر", ms(ping.jitterMs))
        InfoRow("از دست رفتن بسته", "${"%.1f".format(Locale.US, ping.packetLossPercent)}٪")
    }
}

@Composable
private fun SitesCard(sites: List<SiteResult>, running: Boolean) {
    SectionCard(title = "دسترسی به سایتها") {
        if (sites.isEmpty()) {
            Text(if (running) "در حال بررسی..." else NOT_TESTED_YET)
            return@SectionCard
        }
        InfoRow("در دسترس", "${sites.count { it.success }} از ${sites.size}")
        sites.forEach { site ->
            HorizontalDivider()
            InfoRow(hostOf(site.url), if (site.success) "موفق" else (site.error ?: "ناموفق"))
            InfoRow("کد وضعیت", site.statusCode?.toString() ?: "—")
            InfoRow("زمان پاسخ", "${site.elapsedMs} ms")
        }
    }
}

@Composable
private fun QualityCard(quality: Quality) {
    val (label, color) = when (quality) {
        Quality.EXCELLENT -> "عالی" to Color(0xFF1B7F3B)
        Quality.GOOD -> "خوب" to Color(0xFF3F6C85)
        Quality.FAIR -> "متوسط" to Color(0xFFB06B00)
        Quality.POOR -> "ضعیف" to Color(0xFFB00020)
    }
    SectionCard(title = "امتیاز کیفیت") {
        Text(text = label, color = color, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleLarge)
    }
}

@Composable
private fun MessageCard(message: String) {
    SectionCard(title = "وضعیت") { Text(message) }
}

@Composable
private fun EmptySection(title: String, hint: String) {
    SectionCard(title = title) { Text(hint) }
}

@Composable
private fun HistoryScreen(history: List<TestRecord>, onClearHistory: () -> Unit) {
    Column(modifier = Modifier.fillMaxSize().padding(16.dp)) {
        if (history.isEmpty()) {
            Text("هنوز نتیجهای ذخیره نشده است.")
        } else {
            LazyColumn(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(history, key = { it.id }) { record -> HistoryCard(record) }
            }
        }
        Spacer(Modifier.height(12.dp))
        OutlinedButton(
            onClick = onClearHistory,
            enabled = history.isNotEmpty(),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text("پاک کردن همه")
        }
    }
}

@Composable
private fun HistoryCard(record: TestRecord) {
    SectionCard(title = formatTimestamp(record.timestamp)) {
        InfoRow("نوع اتصال", connectionLabel(connectionTypeOf(record.connectionType)))
        InfoRow("میانگین پینگ", ms(record.pingAvgMs))
        InfoRow("جیتر", ms(record.jitterMs))
        InfoRow("از دست رفتن بسته", "${"%.1f".format(Locale.US, record.packetLossPercent)}٪")
        InfoRow("سایتهای در دسترس", "${record.sitesOk} از ${record.sitesTotal}")
    }
}

@Composable
private fun SectionCard(title: String, content: @Composable () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(text = title, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleMedium)
            content()
        }
    }
}

@Composable
private fun InfoRow(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(text = label, style = MaterialTheme.typography.bodyMedium)
        Text(text = value, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
    }
}

private fun connectionLabel(type: ConnectionType): String = when (type) {
    ConnectionType.WIFI -> "Wi-Fi"
    ConnectionType.CELLULAR -> "موبایل"
    ConnectionType.ETHERNET -> "اترنت"
    ConnectionType.VPN -> "VPN"
    ConnectionType.NONE -> "بدون اتصال"
}

/** Stored values are enum names; an unknown one (older row) reads as offline. */
private fun connectionTypeOf(name: String): ConnectionType =
    ConnectionType.entries.firstOrNull { it.name == name } ?: ConnectionType.NONE

private fun ms(value: Double?): String =
    if (value == null) "—" else "${"%.1f".format(Locale.US, value)} ms"

private fun kbps(value: Int?): String =
    if (value == null) "—" else if (value >= 1000) "%.1f Mbps".format(Locale.US, value / 1000.0) else "$value kbps"

private fun hostOf(url: String): String = url.removePrefix("https://").removePrefix("http://").trimEnd('/')

private fun formatTimestamp(timestamp: Long): String =
    SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.US).format(Date(timestamp))

private const val TAB_TEST = 0
private const val TAB_HISTORY = 1
private const val NOT_TESTED_YET = "هنوز تستی انجام نشده"
