import { expect, test } from 'bun:test';
import { copilotBudget, copilotBudgetStatus, formatCopilotMoney } from '../src/copilot-budget';
import { normalizeCodexLimits, renderLimitsHtml, renderLimitsText } from '../src/limits';

const settings = { SPENDWATCH_COPILOT_MONTHLY_EUR: '400', SPENDWATCH_USD_EUR_RATE: String(1 / 1.1206), SPENDWATCH_FX_RATE_DATE: '2026-10-09' };

test('EUR ceiling uses the real USD credit value and crosses at the converted allowance', () => {
  const budget = copilotBudget(settings);
  expect(budget.credits).toBe(44824);
  expect(budget.creditUsd).toBe(0.01);
  const account = normalizeCodexLimits({ provider: 'copilot', account: 'dev', usage: { accountEmail: 'dev', loginMethod: 'business' }, copilot: { premiumCreditsUsed: 44825 } })[0]!;
  const status = copilotBudgetStatus(account, budget);
  expect(status.over).toBe(true);
  expect(status.usedPercent).toBeGreaterThan(100);
  expect(formatCopilotMoney(budget.usd, budget)).toBe('€400');
});

test('EUR needs a real exchange rate', () => {
  expect(() => copilotBudget({ SPENDWATCH_COPILOT_MONTHLY_EUR: '400' })).toThrow('SPENDWATCH_USD_EUR_RATE');
});

test('money, warning and terminal output all use the EUR budget', () => {
  const original = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, settings);
    const accounts = normalizeCodexLimits({ provider: 'copilot', account: 'dev', usage: { accountEmail: 'dev', loginMethod: 'business' }, copilot: { premiumCreditsUsed: 50000 } });
    const html = renderLimitsHtml(accounts);
    expect(html).toContain('€446.19 / €400');
    expect(html).toContain('€46.19 over the €400 ceiling');
    expect(html).toContain('FX 2026-10-09');
    expect(renderLimitsText(accounts)).toContain('€446.19 of €400');
  } finally {
    for (const [key, value] of Object.entries(original)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
