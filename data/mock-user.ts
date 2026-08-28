import type { User } from '@/types/user';

/**
 * Stands in for the signed-in user until authentication exists.
 * Replaced by the Supabase session in a later phase.
 */
export const MOCK_USER: User = {
  name: 'Khelil',
  email: 'khelil@example.com',
};
