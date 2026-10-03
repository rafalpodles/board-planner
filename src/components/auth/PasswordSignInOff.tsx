import Link from "next/link";

/** What the password pages say on an instance that has turned password sign-in off. */
export function PasswordSignInOff() {
  return (
    <div className="w-full max-w-sm text-center">
      <h1 className="text-2xl font-bold mb-2">Passwords are not used here</h1>
      <p className="text-sm text-text-muted mb-6">
        This instance signs in with a provider only, so there is no password to reset.
      </p>
      <Link href="/login" className="text-sm underline">
        Go to sign-in
      </Link>
    </div>
  );
}
