'use client';

import React, { createContext, useContext, useEffect, ReactNode } from 'react';
import { ensureAuthListener } from '@/lib/auth';

/**
 * The app is dark-only (design audit P0-2 / P2-17). This provider keeps its
 * original API for compatibility, but `isDark` is always true and
 * `toggleTheme` is a no-op. Nothing is persisted.
 */
interface ThemeContextProps {
  isDark: boolean;
  toggleTheme: () => void;
}

const DARK_ONLY: ThemeContextProps = { isDark: true, toggleTheme: () => {} };
const ThemeContext = createContext<ThemeContextProps | undefined>(undefined);

export const ThemeProvider = ({ children }: { children: ReactNode }) => {
  useEffect(() => {
    ensureAuthListener();
  }, []);

  return <ThemeContext.Provider value={DARK_ONLY}>{children}</ThemeContext.Provider>;
};

export const useTheme = (): ThemeContextProps => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};
