import React from 'react';

const STATUS_STYLES = {
  imported:     'bg-gray-700 text-gray-300',
  classified:   'bg-blue-900 text-blue-300',
  needs_review: 'bg-yellow-900 text-yellow-300',
  approved:     'bg-indigo-900 text-indigo-300',
  synced:       'bg-green-900 text-green-300',
  ignored:      'bg-gray-800 text-gray-500',
  failed:       'bg-red-900 text-red-300',
};

const CATEGORY_STYLES = {
  sale:                    'bg-emerald-900 text-emerald-300',
  paypal_fee:              'bg-orange-900 text-orange-300',
  paypal_credit_purchase:  'bg-purple-900 text-purple-300',
  paypal_credit_repayment: 'bg-violet-900 text-violet-300',
  bank_transfer_in:        'bg-cyan-900 text-cyan-300',
  bank_transfer_out:       'bg-teal-900 text-teal-300',
  refund:                  'bg-rose-900 text-rose-300',
  noise:                   'bg-gray-800 text-gray-500',
  unknown:                 'bg-yellow-900 text-yellow-400',
};

const LABELS = {
  // statuses
  imported:     'Imported',
  classified:   'Classified',
  needs_review: 'Needs Review',
  approved:     'Approved',
  synced:       'Synced',
  ignored:      'Ignored',
  failed:       'Failed',
  // categories
  sale:                    'Sale',
  paypal_fee:              'PayPal Fee',
  paypal_credit_purchase:  'PP Credit Purchase',
  paypal_credit_repayment: 'PP Credit Repayment',
  bank_transfer_in:        'Bank → PayPal',
  bank_transfer_out:       'PayPal → Bank',
  refund:                  'Refund',
  noise:                   'Noise/Hold',
  unknown:                 'Unknown',
};

export default function StatusBadge({ value, type = 'status' }) {
  const styles = type === 'status' ? STATUS_STYLES : CATEGORY_STYLES;
  const cls    = styles[value] || 'bg-gray-700 text-gray-400';
  const label  = LABELS[value] || value || '—';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {label}
    </span>
  );
}
