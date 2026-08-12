"use client";

import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useMemo } from "react";
import { remarkTaskReferences, type ReferenceScope } from "@/lib/task-references";

// "//evil.example" is a protocol-relative URL and "/\\evil.example" is folded into one by some
// parsers — both start with a slash and both leave the origin. Same check safeNextPath makes,
// and getting it wrong here means an off-site anchor rendered without rel="noopener" (BP-306).
function isInternalHref(href: string | undefined): href is string {
  if (typeof href !== "string" || !href.startsWith("/")) return false;
  if (href.startsWith("//") || href.includes("\\")) return false;
  return true;
}

const components = {
  // Internal task references route through the client without a full page load; anything else a
  // person pasted stays an ordinary anchor and opens where they expect
  // A plain anchor even for an internal address, so this is a real navigation rather than a soft
  // one. `/projects/x/tasks/n` is an intercepted route: soft-navigating to it from a task page
  // wakes the modal interceptor, which draws the task on top of the page the reader is already on
  // — two tasks stacked, the one underneath still the old one. The reader asked to go to a task,
  // not to open it over the one they were reading.
  //
  // `node` is react-markdown's mdast node and must not be spread onto an element; the rest is
  // dropped with it because nothing else here needs forwarding.
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
  // One line inside a row of other things — an acceptance criterion next to its checkbox — where a
  // block-level paragraph would break the row onto its own line
  inline = false,
  // The board this content belongs to. Without it a key stays plain text rather than becoming a
  // link to whichever project happens to share the prefix.
  scope,
}: {
  children: string;
  mentions?: boolean;
  inline?: boolean;
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
    <Markdown
      remarkPlugins={plugins}
      components={inline ? { ...components, p: ({ children: c }) => <>{c}</> } : components}
    >
      {processed}
    </Markdown>
  );
}
