export const metadata = {
  title: 'Docker Manager',
  description: 'CoreDocker - Docker Container Management Platform',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" data-theme="light">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200"
          rel="stylesheet"
        />
        <style>{`
  :root {
    --md-font: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    --md-font-mono: 'JetBrains Mono', 'Fira Code', monospace;
    --md-font-icons: 'Material Symbols Outlined';

    --md-surface: #f9f9ff;
    --md-surface-container: #eeedf4;
    --md-surface-container-high: #e8e7ef;
    --md-surface-container-highest: #e2e2e9;
    --md-surface-container-low: #f3f3fa;
    --md-surface-container-lowest: #ffffff;
    --md-surface-bright: #f9f9ff;
    --md-surface-dim: #d9d9e0;
    --md-background: #f9f9ff;
    --md-on-surface: #1a1b20;
    --md-on-surface-variant: #44474f;
    --md-on-background: #1a1b20;
    --md-primary: #445e91;
    --md-on-primary: #ffffff;
    --md-primary-container: #d8e2ff;
    --md-on-primary-container: #2b4678;
    --md-primary-fixed: #d8e2ff;
    --md-primary-fixed-dim: #adc6ff;
    --md-secondary: #575e71;
    --md-on-secondary: #ffffff;
    --md-secondary-container: #dbe2f9;
    --md-on-secondary-container: #3f4759;
    --md-error: #ba1a1a;
    --md-on-error: #ffffff;
    --md-error-container: #ffdad6;
    --md-on-error-container: #93000a;
    --md-outline: #75777f;
    --md-outline-variant: #c4c6d0;
    --md-tertiary: #715573;
    --md-on-tertiary: #ffffff;
    --md-shadow: #000000;
    --md-scrim: #000000;
    --md-inverse-surface: #2f3036;
    --md-inverse-on-surface: #f0f0f7;
    --md-inverse-primary: #adc6ff;

    --md-success: #2e7d32;
    --md-success-container: #c8e6c9;
    --md-on-success-container: #1b5e20;
    --md-warning: #e65100;
    --md-warning-container: #ffe0b2;
    --md-on-warning-container: #bf360c;

    --md-status-running: #2563eb;
    --md-status-running-bg: #dbeafe;
    --md-status-failed: #dc2626;
    --md-status-failed-bg: #fee2e2;
    --md-status-success: #059669;
    --md-status-success-bg: #d1fae5;
    --md-status-idle: #64748b;
    --md-status-idle-bg: #f1f5f9;
    --md-status-paused: #ef4444;
    --md-status-paused-bg: #fef2f2;

    --md-radius-sm: 4px;
    --md-radius-md: 8px;
    --md-radius-lg: 12px;
    --md-radius-xl: 16px;
    --md-radius-full: 9999px;

    --md-shadow-sm: 0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.06);
    --md-shadow-md: 0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1);
    --md-shadow-lg: 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1);

    --md-elevation-1: 0 1px 3px 1px rgba(0,0,0,0.15), 0 1px 2px rgba(0,0,0,0.3);
    --md-elevation-2: 0 2px 6px 2px rgba(0,0,0,0.15), 0 1px 2px rgba(0,0,0,0.3);
    --md-elevation-3: 0 4px 8px 3px rgba(0,0,0,0.15), 0 1px 3px rgba(0,0,0,0.3);
    --md-elevation-4: 0 6px 10px 4px rgba(0,0,0,0.15), 0 2px 3px rgba(0,0,0,0.3);
    --md-elevation-5: 0 8px 12px 6px rgba(0,0,0,0.15), 0 4px 4px rgba(0,0,0,0.3);

    --md-transition: 200ms cubic-bezier(0.2, 0, 0, 1);
    --md-transition-spring: 350ms cubic-bezier(0.34, 1.56, 0.64, 1);
  }

  [data-theme="dark"] {
    --md-surface: #111318;
    --md-surface-container: #1e1f25;
    --md-surface-container-high: #282a2f;
    --md-surface-container-highest: #33353a;
    --md-surface-container-low: #1a1b20;
    --md-surface-container-lowest: #0c0e13;
    --md-surface-bright: #37393e;
    --md-surface-dim: #111318;
    --md-background: #111318;
    --md-on-surface: #e2e2e9;
    --md-on-surface-variant: #c4c6d0;
    --md-on-background: #e2e2e9;
    --md-primary: #adc6ff;
    --md-on-primary: #112f60;
    --md-primary-container: #2b4678;
    --md-on-primary-container: #d8e2ff;
    --md-primary-fixed: #d8e2ff;
    --md-primary-fixed-dim: #adc6ff;
    --md-secondary: #bfc6dc;
    --md-on-secondary: #293041;
    --md-secondary-container: #3f4759;
    --md-on-secondary-container: #dbe2f9;
    --md-error: #ffb4ab;
    --md-on-error: #690005;
    --md-error-container: #93000a;
    --md-on-error-container: #ffdad6;
    --md-outline: #8e9099;
    --md-outline-variant: #44474f;
    --md-tertiary: #debcdf;
    --md-on-tertiary: #402843;
    --md-shadow: #000000;
    --md-scrim: #000000;
    --md-inverse-surface: #e2e2e9;
    --md-inverse-on-surface: #2f3036;
    --md-inverse-primary: #445e91;

    --md-success: #66bb6a;
    --md-success-container: #2e7d32;
    --md-on-success-container: #c8e6c9;
    --md-warning: #ffa726;
    --md-warning-container: #e65100;
    --md-on-warning-container: #ffe0b2;

    --md-shadow-sm: 0 1px 3px rgba(0,0,0,0.3), 0 1px 2px rgba(0,0,0,0.2);
    --md-shadow-md: 0 4px 6px -1px rgba(0,0,0,0.4), 0 2px 4px -2px rgba(0,0,0,0.3);
    --md-shadow-lg: 0 10px 15px -3px rgba(0,0,0,0.4), 0 4px 6px -4px rgba(0,0,0,0.3);

    --md-elevation-1: 0 1px 3px 1px rgba(0,0,0,0.3), 0 1px 2px rgba(0,0,0,0.4);
    --md-elevation-2: 0 2px 6px 2px rgba(0,0,0,0.3), 0 1px 2px rgba(0,0,0,0.4);
    --md-elevation-3: 0 4px 8px 3px rgba(0,0,0,0.3), 0 1px 3px rgba(0,0,0,0.4);
  }
`}</style>
      </head>
      <body style={{ margin: 0, fontFamily: 'var(--md-font)', background: 'var(--md-background)', color: 'var(--md-on-background)', transition: 'background var(--md-transition), color var(--md-transition)' }}>
        {children}
      </body>
    </html>
  );
}
