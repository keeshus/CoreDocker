import React, { useEffect, useState, useRef } from 'react';
import ContainerRow from '../components/ContainerRow';
import NodesTab from '../components/NodesTab';
import SecretsTab from '../components/SecretsTab';
import TasksTab from '../components/TasksTab';
import SettingsTab from '../components/SettingsTab';
import AppLayout from '../components/AppLayout';
import UnsealView from '../components/UnsealView';

export default function Home() {
  const [activeTab, setActiveTab] = useState('containers');
  const [containers, setContainers] = useState([]);
  const [info, setInfo] = useState(null);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({});
  const [events, setEvents] = useState([]);
  const [expandedContainer, setExpandedContainer] = useState(null);
  const [editingContainer, setEditingContainer] = useState(null);
  const eventScrollRef = useRef(null);

  const refreshData = async () => {
    try {
      const [containersRes, infoRes, statusRes] = await Promise.all([
        fetch('/api/containers'),
        fetch('/api/info'),
        fetch('/api/system/status')
      ]);
      
      if (statusRes.ok) {
        const statusData = await statusRes.json();
        setStatus(statusData);
        if (!statusData.unsealed || !statusData.authenticated) return;
      }

      if (containersRes.ok) setContainers(await containersRes.json());
      if (infoRes.ok) setInfo(await infoRes.json());
    } catch (err) {
      console.error('Refresh error:', err);
    }
  };

  useEffect(() => {
    refreshData().finally(() => setLoading(false));

    const eventSource = new EventSource('/api/events');
    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'docker-event') {
          setEvents(prev => [...prev, { 
            id: Date.now() + Math.random(), 
            time: new Date().toLocaleTimeString(), 
            ...data 
          }].slice(-20));
          refreshData();
        } else if (data.type === 'container-stats') {
          setStats(prev => ({ ...prev, [data.id]: data }));
        }
      } catch (e) {}
    };
    eventSource.onerror = () => eventSource.close();
    return () => eventSource.close();
  }, []);

  useEffect(() => {
    if (eventScrollRef.current) {
      eventScrollRef.current.scrollTop = 0;
    }
  }, [events]);

  const handleUnseal = async (password) => {
    const endpoint = status.initialized ? '/api/system/unseal' : '/api/system/setup';
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });
      if (res.ok) {
        refreshData();
      } else {
        const err = await res.json();
        alert(err.error);
      }
    } catch (err) {
      alert(err.message);
    }
  };

  const handleEdit = (container) => {
    setEditingContainer({
      dockerId: container.Id,
      ...container.persistedConfig
    });
  };

  const handlePersist = async (container) => {
    try {
      const res = await fetch(`/api/containers/${container.Id}/persist`, { method: 'POST' });
      if (res.ok) {
        alert('Container successfully migrated to CoreDocker.');
        refreshData();
      } else {
        const err = await res.json();
        alert('Failed to migrate: ' + err.error);
      }
    } catch (e) {
      alert('Failed to migrate: ' + e.message);
    }
  };

  const handleDelete = async (container) => {
    if (!window.confirm(`Are you sure you want to completely delete ${container.Names[0]}?`)) return;
    try {
      const res = await fetch(`/api/containers/${container.Id}`, { method: 'DELETE' });
      if (res.ok) {
        alert('Container deleted.');
        refreshData();
      } else {
        const err = await res.json();
        alert('Failed to delete: ' + err.error);
      }
    } catch (e) {
      alert('Failed to delete: ' + e.message);
    }
  };

  if (loading) return <div style={{ padding: '20px', fontFamily: 'sans-serif' }}>Loading...</div>;
  
  if (status && (!status.unsealed || !status.authenticated)) {
    return <UnsealView status={status} onUnseal={handleUnseal} />;
  }

  return (
    <AppLayout 
      activeTab={activeTab} 
      setActiveTab={setActiveTab} 
      info={info} 
      onRefresh={refreshData}
    >
      {activeTab === 'containers' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '20px', marginBottom: '40px' }}>
            <section style={{ padding: '15px', background: '#f8fafc', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
              <h2 style={{ marginTop: 0, fontSize: '1.2em', display: 'flex', justifyContent: 'space-between' }}>
                Live Events 
                <span style={{ fontSize: '0.6em', color: '#94a3b8', fontWeight: 'normal' }}>Showing last 20 events</span>
              </h2>
              <div 
                ref={eventScrollRef}
                style={{ maxHeight: '250px', overflowY: 'auto', fontSize: '0.85em', background: '#fff', padding: '10px', borderRadius: '4px', border: '1px solid #f1f5f9' }}
              >
                {events.length === 0 ? <p style={{ color: '#94a3b8', margin: 0 }}>Waiting for events...</p> : (
                  <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column-reverse' }}>
                    {events.map(e => (
                      <li key={e.id} style={{ padding: '6px 0', borderBottom: '1px solid #f1f5f9', display: 'flex', alignItems: 'center' }}>
                        <span style={{ color: '#94a3b8', fontFamily: 'monospace', width: '100px' }}>[{e.time}]</span> 
                        <span style={{ 
                          display: 'inline-block', width: '80px', fontWeight: 'bold', textTransform: 'uppercase', 
                          color: ['die', 'kill', 'stop'].includes(e.action) ? '#ef4444' : '#10b981'
                        }}>
                          {e.action}
                        </span> 
                        <span style={{ color: '#1e293b' }}>{e.name}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          </div>

          <section>
            <h2 style={{ fontSize: '1.5em' }}>Containers</h2>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
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
                {containers.filter(c => !c.Names[0].startsWith('/core-docker-')).map(c => (
                  <ContainerRow
                    key={c.Id} container={c} stats={stats[c.Id]}
                    isExpanded={expandedContainer === c.Id} 
                    onToggle={() => setExpandedContainer(expandedContainer === c.Id ? null : c.Id)}
                    onEdit={handleEdit}
                    onPersist={handlePersist}
                    onDelete={handleDelete}
                  />
                ))}
              </tbody>
            </table>
          </section>

          {editingContainer && (
            <CreateContainer 
              isOpenMode={true} 
              initialData={editingContainer} 
              onCreated={() => { setEditingContainer(null); refreshData(); }} 
              onClose={() => setEditingContainer(null)} 
            />
          )}
        </>
      )}
      
      {activeTab === 'nodes' && <NodesTab />}
      {activeTab === 'secrets' && <SecretsTab />}
      {activeTab === 'tasks' && <TasksTab />}
      {activeTab === 'settings' && <SettingsTab systemContainers={containers.filter(c => c.Names[0].startsWith('/core-docker-'))} stats={stats} />}
    </AppLayout>
  );
}
