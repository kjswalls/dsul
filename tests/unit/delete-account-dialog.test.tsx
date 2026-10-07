import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Settings → dsul → Delete account (components/settings/delete-account-dialog.tsx),
 * with fetch and the browser client mocked: what it says, when Delete lights,
 * what it sends, and what each answer leaves on screen.
 */

const signOut = vi.fn();
vi.mock('@/lib/supabase', () => ({ createClient: () => ({ auth: { signOut } }) }));

import { DeleteAccountDialog } from '@/components/settings/delete-account-dialog';
import { DELETION_NOTICE_KEY } from '@/lib/account-client';
import { ACCOUNT_COPY } from '@/lib/account-copy';
import type { AccountFacts } from '@/lib/account-types';
import { signedOutNav } from '@/lib/signed-out-redirect';

const USER = '6f1c2a9e-3b4d-4e5f-8a6b-7c8d9e0f1a2b';
const PLAIN: AccountFacts = {
  userId: USER,
  email: 'kirby@example.com',
  appleIds: [],
  appleRevocable: false,
  beeminder: false,
  ledger: false,
  openclaw: false,
  keyServices: [],
  modelProviderName: null,
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

let factsAnswer: () => Promise<Response>;
let deleteAnswer: () => Promise<Response>;
const fetchMock = vi.fn<typeof fetch>(async (input) => {
  const url = String(input);
  if (url === '/api/account') return factsAnswer();
  if (url === '/api/account/delete') return deleteAnswer();
  throw new Error(`unexpected fetch ${url}`);
});

const onOpenChange = vi.fn();

function mount(facts: AccountFacts | Response = PLAIN) {
  factsAnswer = async () => (facts instanceof Response ? facts : json(200, facts));
  return render(<DeleteAccountDialog open onOpenChange={onOpenChange} />);
}

const field = () => screen.getByTestId('delete-account-confirm') as HTMLInputElement;
const submit = () => screen.getByTestId('delete-account-submit') as HTMLButtonElement;
const deleteCalls = () => fetchMock.mock.calls.filter(([u]) => String(u) === '/api/account/delete');

async function ready() {
  await waitFor(() => expect(screen.queryByText(ACCOUNT_COPY.confirmLabel)).not.toBeNull());
  // The facts are in once the field's state no longer waits on them.
  await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeNull());
}

function type(text: string) {
  fireEvent.change(field(), { target: { value: text } });
}

async function confirmDelete() {
  type('DELETE');
  await act(async () => {
    fireEvent.click(submit());
  });
}

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  deleteAnswer = async () => json(200, { deleted: true, apple: 'none' });
  signOut.mockReset().mockResolvedValue({ error: null });
  onOpenChange.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

