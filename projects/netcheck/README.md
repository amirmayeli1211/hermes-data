# NetCheck

An Android app that reports the quality of the current internet connection in one
press: connection type, TCP ping statistics, HTTP reachability of a few sites,
and an optional local history of the results.

- Spec / source of truth: [docs/DOCUMENTATION.md](docs/DOCUMENTATION.md) (Persian)
- Package: `com.example.netcheck`
- Kotlin 2.0.20 · Jetpack Compose (Material3, BOM 2024.09.00) · MVVM + StateFlow ·
  Room · Coroutines · minSdk 24 · targetSdk/compileSdk 34

## Layout

```
app/src/main/java/com/example/netcheck/
├── MainActivity.kt                 entry point, Compose theme, forced RTL
├── domain/Models.kt                NetworkSnapshot, PingStats, SiteResult, ConnectionType, Defaults
├── domain/QualityClassifier.kt     FR-09 quality buckets (thresholds as constants)
├── network/NetworkInfoProvider.kt  FR-01/FR-02/FR-12 + FR-11 network callback
├── network/PingTester.kt           TCP handshake timing, pure buildStats()
├── network/SiteChecker.kt          HTTP HEAD probes
├── data/Database.kt                Entity, DAO, Room database
├── viewmodel/NetCheckViewModel.kt  UiState, runTest(), saveResult(), clearHistory()
└── ui/Screens.kt                   test + history tabs, cards, shared components
app/src/test/java/com/example/netcheck/
├── PingStatsTest.kt                statistics unit tests
└── QualityClassifierTest.kt        quality-threshold unit tests
```

## Build and test

```sh
./gradlew test          # unit tests (JVM, no device)
./gradlew assembleDebug # debug APK at app/build/outputs/apk/debug/app-debug.apk
```

`local.properties` must point at an Android SDK (`sdk.dir=...`) with platform 34
and build-tools 34.0.0 installed.

## Deliberate limits in v1

- Ping is TCP handshake timing, not ICMP: no root, slightly higher than real RTT.
- The Wi-Fi SSID/BSSID are not shown, because that needs `ACCESS_FINE_LOCATION`
  (roadmap 0.4).
- Link speed is the OS estimate, not a throughput measurement.
- UI strings are inline Persian; `strings.xml` and an English translation are
  roadmap 0.3, as are editable ping target and site list.
