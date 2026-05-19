import Link from "next/link";

import { getCurrentUser } from "../../server/auth/session";
import { LoginForm } from "./login-form";
import { redirect } from "next/navigation";

export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) redirect("/");

  return (
    <main className="page-shell">
      <section className="hero-card auth-card" aria-labelledby="login-title">
        <p className="eyebrow">Private access</p>
        <h1 id="login-title">Sign in</h1>
        <p className="lede">Use your dnd.firegory account to access the search workspace.</p>
        <LoginForm />
        <p className="muted">
          No account yet? <Link href="/register">Register</Link>
        </p>
      </section>
    </main>
  );
}
