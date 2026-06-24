import React from 'react';
import { useTheme } from '../lib/ThemeProvider';

export default function AppLayout({ children, activeTab, setActiveTab, info, onRefresh }) {
  const { theme, toggleTheme } = useTheme();

  const tabs = [
    { id: 'containers', label: 'Containers' },
    { id: 'secrets', label: 'Secrets' },
    { id: 'tasks', label: 'Scheduler & Tasks' },
    { id: 'cluster-settings', label: 'Cluster Settings' },
    { id: 'node-settings', label: 'Node Settings' },
  ];

  return (
    <div style={{
      padding: '0', fontFamily: 'var(--md-font)',
      maxWidth: '1440px', margin: '0 auto',
      background: 'var(--md-background)',
      minHeight: '100vh',
      transition: 'background var(--md-transition)',
    }}>
      <header style={{
        background: 'var(--md-surface-container)',
        borderBottom: '1px solid var(--md-outline-variant)',
        position: 'sticky', top: 0, zIndex: 100,
        backdropFilter: 'blur(12px)',
        transition: 'background var(--md-transition)',
      }}>
        <div style={{
          maxWidth: '1440px', margin: '0 auto',
          padding: '12px 24px',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{
              width: '40px', height: '40px', borderRadius: 'var(--md-radius-md)',
              background: 'var(--md-primary-container)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--md-on-primary-container)',
              fontWeight: 800, fontSize: '1.1rem',
            }}>
              D
            </div>
            <h1 style={{
              margin: 0, fontSize: '1.35rem', fontWeight: 700,
              color: 'var(--md-on-surface)',
              letterSpacing: '-0.02em',
            }}>
              Docker Manager
            </h1>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            {info && (
              <div style={{
                display: 'flex', gap: '16px', fontSize: '0.8rem',
                background: 'var(--md-surface)', padding: '6px 16px',
                borderRadius: 'var(--md-radius-full)',
                border: '1px solid var(--md-outline-variant)',
                color: 'var(--md-on-surface-variant)',
              }}>
                <span><strong>OS:</strong> {info.OperatingSystem}</span>
                <span><strong>Kernel:</strong> {info.KernelVersion}</span>
                <span><strong>Containers:</strong> {info.Containers} (Run: {info.ContainersRunning})</span>
                <span><strong>CPUs:</strong> {info.NCPU}</span>
              </div>
            )}

            <button
              onClick={toggleTheme}
              title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
              style={{
                width: '40px', height: '40px', borderRadius: 'var(--md-radius-full)',
                border: '1px solid var(--md-outline-variant)',
                background: 'var(--md-surface)',
                color: 'var(--md-on-surface-variant)',
                cursor: 'pointer', display: 'flex', alignItems: 'center',
                justifyContent: 'center', fontSize: '1.25rem',
                transition: 'all var(--md-transition)',
              }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: '1.25rem' }}>
                {theme === 'light' ? 'dark_mode' : 'light_mode'}
              </span>
            </button>

            <button
              onClick={onRefresh}
              title="Refresh data"
              style={{
                width: '40px', height: '40px', borderRadius: 'var(--md-radius-full)',
                border: '1px solid var(--md-outline-variant)',
                background: 'var(--md-surface)',
                color: 'var(--md-on-surface-variant)',
                cursor: 'pointer', display: 'flex', alignItems: 'center',
                justifyContent: 'center', fontSize: '1.25rem',
              }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: '1.25rem' }}>
                refresh
              </span>
            </button>

            <button
              onClick={async () => {
                await fetch('/api/system/logout', { method: 'POST' });
                window.location.reload();
              }}
              style={{
                padding: '8px 20px',
                borderRadius: 'var(--md-radius-full)',
                border: '1px solid var(--md-error)',
                background: 'transparent',
                color: 'var(--md-error)',
                cursor: 'pointer', fontSize: '0.85rem', fontWeight: 600,
                display: 'flex', alignItems: 'center', gap: '6px',
                fontFamily: 'var(--md-font)',
              }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: '1.1rem' }}>logout</span>
              Logout
            </button>
          </div>
        </div>

        <div style={{
          maxWidth: '1440px', margin: '0 auto',
          padding: '0 24px',
          display: 'flex', gap: '4px',
        }}>
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                padding: '10px 20px',
                background: 'none',
                color: activeTab === tab.id ? 'var(--md-primary)' : 'var(--md-on-surface-variant)',
                border: 'none',
                borderBottom: activeTab === tab.id ? '2px solid var(--md-primary)' : '2px solid transparent',
                cursor: 'pointer', fontWeight: activeTab === tab.id ? 600 : 400,
                fontSize: '0.9rem',
                transition: 'all var(--md-transition)',
                fontFamily: 'var(--md-font)',
                marginBottom: '-1px',
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </header>

      <main style={{ padding: '24px' }}>
        {children}
      </main>
    </div>
  );
}
