"use client";

import { ButtonHTMLAttributes, forwardRef } from "react";

const variants = {
  primary: "bg-primary hover:bg-primary-hover text-white",
  secondary: "bg-bg-input hover:bg-bg-hover text-text border border-border",
  danger: "bg-danger hover:bg-danger-hover text-white",
  ghost: "hover:bg-bg-hover text-text-muted hover:text-text",
};

const sizes = {
  sm: "px-3 py-1.5 text-sm min-h-[36px]",
  md: "px-4 py-2 text-sm min-h-[44px]",
  lg: "px-6 py-3 text-base min-h-[48px]",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "primary", size = "md", className = "", ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={`inline-flex items-center justify-center rounded-lg font-medium transition-colors
          focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary
          disabled:opacity-50 disabled:pointer-events-none
          ${variants[variant]} ${sizes[size]} ${className}`}
        {...props}
      />
    );
  }
);

Button.displayName = "Button";
