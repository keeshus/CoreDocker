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

  const bgMap = { error: 'var(--md-error)', success: 'var(--md-success)', info: 'var(--md-primary)' };

  return (
    <UIContext.Provider value={{ showToast, showConfirm }}>
      {children}
      {toast && (
        <div
          onClick={() => setToast(null)}
          style={{
            position: 'fixed', bottom: '24px', right: '24px',
            padding: '12px 24px', borderRadius: 'var(--md-radius-md)',
            background: bgMap[toast.type] || 'var(--md-primary)',
            color: 'var(--md-on-primary)',
            fontWeight: 500, fontSize: '0.9rem',
            zIndex: 2000,
            boxShadow: 'var(--md-elevation-3)',
            transition: 'opacity var(--md-transition)',
            cursor: 'pointer',
            fontFamily: 'var(--md-font)',
          }}
        >
          {toast.message}
        </div>
      )}
      {confirmState && (
        <div
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.5)', zIndex: 2000,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            backdropFilter: 'blur(4px)',
          }}
          onClick={() => handleConfirm(false)}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: 'var(--md-surface-container)',
              padding: '24px', borderRadius: 'var(--md-radius-xl)',
              maxWidth: '400px', width: '90%',
              boxShadow: 'var(--md-elevation-3)',
            }}
          >
            <p style={{ margin: '0 0 24px 0', fontSize: '1rem', color: 'var(--md-on-surface)' }}>
              {confirmState.message}
            </p>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
              <button
                onClick={() => handleConfirm(false)}
                style={{
                  padding: '10px 24px', background: 'transparent',
                  color: 'var(--md-on-surface-variant)',
                  border: '1px solid var(--md-outline)',
                  borderRadius: 'var(--md-radius-full)',
                  cursor: 'pointer', fontWeight: 500, fontSize: '0.875rem',
                  fontFamily: 'var(--md-font)',
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => handleConfirm(true)}
                style={{
                  padding: '10px 24px', background: 'var(--md-error)',
                  color: 'var(--md-on-error)',
                  border: 'none',
                  borderRadius: 'var(--md-radius-full)',
                  cursor: 'pointer', fontWeight: 500, fontSize: '0.875rem',
                  fontFamily: 'var(--md-font)',
                }}
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
