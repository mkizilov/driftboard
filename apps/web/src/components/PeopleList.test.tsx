// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { testPresence } from '../lib/test-support';
import { cleanup, flush, must, pressKey, render, setInputValue } from '../test-render';
import { PeopleList } from './PeopleList';

afterEach(cleanup);

function setup(name = 'Me') {
  const people = testPresence(name);
  const screen = render(<PeopleList presence={people.presence} />);
  const listed = () =>
    [...screen.container.querySelectorAll('.others .person')].map((item) => item.textContent);
  const field = () => must(screen.container.querySelector<HTMLInputElement>('.my-name'));
  return { people, screen, listed, field };
}

describe('PeopleList', () => {
  it('shows this person first, as themselves, with the name they can change', () => {
    const { field, screen } = setup('Grace');
    expect(field().value).toBe('Grace');
    expect(must(screen.container.querySelector('.you')).textContent).toBe('(you)');
    expect(screen.container.querySelectorAll('.others .person')).toHaveLength(0);
  });

  it('lists the other people by name as they arrive and leave', () => {
    const { people, listed } = setup();
    flush(() => {
      people.hear('Zed', {});
      people.hear('Ann', {});
    });
    expect(listed()).toEqual(['Ann', 'Zed']);
    flush(() => {
      people.hear('Ann', null);
    });
    expect(listed()).toEqual(['Zed']);
    flush(() => {
      people.timers.advance(6000);
    });
    expect(listed()).toEqual([]);
  });

  it('says who is editing a note', () => {
    const { people, listed } = setup();
    flush(() => {
      people.hear('Ann', { editing: '1@x' });
      people.hear('Zed', {});
    });
    expect(listed()).toEqual(['Ann · editing a note', 'Zed']);
    flush(() => {
      people.hear('Ann', { editing: null });
    });
    expect(listed()).toEqual(['Ann', 'Zed']);
  });

  it('colours each person’s dot with their colour', () => {
    const { people, screen } = setup();
    flush(() => {
      people.hear('Ann', { color: '#2f9e44' });
    });
    const person = must(screen.container.querySelector<HTMLElement>('.others .person'));
    expect(person.style.getPropertyValue('--peer')).toBe('#2f9e44');
  });

  it('renames this person when they type a new name and press Enter', () => {
    const { people, field } = setup();
    flush(() => {
      field().focus();
    });
    setInputValue(field(), 'Ada Lovelace');
    expect(field().value).toBe('Ada Lovelace');
    expect(people.identity.getIdentity().name).toBe('Me');
    pressKey(field(), 'Enter');
    expect(people.identity.getIdentity().name).toBe('Ada Lovelace');
    expect(field().value).toBe('Ada Lovelace');
  });

  it('renames when the field loses the focus', () => {
    const { people, field } = setup();
    flush(() => {
      field().focus();
    });
    setInputValue(field(), 'Grace');
    flush(() => {
      field().blur();
    });
    expect(people.identity.getIdentity().name).toBe('Grace');
  });

  it('forgets what was typed when Escape is pressed', () => {
    const { people, field } = setup();
    flush(() => {
      field().focus();
    });
    setInputValue(field(), 'Not this');
    pressKey(field(), 'Escape');
    expect(people.identity.getIdentity().name).toBe('Me');
    expect(field().value).toBe('Me');
  });

  it('does not accept an empty name', () => {
    const { people, field } = setup();
    flush(() => {
      field().focus();
    });
    setInputValue(field(), '   ');
    flush(() => {
      field().blur();
    });
    expect(people.identity.getIdentity().name).toBe('Me');
    expect(field().value).toBe('Me');
  });

  it('tells the others the new name', () => {
    const { people, field } = setup();
    people.set('online');
    people.timers.advance(100);
    flush(() => {
      field().focus();
    });
    setInputValue(field(), 'Ada');
    pressKey(field(), 'Enter');
    expect(people.sent.at(-1)?.name).toBe('Ada');
  });

  it('shows a name someone else gave as text', () => {
    const { people, screen } = setup();
    flush(() => {
      people.hear('Mal', { name: '<b>bold</b>' });
    });
    expect(screen.container.querySelector('.others b')).toBeNull();
    expect(must(screen.container.querySelector('.person-name')).textContent).toBe('<b>bold</b>');
  });

  it('is a labelled group, so that assistive technology can find it', () => {
    const { screen, field } = setup();
    const group = must(screen.container.querySelector('.people'));
    expect(group.getAttribute('role')).toBe('group');
    expect(group.getAttribute('aria-label')).toBe('People on this board');
    expect(field().getAttribute('aria-label')).toBe('Your name');
  });
});
