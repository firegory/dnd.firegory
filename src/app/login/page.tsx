import Link from "next/link";
import { redirect } from "next/navigation";

import { T } from "../../components/ui/i18n";
import { getCurrentUser } from "../../server/auth/session";
import { validatedRedirectPath } from "../../server/http/redirect-path";
import { LoginForm } from "./login-form";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const rawNext = (await searchParams).next;
  const nextPath = validatedRedirectPath(Array.isArray(rawNext) ? rawNext[0] : rawNext);
  const user = await getCurrentUser();
  if (user) redirect(nextPath);

  return (
    <div className="app-parchment flex min-h-screen items-center justify-center bg-primary px-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-accent"><T k="privateAccess" /></p>
          <h1 id="login-title" className="mt-2 text-2xl font-bold text-text-primary"><T k="signIn" /></h1>
          <p className="mt-1 text-sm text-text-muted"><T k="loginLede" /></p>
        </div>
        <section className="rounded-2xl border border-border bg-surface p-6" aria-labelledby="login-title">
          <LoginForm nextPath={nextPath} />
        </section>
        <p className="text-center text-sm text-text-muted">
          <T k="noAccount" />{" "}
          <Link href={`/register?next=${encodeURIComponent(nextPath)}`} className="font-medium text-accent hover:underline">
            <T k="register" />
          </Link>
        </p>
      </div>
    </div>
  );
}
