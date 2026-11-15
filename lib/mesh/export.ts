import type { MeshState } from "./types";

// Prefix spreadsheet formula initiators; invoice descriptions and names are untrusted.
function csvCell(value: string | number) {
  let text = String(value);
  if (/^[\s]*[=+@\-]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export function ledgerCsv(state: MeshState) {
  const rows: (string | number)[][] = [["Entry", "Invoice", "Owner", "Account", "Debit", "Credit", "Currency", "Receipt", "Date"]];
  for (const entry of state.ledger) {
    rows.push([entry.id, state.invoices.find((invoice) => invoice.id === entry.invoiceId)?.number ?? entry.invoiceId,
      state.accounts.find((account) => account.id === entry.accountId)?.name ?? entry.accountId, entry.account,
      (entry.debitCents / 100).toFixed(2), (entry.creditCents / 100).toFixed(2), entry.currency, entry.receiptId, entry.createdAt]);
  }
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}
