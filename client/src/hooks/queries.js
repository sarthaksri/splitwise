import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';

export const keys = {
  summary: ['dashboard', 'summary'],
  groups: ['groups'],
  group: (id) => ['group', id],
  balances: (id) => ['group', id, 'balances'],
  expenses: (params) => ['expenses', params],
  settlements: (params) => ['settlements', params],
  friends: ['friends'],
  recurring: (groupId) => ['recurring', groupId ?? 'all'],
  recurringSummary: (groupId) => ['recurring', 'summary', groupId ?? 'all'],
};

export const useSummary = () =>
  useQuery({ queryKey: keys.summary, queryFn: () => api.get('/dashboard/summary') });

export const useGroups = () =>
  useQuery({ queryKey: keys.groups, queryFn: () => api.get('/groups') });

export const useGroup = (id) =>
  useQuery({
    queryKey: keys.group(id),
    queryFn: () => api.get(`/groups/${id}`),
    enabled: Boolean(id),
  });

export const useBalances = (id) =>
  useQuery({
    queryKey: keys.balances(id),
    queryFn: () => api.get(`/groups/${id}/balances`),
    enabled: Boolean(id),
  });

export const useExpenses = (params = {}) => {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v != null && v !== ''),
  ).toString();
  return useQuery({
    queryKey: keys.expenses(qs),
    queryFn: () => api.get(`/expenses${qs ? `?${qs}` : ''}`),
  });
};

export const useSettlements = (params = {}) => {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v != null && v !== ''),
  ).toString();
  return useQuery({
    queryKey: keys.settlements(qs),
    queryFn: () => api.get(`/settlements${qs ? `?${qs}` : ''}`),
  });
};

export const useFriends = () =>
  useQuery({ queryKey: keys.friends, queryFn: () => api.get('/users/friends') });

/**
 * Anything that moves money invalidates the same broad set of views, so they
 * all share one helper rather than each remembering the list.
 */
export function useInvalidateLedger() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['dashboard'] });
    qc.invalidateQueries({ queryKey: ['groups'] });
    qc.invalidateQueries({ queryKey: ['group'] });
    qc.invalidateQueries({ queryKey: ['expenses'] });
    qc.invalidateQueries({ queryKey: ['settlements'] });
    qc.invalidateQueries({ queryKey: ['recurring'] });
  };
}

export const useRecurring = (groupId) =>
  useQuery({
    queryKey: keys.recurring(groupId),
    queryFn: () => api.get(`/recurring${groupId ? `?group=${groupId}` : ''}`),
  });

export const useRecurringSummary = (groupId) =>
  useQuery({
    queryKey: keys.recurringSummary(groupId),
    queryFn: () => api.get(`/recurring/summary${groupId ? `?group=${groupId}` : ''}`),
  });

export function useSaveRecurring() {
  const invalidate = useInvalidateLedger();
  return useMutation({
    mutationFn: ({ id, ...body }) =>
      id ? api.patch(`/recurring/${id}`, body) : api.post('/recurring', body),
    onSuccess: invalidate,
  });
}

export function useDeleteRecurring() {
  const invalidate = useInvalidateLedger();
  return useMutation({
    mutationFn: (id) => api.delete(`/recurring/${id}`),
    onSuccess: invalidate,
  });
}

export function useSaveExpense() {
  const invalidate = useInvalidateLedger();
  return useMutation({
    mutationFn: ({ id, ...body }) =>
      id ? api.patch(`/expenses/${id}`, body) : api.post('/expenses', body),
    onSuccess: invalidate,
  });
}

export function useDeleteExpense() {
  const invalidate = useInvalidateLedger();
  return useMutation({
    mutationFn: (id) => api.delete(`/expenses/${id}`),
    onSuccess: invalidate,
  });
}

export function useSettleUp() {
  const invalidate = useInvalidateLedger();
  return useMutation({
    mutationFn: ({ id, ...body }) =>
      id ? api.patch(`/settlements/${id}`, body) : api.post('/settlements', body),
    onSuccess: invalidate,
  });
}

export function useDeletePayment() {
  const invalidate = useInvalidateLedger();
  return useMutation({
    mutationFn: (id) => api.delete(`/settlements/${id}`),
    onSuccess: invalidate,
  });
}

export function useCreateGroup() {
  const invalidate = useInvalidateLedger();
  return useMutation({
    mutationFn: (body) => api.post('/groups', body),
    onSuccess: invalidate,
  });
}

export function useUpdateGroup(id) {
  const invalidate = useInvalidateLedger();
  return useMutation({
    mutationFn: (body) => api.patch(`/groups/${id}`, body),
    onSuccess: invalidate,
  });
}

export function useAddMember(id) {
  const invalidate = useInvalidateLedger();
  return useMutation({
    mutationFn: (body) => api.post(`/groups/${id}/members`, body),
    onSuccess: invalidate,
  });
}

/** Add a stand-in for someone who hasn't signed up. */
export function useAddPlaceholder(id) {
  const invalidate = useInvalidateLedger();
  return useMutation({
    mutationFn: (body) => api.post(`/groups/${id}/placeholders`, body),
    onSuccess: invalidate,
  });
}

/** Hand a stand-in's history to a real account once they've signed up. */
export function useLinkPlaceholder(id) {
  const invalidate = useInvalidateLedger();
  return useMutation({
    mutationFn: ({ placeholderId, handle }) =>
      api.post(`/groups/${id}/placeholders/${placeholderId}/link`, { handle }),
    onSuccess: invalidate,
  });
}