describe('what the dialog says', () => {
  it('names the account by its email, then the lead', async () => {
    mount();
    await ready();
    expect(screen.getByText(ACCOUNT_COPY.title)).toBeInTheDocument();
    expect(screen.getByTestId('delete-account-account')).toHaveTextContent(
      'This deletes the account for kirby@example.com.',
    );
    expect(screen.getByText(ACCOUNT_COPY.lead)).toBeInTheDocument();
  });

  it('has no account line with no email', async () => {
    mount({ ...PLAIN, email: null });
    await ready();
    expect(screen.queryByTestId('delete-account-account')).toBeNull();
  });

  it("lists the facts' lines, with the web's manual Apple line and never the step line", async () => {
    mount({
      ...PLAIN,
      appleIds: ['001234.dsul.0001'],
      appleRevocable: true,
      beeminder: true,
      ledger: true,
      openclaw: true,
      keyServices: ['Beeminder', 'Twilio'],
      modelProviderName: 'OpenAI',
    });
    await ready();
    const items = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual([
      ACCOUNT_COPY.beeminder,
      ACCOUNT_COPY.ledger,
      ACCOUNT_COPY.openclaw,
      ACCOUNT_COPY.keys(['Beeminder', 'Twilio']),
      ACCOUNT_COPY.modelKey('OpenAI'),
      ACCOUNT_COPY.appleManualWeb,
    ]);
    expect(screen.queryByText(ACCOUNT_COPY.appleStep)).toBeNull();
    expect(screen.queryByText(ACCOUNT_COPY.appleManual)).toBeNull();
  });

  it('lists nothing for a new account', async () => {
    mount();
    await ready();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });

  it('starts reading at the top: focus is on the dialog, not the field, and loading is said in words', async () => {
    const facts = deferred<Response>();
    factsAnswer = () => facts.promise;
    render(<DeleteAccountDialog open onOpenChange={onOpenChange} />);
    const content = screen.getByTestId('delete-account-dialog');
    await waitFor(() => expect(content).toHaveFocus());
    expect(field()).not.toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
    await act(async () => facts.resolve(json(200, PLAIN)));
    expect(screen.queryByRole('status')).toBeNull();
    expect(content).toHaveFocus();
  });

  it('is capped to the viewport and scrolls, so the buttons are never cut off', async () => {
    mount({ ...PLAIN, appleIds: ['001234.dsul.0001'], beeminder: true, ledger: true, openclaw: true });
    await ready();
    const classes = screen.getByTestId('delete-account-dialog').className.split(/\s+/);
    expect(classes).toContain('max-h-[calc(100dvh-2rem)]');
    expect(classes).toContain('overflow-y-auto');
  });

  it('labels the field with the instruction and shows DELETE as its placeholder', async () => {
    mount();
    await ready();
    const input = screen.getByLabelText(ACCOUNT_COPY.confirmLabel);
    expect(input).toBe(field());
    expect(input).toHaveAttribute('placeholder', 'DELETE');
    expect(input).toHaveAttribute('autocomplete', 'off');
  });
});

describe('Delete', () => {
  it('stays off until DELETE is typed, in any case', async () => {
    mount();
    await ready();
    expect(submit()).toBeDisabled();
    type('delet');
    expect(submit()).toBeDisabled();
    type('Delete account');
    expect(submit()).toBeDisabled();
    type(' delete ');
    expect(submit()).toBeEnabled();
    type('DELETE');
    expect(submit()).toBeEnabled();
  });

  it('stays off while the facts load, whatever is typed', async () => {
    const facts = deferred<Response>();
    factsAnswer = () => facts.promise;
    render(<DeleteAccountDialog open onOpenChange={onOpenChange} />);
    type('DELETE');
    expect(submit()).toBeDisabled();
    await act(async () => facts.resolve(json(200, PLAIN)));
    expect(submit()).toBeEnabled();
  });

  it('sends the account it opened for and the constant word, not what was typed', async () => {
    mount();
    await ready();
    type('  delete ');
    await act(async () => {
      fireEvent.click(submit());
    });
    expect(deleteCalls()).toHaveLength(1);
    const init = deleteCalls()[0]![1];
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(`{"account":"${USER}","confirm":"DELETE"}`);
  });

  it('reads "Deleting…" and cannot be closed while the delete is out', async () => {
    const answer = deferred<Response>();
    deleteAnswer = () => answer.promise;
    mount();
    await ready();
    await confirmDelete();
    expect(submit()).toHaveTextContent(ACCOUNT_COPY.deletingLabel);
    expect(submit()).toBeDisabled();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    await act(async () => answer.resolve(json(200, { deleted: true, apple: 'none' })));
  });
});

