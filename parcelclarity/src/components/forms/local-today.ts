"use client";

import { useSyncExternalStore } from "react";

/** Today's date in the browser's local calendar; the server renders an empty value to avoid a hydration mismatch (and a UTC date that is already tomorrow for a US evening). */
function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const subscribeNever = () => () => {};
export const useLocalToday = () => useSyncExternalStore(subscribeNever, localToday, () => "");
