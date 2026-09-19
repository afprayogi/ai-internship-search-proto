# Job Search - Android app (standalone)

Runs with no PC/server: `www/` is built from `tools/dashboard.html` + `src/standalone.js` (fake /api routes,
data in the phone's storage) + `src/scraper_lib.js` (browser port of the scraper; LinkedIn, JobStreet, Glints).
Not included on phone: LinkedIn feed-post search and WhatsApp alerts.

Rebuild after changing the dashboard or scraper:
```
cd mobile-app
node build_www.mjs && npx cap sync android
cd android && gradlew.bat assembleDebug     # needs JDK 17 + Android SDK (Capacitor is pinned to v6 for Java 17)
```
APK: `android/app/build/outputs/apk/debug/app-debug.apk`
