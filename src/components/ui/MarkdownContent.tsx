"use client";

import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useMemo } from "react";
import { remarkTaskReferences, type ReferenceScope } from "@/lib/task-references";

function isInternalHref(href: string | undefined): href is string {
  if (typeof href !== "string" || !href.startsWith("/")) return false;
  if (href.startsWith("//") || href.includes("\\")) return false;
  return true;
}

const components = {
  a: ({ href, children }: React.AnchorHTMLAttributes<HTMLAnchorElement>) =>
    isInternalHref(href) ? (
      <a href={href} className="text-primary hover:underline">
        {children}
      </a>
    ) : (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ),
  img: ({ src, alt, ...props }: React.ImgHTMLAttributes<HTMLImageElement>) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt || ""}
      {...props}
      className="rounded-lg max-w-full h-auto border border-border"
      loading="lazy"
    />
  ),
};

export function MarkdownContent({
  children,
  mentions = false,
  inline = false,
  scope,
}: {
  children: string;
  mentions?: boolean;
  inline?: boolean;
  scope?: ReferenceScope | null;
}) {
  const key = scope?.key ?? "";
  const former = (scope?.formerKeys ?? []).join(",");
  const plugins = useMemo(
    () =>
      key
        ? [remarkGfm, remarkTaskReferences({ key, formerKeys: former ? former.split(",") : [] })]
        : [remarkGfm],
    [key, former]
  );

  const processed = mentions
    ? children.replace(/@([a-zA-Z0-9_-]+)/g, "**`@$1`**")
    : children;

  return (
    <Markdown
      remarkPlugins={plugins}
      components={inline ? { ...components, p: ({ children: c }) => <>{c}</> } : components}
    >
      {processed}
    </Markdown>
  );
}
