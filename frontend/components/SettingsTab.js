import React, { useState, useEffect } from 'react';
import ContainerRow from './ContainerRow';

export default function SettingsTab({ systemContainers = [], stats = {} }) {
  const [settings, setSettings] = useState({ sharedIpPool: '', backhaulNetwork: '', dnsVip: '' });
  const [expandedContainer, setExpandedContainer] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch('/api/settings')
      .then(res => res.json())
      .then(data => {
        if (data && typeof data === 'object') {
          setSettings(prev => ({ ...prev, ...data }));
        }
        setLoading(false);
      })
      .catch(e => {
        console.error('Failed to load settings:', e);
        setLoading(false);
      });
  }, []);

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });
      if (res.ok) {
        alert('Settings saved successfully!');
      } else {
        const error = await res.json();
        alert('Error saving settings: ' + JSON.stringify(error));
      }
    } catch (e) {
      alert('Error saving settings: ' + e.message);
    }
    setSaving(false);
  };

  if (loading) return <div>Loading settings...</div>;

  return (
    <div style={{ background: '#f8fafc', padding: '20px', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
      <h2 style={{ marginTop: 0 }}>Cluster Settings</h2>
      <p style={{ color: '#64748b' }}>Configure Master Node and Cluster-wide settings.</p>

      <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '600px', marginTop: '20px' }}>
        <div>
          <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '8px' }}>Shared Virtual IP (VIP) Pool</label>
          <input 
            type="text" 
            value={settings.sharedIpPool} 
            onChange={e => setSettings({...settings, sharedIpPool: e.target.value})}
            placeholder="e.g. 192.168.1.200-192.168.1.210"
            style={{ width: '100%', padding: '10px', border: '1px solid #cbd5e1', borderRadius: '4px' }}
          />
          <small style={{ color: '#64748b', display: 'block', marginTop: '4px' }}>Range of IP addresses managed by KeepaliveD for High Availability.</small>
        </div>

        <div>
          <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '8px' }}>Backhaul Network Interface / IP Range</label>
          <input 
            type="text" 
            value={settings.backhaulNetwork} 
            onChange={e => setSettings({...settings, backhaulNetwork: e.target.value})}
            placeholder="e.g. eth1 or 10.0.0.0/24"
            style={{ width: '100%', padding: '10px', border: '1px solid #cbd5e1', borderRadius: '4px' }}
          />
          <small style={{ color: '#64748b', display: 'block', marginTop: '4px' }}>Dedicated network for internal cluster traffic (ETCD, Sync).</small>
        </div>

        <div>
          <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '8px' }}>Shared DNS VIP Address</label>
          <input 
            type="text" 
            value={settings.dnsVip} 
            onChange={e => setSettings({...settings, dnsVip: e.target.value})}
            placeholder="e.g. 10.0.0.53"
            style={{ width: '100%', padding: '10px', border: '1px solid #cbd5e1', borderRadius: '4px' }}
          />
          <small style={{ color: '#64748b', display: 'block', marginTop: '4px' }}>Static IP used by your router for DNS. Managed via Keepalived on up to 3 nodes.</small>
        </div>

        <button 
          type="submit" 
          disabled={saving}
          style={{ padding: '10px 20px', background: '#3b82f6', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold', width: 'fit-content' }}
        >
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
      </form>

      <div style={{ marginTop: '40px', paddingTop: '20px', borderTop: '1px solid #e2e8f0' }}>
        <h3 style={{ marginTop: 0 }}>System Containers</h3>
        <p style={{ color: '#64748b', fontSize: '0.9em' }}>Monitor core application containers here.</p>
        
        {systemContainers.length > 0 ? (
          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '15px' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '2px solid #e2e8f0', color: '#64748b', fontSize: '0.9em' }}>
                <th style={{ padding: '12px 10px' }}>Name</th>
                <th style={{ padding: '12px 10px' }}>Image</th>
                <th style={{ padding: '12px 10px' }}>State</th>
                <th style={{ padding: '12px 10px' }}>CPU %</th>
                <th style={{ padding: '12px 10px' }}>Memory</th>
                <th style={{ padding: '12px 10px' }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {systemContainers.map(c => (
                <ContainerRow
                  key={c.Id}
                  container={c}
                  stats={stats[c.Id]}
                  isExpanded={expandedContainer === c.Id}
                  onToggle={() => setExpandedContainer(expandedContainer === c.Id ? null : c.Id)}
                  onEdit={() => {}}
                  onPersist={() => {}}
                  isSystem={true}
                />
              ))}
            </tbody>
          </table>
        ) : (
          <p style={{ color: '#94a3b8' }}>No system containers found.</p>
        )}
      </div>
    </div>
  );
}
