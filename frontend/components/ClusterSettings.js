import React, { useState, useEffect } from 'react';
import { validatePasswordChange } from '../lib/domain-logic';
import { useUI } from '../lib/UIProvider';

export default function ClusterSettings() {
  const { showToast, showConfirm } = useUI();
  const [settings, setSettings] = useState({ dnsVip: '', dnsVipInterface: '', dnsForwarder: '', sshUser: 'coredocker', resticS3Endpoint: '', resticS3Bucket: '' });
  const [credentials, setCredentials] = useState({ 'cert-domain': '', 'cert-cloudflare-token': '', 'restic-password': '', 'restic-access-key': '', 'restic-secret-key': '' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [nodes, setNodes] = useState([]);
  const [etcdStatus, setEtcdStatus] = useState({ nodes: [], members: [], allVoting: false });
  const [loadingNodes, setLoadingNodes] = useState(true);
  const [passwords, setPasswords] = useState({ current: '', next: '', confirm: '' });
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [isRotating, setIsRotating] = useState(false);
  const [renamingNode, setRenamingNode] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [dekPassword, setDekPassword] = useState('');
  const [showDekPrompt, setShowDekPrompt] = useState(false);

  const fetchNodes = async () => {
    try {
      const res = await fetch('/api/nodes'); const data = await res.json(); setNodes(data);
    } catch (e) { console.error(e); } finally { setLoadingNodes(false); }
    try { const res = await fetch('/api/nodes/etcd-status'); const data = await res.json(); if (data && data.nodes) setEtcdStatus(data); }
    catch (e) { console.error('Failed to fetch etcd status:', e); }
  };

  useEffect(() => {
    fetch('/api/settings').then(res => res.json()).then(data => {
      if (data && typeof data === 'object') { const { clusterDomain, ...rest } = data; setSettings(prev => ({ ...prev, ...rest })); }
      fetch('/api/secrets/bulk-read', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: ['__system__/cert-domain', '__system__/cert-cloudflare-token', '__system__/restic-password', '__system__/restic-access-key', '__system__/restic-secret-key'] })
      }).then(res => res.json()).then(data => {
        if (data && typeof data === 'object') { const mapped = {}; for (const [k, v] of Object.entries(data)) { const shortKey = k.replace('__system__/', ''); mapped[shortKey] = v; } setCredentials(prev => ({ ...prev, ...mapped })); }
      }).catch(() => {});
      setLoading(false);
    }).catch(() => setLoading(false));
    fetchNodes();
  }, []);

  const handleSave = async (e) => {
    e.preventDefault(); setSaving(true);
    try {
      const settingsRes = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) });
      if (!settingsRes.ok) { const error = await settingsRes.json(); showToast('Error saving settings: ' + JSON.stringify(error), 'error'); setSaving(false); return; }
      const credFields = [
        { key: '__system__/cert-domain', value: credentials['cert-domain'] },
        { key: '__system__/cert-cloudflare-token', value: credentials['cert-cloudflare-token'] },
        { key: '__system__/restic-password', value: credentials['restic-password'] },
        { key: '__system__/restic-access-key', value: credentials['restic-access-key'] },
        { key: '__system__/restic-secret-key', value: credentials['restic-secret-key'] },
      ];
      let allOk = true;
      for (const { key, value } of credFields) { if (!value) continue; const res = await fetch('/api/secrets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, value }) }); if (!res.ok) allOk = false; }
      showToast(allOk ? 'Settings saved!' : 'Settings saved but some credentials failed', allOk ? 'success' : 'error');
    } catch (e) { showToast('Error saving settings: ' + e.message, 'error'); }
    setSaving(false);
  };

  const handleDeleteNode = async (id) => {
    const confirmed = await showConfirm('Are you sure you want to remove this node?');
    if (!confirmed) return;
    try { const res = await fetch(`/api/nodes/${id}`, { method: 'DELETE' }); if (res.ok) fetchNodes(); }
    catch (e) { console.error(e); }
  };

  const handleChangePassword = async (e) => {
    e.preventDefault(); const validation = validatePasswordChange(passwords);
    if (!validation.valid) { showToast(validation.error, 'error'); return; }
    setIsChangingPassword(true);
    try {
      const res = await fetch('/api/system/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: passwords.current, newPassword: passwords.next }) });
      if (res.ok) { showToast('Master password updated!', 'success'); setPasswords({ current: '', next: '', confirm: '' }); }
      else { const error = await res.json(); showToast('Error: ' + error.error, 'error'); }
    } catch (e) { showToast('Error changing password: ' + e.message, 'error'); }
    setIsChangingPassword(false);
  };

  const handleRenameNode = async (id) => {
    if (!renameValue.trim()) { setRenamingNode(null); return; }
    try {
      const res = await fetch(`/api/nodes/${id}/rename`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: renameValue.trim() }) });
      if (res.ok) { fetchNodes(); showToast('Node renamed.', 'success'); }
      else { const err = await res.json(); showToast('Error: ' + err.error, 'error'); }
    } catch (e) { console.error(e); }
    setRenamingNode(null); setRenameValue('');
  };

  const handleRotateDEK = () => setShowDekPrompt(true);

  const confirmRotateDEK = async () => {
    if (!dekPassword) return; setShowDekPrompt(false); setIsRotating(true);
    try {
      const res = await fetch('/api/system/rotate-dek', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ masterPassword: dekPassword }) });
      if (res.ok) { showToast('Data Encryption Key rotated successfully!', 'success'); setDekPassword(''); }
      else { const error = await res.json(); showToast('Error: ' + error.error, 'error'); }
    } catch (e) { showToast('Error rotating DEK: ' + e.message, 'error'); }
    setIsRotating(false);
  };

  const inputStyle = {
    width: '100%', padding: '10px 12px', borderRadius: 'var(--md-radius-sm)',
    border: '1px solid var(--md-outline)', background: 'var(--md-surface)',
    color: 'var(--md-on-surface)', fontSize: '0.9rem', fontFamily: 'var(--md-font)',
    boxSizing: 'border-box', outline: 'none',
  };

  if (loading) return <div style={{ padding: '20px', color: 'var(--md-on-surface-variant)' }}>Loading settings...</div>;

  return (
    <div>
      <h2 style={{ fontSize: '1.35rem', fontWeight: 600, color: 'var(--md-on-surface)', margin: '0 0 4px 0' }}>Cluster Settings</h2>
      <p style={{ color: 'var(--md-on-surface-variant)', fontSize: '0.9rem', margin: '0 0 24px 0' }}>Configure Cluster-wide settings and manage cluster nodes.</p>

      <form onSubmit={handleSave} style={{
        display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '600px',
        padding: '20px', background: 'var(--md-surface-container)', borderRadius: 'var(--md-radius-lg)',
        border: '1px solid var(--md-outline-variant)',
      }}>
        <div>
          <label style={{ display: 'block', fontWeight: 500, marginBottom: '6px', fontSize: '0.85rem', color: 'var(--md-on-surface-variant)' }}>DNS VIP Interface</label>
          <input type="text" value={settings.dnsVipInterface} onChange={e => setSettings({...settings, dnsVipInterface: e.target.value})} placeholder="e.g. eth0 (leave empty for auto-detect)" style={inputStyle} />
          <small style={{ color: 'var(--md-on-surface-variant)', display: 'block', marginTop: '4px' }}>Physical interface for the DNS VIP (auto-detected from node IP if left empty).</small>
        </div>
        <div>
          <label style={{ display: 'block', fontWeight: 500, marginBottom: '6px', fontSize: '0.85rem', color: 'var(--md-on-surface-variant)' }}>DNS Upstream Forwarder</label>
          <input type="text" value={settings.dnsForwarder} onChange={e => setSettings({...settings, dnsForwarder: e.target.value})} placeholder="e.g. 192.168.1.1 (your router/gateway)" style={inputStyle} />
          <small style={{ color: 'var(--md-on-surface-variant)', display: 'block', marginTop: '4px' }}>Upstream DNS server CoreDNS forwards unresolved queries to.</small>
        </div>
        <div>
          <label style={{ display: 'block', fontWeight: 500, marginBottom: '6px', fontSize: '0.85rem', color: 'var(--md-on-surface-variant)' }}>Shared DNS VIP Address</label>
          <input type="text" value={settings.dnsVip} onChange={e => setSettings({...settings, dnsVip: e.target.value})} placeholder="e.g. 10.0.0.53" style={inputStyle} />
          <small style={{ color: 'var(--md-on-surface-variant)', display: 'block', marginTop: '4px' }}>Static IP used by your router for DNS. Managed via Keepalived on up to 3 nodes.</small>
        </div>

        <div style={{ paddingTop: '12px', borderTop: '1px solid var(--md-outline-variant)' }}>
          <h3 style={{ fontSize: '1.1rem', fontWeight: 600, margin: '0 0 12px 0', color: 'var(--md-on-surface)' }}>SSH & Sync</h3>
          <input type="text" value={settings.sshUser} onChange={e => setSettings({...settings, sshUser: e.target.value})} placeholder="e.g. coredocker" style={inputStyle} />
          <small style={{ color: 'var(--md-on-surface-variant)', display: 'block', marginTop: '4px' }}>Non-root SSH user for HA folder sync across nodes.</small>
        </div>

        <div style={{ paddingTop: '12px', borderTop: '1px solid var(--md-outline-variant)' }}>
          <h3 style={{ fontSize: '1.1rem', fontWeight: 600, margin: '0 0 12px 0', color: 'var(--md-on-surface)' }}>Restic S3 Backup</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
            <div><input type="text" value={settings.resticS3Endpoint} onChange={e => setSettings({...settings, resticS3Endpoint: e.target.value})} placeholder="e.g. s3.eu-central-1.wasabisys.com" style={inputStyle} /></div>
            <div><input type="text" value={settings.resticS3Bucket} onChange={e => setSettings({...settings, resticS3Bucket: e.target.value})} placeholder="e.g. my-backup-bucket" style={inputStyle} /></div>
          </div>
          <small style={{ color: 'var(--md-on-surface-variant)', display: 'block', marginTop: '4px' }}>Repository URL will be: s3:https://ENDPOINT/BUCKET</small>
          <div style={{ marginTop: '15px', padding: '12px', background: 'var(--md-surface)', borderRadius: 'var(--md-radius-md)' }}>
            <p style={{ color: 'var(--md-on-surface-variant)', fontSize: '0.8rem', margin: '0 0 12px 0', fontWeight: 600 }}>Credentials (stored as encrypted secrets)</p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' }}>
              <div><input type="password" value={credentials['restic-password']} onChange={e => setCredentials({...credentials, 'restic-password': e.target.value})} placeholder="Repo password" style={inputStyle} /></div>
              <div><input type="password" value={credentials['restic-access-key']} onChange={e => setCredentials({...credentials, 'restic-access-key': e.target.value})} placeholder="S3 access key" style={inputStyle} /></div>
              <div><input type="password" value={credentials['restic-secret-key']} onChange={e => setCredentials({...credentials, 'restic-secret-key': e.target.value})} placeholder="S3 secret key" style={inputStyle} /></div>
            </div>
          </div>
        </div>

        <div style={{ paddingTop: '12px', borderTop: '1px solid var(--md-outline-variant)' }}>
          <h3 style={{ fontSize: '1.1rem', fontWeight: 600, margin: '0 0 12px 0', color: 'var(--md-on-surface)' }}>TLS Certificates (Let's Encrypt)</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
            <div><input type="text" value={credentials['cert-domain']} onChange={e => setCredentials({...credentials, 'cert-domain': e.target.value})} placeholder="e.g. example.com" style={inputStyle} /></div>
            <div><input type="password" value={credentials['cert-cloudflare-token']} onChange={e => setCredentials({...credentials, 'cert-cloudflare-token': e.target.value})} placeholder="Cloudflare API token" style={inputStyle} /></div>
          </div>
        </div>

        <button type="submit" disabled={saving} style={{
          padding: '10px 24px', background: 'var(--md-primary)', color: 'var(--md-on-primary)',
          border: 'none', borderRadius: 'var(--md-radius-full)', cursor: 'pointer',
          fontWeight: 600, fontSize: '0.9rem', fontFamily: 'var(--md-font)',
          width: 'fit-content', opacity: saving ? 0.7 : 1,
        }}>
          {saving ? 'Saving...' : 'Save Cluster Settings'}
        </button>
      </form>

      <div style={{ marginTop: '40px' }}>
        <h3 style={{ fontSize: '1.1rem', fontWeight: 600, color: 'var(--md-on-surface)', marginBottom: '4px' }}>Cluster Nodes</h3>
        <p style={{ color: 'var(--md-on-surface-variant)', fontSize: '0.85rem', marginBottom: '16px' }}>Nodes register automatically during setup. Rename or remove them here.</p>

        <table style={{
          width: '100%', borderCollapse: 'collapse', background: 'var(--md-surface-container)',
          borderRadius: 'var(--md-radius-lg)', overflow: 'hidden',
          border: '1px solid var(--md-outline-variant)',
        }}>
          <thead>
            <tr style={{
              textAlign: 'left', borderBottom: '1px solid var(--md-outline-variant)',
              color: 'var(--md-on-surface-variant)', fontSize: '0.8rem', fontWeight: 600,
              background: 'var(--md-surface)',
            }}>
              <th style={{ padding: '12px 16px' }}>Name</th>
              <th style={{ padding: '12px 16px' }}>IP Address</th>
              <th style={{ padding: '12px 16px' }}>Status</th>
              <th style={{ padding: '12px 16px' }}>etcd</th>
              <th style={{ padding: '12px 16px' }}>Services</th>
              <th style={{ padding: '12px 16px' }}>Security</th>
              <th style={{ padding: '12px 16px', textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loadingNodes ? (
              <tr><td colSpan="7" style={{ padding: '16px', textAlign: 'center', color: 'var(--md-on-surface-variant)' }}>Loading nodes...</td></tr>
            ) : nodes.length === 0 ? (
              <tr><td colSpan="7" style={{ padding: '16px', textAlign: 'center', color: 'var(--md-on-surface-variant)' }}>No nodes registered.</td></tr>
            ) : nodes.map(node => {
              const etcdInfo = etcdStatus.nodes.find(n => n.id === node.id)?.etcd || {};
              const isLearner = etcdInfo.isLearner;
              return (
              <tr key={node.id} style={{ borderBottom: '1px solid var(--md-outline-variant)' }}>
                <td style={{ padding: '14px 16px', fontWeight: 600, color: 'var(--md-on-surface)' }}>
                  {renamingNode === node.id ? (
                    <input value={renameValue} onChange={e => setRenameValue(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleRenameNode(node.id); if (e.key === 'Escape') setRenamingNode(null); }}
                      onBlur={() => handleRenameNode(node.id)} autoFocus
                      style={{ width: '120px', padding: '4px 8px', border: '1px solid var(--md-primary)', borderRadius: 'var(--md-radius-sm)', background: 'var(--md-surface)', color: 'var(--md-on-surface)' }} />
                  ) : node.name}
                </td>
                <td style={{ padding: '14px 16px', color: 'var(--md-on-surface-variant)' }}>{node.ip}</td>
                <td style={{ padding: '14px 16px' }}>
                  <span style={{
                    display: 'inline-block', padding: '4px 10px', borderRadius: 'var(--md-radius-full)', fontSize: '0.75rem', fontWeight: 600,
                    background: node.status === 'online' ? 'var(--md-success-container)' : 'var(--md-error-container)',
                    color: node.status === 'online' ? 'var(--md-on-success-container)' : 'var(--md-on-error-container)',
                  }}>
                    {(node.status || 'UNKNOWN').toUpperCase()}
                  </span>
                </td>
                <td style={{ padding: '14px 16px' }}>
                  {isLearner === null ? (
                    <span style={{ color: 'var(--md-on-surface-variant)', fontSize: '0.85rem' }}>&mdash;</span>
                  ) : isLearner ? (
                    <span style={{ color: 'var(--md-warning)', fontSize: '0.85rem', fontWeight: 600 }}>Learner</span>
                  ) : (
                    <span style={{ color: 'var(--md-success)', fontSize: '0.85rem', fontWeight: 600 }}>Voting</span>
                  )}
                </td>
                <td style={{ padding: '14px 16px' }}>
                  <span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: etcdStatus.allServicesHealthy ? 'var(--md-success)' : 'var(--md-error)', marginRight: '6px', verticalAlign: 'middle' }} />
                  <span style={{ fontSize: '0.85rem', color: 'var(--md-on-surface-variant)' }}>{etcdStatus.allServicesHealthy ? 'All Healthy' : 'Degraded'}</span>
                  {!etcdStatus.allServicesHealthy && etcdStatus.systemServices && (
                    <div style={{ fontSize: '0.75rem', color: 'var(--md-error)', marginTop: '4px' }}>{etcdStatus.systemServices.filter(s => !node.services?.[s]).join(', ')} down</div>
                  )}
                </td>
                <td style={{ padding: '14px 16px' }}>
                  {!node.sealed ? (
                    <span style={{ color: 'var(--md-success)', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <span className="material-symbols-outlined" style={{ fontSize: '1rem' }}>lock_open</span>
                      Unsealed
                    </span>
                  ) : (
                    <a href={`https://${node.name}.core-docker.local`} target="_blank" rel="noopener noreferrer"
                      style={{ color: 'var(--md-primary)', fontSize: '0.85rem', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '4px', fontWeight: 600 }}>
                      <span className="material-symbols-outlined" style={{ fontSize: '1rem' }}>lock</span>
                      Sealed (Unseal)
                    </a>
                  )}
                </td>
                <td style={{ padding: '14px 16px', textAlign: 'right' }}>
                  <button onClick={() => { setRenamingNode(node.id); setRenameValue(node.name); }}
                    style={{ background: 'none', border: 'none', color: 'var(--md-primary)', cursor: 'pointer', marginRight: '8px', verticalAlign: 'middle' }} title="Rename Node">
                    <span className="material-symbols-outlined" style={{ fontSize: '1.25rem' }}>edit</span>
                  </button>
                  <button onClick={() => handleDeleteNode(node.id)}
                    style={{ background: 'none', border: 'none', color: 'var(--md-error)', cursor: 'pointer', verticalAlign: 'middle' }} title="Remove Node">
                    <span className="material-symbols-outlined" style={{ fontSize: '1.25rem' }}>delete</span>
                  </button>
                </td>
              </tr>
            );
            })}
          </tbody>
        </table>
      </div>

      <div style={{
        marginTop: '40px', padding: '20px', background: 'var(--md-surface-container)',
        borderRadius: 'var(--md-radius-lg)', border: '1px solid var(--md-outline-variant)',
      }}>
        <h3 style={{ margin: 0, color: 'var(--md-on-surface)', fontSize: '1.1rem', fontWeight: 600 }}>Security</h3>
        <p style={{ color: 'var(--md-on-surface-variant)', fontSize: '0.85rem', margin: '4px 0 20px 0' }}>Manage your master password and data encryption keys.</p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '40px' }}>
          <form onSubmit={handleChangePassword} style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
            <h4 style={{ margin: 0, color: 'var(--md-on-surface)', fontWeight: 600 }}>Change Master Password</h4>
            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 500, marginBottom: '4px', color: 'var(--md-on-surface-variant)' }}>Current Password</label>
              <input type="password" value={passwords.current} onChange={e => setPasswords({...passwords, current: e.target.value})} style={inputStyle} required />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 500, marginBottom: '4px', color: 'var(--md-on-surface-variant)' }}>New Password</label>
              <input type="password" value={passwords.next} onChange={e => setPasswords({...passwords, next: e.target.value})} style={inputStyle} required />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 500, marginBottom: '4px', color: 'var(--md-on-surface-variant)' }}>Confirm New Password</label>
              <input type="password" value={passwords.confirm} onChange={e => setPasswords({...passwords, confirm: e.target.value})} style={inputStyle} required />
            </div>
            <button type="submit" disabled={isChangingPassword} style={{
              padding: '10px 24px', background: 'var(--md-on-surface)', color: 'var(--md-inverse-on-surface)',
              border: 'none', borderRadius: 'var(--md-radius-full)', cursor: 'pointer',
              fontWeight: 600, fontSize: '0.875rem', fontFamily: 'var(--md-font)',
              width: 'fit-content', opacity: isChangingPassword ? 0.7 : 1,
            }}>
              {isChangingPassword ? 'Updating...' : 'Update Password'}
            </button>
          </form>

          <div style={{
            padding: '16px', border: '1px solid var(--md-error)', borderRadius: 'var(--md-radius-lg)',
            background: 'var(--md-error-container)',
          }}>
            <h4 style={{ margin: 0, color: 'var(--md-on-error-container)', fontWeight: 600 }}>Rotate Data Encryption Key (DEK)</h4>
            <p style={{ fontSize: '0.85rem', color: 'var(--md-on-error-container)', margin: '10px 0' }}>
              <strong>Warning:</strong> This will re-encrypt all containers, tasks, and secrets with a brand new key.
              If this process is interrupted, your cluster data may become permanently unreadable.
              <strong> Take a backup first.</strong>
            </p>
            <button onClick={handleRotateDEK} disabled={isRotating} style={{
              marginTop: '10px', padding: '10px 24px', background: 'var(--md-error)',
              color: 'var(--md-on-error)', border: 'none', borderRadius: 'var(--md-radius-full)',
              cursor: 'pointer', fontWeight: 600, fontSize: '0.875rem', fontFamily: 'var(--md-font)',
              opacity: isRotating ? 0.7 : 1,
            }}>
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
          backdropFilter: 'blur(4px)',
        }}>
          <div style={{
            background: 'var(--md-surface-container)', padding: '24px', borderRadius: 'var(--md-radius-xl)',
            maxWidth: '400px', width: '90%', boxShadow: 'var(--md-elevation-3)',
          }} onClick={e => e.stopPropagation()}>
            <h4 style={{ margin: '0 0 10px 0', color: 'var(--md-error)' }}>Rotate Data Encryption Key</h4>
            <p style={{ fontSize: '0.9rem', color: 'var(--md-on-surface-variant)', marginBottom: '15px' }}>
              This will re-encrypt all cluster data. Enter your Master Password to authorize.
            </p>
            <input type="password" value={dekPassword} onChange={e => setDekPassword(e.target.value)}
              placeholder="Master Password" style={{ ...inputStyle, marginBottom: '15px' }} autoFocus />
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
              <button onClick={() => { setShowDekPrompt(false); setDekPassword(''); }} style={{
                padding: '10px 24px', background: 'transparent', color: 'var(--md-on-surface-variant)',
                border: '1px solid var(--md-outline)', borderRadius: 'var(--md-radius-full)',
                cursor: 'pointer', fontWeight: 500, fontFamily: 'var(--md-font)',
              }}>
                Cancel
              </button>
              <button onClick={confirmRotateDEK} disabled={!dekPassword} style={{
                padding: '10px 24px', background: 'var(--md-error)', color: 'var(--md-on-error)',
                border: 'none', borderRadius: 'var(--md-radius-full)', cursor: 'pointer',
                fontWeight: 600, fontFamily: 'var(--md-font)', opacity: !dekPassword ? 0.5 : 1,
              }}>
                Rotate
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
