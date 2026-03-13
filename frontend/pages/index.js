import React, { useEffect, useState, useRef } from 'react';
import ContainerRow from '../components/ContainerRow';
import CreateContainer from '../components/CreateContainer';

export default function Home() {
  const [containers, setContainers] = useState([]);
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error] = useState(null);
  const [stats, setStats] = useState({});
  const [events, setEvents] = useState([]);
  const [expandedContainer, setExpandedContainer] = useState(null);
  const [editingContainer, setEditingContainer] = useState(null);
  const eventScrollRef = useRef(null);

  const refreshData = async () => {
    try {
      const [containersRes, infoRes] = await Promise.all([
        fetch('/api/proxy/containers'),
        fetch('/api/proxy/info')
      ]);
      if (containersRes.ok) setContainers(await containersRes.json());
      if (infoRes.ok) setInfo(await infoRes.json());
    } catch (err) {
      console.error('Refresh error:', err);
    }
  };

  useEffect(() => {
    refreshData().finally(() => setLoading(false));

    const eventSource = new EventSource('/api/proxy/events');
    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'docker-event') {
          setEvents(prev => {
            const newEvents = [...prev, { 
              id: Date.now() + Math.random(), 
              time: new Date().toLocaleTimeString(), 
              ...data 
            }].slice(-20);
            return newEvents;
          });
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
    // Scroll to top when events change (newest is at top)
    if (eventScrollRef.current) {
      eventScrollRef.current.scrollTop = 0;
    }
  }, [events]);

  const handleEdit = (container) => {
    setEditingContainer({
      dockerId: container.Id,
      ...container.persistedConfig
    });
  };

  const handlePersist = async (container) => {
    try {
      const res = await fetch(`/api/proxy/containers/${container.Id}/persist`, {
        method: 'POST'
      });
      if (res.ok) {
        alert('Container successfully persisted to database.');
        refreshData();
      } else {
        const err = await res.json();
        alert('Failed to persist: ' + err.error);
      }
    } catch (e) {
      alert('Failed to persist: ' + e.message);
    }
  };

  if (loading) return <div style={{ padding: '20px', fontFamily: 'sans-serif' }}>Loading...</div>;
  if (error) return <div style={{ padding: '20px', color: 'red' }}>Error: {error}</div>;

  return (
    <div style={{ padding: '20px', fontFamily: 'sans-serif', maxWidth: '1400px', margin: '0 auto' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h1 style={{ margin: 0 }}>Docker Manager</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
          {info && (
            <div style={{ 
              display: 'flex', gap: '20px', fontSize: '0.85em', background: '#f8fafc', 
              padding: '8px 15px', borderRadius: '20px', border: '1px solid #e2e8f0', color: '#64748b' 
            }}>
              <span><strong>OS:</strong> {info.OperatingSystem}</span>
              <span><strong>Kernel:</strong> {info.KernelVersion}</span>
              <span><strong>Containers:</strong> {info.Containers} (Run: {info.ContainersRunning})</span>
              <span><strong>CPUs:</strong> {info.NCPU}</span>
            </div>
          )}
          <CreateContainer onCreated={refreshData} />
        </div>
      </header>
      
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
            {containers.map(c => (
              <ContainerRow 
                key={c.Id} container={c} stats={stats[c.Id]} 
                isExpanded={expandedContainer === c.Id} 
                onToggle={() => setExpandedContainer(expandedContainer === c.Id ? null : c.Id)} 
                onEdit={handleEdit}
                onPersist={handlePersist}
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
    </div>
  );
}
