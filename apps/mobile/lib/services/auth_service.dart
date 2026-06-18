import 'package:flutter/foundation.dart';
import 'package:google_sign_in/google_sign_in.dart';
import 'api_client.dart';

class AuthService extends ChangeNotifier {
  final ApiClient api;
  AuthService(this.api);

  final _google = GoogleSignIn(scopes: ['email', 'profile', 'openid']);

  Map<String, dynamic>? _user;
  Map<String, dynamic>? get user => _user;
  bool get isAuthed => _user != null;

  Future<void> hydrate() async {
    final t = await api.token();
    if (t == null) return;
    try {
      final me = await api.get('/me');
      _user = me;
      notifyListeners();
    } catch (_) {
      await api.clearToken();
    }
  }

  Future<void> signInWithGoogle() async {
    final account = await _google.signIn();
    if (account == null) return; // user cancelled
    final auth = await account.authentication;
    final idToken = auth.idToken;
    if (idToken == null) {
      throw Exception('Google sign-in returned no ID token');
    }
    final res = await api.post('/auth/google', {'idToken': idToken}, auth: false);
    await api.setToken(res['accessToken'] as String);
    _user = res['user'] as Map<String, dynamic>;
    notifyListeners();
  }

  Future<void> setPin(String pin) async {
    await api.post('/auth/pin/set', {'pin': pin});
    final me = await api.get('/me');
    _user = me;
    notifyListeners();
  }

  Future<void> verifyPin(String pin) async {
    await api.post('/auth/pin/verify', {'pin': pin});
  }

  Future<void> signOut() async {
    await _google.signOut();
    await api.clearToken();
    _user = null;
    notifyListeners();
  }
}
