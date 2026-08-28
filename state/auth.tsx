import type { Session } from '@supabase/supabase-js';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import type { User } from '@/types/user';

export type AuthStatus = 'loading' | 'signedIn' | 'signedOut';

export type AuthResult = {
  /** French, user-facing. `null` when the call succeeded. */
  error: string | null;
  /** True when Supabase requires the email to be confirmed before signing in. */
  needsEmailConfirmation?: boolean;
};

type AuthContextValue = {
  status: AuthStatus;
  session: Session | null;
  /** The signed-in user reduced to what the UI shows. */
  user: User | null;
  /** False when no Supabase credentials are configured. */
  isConfigured: boolean;
  signIn: (email: string, password: string) => Promise<AuthResult>;
  signUp: (firstName: string, email: string, password: string) => Promise<AuthResult>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

const NOT_CONFIGURED: AuthResult = {
  error: "La connexion n'est pas encore configurée sur cette application.",
};

/**
 * Supabase session, shared by the whole app.
 *
 * Email and password only for V1 — no social providers, no magic links. The
 * session is restored at start-up and kept in sync through
 * `onAuthStateChange`, so a sign-in or sign-out anywhere updates every screen.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<AuthStatus>(
    isSupabaseConfigured ? 'loading' : 'signedOut'
  );

  useEffect(() => {
    if (!supabase) {
      return;
    }

    let active = true;

    void supabase.auth.getSession().then(({ data }) => {
      if (!active) {
        return;
      }
      setSession(data.session);
      setStatus(data.session ? 'signedIn' : 'signedOut');
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setStatus(nextSession ? 'signedIn' : 'signedOut');
    });

    return () => {
      active = false;
      subscription.subscription.unsubscribe();
    };
  }, []);

  const user = useMemo<User | null>(() => {
    if (!session?.user) {
      return null;
    }
    const metadata = session.user.user_metadata as { first_name?: unknown } | null;
    const firstName = typeof metadata?.first_name === 'string' ? metadata.first_name : '';
    const email = session.user.email ?? '';
    return {
      // Fall back to the local part of the email when no name was given.
      name: firstName.trim() || email.split('@')[0] || 'Compte',
      email,
    };
  }, [session]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      session,
      user,
      isConfigured: isSupabaseConfigured,

      signIn: async (email, password) => {
        if (!supabase) {
          return NOT_CONFIGURED;
        }
        const { error } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        return { error: error ? translateAuthError(error.message) : null };
      },

      signUp: async (firstName, email, password) => {
        if (!supabase) {
          return NOT_CONFIGURED;
        }
        const { data, error } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: { data: { first_name: firstName.trim() } },
        });
        if (error) {
          return { error: translateAuthError(error.message) };
        }
        // Supabase returns a user without a session when email confirmation
        // is switched on for the project.
        return { error: null, needsEmailConfirmation: data.session === null };
      },

      signOut: async () => {
        if (!supabase) {
          return;
        }
        await supabase.auth.signOut();
      },
    }),
    [status, session, user]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (context === null) {
    throw new Error('useAuth must be called inside an AuthProvider');
  }
  return context;
}

/**
 * Supabase returns English messages. Map the ones a user actually hits and
 * fall back to something calm rather than leaking a raw API string.
 */
function translateAuthError(message: string): string {
  const normalized = message.toLowerCase();

  if (normalized.includes('invalid login credentials')) {
    return 'Email ou mot de passe incorrect.';
  }
  if (normalized.includes('already registered') || normalized.includes('already been registered')) {
    return 'Un compte existe déjà avec cet email.';
  }
  if (normalized.includes('password should be at least')) {
    return 'Le mot de passe doit contenir au moins 6 caractères.';
  }
  if (normalized.includes('unable to validate email') || normalized.includes('invalid email')) {
    return 'Cet email ne semble pas valide.';
  }
  if (normalized.includes('email not confirmed')) {
    return 'Confirme ton email avant de te connecter.';
  }
  if (normalized.includes('network') || normalized.includes('fetch')) {
    return 'Connexion impossible. Vérifie ta connexion internet.';
  }
  return 'Une erreur est survenue. Réessaie dans un instant.';
}
