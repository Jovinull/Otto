import { normalizeText } from '../../shared/text';

export type CategoryKind = 'expense' | 'income';
export type CategoryNature = 'essential' | 'discretionary' | 'other';

export interface CategorySeed {
  slug: string;
  name: string;
  kind: CategoryKind;
  nature: CategoryNature;
}

export const FALLBACK_EXPENSE_SLUG = 'outros';
export const FALLBACK_INCOME_SLUG = 'outras-receitas';

export const DEFAULT_CATEGORIES: readonly CategorySeed[] = [
  { slug: 'moradia', name: 'Moradia', kind: 'expense', nature: 'essential' },
  {
    slug: 'supermercado',
    name: 'Alimentação / Supermercado',
    kind: 'expense',
    nature: 'essential',
  },
  { slug: 'delivery', name: 'Alimentação / Delivery', kind: 'expense', nature: 'discretionary' },
  {
    slug: 'restaurantes',
    name: 'Alimentação / Restaurantes',
    kind: 'expense',
    nature: 'discretionary',
  },
  { slug: 'transporte', name: 'Transporte', kind: 'expense', nature: 'essential' },
  { slug: 'saude', name: 'Saúde', kind: 'expense', nature: 'essential' },
  { slug: 'farmacia', name: 'Farmácia', kind: 'expense', nature: 'essential' },
  { slug: 'educacao', name: 'Educação', kind: 'expense', nature: 'essential' },
  { slug: 'lazer', name: 'Lazer', kind: 'expense', nature: 'discretionary' },
  { slug: 'assinaturas', name: 'Assinaturas', kind: 'expense', nature: 'discretionary' },
  { slug: 'compras-pessoais', name: 'Compras pessoais', kind: 'expense', nature: 'discretionary' },
  { slug: 'contas-domesticas', name: 'Contas domésticas', kind: 'expense', nature: 'essential' },
  { slug: 'trabalho', name: 'Trabalho', kind: 'expense', nature: 'other' },
  { slug: 'imprevistos', name: 'Imprevistos', kind: 'expense', nature: 'other' },
  { slug: 'encargos', name: 'Juros e encargos', kind: 'expense', nature: 'other' },
  { slug: FALLBACK_EXPENSE_SLUG, name: 'Outros', kind: 'expense', nature: 'other' },
  { slug: 'salario', name: 'Salário', kind: 'income', nature: 'other' },
  { slug: 'renda-extra', name: 'Renda extra', kind: 'income', nature: 'other' },
  { slug: 'reembolso', name: 'Reembolso', kind: 'income', nature: 'other' },
  { slug: FALLBACK_INCOME_SLUG, name: 'Outras receitas', kind: 'income', nature: 'other' },
];

const EXPENSE_KEYWORDS: Record<string, readonly string[]> = {
  encargos: ['juros', 'multa', 'iof', 'encargo', 'encargos', 'anuidade', 'tarifa'],
  delivery: ['ifood', 'rappi', 'delivery', 'pizza'],
  restaurantes: ['almoco', 'jantar', 'restaurante', 'lanchonete', 'lanche'],
  supermercado: ['mercado', 'supermercado', 'feira', 'hortifruti', 'atacadao', 'assai'],
  transporte: [
    'uber',
    '99',
    'taxi',
    'onibus',
    'gasolina',
    'combustivel',
    'estacionamento',
    'pedagio',
  ],
  farmacia: ['farmacia', 'remedio', 'remedios', 'drogaria', 'drogasil'],
  saude: ['medico', 'consulta', 'dentista', 'exame', 'hospital', 'plano de saude'],
  educacao: ['curso', 'faculdade', 'escola', 'livro', 'mensalidade'],
  lazer: ['cinema', 'show', 'bar', 'viagem', 'passeio', 'jogo'],
  assinaturas: ['netflix', 'spotify', 'assinatura', 'disney', 'prime video'],
  moradia: ['aluguel', 'condominio', 'iptu'],
  'contas-domesticas': ['energia', 'luz', 'agua', 'internet', 'gas', 'telefone'],
  'compras-pessoais': ['roupa', 'roupas', 'sapato', 'tenis', 'besteira', 'celular'],
};

const INCOME_KEYWORDS: Record<string, readonly string[]> = {
  salario: ['salario', 'pagamento mensal', 'holerite'],
  reembolso: ['reembolso', 'devolucao', 'estorno'],
  'renda-extra': ['extra', 'freela', 'bico', 'servico'],
};

function containsTerm(text: string, term: string): boolean {
  return ` ${text} `.includes(` ${term} `);
}

/** Classificacao por palavras-chave para comandos sem IA. Na duvida, usa a categoria generica. */
export function inferCategorySlug(description: string, kind: CategoryKind): string {
  const text = normalizeText(description).replace(/[^a-z0-9 ]/g, ' ');
  const table = kind === 'expense' ? EXPENSE_KEYWORDS : INCOME_KEYWORDS;
  for (const [slug, terms] of Object.entries(table)) {
    if (terms.some((term) => containsTerm(text, term))) return slug;
  }
  return kind === 'expense' ? FALLBACK_EXPENSE_SLUG : FALLBACK_INCOME_SLUG;
}
