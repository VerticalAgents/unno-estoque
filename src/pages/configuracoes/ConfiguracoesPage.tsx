import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import type { CategoriaInsumo, Empresa, Usuario } from '../../types/database.types'
import { Card } from '../../components/ui/Card'
import { Button } from '../../components/ui/Button'
import { Input, Select } from '../../components/ui/Input'
import { Badge } from '../../components/ui/Badge'
import { ALL_ROUTES } from '../../lib/permissions'
import { MotivosDescarteTab } from './MotivosDescarteTab'
import { EtiquetasTab } from './EtiquetasTab'

type Tab = 'perfil' | 'senha' | 'empresa' | 'funcionarios' | 'categorias' | 'producao' | 'etiquetas' | 'travas' | 'abertura'

/**
 * As regras que o sistema pode impor. Cada uma pode BLOQUEAR (recusa sempre)
 * ou AVISAR (deixa passar com justificativa escrita, que fica registrada).
 *
 * A descrição explica a consequência, não o mecanismo — quem configura precisa
 * saber o que perde ao afrouxar.
 */
const TRAVAS: { chave: string; titulo: string; descricao: string }[] = [
  {
    chave: 'marca_diferente',
    titulo: 'Misturar marcas no recipiente',
    descricao:
      'Duas marcas no mesmo pote tornam impossível dizer qual foi usada numa produção. Num recall, não dá para separar.',
  },
  {
    chave: 'segundo_lote_aberto',
    titulo: 'Abrir um segundo lote do mesmo insumo',
    descricao:
      'Mais de uma embalagem aberta ao mesmo tempo multiplica as pontas soltas no estoque e atrapalha o FEFO.',
  },
  {
    chave: 'excede_capacidade',
    titulo: 'Escanear mais do que cabe nos recipientes',
    descricao:
      'Impede levar para a produção lote que voltaria inteiro para o estoque. '
      + 'O limite é o espaço livre somado dos recipientes do insumo; o último lote '
      + 'pode passar, e é dele que sai a sobra.',
  },
  {
    chave: 'sessao_sem_insumo',
    titulo: 'Abrir produção sem insumo suficiente',
    descricao:
      'A produção começa e para no meio para abastecer. É o problema que o planejador existe para evitar.',
  },
  {
    chave: 'fefo',
    titulo: 'Deixar para trás o lote que está aberto',
    descricao:
      'Ao escanear no estoque central, o lote aberto do insumo tem que vir primeiro. '
      + 'Onde ele vai parar dentro dos recipientes não importa — o que não pode é ele '
      + 'ficar na prateleira enquanto embalagens fechadas são abertas.',
  },
]

const UFS = [
  'AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG',
  'PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO',
]

const PAPEIS: { value: string; label: string }[] = [
  { value: 'admin', label: 'Administrador' },
  { value: 'gestao', label: 'Gestão' },
  { value: 'producao', label: 'Produção' },
  { value: 'compras', label: 'Compras' },
]

export function ConfiguracoesPage() {
  const { profile } = useAuth()
  const isAdmin = profile?.papel === 'admin'

  const tabs: { key: Tab; label: string; adminOnly?: boolean }[] = [
    { key: 'perfil', label: 'Perfil' },
    { key: 'senha', label: 'Senha' },
    { key: 'empresa', label: 'Empresa' },
    { key: 'funcionarios', label: 'Funcionários', adminOnly: true },
    { key: 'categorias', label: 'Categorias' },
    { key: 'producao', label: 'Produção' },
    { key: 'etiquetas', label: 'Etiquetas' },
    { key: 'travas', label: 'Travas', adminOnly: true },
    { key: 'abertura', label: 'Abertura de estoque', adminOnly: true },
  ]

  const [activeTab, setActiveTab] = useState<Tab>('perfil')

  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900">Configurações</h1>
        <p className="text-sm text-gray-500 mt-0.5">Gerencie seu perfil, empresa e sistema</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-200 mb-6 overflow-x-auto">
        {tabs
          .filter(t => !t.adminOnly || isAdmin)
          .map(t => (
            <button
              key={t.key}
              onClick={() => setActiveTab(t.key)}
              className={[
                'px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition-colors -mb-px',
                activeTab === t.key
                  ? 'border-brand-600 text-brand-700'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300',
              ].join(' ')}
            >
              {t.label}
            </button>
          ))}
      </div>

      {activeTab === 'perfil' && <PerfilTab />}
      {activeTab === 'senha' && <SenhaTab />}
      {activeTab === 'empresa' && <EmpresaTab />}
      {activeTab === 'funcionarios' && isAdmin && <FuncionariosTab />}
      {activeTab === 'categorias' && <CategoriasTab />}
      {activeTab === 'producao' && (
        <div className="space-y-4">
          <ProducaoTab />
          <MotivosDescarteTab />
        </div>
      )}
      {activeTab === 'etiquetas' && <EtiquetasTab />}
      {activeTab === 'travas' && isAdmin && <TravasTab />}
      {activeTab === 'abertura' && isAdmin && <AberturaTab />}
    </div>
  )
}

// ── Perfil ──────────────────────────────────────────────────

// ── Produção ──────────────────────────────────────────────────

/**
 * Quantas unidades saem de uma forma, por produto.
 *
 * O dado não é global: cada ficha tem o seu, guardado na versão ativa
 * (`fichas_tecnicas_versoes.rendimento_fornada`). Esta aba só o traz para um
 * lugar fácil de achar — antes só dava para mexer criando uma versão nova da
 * ficha.
 *
 * Mudar aqui vale para os cálculos daqui para a frente. Sessões já fechadas
 * guardam o consumo do dia em que aconteceram e não são recalculadas.
 */