describe('after a 200', () => {
  it('stores the note before anything else, even if the page goes at once', async () => {
    const answer = deferred<Response>();
    deleteAnswer = () => answer.promise;
    const view = mount({ ...PLAIN, appleIds: ['001234.dsul.0001'] });
    await ready();
    await confirmDelete();
    // Another tab's SIGNED_OUT replaces the page before the answer lands.
    view.unmount();
    await act(async () => answer.resolve(json(200, { deleted: true, apple: 'not_revoked' })));
    await waitFor(() => expect(window.sessionStorage.getItem(DELETION_NOTICE_KEY)).not.toBeNull());
    expect(JSON.parse(window.sessionStorage.getItem(DELETION_NOTICE_KEY)!)).toEqual({
      apple: 'not_revoked',
      hadApple: true,
    });
    // Nobody is left to press Done, so the session ends here.
    expect(signOut).toHaveBeenCalledExactlyOnceWith({ scope: 'local' });
  });

  it('shows the done line as a status, moves focus to Done, and Done signs out locally', async () => {
    mount();
    await ready();
    await confirmDelete();
    const done = await screen.findByTestId('delete-account-done');
    expect(done).toHaveAttribute('role', 'status');
    expect(done).toHaveTextContent(ACCOUNT_COPY.deleted);
    expect(screen.queryByTestId('delete-account-confirm')).toBeNull();
    // The question is answered: the title no longer asks it, and the account
    // line no longer says what is about to go.
    expect(screen.queryByText(ACCOUNT_COPY.title)).toBeNull();
    expect(screen.getByRole('heading', { name: ACCOUNT_COPY.deleteLabel })).toBeInTheDocument();
    expect(screen.queryByTestId('delete-account-account')).toBeNull();
    const button = screen.getByRole('button', { name: ACCOUNT_COPY.doneLabel });
    await waitFor(() => expect(button).toHaveFocus());
    expect(JSON.parse(window.sessionStorage.getItem(DELETION_NOTICE_KEY)!)).toEqual({
      apple: 'none',
      hadApple: false,
    });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(signOut).toHaveBeenCalledExactlyOnceWith({ scope: 'local' });
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("an Apple account the web couldn't revoke gets the web's Apple-left line", async () => {
    deleteAnswer = async () => json(200, { deleted: true, apple: 'not_revoked' });
    mount({ ...PLAIN, appleIds: ['001234.dsul.0001'] });
    await ready();
    await confirmDelete();
    expect(await screen.findByTestId('delete-account-done')).toHaveTextContent(ACCOUNT_COPY.appleLeftWeb);
  });

  it('Escape does what Done does', async () => {
    mount();
    await ready();
    await confirmDelete();
    await screen.findByTestId('delete-account-done');
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    });
    expect(signOut).toHaveBeenCalledExactlyOnceWith({ scope: 'local' });
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('leaving any other way still signs out: browser Back unmounts it with no handler', async () => {
    const view = mount();
    await ready();
    await confirmDelete();
    await screen.findByTestId('delete-account-done');
    expect(signOut).not.toHaveBeenCalled();
    view.unmount();
    expect(signOut).toHaveBeenCalledExactlyOnceWith({ scope: 'local' });
  });

  it('Done and then the unmount it brings sign out once', async () => {
    const view = mount();
    await ready();
    await confirmDelete();
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: ACCOUNT_COPY.doneLabel }));
    });
    view.unmount();
    expect(signOut).toHaveBeenCalledExactlyOnceWith({ scope: 'local' });
  });

  it('a sign-out that fails still goes to /login', async () => {
    const replace = vi.spyOn(signedOutNav, 'replace').mockImplementation(() => {});
    signOut.mockResolvedValue({ error: new Error('offline') });
    mount();
    await ready();
    await confirmDelete();
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: ACCOUNT_COPY.doneLabel }));
    });
    expect(replace).toHaveBeenCalledWith('/login');
  });
});

