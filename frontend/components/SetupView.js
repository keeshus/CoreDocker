import React from 'react';

export default function SetupView({ onSetup }) {
  const handleSetup = async (e) => {
    e.preventDefault();
    onSetup({
      password: e.target.password.value,
      backupPath: e.target.backupPath.value,
      nonBackupPath: e.target.nonBackupPath.value
    });
  };

  return (
    <div style={{ 
      display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', 
      fontFamily: 'sans-serif', background: '#f1f5f9' 
    }}>
      <div style={{ 
        background: '#fff', padding: '40px', borderRadius: '12px', 
        boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)', width: '400px' 
      }}>
        <h1 style={{ marginTop: 0 }}>🚀 System Setup</h1>
        <p style={{ color: '#64748b', marginBottom: '24px' }}>
          Initialize the system by setting a master password and storage locations.
        </p>
        <form onSubmit={handleSetup}>
          <label style={{ display: 'block', marginBottom: '8px', fontSize: '0.9em', color: '#475569' }}>Master Password</label>
          <input 
            name="password" type="password" placeholder="Master Password" required autoFocus
            style={{ 
              width: '100%', padding: '12px', marginBottom: '20px', borderRadius: '6px', 
              border: '1px solid #e2e8f0', boxSizing: 'border-box' 
            }} 
          />
          
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
            Initialize System
          </button>
        </form>
      </div>
    </div>
  );
}
