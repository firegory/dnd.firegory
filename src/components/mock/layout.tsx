"use client";

import { MockSidebar, MockMobileHeader } from "./sidebar";

export function MockLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-primary">
      {/* Desktop sidebar */}
      <div className="hidden lg:block">
        <MockSidebar />
      </div>

      {/* Mobile header */}
      <MockMobileHeader />

      {/* Main content */}
      <div className="lg:pl-56">
        <main className="mx-auto max-w-5xl px-4 py-6 lg:px-8 lg:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
