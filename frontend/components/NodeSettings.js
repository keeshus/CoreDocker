import React, { useState, useEffect } from 'react';
import ContainerRow from './ContainerRow';

export default function NodeSettings({ systemContainers = [], stats = {} }) {
  const [nodes, setNodes] = useState([]);
  const [selectedNodeId, setSelectedNodeId] = useState('');
  const [settings, setSettings] = useState({ backupPath: '', nonBackupPath: '' });
  const [loadingNodes, setLoadingNodes] = useState(true);
  const [loadingSettings, setLoadingSettings] = useState(false);
  const [saving, setSaving] = useState(false);
  const [expandedContainer, setExpandedContainer] = useState(null);

  useEffect(() => {
    fetch('/api/nodes')
      .then(res => res.json())
      .then(data => {
        setNodes(data);
        if (data.length > 0 && !selectedNodeId) {
          setSelectedNodeId(data[0].id);
        }
        setLoadingNodes(false);
      })
      .catch(e => {
        console.error('Failed to load nodes:', e);
        setLoadingNodes(false);
      });
  }, []);

  useEffect(() => {
    if (selectedNodeId) {
      setLoadingSettings(true);
      fetch(`/api/nodes/${selectedNodeId}/settings`)
        .then(res => res.json())
        .then(data => {
          setSettings(data);
          setLoadingSettings(false);
        })
        .catch(e => {
          console.error('Failed to load node settings:', e);
          setLoadingSettings(false);
        });
    }
  }, [selectedNodeId]);

  const handleSave = async (e) => {
    e.preventDefault();
    if (!selectedNodeId) return;
    
    setSaving(true);
    try {
      const res = await fetch(`/api/nodes/${selectedNodeId}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });
      if (res.ok) {
        alert('Node settings saved successfully!');
      } else {
        const error = await res.json();
        alert('Error saving node settings: ' + JSON.stringify(error));
      }
    } catch (e) {
      alert('Error saving node settings: ' + e.message);
    }
    setSaving(false);
  };

  if (loadingNodes) return <div>Loading nodes...</div>;

  const selectedNode = nodes.find(n => n.id === selectedNodeId);
  
  const filteredSystemContainers = systemContainers.filter(c => {
    if (selectedNode) {
      const containerNode = c.current_node || '';
      const nameMatch = c.Names[0].includes(selectedNode.name);
      // Treat 'master' as the first node in the cluster if it's node-1
      const isMasterNodeMatch = containerNode === 'master' && selectedNode.name === 'node-1';
      
      return containerNode === selectedNode.name || 
             containerNode === selectedNode.id ||
             nameMatch ||
             isMasterNodeMatch;
    }
    return true;
  });

  return (
    <div style={{ background: '#f8fafc', padding: '20px', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
      <h2 style={{ marginTop: 0 }}>Node Settings</h2>
      <p style={{ color: '#64748b' }}>Configure settings and monitor system containers for specific nodes.</p>

      <div style={{ marginBottom: '20px' }}>
        <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '8px' }}>Select Node</label>
        <select 
          value={selectedNodeId} 
          onChange={e => setSelectedNodeId(e.target.value)}
          style={{ width: '100%', maxWidth: '400px', padding: '10px', border: '1px solid #cbd5e1', borderRadius: '4px' }}
        >
          {nodes.map(node => (
            <option key={node.id} value={node.id}>{node.name} ({node.ip})</option>
          ))}
        </select>
      </div>

      {loadingSettings ? (
        <div>Loading node settings...</div>
      ) : selectedNodeId ? (
        <>
          <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '600px', marginTop: '20px' }}>
            <div>
              <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '8px' }}>Backup Path</label>
              <input 
                type="text" 
                value={settings.backupPath} 
                onChange={e => setSettings({...settings, backupPath: e.target.value})}
                placeholder="e.g. /data/backup"
                style={{ width: '100%', padding: '10px', border: '1px solid #cbd5e1', borderRadius: '4px' }}
              />
              <small style={{ color: '#64748b', display: 'block', marginTop: '4px' }}>Path where persistent data is backed up.</small>
            </div>

            <div>
              <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '8px' }}>Non-Backup Path</label>
              <input 
                type="text" 
                value={settings.nonBackupPath} 
                onChange={e => setSettings({...settings, nonBackupPath: e.target.value})}
                placeholder="e.g. /data/non-backup"
                style={{ width: '100%', padding: '10px', border: '1px solid #cbd5e1', borderRadius: '4px' }}
              />
              <small style={{ color: '#64748b', display: 'block', marginTop: '4px' }}>Path for temporary or non-essential data.</small>
            </div>

            <button 
              type="submit" 
              disabled={saving}
              style={{ padding: '10px 20px', background: '#3b82f6', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold', width: 'fit-content' }}
            >
              {saving ? 'Saving...' : 'Save Node Settings'}
            </button>
          </form>

          <div style={{ marginTop: '40px', paddingTop: '20px', borderTop: '1px solid #e2e8f0' }}>
            <h3 style={{ marginTop: 0 }}>System Containers on {selectedNode?.name}</h3>
            <p style={{ color: '#64748b', fontSize: '0.9em' }}>Monitor core application containers running on this node.</p>
            
            {filteredSystemContainers.length > 0 ? (
              <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '15px', background: 'white', borderRadius: '8px', overflow: 'hidden', border: '1px solid #e2e8f0' }}>
                <thead>
                  <tr style={{ textAlign: 'left', borderBottom: '2px solid #e2e8f0', color: '#64748b', fontSize: '0.9em', background: '#f8fafc' }}>
                    <th style={{ padding: '12px 10px' }}>Name</th>
                    <th style={{ padding: '12px 10px' }}>Image</th>
                    <th style={{ padding: '12px 10px' }}>State</th>
                    <th style={{ padding: '12px 10px' }}>CPU %</th>
                    <th style={{ padding: '12px 10px' }}>Memory</th>
                    <th style={{ padding: '12px 10px' }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSystemContainers.map(c => (
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
              <p style={{ color: '#94a3b8', marginTop: '15px' }}>No system containers found on this node.</p>
            )}
          </div>
        </>
      ) : (
        <p>No node selected or no nodes available.</p>
      )}
    </div>
  );
}
