import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { PlatformSignIn } from "@/components/auth/PlatformSignIn";
import { isPlatformHost } from "@/lib/organisation-host";
import { servedOrganisationById } from "@/lib/platform-sign-in";
import { rememberedOrganisationIn } from "@/lib/platform-sign-in-route";

export default async function Home({ searchParams }: { searchParams: Promise<{ switch?: string }> }) {
  const requestHeaders = await headers();
  if (!isPlatformHost(requestHeaders.get("host"))) redirect("/projects");

  if ((await searchParams).switch === undefined) {
    const remembered = await servedOrganisationById(rememberedOrganisationIn(requestHeaders.get("cookie"))).catch(() => null);
    if (remembered) redirect(`${remembered.origin}/projects`);
  }
  return <PlatformSignIn />;
}
