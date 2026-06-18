import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import '../services/api_client.dart';

class WalletDetailScreen extends StatefulWidget {
  final String walletId;
  const WalletDetailScreen({super.key, required this.walletId});
  @override
  State<WalletDetailScreen> createState() => _WalletDetailScreenState();
}

class _WalletDetailScreenState extends State<WalletDetailScreen> {
  late Future<Map<String, dynamic>> _data;
  final _idr = NumberFormat.currency(locale: 'id_ID', symbol: 'Rp ', decimalDigits: 0);

  @override
  void initState() {
    super.initState();
    _data = context
        .read<ApiClient>()
        .get('/wallets/${widget.walletId}')
        .then((v) => v as Map<String, dynamic>);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Wallet')),
      body: FutureBuilder<Map<String, dynamic>>(
        future: _data,
        builder: (ctx, snap) {
          if (!snap.hasData) return const Center(child: CircularProgressIndicator());
          final w = snap.data!;
          final entries = (w['recent'] as List).cast<Map<String, dynamic>>();
          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(w['name'] as String,
                          style: Theme.of(context).textTheme.titleLarge),
                      const SizedBox(height: 4),
                      Text('${w['type']}  ·  ${w['role']}'),
                      const SizedBox(height: 12),
                      Text(_idr.format(int.parse(w['balance'] as String)),
                          style: Theme.of(context).textTheme.headlineMedium),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 16),
              const Text('Recent activity'),
              const SizedBox(height: 8),
              ...entries.map((e) {
                final isIn = e['direction'] == 'DEBIT';
                return ListTile(
                  leading: Icon(isIn ? Icons.south_west : Icons.north_east,
                      color: isIn ? Colors.green : Colors.red),
                  title: Text(e['description']?.toString() ?? e['type']),
                  subtitle: Text(e['category']?.toString() ?? ''),
                  trailing: Text(
                    '${isIn ? '+' : '-'}${_idr.format(int.parse(e['amount']))}',
                  ),
                );
              }),
            ],
          );
        },
      ),
    );
  }
}
