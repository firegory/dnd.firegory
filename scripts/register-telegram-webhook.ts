import { setWebhook } from "../src/server/telegram/client";

const PUBLIC_URL = process.env.APP_URL ?? "https://dnd.firegory.site";
const SECRET = process.env.TELEGRAM_SECRET_TOKEN;

if (!SECRET) {
  console.error("TELEGRAM_SECRET_TOKEN is required");
  process.exit(1);
}

const webhookUrl = `${PUBLIC_URL}/api/telegram/webhook`;

await setWebhook(webhookUrl, SECRET);

console.log(`Webhook registered: ${webhookUrl}`);
