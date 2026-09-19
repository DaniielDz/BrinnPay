import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'BrinnPay',
  description: 'Payment infrastructure sandbox for developers.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}