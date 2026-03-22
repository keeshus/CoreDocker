import React, { useState, useEffect } from 'react';
import { Settings, Plus, Trash2 } from 'lucide-react';

export default function ClusterSettings() {
  const [settings, setSettings] = useState({ sharedIpPool: '', backhaulNetwork: '', dnsVip: '' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Cluster Nodes State
  const [nodes, setNodes] = useState([]);
  const [newNodeName, setNewNodeName] = useState('');
  const [newNodeIp, setNewNodeIp] = useState('');
  const [newBackupPath, setNewBackupPath] = useState('/data/backup');
  const [newNonBackupPath, setNewNonBackupPath] = useState('/data/non-backup');
  const [loadingNodes, setLoadingNodes] = useState(true);

  // Security Form State
  const [passwords, setPasswords] = useState({ current: '', next: '', confirm: '' });
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [isRotating, setIsRotating] = useState(false);

  const fetchNodes = async () => {
    try {
      const res = await fetch('/api/nodes');
      const data = await res.json();
      setNodes(data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingNodes(false);
    }
  };

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
    fetchNodes();
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

  const handleAddNode = async (e) => {
    e.preventDefault();
    if (!newNodeName || !newNodeIp) return;
    
    try {
      const res = await fetch('/api/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newNodeName, ip: newNodeIp, backupPath: newBackupPath, nonBackupPath: newNonBackupPath }),
      });
      if (res.ok) {
        setNewNodeName('');
        setNewNodeIp('');
        setNewBackupPath('/data/backup');
        setNewNonBackupPath('/data/non-backup');
        fetchNodes();
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleDeleteNode = async (id) => {
    if (!window.confirm('Are you sure you want to remove this node?')) return;
    try {
      const res = await fetch(`/api/nodes/${id}`, { method: 'DELETE' });
      if (res.ok) fetchNodes();
    } catch (e) {
      console.error(e);
    }
  };

  const handleChangePassword = async (e) => {
    e.preventDefault();
    if (passwords.next !== passwords.confirm) {
      alert("New passwords don't match!");
      return;
    }
    setIsChangingPassword(true);
    try {
      const res = await fetch('/api/system/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentPassword: passwords.current,
          newPassword: passwords.next
        })
      });
      if (res.ok) {
        alert('Master password updated successfully!');
        setPasswords({ current: '', next: '', confirm: '' });
      } else {
        const error = await res.json();
        alert('Error: ' + error.error);
      }
    } catch (e) {
      alert('Error changing password: ' + e.message);
    }
    setIsChangingPassword(false);
  };

  const handleRotateDEK = async () => {
    const password = prompt("DANGER: This will re-encrypt all cluster data. Enter your Master Password to authorize DEK rotation:");
    if (!password) return;

    setIsRotating(true);
    try {
      const res = await fetch('/api/system/rotate-dek', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ masterPassword: password })
      });
      if (res.ok) {
        alert('Data Encryption Key rotated successfully! All data has been re-encrypted.');
      } else {
        const error = await res.json();
        alert('Error: ' + error.error);
      }
    } catch (e) {
      alert('Error rotating DEK: ' + e.message);
    }
    setIsRotating(false);
  };

  if (loading) return <div>Loading settings...</div>;

  return (
    <div style={{ background: '#f8fafc', padding: '20px', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
      <h2 style={{ marginTop: 0 }}>Cluster Settings</h2>
      <p style={{ color: '#64748b' }}>Configure Cluster-wide settings and manage cluster nodes.</p>

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
          {saving ? 'Saving...' : 'Save Cluster Settings'}
        </button>
      </form>

      <div style={{ marginTop: '40px', paddingTop: '20px', borderTop: '1px solid #e2e8f0' }}>
        <h3 style={{ marginTop: 0 }}>Cluster Nodes</h3>
        
        <div style={{ padding: '15px', background: 'white', borderRadius: '8px', border: '1px solid #e2e8f0', marginBottom: '20px' }}>
          <h4 style={{ marginTop: 0, fontSize: '1.1em', display: 'flex', alignItems: 'center', gap: '8px', color: '#1e293b' }}>
            <Settings size={18} /> Register New Node
          </h4>
          <form onSubmit={handleAddNode} style={{ display: 'flex', flexWrap: 'wrap', gap: '15px', alignItems: 'flex-end' }}>
            <div style={{ flex: '1 1 200px' }}>
              <label style={{ display: 'block', fontSize: '0.85em', color: '#64748b', marginBottom: '8px', fontWeight: 'bold', textTransform: 'uppercase' }}>Node Name</label>
              <input
                type="text"
                value={newNodeName}
                onChange={e => setNewNodeName(e.target.value)}
                placeholder="e.g. worker-01"
                style={{ width: '100%', padding: '10px', borderRadius: '4px', border: '1px solid #cbd5e1', outline: 'none' }}
                required
              />
            </div>
            <div style={{ flex: '1 1 200px' }}>
              <label style={{ display: 'block', fontSize: '0.85em', color: '#64748b', marginBottom: '8px', fontWeight: 'bold', textTransform: 'uppercase' }}>IP Address</label>
              <input
                type="text"
                value={newNodeIp}
                onChange={e => setNewNodeIp(e.target.value)}
                placeholder="e.g. 192.168.1.100"
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
              <Plus size={18} /> Add Node
            </button>
          </form>
        </div>

        <table style={{ width: '100%', borderCollapse: 'collapse', background: 'white', borderRadius: '8px', overflow: 'hidden', border: '1px solid #e2e8f0' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '2px solid #e2e8f0', color: '#64748b', fontSize: '0.9em', background: '#f8fafc' }}>
              <th style={{ padding: '12px 10px' }}>Name</th>
              <th style={{ padding: '12px 10px' }}>IP Address</th>
              <th style={{ padding: '12px 10px' }}>Status</th>
              <th style={{ padding: '12px 10px' }}>Security</th>
              <th style={{ padding: '12px 10px', textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loadingNodes ? (
              <tr><td colSpan="5" style={{ padding: '15px 10px', textAlign: 'center', color: '#64748b' }}>Loading nodes...</td></tr>
            ) : nodes.length === 0 ? (
              <tr><td colSpan="5" style={{ padding: '15px 10px', textAlign: 'center', color: '#64748b' }}>No nodes registered.</td></tr>
            ) : nodes.map(node => (
              <tr key={node.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                <td style={{ padding: '15px 10px', fontWeight: 'bold', color: '#1e293b' }}>{node.name}</td>
                <td style={{ padding: '15px 10px', color: '#64748b' }}>{node.ip}</td>
                <td style={{ padding: '15px 10px' }}>
                  <span style={{
                    display: 'inline-block', padding: '4px 8px', borderRadius: '12px', fontSize: '0.8em', fontWeight: 'bold',
                    background: node.status === 'online' ? '#d1fae5' : '#fee2e2',
                    color: node.status === 'online' ? '#059669' : '#dc2626'
                  }}>
                    {node.status.toUpperCase()}
                  </span>
                </td>
                <td style={{ padding: '15px 10px' }}>
                  {node.unsealed ? (
                    <span style={{ color: '#059669', fontSize: '0.9em', display: 'flex', alignItems: 'center', gap: '4px' }}>
                      🔓 Unsealed
                    </span>
                  ) : (
                    <a
                      href={`http://${node.id}.core-docker.local`}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        color: '#3b82f6', fontSize: '0.9em', textDecoration: 'none',
                        display: 'flex', alignItems: 'center', gap: '4px', fontWeight: 'bold'
                      }}
                    >
                      🔒 Sealed (Unseal)
                    </a>
                  )}
                </td>
                <td style={{ padding: '15px 10px', textAlign: 'right' }}>
                  <button
                    onClick={() => handleDeleteNode(node.id)}
                    style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer' }}
                    title="Remove Node"
                  >
                    <Trash2 size={18} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: '40px', padding: '20px', background: 'white', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
        <h3 style={{ marginTop: 0, color: '#1e293b' }}>Security</h3>
        <p style={{ color: '#64748b', fontSize: '0.9em' }}>Manage your master password and data encryption keys.</p>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '40px', marginTop: '20px' }}>
          {/* Change Password Form */}
          <form onSubmit={handleChangePassword} style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
            <h4 style={{ margin: 0 }}>Change Master Password</h4>
            
            <div>
              <label style={{ display: 'block', fontSize: '0.8em', fontWeight: 'bold', marginBottom: '4px' }}>Current Password</label>
              <input 
                type="password" 
                value={passwords.current} 
                onChange={e => setPasswords({...passwords, current: e.target.value})}
                style={{ width: '100%', padding: '8px', border: '1px solid #cbd5e1', borderRadius: '4px' }}
                required
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.8em', fontWeight: 'bold', marginBottom: '4px' }}>New Password</label>
              <input 
                type="password" 
                value={passwords.next} 
                onChange={e => setPasswords({...passwords, next: e.target.value})}
                style={{ width: '100%', padding: '8px', border: '1px solid #cbd5e1', borderRadius: '4px' }}
                required
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.8em', fontWeight: 'bold', marginBottom: '4px' }}>Confirm New Password</label>
              <input 
                type="password" 
                value={passwords.confirm} 
                onChange={e => setPasswords({...passwords, confirm: e.target.value})}
                style={{ width: '100%', padding: '8px', border: '1px solid #cbd5e1', borderRadius: '4px' }}
                required
              />
            </div>

            <button 
              type="submit" 
              disabled={isChangingPassword}
              style={{ padding: '8px 16px', background: '#1e293b', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold', width: 'fit-content' }}
            >
              {isChangingPassword ? 'Updating...' : 'Update Password'}
            </button>
          </form>

          {/* DEK Rotation */}
          <div style={{ padding: '15px', border: '1px solid #fee2e2', borderRadius: '8px', background: '#fff1f1' }}>
            <h4 style={{ margin: 0, color: '#991b1b' }}>Rotate Data Encryption Key (DEK)</h4>
            <p style={{ fontSize: '0.85em', color: '#b91c1c', margin: '10px 0' }}>
              <strong>Warning:</strong> This will re-encrypt all containers, tasks, and secrets with a brand new key. 
              If this process is interrupted, your cluster data may become permanently unreadable. 
              <strong>Take a backup first.</strong>
            </p>
            
            <button 
              onClick={handleRotateDEK}
              disabled={isRotating}
              style={{ 
                marginTop: '10px',
                padding: '10px 20px', 
                background: '#dc2626', 
                color: 'white', 
                border: 'none', 
                borderRadius: '4px', 
                cursor: 'pointer', 
                fontWeight: 'bold' 
              }}
            >
              {isRotating ? 'Rotating Keys...' : 'Rotate DEK Now'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
