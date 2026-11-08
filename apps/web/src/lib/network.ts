/** What the browser tells about the network (`window` has both). */
export interface NetworkEvents {
  addEventListener(type: 'online' | 'offline', listener: () => void): void;
  removeEventListener(type: 'online' | 'offline', listener: () => void): void;
}

/** The part of a connection that reacts to the network. */
export interface NetworkAware {
  retryNow(): void;
  networkLost(): void;
}

/**
 * Connects the browser's `online` and `offline` events to a connection: when the network returns
 * it connects at once and does not wait out the backoff, and when the network goes away it stops
 * trusting a connection that may look open for minutes. Returns a function that stops listening.
 */
export function watchNetwork(events: NetworkEvents, connection: NetworkAware): () => void {
  const online = () => {
    connection.retryNow();
  };
  const offline = () => {
    connection.networkLost();
  };
  events.addEventListener('online', online);
  events.addEventListener('offline', offline);
  return () => {
    events.removeEventListener('online', online);
    events.removeEventListener('offline', offline);
  };
}
