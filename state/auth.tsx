import type { AuthError, Session } from '@supabase/supabase-js';
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
        if (error) {
          logAuthError('signIn', error);
          return { error: translateAuthError(error) };
        }
        return { error: null };
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
          logAuthError('signUp', error);
          return { error: translateAuthError(error) };
        }
        // Supabase returns a user without a session when email confirmation
        // is switched on for the project.
        return { error: null, needsEmailConfirmation: data.session === null };
      },

      signOut: async () => {
        if (!supabase) {
          return;
        }
        const { error } = await supabase.auth.signOut();
        if (error) {
          logAuthError('signOut', error);
        }
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
 * Logs the real Supabase failure during development.
 *
 * Deliberately limited to message, status, code and name. Never log the
 * password, the access or refresh token, the Supabase key, or the session.
 */
function logAuthError(action: 'signIn' | 'signUp' | 'signOut', error: AuthError): void {
  if (!__DEV__) {
    return;
  }
  console.warn(
    `[auth:${action}] ${error.name}: ${error.message} ` +
      `(status=${error.status ?? 'n/a'}, code=${error.code ?? 'n/a'})`
  );
}

/**
 * Supabase answers in English. Translate on the stable error code first and
 * only fall back to the message, which is free text and changes between
 * versions — matching on it alone silently collapsed distinct failures
 * (a rejected email, a bad API key) into one unhelpful message.
 */
function translateAuthError(error: AuthError): string {
  switch (error.code) {
    case 'invalid_credentials':
      return 'Email ou mot de passe incorrect.';
    case 'email_exists':
    case 'user_already_exists':
      return 'Un compte existe déjà avec cet email.';
    case 'weak_password':
      return 'Le mot de passe doit contenir au moins 6 caractères.';
    case 'email_address_invalid':
    case 'email_address_not_authorized':
      return 'Cet email ne semble pas valide. Essaie une autre adresse.';
    case 'email_not_confirmed':
      return 'Confirme ton email avant de te connecter.';
    case 'signup_disabled':
      return 'Les inscriptions sont désactivées sur ce projet.';
    case 'email_provider_disabled':
      return 'La connexion par email est désactivée sur ce projet.';
    case 'over_email_send_rate_limit':
    case 'over_request_rate_limit':
      return 'Trop de tentatives. Réessaie dans quelques minutes.';
    case 'validation_failed':
      return 'Vérifie les informations saisies.';
    default:
      break;
  }

  // Failures that arrive without a code, including a rejected API key.
  const message = error.message.toLowerCase();

  if (error.status === 401 || message.includes('invalid api key')) {
    return 'Clé Supabase invalide. Vérifie EXPO_PUBLIC_SUPABASE_ANON_KEY dans .env, puis relance avec --clear.';
  }
  if (message.includes('network') || message.includes('fetch')) {
    return 'Connexion impossible. Vérifie ta connexion internet.';
  }
  return 'Une erreur est survenue. Réessaie dans un instant.';
}
