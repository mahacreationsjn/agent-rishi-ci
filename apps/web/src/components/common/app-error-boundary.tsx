import type { ReactNode } from "react";
import { ErrorBoundary } from "@/components/error-boundary";
import { Button } from "@/components/ui/button";

export function AppErrorBoundary({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary
      fallback={
        <main role="alert" className="grid min-h-dvh place-content-center gap-4 p-6 text-center">
          <h1 className="text-xl font-semibold">Agent Rishi could not load</h1>
          <Button variant="outline" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </main>
      }
    >
      {children}
    </ErrorBoundary>
  );
}
