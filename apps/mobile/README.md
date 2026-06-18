# MORES-HUB Mobile (Flutter)

Single Flutter codebase → iOS, Android, and Web.

## Setup

```bash
flutter pub get
# Configure API base URL — see lib/config.dart
flutter run -d <device>
```

## Google Sign-In configuration
- **Android:** `android/app/google-services.json` from Firebase / GCP project
- **iOS:** `ios/Runner/GoogleService-Info.plist` and reversed client id URL scheme
- **Web:** add Google client id to `web/index.html` meta tag

The mobile app calls `google_sign_in` to obtain a Google **ID token**, then POSTs it to `/auth/google` on the API. The API verifies the token, returns a JWT, and the app stores the JWT in `flutter_secure_storage`. After first login the user sets a 6-digit PIN; subsequent app opens prompt for PIN (or biometric) instead of going through Google again.
