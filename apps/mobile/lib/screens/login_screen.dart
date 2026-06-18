import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../services/auth_service.dart';
import 'pin_screen.dart';

class LoginScreen extends StatelessWidget {
  const LoginScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final auth = context.read<AuthService>();
    return Scaffold(
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text('MORES-HUB',
                  style: Theme.of(context).textTheme.displaySmall),
              const SizedBox(height: 8),
              const Text('Wallets, top-up, QRIS, prepaid card.'),
              const SizedBox(height: 48),
              ElevatedButton.icon(
                icon: const Icon(Icons.login),
                label: const Text('Continue with Google'),
                onPressed: () async {
                  try {
                    await auth.signInWithGoogle();
                    if (!context.mounted) return;
                    Navigator.of(context).pushReplacement(
                      MaterialPageRoute(
                        builder: (_) => const PinScreen(mode: PinMode.create),
                      ),
                    );
                  } catch (e) {
                    if (!context.mounted) return;
                    ScaffoldMessenger.of(context).showSnackBar(
                      SnackBar(content: Text(e.toString())),
                    );
                  }
                },
              ),
            ],
          ),
        ),
      ),
    );
  }
}
