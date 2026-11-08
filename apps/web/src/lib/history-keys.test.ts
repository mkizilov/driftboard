import { describe, expect, it } from 'vitest';
import { historyInput, historyShortcut, type KeyLike } from './history-keys';

const key = (change: Partial<KeyLike>): KeyLike => ({
  key: 'z',
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...change,
});

describe('historyShortcut', () => {
  it('undoes on Ctrl+Z and on Cmd+Z', () => {
    expect(historyShortcut(key({ ctrlKey: true }))).toBe('undo');
    expect(historyShortcut(key({ metaKey: true }))).toBe('undo');
  });

  it('redoes on Shift+Ctrl+Z and Shift+Cmd+Z, where the browser reports a capital Z', () => {
    expect(historyShortcut(key({ ctrlKey: true, shiftKey: true, key: 'Z' }))).toBe('redo');
    expect(historyShortcut(key({ metaKey: true, shiftKey: true, key: 'Z' }))).toBe('redo');
    expect(historyShortcut(key({ metaKey: true, shiftKey: true, key: 'z' }))).toBe('redo');
  });

  it('does not answer to Z without Ctrl or Cmd, or to other keys with them', () => {
    expect(historyShortcut(key({}))).toBeNull();
    expect(historyShortcut(key({ shiftKey: true, key: 'Z' }))).toBeNull();
    for (const other of ['y', 'a', 'x', 'c', 'v', 'Enter', 'Control', 'Meta']) {
      expect(historyShortcut(key({ ctrlKey: true, key: other }))).toBeNull();
    }
  });

  it('leaves Alt combinations alone', () => {
    expect(historyShortcut(key({ ctrlKey: true, altKey: true }))).toBeNull();
    expect(historyShortcut(key({ metaKey: true, altKey: true, shiftKey: true }))).toBeNull();
  });

  it('leaves keys to an input method that is composing', () => {
    expect(historyShortcut(key({ ctrlKey: true, isComposing: true }))).toBeNull();
    expect(historyShortcut(key({ ctrlKey: true, isComposing: false }))).toBe('undo');
  });

  it('leaves a one-line field its own undo, but not a textarea or anything else', () => {
    expect(historyShortcut(key({ ctrlKey: true, target: { tagName: 'INPUT' } }))).toBeNull();
    expect(historyShortcut(key({ ctrlKey: true, target: { tagName: 'TEXTAREA' } }))).toBe('undo');
    expect(historyShortcut(key({ ctrlKey: true, target: { tagName: 'BODY' } }))).toBe('undo');
    expect(historyShortcut(key({ ctrlKey: true, target: null }))).toBe('undo');
    expect(historyShortcut(key({ ctrlKey: true, target: {} }))).toBe('undo');
  });
});

describe('historyInput', () => {
  it('takes the browser’s own undo and redo for the board’s', () => {
    expect(historyInput({ inputType: 'historyUndo' })).toBe('undo');
    expect(historyInput({ inputType: 'historyRedo' })).toBe('redo');
  });

  it('ignores every other kind of input', () => {
    for (const inputType of ['insertText', 'deleteContentBackward', 'insertFromPaste', '']) {
      expect(historyInput({ inputType })).toBeNull();
    }
  });

  it('leaves a one-line field its own undo', () => {
    expect(historyInput({ inputType: 'historyUndo', target: { tagName: 'INPUT' } })).toBeNull();
    expect(historyInput({ inputType: 'historyUndo', target: { tagName: 'TEXTAREA' } })).toBe(
      'undo',
    );
  });
});
