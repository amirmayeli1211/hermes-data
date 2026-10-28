# Copy-ready Gradle files: Kotlin 2.0.20 + Compose BOM 2024.09.00 + Room/KSP

Verified as a working set (Kotlin 2.0.20 · AGP 8.5.2 · Gradle 8.9 wrapper ·
Compose BOM 2024.09.00 · KSP 2.0.20-1.0.25 · Room 2.6.1 · minSdk 24 / targetSdk
34 · JDK 21 with jvmTarget 17). Copy each block into the file named above it.

## `gradle/wrapper/gradle-wrapper.properties` (generate, don't hand-write)

Generate with `gradle wrapper --gradle-version 8.9 --distribution-type bin` from a
scratch directory that contains a one-line `settings.gradle.kts` (Gradle refuses
the wrapper task outside a build), then copy `gradlew`, `gradlew.bat` and
`gradle/wrapper/*` into the project. The file must end up containing:

```properties
distributionUrl=https\://services.gradle.org/distributions/gradle-8.9-bin.zip
```

## `settings.gradle.kts`

```kotlin
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "<AppName>"
include(":app")
```

## `build.gradle.kts` (root)

```kotlin
// Root build file: only declares the plugins the modules apply.
plugins {
    id("com.android.application") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "2.0.20" apply false
    // Kotlin 2.0 REQUIRES this plugin for Compose; version must equal Kotlin's.
    id("org.jetbrains.kotlin.plugin.compose") version "2.0.20" apply false
    id("com.google.devtools.ksp") version "2.0.20-1.0.25" apply false
}
```

## `gradle.properties`

```properties
# On a 2 GB host the build JVM must stay small, or the OOM killer wins.
org.gradle.jvmargs=-Xmx1024m -XX:MaxMetaspaceSize=384m -Dfile.encoding=UTF-8
org.gradle.parallel=false
org.gradle.caching=true
android.useAndroidX=true
android.nonTransitiveRClass=true
kotlin.code.style=official
```

## `local.properties`

```properties
sdk.dir=/opt/android-sdk
```

## `app/build.gradle.kts`

```kotlin
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("com.google.devtools.ksp")
}

android {
    namespace = "com.example.<app>"       // must match the package of the sources
    compileSdk = 34

    defaultConfig {
        applicationId = "com.example.<app>"
        minSdk = 24                       // Android 7.0
        targetSdk = 34
        versionCode = 1
        versionName = "0.1"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions { jvmTarget = "17" }

    buildFeatures { compose = true }

    packaging { resources.excludes += "/META-INF/{AL2.0,LGPL2.1}" }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2024.09.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.9.2")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.6")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.6")   // collectAsStateWithLifecycle

    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    // Room via KSP (no kapt on Kotlin 2.x).
    implementation("androidx.room:room-runtime:2.6.1")
    implementation("androidx.room:room-ktx:2.6.1")
    ksp("androidx.room:room-compiler:2.6.1")

    testImplementation("junit:junit:4.13.2")     // JVM unit tests, no device
    debugImplementation("androidx.compose.ui:ui-tooling")
}
```

## `app/src/main/AndroidManifest.xml` (minimal, no XML theme needed)

```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />

    <application
        android:allowBackup="true"
        android:label="<AppName>"
        android:supportsRtl="true"
        android:theme="@android:style/Theme.Material.Light.NoActionBar">
        <activity
            android:name=".MainActivity"
            android:exported="true">      <!-- required for the launcher activity -->
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
```

Then: `./gradlew test assembleDebug --no-daemon --console=plain` with
`JAVA_HOME` pointed at a JDK 17/21 and `GRADLE_USER_HOME` set explicitly.
