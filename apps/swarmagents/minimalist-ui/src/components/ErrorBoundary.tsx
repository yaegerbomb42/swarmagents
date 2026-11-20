import { Component, type ReactNode } from "react";

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
          <div className="glass-soft w-full max-w-md rounded-3xl p-8 text-center">
            <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-red-500/10 text-red-400 ring-1 ring-red-500/20">
              <span className="text-xl">⚠</span>
            </div>
            <div className="text-base font-medium text-white/90">Something went wrong</div>
            <p className="mt-2 text-sm text-white/45">The workspace hit an unexpected error. You can reload, or try again.</p>
            <p className="mt-3 break-words rounded-xl bg-white/5 p-3 font-mono text-[10px] leading-relaxed text-red-300/70">
              {this.state.error.message || String(this.state.error)}
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
