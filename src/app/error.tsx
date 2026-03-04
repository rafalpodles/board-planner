"use client";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[50vh] gap-4">
      <h2 className="text-xl font-bold text-danger">Something went wrong</h2>
      <pre className="text-sm text-text-muted bg-bg-input p-4 rounded-lg max-w-lg overflow-auto">
        {error.message}
        {"\n\n"}
        {error.stack}
      </pre>
      <button
        onClick={reset}
        className="px-4 py-2 bg-primary text-white rounded-lg"
      >
        Try again
      </button>
    </div>
  );
}
