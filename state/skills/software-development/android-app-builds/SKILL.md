---
name: android-app-builds
description: "Build, test and package Android apps (Kotlin/Compose/Gradle) from the command line, size the build to a small host, and hand heavy or foreign-platform builds to CI runners."
version: 1.0.0
author: Hermes Agent
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [android, gradle, kotlin, compose, apk, aapt2, apksigner, room, ci]
    related_skills: [hermes-gateway-no-systemd, plan, writing-plans]
---

# Android app builds from the shell

## When to use this

The user asks for an Android app, an APK, "build/run my app", or hands over a spec
for a Kotlin/Compose project. Also load it before promising anything about
running an Android app, testing it on a device, or building for iOS/Windows.

Answer in the user's language (this user writes Persian) and lead with what is
actually verifiable here — the toolchain exists, the emulator does not.

## Inventory before you build — check, don't assume

```bash
java -version                                  # JDK 17 or 21 (AGP needs 17+)
ls /opt/android-sdk                            # or $ANDROID_HOME
ls /opt/android-sdk/platforms /opt/android-sdk/build-tools
command -v aapt2 d8 zipalign apksigner sdkmanager adb
cat gradle/wrapper/gradle-wrapper.properties   # the project owns its Gradle
```

A build needs all four: a JDK, the SDK **platform** matching `compileSdk`, the
**build-tools** that provide `aapt2`/`d8`/`zipalign`/`apksigner`, and a Gradle
wrapper in the project. Prefer the project's wrapper over any system Gradle.

## Version set that works together (verified)

- Kotlin **2.0.20**, AGP **8.5.2**, wrapper Gradle **8.9**
- Compose BOM **2024.09.00**, plus `org.jetbrains.kotlin.plugin.compose` at the
  **same version as Kotlin** (Kotlin 2.x fails the build without it)
- Room **2.6.1** with **KSP `2.0.20-1.0.25`** (KSP, not kapt — faster and the
  Kotlin-2 default)
- `compileSdk`/`targetSdk` 34 with platform **android-34** + build-tools 34.0.0
- JDK 21 running the build, `jvmTarget = "17"` + `sourceCompatibility 17`

Copy-ready files: `templates/gradle-config-kotlin2-compose.md`.

## Create the wrapper — the step that always trips

`gradle wrapper` refuses to run in a directory that is not a Gradle build
("Directory ... does not contain a Gradle build"), so generate it in a scratch
dir and copy it in:

```bash
mkdir -p /tmp/wrapgen && cd /tmp/wrapgen
printf 'rootProject.name = "wrapgen"\n' > settings.gradle.kts
gradle wrapper --gradle-version 8.9 --distribution-type bin
cp gradlew gradlew.bat /path/to/project/
mkdir -p /path/to/project/gradle/wrapper
cp gradle/wrapper/gradle-wrapper.{jar,properties} /path/to/project/gradle/wrapper/
chmod +x /path/to/project/gradlew
```

The wrapper then downloads its own distribution on first run, so no system Gradle
version has to match AGP.

## Size the build to the host (this is where builds die)

A single-module Compose app pulls **~0.9 GB** of Gradle caches and distribution.
On a 2 vCPU / 2 GB RAM container with a ~7.8 GB root disk that is the whole
margin, and a build that hits 100% full leaves both a broken build **and** a host
whose gateway can no longer write its session DB.

Before the first build, and again if it fails with an I/O or unzip error:

```bash
df -h / ; du -xsh /opt/* /root/.gradle /home/user/.gradle 2>/dev/null | sort -rh | head
```

Reclaim only things you can reinstall, and say what you removed:

- vendored source clones of tools whose installed copy is self-contained
- alternate/unused Gradle installs, package-manager caches (uv/npm/pip), apt cache
- optional analysis engines (static-binary downloads) — note the re-install command

Never reclaim the SDK platforms/build-tools the build itself needs.

**Measured on this host: no memory setting makes this build fit.** A Compose +
Room (KSP) app needs roughly 2 GB on its own:

- `-Xmx1024m` with a separate Kotlin daemon → the kernel **OOM-killed** the
  Gradle daemon (`oom-kill: task=java`, while a second Kotlin JVM held 750 MB).
