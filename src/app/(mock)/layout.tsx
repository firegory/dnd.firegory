import type { Metadata } from "next";
import { MockLayout } from "../../components/mock/layout";

export const metadata: Metadata = {
  title: "dnd.firegory — UI Prototype",
  description: "UI mock for dnd.firegory redesign review",
};

export default function MockGroupLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <MockLayout>{children}</MockLayout>;
}
