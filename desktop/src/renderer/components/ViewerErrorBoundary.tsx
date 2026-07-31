/**
 * A file preview that throws must not take the app with it.
 *
 * FileViewer renders whatever the user points at — a 200 MB CSV, a PDF with a
 * broken xref table, a docx some tool half-wrote. Those failures belong to the
 * FILE, not to the session, so they are caught here and offered a retry: the
 * retryKey remounts the subtree, which is the difference between "open it
 * again" and "restart the app".
 *
 * Lives in its own file because both the dock's viewer panel and any future
 * host need it, and importing it from App would be a cycle.
 */

import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";

export class ViewerErrorBoundary extends Component<
  { children: ReactNode; onClose: () => void },
  { error: Error | null; retryKey: number }
> {
  state: { error: Error | null; retryKey: number } = {
    error: null,
    retryKey: 0,
  };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[renderer] FileViewer render error", error, info.componentStack);
  }

  private retry = (): void => {
    this.setState(({ retryKey }) => ({ error: null, retryKey: retryKey + 1 }));
  };

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-sm font-medium text-destructive">File preview failed</p>
          <p className="max-w-md text-xs text-muted-foreground">
            {this.state.error.message || "The file preview could not be rendered."}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={this.retry}
              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={this.props.onClose}
              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
            >
              Close
            </button>
          </div>
        </div>
      );
    }
    return <Fragment key={this.state.retryKey}>{this.props.children}</Fragment>;
  }
}
