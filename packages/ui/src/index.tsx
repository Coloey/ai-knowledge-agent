import React from 'react';

export function AppShell(props: React.PropsWithChildren<{ title: string }>) {
  return (
    <main style={{ minHeight: '100vh', display: 'grid', gridTemplateRows: '56px 1fr' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '0 24px',
          borderBottom: '1px solid #e5e7eb',
          background: '#fff',
          fontWeight: 650,
        }}
      >
        {props.title}
      </header>
      <section style={{ padding: 24 }}>{props.children}</section>
    </main>
  );
}
