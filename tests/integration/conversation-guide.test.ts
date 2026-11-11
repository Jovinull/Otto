import { beforeEach, describe, expect, it } from 'vitest';
import type { HelpTopic } from '../../src/infrastructure/ai/interpretation';
import type { Harness } from '../fixtures/harness';
import { buttonData, createHarness, interpretation, JENNIFER_ID } from '../fixtures/harness';

let h: Harness;
const day = (iso: string) =>
  Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)), 15);

async function at(iso: string, text: string, from?: string) {
  h.setNow(day(iso));
  await h.say(text, from === undefined ? undefined : { from });
  return h.messaging.last();
}

const writes = async () =>
  (await h.count('financial_transactions')) + (await h.count('pending_actions'));

beforeEach(async () => {
  h = await createHarness();
  await at('2026-10-20', '/addconta corrente Principal saldo=5000 padrao');
  await at('2026-10-20', '/addconta cartao Nubank fecha=3 vence=10 padrao');
  await at('2026-10-20', '/addconta cartao Santander fecha=20 vence=28');
});

describe('conferencia da fatura', () => {
  beforeEach(async () => {
    await at('2026-10-10', '/gasto 100 mercado @Nubank');
    await at('2026-10-15', '/gasto 50 farmacia @Nubank');
    await at('2026-10-20', '/gasto 300 tenis cartao 3x');
  });

  it('confere quando bate e lista as compras com codigo, sem gravar nada', async () => {
    const before = await writes();
    const text = await at('2026-11-05', '/fatura Nubank 250');
    expect(text).toContain('Nubank: fatura que vence 10/11 (fechou 03/11)');
    expect(text).toContain('✅ Confere');
    expect(text).toMatch(/10\/10 mercado: R\$ 100,00 · #[0-9a-f]{6}/);
    expect(text).toContain('tenis (parcela 1/3): R$ 100,00');
    expect(text).toContain('paguei a fatura do Nubank');
    expect(await writes()).toBe(before);
  });

  it('mostra quanto falta e como lancar a compra esquecida', async () => {
    const text = await at('2026-11-05', '/fatura Nubank 280,90');
    expect(text).toContain('Você informou R$ 280,90; aqui tenho R$ 250,00.');
    expect(text).toContain('Faltam R$ 30,90 registrados aqui.');
    expect(text).toContain('/gasto 30 padaria @Nubank 31/10');
    expect(text).toContain('Pega as compras de 03/10 a 02/11.');
    expect(text).toContain('juros');
    // Lanca o que faltou e confere de novo.
    await at('2026-11-05', '/gasto 30,90 padaria @Nubank 01/11');
    expect(await at('2026-11-05', '/fatura Nubank 280,90')).toContain('✅ Confere');
  });

  it('aponta o item a mais e possivel duplicado', async () => {
    await at('2026-10-15', '/gasto 50 farmacia @Nubank');
    // O Otto pergunta se e repetido; aqui a pessoa confirma mesmo assim.
    await h.press(buttonData(h.messaging, 'c'));
    const text = await at('2026-11-05', '/fatura 250');
    expect(text).toContain('Tenho R$ 50,00 a mais que a fatura.');
    expect(text).toContain('Parece duplicado: farmacia');
    expect(text).toContain('/estornar CODIGO');
  });

  it('compra no dia do fechamento que o banco pos nesta fatura', async () => {
    await at('2026-11-03', '/gasto 40 uber @Nubank');
    const text = await at('2026-11-05', '/fatura Nubank 290');
    expect(text).toContain('uber (03/11');
    expect(text).toContain('está na próxima fatura');
  });

  it('soma faturas anteriores em aberto quando o banco somou', async () => {
    await at('2026-12-05', '/gasto 10 cafe @Nubank 20/11');
    // Novembro (250) nao foi paga; dezembro tem 100 da parcela + 10.
    expect(await at('2026-12-05', '/fatura Nubank 360')).toContain(
      'Confere somando R$ 250,00 de faturas anteriores',
    );
  });

  it('fatura ainda aberta avisa que compras novas entram', async () => {
    await at('2026-11-10', '/pagar_fatura 250 Principal para Nubank');
    const text = await at('2026-11-20', '/fatura Nubank 100');
    expect(text).toContain('Ela ainda está aberta');
    expect(text).toContain('✅ Confere');
  });

  it('usa o cartao padrao de quem pergunta e nunca o de outra pessoa', async () => {
    await at('2026-10-20', '/addconta cartao PicPay fecha=5 vence=12 padrao', JENNIFER_ID);
    expect(await at('2026-11-05', '/fatura 250')).toContain('Nubank: fatura');
    expect(await at('2026-11-06', '/fatura 10', JENNIFER_ID)).toContain('PicPay: fatura');
    expect(await at('2026-11-06', '/fatura Bradesco 10')).toContain('Não achei o cartão');
  });

  it('linguagem natural: "a fatura veio 250, confere?"', async () => {
    h.ai.nextInterpretation = interpretation('check_invoice', {
      invoice: { card_text: 'Nubank', amount_text: '250' },
    });
    expect(await at('2026-11-05', 'Otto, a fatura do Nubank veio 250, confere?')).toContain(
      '✅ Confere',
    );
  });

  it('valor que nao aparece na mensagem nao e usado', async () => {
    h.ai.nextInterpretation = interpretation('check_invoice', {
      invoice: { card_text: 'Nubank', amount_text: '250' },
    });
    expect(await at('2026-11-05', 'Otto, confere a fatura do Nubank?')).toContain(
      'Não consegui confirmar o valor',
    );
  });

  it('pedir para conferir sem valor mostra a fatura e pede o valor', async () => {
    h.ai.nextInterpretation = interpretation('check_invoice', {
      invoice: { card_text: 'Nubank', amount_text: null },
    });
    const text = await at('2026-11-05', 'Otto, me ajuda a conferir a fatura do Nubank');
    expect(text).toContain('💳 Nubank');
    expect(text).toContain('/fatura Nubank 300');
  });
});

describe('vencimento em dia sem banco', () => {
  it('mostra que o vencimento passou para o dia util', async () => {
    // Santander fecha 20 e vence 28; 28/11/2026 e sabado.
    await at('2026-11-10', '/gasto 80 livro @Santander');
    const text = await at('2026-11-22', '/fatura Santander');
    expect(text).toContain('vence 30/11');
    expect(text).toContain('O vencimento de 28/11 cai num sábado: passa para 30/11.');
  });
});

describe('guia em conversa', () => {
  const ask = (text: string, topic: HelpTopic) => {
    h.ai.nextInterpretation = interpretation('how_to', { help_topic: topic });
    return at('2026-11-05', text);
  };

  it('responde com os nomes do cadastro de quem pergunta', async () => {
    const card = await ask('Otto, como lanço uma compra parcelada?', 'card_purchase');
    expect(card).toContain('"Cartão" sozinho usa o seu padrão (Nubank)');
    expect(card).toContain('Outro: @Santander');
    const expense = await ask('Otto, como lanço um gasto?', 'expense');
    expect(expense).toContain('uso a sua padrão (Principal)');
    const check = await ask('Otto, o que faço quando a fatura chegar?', 'check_invoice');
    expect(check).toContain('/fatura Nubank 300');
  });

  it('sem cadastro, orienta o primeiro passo', async () => {
    const card = await ask('Otto, como lanço no cartão?', 'card_purchase');
    expect(card).not.toContain('Você ainda não tem cartão');
    h.ai.nextInterpretation = interpretation('how_to', { help_topic: 'card_purchase' });
    expect(await at('2026-11-05', 'Otto, como lanço no cartão?', JENNIFER_ID)).toContain(
      'Você ainda não tem cartão',
    );
  });

  it('metas usam as metas reais', async () => {
    await at('2026-11-01', '/meta criar Viagem valor=8000');
    await at('2026-11-01', '/addconta reserva Cofre saldo=0');
    const text = await ask('Otto, como guardo dinheiro na meta?', 'goal_money');
    expect(text).toContain('/aporte Viagem 200 @Cofre');
    expect(text).toContain('Metas de vocês: Viagem.');
  });

  it('todos os temas respondem sem erro e sem gravar nada', async () => {
    const before = await writes();
    for (const topic of [
      'expense',
      'card_purchase',
      'income',
      'transfer',
      'pay_invoice',
      'check_invoice',
      'goal',
      'goal_money',
      'budget',
      'fixed_bills',
      'accounts',
      'balance_check',
      'correct',
      'shared',
      'reports',
      'notifications',
      'setup',
      'other',
    ] as const) {
      const text = await ask('Otto, como faço?', topic);
      expect(text.length, topic).toBeGreaterThan(30);
      expect(text, topic).not.toContain('undefined');
    }
    expect(await writes()).toBe(before);
  });

  it('/ajuda TEMA livre usa o guia', async () => {
    expect(await at('2026-11-05', '/ajuda fatura')).toContain('Paguei a fatura do Nubank');
    expect(await at('2026-11-05', '/ajuda conferir fatura')).toContain('/fatura Nubank 300');
    expect(await at('2026-11-05', '/ajuda meta')).toContain('/meta criar Viagem');
  });
});

describe('quando algo da errado', () => {
  it('nao entendeu: sugere os caminhos pelo assunto', async () => {
    h.ai.nextInterpretation = interpretation('unknown');
    const text = await at('2026-11-05', 'Otto, aquela coisa da fatura do cartão lá');
    expect(text).toContain('Nada foi registrado');
    expect(text).toContain('/fatura');
    expect(text).toContain('como faço para');
  });

  it('comando inexistente sugere o parecido ou o substituto', async () => {
    expect(await at('2026-11-05', '/fatrua')).toContain('Você quis dizer /fatura');
    expect(await at('2026-11-05', '/faturas')).toContain('Use /fatura');
    expect(await at('2026-11-05', '/conferir')).toContain('/fatura CARTÃO VALOR');
    expect(await at('2026-11-05', '/xyzabc')).toContain('/comandos');
  });
});
