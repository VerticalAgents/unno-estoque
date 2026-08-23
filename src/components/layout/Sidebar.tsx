import { NavLink, useLocation } from 'react-router-dom'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { canAccess } from '../../lib/permissions'

export interface NavItem {
  to: string
  label: string
  icon: ReactNode
  exact?: boolean
  /** Sub-rotas que têm item próprio no menu e não devem acender este.
   *  Ex: /producao/planejador não pode acender "Produção" junto. */
  exceto?: string[]
}

const CAT_PRINCIPAIS: NavItem[] = [
  {
    to: '/dashboard',
    label: 'Dashboard',
    exact: true,
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" />
      </svg>
    ),
  },
  {
    to: '/reabastecimento',
    label: 'Reabastecimento',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 3h1.386c.51 0 .955.343 1.087.835l.383 1.437M7.5 14.25a3 3 0 00-3 3h15.75m-12.75-3h11.218c1.121-2.3 2.1-4.684 2.924-7.138a60.114 60.114 0 00-16.536-1.84M7.5 14.25L5.106 5.272M6 20.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm12.75 0a.75.75 0 11-1.5 0 .75.75 0 011.5 0z" />
      </svg>
    ),
  },
  {
    to: '/recebimento',
    label: 'Recebimento',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 3.75H6.912a2.25 2.25 0 00-2.15 1.588L2.35 13.177a2.25 2.25 0 00-.1.661V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18v-4.162c0-.224-.034-.447-.1-.661L19.24 5.338a2.25 2.25 0 00-2.15-1.588H15M2.25 13.5h3.86a2.251 2.251 0 011.591.659l.182.182a2.251 2.251 0 001.591.659h2.052a2.252 2.252 0 001.591-.659l.182-.182a2.251 2.251 0 011.591-.659h3.86M12 3v8.25m0 0l-3-3m3 3l3-3" />
      </svg>
    ),
  },
  {
    to: '/transferencia',
    label: 'Transferência',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
      </svg>
    ),
  },
  {
    to: '/producao/planejador',
    label: 'Planejador',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5M12 12.75h.008v.008H12v-.008zM12 15h.008v.008H12V15zm0 2.25h.008v.008H12v-.008zM9.75 15h.008v.008H9.75V15zm0 2.25h.008v.008H9.75v-.008zM7.5 15h.008v.008H7.5V15zm0 2.25h.008v.008H7.5v-.008zm6.75-4.5h.008v.008h-.008v-.008zm0 2.25h.008v.008h-.008V15zm0 2.25h.008v.008h-.008v-.008zm2.25-4.5h.008v.008H16.5v-.008zm0 2.25h.008v.008H16.5V15z" />
      </svg>
    ),
  },
  {
    to: '/producao',
    label: 'Produção',
    exceto: ['/producao/planejador'],
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23-.693L5 14.5m14.8.8l1.402 1.402c1 1 .23 2.717-1.07 2.717H3.868c-1.3 0-2.07-1.716-1.07-2.716L4.198 15.3" />
      </svg>
    ),
  },
  {
    to: '/pos-producao',
    label: 'Pós-produção',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" />
      </svg>
    ),
  },
  {
    to: '/expedicao',
    label: 'Expedição',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 18.75a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m3 0h6m-9 0H3.375a1.125 1.125 0 01-1.125-1.125V14.25m17.25 4.5a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m3 0h1.125c.621 0 1.129-.504 1.09-1.124a17.902 17.902 0 00-3.213-9.193 2.056 2.056 0 00-1.58-.86H14.25M16.5 18.75h-2.25m0-11.177v-.958c0-.568-.422-1.048-.987-1.106a48.554 48.554 0 00-10.026 0 1.106 1.106 0 00-.987 1.106v7.635m12-6.677v6.677m0 4.5v-4.5m0 0h-12" />
      </svg>
    ),
  },
  {
    to: '/perdas',
    label: 'Perdas',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
      </svg>
    ),
  },
  {
    to: '/contagem',
    label: 'Contagem',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
      </svg>
    ),
  },
  {
    to: '/rastreabilidade',
    label: 'Rastreabilidade',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5m-9-6h.008v.008H12v-.008z" />
      </svg>
    ),
  },
  {
    to: '/relatorios',
    label: 'Relatórios',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
      </svg>
    ),
  },
]

