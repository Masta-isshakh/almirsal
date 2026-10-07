/**
 * Client-side downloads: CSV with a UTF-8 BOM (Excel opens Arabic correctly)
 * and the same rows as an Excel-compatible HTML table (`.xls`).
 */
function csvCell(value: unknown): string {
  const text = value === null || value === undefined || value === false ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvContent(rows: unknown[][]): string {
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}

export function downloadCsv(filename: string, rows: unknown[][]): void {
  const body = csvContent(rows);
  downloadBlob(filename, new Blob(['﻿', body], { type: 'text/csv;charset=utf-8' }));
}

export function excelContent(rows: unknown[][]): string {
  const escape = (value: unknown) => String(value === null || value === undefined || value === false ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  // Account codes and references are text: Excel must keep leading zeros.
  // Numeric values still export as numbers so amounts can be totalled.
  const table = `<table>${rows.map((row, index) => `<tr>${row.map((cell) => (index === 0 ? `<th>${escape(cell)}</th>` : `<td${typeof cell === 'string' ? ' style=\'mso-number-format:"\\@"\'' : ''}>${escape(cell)}</td>`)).join('')}</tr>`).join('')}</table>`;
  return `<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"></head><body>${table}</body></html>`;
}

export function downloadXls(filename: string, rows: unknown[][]): void {
  const html = excelContent(rows);
  downloadBlob(filename, new Blob(['﻿', html], { type: 'application/vnd.ms-excel' }));
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
