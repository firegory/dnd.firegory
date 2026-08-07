import type { Metadata } from "next";
import { headers } from "next/headers";
import { UiLanguageProvider } from "../components/ui/i18n";
import "./globals.css";

export const metadata: Metadata = {
  title: "dnd.firegory",
  description: "Private citation-first D&D search and RAG workspace.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const language = (await headers()).get("x-dnd-ui-language") === "en" ? "en" : "ru";
  return (
    <html lang={language}>
      <body><UiLanguageProvider>{children}</UiLanguageProvider></body>
    </html>
  );
}
