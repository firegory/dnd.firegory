import Link from "next/link";

import { requireUser } from "../../server/auth/session";
import { logoutAction } from "../../server/auth/actions";
import { SearchForm } from "./search-form";

export default async function SearchPage() {
  const user = await requireUser();

  return (
    <main className="page-shell">
      <div className="search-layout">
        <header className="search-header">
          <div className="search-header-row">
            <h1 className="search-title">dnd.firegory</h1>
            <div className="search-header-actions">
              <Link href="/" className="secondary-button small">Home</Link>
              <form action={logoutAction}>
                <button type="submit" className="secondary-button small">Sign out</button>
              </form>
            </div>
          </div>
          <p className="hint">
            Signed in as <strong>{user.email}</strong>
          </p>
        </header>

        <SearchForm />
      </div>
    </main>
  );
}
