import { Component, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * t14r — recoverable error boundary around the workspace.
 *
 * Catches render errors anywhere below it and shows a friendly fallback with a one-click
 * reset and a reload action instead of a blank white screen.
 *
 * The error detail is never shown on the page — it is not actionable to
 * the visitor and can carry internal paths or messages. This matches the
 * root error boundary in app/error.tsx; the browser console still has
 * the original error for debugging.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  private handleReset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return (
        <div className="grid min-h-screen place-items-center bg-[#07070a] px-4 text-white antialiased">
          <div role="alert" className="glass-soft w-full max-w-md rounded-3xl p-8 text-center">
            <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-red-500/10 text-red-400 ring-1 ring-red-500/20">
              <TriangleAlert className="h-5 w-5" aria-hidden />
            </div>
            <div className="text-base font-medium text-white/90">Something went wrong</div>
            <p className="mt-2 text-sm leading-relaxed text-white/45">
              The workspace hit an unexpected error. Try again — if it keeps happening, reload
              the page.
            </p>
            <div className="mt-6 flex justify-center gap-3">
              <button
                onClick={() => window.location.reload()}
                className="rounded-full bg-white px-5 py-2 text-xs font-medium text-black transition hover:scale-105"
              >
                Reload
              </button>
              <button
                onClick={this.handleReset}
                className="rounded-full border border-white/15 px-5 py-2 text-xs text-white/70 transition hover:text-white"
              >
                Try again
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
