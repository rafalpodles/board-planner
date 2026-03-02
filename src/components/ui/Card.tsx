"use client";

interface CardProps {
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
}

export function Card({ children, className = "", onClick }: CardProps) {
  return (
    <div
      className={`rounded-xl border border-border bg-bg-card p-4
        ${onClick ? "cursor-pointer hover:border-primary/50 transition-colors" : ""}
        ${className}`}
      onClick={onClick}
    >
      {children}
    </div>
  );
}