const CAT_CADASTROS: NavItem[] = [
  {
    to: '/insumos',
    label: 'Cadastro de insumos',
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
      </svg>
    ),
  },
  {
    to: '/fornecedores',
    label: 'Fornecedores',
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 18.75a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m3 0h6m-9 0H3.375a1.125 1.125 0 01-1.125-1.125V14.25m17.25 4.5a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m3 0h1.125c.621 0 1.129-.504 1.09-1.124a17.902 17.902 0 00-3.213-9.193 2.056 2.056 0 00-1.58-.86H14.25M16.5 18.75h-2.25m0-11.177v-.958c0-.568-.422-1.048-.987-1.106a48.554 48.554 0 00-10.026 0 1.106 1.106 0 00-.987 1.106v7.635m12-6.677v6.677m0 4.5v-4.5m0 0h-12" />
      </svg>
    ),
  },
  {
    to: '/fichas',
    label: 'Fichas Técnicas',
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25zM6.75 12h.008v.008H6.75V12zm0 3h.008v.008H6.75V15zm0 3h.008v.008H6.75V18z" />
      </svg>
    ),
  },
  {
    to: '/produtos',
    // "Produtos" aparecia em Cadastros e em Estoque; lado a lado no menu de
    // baixo, ninguém sabia qual era qual.
    label: 'Cadastro de produtos',
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M21 7.5l-9-5.25L3 7.5m18 0l-9 5.25m9-5.25v9l-9 5.25M3 7.5l9 5.25M3 7.5v9l9 5.25m0-9v9" />
      </svg>
    ),
  },
  {
    to: '/recipientes',
    label: 'Recipientes',
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" />
      </svg>
    ),
  },
]

const CAT_ESTOQUE: NavItem[] = [
  {
    to: '/estoque/insumos',
    label: 'Estoque de insumos',
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
      </svg>
    ),
  },
  {
    to: '/estoque/produtos',
    label: 'Estoque de produtos',
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M21 7.5l-9-5.25L3 7.5m18 0l-9 5.25m9-5.25v9l-9 5.25M3 7.5l9 5.25M3 7.5v9l9 5.25m0-9v9" />
      </svg>
    ),
  },
  {
    to: '/estoque/historico',
    label: 'Histórico',
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
      </svg>
    ),
  },
]

/**
 * OS GRUPOS.
 *
 * Dezenove itens soltos não cabem numa coluna sem rolagem, e deitados não cabem
 * num cabeçalho sem rolagem horizontal. O corte não é por o que a coisa É, e sim
 * por QUANDO se usa — foi assim que 16 linhas viraram 6.
 *
 * Operação segue a ordem física da matéria-prima pela fábrica: chega,
 * distribui, enche o balde, planeja o dia, produz, desenforma, expede. Menu que
 * acompanha o caminho real se aprende uma vez; em ordem alfabética, nunca.
 *
 * Transferência e Reabastecimento ficam aqui, e não em Estoque, por decisão do
 * usuário: as duas acontecem no meio do turno, pelas mesmas mãos que produzem.
 *
 * Cadastros fica por último de propósito — mexe-se nele uma vez por mês, e
 * antes ele dividia espaço visual com Produção, que se abre todo dia.
 */
export interface GrupoNav {
  chave: string
  titulo: string
  icone: ReactNode
  itens: NavItem[]
}

