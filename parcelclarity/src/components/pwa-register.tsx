"use client";

import { useEffect } from "react";

/** Registers the minimal service worker (installability + offline notice only; see public/sw.js). */
export function PwaRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
    }
  }, []);
  return null;
}
