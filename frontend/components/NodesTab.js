import React, { useState, useEffect } from 'react';
import { Settings, Plus, Trash2, Server } from 'lucide-react';

export default function NodesTab() {
  const [nodes, setNodes] = useState([]);
  const [newNodeName, setNewNodeName] = useState('');
  const [newNodeIp, setNewNodeIp] = useState('');
  const [newBackupPath, setNewBackupPath] = useState('/data/backup');
  const [newNonBackupPath, setNewNonBackupPath] = useState('/data/non-backup');
  const [loading, setLoading] = useState(true);

  const fetchNodes = async () => {
    try {
      const res = await fetch('/api/nodes');
      const data = await res.json();
      setNodes(data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchNodes();
  }, []);

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
    try {
      const res = await fetch(`/api/nodes/${id}`, { method: 'DELETE' });
      if (res.ok) fetchNodes();
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <section>
      <div style={{ padding: '15px', background: '#f8fafc', borderRadius: '8px', border: '1px solid #e2e8f0', marginBottom: '30px' }}>
        <h2 style={{ marginTop: 0, fontSize: '1.2em', display: 'flex', alignItems: 'center', gap: '8px', color: '#1e293b' }}>
          <Settings size={20} /> Register New Node
        </h2>
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
          <div style={{ flex: '1 1 200px' }}>
            <label style={{ display: 'block', fontSize: '0.85em', color: '#64748b', marginBottom: '8px', fontWeight: 'bold', textTransform: 'uppercase' }}>Backup Path</label>
            <input
              type="text"
              value={newBackupPath}
              onChange={e => setNewBackupPath(e.target.value)}
              placeholder="/data/backup"
              style={{ width: '100%', padding: '10px', borderRadius: '4px', border: '1px solid #cbd5e1', outline: 'none' }}
              required
            />
          </div>
          <div style={{ flex: '1 1 200px' }}>
            <label style={{ display: 'block', fontSize: '0.85em', color: '#64748b', marginBottom: '8px', fontWeight: 'bold', textTransform: 'uppercase' }}>Non-Backup Path</label>
            <input
              type="text"
              value={newNonBackupPath}
              onChange={e => setNewNonBackupPath(e.target.value)}
              placeholder="/data/non-backup"
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

      <h2 style={{ fontSize: '1.5em' }}>Cluster Nodes</h2>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '2px solid #e2e8f0', color: '#64748b', fontSize: '0.9em' }}>
            <th style={{ padding: '12px 10px' }}>Name</th>
            <th style={{ padding: '12px 10px' }}>IP Address</th>
            <th style={{ padding: '12px 10px' }}>Status</th>
            <th style={{ padding: '12px 10px' }}>Security</th>
            <th style={{ padding: '12px 10px' }}>Paths (Backup / Non-Backup)</th>
            <th style={{ padding: '12px 10px', textAlign: 'right' }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
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
                    🔒 Sealed (Click to Unseal)
                  </a>
                )}
              </td>
              <td style={{ padding: '15px 10px', fontSize: '0.85em', color: '#64748b' }}>
                <div><strong>B:</strong> {node.backupPath || '/data/backup'}</div>
                <div><strong>NB:</strong> {node.nonBackupPath || '/data/non-backup'}</div>
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
    </section>
  );
}