const doCatalogo = (...rotas: string[]): NavItem[] => {
  const mapa = new Map([...CAT_PRINCIPAIS, ...CAT_ESTOQUE, ...CAT_CADASTROS].map(i => [i.to, i]))
  return rotas.map(r => mapa.get(r)).filter((i): i is NavItem => Boolean(i))
}

const icone = (d: string) => (
  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    <path strokeLinecap="round" strokeLinejoin="round" d={d} />
  </svg>
)

/** Fora de grupo, no topo: é o destino de quem não sabe para onde ir. */
export const itemDashboard = doCatalogo('/dashboard')[0]

export const itemConfiguracoes: NavItem = {
  to: '/configuracoes',
  label: 'Configurações',
  icon: icone('M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z'),
}

export const gruposNav: GrupoNav[] = [
  {
    chave: 'operacao',
    titulo: 'Operação',
    icone: icone('M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23-.693L5 14.5m14.8.8l1.402 1.402c1 1 .23 2.717-1.07 2.717H3.868c-1.3 0-2.07-1.716-1.07-2.716L4.198 15.3'),
    itens: doCatalogo('/recebimento', '/transferencia', '/reabastecimento', '/producao/planejador', '/producao', '/pos-producao', '/expedicao'),
  },
  {
    chave: 'estoque',
    titulo: 'Estoque',
    icone: icone('M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z'),
    itens: doCatalogo('/estoque/insumos', '/estoque/produtos', '/contagem', '/estoque/historico'),
  },
  {
    chave: 'analise',
    titulo: 'Análise',
    icone: icone('M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z'),
    itens: doCatalogo('/perdas', '/rastreabilidade', '/relatorios'),
  },
  {
    chave: 'cadastros',
    titulo: 'Cadastros',
    icone: icone('M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z'),
    itens: doCatalogo('/insumos', '/fornecedores', '/fichas', '/produtos', '/recipientes'),
  },
]

/** Um grupo acende quando a rota atual é de algum filho dele. */
export function grupoAceso(grupo: GrupoNav, caminho: string): boolean {
  return grupo.itens.some(i => caminho.startsWith(i.to))
}

/** Item aceso: o mais específico ganha, senão /producao acenderia no planejador. */
export function itemAceso(item: NavItem, caminho: string): boolean {
  if (item.exact) return caminho === item.to
  return caminho.startsWith(item.to)
    && !(item.exceto ?? []).some(p => caminho.startsWith(p))
}


/**
 * A barra lateral, agora só do computador.
 *
 * No celular ela era aberta como gaveta pela esquerda; quem faz esse papel
 * hoje é o `MenuInferior`, que sobe de baixo — perto do polegar e de onde o
 * toque acontece.
 *
 * SEIS LINHAS, NÃO DEZESSEIS. Antes os doze itens de operação ficavam soltos no
 * topo e a coluna rolava. Agora só Dashboard e Configurações ficam soltos; o
 * resto mora nos quatro grupos, e o grupo da rota atual abre sozinho.
 */
