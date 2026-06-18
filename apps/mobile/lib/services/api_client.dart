import 'dart:convert';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;
import '../config.dart';

class ApiException implements Exception {
  final int status;
  final String message;
  ApiException(this.status, this.message);
  @override
  String toString() => 'ApiException($status): $message';
}

class ApiClient {
  final _storage = const FlutterSecureStorage();
  static const _tokenKey = 'jwt';

  Future<String?> token() => _storage.read(key: _tokenKey);
  Future<void> setToken(String t) => _storage.write(key: _tokenKey, value: t);
  Future<void> clearToken() => _storage.delete(key: _tokenKey);

  Future<Map<String, String>> _headers({bool auth = true}) async {
    final h = {'Content-Type': 'application/json'};
    if (auth) {
      final t = await token();
      if (t != null) h['Authorization'] = 'Bearer $t';
    }
    return h;
  }

  Uri _u(String path) => Uri.parse('${AppConfig.apiBaseUrl}$path');

  Future<dynamic> get(String path, {bool auth = true}) async {
    final res = await http.get(_u(path), headers: await _headers(auth: auth));
    return _decode(res);
  }

  Future<dynamic> post(String path, Map<String, dynamic> body, {bool auth = true}) async {
    final res = await http.post(
      _u(path),
      headers: await _headers(auth: auth),
      body: jsonEncode(body),
    );
    return _decode(res);
  }

  dynamic _decode(http.Response res) {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      return res.body.isEmpty ? null : jsonDecode(res.body);
    }
    String msg = res.body;
    try {
      final j = jsonDecode(res.body);
      msg = j['message']?.toString() ?? msg;
    } catch (_) {}
    throw ApiException(res.statusCode, msg);
  }
}
