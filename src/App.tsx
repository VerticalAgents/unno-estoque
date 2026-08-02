import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Layout } from './components/layout/Layout'
import { LoginPage } from './pages/auth/LoginPage'
import { DashboardPage } from './pages/dashboard/DashboardPage'
import { EstoquePage } from './pages/estoque/EstoquePage'
import { InsumoListPage } from './pages/insumos/InsumoListPage'
import { FornecedorListPage } from './pages/fornecedores/FornecedorListPage'
import { RecebimentoListPage } from './pages/recebimento/RecebimentoListPage'
import { NovoLotePage } from './pages/recebimento/NovoLotePage'
import { ImpressaoEtiquetaPage } from './pages/recebimento/ImpressaoEtiquetaPage'
import { ImpressaoLotesPage } from './pages/recebimento/ImpressaoLotesPage'
import { TransferenciaPage } from './pages/transferencia/TransferenciaPage'
import { SessoesListPage } from './pages/producao/SessoesListPage'
import { AberturaSessaoPage } from './pages/producao/AberturaSessaoPage'
import { PlanejadorRecipientesPage } from './pages/producao/PlanejadorRecipientesPage'
import { ReabastecimentoPage } from './pages/reabastecimento/ReabastecimentoPage'
import { FechamentoSessaoPage } from './pages/producao/FechamentoSessaoPage'
import { PerdaListPage } from './pages/perdas/PerdaListPage'
import { NovaPerdaPage } from './pages/perdas/NovaPerdaPage'
import { FichasListPage } from './pages/fichas/FichasListPage'
import { NovaFichaPage } from './pages/fichas/NovaFichaPage'
import { FichaDetailPage } from './pages/fichas/FichaDetailPage'
import { NovaVersaoFichaPage } from './pages/fichas/NovaVersaoFichaPage'
import { ImpressaoFichaPage } from './pages/fichas/ImpressaoFichaPage'
import { TabelaNutricionalPage } from './pages/fichas/TabelaNutricionalPage'
import { RelatoriosPage } from './pages/relatorios/RelatoriosPage'
import { ContagemListPage } from './pages/contagem/ContagemListPage'
import { NovaContagemEcPage } from './pages/contagem/NovaContagemEcPage'
import { NovaContagemEpPage } from './pages/contagem/NovaContagemEpPage'
import { ContagemResumoPage } from './pages/contagem/ContagemResumoPage'
import { DevPage } from './pages/dev/DevPage'
import { ConfiguracoesPage } from './pages/configuracoes/ConfiguracoesPage'
import { RecipienteListPage } from './pages/recipientes/RecipienteListPage'
import { EtiquetaRecipientePage } from './pages/recipientes/EtiquetaRecipientePage'
import { ProdutosEstoquePage } from './pages/estoque/ProdutosEstoquePage'
import { HistoricoProducaoPage } from './pages/estoque/HistoricoProducaoPage'
import { ProdutoListPage } from './pages/produtos/ProdutoListPage'
import { ExpedicaoListPage } from './pages/expedicao/ExpedicaoListPage'
import { NovaExpedicaoPage } from './pages/expedicao/NovaExpedicaoPage'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<Layout />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="estoque" element={<Navigate to="/estoque/insumos" replace />} />
          <Route path="estoque/insumos" element={<EstoquePage />} />
          <Route path="estoque/produtos" element={<ProdutosEstoquePage />} />
          <Route path="estoque/historico" element={<HistoricoProducaoPage />} />
          <Route path="insumos" element={<InsumoListPage />} />
          <Route path="fornecedores" element={<FornecedorListPage />} />
          <Route path="recebimento" element={<RecebimentoListPage />} />
          <Route path="recebimento/novo" element={<NovoLotePage />} />
          <Route path="recebimento/imprimir/:loteId" element={<ImpressaoEtiquetaPage />} />
          <Route path="recebimento/imprimir-lotes" element={<ImpressaoLotesPage />} />
          <Route path="transferencia" element={<TransferenciaPage />} />
          <Route path="reabastecimento" element={<ReabastecimentoPage />} />
          <Route path="producao" element={<SessoesListPage />} />
          <Route path="producao/abrir" element={<AberturaSessaoPage />} />
          <Route path="producao/planejador" element={<PlanejadorRecipientesPage />} />
          <Route path="producao/:id/editar" element={<AberturaSessaoPage />} />
          <Route path="producao/:id/fechar" element={<FechamentoSessaoPage />} />
          <Route path="contagem" element={<ContagemListPage />} />
          <Route path="contagem/ec/:id" element={<NovaContagemEcPage />} />
          <Route path="contagem/ep/:id" element={<NovaContagemEpPage />} />
          <Route path="contagem/resumo/:id" element={<ContagemResumoPage />} />
          <Route path="perdas" element={<PerdaListPage />} />
          <Route path="perdas/nova" element={<NovaPerdaPage />} />
          <Route path="expedicao" element={<ExpedicaoListPage />} />
          <Route path="expedicao/nova" element={<NovaExpedicaoPage />} />
          <Route path="fichas" element={<FichasListPage />} />
          <Route path="fichas/nova" element={<NovaFichaPage />} />
          <Route path="fichas/:id" element={<FichaDetailPage />} />
          <Route path="fichas/:id/nova-versao" element={<NovaVersaoFichaPage />} />
          <Route path="fichas/:id/imprimir" element={<ImpressaoFichaPage />} />
          <Route path="fichas/:id/nutricional" element={<TabelaNutricionalPage />} />
          <Route path="relatorios" element={<RelatoriosPage />} />
          <Route path="produtos" element={<ProdutoListPage />} />
          <Route path="recipientes" element={<RecipienteListPage />} />
          <Route path="recipientes/:id/etiqueta" element={<EtiquetaRecipientePage />} />
          <Route path="configuracoes" element={<ConfiguracoesPage />} />
          <Route path="dev" element={<DevPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