export function Sidebar({ onRecolher }: { onRecolher?: () => void }) {
  const location = useLocation()
  const { profile, permissoes } = useAuth()
  const papel = profile?.papel ?? 'producao'

  // O papel do usuário some com itens inteiros — e grupo que ficou vazio não
  // deve aparecer só para dizer que está vazio.
  const grupos = gruposNav
    .map(g => ({ ...g, itens: g.itens.filter(i => canAccess(papel, i.to, permissoes)) }))
    .filter(g => g.itens.length > 0)

  const mostrarDashboard = canAccess(papel, itemDashboard.to, permissoes)
  const mostrarConfig = canAccess(papel, itemConfiguracoes.to, permissoes)

  /**
   * Quais grupos estão abertos.
   *
   * Nasce com o grupo da rota atual aberto e os outros fechados: quem chega em
   * Produção quer ver as irmãs de Produção, não Cadastros. Depois disso a
   * escolha é de quem clica — não reabrimos nada ao navegar, senão um grupo que
   * a pessoa fechou de propósito voltaria sozinho a cada página.
   */
  const [abertos, setAbertos] = useState<Set<string>>(
    () => new Set(gruposNav.filter(g => grupoAceso(g, location.pathname)).map(g => g.chave)),
  )

  const alternarGrupo = (chave: string) =>
    setAbertos(atual => {
      const novo = new Set(atual)
      if (novo.has(chave)) novo.delete(chave)
      else novo.add(chave)
      return novo
    })

  const classeLinha = (aceso: boolean) => [
    'flex items-center gap-3 px-3 py-2.5 rounded-controle text-[0.7rem] font-semibold',
    'uppercase tracking-[1px] transition-all duration-200 ease-out-expo',
    aceso
      ? 'bg-brand-500/12 text-brand-700 shadow-[inset_0_1px_0_#ffffffb3] dark:text-brand-400 dark:shadow-[inset_0_1px_0_#ffffff0f]'
      : 'text-areia-600 hover:bg-areia-100 hover:text-areia-950 dark:text-unno-muted dark:hover:bg-white/[.04] dark:hover:text-unno-text',
  ].join(' ')

  const classeIcone = (aceso: boolean) =>
    aceso ? 'text-brand-600 dark:text-brand-400' : 'text-areia-400 dark:text-unno-dim'

  const content = (
    // <div> e não <nav>: o <nav> agora é o bloco que envolve isto, e um
    // dentro do outro daria dois marcos de navegação para o leitor de tela.
    <div className="flex flex-col h-full">
      {/* Logo */}
      <div className="px-5 py-5 border-b border-areia-200 dark:border-white/[.06]">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-controle bg-brand-500 flex items-center justify-center shadow-botao">
            <span className="font-display text-white text-sm font-extrabold">U</span>
          </div>
          <div className="min-w-0">
            <p className="font-display text-sm font-extrabold uppercase tracking-[3px] text-areia-950 dark:text-brand-400 leading-none">
              Unno
            </p>
            <p className="text-[0.65rem] uppercase tracking-[1.5px] text-areia-500 dark:text-unno-dim mt-1">
              Estoque
            </p>
          </div>

          {/* Recolher: o menu vira cabeçalho e a tela ganha a largura toda. */}
          {onRecolher && (
            <button
              type="button"
              onClick={onRecolher}
              title="Recolher o menu"
              aria-label="Recolher o menu"
              className="ml-auto shrink-0 w-8 h-8 rounded-controle flex items-center justify-center
                         text-areia-500 hover:text-areia-950 hover:bg-areia-100
                         dark:text-unno-dim dark:hover:text-unno-text dark:hover:bg-white/[.04]
                         transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M18.75 19.5l-7.5-7.5 7.5-7.5M11.25 19.5l-7.5-7.5 7.5-7.5" />
              </svg>
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        {/* Dashboard, fora de grupo */}
        {mostrarDashboard && (
          <NavLink to={itemDashboard.to} className={classeLinha(itemAceso(itemDashboard, location.pathname))}>
            <span className={classeIcone(itemAceso(itemDashboard, location.pathname))}>{itemDashboard.icon}</span>
            {itemDashboard.label}
          </NavLink>
        )}

        {/* Os quatro grupos */}
        {grupos.map(grupo => {
          const aceso = grupoAceso(grupo, location.pathname)
          const aberto = abertos.has(grupo.chave)
          return (
            <div key={grupo.chave}>
              <button
                type="button"
                onClick={() => alternarGrupo(grupo.chave)}
                aria-expanded={aberto}
                className={`w-full ${classeLinha(aceso && !aberto)}`}
              >
                <span className={classeIcone(aceso)}>{grupo.icone}</span>
                <span className="flex-1 text-left">{grupo.titulo}</span>
                {/* A bolinha só aparece com o grupo fechado: aberto, o item
                    aceso já está à vista e o ponto seria ruído. */}
                {aceso && !aberto && (
                  <span className="w-1.5 h-1.5 rounded-full bg-brand-500 shrink-0" />
                )}
                <svg
                  className={['w-4 h-4 shrink-0 transition-transform duration-200', aberto ? 'rotate-180' : ''].join(' ')}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              {aberto && (
                <div className="mt-1 ml-4 pl-3 border-l border-areia-200 dark:border-white/[.06] space-y-1">
                  {grupo.itens.map(item => {
                    const filhoAceso = itemAceso(item, location.pathname)
                    return (
                      <NavLink
                        key={item.to}
                        to={item.to}
                        className={classeLinha(filhoAceso).replace('gap-3 px-3 py-2.5', 'gap-2.5 px-3 py-2')}
                      >
                        <span className={classeIcone(filhoAceso)}>{item.icon}</span>
                        {item.label}
                      </NavLink>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}

        {/* Configurações, fora de grupo */}
        {mostrarConfig && (
          <NavLink
            to={itemConfiguracoes.to}
            className={classeLinha(location.pathname.startsWith(itemConfiguracoes.to))}
          >
            <span className={classeIcone(location.pathname.startsWith(itemConfiguracoes.to))}>
              {itemConfiguracoes.icon}
            </span>
            {itemConfiguracoes.label}
          </NavLink>
        )}

        {/* Dev tools */}
        {papel === 'admin' && (
          <div className="pt-2 mt-2 border-t border-areia-200 dark:border-white/[.06]">
            <NavLink
              to="/dev"
              className={[
                'flex items-center gap-3 px-3 py-2.5 rounded-controle text-[0.7rem] font-semibold',
                'uppercase tracking-[1px] transition-all duration-200 ease-out-expo',
                location.pathname.startsWith('/dev')
                  ? 'bg-unno-amber/[.14] text-amber-800 dark:text-unno-amber'
                  : 'text-amber-700/80 hover:bg-unno-amber/[.10] hover:text-amber-800 dark:text-unno-amber/80 dark:hover:text-unno-amber',
              ].join(' ')}
            >
              <span className="text-unno-amber">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M11.42 15.17L17.25 21A2.652 2.652 0 0021 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 11-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 004.486-6.336l-3.276 3.277a3.004 3.004 0 01-2.25-2.25l3.276-3.276a4.5 4.5 0 00-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085m-1.745 1.437L5.909 7.5H4.5L2.25 3.75l1.5-1.5L7.5 4.5v1.409l4.26 4.26m-1.745 1.437l1.745-1.437m6.615 8.206L15.75 15.75M4.867 19.125h.008v.008h-.008v-.008z" />
                </svg>
              </span>
              Dev Tools
            </NavLink>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-5 py-4 border-t border-areia-200 dark:border-white/[.06]">
        <p className="text-[0.65rem] uppercase tracking-[1.5px] text-areia-500 dark:text-unno-dim">Unno</p>
        <p className="text-[0.65rem] uppercase tracking-[1.5px] text-areia-400 dark:text-unno-dim/60">Porto Alegre · RS</p>
      </div>
    </div>
  )

  return (
    // Só no computador: no celular quem abre é o MenuInferior.
    //
    // O <aside> é a moldura e não tem visual próprio; quem desenha é o bloco
    // de dentro. Separar os dois é o que permite ao bloco ter os quatro cantos
    // arredondados e uma sombra em volta — encostado na borda da tela, um
    // painel só mostra dois cantos e a sombra não tem para onde cair.
    //
    // w-60 (e não w-56): os rótulos em maiúsculas ocupam mais largura.
    <aside className="hidden lg:flex flex-col shrink-0 h-full py-3 pl-3">
      <nav className="flex flex-col h-full w-60 overflow-hidden rounded-bloco
                      bg-white border border-areia-200 shadow-bloco
                      dark:bg-unno-raised dark:border-white/[.06] dark:shadow-tactil-escuro">
        {content}
      </nav>
    </aside>
  )
}
