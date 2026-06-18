import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import '../services/api_client.dart';

class TopupScreen extends StatefulWidget {
  final String walletId;
  const TopupScreen({super.key, required this.walletId});
  @override
  State<TopupScreen> createState() => _TopupScreenState();
}

class _TopupScreenState extends State<TopupScreen> {
  final _amount = TextEditingController(text: '100000');
  String _bank = 'BCA';
  Map<String, dynamic>? _order;
  bool _busy = false;
  String? _err;

  static const _banks = ['BCA', 'BNI', 'BRI', 'MANDIRI', 'PERMATA', 'CIMB', 'BSI', 'DANAMON'];

  Future<void> _create() async {
    setState(() {
      _busy = true;
      _err = null;
    });
    try {
      final res = await context.read<ApiClient>().post('/topup/orders', {
        'walletId': widget.walletId,
        'bank': _bank,
        'amount': int.parse(_amount.text),
      });
      setState(() => _order = res as Map<String, dynamic>);
    } catch (e) {
      setState(() => _err = e.toString());
    } finally {
      setState(() => _busy = false);
    }
  }

  Future<void> _simulatePaid() async {
    final hint = _order?['mockSettleHint'] as Map<String, dynamic>?;
    if (hint == null) return;
    await context.read<ApiClient>().post(hint['url'] as String, hint['body'] as Map<String, dynamic>);
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Mock VA settled — wallet credited')),
    );
    Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Top up')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: _order == null ? _form() : _orderView(),
      ),
    );
  }

  Widget _form() => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          DropdownButtonFormField<String>(
            value: _bank,
            decoration: const InputDecoration(labelText: 'Bank'),
            items: _banks.map((b) => DropdownMenuItem(value: b, child: Text(b))).toList(),
            onChanged: (v) => setState(() => _bank = v!),
          ),
          const SizedBox(height: 16),
          TextField(
            controller: _amount,
            keyboardType: TextInputType.number,
            decoration: const InputDecoration(labelText: 'Amount (IDR)', prefixText: 'Rp '),
            inputFormatters: [FilteringTextInputFormatter.digitsOnly],
          ),
          const SizedBox(height: 24),
          if (_err != null) Text(_err!, style: const TextStyle(color: Colors.red)),
          ElevatedButton(
            onPressed: _busy ? null : _create,
            child: Text(_busy ? '…' : 'Generate VA number'),
          ),
        ],
      );

  Widget _orderView() => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text('Transfer to ${_order!['bank']} VA:',
              style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 12),
          SelectableText(
            _order!['vaNumber'] as String,
            style: const TextStyle(fontSize: 24, fontWeight: FontWeight.bold),
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 12),
          Text('Amount: Rp ${_order!['amount']}'),
          Text('Expires: ${_order!['expiresAt']}'),
          const SizedBox(height: 24),
          if (_order!['mockSettleHint'] != null) ...[
            const Divider(),
            const Text('Mock mode — simulate the bank transfer below.'),
            const SizedBox(height: 12),
            OutlinedButton.icon(
              icon: const Icon(Icons.bug_report),
              label: const Text('Simulate VA settled'),
              onPressed: _simulatePaid,
            ),
          ],
        ],
      );
}
