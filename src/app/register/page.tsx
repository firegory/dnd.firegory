import Link from "next/link";
import { redirect } from "next/navigation";

import { getCurrentUser } from "../../server/auth/session";
import { RegisterForm } from "./register-form";

export default async function RegisterPage() {
  const user = await getCurrentUser();
  if (user) redirect("/");

  return (
    <main className="page-shell">
      <section className="hero-card auth-card" aria-labelledby="register-title">
        <p className="eyebrow">Required registration</p>
        <h1 id="register-title">Create account</h1>
        <p className="lede">Register to use the private D&D search workspace.</p>
        <RegisterForm />
        <p className="muted">
          Already have an account? <Link href="/login">Sign in</Link>
        </p>
      </section>
    </main>
  );
}