describe('the other answers', () => {
  it('a 401 on open signs out at once', async () => {
    mount(json(401, { error: 'unauthorized' }));
    await waitFor(() => expect(signOut).toHaveBeenCalledExactlyOnceWith({ scope: 'local' }));
  });

  it('a 401 from the delete signs out at once', async () => {
    deleteAnswer = async () => json(401, { error: 'unauthorized' });
    mount();
    await ready();
    await confirmDelete();
    await waitFor(() => expect(signOut).toHaveBeenCalledExactlyOnceWith({ scope: 'local' }));
    expect(screen.queryByTestId('delete-account-done')).toBeNull();
  });

  it('a 410 on open shows the deleted line and Done, and leaves the note', async () => {
    mount(json(410, { error: 'gone' }));
    const done = await screen.findByTestId('delete-account-done');
    expect(done).toHaveTextContent(ACCOUNT_COPY.deleted);
    expect(screen.getByRole('button', { name: ACCOUNT_COPY.doneLabel })).toBeInTheDocument();
    expect(JSON.parse(window.sessionStorage.getItem(DELETION_NOTICE_KEY)!)).toEqual({
      apple: 'unknown',
      hadApple: false,
    });
    expect(deleteCalls()).toHaveLength(0);
  });

  it('a 409 shows the changed line, and Delete stays off until it is opened again', async () => {
    deleteAnswer = async () => json(409, { error: 'changed' });
    const view = mount();
    await ready();
    await confirmDelete();
    const line = await screen.findByTestId('delete-account-error');
    expect(line).toHaveAttribute('role', 'alert');
    expect(line).toHaveTextContent(ACCOUNT_COPY.changed);
    expect(submit()).toBeDisabled();
    type('delete');
    expect(submit()).toBeDisabled();

    // Closed and opened again: a fresh read of whoever is signed in now.
    view.rerender(<DeleteAccountDialog open={false} onOpenChange={onOpenChange} />);
    view.rerender(<DeleteAccountDialog open onOpenChange={onOpenChange} />);
    await ready();
    expect(field().value).toBe('');
    expect(screen.queryByTestId('delete-account-error')).toBeNull();
    type('DELETE');
    expect(submit()).toBeEnabled();
  });

  it.each([
    [503, 'unavailable', ACCOUNT_COPY.unreachable],
    [500, 'failed', ACCOUNT_COPY.failed],
  ])('a %i shows its line as an alert, keeps the text, and the dialog stays', async (status, error, words) => {
    deleteAnswer = async () => json(status, { error });
    mount();
    await ready();
    await confirmDelete();
    const line = await screen.findByTestId('delete-account-error');
    expect(line).toHaveAttribute('role', 'alert');
    expect(line).toHaveTextContent(words);
    expect(field().value).toBe('DELETE');
    expect(submit()).toBeEnabled();
    expect(submit()).toHaveTextContent(ACCOUNT_COPY.deleteLabel);
    expect(screen.getByTestId('delete-account-dialog')).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(DELETION_NOTICE_KEY)).toBeNull();
  });

  it('a fetch that throws on Delete is the unreachable line', async () => {
    deleteAnswer = async () => {
      throw new TypeError('Failed to fetch');
    };
    mount();
    await ready();
    await confirmDelete();
    expect(await screen.findByTestId('delete-account-error')).toHaveTextContent(ACCOUNT_COPY.unreachable);
  });

  it('facts that fail show the unreachable line and Try again, which asks again', async () => {
    mount(json(503, { error: 'unavailable' }));
    const line = await screen.findByTestId('delete-account-error');
    expect(line).toHaveTextContent(ACCOUNT_COPY.unreachable);
    expect(submit()).toBeDisabled();

    factsAnswer = async () => json(200, PLAIN);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });
    await ready();
    expect(screen.queryByTestId('delete-account-error')).toBeNull();
    expect(screen.getByTestId('delete-account-account')).toBeInTheDocument();
  });

  it('Cancel closes it and deletes nothing', async () => {
    mount();
    await ready();
    type('DELETE');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(deleteCalls()).toHaveLength(0);
    expect(signOut).not.toHaveBeenCalled();
  });

  it('unmounting before any deletion signs nobody out', async () => {
    const view = mount();
    await ready();
    view.unmount();
    expect(signOut).not.toHaveBeenCalled();
  });

  it('unmounting after a failed delete signs nobody out', async () => {
    deleteAnswer = async () => json(500, { error: 'failed' });
    const view = mount();
    await ready();
    await confirmDelete();
    await screen.findByTestId('delete-account-error');
    view.unmount();
    expect(signOut).not.toHaveBeenCalled();
  });
});
