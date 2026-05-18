'use client';

import React, { createContext, useContext, useState, useCallback, useRef } from 'react';

const UIContext = createContext(null);

export function useUI() {
  return useContext(UIContext);
}

export function UIProvider({ children }) {
  const [toast, setToast] = useState(null);
  const [confirmState, setConfirmState] = useState(null);
  const confirmResolve = useRef(null);

  const showToast = useCallback((message, type = 'info') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  }, []);

  const showConfirm = useCallback((message) => {
    return new Promise((resolve) => {
      confirmResolve.current = resolve;
      setConfirmState({ message });
    });
  }, []);

  const handleConfirm = (result) => {
    setConfirmState(null);
    if (confirmResolve.current) {
      confirmResolve.current(result);
      confirmResolve.current = null;
    }
  };

  const toastStyle = {
    position: 'fixed',
    bottom: '20px',
    right: '20px',
    padding: '12px 24px',
    borderRadius: '8px',
    color: '#fff',
    fontWeight: 'bold',
    fontSize: '0.9em',
    zIndex: 2000,
    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
    transition: 'opacity 0.3s ease',
    background: toast?.type === 'error' ? '#ef4444' : toast?.type === 'success' ? '#10b981' : '#3b82f6',
  };

  return (
    <UIContext.Provider value={{ showToast, showConfirm }}>
      {children}
      {toast && (
        <div style={toastStyle} onClick={() => setToast(null)}>
          {toast.message}
        </div>
      )}
      {confirmState && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)', zIndex: 2000,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            background: 'white', padding: '24px', borderRadius: '8px',
            maxWidth: '400px', width: '90%', boxShadow: '0 4px 20px rgba(0,0,0,0.2)',
          }}>
            <p style={{ margin: '0 0 20px 0', fontSize: '1em', color: '#1e293b' }}>{confirmState.message}</p>
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
              <button
                onClick={() => handleConfirm(false)}
                style={{ padding: '8px 20px', background: '#f1f5f9', color: '#475569', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}
              >
                Cancel
              </button>
              <button
                onClick={() => handleConfirm(true)}
                style={{ padding: '8px 20px', background: '#ef4444', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </UIContext.Provider>
  );
}
