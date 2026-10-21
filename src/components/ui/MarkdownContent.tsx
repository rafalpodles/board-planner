"use client";

import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Component, useMemo, type ReactNode } from "react";
import { remarkTaskReferences, type ReferenceScope } from "@/lib/task-references";
import { remarkMentions, type MentionablePerson } from "@/lib/remark-mentions";
import { tooCostlyToParse } from "@/lib/markdown-cost";

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
  code: ({ children, className }: React.HTMLAttributes<HTMLElement>) => (
    <code className={className ? `md-code ${className}` : "md-code"}>{children}</code>
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

const RAW_TEXT = "whitespace-pre-wrap [overflow-wrap:anywhere]";

function RawText({ children, inline }: { children: string; inline: boolean }) {
  if (inline) {
    return (
      <span data-markdown="raw" className={RAW_TEXT}>
        {children}
      </span>
    );
  }
  return (
    <div>
      <p data-markdown="note" className="mb-1 text-xs text-text-muted">
        Shown as plain text: too long or too deeply nested to format.
      </p>
      <div data-markdown="raw" className={RAW_TEXT}>
        {children}
      </div>
    </div>
  );
}

// react-markdown parses while it renders, so a body the parser throws on takes down the tree it sits
// in (BP-1107)
class RawTextOnError extends Component<
  { source: string; fallback: ReactNode; children: ReactNode },
  { failed: boolean; source: string }
> {
  state = { failed: false, source: this.props.source };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  static getDerivedStateFromProps(
    props: { source: string },
    state: { failed: boolean; source: string }
  ) {
    return props.source === state.source ? null : { failed: false, source: props.source };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function MarkdownContent({
  children,
  // The people a `@username` may name here; each one renders as a pill and anyone else as text
  mentions,
  // One line inside a row of other things — an acceptance criterion next to its checkbox — where a
  // block-level paragraph would break the row onto its own line
  inline = false,
  // The board this content belongs to. Without it a key stays plain text rather than becoming a
  // link to whichever project happens to share the prefix.
  scope,
}: {
  children: string;
  mentions?: readonly MentionablePerson[];
  inline?: boolean;
  scope?: ReferenceScope | null;
}) {
  // Keyed on the values, not on the object: a parent building the scope inline would otherwise
  // rebuild the plugin — and re-parse the markdown — on every render it happens to do
  const key = scope?.key ?? "";
  const former = (scope?.formerKeys ?? []).join(",");
  const plugins = useMemo(
    () => [
      remarkGfm,
      ...(key ? [remarkTaskReferences({ key, formerKeys: former ? former.split(",") : [] })] : []),
      ...(mentions?.length ? [remarkMentions(mentions)] : []),
    ],
    [key, former, mentions]
  );

  const body = typeof children === "string" ? children : "";
  const raw = useMemo(() => tooCostlyToParse(body), [body]);
  if (raw) return <RawText inline={inline}>{body}</RawText>;

  return (
    <RawTextOnError source={body} fallback={<RawText inline={inline}>{body}</RawText>}>
      <Markdown
        remarkPlugins={plugins}
        components={inline ? { ...components, p: ({ children: c }) => <>{c}</> } : components}
      >
        {body}
      </Markdown>
    </RawTextOnError>
  );
}
