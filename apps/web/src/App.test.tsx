import { PROTOCOL_VERSION } from '@driftboard/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('App', () => {
  it('renders the title and the protocol version', () => {
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain('<h1>driftboard</h1>');
    expect(html).toContain(`v${PROTOCOL_VERSION}`);
  });
});
