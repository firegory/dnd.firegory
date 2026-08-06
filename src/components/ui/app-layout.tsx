import { MobileHeader, Sidebar } from "./sidebar";
import { T } from "./i18n";

export type { AppLayoutRole } from "./navigation";
import type { AppLayoutRole } from "./navigation";

export function AppLayout({
  children,
  userRole,
  wide = false,
}: {
  children: React.ReactNode;
  userRole?: AppLayoutRole;
  wide?: boolean;
}) {
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content"><T k="skipToContent" /></a>
      <div className="app-frame">
        <div className="desktop-sidebar">
          <Sidebar userRole={userRole} />
        </div>
        <div className="app-page">
          <MobileHeader userRole={userRole} />
          <main
            id="main-content"
            tabIndex={-1}
            className={`app-parchment app-content ${wide ? "app-content-wide" : ""}`}
          >
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}
