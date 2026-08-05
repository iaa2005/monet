import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/globals.css";
import { applyCodeThemes } from "./lib/code-theme";

// The chosen code-highlighting palettes, before first paint — globals.css
// carries fallbacks, but a non-default theme must not flash the default.
applyCodeThemes();

// Error boundary to catch and display crashes
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error("[renderer] unhandled render error", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 40, fontFamily: "monospace", color: "#ef4444" }}>
          <h1>App Crashed</h1>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>
            {this.state.error.message}
            {"\n\n"}
            {this.state.error.stack}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              marginTop: 16,
              cursor: "pointer",
              border: "1px solid currentColor",
              borderRadius: 6,
              padding: "8px 12px",
              background: "transparent",
              color: "inherit",
              fontFamily: "inherit",
            }}
          >
            Reload application
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
