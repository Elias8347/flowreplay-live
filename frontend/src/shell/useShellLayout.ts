import { useCallback, useEffect, useState } from 'react';

export type LayoutPreset = 'scalper' | 'review' | 'compact';

interface ShellLayout {
  preset: LayoutPreset;
  dockOpen: boolean;
  bottomOpen: boolean;
}

const STORAGE_KEY = 'flowreplay.shell.v1';
const COMPACT_BELOW = 1280;

const PRESETS: Record<LayoutPreset, ShellLayout> = {
  scalper: { preset: 'scalper', dockOpen: true, bottomOpen: false },
  review: { preset: 'review', dockOpen: true, bottomOpen: true },
  compact: { preset: 'compact', dockOpen: false, bottomOpen: false },
};

function readStored(): ShellLayout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ShellLayout>;
      if (parsed.preset && parsed.preset in PRESETS) return { ...PRESETS[parsed.preset], ...parsed } as ShellLayout;
    }
  } catch {
    // Storage can be unavailable or hold bad data; fall back to defaults
  }
  return PRESETS.scalper;
}

/** Layout preset, dock and bottom panel state, saved locally. Narrow screens are forced into Compact. */
export function useShellLayout() {
  const [layout, setLayout] = useState<ShellLayout>(readStored);
  const [narrow, setNarrow] = useState(() => window.innerWidth < COMPACT_BELOW);

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < COMPACT_BELOW);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
    } catch {
      // Ignore storage failures
    }
  }, [layout]);

  const applyPreset = useCallback((preset: LayoutPreset) => setLayout(PRESETS[preset]), []);
  const toggleDock = useCallback(() => setLayout((l) => ({ ...l, dockOpen: !l.dockOpen })), []);
  const toggleBottom = useCallback(() => setLayout((l) => ({ ...l, bottomOpen: !l.bottomOpen })), []);

  const effective: ShellLayout = narrow ? { ...layout, preset: 'compact', dockOpen: layout.preset === 'compact' ? layout.dockOpen : false } : layout;
  return { ...effective, narrow, applyPreset, toggleDock, toggleBottom };
}
