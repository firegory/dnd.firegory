"use client";

import { useState } from "react";
import { generateLinkTokenAction, unlinkTelegramAction } from "./page";

export function SettingsClient({
  userId,
  isLinked: initialLinked,
}: {
  userId: string;
  isLinked: boolean;
}) {
  const [isLinked, setIsLinked] = useState(initialLinked);
  const [code, setCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleLink() {
    setLoading(true);
    try {
      const token = await generateLinkTokenAction();
      setCode(token);
    } finally {
      setLoading(false);
    }
  }

  async function handleUnlink() {
    setLoading(true);
    try {
      await unlinkTelegramAction();
      setIsLinked(false);
      setCode(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 600, margin: "2rem auto", padding: "0 1rem" }}>
      <h1>Settings</h1>

      <section style={{ marginTop: "2rem" }}>
        <h2>Telegram Integration</h2>

        {isLinked && !code && (
          <div>
            <p style={{ color: "var(--color-success, green)" }}>
              Your account is linked to Telegram.
            </p>
            <button onClick={handleUnlink} disabled={loading}>
              {loading ? "Unlinking…" : "Unlink Telegram"}
            </button>
          </div>
        )}

        {code && (
          <div style={{ marginTop: "1rem" }}>
            <p>Send this code to the Telegram bot:</p>
            <div
              style={{
                fontSize: "2rem",
                fontWeight: "bold",
                letterSpacing: "0.5em",
                padding: "1rem",
                background: "var(--color-bg-secondary, #f0f0f0)",
                borderRadius: "8px",
                textAlign: "center",
                fontFamily: "monospace",
              }}
            >
              {code}
            </div>
            <p style={{ marginTop: "0.5rem", fontSize: "0.875rem", color: "var(--color-text-secondary, #666)" }}>
              This code expires in 15 minutes.
            </p>
          </div>
        )}

        {!isLinked && !code && (
          <div>
            <p>Link your Telegram account to search the D&D knowledge base from Telegram.</p>
            <button onClick={handleLink} disabled={loading}>
              {loading ? "Generating…" : "Link Telegram"}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
