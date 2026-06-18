'use client';
import { useState } from 'react';

const API = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3000';

function authHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${localStorage.getItem('admin_jwt') ?? ''}`,
  };
}

export default function Vault() {
  const [freezeId, setFreezeId] = useState('');
  const [freezeReason, setFreezeReason] = useState('');
  const [adjust, setAdjust] = useState({
    debitWalletId: '',
    creditWalletId: '',
    amount: '',
    reason: '',
  });
  const [approveId, setApproveId] = useState('');
  const [out, setOut] = useState<string>('');

  async function call(path: string, body: any) {
    setOut('…');
    const res = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
    });
    const txt = await res.text();
    setOut(`${res.status}\n${txt}`);
  }

  async function verify() {
    setOut('…');
    const res = await fetch(`${API}/admin/audit/verify`, { headers: authHeaders() });
    setOut(`${res.status}\n${await res.text()}`);
  }

  return (
    <>
      <h1>Vault</h1>
      <p style={{ color: '#888' }}>
        Every action below is appended to <code>AuditLog</code> with a hash
        chain. Adjustments above IDR 50,000,000 require a second admin to
        approve before execution.
      </p>

      <div className="card">
        <h3>Freeze wallet</h3>
        <input placeholder="walletId" value={freezeId} onChange={(e) => setFreezeId(e.target.value)} />{' '}
        <input placeholder="reason" value={freezeReason} onChange={(e) => setFreezeReason(e.target.value)} />{' '}
        <button onClick={() => call(`/admin/wallets/${freezeId}/freeze`, { reason: freezeReason })}>Freeze</button>
      </div>

      <div className="card">
        <h3>Manual ledger adjustment</h3>
        <input placeholder="debit wallet (recipient)" value={adjust.debitWalletId} onChange={(e) => setAdjust({ ...adjust, debitWalletId: e.target.value })} /><br /><br />
        <input placeholder="credit wallet (source)" value={adjust.creditWalletId} onChange={(e) => setAdjust({ ...adjust, creditWalletId: e.target.value })} /><br /><br />
        <input placeholder="amount IDR" value={adjust.amount} onChange={(e) => setAdjust({ ...adjust, amount: e.target.value })} /><br /><br />
        <input placeholder="reason" value={adjust.reason} onChange={(e) => setAdjust({ ...adjust, reason: e.target.value })} /><br /><br />
        <button onClick={() => call('/admin/ledger/adjust', { ...adjust, amount: Number(adjust.amount) })}>Submit</button>
      </div>

      <div className="card">
        <h3>Approve dual-action</h3>
        <input placeholder="approval id" value={approveId} onChange={(e) => setApproveId(e.target.value)} />{' '}
        <button onClick={() => call(`/admin/approvals/${approveId}`, {})}>Approve</button>
      </div>

      <div className="card">
        <h3>Audit chain integrity</h3>
        <button className="secondary" onClick={verify}>Verify hash chain</button>
      </div>

      <div className="card">
        <h3>Response</h3>
        <pre style={{ whiteSpace: 'pre-wrap' }}>{out}</pre>
      </div>
    </>
  );
}
