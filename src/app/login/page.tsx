"use client";

import { useState, useEffect, FormEvent } from "react";
import { useRouter } from "next/navigation";
import { safeNextPath } from "@/lib/next-path";
import Image from "next/image";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useAuth } from "@/hooks/use-auth";
import { APP_NAME } from "@/lib/brand";
import {
  ProviderButtons,
  SIGN_IN_REFUSALS,
  SIGN_IN_REFUSALS_PASSWORDS_OFF,
} from "@/components/auth/ProviderButtons";

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [setupCode, setSetupCode] = useState("");
  const [isRegister, setIsRegister] = useState(false);
  // null until the server answers. Hidden while unknown and hidden on a failure: offering to
  // create the first administrator on an instance that already has one is the bug (BP-268), and
  // the sign-in form below works either way.
  const [unclaimed, setUnclaimed] = useState<boolean | null>(null);
  // Unknown until the server answers, and drawn as on meanwhile — the default, and on an instance
  // that turned it off the form only refuses itself until the answer replaces it
  const [passwordSignIn, setPasswordSignIn] = useState<boolean | null>(null);
  const [next, setNext] = useState<string | undefined>(undefined);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [ssoReason, setSsoReason] = useState("");
  const { login } = useAuth();
  const router = useRouter();

  // Asked of the server rather than guessed. This decides what is offered, not what is allowed:
  // POST /api/users counts the users itself and refuses a second bootstrap whatever this says, so
  // re-opening the form from the DOM buys nothing.
  useEffect(() => {
    let live = true;
    fetch("/api/auth/instance")
      // A 503 is never "unclaimed", but still says whether passwords sign in: that is not read
      // from the database
      .then(async (res) => ({ ok: res.ok, data: await res.json().catch(() => ({})) }))
      .then(({ ok, data }) => {
        if (!live) return;
        setUnclaimed(ok && data.unclaimed === true);
        setPasswordSignIn(data.passwordSignIn !== false);
      })
      .catch((err) => {
        // Says why rather than failing silently: on a fresh instance whose database is flapping,
        // the operator otherwise gets a sign-in page with no way to create the first account and
        // no explanation. A reload retries it.
        console.warn("could not ask whether this instance has been claimed", err);
        if (live) {
          setUnclaimed(false);
          setPasswordSignIn(true);
        }
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const reason = query.get("sso");
    if (reason) setSsoReason(reason);
    if (query.get("next")) setNext(safeNextPath(query.get("next")));
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      if (isRegister) {
        // Bootstrap first user
        const res = await fetch("/api/users", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password, fullName, setupCode }),
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || "Registration failed");
        }
      }

      const result = await login(username, password);
      if (result.ok) {
        router.replace(safeNextPath(new URLSearchParams(window.location.search).get("next")));
      } else {
        setError(result.reason);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  const ssoError = !ssoReason
    ? ""
    : ((passwordSignIn === false && SIGN_IN_REFUSALS_PASSWORDS_OFF[ssoReason]) ||
      SIGN_IN_REFUSALS[ssoReason] ||
      SIGN_IN_REFUSALS.failed);

  const setupCodeField = (
    <div>
      <Input
        label="Setup code"
        value={setupCode}
        onChange={(e) => setSetupCode(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        required
      />
      <p className="mt-1 text-xs text-text-muted">
        Printed in the server log when the instance starts, or the BOOTSTRAP_TOKEN you set.
      </p>
    </div>
  );

  return (
    <div className="flex items-center justify-center min-h-screen px-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <Image src="/logo.svg" alt={APP_NAME} width={48} height={48} className="mb-3" />
          <h1 className="text-2xl font-bold">{APP_NAME}</h1>
        </div>

        {passwordSignIn !== false && (
          <form onSubmit={handleSubmit} className="space-y-4">
            <Input
              label="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
            />
            <Input
              label="Password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={isRegister ? "new-password" : "current-password"}
              required
            />
            {isRegister && (
              <Input
                label="Full Name"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                required
              />
            )}
            {isRegister && setupCodeField}

            {error && (
              <p role="alert" className="text-sm text-danger text-center">
                {error}
              </p>
            )}

            <Button type="submit" className="w-full" disabled={loading}>
              {loading
                ? "..."
                : isRegister
                  ? "Create Account"
                  : "Sign In"}
            </Button>
          </form>
        )}

        {passwordSignIn === false && isRegister && (
          <div className="space-y-4">
            <Input
              label="Username"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
            <Input
              label="Full Name"
              autoComplete="name"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              required
            />
            {setupCodeField}
            <ProviderButtons
              intent="bootstrap"
              verb="Set up with"
              divider={false}
              extraBody={{ username, fullName, setupCode }}
            />
          </div>
        )}

        {!isRegister && (
          <div className={passwordSignIn !== false ? "mt-4 space-y-3" : "space-y-3"}>
            {ssoError && (
              <p role="alert" className="text-sm text-danger text-center">
                {ssoError}
              </p>
            )}
            <ProviderButtons
              intent="signin"
              divider={passwordSignIn !== false}
              extraBody={next ? { next } : undefined}
            />
          </div>
        )}

        {/* Only when signing in: it answers nothing on a form that is creating an account */}
        {!isRegister && passwordSignIn !== false && (
          <p className="mt-4 text-center text-sm">
            <Link href="/forgot" className="text-text-muted underline hover:text-text">
              Forgot your password?
            </Link>
          </p>
        )}

        {unclaimed && (
          <button
            onClick={() => setIsRegister(!isRegister)}
            className="mt-4 w-full text-center text-sm text-text-muted hover:text-text min-h-[44px]"
          >
            {isRegister
              ? "Already have an account? Sign In"
              : "First time? Create Account"}
          </button>
        )}
      </div>
    </div>
  );
}
