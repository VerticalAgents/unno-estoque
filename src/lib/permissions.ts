import type { PapelUsuario } from '../types/database.types'
import type { PermissoesPapel } from '../contexts/AuthContext'

// Fallback hardcoded (usado se permissões não carregaram do banco)
const defaultRoutes: Record<PapelUsuario, string[]> = {
  admin: ['*'],
  gestao: [
    '/dashboard', '/recebimento', '/transferencia', '/producao',
    '/expedicao', '/perdas', '/contagem', '/relatorios',
    '/estoque', '/insumos', '/fornecedores', '/fichas', '/produtos', '/recipientes',
    '/configuracoes',
  ],
  producao: [
    '/dashboard', '/transferencia', '/producao', '/contagem', '/estoque',
  ],
  compras: [
    '/dashboard', '/recebimento', '/estoque', '/contagem', '/perdas',
  ],
}

export function canAccess(papel: PapelUsuario, path: string, permissoes?: PermissoesPapel): boolean {
  const allowed = permissoes?.[papel] ?? defaultRoutes[papel]
  if (!allowed) return false
  if (allowed.includes('*')) return true
  return allowed.some(prefix => path === prefix || path.startsWith(prefix + '/'))
}

// Todas as rotas configuráveis do sistema
export const ALL_ROUTES = [
  { path: '/dashboard', label: 'Dashboard' },
  { path: '/recebimento', label: 'Recebimento' },
  { path: '/transferencia', label: 'Transferência' },
  { path: '/producao', label: 'Produção' },
  { path: '/expedicao', label: 'Expedição' },
  { path: '/perdas', label: 'Perdas' },
  { path: '/contagem', label: 'Contagem' },
  { path: '/relatorios', label: 'Relatórios' },
  { path: '/estoque', label: 'Estoque' },
  { path: '/insumos', label: 'Insumos' },
  { path: '/fornecedores', label: 'Fornecedores' },
  { path: '/fichas', label: 'Fichas Técnicas' },
  { path: '/produtos', label: 'Produtos' },
  { path: '/recipientes', label: 'Recipientes' },
  { path: '/configuracoes', label: 'Configurações' },
]
