import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'services/api_client.dart';
import 'services/auth_service.dart';
import 'screens/splash_screen.dart';

void main() {
  runApp(const MoresHubApp());
}

class MoresHubApp extends StatelessWidget {
  const MoresHubApp({super.key});

  @override
  Widget build(BuildContext context) {
    final api = ApiClient();
    return MultiProvider(
      providers: [
        Provider<ApiClient>.value(value: api),
        ChangeNotifierProvider(create: (_) => AuthService(api)),
      ],
      child: MaterialApp(
        title: 'MORES-HUB',
        debugShowCheckedModeBanner: false,
        theme: ThemeData(
          colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF1B5E20)),
          useMaterial3: true,
        ),
        home: const SplashScreen(),
      ),
    );
  }
}
