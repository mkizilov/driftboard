import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: { root: Root; container: HTMLElement }[] = [];

/** Renders `node` into the document, flushing effects. Call `cleanup` after each test. */
export function render(node: ReactNode) {
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  mounted.push({ root, container });
  return {
    container,
    rerender(next: ReactNode) {
      act(() => {
        root.render(next);
      });
    },
  };
}

export function cleanup(): void {
  for (const { root, container } of mounted.splice(0)) {
    act(() => {
      root.unmount();
    });
    container.remove();
  }
}

/** Waits for pending promises, such as a board being read from storage, and what they cause. */
export async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Runs `change` and lets React process what it caused. */
export function flush(change: () => void): void {
  act(() => {
    change();
  });
}

/**
 * What a user does when typing or pasting `text` over the textarea's selection. The value is set
 * through the prototype's setter so that React's value tracking still sees a change when the
 * `input` event arrives, as it does for real input.
 */
export function typeInto(textarea: HTMLTextAreaElement, text: string): void {
  const { selectionStart, selectionEnd, value } = textarea;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (setter === undefined) throw new Error('textarea has no value setter');
  flush(() => {
    setter.call(textarea, value.slice(0, selectionStart) + text + value.slice(selectionEnd));
    const caret = selectionStart + text.length;
    textarea.setSelectionRange(caret, caret);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/**
 * What a user does when typing `value` into a text input: set through the prototype's setter so
 * that React's value tracking sees a change when the `input` event arrives.
 */
export function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter === undefined) throw new Error('input has no value setter');
  flush(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** A key pressed on `element`. */
export function pressKey(element: HTMLElement, key: string): void {
  flush(() => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

/** A key combination pressed on `target`. Returns whether it was handled (default prevented). */
export function chord(target: EventTarget, init: KeyboardEventInit): boolean {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  flush(() => {
    target.dispatchEvent(event);
  });
  return event.defaultPrevented;
}

/** The browser's own undo or redo reaching `target`, as from a menu. Returns if it was handled. */
export function nativeHistory(target: EventTarget, inputType: string): boolean {
  const event = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType });
  flush(() => {
    target.dispatchEvent(event);
  });
  return event.defaultPrevented;
}

/** An input method composition event. */
export function composition(textarea: HTMLTextAreaElement, type: 'start' | 'end'): void {
  flush(() => {
    textarea.dispatchEvent(new CompositionEvent(`composition${type}`, { bubbles: true }));
  });
}

export function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('expected a value');
  return value;
}
