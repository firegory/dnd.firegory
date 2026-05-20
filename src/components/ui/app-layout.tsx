import { MobileHeader, Sidebar } from "./sidebar";

export function AppLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-primary"><div className="hidden lg:block"><Sidebar /></div><MobileHeader /><div className="lg:pl-56"><main className="mx-auto max-w-5xl px-4 py-6 lg:px-8 lg:py-8">{children}</main></div></div>;
}
