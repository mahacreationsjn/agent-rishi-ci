import { create } from "zustand";

interface FactoryGuideState {
  open: boolean;
  /** The section to show first (a heading anchor such as "the-merge-queue"), or the top. */
  section: string | null;
  /** Opens the guide, at `section` when given. */
  show: (section?: string) => void;
  hide: () => void;
}

/** The "How the factory loop works" sheet: one per window, opened from anywhere. Not persisted. */
export const useFactoryGuideStore = create<FactoryGuideState>()((set) => ({
  open: false,
  section: null,
  show: (section) => set({ open: true, section: section ?? null }),
  hide: () => set({ open: false }),
}));
