import { MobileHeader, Sidebar } from "./sidebar";

export type AppLayoutRole = "user" | "premium" | "admin";

export function AppLayout({
  children,
  userRole,
}: {
  children: React.ReactNode;
  userRole?: AppLayoutRole;
}) {
  return (
    <div className="min-h-screen bg-primary">
      <div className="hidden lg:block">
        <Sidebar userRole={userRole} />
      </div>
      <MobileHeader userRole={userRole} />
      <div className="lg:pl-56">
        <main className="mx-auto max-w-5xl px-4 py-6 lg:px-8 lg:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
