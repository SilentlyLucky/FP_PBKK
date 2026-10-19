"use client";

import { LocalSourceBrowser } from "@/components/local-source-browser";

export function LocalWorkspaceStatus() {
  return <LocalSourceBrowser onImported={async () => undefined} />;
}
