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

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [isRegister, setIsRegister] = useState(false);
  // null until the server answers. Hidden while unknown and hidden on a failure: offering to
  // create the first administrator on an instance that already has one is the bug (BP-268), and
  // the sign-in form below works either way.
  const [unclaimed, setUnclaimed] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const router = useRouter();

  // Asked of the server rather than guessed. This decides what is offered, not what is allowed:
  // POST /api/users counts the users itself and refuses a second bootstrap whatever this says, so
  // re-opening the form from the DOM buys nothing.
  useEffect(() => {
    let live = true;
    fetch("/api/auth/instance")
      .then((res) => (res.ok ? res.json() : { unclaimed: false }))
      .then((data) => live && setUnclaimed(data.unclaimed === true))
      .catch(() => live && setUnclaimed(false));
    return () => {
      live = false;
    };
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
          body: JSON.stringify({ username, password, fullName }),
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

  return (
    <div className="flex items-center justify-center min-h-screen px-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <Image src="/logo.svg" alt={APP_NAME} width={48} height={48} className="mb-3" />
          <h1 className="text-2xl font-bold">{APP_NAME}</h1>
        </div>

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

        {/* Only when signing in: it answers nothing on a form that is creating an account */}
        {!isRegister && (
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
