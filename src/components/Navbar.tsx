"use client";

import Link from "next/link";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/Button";
import { useRouter } from "next/navigation";

export function Navbar() {
  const { user, logout } = useAuth();
  const router = useRouter();

  return (
    <nav className="border-b border-border bg-bg-card sticky top-0 z-40">
      <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between">
        <Link href="/projects" className="font-bold text-lg">
          ClaudePlanner
        </Link>

        {user && (
          <div className="flex items-center gap-3">
            <span className="text-sm text-text-muted hidden sm:inline">
              {user.fullName}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                logout();
                router.replace("/login");
              }}
            >
              Logout
            </Button>
          </div>
        )}
      </div>
    </nav>
  );
}
