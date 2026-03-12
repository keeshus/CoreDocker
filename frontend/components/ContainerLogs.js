import React, { useEffect, useState, useRef } from 'react';

export default function ContainerLogs({ containerId }) {
  const [logs, setLogs] = useState([]);
  const scrollRef = useRef(null);

  useEffect(() => {
    const eventSource = new EventSource(`/api/proxy/containers/${containerId}/logs`);
    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        setLogs(prev => [...prev, data.log].slice(-100));
      } catch (e) {}
    };
    eventSource.onerror = () => eventSource.close();
    return () => eventSource.close();
  }, [containerId]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [logs]);

  return (
    <div 
      ref={scrollRef}
      style={{ 
        background: '#0f172a', color: '#f1f5f9', padding: '10px', borderRadius: '4px', 
        fontFamily: 'monospace', fontSize: '0.8em', height: '250px', overflowY: 'auto',
        whiteSpace: 'pre-wrap', border: '1px solid #334155'
      }}
    >
      {logs.length === 0 ? 'Loading logs...' : logs.join('')}
    </div>
  );
}
