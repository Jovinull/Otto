/**
 * Conta subrequisicoes da invocacao. No plano gratuito cada consulta D1 e cada fetch contam
 * para o limite de 50 por invocacao; um lote (batch) conta uma vez.
 */
export interface Meter {
  count: number;
}

/** Limite do plano gratuito por invocacao. */
export const SUBREQUEST_LIMIT = 50;
/**
 * Pior caso medido para processar um evento: ~29 consultas D1 numa analise, mais as chamadas
 * a IA e o envio ao Telegram (ver tests/integration/concurrency.test.ts).
 */
export const EVENT_RESERVE = 34;
/** Reivindicar, enviar e concluir uma mensagem do outbox. */
export const DELIVERY_RESERVE = 3;

export const canStartEvent = (meter: Meter): boolean =>
  meter.count + EVENT_RESERVE <= SUBREQUEST_LIMIT;

export const canDeliver = (meter: Meter): boolean =>
  meter.count + DELIVERY_RESERVE <= SUBREQUEST_LIMIT;

/** Trabalho leve de manutencao (consultas avulsas). */
export const hasBudget = (meter: Meter): boolean => meter.count + 10 <= SUBREQUEST_LIMIT;

const EXECUTORS = new Set(['run', 'all', 'first', 'raw']);

export function meterD1(database: D1Database, meter: Meter): D1Database {
  const originals = new WeakMap<object, D1PreparedStatement>();

  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, property) {
        if (property === 'bind') {
          return (...values: unknown[]) => wrap(target.bind(...values));
        }
        const value = Reflect.get(target, property, target) as unknown;
        if (typeof value !== 'function') return value;
        if (typeof property === 'string' && EXECUTORS.has(property)) {
          return (...args: unknown[]) => {
            meter.count += 1;
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return (value as (...a: unknown[]) => unknown).bind(target);
      },
    });
    originals.set(proxy, statement);
    return proxy;
  };

  return new Proxy(database, {
    get(target, property) {
      if (property === 'prepare') return (query: string) => wrap(target.prepare(query));
      if (property === 'batch') {
        return (statements: D1PreparedStatement[]) => {
          meter.count += 1;
          return target.batch(statements.map((s) => originals.get(s) ?? s));
        };
      }
      if (property === 'exec') {
        return (query: string) => {
          meter.count += 1;
          return target.exec(query);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
}

export function meteredFetch(meter: Meter): typeof fetch {
  return (...args) => {
    meter.count += 1;
    return fetch(...args);
  };
}
