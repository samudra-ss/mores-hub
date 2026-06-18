import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:qr_flutter/qr_flutter.dart';
import '../services/api_client.dart';

class QrScreen extends StatefulWidget {
  final String walletId;
  const QrScreen({super.key, required this.walletId});
  @override
  State<QrScreen> createState() => _QrScreenState();
}

class _QrScreenState extends State<QrScreen> {
  String? _payload;
  bool _busy = false;

  Future<void> _generate() async {
    setState(() => _busy = true);
    try {
      final res = await context
          .read<ApiClient>()
          .post('/qris/static', {'walletId': widget.walletId});
      setState(() => _payload = res['payload'] as String);
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.toString())));
    } finally {
      setState(() => _busy = false);
    }
  }

  @override
  void initState() {
    super.initState();
    _generate();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Receive via QRIS')),
      body: Center(
        child: _busy || _payload == null
            ? const CircularProgressIndicator()
            : Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  QrImageView(data: _payload!, size: 280),
                  const SizedBox(height: 16),
                  const Text('Scan with any QRIS-supporting app'),
                  const SizedBox(height: 8),
                  const Text('(mock — sandbox merchant id)',
                      style: TextStyle(fontSize: 11, color: Colors.grey)),
                ],
              ),
      ),
    );
  }
}
