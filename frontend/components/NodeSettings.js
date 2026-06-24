import React, { useState, useEffect } from 'react';
import ContainerRow from './ContainerRow';

export default function NodeSettings({ systemContainers = [], stats = {} }) {
  const [nodes, setNodes] = useState([]);
  const [selectedNodeId, setSelectedNodeId] = useState('');
  const [loadingNodes, setLoadingNodes] = useState(true);
  const [expandedContainer, setExpandedContainer] = useState(null);
  const [remoteContainers, setRemoteContainers] = useState([]);
  const [loadingContainers, setLoadingContainers] = useState(false);
  const [containerError, setContainerError] = useState('');

  useEffect(() => {
    fetch('/api/nodes').then(res => res.json()).then(data => {
      setNodes(data);
      if (data.length > 0 && !selectedNodeId) setSelectedNodeId(data[0].id);
      setLoadingNodes(false);
    }).catch(() => setLoadingNodes(false));
  }, []);

  useEffect(() => {
    if (!selectedNodeId) return;
    const selectedNode = nodes.find(n => n.id === selectedNodeId);
    if (!selectedNode) return;
    setLoadingContainers(true); setContainerError('');
    fetch(`/api/containers?node=${selectedNodeId}`)
      .then(async res => {
        if (!res.ok) { const err = await res.text().catch(() => 'unknown'); throw new Error(`HTTP ${res.status}: ${err.slice(0, 200)}`); }
        return res.json();
      })
      .then(data => { setRemoteContainers(data.filter(c => (c.Names?.[0] || '').startsWith('/core-docker-'))); setLoadingContainers(false); })
      .catch(e => { setContainerError(e.message); setRemoteContainers([]); setLoadingContainers(false); });
  }, [selectedNodeId, nodes]);

  if (loadingNodes) return <div style={{ padding: '20px', color: 'var(--md-on-surface-variant)' }}>Loading nodes...</div>;

  const selectedNode = nodes.find(n => n.id === selectedNodeId);
  const containers = remoteContainers.length > 0 || !selectedNodeId ? remoteContainers : systemContainers;

  return (
    <div>
      <h2 style={{ fontSize: '1.35rem', fontWeight: 600, color: 'var(--md-on-surface)', margin: '0 0 4px 0' }}>Node Settings</h2>
      <p style={{ color: 'var(--md-on-surface-variant)', fontSize: '0.9rem', margin: '0 0 24px 0' }}>Configure settings and monitor system containers for specific nodes.</p>

      <div style={{
        padding: '16px', background: 'var(--md-surface-container)', borderRadius: 'var(--md-radius-lg)',
        border: '1px solid var(--md-outline-variant)', maxWidth: '400px',
      }}>
        <label style={{ display: 'block', fontWeight: 500, marginBottom: '6px', fontSize: '0.85rem', color: 'var(--md-on-surface-variant)' }}>Select Node</label>
        <select value={selectedNodeId} onChange={e => setSelectedNodeId(e.target.value)} style={{
          width: '100%', padding: '10px 12px', borderRadius: 'var(--md-radius-sm)',
          border: '1px solid var(--md-outline)', background: 'var(--md-surface)',
          color: 'var(--md-on-surface)', fontSize: '0.9rem', fontFamily: 'var(--md-font)',
        }}>
          {nodes.map(node => <option key={node.id} value={node.id}>{node.name} ({node.ip})</option>)}
        </select>
      </div>

      {selectedNode && selectedNode.system && (
        <div style={{
          marginTop: '16px', padding: '16px', background: 'var(--md-primary-container)',
          border: '1px solid var(--md-primary)', borderRadius: 'var(--md-radius-md)',
          maxWidth: '400px',
        }}>
          <strong style={{ color: 'var(--md-on-primary-container)' }}>Hardware Resources</strong>
          <div style={{ marginTop: '8px', display: 'flex', justifyContent: 'space-between', color: 'var(--md-on-primary-container)' }}>
            <span>CPUs: {selectedNode.system.cpus || 'Unknown'}</span>
            <span>Memory: {selectedNode.system.totalMem ? (selectedNode.system.totalMem / 1024 / 1024 / 1024).toFixed(2) + ' GB' : 'Unknown'}</span>
          </div>
        </div>
      )}

      {selectedNodeId ? (
        <div style={{ marginTop: '24px' }}>
          <h3 style={{ fontSize: '1.1rem', fontWeight: 600, color: 'var(--md-on-surface)', marginBottom: '4px' }}>System Containers on {selectedNode?.name}</h3>
          <p style={{ color: 'var(--md-on-surface-variant)', fontSize: '0.85rem', marginBottom: '16px' }}>Monitor core application containers running on this node.</p>

          {containerError && (
            <div style={{ color: 'var(--md-on-error-container)', background: 'var(--md-error-container)', padding: '10px', borderRadius: 'var(--md-radius-md)', marginBottom: '16px', fontSize: '0.85rem' }}>
              <span className="material-symbols-outlined" style={{ fontSize: '1rem', verticalAlign: 'middle', marginRight: '4px' }}>warning</span>
              {containerError}
            </div>
          )}

          {loadingContainers ? (
            <p style={{ color: 'var(--md-on-surface-variant)', fontSize: '0.85rem' }}>Loading containers...</p>
          ) : containers.length > 0 ? (
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
                  <th style={{ padding: '12px 16px' }}>Image</th>
                  <th style={{ padding: '12px 16px' }}>State</th>
                  <th style={{ padding: '12px 16px' }}>Container ID</th>
                  <th style={{ padding: '12px 16px' }}>CPU %</th>
                  <th style={{ padding: '12px 16px' }}>Memory</th>
                  <th style={{ padding: '12px 16px' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {containers.map(c => (
                  <ContainerRow key={c.Id} container={c} stats={stats[c.Id]}
                    isExpanded={expandedContainer === c.Id}
                    onToggle={() => setExpandedContainer(expandedContainer === c.Id ? null : c.Id)}
                    onEdit={() => {}} onPersist={() => {}} isSystem={true} />
                ))}
              </tbody>
            </table>
          ) : (
            <p style={{ color: 'var(--md-on-surface-variant)', fontSize: '0.85rem' }}>No system containers found on this node.</p>
          )}
        </div>
      ) : (
        <p style={{ color: 'var(--md-on-surface-variant)' }}>No node selected or no nodes available.</p>
      )}
    </div>
  );
}
