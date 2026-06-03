import { randomInt } from "node:crypto";
import { query, withTransaction } from "../db/client";

const LINK_CODE_TTL_MINUTES = 15;

export async function generateLinkToken(userId: string): Promise<string> {
  const code = String(randomInt(100000, 999999));
  const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MINUTES * 60 * 1000);

  await query(
    `DELETE FROM telegram_link_tokens WHERE expires_at < now()`,
  );

  await query(
    `INSERT INTO telegram_link_tokens (user_id, code, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, code, expiresAt],
  );

  return code;
}

export type LinkResult =
  | { ok: true; userId: string }
  | { ok: false; error: string };

export async function verifyLinkCode(
  code: string,
  telegramId: number,
): Promise<LinkResult> {
  return withTransaction(async (tx) => {
    const claimed = await tx.query<{ user_id: string }, [string]>(
      `UPDATE telegram_link_tokens
       SET used_at = now()
       WHERE code = $1 AND used_at IS NULL AND expires_at > now()
       RETURNING user_id`,
      [code],
    );

    if (claimed.rows.length === 0) {
      return { ok: false as const, error: "Invalid or expired link code." };
    }

    const userId = claimed.rows[0].user_id;

    await tx.query(
      "DELETE FROM telegram_links WHERE telegram_id = $1",
      [telegramId],
    );

    await tx.query(
      "INSERT INTO telegram_links (user_id, telegram_id) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET telegram_id = $2, created_at = now()",
      [userId, telegramId],
    );

    return { ok: true as const, userId };
  });
}

export async function unlinkTelegram(userId: string): Promise<void> {
  await query("DELETE FROM telegram_links WHERE user_id = $1", [userId]);
}

export type TelegramUser = {
  userId: string;
  role: string;
};

export async function findUserByTelegramId(
  telegramId: number,
): Promise<TelegramUser | null> {
  const result = await query<{ user_id: string; role: string }>(
    `SELECT u.id AS user_id, u.role
     FROM telegram_links tl
     JOIN users u ON u.id = tl.user_id
     WHERE tl.telegram_id = $1 AND u.disabled_at IS NULL`,
    [telegramId],
  );

  const row = result.rows[0];
  if (!row) return null;

  return { userId: row.user_id, role: row.role };
}

export async function findTelegramLinkByUserId(
  userId: string,
): Promise<{ telegramId: number } | null> {
  const result = await query<{ telegram_id: number }>(
    "SELECT telegram_id FROM telegram_links WHERE user_id = $1",
    [userId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { telegramId: row.telegram_id };
}
