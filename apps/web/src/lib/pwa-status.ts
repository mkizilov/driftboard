export interface PwaState {
  /** The app and its assets are cached, so it opens with no network. */
  readonly offlineReady: boolean;
  /** A newer version is installed and waits for the page to reload. */
  readonly needRefresh: boolean;
}

/**
 * What the service worker has told the page, in the shape React reads. The page that registers the
 * worker feeds it (`markOfflineReady`, `markNeedRefresh`) and says how to apply an update
 * (`setReload`); the banner shows it and calls `reload` or `dismiss`.
 */
export class PwaStatus {
  readonly #listeners = new Set<() => void>();
  #state: PwaState = { offlineReady: false, needRefresh: false };
  #reload: () => void = () => undefined;

  readonly getState = (): PwaState => this.#state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  markOfflineReady(): void {
    this.#set({ ...this.#state, offlineReady: true });
  }

  markNeedRefresh(): void {
    this.#set({ ...this.#state, needRefresh: true });
  }

  /** What "reload" does once an update is waiting. */
  setReload(reload: () => void): void {
    this.#reload = reload;
  }

  reload(): void {
    this.#reload();
  }

  /** Hides whatever is being shown. */
  dismiss(): void {
    this.#set({ offlineReady: false, needRefresh: false });
  }

  #set(next: PwaState): void {
    const { offlineReady, needRefresh } = this.#state;
    if (next.offlineReady === offlineReady && next.needRefresh === needRefresh) return;
    this.#state = next;
    for (const listener of [...this.#listeners]) listener();
  }
}

/** The page's one status. */
export const pwaStatus = new PwaStatus();
