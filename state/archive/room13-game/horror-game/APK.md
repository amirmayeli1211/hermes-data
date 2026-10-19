# ساخت APK از بازی «اتاق ۱۳»

بازی یک فایل HTML است، پس APK هم فقط یک پوسته (WebView) دور همان فایل است.
دو راه دارد. راه اول استاندارد امروز است؛ راه دوم آفلاین و بدون نیاز به Gradle.

---

## راه ۱ — Capacitor (توصیه می‌شود)

خروجی تمیز، پشتیبانی فعال، و آپدیت راحت.

### پیش‌نیازها
| چیز | چرا |
| --- | --- |
| Node.js 18+ | ابزار Capacitor |
| Android Studio | کامپایل APK و امضای آن |
| JDK 17 | موتور Gradle |
| Android SDK (API 34) | داخل Android Studio نصب می‌شود |

### مراحل

```bash
mkdir room13-app && cd room13-app
npm init -y
npm install @capacitor/core @capacitor/cli @capacitor/android
npx cap init "Room13" com.reza.room13 --web-dir=www
```

> نام داخل `cap init` را انگلیسی بده (`Room13`). نام فارسی را بعداً در
> `strings.xml` می‌گذاری — چون Gradle با نام غیر‌ASCII در این مرحله گیر می‌کند.

```bash
mkdir -p www
cp /path/to/room13.html www/index.html     # فایل تک‌فایلی: صدا و کد داخلش
npx cap add android
npx cap sync
npx cap open android                        # Android Studio باز می‌شود
```

در Android Studio: **Build → Build Bundle(s) / APK(s) → Build APK(s)**.
خروجی: `android/app/build/outputs/apk/debug/app-debug.apk`

### چهار تنظیمی که باید عوض کنی

**۱. نام اپ روی صفحه گوشی** — `android/app/src/main/res/values/strings.xml`:
```xml
<string name="app_name">اتاق ۱۳</string>
```

**۲. پشتیبانی فارسی (RTL)** — `android/app/src/main/AndroidManifest.xml`،
داخل تگ `<application>`:
```xml
android:supportsRtl="true"
```

**۳. تمام‌صفحه** — `android/app/src/main/res/values/styles.xml`، داخل استایل اصلی:
```xml
<item name="android:windowFullscreen">true</item>
<item name="android:windowLayoutInDisplayCutoutMode">shortEdges</item>
```

**۴. جهت صفحه** — `AndroidManifest.xml`، داخل `<activity>`:
```xml
android:screenOrientation="portrait"
```

### نسخه نهایی (برای دادن به دیگران)

نسخه debug فقط روی گوشی خودت با کابل نصب می‌شود. برای فایل قابل نصب روی
هر گوشی، باید امضا شود:

```bash
# ۱. کلید بساز (یک بار برای همیشه — این فایل را گم نکن)
keytool -genkey -v -keystore room13.keystore -alias room13 \
        -keyalg RSA -keysize 2048 -validity 10000

# ۲. در Android Studio:
#    Build → Generate Signed Bundle / APK → APK → کلید بالا را انتخاب کن
#    خروجی در android/app/build/outputs/apk/release/
```

آن APK را می‌توانی به هر کسی بدهی. اگر بعداً آپدیت بدهی، **همان کلید** را
استفاده کن (Android اجازه نمی‌دهد اپ با کلید دیگر روی نسخه قبلی نصب شود).

---

## راه ۲ — بدون Android Studio (آفلاین)

اگر نمی‌خواهی ۱۰ گیگ Android Studio نصب کنی، می‌توانی APK را از یک قالب آماده
بسازی. یک APK در واقع یک فایل ZIP است با `AndroidManifest.xml` کامپایل‌شده.

### ابزار: apktool یا buildozer

```bash
# راه سریع‌تر: کوردوا با یک قالب حداقلی
npm install -g cordova
cordova create room13 com.reza.room13 Room13
cd room13
cordova platform add android
cp /path/to/room13.html www/index.html
# فونت و تمام‌صفحه در config.xml:
#   <preference name="Fullscreen" value="true" />
#   <preference name="Orientation" value="portrait" />
cordova build android
```

خروجی: `platforms/android/app/build/outputs/apk/debug/app-debug.apk`

هر دو راه به Android SDK نیاز دارند؛ تفاوتشان فقط در مقدار چیزهایی است که
باید نصب کنی. اگر یک بار SDK را نصب کنی، راه ۱ راحت‌تر است.

---

## موبایل بدون APK (بدون هیچ نصبی)

اگر فقط می‌خواهی روی گوشی خودت بازی کنی و APK نمی‌خواهی:

1. فایل `room13.html` را به گوشی بفرست (تلگرام، بلوتوث، کابل).
2. با مرورگر گوشی بازش کن (Chrome یا Firefox).
3. منوی مرورگر → **Add to Home screen**.

حالا مثل یک اپ آیکون دارد و تمام‌صفحه باز می‌شود. صدا و سیو هم کار می‌کنند
(سیو در localStorage همان مرورگر می‌ماند).

---

## نکاتی که موقع ساخت APK به مشکل می‌خورند

| مشکل | علت | راه‌حل |
| --- | --- | --- |
| صدا پخش نمی‌شود | WebView سیاست autoplay دارد | بازی صدا را روی **اولین کلیک بازیکن** باز می‌کند؛ اگر باز هم نشد `--autoplay-policy` را در کد WebView غیرفعال نکن — به‌جایش مطمئن شو اولین کلیک روی دکمه «شروع تازه» انجام شده |
| متن فارسی جدا‌جدا نشان می‌دهد | فونت موبایل | `Tahoma` در CSS به‌عنوان fallback هست؛ برای نتیجه بهتر `Vazirmatn` را در `style.css` لود کن |
| سیو پاک می‌شود | WebView پاک‌سازی حافظه | `localStorage` روی اپ نصب‌شده پایدار است؛ در حالت «حالت ناشناس» مرورگر پاک می‌شود |
| APK نصب نمی‌شود | امضا نشده | `Generate Signed APK` (بالا) |
| صفحه بریده می‌شود | ناچ گوشی | `windowLayoutInDisplayCutoutMode` (بالا) |

---

## خلاصه در سه خط

```bash
npm i -D @capacitor/cli @capacitor/core @capacitor/android && npx cap init Room13 com.reza.room13 --web-dir=www
mkdir -p www && cp room13.html www/index.html && npx cap add android && npx cap sync
npx cap open android      # و بعد Build → Build APK
```
