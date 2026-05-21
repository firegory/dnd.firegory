import type { Metadata } from "next";
import { UiLanguageProvider } from "../components/ui/i18n";
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
    <html lang="ru">
      <body><UiLanguageProvider>{children}</UiLanguageProvider></body>
    </html>
  );
}
