import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Formless Health',
  description: 'A live, agent-editable interface running in your browser.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
