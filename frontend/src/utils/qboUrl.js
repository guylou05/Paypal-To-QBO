/**
 * Build a QuickBooks Online deep-link URL for a given object type + ID.
 *
 * environment: 'sandbox' | 'production'  (from the /api/quickbooks/status response)
 *
 * QBO URL format:
 *   Production: https://app.qbo.intuit.com/app/{path}?txnId={id}
 *   Sandbox:    https://app.sandbox.qbo.intuit.com/app/{path}?txnId={id}
 */

const QBO_TYPE_PATH = {
  SalesReceipt:  'salesreceipt',
  JournalEntry:  'journal',
  Purchase:      'expense',
  Transfer:      'transfer',
  RefundReceipt: 'refundreceipt',
  Deposit:       'deposit',
  Bill:          'bill',
  Invoice:       'invoice',
};

export function buildQboUrl(objectType, objectId, environment = 'production') {
  if (!objectType || !objectId) return null;
  const path = QBO_TYPE_PATH[objectType];
  if (!path) return null;

  const base = environment === 'sandbox'
    ? 'https://app.sandbox.qbo.intuit.com/app'
    : 'https://app.qbo.intuit.com/app';

  return `${base}/${path}?txnId=${objectId}`;
}
