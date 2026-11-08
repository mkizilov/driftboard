import { PROTOCOL_VERSION } from '@driftboard/protocol';

export function App() {
  return (
    <main>
      <h1>driftboard</h1>
      <p>A local-first collaborative sticky-note board.</p>
      <small>sync protocol v{PROTOCOL_VERSION}</small>
    </main>
  );
}
