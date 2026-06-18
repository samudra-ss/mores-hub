class AppConfig {
  static const String apiBaseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'http://10.0.2.2:3000',
  );
  static const String googleClientId = String.fromEnvironment(
    'GOOGLE_CLIENT_ID',
    defaultValue: '',
  );
}