/**
 * A porta de entrada de quem está migrando a operação para o sistema.
 *
 * Fica em Configurações e não no Recebimento de propósito: saldo de abertura
 * não é compra, e misturar os dois na mesma tela é o começo de um relatório
 * de entradas que ninguém consegue explicar depois.
 */
function AberturaTab() {
  return (
    <Card className="p-5">
      <h2 className="font-semibold text-gray-900 mb-1">Abertura de estoque</h2>
      <p className="text-sm text-gray-600 mb-4">
        Para quem está começando a usar o sistema com estoque já existente. Você conta o que
        está na prateleira, pesa o que está nos baldes, e o sistema cria os lotes e as
        etiquetas com QR — sem precisar inventar um recebimento que nunca houve.
      </p>
      <ol className="text-sm text-gray-600 space-y-1.5 mb-4 list-decimal pl-5">
        <li>Confira antes se os insumos, as marcas e os recipientes já estão cadastrados.</li>
        <li>Conte o que está fora dos baldes.</li>
        <li>Pese o que está dentro deles.</li>
        <li>Imprima as etiquetas e cole nas embalagens.</li>
      </ol>
      <Link to="/configuracoes/abertura-estoque">
        <Button size="lg">Começar abertura de estoque</Button>
      </Link>
    </Card>
  )
}

