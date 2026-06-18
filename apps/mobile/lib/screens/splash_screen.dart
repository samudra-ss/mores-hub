import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../services/auth_service.dart';
import 'login_screen.dart';
import 'pin_screen.dart';
import 'home_screen.dart';

class SplashScreen extends StatefulWidget {
  const SplashScreen({super.key});
  @override
  State<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends State<SplashScreen> {
  @override
  void initState() {
    super.initState();
    _decide();
  }

  Future<void> _decide() async {
    final auth = context.read<AuthService>();
    await auth.hydrate();
    if (!mounted) return;
    if (!auth.isAuthed) {
      _go(const LoginScreen());
    } else if (auth.user!['hasPin'] == true) {
      _go(const PinScreen(mode: PinMode.verify));
    } else {
      _go(const PinScreen(mode: PinMode.create));
    }
  }

  void _go(Widget w) =>
      Navigator.of(context).pushReplacement(MaterialPageRoute(builder: (_) => w));

  @override
  Widget build(BuildContext context) =>
      const Scaffold(body: Center(child: CircularProgressIndicator()));
}
