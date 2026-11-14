import { Card, Skeleton } from "./ui";

/** Loading state for a list or dashboard page: stable layout, no fake numbers. */
export function PageLoading({ label = "Loading…" }: { label?: string }) {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      <Skeleton className="mb-2 h-8 w-56" />
      <Skeleton className="mb-6 h-4 w-80 max-w-full" />
      <Card>
        <div className="space-y-4 p-5">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center gap-4">
              <Skeleton className="h-5 flex-1" />
              <Skeleton className="hidden h-5 w-24 sm:block" />
              <Skeleton className="h-5 w-16" />
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