- `-Xmx640m/-Xmx768m` with `kotlin.compiler.execution.strategy=in-process` →
  died in **Metaspace** (256 MB and even 512 MB were not enough for the Kotlin
  compiler's class metadata).

So: **do not spend attempts on the local build; dispatch the CI build.** Check
the RAM wall once (`free -m`) and go to the workflow. Keep `--no-daemon` and a
modest `-Xmx` anyway so a stray attempt fails fast instead of eating the host.

**Split the Gradle settings by owner.** `${GRADLE_USER_HOME}/gradle.properties`
is read *after* the project's `gradle.properties`, so:

- project file → portable, CI-sized (`-Xmx2g -XX:MaxMetaspaceSize=1g`,
  `parallel=true`); committed, so the runner uses it.
- `${GRADLE_USER_HOME}/gradle.properties` → this host's small values, *never*
  committed. This is the only way the committed file can stay CI-tuned.

**Kill orphaned Kotlin daemons before retrying.** They start with
`--daemon-autoshutdownIdleSeconds=7200` and survive their Gradle launcher, so a
failed attempt leaves a JVM holding hundreds of MB for two hours:

```bash
ps -eo pid,etimes,rss,cmd | grep KotlinCompileDaemon | grep -v grep
# kill only daemons older than the build you are running now
```

**Pin `GRADLE_USER_HOME` explicitly** (`GRADLE_USER_HOME=/home/<user>/.gradle`).
A background command may run with a different `HOME`, so caches land somewhere
you did not measure — `du` both paths before concluding the build is small.

## Build, test, verify

```bash
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
./gradlew test assembleDebug --no-daemon --console=plain
```

- Unit tests live in `app/src/test/...` and run on the JVM — **no device needed**.
  Keep statistics/pure logic in a plain function so this stays true.
- APK: `app/build/outputs/apk/debug/app-debug.apk`. Verify before shipping:
  `apksigner verify --print-certs app-debug.apk`, and `apkanalyzer` for size and
  manifest facts.
- `local.properties` must contain `sdk.dir=<sdk path>` or AGP asks for one.
- Install on real hardware with `adb install -r <apk>` (adb ships in
  platform-tools).

## No emulator on this class of host

Check `/dev/kvm` before promising one. Without it (and with ~2 GB RAM) an AVD is
either impossible or unusably slow: install the APK on the user's own phone, or
run instrumentation tests on a CI runner that has an emulator. Say this plainly
instead of attempting a doomed emulator boot.

## When the project outgrows the host, or needs another platform

| Situation | Where it should build |
| --- | --- |
| Single/small module, Kotlin+Compose+Room+KSP | **also CI on this host** — verified: the local build cannot fit in 2 GB RAM |
| Multi-module, NDK/C++, baseline profiles, long test suites | GitHub Actions `ubuntu-latest` |
| iOS/macOS target (Xcode), Hopper-class tooling | GitHub Actions `macos-latest` |
| Windows-only toolchain | GitHub Actions `windows-latest` |

The host does not need to be able to build the platform — it only needs to be able
to *trigger* the build and fetch the artifact. A workflow with
`on: [workflow_dispatch, push]` that uploads the APK (artifact or Release) removes
the host's CPU/RAM/disk from the equation entirely. Offer this proactively when
the target is heavy or foreign; do not silently attempt it locally.

### Workflow details that this setup needs (each one bit once)

- **`run: chmod +x gradlew` before the first Gradle step.** A state-store sync
  writes file *contents* only, so the checked-out wrapper is mode 100644 and the
  build dies with "Permission denied".
- **`rm -f local.properties`.** `sdk.dir=` in the committed file overrides the
  runner's `ANDROID_HOME`, and the runner has no such path. Exclude it from the
  sync as well.
- **Path filters on `push`.** If the repository is also a periodic state mirror,
  every sync touches the tree; without
  `on.push.paths: ["projects/<app>/**", ".github/workflows/<wf>.yml"]` the
  workflow fires every 30 minutes and burns Actions minutes.
- **Artifact download needs the redirect followed by hand, without the token.**
  `GET /actions/artifacts/{id}/zip` answers `302` to signed blob storage; reusing
  the `Authorization` header there returns `401 InvalidAuthenticationInfo`.
  Disable redirect following, then fetch `Location` with a plain request.
- `workflow_dispatch` needs the workflow file **on the dispatched ref**, and a
  push made with a personal token does trigger workflows (one made with the
  default `GITHUB_TOKEN` does not).
- Helper that wraps the whole loop (dispatch → wait → download → sha256):
  `~/.hermes/scripts/ci_android_build.py`, with `--status` and `--fetch-latest`.

## Pitfalls

- Kotlin 2.0 without `kotlin.plugin.compose` → "This version of the Compose
  Compiler…" — the plugin must match the Kotlin version exactly.
- `compileSdk` without `platforms;android-NN` installed → AGP tries to download,
  which fails on a full or offline host (pre-install with `sdkmanager`).
- Compose UI needs `ComponentActivity` + `setContent`; a manifest theme from
  `android:Theme.Material.*` avoids needing an XML theme or the Material
  Components dependency at all.
- `android:theme` is required enough to set — omitting it is not the risk,
  forgetting `android:exported` on the launcher activity is (install fails).
- RTL/Persian UI: force `CompositionLocalProvider(LocalLayoutDirection provides
  LayoutDirection.Rtl)` rather than trusting the device locale.
- Cleartext HTTP is blocked from API 28: an HTTPS probe (or a network security
  config) avoids a runtime failure that no unit test would catch.
- Never leave a Gradle daemon running on a 2 GB host; `--no-daemon` every time.
- Verify the built APK before claiming it works: `aapt2 dump badging` for package
  / minSdk / targetSdk / label and `apksigner verify --print-certs` for the
  debug signature — a debug APK installs on a real phone, which is the only
  "run" this class of host can offer.
