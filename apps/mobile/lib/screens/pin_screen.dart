import 'package:flutter/material.dart';
import 'package:pin_code_fields/pin_code_fields.dart';
import 'package:provider/provider.dart';
import '../services/auth_service.dart';
import 'home_screen.dart';

enum PinMode { create, verify }

class PinScreen extends StatefulWidget {
  final PinMode mode;
  const PinScreen({super.key, required this.mode});
  @override
  State<PinScreen> createState() => _PinScreenState();
}

class _PinScreenState extends State<PinScreen> {
  final _ctl = TextEditingController();
  bool _busy = false;

  Future<void> _submit(String pin) async {
    if (pin.length != 6) return;
    setState(() => _busy = true);
    final auth = context.read<AuthService>();
    try {
      if (widget.mode == PinMode.create) {
        await auth.setPin(pin);
      } else {
        await auth.verifyPin(pin);
      }
      if (!mounted) return;
      Navigator.of(context).pushReplacement(
        MaterialPageRoute(builder: (_) => const HomeScreen()),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(e.toString())));
      _ctl.clear();
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.mode == PinMode.create ? 'Set a 6-digit PIN' : 'Enter your PIN'),
      ),
      body: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          children: [
            const SizedBox(height: 32),
            Text(
              widget.mode == PinMode.create
                  ? 'You will use this PIN to open the app and confirm payments.'
                  : 'Welcome back. Enter your PIN to continue.',
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 32),
            PinCodeTextField(
              appContext: context,
              length: 6,
              controller: _ctl,
              keyboardType: TextInputType.number,
              obscureText: true,
              animationType: AnimationType.fade,
              onCompleted: _submit,
              onChanged: (_) {},
            ),
            if (_busy) const CircularProgressIndicator(),
          ],
        ),
      ),
    );
  }
}
