'use client';

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { initTheme, applyTheme, watchOSTheme } from './theme';

const ThemeContext = createContext(null);

export function useTheme() {
  return useContext(ThemeContext);
}

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState('light');

  useEffect(() => {
    const initial = initTheme();
    setThemeState(initial);
    return watchOSTheme((mode) => setThemeState(mode));
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState(prev => {
      const next = prev === 'light' ? 'dark' : 'light';
      applyTheme(next);
      return next;
    });
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}
