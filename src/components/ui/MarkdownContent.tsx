"use client";

import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

const components = {
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
}: {
  children: string;
  mentions?: boolean;
}) {
  const processed = mentions
    ? children.replace(/@([a-zA-Z0-9_-]+)/g, "**`@$1`**")
    : children;
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={components}>
      {processed}
    </Markdown>
  );
}
