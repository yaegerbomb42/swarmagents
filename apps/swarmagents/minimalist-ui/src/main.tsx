import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ToastsProvider } from "./components/Toasts";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <ToastsProvider>
        <App />
      </ToastsProvider>
    </ErrorBoundary>
  </StrictMode>
);
