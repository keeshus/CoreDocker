import React, { useState } from 'react';

export default function SetupView({ onSetup }) {
  const [setupMode, setSetupMode] = useState('create');

  const handleSetup = async (e) => {
    e.preventDefault();
    if (setupMode === 'create') onSetup({ mode: 'create', password: e.target.password.value });
    else if (setupMode === 'join') onSetup({ mode: 'join', primaryIp: e.target.primaryIp.value, joinToken: e.target.password.value, password: e.target.password.value });
    else if (setupMode === 'restore') onSetup({ mode: 'restore', password: e.target.password.value, snapshotFile: e.target.snapshotFile.files[0] });
  };

  const modeBtn = (id, label, desc) => ({
    id, label, desc,
    style: setupMode === id
      ? { background: 'var(--md-primary-container)', border: '1px solid var(--md-primary)', color: 'var(--md-on-primary-container)' }
      : { background: 'var(--md-surface)', border: '1px solid var(--md-outline-variant)', color: 'var(--md-on-surface-variant)', cursor: 'pointer' },
  });

  const modes = [
    modeBtn('create', 'Create', 'New Cluster'),
    modeBtn('join', 'Join', 'Existing Cluster'),
    modeBtn('restore', 'Restore', 'From Backup'),
  ];

  return (
    <div style={{
      display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh',
      fontFamily: 'var(--md-font)', background: 'var(--md-background)',
    }}>
      <div style={{
        background: 'var(--md-surface-container)', padding: '40px',
        borderRadius: 'var(--md-radius-xl)',
        boxShadow: 'var(--md-elevation-3)', width: '450px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
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
            <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 700, color: 'var(--md-on-surface)', letterSpacing: '-0.02em' }}>
              System Setup
            </h1>
            <p style={{ color: 'var(--md-on-surface-variant)', margin: '2px 0 0 0', fontSize: '0.85rem' }}>
              Select how to initialize this node.
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '10px', marginBottom: '24px', marginTop: '24px' }}>
          {modes.map(m => (
            <div key={m.id} onClick={() => setSetupMode(m.id)}
              style={{ flex: 1, padding: '12px 8px', textAlign: 'center', borderRadius: 'var(--md-radius-md)', ...m.style, transition: 'all var(--md-transition)' }}>
              <div style={{ fontWeight: 700, fontSize: '0.9rem' }}>{m.label}</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--md-on-surface-variant)', marginTop: '4px' }}>{m.desc}</div>
            </div>
          ))}
        </div>

        <form onSubmit={handleSetup}>
          {setupMode === 'create' && (
            <>
              <label style={{ display: 'block', marginBottom: '6px', fontSize: '0.85rem', fontWeight: 500, color: 'var(--md-on-surface-variant)' }}>Master Password</label>
              <input name="password" type="password" placeholder="Master Password" required autoFocus
                style={{ width: '100%', padding: '12px', marginBottom: '20px', borderRadius: 'var(--md-radius-md)', border: '1px solid var(--md-outline)', background: 'var(--md-surface)', color: 'var(--md-on-surface)', fontSize: '0.9rem', fontFamily: 'var(--md-font)', boxSizing: 'border-box' }} />
            </>
          )}

          {setupMode === 'join' && (
            <>
              <label style={{ display: 'block', marginBottom: '6px', fontSize: '0.85rem', fontWeight: 500, color: 'var(--md-on-surface-variant)' }}>Primary Node Backhaul IP</label>
              <input name="primaryIp" type="text" placeholder="Backhaul IP of the primary node" required autoFocus
                style={{ width: '100%', padding: '12px', marginBottom: '6px', borderRadius: 'var(--md-radius-md)', border: '1px solid var(--md-outline)', background: 'var(--md-surface)', color: 'var(--md-on-surface)', fontSize: '0.9rem', fontFamily: 'var(--md-font)', boxSizing: 'border-box' }} />
              <p style={{ fontSize: '0.75rem', color: 'var(--md-on-surface-variant)', marginBottom: '20px' }}>Use the cluster-internal (backhaul) IP, not the public-facing IP.</p>
              <label style={{ display: 'block', marginBottom: '6px', fontSize: '0.85rem', fontWeight: 500, color: 'var(--md-on-surface-variant)' }}>Master Password</label>
              <input name="password" type="password" placeholder="Cluster master password" required
                style={{ width: '100%', padding: '12px', marginBottom: '20px', borderRadius: 'var(--md-radius-md)', border: '1px solid var(--md-outline)', background: 'var(--md-surface)', color: 'var(--md-on-surface)', fontSize: '0.9rem', fontFamily: 'var(--md-font)', boxSizing: 'border-box' }} />
            </>
          )}

          {setupMode === 'restore' && (
            <>
              <label style={{ display: 'block', marginBottom: '6px', fontSize: '0.85rem', fontWeight: 500, color: 'var(--md-on-surface-variant)' }}>ETCD Snapshot File (.snapshot)</label>
              <input name="snapshotFile" type="file" accept=".snapshot" required
                style={{ width: '100%', padding: '12px', marginBottom: '20px', borderRadius: 'var(--md-radius-md)', border: '1px solid var(--md-outline)', background: 'var(--md-surface)', color: 'var(--md-on-surface)', fontFamily: 'var(--md-font)', boxSizing: 'border-box' }} />
              <label style={{ display: 'block', marginBottom: '6px', fontSize: '0.85rem', fontWeight: 500, color: 'var(--md-on-surface-variant)' }}>Original Master Password</label>
              <input name="password" type="password" placeholder="Password used when cluster was created" required
                style={{ width: '100%', padding: '12px', marginBottom: '20px', borderRadius: 'var(--md-radius-md)', border: '1px solid var(--md-outline)', background: 'var(--md-surface)', color: 'var(--md-on-surface)', fontSize: '0.9rem', fontFamily: 'var(--md-font)', boxSizing: 'border-box' }} />
            </>
          )}

          <div style={{ borderTop: '1px solid var(--md-outline-variant)', margin: '20px 0', paddingTop: '20px' }}>
            <button type="submit" style={{
              width: '100%', padding: '14px', background: 'var(--md-primary)', color: 'var(--md-on-primary)',
              border: 'none', borderRadius: 'var(--md-radius-full)', fontWeight: 600, cursor: 'pointer',
              fontSize: '1rem', fontFamily: 'var(--md-font)',
            }}>
              {setupMode === 'create' && 'Initialize New Cluster'}
              {setupMode === 'join' && 'Join Cluster'}
              {setupMode === 'restore' && 'Restore Cluster'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
