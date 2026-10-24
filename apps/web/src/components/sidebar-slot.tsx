"use client";

import { createContext, useContext } from "react";

export interface SidebarContextValue {
  /** Elemen DOM di sidebar tempat halaman dapat memasang isinya (mis. riwayat percakapan). */
  slot: HTMLElement | null;
  mobileOpen: boolean;
  setMobileOpen: (open: boolean) => void;
}

export const SidebarContext = createContext<SidebarContextValue>({
  slot: null,
  mobileOpen: false,
  setMobileOpen: () => undefined,
});

export function useSidebar(): SidebarContextValue {
  return useContext(SidebarContext);
}
