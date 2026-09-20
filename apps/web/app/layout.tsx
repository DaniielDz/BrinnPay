import type { Metadata } from 'next';

import { AuthProvider } from '../components/auth/auth-provider';

export const metadata: Metadata = {
  title: 'BrinnPay',
  description: 'Payment infrastructure sandbox for developers.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}