import React, { useState, useEffect } from 'react';
import { Lock, Plus, Trash2, Key } from 'lucide-react';

export default function SecretsTab() {
  const [secrets, setSecrets] = useState([]);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [loading, setLoading] = useState(true);

  const fetchSecrets = async () => {
    try {
      const res = await fetch('/api/secrets');
      const data = await res.json();
      setSecrets(data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSecrets();
  }, []);

  const handleAddSecret = async (e) => {
    e.preventDefault();
    if (!newKey || !newValue) return;
    
    try {
      const res = await fetch('/api/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: newKey, value: newValue }),
      });
      if (res.ok) {
        setNewKey('');
        setNewValue('');
        fetchSecrets();
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleDeleteSecret = async (key) => {
    try {
      const res = await fetch(`/api/secrets/${key}`, { method: 'DELETE' });
      if (res.ok) fetchSecrets();
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <section>
      <div style={{ padding: '15px', background: '#f8fafc', borderRadius: '8px', border: '1px solid #e2e8f0', marginBottom: '30px' }}>
        <h2 style={{ marginTop: 0, fontSize: '1.2em', display: 'flex', alignItems: 'center', gap: '8px', color: '#1e293b' }}>
          <Key size={20} /> Add New Secret
        </h2>
        <form onSubmit={handleAddSecret} style={{ display: 'flex', gap: '15px', alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}>
            <label style={{ display: 'block', fontSize: '0.85em', color: '#64748b', marginBottom: '8px', fontWeight: 'bold', textTransform: 'uppercase' }}>Secret Key</label>
            <input
              type="text"
              value={newKey}
              onChange={e => setNewKey(e.target.value)}
              placeholder="e.g. CLOUDFLARE_API_KEY"
              style={{ width: '100%', padding: '10px', borderRadius: '4px', border: '1px solid #cbd5e1', outline: 'none' }}
              required
            />
          </div>
          <div style={{ flex: 1 }}>
            <label style={{ display: 'block', fontSize: '0.85em', color: '#64748b', marginBottom: '8px', fontWeight: 'bold', textTransform: 'uppercase' }}>Secret Value</label>
            <input
              type="password"
              value={newValue}
              onChange={e => setNewValue(e.target.value)}
              placeholder="Enter secure value"
              style={{ width: '100%', padding: '10px', borderRadius: '4px', border: '1px solid #cbd5e1', outline: 'none' }}
              required
            />
          </div>
          <button
            type="submit"
            style={{
              background: '#3b82f6', color: 'white', border: 'none', padding: '10px 20px',
              borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '8px'
            }}
          >
            <Plus size={18} /> Save Secret
          </button>
        </form>
      </div>

      <h2 style={{ fontSize: '1.5em' }}>Secret Manager</h2>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '2px solid #e2e8f0', color: '#64748b', fontSize: '0.9em' }}>
            <th style={{ padding: '12px 10px' }}>Secret Key</th>
            <th style={{ padding: '12px 10px', textAlign: 'right' }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr><td colSpan="2" style={{ padding: '15px 10px', textAlign: 'center', color: '#64748b' }}>Loading secrets...</td></tr>
          ) : secrets.length === 0 ? (
            <tr><td colSpan="2" style={{ padding: '15px 10px', textAlign: 'center', color: '#64748b' }}>No secrets found.</td></tr>
          ) : secrets.map(key => (
            <tr key={key} style={{ borderBottom: '1px solid #f1f5f9' }}>
              <td style={{ padding: '15px 10px', fontWeight: 'bold', color: '#1e293b' }}>{key}</td>
              <td style={{ padding: '15px 10px', textAlign: 'right' }}>
                <button
                  onClick={() => handleDeleteSecret(key)}
                  style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer' }}
                  title="Delete Secret"
                >
                  <Trash2 size={18} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}