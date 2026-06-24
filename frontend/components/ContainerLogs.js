import React, { useEffect, useState, useRef } from 'react';

export default function ContainerLogs({ containerId }) {
  const [logs, setLogs] = useState([]);
  const scrollRef = useRef(null);

  useEffect(() => {
    const eventSource = new EventSource(`/api/containers/${containerId}/logs`);
    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        setLogs(prev => [data.log, ...prev].slice(0, 100));
      } catch (e) {}
    };
    eventSource.onerror = () => eventSource.close();
    return () => eventSource.close();
  }, [containerId]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [logs]);

  return (
    <div
      ref={scrollRef}
      style={{
        background: 'var(--md-inverse-surface)',
        color: 'var(--md-inverse-on-surface)',
        padding: '12px', borderRadius: 'var(--md-radius-md)',
        fontFamily: 'var(--md-font-mono)', fontSize: '0.8rem',
        height: '250px', overflowY: 'auto',
        whiteSpace: 'pre-wrap',
        border: '1px solid var(--md-outline-variant)',
      }}
    >
      {logs.length === 0 ? 'Loading logs...' : logs.join('')}
    </div>
  );
}
