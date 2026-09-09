import { QRCodeSVG } from 'qrcode.react'
import type { Lote, Empresa } from '../../types/database.types'
import { formatDate, formatDateTime } from '../../lib/utils'
import { LAYOUT_BASE, baseDoLayout, layoutDaEtiqueta, type EtiquetaDims } from '../../lib/etiquetas'
import { codigoCurtoLote } from '../../lib/qr'

/**
 * O conteúdo da etiqueta de lote/sublote, nos dois desenhos possíveis.
 *
 * Cada desenho é feito no tamanho-base do seu layout (100x75mm deitado,
 * 34x65mm em pé) e é o `EtiquetaCanvas` que o ajusta ao papel configurado.
 * Quem escolhe o desenho é o formato do papel, não a tela: um rolo em pé
 * usando o desenho deitado desperdiçaria mais da metade da etiqueta.
 *
 * Os dois carregam a mesma informação. O que muda é o arranjo e o quanto
 * cada bloco pode ocupar.
 */

export type LoteEtiqueta = Lote & {
  embalagem_aberta?: boolean
  insumo: { nome: string; codigo: string; unidade_medida: string; shelf_life_dias_pos_abertura?: number }
  fornecedor?: { nome: string }
  marca?: { nome: string }
  recebido_usuario?: { nome: string }
}

type Props = { lote: LoteEtiqueta; empresa: Empresa | null; dims: EtiquetaDims }

/** Os campos da etiqueta, já formatados — iguais nos dois desenhos. */
function dadosDoLote(lote: LoteEtiqueta, empresa: Empresa | null) {
  const marcaForn = [
    (lote.marca as unknown as { nome: string } | null)?.nome,
    (lote.fornecedor as unknown as { nome: string } | null)?.nome,
  ].filter(Boolean).join(' - ')

  const shelfLife = (lote.insumo as unknown as { shelf_life_dias_pos_abertura?: number })?.shelf_life_dias_pos_abertura

  // A embalagem aberta tem menos produto que as fechadas, e sem um aviso na
  // etiqueta não há como saber em qual fardo colá-la. A quantidade entra junto
  // porque é ela que casa a etiqueta com o fardo certo.
  //
  // O sinal virou coluna na migration 077; a leitura da observação fica como
  // reserva para os lotes gravados antes dela.
  const embalagemAberta = lote.embalagem_aberta === true
    || (lote.observacoes ?? '').toLowerCase().includes('embalagem aberta')
  const qtd = Number(lote.quantidade_recebida)
  const quantidade = Number.isFinite(qtd) && qtd > 0
    ? `${qtd.toLocaleString('pt-BR', { maximumFractionDigits: 3 })} ${lote.insumo?.unidade_medida ?? ''}`.trim()
    : ''

  return {
    marcaForn: marcaForn || '—',
    // A marca sozinha, sem o fornecedor: na bancada é ela que distingue dois
    // sacos do mesmo insumo, e estava espremida em 6pt junto de mais quatro
    // campos. Foi marca que causou o impasse do chocolate em 07/09/2026.
    marca: (lote.marca as unknown as { nome: string } | null)?.nome ?? '',
    responsavel: (lote.recebido_usuario as unknown as { nome: string } | null)?.nome ?? '',
    cnpj: empresa?.cnpj ?? '',
    endereco: [empresa?.endereco, empresa?.cidade, empresa?.estado].filter(Boolean).join(', '),
    empresaNome: empresa?.nome ?? 'Unno',
    aposAbertura: shelfLife != null ? `${shelfLife} DIAS` : '—',
    qrContent: [lote.codigo, lote.data_recebimento, lote.numero_nf ?? ''].filter(Boolean).join('|'),
    embalagemAberta,
    quantidade,
  }
}

/**
 * "09/09/26 10:14" — a data de manipulação no rodapé da etiqueta em pé.
 *
 * Dois dígitos no ano porque a linha é medida em caracteres: são ~32 num vão
 * de 31mm em 5pt, e os dois dígitos a mais custavam o nome do responsável.
 */
function dataHoraCurta(iso: string): string {
  const d = new Date(iso)
  const dd = (n: number) => String(n).padStart(2, '0')
  return `${dd(d.getDate())}/${dd(d.getMonth() + 1)}/${dd(d.getFullYear() % 100)} `
       + `${dd(d.getHours())}:${dd(d.getMinutes())}`
}

/**
 * O código do lote na tarja preta, sempre em UMA linha: a tarja fica na faixa
 * destacável, cuja altura é contada ao milímetro — uma segunda linha empurraria
 * o conteúdo para baixo da picotada.
 *
 * Na etiqueta em pé o que entra aqui é o código CURTO (`0005.1/2`): o `INS014`
 * é o insumo, cujo nome já está escrito por extenso duas linhas acima. Sem os
 * sete caracteres do prefixo o número cabe em 13pt — antes eram 9,5pt, e 6,5pt
 * justamente no sublote comprido, que é o caso mais comum.
 */
