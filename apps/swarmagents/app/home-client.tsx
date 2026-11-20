"use client";

import nextDynamic from "next/dynamic";
import { ErrorBoundary } from "../minimalist-ui/src/components/ErrorBoundary";
import { ToastsProvider } from "../minimalist-ui/src/components/Toasts";

const MinimalistApp = nextDynamic(() => import("../minimalist-ui/src/App"), {
  ssr: false,
});

export default function HomeClient() {
  return (
    <ErrorBoundary>
      <ToastsProvider>
        <MinimalistApp />
      </ToastsProvider>
    </ErrorBoundary>
  );
}
