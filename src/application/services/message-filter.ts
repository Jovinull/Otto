import { normalizeText } from '../../shared/text';

const FINANCIAL_TERMS = [
  'gastei',
  'gastamos',
  'gastou',
  'gasto',
  'gastos',
  'paguei',
  'pagamos',
  'pagou',
  'pagar',
  'recebi',
  'recebemos',
  'recebeu',
  'entrou',
  'comprei',
  'compramos',
  'comprou',
  'transferi',
  'guardei',
  'reais',
  'real',
  'dinheiro',
  'orcamento',
  'saldo',
  'fatura',
  'faturas',
  'cartoes',
  'saldos',
  'parcela',
  'parcelas',
  'salario',
  'aluguel',
  'meta',
  'apartamento',
  'quanto',
  'economizar',
  'economia',
  'podemos',
  'analise',
  'resumo',
  'relatorio',
  'planejamento',
  'financeiro',
  'financas',
  'contas',
  'renda',
  'poupanca',
  'reserva',
  // Correcoes e cancelamentos de lancamentos.
  'apaga',
  'apagar',
  'apague',
  'exclui',
  'excluir',
  'corrige',
  'corrigir',
  'corrija',
  'estorna',
  'estornar',
  'lancamento',
  'lancamentos',
  'errado',
  'errei',
  // Outros termos financeiros comuns.
  'compra',
  'compras',
  'comprar',
  'cartao',
  'pix',
  'boleto',
  'divida',
  'emprestimo',
  'juros',
  'sobra',
  'sobrou',
  'guardar',
  'guardamos',
  'transferir',
  'transferencia',
  'receber',
  'recebo',
  'gastar',
  'conta',
  'banco',
  'cofre',
  'cofres',
  'metas',
  'objetivo',
  'tirei',
  'retirei',
  'coloquei',
  'caiu',
  'status',
  'situacao',
  'nubank',
  'picpay',
  'santander',
  'bradesco',
  'itau',
];

export function mentionsAssistant(text: string): boolean {
  return ` ${normalizeText(text).replace(/[^a-z0-9 ]/g, ' ')} `.includes(' otto ');
}

/**
 * Filtro local antes da IA: conversa comum nao gera custo nem sai do Telegram.
 * Deixa passar qualquer coisa com numero ou termo financeiro; o modelo decide o restante.
 */
export function shouldInterpret(text: string, addressed: boolean): boolean {
  if (addressed) return true;
  if (/\d/.test(text)) return true;
  const words = normalizeText(text)
    .replace(/[^a-z ]/g, ' ')
    .split(' ');
  return words.some((word) => FINANCIAL_TERMS.includes(word));
}
