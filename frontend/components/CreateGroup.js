import React, { useState, useEffect } from 'react';
import { useUI } from '../lib/UIProvider';

export default function CreateGroup({ onCreated, initialData = null, onClose = null, isOpenMode = false }) {
  const { showToast } = useUI();
  const [isOpen, setIsOpen] = useState(isOpenMode);
  const [loading, setLoading] = useState(false);
  const defaultFormData = { name: '', config: { highAvailability: false, ha_allowed_nodes: [], internetAccess: false } };
  const [formData, setFormData] = useState(defaultFormData);
  const [nodes, setNodes] = useState([]);

  const fetchNodes = () =>
    fetch('/api/nodes').then(res => res.json()).then(data => setNodes(data || [])).catch(() => {});

  useEffect(() => { fetchNodes(); }, []);
  useEffect(() => { if (isOpen) fetchNodes(); }, [isOpen]);
  useEffect(() => {
    if (initialData) { setFormData({ name: initialData.name || '', config: initialData.config || {} }); setIsOpen(true); }
    else setFormData(defaultFormData);
  }, [initialData]);
  useEffect(() => { if (isOpenMode) setIsOpen(true); }, [isOpenMode]);

  const handleClose = () => { setIsOpen(false); if (onClose) onClose(); };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const url = initialData ? `/api/groups/${initialData.id}` : '/api/groups';
      const method = initialData ? 'PUT' : 'POST';
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(formData) });
      if (res.ok) { handleClose(); if (onCreated) onCreated(); }
      else { const error = await res.json(); showToast('Error: ' + JSON.stringify(error), 'error'); }
    } catch (err) { showToast('Error saving group: ' + err.message, 'error'); }
    setLoading(false);
  };

  return (
    <>
      {!initialData && !isOpenMode && (
        <button
          onClick={() => setIsOpen(true)}
          style={{
            padding: '10px 24px', background: 'var(--md-surface)', color: 'var(--md-primary)',
            border: '1px solid var(--md-primary)', borderRadius: 'var(--md-radius-full)',
            cursor: 'pointer', fontWeight: 600, fontSize: '0.9rem', fontFamily: 'var(--md-font)',
            display: 'flex', alignItems: 'center', gap: '8px',
          }}
        >
          <span className="material-symbols-outlined" style={{ fontSize: '1.2rem' }}>folder_add</span>
          Create Group
        </button>
      )}

      {isOpen && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)', zIndex: 1000,
          backdropFilter: 'blur(4px)',
        }}>
          <div style={{
            position: 'absolute', right: 0, top: 0, bottom: 0, width: '420px',
            background: 'var(--md-surface-container)', overflowY: 'auto',
            padding: '24px', boxShadow: 'var(--md-elevation-5)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
              <h2 style={{ margin: 0, color: 'var(--md-on-surface)', fontSize: '1.35rem', fontWeight: 600 }}>
                {initialData ? 'Edit Group' : 'Create Group'}
              </h2>
              <button onClick={handleClose} style={{
                background: 'none', border: 'none', fontSize: '1.5rem', cursor: 'pointer',
                color: 'var(--md-on-surface-variant)', width: '40px', height: '40px',
                borderRadius: 'var(--md-radius-full)', display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div>
                <label style={{ display: 'block', fontWeight: 500, marginBottom: '6px', fontSize: '0.85rem', color: 'var(--md-on-surface-variant)' }}>Group Name</label>
                <input required type="text" value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} style={{
                  width: '100%', padding: '10px 12px', border: '1px solid var(--md-outline)', borderRadius: 'var(--md-radius-sm)',
                  background: 'var(--md-surface)', color: 'var(--md-on-surface)', fontSize: '0.9rem', fontFamily: 'var(--md-font)', boxSizing: 'border-box',
                }} placeholder="web-stack" />
              </div>

              <div style={{
                padding: '12px', background: 'var(--md-surface)', borderRadius: 'var(--md-radius-md)',
                border: '1px solid var(--md-outline-variant)',
              }}>
                <label style={{ display: 'flex', alignItems: 'center', fontWeight: 500, cursor: 'pointer', gap: '8px' }}>
                  <input type="checkbox" checked={formData.config.internetAccess} onChange={e => setFormData({...formData, config: {...formData.config, internetAccess: e.target.checked}})} />
                  Internet connected
                </label>
                <p style={{ margin: '8px 0 0 26px', fontSize: '0.8rem', color: 'var(--md-on-surface-variant)' }}>
                  When unchecked, containers in this group share an isolated network without external internet access.
                </p>
              </div>

              <div style={{
                padding: '12px', background: 'var(--md-surface)', borderRadius: 'var(--md-radius-md)',
                border: '1px solid var(--md-outline-variant)',
              }}>
                <label style={{ display: 'flex', alignItems: 'center', fontWeight: 500, cursor: 'pointer', gap: '8px' }}>
                  <input type="checkbox" checked={formData.config.highAvailability} onChange={e => setFormData({...formData, config: {...formData.config, highAvailability: e.target.checked}})} />
                  High Availability
                </label>
                <p style={{ margin: '8px 0 0 26px', fontSize: '0.8rem', color: 'var(--md-on-surface-variant)' }}>
                  All containers in this group will be rescheduled to another node if their host fails.
                </p>

                {formData.config.highAvailability && (
                  <div style={{ marginLeft: '26px', marginTop: '10px' }}>
                    <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 500, marginBottom: '5px', color: 'var(--md-on-surface-variant)' }}>Allowed Nodes (optional)</label>
                    <div style={{
                      display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '150px', overflowY: 'auto',
                      padding: '8px', border: '1px solid var(--md-outline)', borderRadius: 'var(--md-radius-sm)',
                      background: 'var(--md-surface)',
                    }}>
                      {nodes.map(node => (
                        <label key={node.id} style={{ display: 'flex', alignItems: 'center', fontSize: '0.85rem', cursor: 'pointer', gap: '8px' }}>
                          <input type="checkbox" checked={(formData.config.ha_allowed_nodes || []).includes(node.id)}
                            onChange={e => {
                              const selected = [...(formData.config.ha_allowed_nodes || [])];
                              const newSelected = e.target.checked ? [...selected, node.id] : selected.filter(id => id !== node.id);
                              setFormData({...formData, config: {...formData.config, ha_allowed_nodes: newSelected}});
                            }}
                          />
                          <span style={{ color: 'var(--md-on-surface)' }}>{node.name} ({node.ip})</span>
                        </label>
                      ))}
                      {nodes.length === 0 && <span style={{ color: 'var(--md-on-surface-variant)', fontSize: '0.8rem' }}>No other nodes found</span>}
                    </div>
                  </div>
                )}
              </div>

              <button type="submit" disabled={loading} style={{
                padding: '14px 24px', background: 'var(--md-primary)', color: 'var(--md-on-primary)',
                border: 'none', borderRadius: 'var(--md-radius-full)', cursor: 'pointer',
                fontWeight: 600, fontSize: '1rem', fontFamily: 'var(--md-font)',
                marginTop: '8px', opacity: loading ? 0.7 : 1,
              }}>
                {loading ? 'Saving...' : (initialData ? 'Save Changes' : 'Create Group')}
              </button>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
