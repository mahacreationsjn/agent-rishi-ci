import { Component, type ReactNode } from "react";

/**
 * Shows `fallback` instead of `children` once rendering them throws, so one broken part (a diff
 * that fails to parse, say) doesn't take the rest of the view down with it. React logs the error.
 * Give it a `key` that changes with the content to try again.
 */
export class ErrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