function ProducaoTab() {
  const { profile } = useAuth()
  const [fichas, setFichas] = useState<
    { id: string; codigo: string; nome: string; versao_id: string; rendimento: string; peso: string; margem: string }[]
  >([])
  const [salvandoId, setSalvandoId] = useState<string | null>(null)
  const [okId, setOkId] = useState<string | null>(null)
  const [erro, setErro] = useState('')

  useEffect(() => {
    if (!profile) return
    supabase
      .from('fichas_tecnicas')
      .select('id, codigo, nome, versoes:fichas_tecnicas_versoes!inner(id, rendimento_fornada, peso_medio_g, perda_esperada_g_forma, ativa)')
      .eq('empresa_id', profile.empresa_id)
      .eq('ativo', true)
      .eq('tipo', 'produto')
      .order('codigo')
      .then(({ data }) => {
        const rows = (data ?? []) as unknown as {
          id: string; codigo: string; nome: string
          versoes: { id: string; rendimento_fornada: number | null; peso_medio_g: number | null; perda_esperada_g_forma: number | null; ativa: boolean }[]
        }[]
        setFichas(
          rows.flatMap(f => {
            const v = f.versoes.find(x => x.ativa)
            if (!v) return []
            return [{
              id: f.id, codigo: f.codigo, nome: f.nome, versao_id: v.id,
              rendimento: v.rendimento_fornada != null ? String(v.rendimento_fornada) : '',
              peso: v.peso_medio_g != null ? String(v.peso_medio_g) : '',
              margem: v.perda_esperada_g_forma != null ? String(Number(v.perda_esperada_g_forma)) : '50',
            }]
          }),
        )
      })
  }, [profile])

  async function salvar(fichaId: string) {
    const f = fichas.find(x => x.id === fichaId)
    if (!f) return
    setSalvandoId(fichaId)
    setErro('')

    const rendimento = parseInt(f.rendimento)
    if (!rendimento || rendimento < 1) {
      setErro(`${f.codigo}: informe um rendimento maior que zero.`)
      setSalvandoId(null)
      return
    }

    const peso = parseFloat(f.peso.replace(',', '.'))
    const margem = parseFloat(f.margem.replace(',', '.'))
    const { error } = await supabase
      .from('fichas_tecnicas_versoes')
      .update({
        rendimento_fornada: rendimento,
        peso_medio_g: Number.isFinite(peso) && peso > 0 ? peso : null,
        perda_esperada_g_forma: Number.isFinite(margem) && margem >= 0 ? margem : 50,
      })
      .eq('id', f.versao_id)

    setSalvandoId(null)
    if (error) { setErro(error.message); return }
    setOkId(fichaId)
    setTimeout(() => setOkId(null), 2000)
  }

  function setCampo(id: string, campo: 'rendimento' | 'peso' | 'margem', valor: string) {
    setFichas(s => s.map(f => (f.id === id ? { ...f, [campo]: valor } : f)))
  }

  return (
    <Card className="p-5">
      <h2 className="text-base font-semibold text-gray-900">Rendimento por forma</h2>
      <p className="text-sm text-gray-500 mt-0.5 mb-4">
        Quantas unidades saem de uma forma (fornada) de cada produto. É deste número
        que sai a conta de quantas formas o Reabastecimento precisa.
      </p>

      {fichas.length === 0 ? (
        <p className="text-sm text-gray-500">Nenhuma ficha de produto com versão ativa.</p>
      ) : (
        <div className="space-y-4">
          {fichas.map(f => (
            <div key={f.id} className="pb-4 border-b border-gray-100 last:border-0 last:pb-0">
              <p className="text-sm font-medium text-gray-900">
                <span className="text-gray-400 mr-1.5">{f.codigo}</span>{f.nome}
              </p>
              <div className="flex items-end gap-3 mt-2">
                <div className="w-32">
                  <label className="text-xs text-gray-500">Unidades por forma</label>
                  <input
                    type="number" min={1} step={1} inputMode="numeric"
                    value={f.rendimento}
                    onChange={e => setCampo(f.id, 'rendimento', e.target.value)}
                    className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-right
                               focus:outline-none focus:border-brand-500 focus:ring-[3px] focus:ring-brand-500/10"
                  />
                </div>
                <div className="w-32">
                  <label className="text-xs text-gray-500">Margem de perda (g/forma)</label>
                  <input
                    type="number" min={0} step="1" inputMode="decimal"
                    value={f.margem}
                    onChange={e => setCampo(f.id, 'margem', e.target.value)}
                    className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-right
                               focus:outline-none focus:border-brand-500 focus:ring-[3px] focus:ring-brand-500/10"
                  />
                </div>
                <div className="w-32">
                  <label className="text-xs text-gray-500">Peso médio (g)</label>
                  <input
                    type="number" min={0} step="0.1" inputMode="decimal"
                    value={f.peso}
                    onChange={e => setCampo(f.id, 'peso', e.target.value)}
                    className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-right
                               focus:outline-none focus:border-brand-500 focus:ring-[3px] focus:ring-brand-500/10"
                  />
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={salvandoId === f.id}
                  onClick={() => salvar(f.id)}
                >
                  {okId === f.id ? 'Salvo' : 'Salvar'}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {erro && (
        <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {erro}
        </div>
      )}

      <p className="mt-4 text-xs text-gray-500">
        Vale para os cálculos daqui para a frente. Sessões de produção já fechadas
        guardam o consumo do dia em que aconteceram e não mudam.
      </p>
    </Card>
  )
}

// ── Travas ────────────────────────────────────────────────────

function TravasTab() {
  const { profile } = useAuth()
  const [modos, setModos] = useState<Record<string, string>>({})
  const [salvando, setSalvando] = useState<string | null>(null)
  const [excecoes, setExcecoes] = useState<
    { id: string; chave: string; justificativa: string; created_at: string }[]
  >([])

  useEffect(() => {
    if (!profile) return
    supabase
      .from('travas_config')
      .select('chave, modo')
      .eq('empresa_id', profile.empresa_id)
      .then(({ data }) => {
        setModos(Object.fromEntries((data ?? []).map(t => [t.chave, t.modo])))
      })
    supabase
      .from('excecoes_registradas')
      .select('id, chave, justificativa, created_at')
      .eq('empresa_id', profile.empresa_id)
      .order('created_at', { ascending: false })
      .limit(10)
      .then(({ data }) => setExcecoes(data ?? []))
  }, [profile])

  async function alterar(chave: string, modo: string) {
    if (!profile) return
    setSalvando(chave)
    await supabase
      .from('travas_config')
      .upsert(
        { empresa_id: profile.empresa_id, chave, modo, updated_at: new Date().toISOString() },
        { onConflict: 'empresa_id,chave' },
      )
    setModos(m => ({ ...m, [chave]: modo }))
    setSalvando(null)
  }

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <h2 className="text-base font-semibold text-gray-900 dark:text-unno-text mb-1">
          Travas de operação
        </h2>
        <p className="text-sm text-gray-500 dark:text-unno-muted mb-4">
          <strong>Bloqueia</strong> recusa a ação sempre. <strong>Avisa</strong> deixa passar,
          mas exige uma explicação escrita, que fica registrada com o nome de quem fez.
        </p>

        <div className="space-y-3">
          {TRAVAS.map(t => {
            const modo = modos[t.chave] ?? 'avisa'
            return (
              <div
                key={t.chave}
                className="flex items-start justify-between gap-4 py-3 border-t border-gray-100 dark:border-white/[.08]"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-unno-text">{t.titulo}</p>
                  <p className="text-xs text-gray-500 dark:text-unno-muted mt-0.5">{t.descricao}</p>
                </div>
                <div className="flex shrink-0 rounded-lg border border-gray-300 dark:border-white/[.08] overflow-hidden">
                  {(['avisa', 'bloqueia'] as const).map(op => (
                    <button
                      key={op}
                      disabled={salvando === t.chave}
                      onClick={() => alterar(t.chave, op)}
                      className={[
                        'px-3 py-1.5 text-[0.65rem] font-semibold uppercase tracking-wide transition-colors',
                        modo === op
                          ? op === 'bloqueia'
                            ? 'bg-unno-danger/15 text-red-700 dark:text-unno-danger'
                            : 'bg-unno-amber/15 text-amber-700 dark:text-unno-amber'
                          : 'text-gray-400 hover:text-gray-600 dark:text-unno-dim',
                      ].join(' ')}
                    >
                      {op === 'bloqueia' ? 'Bloqueia' : 'Avisa'}
                    </button>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </Card>

      <Card className="p-5">
        <h2 className="text-base font-semibold text-gray-900 dark:text-unno-text mb-1">
          Exceções registradas
        </h2>
        <p className="text-sm text-gray-500 dark:text-unno-muted mb-3">
          Últimas vezes em que uma regra foi contrariada, e por quê.
        </p>
        {excecoes.length === 0 ? (
          <p className="text-sm text-gray-400 italic">Nenhuma exceção até agora.</p>
        ) : (
          <div className="space-y-2">
            {excecoes.map(e => (
              <div key={e.id} className="text-sm border-t border-gray-100 dark:border-white/[.08] pt-2">
                <p className="text-xs text-gray-400 dark:text-unno-dim">
                  {new Date(e.created_at).toLocaleString('pt-BR')} ·{' '}
                  {TRAVAS.find(t => t.chave === e.chave)?.titulo ?? e.chave}
                </p>
                <p className="text-gray-700 dark:text-unno-text">{e.justificativa}</p>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}

function PerfilTab() {
  const { profile, reloadProfile } = useAuth()
  const [nome, setNome] = useState(profile?.nome ?? '')
  const [sexo, setSexo] = useState(profile?.sexo ?? '')
  const [cpf, setCpf] = useState(profile?.cpf ?? '')
  const [celular, setCelular] = useState(profile?.celular ?? '')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  async function handleSave(e: FormEvent) {
    e.preventDefault()
    if (!profile) return
    setSaving(true)
    setMsg('')

    const { error } = await supabase.from('usuarios').update({
      nome: nome.trim(),
      sexo: sexo || null,
      cpf: cpf.trim() || null,
      celular: celular.trim() || null,
    }).eq('id', profile.id)

    if (error) {
      setMsg('Erro: ' + error.message)
    } else {
      await reloadProfile()
      setMsg('Perfil atualizado!')
    }
    setSaving(false)
  }

  return (
    <Card className="p-5">
      <h2 className="text-base font-semibold text-gray-900 mb-4">Dados Pessoais</h2>
      <form onSubmit={handleSave} className="space-y-4">
        <Input label="Nome" value={nome} onChange={e => setNome(e.target.value)} required />
        <Input label="Email" value={profile?.email ?? ''} disabled />
        <div className="grid grid-cols-2 gap-4">
          <Select label="Sexo" value={sexo} onChange={e => setSexo(e.target.value)}>
            <option value="">—</option>
            <option value="M">Masculino</option>
            <option value="F">Feminino</option>
            <option value="Outro">Outro</option>
          </Select>
          <Input label="CPF" value={cpf} onChange={e => setCpf(e.target.value)} placeholder="000.000.000-00" />
        </div>
        <Input label="Celular" value={celular} onChange={e => setCelular(e.target.value)} placeholder="(51) 99999-9999" />

        {msg && (
          <p className={`text-sm ${msg.startsWith('Erro') ? 'text-red-600' : 'text-emerald-600'}`}>{msg}</p>
        )}
        <Button type="submit" loading={saving}>Salvar</Button>
      </form>
    </Card>
  )
}

// ── Senha ──────────────────────────────────────────────────

function SenhaTab() {
  const [novaSenha, setNovaSenha] = useState('')
  const [confirmar, setConfirmar] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  async function handleSave(e: FormEvent) {
    e.preventDefault()
    setMsg('')

    if (novaSenha.length < 6) {
      setMsg('Erro: a senha deve ter pelo menos 6 caracteres.')
      return
    }
    if (novaSenha !== confirmar) {
      setMsg('Erro: as senhas não conferem.')
      return
    }

    setSaving(true)
    const { error } = await supabase.auth.updateUser({ password: novaSenha })

    if (error) {
      setMsg('Erro: ' + error.message)
    } else {
      setMsg('Senha alterada com sucesso!')
      setNovaSenha('')
      setConfirmar('')
    }
    setSaving(false)
  }

  return (
    <Card className="p-5">
      <h2 className="text-base font-semibold text-gray-900 mb-4">Alterar Senha</h2>
      <form onSubmit={handleSave} className="space-y-4 max-w-sm">
        <Input
          label="Nova senha"
          type="password"
          value={novaSenha}
          onChange={e => setNovaSenha(e.target.value)}
          placeholder="Mínimo 6 caracteres"
          required
        />
        <Input
          label="Confirmar nova senha"
          type="password"
          value={confirmar}
          onChange={e => setConfirmar(e.target.value)}
          placeholder="Repita a nova senha"
          required
        />
        {msg && (
          <p className={`text-sm ${msg.startsWith('Erro') ? 'text-red-600' : 'text-emerald-600'}`}>{msg}</p>
        )}
        <Button type="submit" loading={saving}>Alterar Senha</Button>
      </form>
    </Card>
  )
}

// ── Empresa ──────────────────────────────────────────────────

function EmpresaTab() {
  const { profile } = useAuth()
  const isAdmin = profile?.papel === 'admin'
  const [empresa, setEmpresa] = useState<Empresa | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    if (!profile) return
    supabase.from('empresas').select('*').eq('id', profile.empresa_id).single()
      .then(({ data }) => {
        setEmpresa(data as Empresa)
        setLoading(false)
      })
  }, [profile])

  function set(field: keyof Empresa, value: string) {
    setEmpresa(prev => prev ? { ...prev, [field]: value } : prev)
  }

  async function handleSave(e: FormEvent) {
    e.preventDefault()
    if (!empresa || !profile) return
    setSaving(true)
    setMsg('')

    const { error } = await supabase.from('empresas').update({
      nome: empresa.nome,
      cnpj: empresa.cnpj || null,
      email: empresa.email || null,
      telefone: empresa.telefone || null,
      endereco: empresa.endereco || null,
      cidade: empresa.cidade || null,
      estado: empresa.estado || null,
      cep: empresa.cep || null,
    }).eq('id', profile.empresa_id)

    if (error) {
      setMsg('Erro: ' + error.message)
    } else {
      setMsg('Dados da empresa atualizados!')
    }
    setSaving(false)
  }

  if (loading) return (
    <div className="flex justify-center py-8">
      <div className="w-5 h-5 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
    </div>
  )

  return (
    <Card className="p-5">
      <h2 className="text-base font-semibold text-gray-900 mb-4">Dados da Empresa</h2>
      {!isAdmin && (
        <p className="text-xs text-amber-600 mb-4">Somente administradores podem editar os dados da empresa.</p>
      )}
      <form onSubmit={handleSave} className="space-y-4">
        <Input label="Nome da empresa" value={empresa?.nome ?? ''} onChange={e => set('nome', e.target.value)} required disabled={!isAdmin} />
        <div className="grid grid-cols-2 gap-4">
          <Input label="CNPJ" value={empresa?.cnpj ?? ''} onChange={e => set('cnpj', e.target.value)} placeholder="00.000.000/0000-00" disabled={!isAdmin} />
          <Input label="Email" value={empresa?.email ?? ''} onChange={e => set('email', e.target.value)} type="email" disabled={!isAdmin} />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Input label="Telefone" value={empresa?.telefone ?? ''} onChange={e => set('telefone', e.target.value)} disabled={!isAdmin} />
          <Input label="CEP" value={empresa?.cep ?? ''} onChange={e => set('cep', e.target.value)} disabled={!isAdmin} />
        </div>
        <Input label="Endereço" value={empresa?.endereco ?? ''} onChange={e => set('endereco', e.target.value)} disabled={!isAdmin} />
        <div className="grid grid-cols-2 gap-4">
          <Input label="Cidade" value={empresa?.cidade ?? ''} onChange={e => set('cidade', e.target.value)} disabled={!isAdmin} />
          <Select label="Estado" value={empresa?.estado ?? ''} onChange={e => set('estado', e.target.value)} disabled={!isAdmin}>
            <option value="">—</option>
            {UFS.map(uf => <option key={uf} value={uf}>{uf}</option>)}
          </Select>
        </div>

        {msg && (
          <p className={`text-sm ${msg.startsWith('Erro') ? 'text-red-600' : 'text-emerald-600'}`}>{msg}</p>
        )}
        {isAdmin && <Button type="submit" loading={saving}>Salvar</Button>}
      </form>
    </Card>
  )
}

// ── Funcionários ──────────────────────────────────────────────

const SUPABASE_URL = 'https://axwepvqpzsrfhrigryqt.supabase.co'

async function callManageUser(body: Record<string, unknown>) {
  const { data: { session } } = await supabase.auth.getSession()
  const res = await fetch(`${SUPABASE_URL}/functions/v1/manage-user`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session?.access_token}`,
    },
    body: JSON.stringify(body),
  })
  return res.json() as Promise<{ ok: boolean; erro?: string; userId?: string }>
}

function FuncionariosTab() {
  const { profile } = useAuth()
  const [usuarios, setUsuarios] = useState<Usuario[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [msgType, setMsgType] = useState<'error' | 'success'>('error')

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editPapel, setEditPapel] = useState('')
  const [editAtivo, setEditAtivo] = useState(true)

  // Create state
  const [showCreate, setShowCreate] = useState(false)
  const [newNome, setNewNome] = useState('')
  const [newEmail, setNewEmail] = useState('')
  const [newSenha, setNewSenha] = useState('')
  const [newPapel, setNewPapel] = useState('producao')

  // Reset password state
  const [resetId, setResetId] = useState<string | null>(null)
  const [resetSenha, setResetSenha] = useState('')

  function showMsg(text: string, type: 'error' | 'success') {
    setMsg(text)
    setMsgType(type)
  }

  async function load() {
    if (!profile) return
    const { data } = await supabase
      .from('usuarios')
      .select('*')
      .eq('empresa_id', profile.empresa_id)
      .order('nome')
    setUsuarios((data ?? []) as Usuario[])
    setLoading(false)
  }

  useEffect(() => { load() }, [profile])

  function openEdit(u: Usuario) {
    setEditingId(u.id)
    setEditPapel(u.papel)
    setEditAtivo(u.ativo)
    setResetId(null)
    setMsg('')
  }

  async function handleSave(userId: string) {
    setSaving(true)
    setMsg('')
    const { error } = await supabase.from('usuarios').update({
      papel: editPapel,
      ativo: editAtivo,
    }).eq('id', userId)

    if (error) {
      showMsg('Erro: ' + error.message, 'error')
    } else {
      setEditingId(null)
      load()
    }
    setSaving(false)
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault()
    if (!newNome.trim() || !newEmail.trim() || !newSenha) return
    if (newSenha.length < 6) {
      showMsg('A senha deve ter pelo menos 6 caracteres.', 'error')
      return
    }
    setSaving(true)
    setMsg('')

    const result = await callManageUser({
      action: 'create',
      email: newEmail.trim(),
      password: newSenha,
      nome: newNome.trim(),
      papel: newPapel,
    })

    if (!result.ok) {
      showMsg(result.erro ?? 'Erro ao criar usuário', 'error')
    } else {
      showMsg('Funcionário criado com sucesso!', 'success')
      setShowCreate(false)
      setNewNome('')
      setNewEmail('')
      setNewSenha('')
      setNewPapel('producao')
      load()
    }
    setSaving(false)
  }

  async function handleResetPassword(userId: string) {
    if (!resetSenha || resetSenha.length < 6) {
      showMsg('A senha deve ter pelo menos 6 caracteres.', 'error')
      return
    }
    setSaving(true)
    setMsg('')

    const result = await callManageUser({
      action: 'reset-password',
      userId,
      password: resetSenha,
    })

    if (!result.ok) {
      showMsg(result.erro ?? 'Erro ao redefinir senha', 'error')
    } else {
      showMsg('Senha redefinida com sucesso!', 'success')
      setResetId(null)
      setResetSenha('')
    }
    setSaving(false)
  }

  if (loading) return (
    <div className="flex justify-center py-8">
      <div className="w-5 h-5 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
    </div>
  )

  return (
    <div className="space-y-4">
      {/* Header + Create button */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Funcionários</h2>
          <p className="text-xs text-gray-400 mt-0.5">{usuarios.length} usuário{usuarios.length !== 1 ? 's' : ''} na empresa</p>
        </div>
        {!showCreate && (
          <Button size="sm" onClick={() => { setShowCreate(true); setMsg('') }}
            icon={<svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>}
          >
            Novo funcionário
          </Button>
        )}
      </div>

      {/* Create form */}
      {showCreate && (
        <Card className="p-5">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Novo Funcionário</h3>
          <form onSubmit={handleCreate} className="space-y-3">
            <Input label="Nome" value={newNome} onChange={e => setNewNome(e.target.value)} required />
            <Input label="Email" type="email" value={newEmail} onChange={e => setNewEmail(e.target.value)} required />
            <Input label="Senha" type="password" value={newSenha} onChange={e => setNewSenha(e.target.value)} placeholder="Mínimo 6 caracteres" required />
            <Select label="Papel" value={newPapel} onChange={e => setNewPapel(e.target.value)}>
              {PAPEIS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
            </Select>
            <div className="flex gap-2">
              <Button type="submit" size="sm" loading={saving}>Criar</Button>
              <Button type="button" size="sm" variant="secondary" onClick={() => setShowCreate(false)}>Cancelar</Button>
            </div>
          </form>
        </Card>
      )}

      {msg && (
        <div className={`p-2 rounded-lg text-xs border ${msgType === 'error' ? 'bg-red-50 border-red-200 text-red-700' : 'bg-emerald-50 border-emerald-200 text-emerald-700'}`}>
          {msg}
        </div>
      )}

      {/* User list */}
      <Card className="overflow-hidden">
        <ul className="divide-y divide-gray-100">
          {usuarios.map(u => (
            <li key={u.id} className="px-5 py-3">
              {editingId === u.id ? (
                <div className="space-y-3">
                  <div>
                    <p className="text-sm font-medium text-gray-900">{u.nome}</p>
                    <p className="text-xs text-gray-400">{u.email}</p>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <Select label="Papel" value={editPapel} onChange={e => setEditPapel(e.target.value)}>
                      {PAPEIS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                    </Select>
                    <div className="flex flex-col gap-1">
                      <label className="text-sm font-medium text-gray-700">Status</label>
                      <label className="flex items-center gap-2 mt-1 cursor-pointer">
                        <input type="checkbox" checked={editAtivo} onChange={e => setEditAtivo(e.target.checked)}
                          className="w-4 h-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500" />
                        <span className="text-sm">{editAtivo ? 'Ativo' : 'Inativo'}</span>
                      </label>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" loading={saving} onClick={() => handleSave(u.id)}>Salvar</Button>
                    <Button size="sm" variant="secondary" onClick={() => setEditingId(null)}>Cancelar</Button>
                  </div>
                </div>
              ) : resetId === u.id ? (
                <div className="space-y-3">
                  <div>
                    <p className="text-sm font-medium text-gray-900">{u.nome}</p>
                    <p className="text-xs text-gray-400">Redefinir senha de {u.email}</p>
                  </div>
                  <Input type="password" value={resetSenha} onChange={e => setResetSenha(e.target.value)} placeholder="Nova senha (mín. 6 caracteres)" />
                  <div className="flex gap-2">
                    <Button size="sm" loading={saving} onClick={() => handleResetPassword(u.id)}>Redefinir</Button>
                    <Button size="sm" variant="secondary" onClick={() => { setResetId(null); setResetSenha('') }}>Cancelar</Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-gray-900">{u.nome}</p>
                    <p className="text-xs text-gray-400">{u.email}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={
                      u.papel === 'admin' ? 'purple'
                      : u.papel === 'gestao' ? 'info'
                      : u.papel === 'producao' ? 'success'
                      : 'default'
                    }>
                      {PAPEIS.find(p => p.value === u.papel)?.label ?? u.papel}
                    </Badge>
                    {!u.ativo && <Badge variant="danger">Inativo</Badge>}
                    {u.id !== profile?.id && (
                      <>
                        <button
                          onClick={() => openEdit(u)}
                          className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600"
                          title="Editar papel/status"
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
                          </svg>
                        </button>
                        <button
                          onClick={() => { setResetId(u.id); setEditingId(null); setResetSenha(''); setMsg('') }}
                          className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600"
                          title="Redefinir senha"
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" />
                          </svg>
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      </Card>

      {/* Permissões por papel */}
      <PermissoesSection />
    </div>
  )
}

// ── Permissões ──────────────────────────────────────────────

function PermissoesSection() {
  const { profile, permissoes, reloadPermissoes } = useAuth()
  const [editPapel, setEditPapel] = useState<string | null>(null)
  const [editRotas, setEditRotas] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  const papeisEditaveis = PAPEIS.filter(p => p.value !== 'admin') // admin sempre tem acesso total

  function openEdit(papel: string) {
    setEditPapel(papel)
    setEditRotas(permissoes[papel] ?? [])
    setMsg('')
  }

  function toggleRota(path: string) {
    setEditRotas(prev =>
      prev.includes(path) ? prev.filter(r => r !== path) : [...prev, path]
    )
  }

  async function handleSave() {
    if (!profile || !editPapel) return
    setSaving(true)
    setMsg('')

    const { error } = await supabase
      .from('permissoes_papel')
      .update({ rotas: editRotas })
      .eq('empresa_id', profile.empresa_id)
      .eq('papel', editPapel)

    if (error) {
      setMsg('Erro: ' + error.message)
    } else {
      await reloadPermissoes()
      setEditPapel(null)
      setMsg('')
    }
    setSaving(false)
  }

  return (
    <div className="mt-6">
      <h2 className="text-base font-semibold text-gray-900 mb-1">Permissões por Papel</h2>
      <p className="text-xs text-gray-400 mb-3">Defina quais módulos cada papel pode acessar</p>

      {msg && (
        <div className="mb-3 p-2 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">{msg}</div>
      )}

      <div className="space-y-3">
        {papeisEditaveis.map(p => {
          const rotas = permissoes[p.value] ?? []
          const isEditing = editPapel === p.value

          return (
            <Card key={p.value} className="overflow-hidden">
              <div className="px-4 py-3 flex items-center justify-between">
                <div>
                  <span className="text-sm font-medium text-gray-900">{p.label}</span>
                  <span className="text-xs text-gray-400 ml-2">
                    {rotas.includes('*') ? 'Acesso total' : `${rotas.length} módulo${rotas.length !== 1 ? 's' : ''}`}
                  </span>
                </div>
                {!isEditing && (
                  <button
                    onClick={() => openEdit(p.value)}
                    className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600"
                    title="Editar permissões"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
                    </svg>
                  </button>
                )}
              </div>

              {isEditing && (
                <div className="px-4 pb-4 border-t border-gray-100">
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-3">
                    {ALL_ROUTES.map(route => (
                      <label key={route.path} className="flex items-center gap-2 cursor-pointer py-1">
                        <input
                          type="checkbox"
                          checked={editRotas.includes(route.path)}
                          onChange={() => toggleRota(route.path)}
                          className="w-4 h-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
                        />
                        <span className="text-xs text-gray-700">{route.label}</span>
                      </label>
                    ))}
                  </div>
                  <div className="flex gap-2 mt-3">
                    <Button size="sm" loading={saving} onClick={handleSave}>Salvar</Button>
                    <Button size="sm" variant="secondary" onClick={() => setEditPapel(null)}>Cancelar</Button>
                    <button
                      type="button"
                      onClick={() => setEditRotas(ALL_ROUTES.map(r => r.path))}
                      className="text-xs text-brand-600 hover:underline ml-2"
                    >
                      Marcar todos
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditRotas([])}
                      className="text-xs text-gray-400 hover:underline"
                    >
                      Desmarcar todos
                    </button>
                  </div>
                </div>
              )}

              {!isEditing && !rotas.includes('*') && rotas.length > 0 && (
                <div className="px-4 pb-3 flex flex-wrap gap-1">
                  {rotas.map(r => {
                    const label = ALL_ROUTES.find(ar => ar.path === r)?.label ?? r
                    return (
                      <span key={r} className="px-2 py-0.5 bg-gray-100 text-gray-600 rounded text-xs">
                        {label}
                      </span>
                    )
                  })}
                </div>
              )}
            </Card>
          )
        })}
      </div>

      <p className="text-xs text-gray-400 mt-3">
        O papel <strong>Administrador</strong> sempre tem acesso total e não pode ser editado.
      </p>
    </div>
  )
}

// ── Categorias ──────────────────────────────────────────────

const CORES_PRESET = [
  '#EF4444', '#F97316', '#EAB308', '#22C55E',
  '#14B8A6', '#3B82F6', '#8B5CF6', '#EC4899',
  '#64748B', '#78716C',
]

function CategoriasTab() {
  const { profile } = useAuth()
  const [categorias, setCategorias] = useState<CategoriaInsumo[]>([])
  const [loading, setLoading] = useState(true)

  const [novaOpen, setNovaOpen] = useState(false)
  const [novaNome, setNovaNome] = useState('')
  const [novaCor, setNovaCor] = useState(CORES_PRESET[5])
  const [novaDescricao, setNovaDescricao] = useState('')
  const [salvando, setSalvando] = useState(false)
  const [erroNova, setErroNova] = useState('')

  const [editandoId, setEditandoId] = useState<string | null>(null)
  const [editNome, setEditNome] = useState('')
  const [editCor, setEditCor] = useState('')
  const [editDescricao, setEditDescricao] = useState('')
  const [salvandoEdit, setSalvandoEdit] = useState(false)
  const [erroEdit, setErroEdit] = useState('')

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [deletando, setDeletando] = useState(false)
  const [erroGeral, setErroGeral] = useState('')

  async function load() {
    if (!profile) return
    const { data } = await supabase
      .from('categorias_insumo')
      .select('*')
      .eq('empresa_id', profile.empresa_id)
      .order('nome')
    setCategorias((data ?? []) as CategoriaInsumo[])
    setLoading(false)
  }

  useEffect(() => { load() }, [profile])

  async function handleNova(e: FormEvent) {
    e.preventDefault()
    if (!profile || !novaNome.trim()) return
    setSalvando(true)
    setErroNova('')
    const { error } = await supabase.from('categorias_insumo').insert({
      empresa_id: profile.empresa_id,
      nome: novaNome.trim(),
      cor_hex: novaCor || null,
      descricao: novaDescricao.trim() || null,
    })
    if (error) {
      setErroNova(error.message)
    } else {
      setNovaOpen(false)
      setNovaNome('')
      setNovaCor(CORES_PRESET[5])
      setNovaDescricao('')
      load()
    }
    setSalvando(false)
  }

  function abrirEdicao(cat: CategoriaInsumo) {
    setEditandoId(cat.id)
    setEditNome(cat.nome)
    setEditCor(cat.cor_hex ?? CORES_PRESET[5])
    setEditDescricao(cat.descricao ?? '')
    setErroEdit('')
  }

  async function handleSalvarEdit(id: string) {
    if (!editNome.trim()) return
    setSalvandoEdit(true)
    setErroEdit('')
    const { error } = await supabase.from('categorias_insumo').update({
      nome: editNome.trim(),
      cor_hex: editCor || null,
      descricao: editDescricao.trim() || null,
    }).eq('id', id)
    if (error) {
      setErroEdit(error.message)
    } else {
      setEditandoId(null)
      load()
    }
    setSalvandoEdit(false)
  }

  async function handleDeletar(id: string) {
    setDeletando(true)
    setErroGeral('')
    const { error } = await supabase.from('categorias_insumo').delete().eq('id', id)
    if (error) {
      setErroGeral('Não foi possível excluir: ' + error.message)
    }
    setConfirmDeleteId(null)
    setDeletando(false)
    load()
  }

  return (
    <>
      {erroGeral && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 flex items-center justify-between">
          <span>{erroGeral}</span>
          <button onClick={() => setErroGeral('')} className="text-red-400 hover:text-red-600 ml-3">&times;</button>
        </div>
      )}

      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Categorias de Insumo</h2>
          <p className="text-xs text-gray-400 mt-0.5">Usadas para organizar e filtrar insumos</p>
        </div>
        {!novaOpen && (
          <Button size="sm" onClick={() => { setNovaOpen(true); setErroNova('') }}
            icon={<svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>}
          >
            Nova categoria
          </Button>
        )}
      </div>

      <Card className="overflow-hidden">
        {novaOpen && (
          <form onSubmit={handleNova} className="p-4 bg-brand-50 border-b border-brand-100">
            <p className="text-xs font-semibold text-brand-700 uppercase tracking-wide mb-3">Nova categoria</p>
            <div className="flex gap-3 items-start flex-wrap">
              <div className="flex-1 min-w-40">
                <input autoFocus type="text" placeholder="Nome da categoria" value={novaNome} onChange={e => setNovaNome(e.target.value)} required
                  className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
              </div>
              <div className="flex-1 min-w-40">
                <input type="text" placeholder="Descrição (opcional)" value={novaDescricao} onChange={e => setNovaDescricao(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500">Cor</label>
                <div className="flex items-center gap-2">
                  <div className="flex gap-1.5 flex-wrap max-w-[128px]">
                    {CORES_PRESET.map(cor => (
                      <button key={cor} type="button" onClick={() => setNovaCor(cor)}
                        className={`w-5 h-5 rounded-full border-2 transition-transform hover:scale-110 ${novaCor === cor ? 'border-gray-700 scale-110' : 'border-transparent'}`}
                        style={{ backgroundColor: cor }} title={cor} />
                    ))}
                  </div>
                  <input type="color" value={novaCor} onChange={e => setNovaCor(e.target.value)} className="w-7 h-7 rounded cursor-pointer border border-gray-200" title="Cor personalizada" />
                </div>
              </div>
            </div>
            {erroNova && <p className="text-xs text-red-600 mt-2">{erroNova}</p>}
            <div className="flex gap-2 mt-3">
              <Button type="submit" size="sm" loading={salvando}>Salvar</Button>
              <Button type="button" size="sm" variant="secondary" onClick={() => setNovaOpen(false)}>Cancelar</Button>
            </div>
          </form>
        )}

        {loading ? (
          <div className="p-8 flex justify-center">
            <div className="w-5 h-5 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : categorias.length === 0 && !novaOpen ? (
          <div className="p-8 text-center">
            <p className="text-gray-400 text-sm">Nenhuma categoria cadastrada.</p>
            <button onClick={() => setNovaOpen(true)} className="text-brand-600 text-sm mt-1 hover:underline">Criar primeira categoria &rarr;</button>
          </div>
        ) : (
          <ul className="divide-y divide-gray-100">
            {categorias.map(cat => (
              <li key={cat.id}>
                {editandoId === cat.id ? (
                  <div className="p-4 bg-gray-50">
                    <div className="flex gap-3 items-start flex-wrap">
                      <div className="flex-1 min-w-32">
                        <input autoFocus type="text" value={editNome} onChange={e => setEditNome(e.target.value)}
                          className="w-full px-3 py-1.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
                      </div>
                      <div className="flex-1 min-w-32">
                        <input type="text" value={editDescricao} onChange={e => setEditDescricao(e.target.value)} placeholder="Descrição (opcional)"
                          className="w-full px-3 py-1.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
                      </div>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {CORES_PRESET.map(cor => (
                          <button key={cor} type="button" onClick={() => setEditCor(cor)}
                            className={`w-5 h-5 rounded-full border-2 hover:scale-110 transition-transform ${editCor === cor ? 'border-gray-700 scale-110' : 'border-transparent'}`}
                            style={{ backgroundColor: cor }} />
                        ))}
                        <input type="color" value={editCor} onChange={e => setEditCor(e.target.value)} className="w-7 h-7 rounded cursor-pointer border border-gray-200" />
                      </div>
                    </div>
                    {erroEdit && <p className="text-xs text-red-600 mt-1">{erroEdit}</p>}
                    <div className="flex gap-2 mt-2">
                      <Button size="sm" loading={salvandoEdit} onClick={() => handleSalvarEdit(cat.id)}>Salvar</Button>
                      <Button size="sm" variant="secondary" onClick={() => setEditandoId(null)}>Cancelar</Button>
                    </div>
                  </div>
                ) : confirmDeleteId === cat.id ? (
                  <div className="px-4 py-3 flex items-center justify-between gap-3 bg-red-50">
                    <p className="text-sm text-red-700">Excluir <strong>{cat.nome}</strong>?</p>
                    <div className="flex gap-2 shrink-0">
                      <button onClick={() => handleDeletar(cat.id)} disabled={deletando}
                        className="px-3 py-1 text-xs font-medium bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50">
                        {deletando ? '...' : 'Confirmar'}
                      </button>
                      <button onClick={() => setConfirmDeleteId(null)} className="px-3 py-1 text-xs text-gray-600 hover:text-gray-900">Cancelar</button>
                    </div>
                  </div>
                ) : (
                  <div className="px-4 py-3 flex items-center gap-3">
                    <div className="w-3.5 h-3.5 rounded-full shrink-0" style={{ backgroundColor: cat.cor_hex ?? '#9CA3AF' }} />
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium text-gray-900">{cat.nome}</span>
                      {cat.descricao && <span className="text-xs text-gray-400 ml-2">{cat.descricao}</span>}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button onClick={() => abrirEdicao(cat)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600" title="Editar">
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
                        </svg>
                      </button>
                      <button onClick={() => setConfirmDeleteId(cat.id)} className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500" title="Excluir">
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                        </svg>
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  )
}
