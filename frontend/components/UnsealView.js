import React from 'react';

export default function UnsealView({ status, onUnseal }) {
  const handleUnseal = async (e) => {
    e.preventDefault();
    onUnseal(e.target.password.value);
  };

  return (
    <div style={{
      display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh',
      fontFamily: 'var(--md-font)', background: 'var(--md-background)',
    }}>
      <div style={{
        background: 'var(--md-surface-container)', padding: '40px',
        borderRadius: 'var(--md-radius-xl)',
        boxShadow: 'var(--md-elevation-3)', width: '400px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
          <div style={{
            width: '48px', height: '48px', borderRadius: 'var(--md-radius-lg)',
            background: 'var(--md-primary-container)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--md-on-primary-container)',
            fontWeight: 800, fontSize: '1.3rem',
          }}>
            D
          </div>
          <div>
            <h1 style={{ margin: 0, fontSize: '1.35rem', fontWeight: 700, color: 'var(--md-on-surface)', letterSpacing: '-0.02em' }}>
              {!status.authenticated ? 'Login Required' : 'Node Sealed'}
            </h1>
            <p style={{ color: 'var(--md-on-surface-variant)', margin: '4px 0 0 0', fontSize: '0.85rem' }}>
              {!status.authenticated && !status.sealed
                ? 'Your session has expired. Please log in with the master password.'
                : `Enter the master password to unseal node ${status.nodeName}.`}
            </p>
          </div>
        </div>

        <form onSubmit={handleUnseal}>
          <input name="password" type="password" placeholder="Master Password" required autoFocus
            style={{
              width: '100%', padding: '12px', marginBottom: '24px',
              borderRadius: 'var(--md-radius-md)', border: '1px solid var(--md-outline)',
              background: 'var(--md-surface)', color: 'var(--md-on-surface)',
              fontSize: '0.9rem', fontFamily: 'var(--md-font)', boxSizing: 'border-box',
            }} />
          <button type="submit" style={{
            width: '100%', padding: '14px', background: 'var(--md-primary)', color: 'var(--md-on-primary)',
            border: 'none', borderRadius: 'var(--md-radius-full)', fontWeight: 600, cursor: 'pointer',
            fontSize: '1rem', fontFamily: 'var(--md-font)',
          }}>
            {!status.authenticated && !status.sealed ? 'Login' : 'Unseal Node'}
          </button>
        </form>
        {status.initialized && (
          <p style={{ marginTop: '20px', fontSize: '0.75rem', color: 'var(--md-on-surface-variant)', textAlign: 'center' }}>
            Node ID: {status.nodeId}
          </p>
        )}
      </div>
    </div>
  );
}
