import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import '../services/api_client.dart';
import '../services/auth_service.dart';
import 'topup_screen.dart';
import 'qr_screen.dart';
import 'wallet_detail_screen.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});
  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  late Future<List<dynamic>> _wallets;

  final _idr = NumberFormat.currency(locale: 'id_ID', symbol: 'Rp ', decimalDigits: 0);

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  void _refresh() {
    setState(() {
      _wallets = context.read<ApiClient>().get('/wallets').then((v) => v as List);
    });
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthService>();
    return Scaffold(
      appBar: AppBar(
        title: Text('Hi, ${auth.user?['name'] ?? ''}'),
        actions: [
          IconButton(
            icon: const Icon(Icons.logout),
            onPressed: () async {
              await auth.signOut();
              if (!context.mounted) return;
              Navigator.of(context).popUntil((r) => r.isFirst);
            },
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () async => _refresh(),
        child: FutureBuilder<List<dynamic>>(
          future: _wallets,
          builder: (ctx, snap) {
            if (snap.connectionState != ConnectionState.done) {
              return const Center(child: CircularProgressIndicator());
            }
            if (snap.hasError) {
              return Center(child: Text('Error: ${snap.error}'));
            }
            final wallets = snap.data ?? [];
            return ListView.separated(
              padding: const EdgeInsets.all(16),
              itemCount: wallets.length,
              separatorBuilder: (_, __) => const SizedBox(height: 12),
              itemBuilder: (_, i) {
                final w = wallets[i] as Map<String, dynamic>;
                return Card(
                  child: ListTile(
                    title: Text(w['name'] as String),
                    subtitle: Text('${w['type']}  ·  ${w['role']}'),
                    trailing: Text(
                      _idr.format(int.parse(w['balance'] as String)),
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    onTap: () => Navigator.of(context).push(
                      MaterialPageRoute(
                        builder: (_) => WalletDetailScreen(walletId: w['id']),
                      ),
                    ),
                  ),
                );
              },
            );
          },
        ),
      ),
      floatingActionButton: Row(
        mainAxisAlignment: MainAxisAlignment.end,
        children: [
          FloatingActionButton.extended(
            heroTag: 'qr',
            icon: const Icon(Icons.qr_code),
            label: const Text('QRIS'),
            onPressed: () async {
              final wallets = await _wallets;
              if (!mounted || wallets.isEmpty) return;
              final w = wallets.first as Map<String, dynamic>;
              Navigator.of(context).push(MaterialPageRoute(
                builder: (_) => QrScreen(walletId: w['id']),
              ));
            },
          ),
          const SizedBox(width: 12),
          FloatingActionButton.extended(
            heroTag: 'topup',
            icon: const Icon(Icons.add),
            label: const Text('Top up'),
            onPressed: () async {
              final wallets = await _wallets;
              if (!mounted || wallets.isEmpty) return;
              final personal = (wallets as List).cast<Map<String, dynamic>>().firstWhere(
                    (w) => w['type'] == 'PERSONAL',
                    orElse: () => wallets.first as Map<String, dynamic>,
                  );
              Navigator.of(context)
                  .push(MaterialPageRoute(
                    builder: (_) => TopupScreen(walletId: personal['id']),
                  ))
                  .then((_) => _refresh());
            },
          ),
        ],
      ),
    );
  }
}
