import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "dnd.firegory",
  description: "Private citation-first D&D search and RAG workspace.",
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
