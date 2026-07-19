/**
 * MapError — fail-fast chrome for invalid map fences or missing props.
 */

interface MapErrorProps {
  message: string;
}

export function MapError({ message }: MapErrorProps) {
  return (
    <div
      className="my-3 w-full max-w-2xl rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-100"
      role="alert"
    >
      <div className="font-medium">Invalid map block</div>
      <div className="mt-0.5 opacity-90">{message}</div>
    </div>
  );
}
