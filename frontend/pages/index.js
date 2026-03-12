import React, { useEffect, useState } from 'react';
import ContainerRow from '../components/ContainerRow';

export default function Home() {
  const [containers, setContainers] = useState([]);
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [stats, setStats] = useState({});
  const [events, setEvents] = useState([]);
  const [expandedContainer, setExpandedContainer] = useState(null);

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
          setEvents(prev => [{ id: Date.now() + Math.random(), time: new Date().toLocaleTimeString(), ...data }, ...prev].slice(0, 10));
          refreshData();
        } else if (data.type === 'container-stats') {
          setStats(prev => ({ ...prev, [data.id]: data }));
        }
      } catch (e) {}
    };
    eventSource.onerror = () => eventSource.close();
    return () => eventSource.close();
  }, []);

  if (loading) return <div style={{ padding: '20px', fontFamily: 'sans-serif' }}>Loading...</div>;
  if (error) return <div style={{ padding: '20px', color: 'red' }}>Error: {error}</div>;

  return (
    <div style={{ padding: '20px', fontFamily: 'sans-serif', maxWidth: '1200px', margin: '0 auto' }}>
      <h1>Docker Manager</h1>
      
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '20px', marginBottom: '40px' }}>
        {info && (
          <section style={{ padding: '15px', background: '#f8fafc', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
            <h2 style={{ marginTop: 0 }}>System</h2>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', fontSize: '0.9em' }}>
              <p><strong>OS:</strong> {info.OperatingSystem}</p>
              <p><strong>Containers:</strong> {info.Containers} (Run: {info.ContainersRunning})</p>
              <p><strong>CPUs:</strong> {info.NCPU}</p>
              <p><strong>Kernel:</strong> {info.KernelVersion}</p>
            </div>
          </section>
        )}

        <section style={{ padding: '15px', background: '#f8fafc', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
          <h2 style={{ marginTop: 0 }}>Events</h2>
          <div style={{ maxHeight: '150px', overflowY: 'auto', fontSize: '0.85em' }}>
            {events.length === 0 ? <p color="#64748b">Waiting...</p> : (
              <ul style={{ listStyle: 'none', padding: 0 }}>
                {events.map(e => (
                  <li key={e.id} style={{ padding: '4px 0', borderBottom: '1px solid #f1f5f9' }}>
                    <span style={{ color: '#94a3b8' }}>[{e.time}]</span> <strong>{e.action}</strong> {e.name}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>

      <section>
        <h2>Containers</h2>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '2px solid #e2e8f0' }}>
              <th style={{ padding: '12px 10px' }}>Name</th>
              <th style={{ padding: '12px 10px' }}>Image</th>
              <th style={{ padding: '12px 10px' }}>State</th>
              <th style={{ padding: '12px 10px' }}>CPU %</th>
              <th style={{ padding: '12px 10px' }}>Mem</th>
              <th style={{ padding: '12px 10px' }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {containers.map(c => (
              <ContainerRow 
                key={c.Id} container={c} stats={stats[c.Id]} 
                isExpanded={expandedContainer === c.Id} 
                onToggle={() => setExpandedContainer(expandedContainer === c.Id ? null : c.Id)} 
              />
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
