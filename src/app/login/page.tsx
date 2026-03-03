"use client";

import { useState, FormEvent } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useAuth } from "@/hooks/use-auth";

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [isRegister, setIsRegister] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const router = useRouter();

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

      const success = await login(username, password);
      if (success) {
        router.replace("/projects");
      } else {
        setError("Invalid credentials");
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
          <Image src="/logo.svg" alt="ClaudePlanner" width={48} height={48} className="mb-3" />
          <h1 className="text-2xl font-bold">ClaudePlanner</h1>
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
            <p className="text-sm text-danger text-center">{error}</p>
          )}

          <Button type="submit" className="w-full" disabled={loading}>
            {loading
              ? "..."
              : isRegister
                ? "Create Account"
                : "Sign In"}
          </Button>
        </form>

        <button
          onClick={() => setIsRegister(!isRegister)}
          className="mt-4 w-full text-center text-sm text-text-muted hover:text-text min-h-[44px]"
        >
          {isRegister
            ? "Already have an account? Sign In"
            : "First time? Create Account"}
        </button>
      </div>
    </div>
  );
}
