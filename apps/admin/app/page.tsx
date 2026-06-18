'use client';
import { useEffect, useState } from 'react';

const API = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3000';

export default function Home() {
  const [token, setToken] = useState<string>('');
  const [users, setUsers] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = localStorage.getItem('admin_jwt') ?? '';
    setToken(t);
    if (t) load(t);
  }, []);

  async function load(t: string) {
    setError(null);
    try {
      const res = await fetch(`${API}/admin/users`, {
        headers: { Authorization: `Bearer ${t}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setUsers(await res.json());
    } catch (e: any) {
      setError(e.message);
    }
  }

  function saveToken() {
    localStorage.setItem('admin_jwt', token);
    load(token);
  }

  if (!users) {
    return (
      <div className="card">
        <h2>Sign in</h2>
        <p>
          Paste a JWT for an account with the <code>SUPERADMIN</code> /
          <code>TREASURY</code> / <code>OPERATIONS</code> role.
        </p>
        <p style={{ fontSize: 12, color: '#888' }}>
          (In production this is replaced with SSO + hardware-key TOTP — paste-token is dev-only.)
        </p>
        <input
          style={{ width: '100%', marginBottom: 8 }}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="eyJhbGciOi..."
        />
        <button onClick={saveToken}>Connect</button>
        {error && <p style={{ color: 'red' }}>{error}</p>}
      </div>
    );
  }

  return (
    <>
      <h1>Users</h1>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Email</th>
              <th>Name</th>
              <th>KYC</th>
              <th>Active</th>
              <th>Joined</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.email}</td>
                <td>{u.name}</td>
                <td>{u.kycTier}</td>
                <td>{u.isActive ? 'yes' : 'no'}</td>
                <td>{new Date(u.createdAt).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Vault actions</h2>
      <p>
        <a href="/vault">Open Vault</a> — freeze wallet, manual ledger
        adjustment (dual-approval over IDR 50M), audit chain verification.
      </p>
    </>
  );
}
