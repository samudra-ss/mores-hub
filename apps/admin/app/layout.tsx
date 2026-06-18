import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'MORES-HUB Vault',
  description: 'Admin console — restricted access',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header
          style={{
            background: '#1B5E20',
            color: 'white',
            padding: '12px 24px',
            display: 'flex',
            justifyContent: 'space-between',
          }}
        >
          <strong>MORES-HUB · Vault</strong>
          <span style={{ fontSize: 12, opacity: 0.8 }}>
            Restricted · all actions audited
          </span>
        </header>
        <main style={{ padding: 24, maxWidth: 960, margin: '0 auto' }}>
          {children}
        </main>
      </body>
    </html>
  );
}
