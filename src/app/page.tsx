import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { PlatformSignIn } from "@/components/auth/PlatformSignIn";
import { isPlatformHost } from "@/lib/organisation-host";
import { passwordSignInEnabled } from "@/lib/password-sign-in";
import { servedOrganisationById } from "@/lib/platform-sign-in";
import { rememberedOrganisationIn } from "@/lib/platform-sign-in-route";

export default async function Home({ searchParams }: { searchParams: Promise<{ switch?: string; start?: string }> }) {
  const requestHeaders = await headers();
  if (!isPlatformHost(requestHeaders.get("host"))) redirect("/projects");

  const query = await searchParams;
  const canSignUp = passwordSignInEnabled();
  const signingUp = canSignUp && query.start !== undefined;
  if (query.switch === undefined && query.start === undefined) {
    const remembered = await servedOrganisationById(rememberedOrganisationIn(requestHeaders.get("cookie"))).catch(() => null);
    if (remembered) redirect(`${remembered.origin}/projects`);
  }
  return <PlatformSignIn signingUp={signingUp} canSignUp={canSignUp} />;
}
