import Link from "next/link";
import { redirect } from "next/navigation";

import { T } from "../../components/ui/i18n";
import { getCurrentUser } from "../../server/auth/session";
import { LoginForm } from "./login-form";

export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) redirect("/");

  return (
    <main className="page-shell">
      <section className="hero-card auth-card" aria-labelledby="login-title">
        <p className="eyebrow"><T k="privateAccess" /></p>
        <h1 id="login-title"><T k="signIn" /></h1>
        <p className="lede"><T k="loginLede" /></p>
        <LoginForm />
        <p className="muted">
          <T k="noAccount" /> <Link href="/register"><T k="register" /></Link>
        </p>
      </section>
    </main>
  );
}
