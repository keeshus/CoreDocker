import React, { useState, useEffect } from 'react';
import { Trash2, Pencil } from 'lucide-react';
import { validatePasswordChange } from '../lib/domain-logic';
import { useUI } from '../lib/UIProvider';

export default function ClusterSettings() {
  const { showToast, showConfirm } = useUI();
  const [settings, setSettings] = useState({ dnsVip: '', dnsVipInterface: '', dnsForwarder: '', sshUser: 'coredocker', resticS3Endpoint: '', resticS3Bucket: '' });
  const [credentials, setCredentials] = useState({ 'cert-domain': '', 'cert-cloudflare-token': '', 'restic-password': '', 'restic-access-key': '', 'restic-secret-key': '' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Cluster Nodes State
  const [nodes, setNodes] = useState([]);
  const [etcdStatus, setEtcdStatus] = useState({ nodes: [], members: [], allVoting: false });
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
    try {
      const res = await fetch('/api/nodes/etcd-status');
      const data = await res.json();
      if (data && data.nodes) setEtcdStatus(data);
    } catch (e) {
      console.error('Failed to fetch etcd status:', e);
    }
  };

  useEffect(() => {
    fetch('/api/settings')
      .then(res => res.json())
      .then(data => {
        if (data && typeof data === 'object') {
          const { clusterDomain, ...rest } = data;
          setSettings(prev => ({ ...prev, ...rest }));
        }
        // Load credential values (if node is unsealed)
        fetch('/api/secrets/bulk-read', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ keys: ['__system__/cert-domain', '__system__/cert-cloudflare-token', '__system__/restic-password', '__system__/restic-access-key', '__system__/restic-secret-key'] })
        })
          .then(res => res.json())
          .then(data => {
            if (data && typeof data === 'object') {
              // Map prefixed keys back to short names for the UI
              const mapped = {};
              for (const [k, v] of Object.entries(data)) {
                const shortKey = k.replace('__system__/', '');
                mapped[shortKey] = v;
              }
              setCredentials(prev => ({ ...prev, ...mapped }));
            }
          })
          .catch(() => { /* node may be sealed */ });
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
      // Save non-sensitive settings
      const settingsRes = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });
      if (!settingsRes.ok) {
        const error = await settingsRes.json();
        showToast('Error saving settings: ' + JSON.stringify(error), 'error');
        setSaving(false);
        return;
      }

      // Save credentials via secrets API (uses __system__ prefix so they're hidden from Secrets tab)
      const credFields = [
        { key: '__system__/cert-domain', value: credentials['cert-domain'] },
        { key: '__system__/cert-cloudflare-token', value: credentials['cert-cloudflare-token'] },
        { key: '__system__/restic-password', value: credentials['restic-password'] },
        { key: '__system__/restic-access-key', value: credentials['restic-access-key'] },
        { key: '__system__/restic-secret-key', value: credentials['restic-secret-key'] },
      ];

      let allOk = true;
      for (const { key, value } of credFields) {
        if (!value) continue;
        const res = await fetch('/api/secrets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key, value })
        });
        if (!res.ok) allOk = false;
      }

      showToast(allOk ? 'Settings saved successfully!' : 'Settings saved but some credentials failed', allOk ? 'success' : 'error');
    } catch (e) {
      showToast('Error saving settings: ' + e.message, 'error');
    }
    setSaving(false);
  };

  const handleDeleteNode = async (id) => {
    const confirmed = await showConfirm('Are you sure you want to remove this node?');
    if (!confirmed) return;
    try {
      const res = await fetch(`/api/nodes/${id}`, { method: 'DELETE' });
      if (res.ok) fetchNodes();
    } catch (e) {
      console.error(e);
    }
  };

  const handleChangePassword = async (e) => {
    e.preventDefault();
    const validation = validatePasswordChange(passwords);
    if (!validation.valid) {
      showToast(validation.error, 'error');
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
        showToast('Master password updated successfully!', 'success');
        setPasswords({ current: '', next: '', confirm: '' });
      } else {
        const error = await res.json();
        showToast('Error: ' + error.error, 'error');
      }
    } catch (e) {
      showToast('Error changing password: ' + e.message, 'error');
    }
    setIsChangingPassword(false);
  };

  const [renamingNode, setRenamingNode] = useState(null);
  const [renameValue, setRenameValue] = useState('');

  const handleRenameNode = async (id) => {
    if (!renameValue.trim()) { setRenamingNode(null); return; }
    try {
      const res = await fetch(`/api/nodes/${id}/rename`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: renameValue.trim() }),
      });
      if (res.ok) {
        fetchNodes();
        showToast('Node renamed.', 'success');
      } else {
        const err = await res.json();
        showToast('Error: ' + err.error, 'error');
      }
    } catch (e) {
      console.error(e);
    }
    setRenamingNode(null);
    setRenameValue('');
  };

  const [dekPassword, setDekPassword] = useState('');
  const [showDekPrompt, setShowDekPrompt] = useState(false);

  const handleRotateDEK = async () => {
    setShowDekPrompt(true);
  };

  const confirmRotateDEK = async () => {
    if (!dekPassword) return;
    setShowDekPrompt(false);
    setIsRotating(true);
    try {
      const res = await fetch('/api/system/rotate-dek', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ masterPassword: dekPassword })
      });
      if (res.ok) {
        showToast('Data Encryption Key rotated successfully! All data has been re-encrypted.', 'success');
        setDekPassword('');
      } else {
        const error = await res.json();
        showToast('Error: ' + error.error, 'error');
      }
    } catch (e) {
      showToast('Error rotating DEK: ' + e.message, 'error');
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
          <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '8px' }}>DNS VIP Interface</label>
          <input
            type="text"
            value={settings.dnsVipInterface}
            onChange={e => setSettings({...settings, dnsVipInterface: e.target.value})}
            placeholder="e.g. eth0 (leave empty for auto-detect)"
            style={{ width: '100%', padding: '10px', border: '1px solid #cbd5e1', borderRadius: '4px', boxSizing: 'border-box' }}
          />
          <small style={{ color: '#64748b', display: 'block', marginTop: '4px' }}>Physical interface for the DNS VIP (auto-detected from node IP if left empty).</small>
        </div>

        <div>
          <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '8px' }}>DNS Upstream Forwarder</label>
          <input
            type="text"
            value={settings.dnsForwarder}
            onChange={e => setSettings({...settings, dnsForwarder: e.target.value})}
            placeholder="e.g. 192.168.1.1 (your router/gateway)"
            style={{ width: '100%', padding: '10px', border: '1px solid #cbd5e1', borderRadius: '4px', boxSizing: 'border-box' }}
          />
          <small style={{ color: '#64748b', display: 'block', marginTop: '4px' }}>Upstream DNS server CoreDNS forwards unresolved queries to.</small>
        </div>

        <div>
          <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '8px' }}>Shared DNS VIP Address</label>
          <input
            type="text"
            value={settings.dnsVip}
            onChange={e => setSettings({...settings, dnsVip: e.target.value})}
            placeholder="e.g. 10.0.0.53"
            style={{ width: '100%', padding: '10px', border: '1px solid #cbd5e1', borderRadius: '4px', boxSizing: 'border-box' }}
          />
          <small style={{ color: '#64748b', display: 'block', marginTop: '4px' }}>Static IP used by your router for DNS. Managed via Keepalived on up to 3 nodes.</small>
        </div>

        <div style={{ paddingTop: '10px', borderTop: '2px solid #e2e8f0' }}>
          <h3 style={{ fontSize: '1.1em', margin: '0 0 10px 0', color: '#1e293b' }}>SSH & Sync</h3>
          <div>
            <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '8px' }}>SSH User (for HA rsync)</label>
            <input
              type="text"
              value={settings.sshUser}
              onChange={e => setSettings({...settings, sshUser: e.target.value})}
              placeholder="e.g. coredocker"
              style={{ width: '100%', padding: '10px', border: '1px solid #cbd5e1', borderRadius: '4px', boxSizing: 'border-box' }}
            />
            <small style={{ color: '#64748b', display: 'block', marginTop: '4px' }}>Non-root SSH user for HA folder sync across nodes. The user's ~/.ssh/authorized_keys is managed automatically.</small>
          </div>
        </div>

        <div style={{ paddingTop: '10px', borderTop: '2px solid #e2e8f0' }}>
          <h3 style={{ fontSize: '1.1em', margin: '0 0 10px 0', color: '#1e293b' }}>Restic S3 Backup</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
            <div>
              <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '8px' }}>S3 Endpoint</label>
              <input
                type="text"
                value={settings.resticS3Endpoint}
                onChange={e => setSettings({...settings, resticS3Endpoint: e.target.value})}
                placeholder="e.g. s3.eu-central-1.wasabisys.com"
                style={{ width: '100%', padding: '10px', border: '1px solid #cbd5e1', borderRadius: '4px', boxSizing: 'border-box' }}
              />
            </div>
            <div>
              <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '8px' }}>S3 Bucket</label>
              <input
                type="text"
                value={settings.resticS3Bucket}
                onChange={e => setSettings({...settings, resticS3Bucket: e.target.value})}
                placeholder="e.g. my-backup-bucket"
                style={{ width: '100%', padding: '10px', border: '1px solid #cbd5e1', borderRadius: '4px', boxSizing: 'border-box' }}
              />
            </div>
          </div>
          <small style={{ color: '#64748b', display: 'block', marginTop: '4px' }}>Repository URL will be: s3:https://ENDPOINT/BUCKET</small>

          <div style={{ marginTop: '15px', padding: '12px', background: '#f1f5f9', borderRadius: '6px' }}>
            <p style={{ color: '#475569', fontSize: '0.85em', margin: '0 0 12px 0', fontWeight: 'bold' }}>Credentials (stored as encrypted secrets)</p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '15px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.85em', fontWeight: 'bold', marginBottom: '8px' }}>Repository Password</label>
                <input
                  type="password"
                  value={credentials['restic-password']}
                  onChange={e => setCredentials({...credentials, 'restic-password': e.target.value})}
                  placeholder="Restic encryption password"
                  style={{ width: '100%', padding: '10px', border: '1px solid #cbd5e1', borderRadius: '4px', boxSizing: 'border-box' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.85em', fontWeight: 'bold', marginBottom: '8px' }}>S3 Access Key</label>
                <input
                  type="password"
                  value={credentials['restic-access-key']}
                  onChange={e => setCredentials({...credentials, 'restic-access-key': e.target.value})}
                  placeholder="S3 access key"
                  style={{ width: '100%', padding: '10px', border: '1px solid #cbd5e1', borderRadius: '4px', boxSizing: 'border-box' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.85em', fontWeight: 'bold', marginBottom: '8px' }}>S3 Secret Key</label>
                <input
                  type="password"
                  value={credentials['restic-secret-key']}
                  onChange={e => setCredentials({...credentials, 'restic-secret-key': e.target.value})}
                  placeholder="S3 secret key"
                  style={{ width: '100%', padding: '10px', border: '1px solid #cbd5e1', borderRadius: '4px', boxSizing: 'border-box' }}
                />
              </div>
            </div>
          </div>
        </div>

        <div style={{ paddingTop: '10px', borderTop: '2px solid #e2e8f0' }}>
          <h3 style={{ fontSize: '1.1em', margin: '0 0 10px 0', color: '#1e293b' }}>TLS Certificates (Let's Encrypt)</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
            <div>
              <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '8px' }}>Domain</label>
              <input
                type="text"
                value={credentials['cert-domain']}
                onChange={e => setCredentials({...credentials, 'cert-domain': e.target.value})}
                placeholder="e.g. example.com"
                style={{ width: '100%', padding: '10px', border: '1px solid #cbd5e1', borderRadius: '4px', boxSizing: 'border-box' }}
              />
              <small style={{ color: '#64748b', display: 'block', marginTop: '4px' }}>Stored as encrypted secret.</small>
            </div>
            <div>
              <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '8px' }}>Cloudflare API Token (DNS-01)</label>
              <input
                type="password"
                value={credentials['cert-cloudflare-token']}
                onChange={e => setCredentials({...credentials, 'cert-cloudflare-token': e.target.value})}
                placeholder="Cloudflare API token"
                style={{ width: '100%', padding: '10px', border: '1px solid #cbd5e1', borderRadius: '4px', boxSizing: 'border-box' }}
              />
              <small style={{ color: '#64748b', display: 'block', marginTop: '4px' }}>Stored as encrypted secret.</small>
            </div>
          </div>
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
        <p style={{ color: '#64748b', fontSize: '0.9em' }}>Nodes register automatically during setup. Rename or remove them here.</p>

        <table style={{ width: '100%', borderCollapse: 'collapse', background: 'white', borderRadius: '8px', overflow: 'hidden', border: '1px solid #e2e8f0', marginTop: '15px' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '2px solid #e2e8f0', color: '#64748b', fontSize: '0.9em', background: '#f8fafc' }}>
              <th style={{ padding: '12px 10px' }}>Name</th>
              <th style={{ padding: '12px 10px' }}>IP Address</th>
              <th style={{ padding: '12px 10px' }}>Status</th>
              <th style={{ padding: '12px 10px' }}>etcd</th>
              <th style={{ padding: '12px 10px' }}>Services</th>
              <th style={{ padding: '12px 10px' }}>Security</th>
              <th style={{ padding: '12px 10px', textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loadingNodes ? (
              <tr><td colSpan="7" style={{ padding: '15px 10px', textAlign: 'center', color: '#64748b' }}>Loading nodes...</td></tr>
            ) : nodes.length === 0 ? (
              <tr><td colSpan="7" style={{ padding: '15px 10px', textAlign: 'center', color: '#64748b' }}>No nodes registered.</td></tr>
            ) : nodes.map(node => {
              const etcdInfo = etcdStatus.nodes.find(n => n.id === node.id)?.etcd || {};
              const isLearner = etcdInfo.isLearner;
              const allVoting = etcdStatus.allVoting;
              return (
              <tr key={node.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                <td style={{ padding: '15px 10px', fontWeight: 'bold', color: '#1e293b' }}>
                  {renamingNode === node.id ? (
                    <input
                      value={renameValue}
                      onChange={e => setRenameValue(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleRenameNode(node.id); if (e.key === 'Escape') setRenamingNode(null); }}
                      onBlur={() => handleRenameNode(node.id)}
                      autoFocus
                      style={{ width: '120px', padding: '4px 8px', border: '1px solid #3b82f6', borderRadius: '4px' }}
                    />
                  ) : (
                    node.name
                  )}
                </td>
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
                  {isLearner === null ? (
                    <span style={{ color: '#94a3b8', fontSize: '0.85em' }}>—</span>
                  ) : isLearner ? (
                    <span style={{ color: '#d97706', fontSize: '0.85em', fontWeight: 'bold' }}>Learner</span>
                  ) : (
                    <span style={{ color: '#059669', fontSize: '0.85em', fontWeight: 'bold' }}>Voting</span>
                  )}
                </td>
                <td style={{ padding: '15px 10px' }}>
                  <span style={{
                    display: 'inline-block', width: '10px', height: '10px', borderRadius: '50%',
                    background: isLearner ? '#fbbf24' : '#34d399',
                    marginRight: '6px', verticalAlign: 'middle'
                  }} />
                  <span style={{ fontSize: '0.85em', color: '#64748b' }}>
                    {allVoting ? 'All Healthy' : 'Pending...'}
                  </span>
                </td>
                <td style={{ padding: '15px 10px' }}>
                  {!node.sealed ? (
                    <span style={{ color: '#059669', fontSize: '0.9em', display: 'flex', alignItems: 'center', gap: '4px' }}>
                      🔓 Unsealed
                    </span>
                  ) : (
                    <a
                      href={`https://${node.name}.core-docker.local`}
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
                    onClick={() => { setRenamingNode(node.id); setRenameValue(node.name); }}
                    style={{ background: 'none', border: 'none', color: '#3b82f6', cursor: 'pointer', marginRight: '8px' }}
                    title="Rename Node"
                  >
                    <Pencil size={18} />
                  </button>
                  <button
                    onClick={() => handleDeleteNode(node.id)}
                    style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer' }}
                    title="Remove Node"
                  >
                    <Trash2 size={18} />
                  </button>
                </td>
              </tr>
            );
          })}
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
                style={{ width: '100%', padding: '8px', border: '1px solid #cbd5e1', borderRadius: '4px', boxSizing: 'border-box' }}
                required
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.8em', fontWeight: 'bold', marginBottom: '4px' }}>New Password</label>
              <input 
                type="password" 
                value={passwords.next} 
                onChange={e => setPasswords({...passwords, next: e.target.value})}
                style={{ width: '100%', padding: '8px', border: '1px solid #cbd5e1', borderRadius: '4px', boxSizing: 'border-box' }}
                required
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.8em', fontWeight: 'bold', marginBottom: '4px' }}>Confirm New Password</label>
              <input 
                type="password" 
                value={passwords.confirm} 
                onChange={e => setPasswords({...passwords, confirm: e.target.value})}
                style={{ width: '100%', padding: '8px', border: '1px solid #cbd5e1', borderRadius: '4px', boxSizing: 'border-box' }}
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

      {showDekPrompt && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)', zIndex: 2000,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            background: 'white', padding: '24px', borderRadius: '8px',
            maxWidth: '400px', width: '90%', boxShadow: '0 4px 20px rgba(0,0,0,0.2)',
          }}>
            <h4 style={{ margin: '0 0 10px 0', color: '#dc2626' }}>Rotate Data Encryption Key</h4>
            <p style={{ fontSize: '0.9em', color: '#64748b', marginBottom: '15px' }}>
              This will re-encrypt all cluster data. Enter your Master Password to authorize.
            </p>
            <input
              type="password"
              value={dekPassword}
              onChange={e => setDekPassword(e.target.value)}
              placeholder="Master Password"
              style={{ width: '100%', padding: '10px', border: '1px solid #cbd5e1', borderRadius: '4px', boxSizing: 'border-box', marginBottom: '15px', boxSizing: 'border-box' }}
              autoFocus
            />
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
              <button
                onClick={() => { setShowDekPrompt(false); setDekPassword(''); }}
                style={{ padding: '8px 20px', background: '#f1f5f9', color: '#475569', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}
              >
                Cancel
              </button>
              <button
                onClick={confirmRotateDEK}
                disabled={!dekPassword}
                style={{ padding: '8px 20px', background: '#dc2626', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}
              >
                Rotate
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
