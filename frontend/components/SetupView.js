import React, { useState } from 'react';

export default function SetupView({ onSetup }) {
  const [setupMode, setSetupMode] = useState('create'); // 'create', 'join', 'restore'

  const handleSetup = async (e) => {
    e.preventDefault();
    if (setupMode === 'create') {
      onSetup({
        mode: 'create',
        password: e.target.password.value,
        backupPath: e.target.backupPath.value,
        nonBackupPath: e.target.nonBackupPath.value
      });
    } else if (setupMode === 'join') {
      onSetup({
        mode: 'join',
        primaryIp: e.target.primaryIp.value,
        joinToken: e.target.joinToken.value,
        backupPath: e.target.backupPath.value,
        nonBackupPath: e.target.nonBackupPath.value
      });
    } else if (setupMode === 'restore') {
      onSetup({
        mode: 'restore',
        password: e.target.password.value,
        snapshotFile: e.target.snapshotFile.files[0],
        backupPath: e.target.backupPath.value,
        nonBackupPath: e.target.nonBackupPath.value
      });
    }
  };

  const activeStyle = { background: '#eff6ff', border: '1px solid #3b82f6' };
  const inactiveStyle = { background: '#f8fafc', border: '1px solid #e2e8f0', cursor: 'pointer' };

  return (
    <div style={{ 
      display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', 
      fontFamily: 'sans-serif', background: '#f1f5f9' 
    }}>
      <div style={{ 
        background: '#fff', padding: '40px', borderRadius: '12px', 
        boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)', width: '450px' 
      }}>
        <h1 style={{ marginTop: 0 }}>🚀 System Setup</h1>
        <p style={{ color: '#64748b', marginBottom: '24px' }}>
          Select how you want to initialize this node.
        </p>

        <div style={{ display: 'flex', gap: '10px', marginBottom: '24px' }}>
          <div 
            onClick={() => setSetupMode('create')}
            style={{ flex: 1, padding: '10px', textAlign: 'center', borderRadius: '6px', ...(setupMode === 'create' ? activeStyle : inactiveStyle) }}>
            <strong>Create</strong>
            <div style={{ fontSize: '0.8em', color: '#64748b' }}>New Cluster</div>
          </div>
          <div 
            onClick={() => setSetupMode('join')}
            style={{ flex: 1, padding: '10px', textAlign: 'center', borderRadius: '6px', ...(setupMode === 'join' ? activeStyle : inactiveStyle) }}>
            <strong>Join</strong>
            <div style={{ fontSize: '0.8em', color: '#64748b' }}>Existing Cluster</div>
          </div>
          <div 
            onClick={() => setSetupMode('restore')}
            style={{ flex: 1, padding: '10px', textAlign: 'center', borderRadius: '6px', ...(setupMode === 'restore' ? activeStyle : inactiveStyle) }}>
            <strong>Restore</strong>
            <div style={{ fontSize: '0.8em', color: '#64748b' }}>From Backup</div>
          </div>
        </div>

        <form onSubmit={handleSetup}>
          {setupMode === 'create' && (
            <>
              <label style={{ display: 'block', marginBottom: '8px', fontSize: '0.9em', color: '#475569' }}>Master Password</label>
              <input 
                name="password" type="password" placeholder="Master Password" required autoFocus
                style={{ 
                  width: '100%', padding: '12px', marginBottom: '20px', borderRadius: '6px', 
                  border: '1px solid #e2e8f0', boxSizing: 'border-box' 
                }} 
              />
            </>
          )}

          {setupMode === 'join' && (
            <>
              <label style={{ display: 'block', marginBottom: '8px', fontSize: '0.9em', color: '#475569' }}>Primary Node IP</label>
              <input 
                name="primaryIp" type="text" placeholder="192.168.1.100" required autoFocus
                style={{ 
                  width: '100%', padding: '12px', marginBottom: '20px', borderRadius: '6px', 
                  border: '1px solid #e2e8f0', boxSizing: 'border-box' 
                }} 
              />
              <label style={{ display: 'block', marginBottom: '8px', fontSize: '0.9em', color: '#475569' }}>Cluster Join Token</label>
              <input 
                name="joinToken" type="text" placeholder="Token" required
                style={{ 
                  width: '100%', padding: '12px', marginBottom: '20px', borderRadius: '6px', 
                  border: '1px solid #e2e8f0', boxSizing: 'border-box' 
                }} 
              />
            </>
          )}

          {setupMode === 'restore' && (
            <>
              <label style={{ display: 'block', marginBottom: '8px', fontSize: '0.9em', color: '#475569' }}>ETCD Snapshot File (.snapshot)</label>
              <input 
                name="snapshotFile" type="file" accept=".snapshot" required
                style={{ 
                  width: '100%', padding: '12px', marginBottom: '20px', borderRadius: '6px', 
                  border: '1px solid #e2e8f0', boxSizing: 'border-box' 
                }} 
              />
              <label style={{ display: 'block', marginBottom: '8px', fontSize: '0.9em', color: '#475569' }}>Original Master Password</label>
              <input 
                name="password" type="password" placeholder="Password used when cluster was created" required
                style={{ 
                  width: '100%', padding: '12px', marginBottom: '20px', borderRadius: '6px', 
                  border: '1px solid #e2e8f0', boxSizing: 'border-box' 
                }} 
              />
            </>
          )}

          <hr style={{ border: 'none', borderTop: '1px solid #e2e8f0', margin: '20px 0' }} />

          <label style={{ display: 'block', marginBottom: '8px', fontSize: '0.9em', color: '#475569' }}>Backup Storage Location</label>
          <input 
            name="backupPath" type="text" defaultValue="/data/backup" required
            style={{ 
              width: '100%', padding: '12px', marginBottom: '20px', borderRadius: '6px', 
              border: '1px solid #e2e8f0', boxSizing: 'border-box' 
            }} 
          />
          <label style={{ display: 'block', marginBottom: '8px', fontSize: '0.9em', color: '#475569' }}>Non-Backup Storage Location</label>
          <input 
            name="nonBackupPath" type="text" defaultValue="/data/non-backup" required
            style={{ 
              width: '100%', padding: '12px', marginBottom: '20px', borderRadius: '6px', 
              border: '1px solid #e2e8f0', boxSizing: 'border-box' 
            }} 
          />

          <button
            type="submit"
            style={{
              width: '100%', padding: '12px', background: '#3b82f6', color: '#fff',
              border: 'none', borderRadius: '6px', fontWeight: 'bold', cursor: 'pointer'
            }}
          >
            {setupMode === 'create' && 'Initialize New Cluster'}
            {setupMode === 'join' && 'Join Cluster'}
            {setupMode === 'restore' && 'Restore Cluster'}
          </button>
        </form>
      </div>
    </div>
  );
}
