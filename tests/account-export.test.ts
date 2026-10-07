import { describe, expect, it } from 'vitest';
import { csvContent, excelContent } from '../components/views/export';

describe('accounting exports', () => {
  it('preserves codes and Arabic labels and correctly quotes CSV cells', () => {
    expect(csvContent([
      ['Code', 'Account Name', 'Balance'],
      ['001010', 'نقد، "رئيسي"\nCash', 125.5],
    ])).toBe('Code,Account Name,Balance\r\n001010,"نقد، ""رئيسي""\nCash",125.5');
  });

  it('keeps leading-zero codes as text in Excel while balances stay numeric', () => {
    const html = excelContent([['Code', 'Name', 'Balance'], ['001010', 'Cash', 125.5]]);
    expect(html).toContain('<td style=\'mso-number-format:"\\@"\'>001010</td>');
    expect(html).toContain('<td>125.5</td>');
  });

  it('escapes exported names so HTML is data and empty balances remain empty', () => {
    const html = excelContent([['Name', 'Balance'], ['<script> & نقد', null]]);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script> &amp; نقد');
    expect(html).toContain('<td></td>');
    expect(csvContent([['Cash, bank', false]])).toBe('"Cash, bank",');
  });
});
