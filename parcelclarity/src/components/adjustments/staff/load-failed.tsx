import { Alert } from "@/components/ui/alert";

/** A load that failed is said to have failed. It is never drawn as an empty list or a zero. */
export function LoadFailed({ what }: { what: string }) {
  return (
    <Alert tone="danger" title={`${what[0]!.toUpperCase()}${what.slice(1)} could not be loaded`}>
      Reload the page to try again. If it keeps failing, contact support.
    </Alert>
  );
}
