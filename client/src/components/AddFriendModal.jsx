import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { keys } from '../hooks/queries.js';
import { ErrorNote, Modal, Spinner } from './ui.jsx';

export function AddFriendModal({ open, onClose }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [added, setAdded] = useState(null);

  const addFriend = useMutation({
    mutationFn: (body) => api.post('/users/friends', body),
    onSuccess: (data) => {
      setAdded(data.friend);
      setEmail('');
      qc.invalidateQueries({ queryKey: keys.friends });
    },
  });

  function close() {
    setEmail('');
    setAdded(null);
    addFriend.reset();
    onClose();
  }

  return (
    <Modal open={open} onClose={close} title="Add a friend">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          addFriend.mutate({ handle: email.trim() });
        }}
        className="space-y-4 p-5"
      >
        <div>
          <label className="label" htmlFor="friend-email">Username or email</label>
          <input
            id="friend-email"
            required
            autoFocus
            className="input"
            placeholder="@rahul"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setAdded(null);
            }}
          />
          <p className="mt-1 text-xs text-fg-subtle">
            They need a Splitwise account already — ask them for their @username.
          </p>
        </div>

        {added && (
          <p className="rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent-soft-fg">
            Added {added.name} (@{added.username}). You can now split expenses with them.
          </p>
        )}
        <ErrorNote error={addFriend.error} />

        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={close}>
            Done
          </button>
          <button type="submit" className="btn-primary" disabled={addFriend.isPending}>
            {addFriend.isPending ? <Spinner className="border-white/40 border-t-white" /> : 'Add friend'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
