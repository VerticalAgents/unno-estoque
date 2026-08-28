import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
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

  /**
   * Quem está logado agora, guardado fora do estado.
   *
   * É o que permite reconhecer um evento de sessão que não mudou nada.
   */
  const idAtual = useRef<string | null>(null)

  /**
   * Aplica uma sessão — e SÓ quando ela troca de pessoa.
   *
   * O Supabase renova o token sozinho, e dispara `TOKEN_REFRESHED` sempre que a
   * aba volta a ficar visível. Quem estava no terminal e voltou para o
   * navegador recebia esse evento. A sessão é a mesma, mas `session.user` e o
   * perfil recarregado são OBJETOS NOVOS — e em React objeto novo é mudança.
   *
   * O estrago acontecia longe daqui: toda tela que carrega dados com
   * `useCallback([... profile])` via a identidade do perfil mudar, refazia a
   * consulta e sobrescrevia o que estava na tela. No Planejador isso apagava a
   * semana inteira que ainda não tinha sido salva.
   *
   * Comparar o id resolve na origem: token renovado não mexe em nada, entrar e
   * sair continuam funcionando.
   */
  async function aplicarSessao(session: { user: User } | null) {
    const novoId = session?.user?.id ?? null
    if (novoId === idAtual.current) return

    idAtual.current = novoId
    setUser(session?.user ?? null)

    if (session?.user) {
      await loadProfile(session.user.id)
    } else {
      setProfile(null)
      setPermissoes({})
    }
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      aplicarSessao(session).finally(() => setLoading(false))
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => { aplicarSessao(session) },
    )

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

  /**
   * Sair. A ordem aqui não é detalhe.
   *
   * O estado local é limpo ANTES de falar com o servidor, e `idAtual` volta a
   * ser nulo junto. Esperar a rede primeiro deixava dois buracos numa fábrica
   * com wi-fi irregular: se `signOut` demorasse, a tela ficava parada como se o
   * toque não tivesse acontecido; se falhasse, a pessoa continuava logada sem
   * nenhum aviso.
   *
   * `idAtual` é o que faz `aplicarSessao` ignorar sessão repetida. Sem zerá-lo
   * aqui, uma saída que falhasse na rede deixaria o id antigo guardado — e o
   * próximo login DA MESMA PESSOA seria tratado como "nada mudou", com o app
   * preso na tela de carregamento.
   *
   * O erro do `signOut` é engolido de propósito: o token expira sozinho, e não
   * há nada de útil a fazer com quem já saiu da tela.
   */
  async function logout() {
    idAtual.current = null
    setUser(null)
    setProfile(null)
    setPermissoes({})
    try { await supabase.auth.signOut() } catch { /* já saiu daqui */ }
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
