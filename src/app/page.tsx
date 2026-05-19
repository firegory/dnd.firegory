import Link from "next/link";

import { logoutAction } from "../server/auth/actions";
import { requireUser } from "../server/auth/session";

const plannedFeatures = [
  "Private login-protected D&D rules search",
  "Edition and language aware retrieval",
  "Citation-first answers with source quotes",
];

export default async function Home() {
  const user = await requireUser();

  return (
    <main className="page-shell">
      <section className="hero-card" aria-labelledby="page-title">
        <p className="eyebrow">Authenticated workspace</p>
        <h1 id="page-title">dnd.firegory</h1>
        <p className="lede">
          Signed in as <strong>{user.email}</strong> with role <strong>{user.role}</strong>.
        </p>
        <ul>
          {plannedFeatures.map((feature) => (
            <li key={feature}>{feature}</li>
          ))}
        </ul>
        <div className="button-row">
          {user.role === "admin" ? <Link className="button" href="/admin/ingestion">Ingestion</Link> : null}
          {user.role === "admin" ? <Link className="button" href="/admin/users">Manage users</Link> : null}
          <form action={logoutAction}>
            <button type="submit" className="secondary-button">Sign out</button>
          </form>
        </div>
      </section>
    </main>
  );
}
