import { Loader2, RefreshCw } from "lucide-react";
import { Component, type ComponentType, lazy, type ReactNode, Suspense } from "react";
import { Button } from "@/components/ui/button";
import { isChunkLoadError } from "@/lib/chunk-error";

/**
 * A component whose code loads from its own chunk the first time it renders, so a heavy library
 * that only some panels need stays out of the entry chunk every first load downloads (see
 * `apps/web/README.md`). `fallback` holds its place until the chunk arrives: size it like the
 * component so nothing jumps. A chunk that can't be fetched shows a reload prompt.
 */
export function lazyComponent<P extends object>(
  load: () => Promise<ComponentType<P>>,
  fallback: ReactNode = <PanelLoading />,
): ComponentType<P> {
  const Lazy = lazy(async () => ({ default: await load() }));
  // biome-ignore lint/correctness/noComponentHookFactories: called once per part at module level, like `lazy`, so its identity is stable.
  return function LazyComponent(props: P) {
    return (
      <ChunkErrorBoundary>
        <Suspense fallback={fallback}>
          <Lazy {...props} />
        </Suspense>
      </ChunkErrorBoundary>
    );
  };
}

/** A spinner in the middle of the area a panel fills, while its code loads. */
export function PanelLoading() {
  return (
    <div
      role="status"
      aria-label="Loading"
      className="flex h-full min-h-0 items-center justify-center text-muted-foreground"
    >
      <Loader2 className="size-4 animate-spin" />
    </div>
  );
}

/**
 * Shows a reload prompt in place of `children` when their code can't be fetched. Any other error
 * is a bug in that code and goes on to the boundaries above, as it would without this one.
 */
export class ChunkErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean; error: unknown }
> {
  override state: { failed: boolean; error: unknown } = { failed: false, error: undefined };

  static getDerivedStateFromError(error: unknown): { failed: boolean; error: unknown } {
    return { failed: true, error };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    if (!isChunkLoadError(this.state.error)) throw this.state.error;
    return <ReloadPrompt />;
  }
}

/** In place of a part or page whose code didn't load, usually because Agent Rishi was updated. */
export function ReloadPrompt() {
  return (
    <div
      role="alert"
      className="flex h-full min-h-0 flex-col items-center justify-center gap-2 p-4 text-center text-xs text-muted-foreground"
    >
      <p>
        This part of Agent Rishi didn't load. Agent Rishi may have been updated since you opened it.
      </p>
      <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
        <RefreshCw /> Reload
      </Button>
    </div>
  );
}
