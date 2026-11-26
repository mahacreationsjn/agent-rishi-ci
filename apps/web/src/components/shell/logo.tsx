import { cn } from "@/lib/utils";

/**
 * The Agent Rishi mark: the robot head from docs/brand/agent-rishi.png, rendered to
 * public/logo.png (with the favicon and app icons) by scripts/make-icons.py.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <img
      src="/logo.png"
      alt=""
      aria-hidden="true"
      draggable={false}
      className={cn("shrink-0 object-contain", className)}
    />
  );
}
