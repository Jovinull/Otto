import { describe, expect, it } from 'vitest';
import {
  addMonths,
  dayInPeriod,
  localClock,
  monthRange,
  nthWeekdayApprox,
  parseMonthExpression,
  resolveDateExpression,
  resolveNamedPeriod,
  toLocalDate,
  weekRange,
} from '../../src/shared/dates';
import { formatBRL, parseBRL, percentOf, splitInstallments } from '../../src/shared/money';

describe('parseBRL', () => {
  it.each([
    ['25', 2500],
    ['25,50', 2550],
    ['25,5', 2550],
    ['R$ 25,50', 2550],
    ['r$25,50', 2550],
    ['1.250,00', 125000],
    ['1.250', 125000],
    ['1.250.000,99', 125000099],
    ['2 mil', 200000],
    ['1,5 mil', 150000],
    ['2k', 200000],
    ['38 reais', 3800],
    ['0,01', 1],
  ])('interpreta %s', (input, cents) => {
    expect(parseBRL(input)).toEqual({ status: 'ok', cents });
  });

  it.each([
    ['12.50', 1250],
    ['1.5', 150],
    ['1,250', 125],
  ])('nao aceita silenciosamente o valor ambiguo %s', (input, candidate) => {
    expect(parseBRL(input)).toMatchObject({ status: 'ambiguous', candidateCents: candidate });
  });

  it.each(['abc', '', '0', '0,00', '-10', '1.25.00', '999999999999', 'R$'])(
    'rejeita %s',
    (input) => {
      expect(parseBRL(input).status).toBe('invalid');
    },
  );
});

describe('formatBRL', () => {
  it('formata com milhar e centavos sem float', () => {
    expect(formatBRL(123456789)).toBe('R$ 1.234.567,89');
    expect(formatBRL(5)).toBe('R$ 0,05');
    expect(formatBRL(-2550)).toBe('-R$ 25,50');
  });
});

describe('percentOf', () => {
  it('trunca em vez de arredondar para nao antecipar alerta', () => {
    expect(percentOf(799, 1000)).toBe(79);
    expect(percentOf(1, 0)).toBe(0);
  });
});

describe('splitInstallments', () => {
  it('soma exatamente o total', () => {
    expect(splitInstallments(120000, 6)).toEqual(Array(6).fill(20000));
    const parts = splitInstallments(100000, 3);
    expect(parts).toEqual([33334, 33333, 33333]);
    expect(parts.reduce((a, b) => a + b)).toBe(100000);
  });

  it('rejeita quantidades invalidas', () => {
    expect(() => splitInstallments(100, 0)).toThrow(RangeError);
    expect(() => splitInstallments(0, 2)).toThrow(RangeError);
  });
});

describe('fuso horario', () => {
  it('usa a data local, nao a data UTC', () => {
    // 02:30 UTC do dia 01/12 ainda e 30/11 em Maceio.
    const instant = Date.UTC(2026, 11, 1, 2, 30);
    expect(toLocalDate(instant, 'America/Maceio')).toBe('2026-11-30');
    expect(toLocalDate(instant, 'UTC')).toBe('2026-12-01');
  });

  it('expoe hora e dia da semana locais', () => {
    const clock = localClock(Date.UTC(2026, 10, 9, 12, 0), 'America/Maceio');
    expect(clock).toEqual({ date: '2026-11-09', hour: 9, weekday: 1 });
  });
});

describe('periodos', () => {
  it('atravessa virada de ano', () => {
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2027-01', -1)).toBe('2026-12');
  });

  it('calcula fevereiro bissexto e comum', () => {
    expect(monthRange('2028-02').to).toBe('2028-02-29');
    expect(monthRange('2027-02').to).toBe('2027-02-28');
  });

  it('ajusta dia inexistente ao fim do mes', () => {
    expect(dayInPeriod('2026-11', 31)).toBe('2026-11-30');
  });

  it('semana comeca na segunda', () => {
    expect(weekRange('2026-11-08')).toEqual({ from: '2026-11-02', to: '2026-11-08' });
  });

  it('calcula ultimos 7 dias incluindo hoje', () => {
    expect(resolveNamedPeriod('last_7_days', '2026-11-10')).toEqual({
      from: '2026-11-04',
      to: '2026-11-10',
    });
  });

  it('calcula n-esimo dia util sem feriados', () => {
    // 01/11/2026 e domingo; o quinto dia de semana e sexta 06/11.
    expect(nthWeekdayApprox('2026-11', 5)).toBe('2026-11-06');
  });

  it('interpreta mes por nome', () => {
    expect(parseMonthExpression('novembro', '2026-11-10')).toBe('2026-11');
    expect(parseMonthExpression('março de 2027', '2026-11-10')).toBe('2027-03');
    expect(parseMonthExpression('13/2026', '2026-11-10')).toBeNull();
  });
});

describe('resolveDateExpression', () => {
  const today = '2026-11-10'; // terca

  it.each([
    ['', today],
    ['hoje', today],
    ['ontem', '2026-11-09'],
    ['anteontem', '2026-11-08'],
    ['03/11', '2026-11-03'],
    ['dia 3', '2026-11-03'],
    ['segunda', '2026-11-09'],
    ['terça', '2026-11-03'],
  ])('resolve "%s"', (expression, expected) => {
    expect(resolveDateExpression(expression, today)).toEqual({ status: 'ok', date: expected });
  });

  it('dia maior que hoje vai para o mes anterior', () => {
    expect(resolveDateExpression('dia 28', today)).toEqual({ status: 'ok', date: '2026-10-28' });
  });

  it('semana passada e imprecisa e devolve o intervalo', () => {
    expect(resolveDateExpression('semana passada', today)).toEqual({
      status: 'imprecise',
      range: { from: '2026-11-02', to: '2026-11-08' },
    });
  });

  it('recusa datas futuras e invalidas', () => {
    expect(resolveDateExpression('25/12/2026', today).status).toBe('invalid');
    expect(resolveDateExpression('32/01', today).status).toBe('invalid');
    expect(resolveDateExpression('qualquer coisa', today).status).toBe('invalid');
  });
});
