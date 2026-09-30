// app/layout.tsx
import type { Metadata } from "next";
import "./globals.css";
import { SiteHeader } from "@/components/site-header";
import { NextAuthProvider } from "@/components/auth/NextAuthProvider";

export const metadata: Metadata = {
  title: "TaxRocket",
  description:
    "Guided FBR tax filing — uploads, reconciliation, approval, and supervised filing.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-muted/30 font-sans antialiased">
        <NextAuthProvider>
          <SiteHeader />
          <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
            {children}
          </main>
        </NextAuthProvider>
      </body>
    </html>
  );
}
