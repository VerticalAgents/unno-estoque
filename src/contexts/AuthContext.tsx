import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { User } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import type { Usuario } from '../types/database.types'

export type PermissoesPapel = Record<string, string[]>

interface AuthContextValue {
  user: User | null
  profile: Usuario | null
  permissoes: PermissoesPapel
  loading: boolean
  logout: () => Promise<void>
  reloadProfile: () => Promise<void>
  reloadPermissoes: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [profile, setProfile] = useState<Usuario | null>(null)
  const [permissoes, setPermissoes] = useState<PermissoesPapel>({})
  const [loading, setLoading] = useState(true)

  async function loadProfile(uid: string) {
    const { data } = await supabase
      .from('usuarios')
      .select('*')
      .eq('id', uid)
      .single()
    if (data) {
      const prof = data as Usuario
      setProfile(prof)
      await loadPermissoes(prof.empresa_id)
    }
  }

  async function loadPermissoes(empresaId: string) {
    const { data } = await supabase
      .from('permissoes_papel')
      .select('papel, rotas')
      .eq('empresa_id', empresaId)

    if (data) {
      const map: PermissoesPapel = {}
      for (const row of data as { papel: string; rotas: string[] }[]) {
        map[row.papel] = row.rotas
      }
      setPermissoes(map)
    }
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null)
      if (session?.user) {
        loadProfile(session.user.id).finally(() => setLoading(false))
      } else {
        setLoading(false)
      }
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
      if (session?.user) {
        loadProfile(session.user.id)
      } else {
        setProfile(null)
        setPermissoes({})
      }
    })

    return () => subscription.unsubscribe()
  }, [])

  async function reloadProfile() {
    if (!user) return
    const { data } = await supabase.from('usuarios').select('*').eq('id', user.id).single()
    if (data) setProfile(data as Usuario)
  }

  async function reloadPermissoes() {
    if (!profile) return
    await loadPermissoes(profile.empresa_id)
  }

  async function logout() {
    await supabase.auth.signOut()
    setUser(null)
    setProfile(null)
    setPermissoes({})
  }

  return (
    <AuthContext.Provider value={{ user, profile, permissoes, loading, logout, reloadProfile, reloadPermissoes }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
