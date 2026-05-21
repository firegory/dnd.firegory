import Link from "next/link";
import { redirect } from "next/navigation";

import { T } from "../../components/ui/i18n";
import { getCurrentUser } from "../../server/auth/session";
import { RegisterForm } from "./register-form";

export default async function RegisterPage() {
  const user = await getCurrentUser();
  if (user) redirect("/");

  return (
    <main className="page-shell">
      <section className="hero-card auth-card" aria-labelledby="register-title">
        <p className="eyebrow"><T k="requiredRegistration" /></p>
        <h1 id="register-title"><T k="createAccount" /></h1>
        <p className="lede"><T k="registerLede" /></p>
        <RegisterForm />
        <p className="muted">
          <T k="alreadyHaveAccount" /> <Link href="/login"><T k="signIn" /></Link>
        </p>
      </section>
    </main>
  );
}
