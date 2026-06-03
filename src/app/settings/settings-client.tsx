"use client";

import { useState, useTransition } from "react";
import { generateLinkTokenAction, unlinkTelegramAction } from "./actions";

export function SettingsClient({ isLinked: initialLinked }: { isLinked: boolean }) {
  const [isLinked, setIsLinked] = useState(initialLinked);
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleLink() {
    setError(null);
    startTransition(async () => {
      try {
        const token = await generateLinkTokenAction();
        setCode(token);
      } catch {
        setError("Failed to generate code. Please try again.");
      }
    });
  }

  function handleUnlink() {
    setError(null);
    startTransition(async () => {
      try {
        await unlinkTelegramAction();
        setIsLinked(false);
        setCode(null);
      } catch {
        setError("Failed to unlink. Please try again.");
      }
    });
  }

  if (isLinked && !code) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <span className="inline-flex rounded-full bg-accent/15 px-2.5 py-0.5 text-xs font-semibold text-accent">
            Linked
          </span>
        </div>
        <button
          onClick={handleUnlink}
          disabled={isPending}
          className="inline-flex w-fit items-center gap-2 rounded-lg border border-border bg-surface px-4 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-light hover:text-text-primary disabled:opacity-50"
        >
          {isPending ? "Unlinking…" : "Unlink Telegram"}
        </button>
      </div>
    );
  }

  if (code) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-text-secondary">
          Send this code to the Telegram bot:
        </p>
        <div className="flex items-center gap-4">
          <div className="rounded-lg border border-border bg-primary/60 px-6 py-3 font-mono text-2xl font-bold tracking-[0.4em] text-text-primary">
            {code}
          </div>
          <button
            onClick={() => setCode(null)}
            className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-muted transition-colors hover:bg-surface-light hover:text-text-primary"
          >
            Cancel
          </button>
        </div>
        <p className="text-xs text-text-muted">
          This code expires in 15 minutes.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-secondary">
        Link your account to search the D&D knowledge base from Telegram.
      </p>
      <button
        onClick={handleLink}
        disabled={isPending}
        className="inline-flex w-fit items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-primary shadow-lg shadow-accent/20 transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {isPending ? "Generating…" : "Link Telegram"}
      </button>
      {error && (
        <p className="text-sm text-danger">{error}</p>
      )}
    </div>
  );
}
