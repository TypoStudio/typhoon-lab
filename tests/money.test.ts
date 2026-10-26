import { afterEach, describe, expect, it } from 'vitest';
import { setLanguage } from '../src/i18n';
import { CNY_PER_USD, JPY_PER_USD, KRW_PER_USD, TWD_PER_USD, fmtMoney } from '../src/ui/dom';

afterEach(() => setLanguage('en'));
describe('fmtMoney', () => {
  it('shows USD in English', () => {
    setLanguage('en');
    expect(fmtMoney(1_234_000)).toBe('USD 1,234,000');
    expect(fmtMoney(0)).toBe('USD 0');
  });
  it('shows won in Korean units at the fixed game rate, one unit level', () => {
    setLanguage('ko');
    expect(KRW_PER_USD).toBe(1350);
    expect(fmtMoney(0)).toBe('0원');
    expect(fmtMoney(999)).toBe('134만 원');
    expect(fmtMoney(12_345)).toBe('1,666만 원');
    expect(fmtMoney(1_234_567)).toBe('16억 원');
    expect(fmtMoney(1_000_000_000)).toBe('1조 3,500억 원');
    expect(fmtMoney(15_000_000_000)).toBe('20조 2,500억 원');
    expect(fmtMoney(1_000_000_000_000_000 / KRW_PER_USD)).toBe('1,000조 원');
    expect(fmtMoney(2_000_000_000)).toBe('2조 7,000억 원');
    expect(fmtMoney(100_000_000 / 1350 * 1234)).toBe('1,234억 원');
  });
  it('shows yen with 万/億/兆 units at the fixed game rate', () => {
    setLanguage('ja');
    expect(JPY_PER_USD).toBe(150);
    expect(fmtMoney(0)).toBe('0円');
    expect(fmtMoney(40)).toBe('6,000円');
    expect(fmtMoney(12_345)).toBe('185万円');
    expect(fmtMoney(230_000_000)).toBe('345億円');
    expect(fmtMoney(8_000_000_000)).toBe('1.2兆円');
    expect(fmtMoney(8_333_333_333)).toBe('1.2兆円');
  });
  it('shows RMB yuan with 万/亿/万亿 units at the fixed game rate', () => {
    setLanguage('zh-CN');
    expect(CNY_PER_USD).toBe(7.2);
    expect(fmtMoney(0)).toBe('0元');
    expect(fmtMoney(1_000)).toBe('7,200元');
    expect(fmtMoney(100_000)).toBe('72万元');
    expect(fmtMoney(50_000_000)).toBe('3.6亿元');
    expect(fmtMoney(500_000_000)).toBe('36.0亿元');
    expect(fmtMoney(500_000_000_000)).toBe('3.6万亿元');
  });
  it('shows New Taiwan dollars with 萬/億/兆 units at the fixed game rate', () => {
    setLanguage('zh-TW');
    expect(TWD_PER_USD).toBe(32);
    expect(fmtMoney(0)).toBe('NT$0');
    expect(fmtMoney(100)).toBe('NT$3,200');
    expect(fmtMoney(12_345)).toBe('NT$39萬');
    expect(fmtMoney(37_500_000)).toBe('NT$12億');
    expect(fmtMoney(1_000_000_000_000 / 32 * 2.5)).toBe('NT$2.5兆');
  });
});
