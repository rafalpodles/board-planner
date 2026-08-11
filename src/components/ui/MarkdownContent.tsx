"use client";

import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import Link from "next/link";
import { useMemo } from "react";
import { remarkTaskReferences, type ReferenceScope } from "@/lib/task-references";

const components = {
  // Internal task references route through the client without a full page load; anything else a
  // person pasted stays an ordinary anchor and opens where they expect
  // `node` is react-markdown's mdast node and must not be spread onto an element; the rest is
  // dropped with it because nothing else here needs forwarding
  a: ({ href, children }: React.AnchorHTMLAttributes<HTMLAnchorElement>) =>
    href?.startsWith("/") ? (
      <Link href={href} className="text-primary hover:underline">
        {children}
      </Link>
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
  // The board this content belongs to. Without it a key stays plain text rather than becoming a
  // link to whichever project happens to share the prefix.
  scope,
}: {
  children: string;
  mentions?: boolean;
  scope?: ReferenceScope | null;
}) {
  // Keyed on the values, not on the object: a parent building the scope inline would otherwise
  // rebuild the plugin — and re-parse the markdown — on every render it happens to do
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
    <Markdown remarkPlugins={plugins} components={components}>
      {processed}
    </Markdown>
  );
}
