import type { Metadata } from "next";
import { OrganisationHostGate } from "@/components/auth/OrganisationHostGate";
import { APP_NAME } from "@/lib/brand";

export const metadata: Metadata = {
  title: `Sign in — ${APP_NAME}`,
  description: `Sign in to ${APP_NAME}, the project board your team and your coding agents work on together.`,
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <OrganisationHostGate>{children}</OrganisationHostGate>;
}
