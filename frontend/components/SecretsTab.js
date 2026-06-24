import React, { useState, useEffect } from 'react';

export default function SecretsTab() {
  const [secrets, setSecrets] = useState([]);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [loading, setLoading] = useState(true);
  const [editingKey, setEditingKey] = useState(null);
  const [editValue, setEditValue] = useState('');

  const fetchSecrets = async () => {
    try {
      const res = await fetch('/api/secrets');
      if (res.ok) { const data = await res.json(); setSecrets(data); }
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetchSecrets(); }, []);

  const handleAddSecret = async (e) => {
    e.preventDefault();
    if (!newKey || !newValue) return;
    try {
      const res = await fetch('/api/secrets', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: newKey, value: newValue }),
      });
      if (res.ok) { setNewKey(''); setNewValue(''); fetchSecrets(); }
    } catch (e) { console.error(e); }
  };

  const handleDeleteSecret = async (key) => {
    try { const res = await fetch(`/api/secrets/${key}`, { method: 'DELETE' }); if (res.ok) fetchSecrets(); }
    catch (e) { console.error(e); }
  };

  const handleEditSecret = (key) => { setEditingKey(key); setEditValue(''); };

  const handleUpdateSecret = async (key) => {
    if (!editValue) return;
    try {
      const res = await fetch(`/api/secrets/${key}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: editValue }),
      });
      if (res.ok) { setEditingKey(null); setEditValue(''); fetchSecrets(); }
    } catch (e) { console.error(e); }
  };

  const inputStyle = {
    width: '100%', padding: '10px 12px', borderRadius: 'var(--md-radius-sm)',
    border: '1px solid var(--md-outline)', background: 'var(--md-surface)',
    color: 'var(--md-on-surface)', fontSize: '0.9rem', fontFamily: 'var(--md-font)',
    outline: 'none', boxSizing: 'border-box',
  };

  return (
    <section>
      <div style={{
        padding: '16px', background: 'var(--md-surface-container)',
        borderRadius: 'var(--md-radius-lg)', border: '1px solid var(--md-outline-variant)',
        marginBottom: '30px',
      }}>
        <h2 style={{
          marginTop: 0, fontSize: '1.1rem', fontWeight: 600, display: 'flex',
          alignItems: 'center', gap: '8px', color: 'var(--md-on-surface)',
        }}>
          <span className="material-symbols-outlined" style={{ fontSize: '1.3rem', color: 'var(--md-primary)' }}>key</span>
          Add New Secret
        </h2>
        <form onSubmit={handleAddSecret} style={{ display: 'flex', gap: '15px', alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}>
            <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--md-on-surface-variant)', marginBottom: '6px', fontWeight: 600, textTransform: 'uppercase' }}>Secret Key</label>
            <input type="text" value={newKey} onChange={e => setNewKey(e.target.value)} placeholder="e.g. CLOUDFLARE_API_KEY" style={inputStyle} required />
          </div>
          <div style={{ flex: 1 }}>
            <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--md-on-surface-variant)', marginBottom: '6px', fontWeight: 600, textTransform: 'uppercase' }}>Secret Value</label>
            <input type="password" value={newValue} onChange={e => setNewValue(e.target.value)} placeholder="Enter secure value" style={inputStyle} required />
          </div>
          <button type="submit" style={{
            padding: '10px 24px', background: 'var(--md-primary)', color: 'var(--md-on-primary)',
            border: 'none', borderRadius: 'var(--md-radius-full)', cursor: 'pointer',
            fontWeight: 600, fontSize: '0.875rem', fontFamily: 'var(--md-font)',
            display: 'flex', alignItems: 'center', gap: '8px',
          }}>
            <span className="material-symbols-outlined" style={{ fontSize: '1.2rem' }}>add</span>
            Save Secret
          </button>
        </form>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <h2 style={{ fontSize: '1.35rem', fontWeight: 600, color: 'var(--md-on-surface)', margin: 0 }}>Secret Manager</h2>
      </div>

      <table style={{
        width: '100%', borderCollapse: 'collapse',
        background: 'var(--md-surface-container)', borderRadius: 'var(--md-radius-lg)',
        overflow: 'hidden', border: '1px solid var(--md-outline-variant)',
      }}>
        <thead>
          <tr style={{
            textAlign: 'left', borderBottom: '1px solid var(--md-outline-variant)',
            color: 'var(--md-on-surface-variant)', fontSize: '0.8rem', fontWeight: 600,
            background: 'var(--md-surface)',
          }}>
            <th style={{ padding: '12px 16px' }}>Secret Key</th>
            <th style={{ padding: '12px 16px', textAlign: 'right' }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr><td colSpan="2" style={{ padding: '16px', textAlign: 'center', color: 'var(--md-on-surface-variant)' }}>Loading secrets...</td></tr>
          ) : secrets.length === 0 ? (
            <tr><td colSpan="2" style={{ padding: '16px', textAlign: 'center', color: 'var(--md-on-surface-variant)' }}>No secrets found.</td></tr>
          ) : secrets.map(key => (
            <tr key={key} style={{ borderBottom: '1px solid var(--md-outline-variant)' }}>
              <td style={{ padding: '14px 16px', fontWeight: 500, color: 'var(--md-on-surface)' }}>
                {editingKey === key ? (
                  <input type="password" value={editValue} onChange={e => setEditValue(e.target.value)}
                    placeholder="New value" style={{ width: '80%', padding: '8px 12px', borderRadius: 'var(--md-radius-sm)', border: '1px solid var(--md-outline)', background: 'var(--md-surface)', color: 'var(--md-on-surface)' }}
                    autoFocus />
                ) : key}
              </td>
              <td style={{ padding: '14px 16px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                {editingKey === key ? (
                  <>
                    <button onClick={() => handleUpdateSecret(key)} style={{
                      padding: '6px 16px', background: 'var(--md-primary)', color: 'var(--md-on-primary)',
                      border: 'none', borderRadius: 'var(--md-radius-full)', cursor: 'pointer',
                      fontWeight: 600, fontSize: '0.8rem', marginRight: '8px', fontFamily: 'var(--md-font)',
                    }}>Save</button>
                    <button onClick={() => setEditingKey(null)} style={{
                      background: 'none', border: 'none', color: 'var(--md-on-surface-variant)',
                      cursor: 'pointer', padding: '6px', fontWeight: 500, fontFamily: 'var(--md-font)',
                    }}>Cancel</button>
                  </>
                ) : (
                  <>
                    <button onClick={() => handleEditSecret(key)} style={{
                      background: 'none', border: 'none', color: 'var(--md-primary)',
                      cursor: 'pointer', marginRight: '12px', verticalAlign: 'middle',
                    }} title="Edit Secret">
                      <span className="material-symbols-outlined" style={{ fontSize: '1.25rem' }}>edit</span>
                    </button>
                    <button onClick={() => handleDeleteSecret(key)} style={{
                      background: 'none', border: 'none', color: 'var(--md-error)',
                      cursor: 'pointer', verticalAlign: 'middle',
                    }} title="Delete Secret">
                      <span className="material-symbols-outlined" style={{ fontSize: '1.25rem' }}>delete</span>
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
