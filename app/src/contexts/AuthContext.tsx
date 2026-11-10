import React, { createContext, useContext, useEffect, useState } from 'react';
import { Session, User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import type { Gender } from '../lib/genderText';

type AuthContextType = {
  session: Session | null;
  user: User | null;
  loading: boolean;
  /** Género del usuario logueado (una sola consulta por sesión). null mientras carga o sin sesión. */
  gender: Gender | null;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  /** needsEmailConfirmation: la cuenta se creó pero no hay sesión (el proyecto exige confirmar el email). */
  signUp: (
    email: string,
    password: string,
    gender: Gender,
    birthDate: string
  ) => Promise<{ error: string | null; needsEmailConfirmation: boolean }>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [gender, setGender] = useState<Gender | null>(null);
  const userId = user?.id ?? null;

  // Género propio: se pide una vez por usuario (para textos como "Estás inscripto/a"), no por pantalla.
  useEffect(() => {
    if (!userId) {
      setGender(null);
      return;
    }
    let cancelled = false;
    void supabase
      .from('users')
      .select('gender')
      .eq('id', userId)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) setGender(((data as { gender?: Gender | null } | null)?.gender ?? null) as Gender | null);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
    });

    // Escuchar cambios en autenticación (login/logout)
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      setUser(session?.user ?? null);
    });

    return () => subscription.unsubscribe();
  }, []);

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    return { error: error?.message ?? null };
  };

  const signUp = async (email: string, password: string, gender: Gender, birthDate: string) => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          gender,
          birth_date: birthDate,
        },
      },
    });
    return { error: error?.message ?? null, needsEmailConfirmation: !error && !data?.session };
  };

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider
      value={{ session, user, loading, gender, signIn, signUp, signOut }}
    >
      {children}
    </AuthContext.Provider>
  );
}

/** Género del espectador (el usuario logueado). */
export function useMyGender(): Gender | null {
  return useAuth().gender;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth debe usarse dentro de AuthProvider');
  }
  return context;
}