function corpoDoCodigo(codigo: string): string {
  if (codigo.length <= 8) return '13pt'      // 0005.1/2
  if (codigo.length <= 10) return '11pt'     // 0005.12/12
  if (codigo.length <= 13) return '9.5pt'
  if (codigo.length <= 18) return '7.5pt'
  return '6.5pt'
}

export function EtiquetaLoteContent({ lote, empresa, dims }: Props) {
  return layoutDaEtiqueta(dims) === 'retrato'
    ? <LoteRetrato lote={lote} empresa={empresa} />
    : <LotePaisagem lote={lote} empresa={empresa} base={baseDoLayout(dims)} />
}

// ── Deitada (100mm de largura, altura na proporção do papel) ──

function LotePaisagem({ lote, empresa, base }: { lote: LoteEtiqueta; empresa: Empresa | null; base: EtiquetaDims }) {
  const d = dadosDoLote(lote, empresa)

  return (
    <div style={{
      width: `${base.largura}mm`,
      height: `${base.altura}mm`,
      fontFamily: 'sans-serif',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      boxSizing: 'border-box',
    }}>

      {/* ── CABEÇALHO ── */}
      <div style={{ padding: '4mm 4mm 3mm 4mm', flexShrink: 0 }}>
        <div style={{ fontSize: '14pt', fontWeight: 'bold', lineHeight: 1.2 }}>
          {lote.insumo.nome}
        </div>
        <div style={{ fontSize: '8pt', marginTop: '1mm' }}>
          {d.empresaNome}
        </div>
      </div>

      {/* ── CORPO (dados + QR) ── */}
      <div style={{
        flex: 1,
        display: 'flex',
        borderTop: '1.5pt solid #000',
        borderBottom: '1.5pt solid #000',
        minHeight: 0,
      }}>
        <div style={{
          flex: '0 0 62mm',
          padding: '2.5mm 3mm',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          borderRight: '1pt solid #000',
        }}>
          <Campo label="RECEBIMENTO:" value={formatDate(lote.data_recebimento)} />
          <Campo label="VALIDADE ORIGINAL:" value={formatDate(lote.validade_original)} />
          <Campo label="MANIPULAÇÃO:" value={formatDateTime(lote.created_at)} />
          <Campo label="VALIDADE:" value={formatDate(lote.validade_pos_abertura)} bold />
          <Campo label="APÓS ABERTURA:" value={d.aposAbertura} />
          <Campo label="MARCA/FORN.:" value={d.marcaForn} />
        </div>

        <div style={{
          flex: 1,
          padding: '2.5mm 3mm',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
        }}>
          <div style={{ fontSize: '7pt', alignSelf: 'flex-start' }}>
            <span style={{ fontWeight: 'bold' }}>LOTE: </span>{lote.codigo}
          </div>
          <div style={{ fontSize: '7pt', alignSelf: 'flex-start', marginTop: '1.5mm' }}>
            <span style={{ fontWeight: 'bold' }}>NF: </span>{lote.numero_nf || '—'}
          </div>
          {d.embalagemAberta && (
            <div style={{
              fontSize: '7pt',
              fontWeight: 'bold',
              background: '#000',
              color: '#fff',
              padding: '0.5mm 1.5mm',
              marginTop: '1.5mm',
              alignSelf: 'flex-start',
            }}>
              EMB. ABERTA{d.quantidade ? ` · ${d.quantidade}` : ''}
            </div>
          )}
          <div style={{ marginTop: '2mm', flex: 1, display: 'flex', alignItems: 'center' }}>
            <QRCodeSVG value={d.qrContent} size={90} level="M" includeMargin={false} />
          </div>
        </div>
      </div>

      {/* ── RODAPÉ ── */}
      <div style={{
        padding: '1.5mm 4mm',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-end',
        flexShrink: 0,
      }}>
        <div>
          <div style={{ fontSize: '6.5pt' }}>
            <span style={{ fontWeight: 'bold' }}>RESP.: </span>
            <span style={{ fontWeight: 'bold' }}>{d.responsavel}</span>
          </div>
          <div style={{ fontSize: '6.5pt', marginTop: '0.5mm' }}>
            <span style={{ fontWeight: 'bold' }}>CNPJ: </span>{d.cnpj}
          </div>
          <div style={{ fontSize: '6.5pt', marginTop: '0.5mm', maxWidth: '70mm', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
            <span style={{ fontWeight: 'bold' }}>END.: </span>{d.endereco}
          </div>
        </div>
        <div style={{ fontSize: '6pt', whiteSpace: 'nowrap' }}>
          #{lote.codigo}
        </div>
      </div>
    </div>
  )
}

function Campo({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div style={{ fontSize: '7.5pt', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
      <span style={{ fontWeight: 'bold' }}>{label} </span>
      <span style={{ fontWeight: bold ? 'bold' : 'normal' }}>{value}</span>
    </div>
  )
}

// ── Em pé (base 34x65mm) ──────────────────────────────────────

/**
 * Numa etiqueta estreita não cabe tudo lado a lado, então a informação vira
 * uma pilha e a ordem passa a ser a de quem lê no estoque: o que é o insumo,
 * até quando serve, e só depois a papelada.
 *
 * O código do lote vem em caixa invertida: é o que se procura de longe na
 * prateleira na hora de casar etiqueta com fardo (decisão do usuário em
 * 05/08/2026 — antes era a validade, que desceu para o bloco de baixo).
 *
 * ── O QR ERA PEQUENO DEMAIS, E ISSO ERA O PROBLEMA REAL ──────
 *
 * A etiqueta carregava treze campos em 34x65mm e o QR ficava com o que
 * sobrasse: 15,1mm, ou 4,2 pontos de impressora por quadradinho do código.
 * Quatro é o limite do que uma cabeça de 203dpi resolve — daí as leituras que
 * falhavam e a digitação à mão, que era para ser a exceção.
 *
 * Saíram do papel cinco campos que ninguém lê na bancada e que o aplicativo
 * responde melhor: recebimento, validade original, prazo após abertura, NF e
 * CNPJ. Com eles fora o QR vai a 25,5mm — 7,0 pontos por quadradinho, quase
 * três vezes a área (decisão do usuário em 09/09/2026).
 *
 * O QR passou a ser limitado pela LARGURA da etiqueta, não pela altura: sobram
 * 36mm de altura para 25,5mm de largura possível. É por isso que a tarja de
 * embalagem aberta não custa tamanho de QR nenhum — ela ocupa altura que
 * sobrava de qualquer jeito.
 *
 * O `INS014` continua impresso, de pé ao lado do QR. Ele não é enfeite: quando
 * o QR não lê e a pessoa digita à mão, sem o número do insumo o `0005.1/2` não
 * identifica nada.
 */
function LoteRetrato({ lote, empresa }: { lote: LoteEtiqueta; empresa: Empresa | null }) {
  const d = dadosDoLote(lote, empresa)
  const base = LAYOUT_BASE.retrato

  return (
    <div style={{
      width: `${base.largura}mm`,
      height: `${base.altura}mm`,
      fontFamily: 'sans-serif',
      display: 'flex',
      flexDirection: 'column',
      padding: '1.2mm 1.5mm 1.8mm 1.5mm',
      overflow: 'hidden',
      boxSizing: 'border-box',
    }}>

      {/* ── Faixa destacável ──
          O rolo tem uma picotada a ZONA_DESTACAVEL_MM do topo. Tudo o que
          precisa sobreviver ao destaque — o que é, de quem é, até quando
          serve — cabe acima dela; o resto (papelada e QR) fica abaixo.
          As medidas deste bloco existem para respeitar esse limite: mexer
          em fonte ou espaçamento aqui exige refazer a conta. */}

      {/* Nome do insumo — até duas linhas, o resto corta.
          A altura é fixa (mesmo com nome de uma linha só) para que as
          etiquetas da mesma linha do rolo saiam alinhadas entre si. */}
      <div style={{
        fontSize: '7pt',
        fontWeight: 'bold',
        lineHeight: 1.12,
        height: '5.6mm',
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
        flexShrink: 0,
      }}>
        {lote.insumo.nome}
      </div>
      {/* A MARCA ocupa a linha onde estava o nome da empresa.
          Fisicamente, quem está com o saco na mão distingue um do outro pela
          marca, não pelo nome da fábrica — que é a mesma em toda etiqueta do
          estoque e por isso não informa nada. A empresa desceu para o rodapé,
          junto de quem manipulou. */}
      <div style={{
        fontSize: '6.5pt',
        fontWeight: 'bold',
        lineHeight: 1.1,
        textTransform: 'uppercase',
        marginTop: '0.3mm',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        flexShrink: 0,
      }}>
        {d.marca || d.marcaForn}
      </div>

      {/* Lote — o campo que se lê de longe. Uma linha sempre: a segunda
          estouraria a faixa destacável (ver corpoDoCodigo). */}
      {/* A CONTA DESTE BLOCO, em milímetros, do topo até aqui:
            1,20  padding do topo
            5,60  nome do insumo (7pt, duas linhas)
            2,82  marca (6,5pt + 0,3 de respiro)
            0,60  respiro antes da tarja
            0,50  padding de cima da tarja
            1,55  a palavra LOTE (4pt)
            4,83  o número (13pt x 1,05 de entrelinha)
            0,50  padding de baixo da tarja
           ─────
           17,60  contra a picotada em 18,50 — sobram 0,9mm

          Os paddings da tarja são apertados de propósito: eram 0,7mm e o bloco
          fechava em 18,47mm, encostado na picotada. Mexer em qualquer número
          daqui exige refazer esta soma. */}
      <div style={{
        marginTop: '0.6mm',
        background: '#000',
        color: '#fff',
        padding: '0.5mm 1mm',
        flexShrink: 0,
      }}>
        <div style={{ fontSize: '4pt', lineHeight: 1.1, letterSpacing: '0.3pt' }}>LOTE</div>
        <div style={{
          fontSize: corpoDoCodigo(codigoCurtoLote(lote.codigo)),
          fontWeight: 'bold',
          lineHeight: 1.05,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          // Altura fixa na medida do corpo maior: o código menor não encolhe a
          // tarja, senão etiquetas da mesma linha do rolo sairiam desalinhadas.
          height: '4.83mm',
          display: 'flex',
          alignItems: 'center',
        }}>
          {codigoCurtoLote(lote.codigo)}
        </div>
      </div>
      {/* ── fim da faixa destacável (17,6mm de 18,5mm) ── */}

      {/* Validade à esquerda, código do insumo à direita — na MESMA linha.
          O código estava de pé ao lado do QR e custava 4,5mm de largura, que
          é a medida que limita o QR. Dividindo esta linha ele não custa
          altura nem largura, e o QR passa a usar a etiqueta inteira: 31mm,
          8,5 pontos por módulo (era 7,0 com a faixa, e 4,2 no desenho antigo).

          "VAL:" escrito por extenso porque uma data solta não diz de quê —
          poderia ser a de recebimento tanto quanto a de vencimento. */}
      <div style={{
        marginTop: '1mm',
        paddingTop: '0.8mm',
        borderTop: '1pt solid #000',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: '1mm',
      }}>
        {/* 8pt e 6,5pt sao medidos, nao escolhidos: "VAL: 12/09/2026" mais
            "INS014" mais 1mm de folga dao 30,8mm num vao de 31. Em 9pt/7pt,
            que foi a primeira tentativa, davam 34,1mm — e a data saia cortada,
            que e o defeito que esta linha veio consertar. */}
        <div style={{ fontSize: '8pt', fontWeight: 'bold', lineHeight: 1.15, whiteSpace: 'nowrap', overflow: 'hidden' }}>
          VAL: {formatDate(lote.validade_pos_abertura)}
        </div>
        <div style={{ fontSize: '6.5pt', fontWeight: 'bold', lineHeight: 1.15, whiteSpace: 'nowrap', flexShrink: 0 }}>
          {lote.insumo.codigo}
        </div>
      </div>

      {/* A embalagem aberta tem menos produto que as fechadas, e a quantidade
          é o que casa esta etiqueta com o fardo certo. Ela cabe de graça: o QR
          abaixo é limitado pela largura da etiqueta, e esta tarja gasta
          altura, que sobra. */}
      {d.embalagemAberta && (
        <div style={{
          fontSize: '5.8pt',
          fontWeight: 'bold',
          background: '#000',
          color: '#fff',
          padding: '0.3mm 0.8mm',
          marginTop: '0.3mm',
          display: 'inline-block',
          flexShrink: 0,
        }}>
          EMB. ABERTA{d.quantidade ? ` · ${d.quantidade}` : ''}
        </div>
      )}

      {/* O QR ocupa a largura inteira da etiqueta: 31mm, ou 8,5 pontos de
          impressora por módulo. No desenho antigo eram 4,2 — no limite do que
          uma cabeça de 203dpi resolve, e a razão de as leituras falharem. */}
      <div style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: '1mm',
      }}>
        <QRCodeSVG value={d.qrContent} size={117} level="M" includeMargin={false} />
      </div>

      {/* Manipulação e quem manipulou, que é o que a boa prática pede.
          Cabe em UMA linha, e por pouco: em 5pt, 31mm de etiqueta dão ~32
          caracteres. O nome da fábrica saiu (é o mesmo em toda etiqueta do
          estoque), o ano vai com dois dígitos e o responsável entra só com o
          primeiro nome. Com o texto anterior eram 48,5mm num vão de 31 — e a
          data saía cortada. */}
      <div style={{ flexShrink: 0, marginTop: '0.8mm' }}>
        <div style={{ fontSize: '5pt', lineHeight: 1.25, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          MANIP. {dataHoraCurta(lote.created_at)}
          {d.responsavel ? ` · ${d.responsavel.split(' ')[0]}` : ''}
        </div>
      </div>
    </div>
  )
}

// `CampoRetrato` saiu junto com os cinco campos miudos que ele desenhava. O
// desenho em pe nao tem mais linha de 6pt: sobraram tres blocos, e cada um
// grande o suficiente para ser lido de longe.
