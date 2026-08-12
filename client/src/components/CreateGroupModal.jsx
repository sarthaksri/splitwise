import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCreateGroup, useFriends } from '../hooks/queries.js';
import { Avatar, ErrorNote, Modal, Spinner } from './ui.jsx';

const GROUP_TYPES = [
  { value: 'trip', label: 'Trip', icon: '✈️' },
  { value: 'home', label: 'Home', icon: '🏠' },
  { value: 'couple', label: 'Couple', icon: '💑' },
  { value: 'other', label: 'Other', icon: '📁' },
];

export function CreateGroupModal({ open, onClose }) {
  const navigate = useNavigate();
  const createGroup = useCreateGroup();
  const { data: friendsData } = useFriends();
  const [name, setName] = useState('');
  const [type, setType] = useState('trip');
  const [selected, setSelected] = useState([]);

  const friends = friendsData?.friends ?? [];

  function close() {
    setName('');
    setType('trip');
    setSelected([]);
    createGroup.reset();
    onClose();
  }

  async function onSubmit(e) {
    e.preventDefault();
    const result = await createGroup.mutateAsync({ name, type, memberIds: selected });
    close();
    navigate(`/groups/${result.group._id}`);
  }

  return (
    <Modal open={open} onClose={close} title="Create a group">
      <form onSubmit={onSubmit} className="space-y-4 p-5">
        <div>
          <label className="label" htmlFor="group-name">Group name</label>
          <input
            id="group-name"
            required
            autoFocus
            className="input"
            placeholder="Goa Trip, Flat 402, …"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div>
          <span className="label">Type</span>
          <div className="grid grid-cols-4 gap-2">
            {GROUP_TYPES.map((t) => (
              <button
                key={t.value}
                type="button"
                onClick={() => setType(t.value)}
                className={`flex flex-col items-center gap-1 rounded-lg border px-2 py-2.5 text-xs font-medium transition ${
                  type === t.value
                    ? 'border-brand-500 bg-accent-soft text-accent-soft-fg'
                    : 'border-line text-fg-muted hover:bg-hover'
                }`}
              >
                <span className="text-lg" aria-hidden="true">{t.icon}</span>
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <span className="label">Add people</span>
          {friends.length === 0 ? (
            <p className="rounded-lg bg-sunken px-3 py-2.5 text-sm text-fg-muted">
              Nobody to add yet. Create the group, then invite people by email from the
              group page.
            </p>
          ) : (
            <div className="scrollbar-thin max-h-48 space-y-1 overflow-y-auto rounded-lg border border-line p-1.5">
              {friends.map((friend) => {
                const checked = selected.includes(friend.id);
                return (
                  <label
                    key={friend.id}
                    className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-hover"
                  >
                    <input
                      type="checkbox"
                      className="size-4 accent-brand-500"
                      checked={checked}
                      onChange={() =>
                        setSelected((prev) =>
                          checked ? prev.filter((id) => id !== friend.id) : [...prev, friend.id],
                        )
                      }
                    />
                    <Avatar user={friend} size={28} />
                    <span className="text-sm text-fg">
                      {friend.name}
                      {friend.username && (
                        <span className="ml-1 text-xs text-fg-subtle">@{friend.username}</span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </div>

        <ErrorNote error={createGroup.error} />

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn-secondary" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={createGroup.isPending}>
            {createGroup.isPending ? <Spinner className="border-white/40 border-t-white" /> : 'Create group'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
