import React from 'react';

export default function UnsealView({ status, onUnseal }) {
  const handleUnseal = async (e) => {
    e.preventDefault();
    onUnseal(e.target.password.value);
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
        <h1 style={{ marginTop: 0 }}>
          {!status.authenticated ? '🔑 Login Required' : '🔒 Node Sealed'}
        </h1>
        <p style={{ color: '#64748b', marginBottom: '24px' }}>
          {!status.authenticated && status.unsealed
            ? 'Your session has expired. Please log in with the master password.'
            : `Enter the master password to unseal node ${status.nodeName}.`}
        </p>
        <form onSubmit={handleUnseal}>
          <input 
            name="password" type="password" placeholder="Master Password" required autoFocus
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
            {!status.authenticated && status.unsealed ? 'Login' : 'Unseal Node'}
          </button>
        </form>
        {status.initialized && (
          <p style={{ marginTop: '20px', fontSize: '0.8em', color: '#94a3b8', textAlign: 'center' }}>
            Node ID: {status.nodeId}
          </p>
        )}
      </div>
    </div>
  );
}
