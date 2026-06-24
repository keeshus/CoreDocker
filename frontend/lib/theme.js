const lightVars = {
  '--md-surface': '#f9f9ff',
  '--md-surface-container': '#eeedf4',
  '--md-surface-container-high': '#e8e7ef',
  '--md-surface-container-highest': '#e2e2e9',
  '--md-surface-container-low': '#f3f3fa',
  '--md-surface-container-lowest': '#ffffff',
  '--md-surface-bright': '#f9f9ff',
  '--md-surface-dim': '#d9d9e0',
  '--md-background': '#f9f9ff',
  '--md-on-surface': '#1a1b20',
  '--md-on-surface-variant': '#44474f',
  '--md-on-background': '#1a1b20',
  '--md-primary': '#445e91',
  '--md-on-primary': '#ffffff',
  '--md-primary-container': '#d8e2ff',
  '--md-on-primary-container': '#2b4678',
  '--md-primary-fixed': '#d8e2ff',
  '--md-primary-fixed-dim': '#adc6ff',
  '--md-secondary': '#575e71',
  '--md-on-secondary': '#ffffff',
  '--md-secondary-container': '#dbe2f9',
  '--md-on-secondary-container': '#3f4759',
  '--md-error': '#ba1a1a',
  '--md-on-error': '#ffffff',
  '--md-error-container': '#ffdad6',
  '--md-on-error-container': '#93000a',
  '--md-outline': '#75777f',
  '--md-outline-variant': '#c4c6d0',
  '--md-tertiary': '#715573',
  '--md-on-tertiary': '#ffffff',
  '--md-shadow': '#000000',
  '--md-scrim': '#000000',
  '--md-inverse-surface': '#2f3036',
  '--md-inverse-on-surface': '#f0f0f7',
  '--md-inverse-primary': '#adc6ff',
};

const darkVars = {
  '--md-surface': '#111318',
  '--md-surface-container': '#1e1f25',
  '--md-surface-container-high': '#282a2f',
  '--md-surface-container-highest': '#33353a',
  '--md-surface-container-low': '#1a1b20',
  '--md-surface-container-lowest': '#0c0e13',
  '--md-surface-bright': '#37393e',
  '--md-surface-dim': '#111318',
  '--md-background': '#111318',
  '--md-on-surface': '#e2e2e9',
  '--md-on-surface-variant': '#c4c6d0',
  '--md-on-background': '#e2e2e9',
  '--md-primary': '#adc6ff',
  '--md-on-primary': '#112f60',
  '--md-primary-container': '#2b4678',
  '--md-on-primary-container': '#d8e2ff',
  '--md-primary-fixed': '#d8e2ff',
  '--md-primary-fixed-dim': '#adc6ff',
  '--md-secondary': '#bfc6dc',
  '--md-on-secondary': '#293041',
  '--md-secondary-container': '#3f4759',
  '--md-on-secondary-container': '#dbe2f9',
  '--md-error': '#ffb4ab',
  '--md-on-error': '#690005',
  '--md-error-container': '#93000a',
  '--md-on-error-container': '#ffdad6',
  '--md-outline': '#8e9099',
  '--md-outline-variant': '#44474f',
  '--md-tertiary': '#debcdf',
  '--md-on-tertiary': '#402843',
  '--md-shadow': '#000000',
  '--md-scrim': '#000000',
  '--md-inverse-surface': '#e2e2e9',
  '--md-inverse-on-surface': '#2f3036',
  '--md-inverse-primary': '#445e91',
};

export const themeVars = { light: lightVars, dark: darkVars };

export function initTheme() {
  const saved = localStorage.getItem('md-theme');
  if (saved === 'light' || saved === 'dark') {
    applyTheme(saved);
    return saved;
  }
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const mode = prefersDark ? 'dark' : 'light';
  applyTheme(mode);
  return mode;
}

export function applyTheme(mode) {
  document.documentElement.setAttribute('data-theme', mode);
  localStorage.setItem('md-theme', mode);
}

export function watchOSTheme(onChange) {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = (e) => {
    const saved = localStorage.getItem('md-theme');
    if (!saved) {
      applyTheme(e.matches ? 'dark' : 'light');
      if (onChange) onChange(e.matches ? 'dark' : 'light');
    }
  };
  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
}
