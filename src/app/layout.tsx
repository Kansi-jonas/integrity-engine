import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RTKdata Integrity Engine",
  description: "Signal Integrity Monitoring for GNSS Networks",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
