export interface PaymentRecord {
  id: string;
  userId: string;
  type: 'subscription' | 'consultation';
  title: string;
  titleBn: string;
  amountBDT: number;
  method: 'bkash' | 'nagad' | 'card' | 'clinic';
  status: 'completed' | 'refunded';
  date: string;
  referenceId: string;
}

const PAYMENTS_KEY = 'pathway_payment_records';

function getSeedPayments(): PaymentRecord[] {
  return [
    {
      id: 'pay-seed-1',
      userId: 'user-shanto',
      type: 'consultation',
      title: 'Consultation with Prof. Dr. Tanvir Ahmed',
      titleBn: 'অধ্যাপক ডাঃ তানভীর আহমেদের অনলাইন ভিজিট ফি',
      amountBDT: 2000,
      method: 'bkash',
      status: 'completed',
      date: '2026-11-09',
      referenceId: 'BKASH-TXN-884912'
    },
    {
      id: 'pay-seed-2',
      userId: 'user-shanto',
      type: 'consultation',
      title: 'Consultation with Dr. Nusrat Jahan',
      titleBn: 'ডাঃ নুসরত জাহানের অনলাইন ভিজিট ফি',
      amountBDT: 1800,
      method: 'bkash',
      status: 'completed',
      date: '2026-10-24',
      referenceId: 'BKASH-TXN-719302'
    }
  ];
}

export function getUserPayments(userId: string): PaymentRecord[] {
  const raw = localStorage.getItem(PAYMENTS_KEY);
  if (!raw) {
    const seeds = getSeedPayments();
    localStorage.setItem(PAYMENTS_KEY, JSON.stringify(seeds));
    return seeds;
  }
  try {
    const all: PaymentRecord[] = JSON.parse(raw);
    return all.filter((p) => p.userId === userId);
  } catch {
    return getSeedPayments();
  }
}

export function recordPayment(payment: Omit<PaymentRecord, 'id' | 'date'>): PaymentRecord {
  const raw = localStorage.getItem(PAYMENTS_KEY);
  const all: PaymentRecord[] = raw ? JSON.parse(raw) : getSeedPayments();

  const newRecord: PaymentRecord = {
    ...payment,
    id: `pay-${Date.now()}`,
    date: new Date().toISOString().split('T')[0]
  };

  all.unshift(newRecord);
  localStorage.setItem(PAYMENTS_KEY, JSON.stringify(all));
  return newRecord;
}

// Download receipt printable summary
export function downloadReceipt(payment: PaymentRecord) {
  const receiptHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Pathway Receipt - ${payment.referenceId}</title>
        <style>
          body { font-family: sans-serif; padding: 2.5rem; max-width: 600px; margin: 0 auto; color: #2d3748; border: 1px solid #e2e8f0; border-radius: 8px; }
          .header { border-bottom: 2px solid #1d4ed8; padding-bottom: 1rem; margin-bottom: 1.5rem; }
          .logo { font-size: 24px; font-weight: bold; color: #1d4ed8; }
          .badge { display: inline-block; padding: 3px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; background: #dbeafe; color: #1e40af; }
          .table { width: 100%; border-collapse: collapse; margin: 1.5rem 0; }
          .table td { padding: 8px 0; border-bottom: 1px solid #edf2f7; }
          .total { font-size: 18px; font-weight: bold; color: #1a202c; }
        </style>
      </head>
      <body>
        <div class="header">
          <div class="logo">Pathway</div>
          <p style="margin: 4px 0; font-size: 13px; color: #718096;">Digital Payment Receipt &bull; Tax Inclusive</p>
        </div>
        <p><span class="badge">Status: ${payment.status.toUpperCase()}</span> &bull; <strong>Ref:</strong> ${payment.referenceId}</p>
        <table class="table">
          <tr><td><strong>Date:</strong></td><td style="text-align: right;">${payment.date}</td></tr>
          <tr><td><strong>Description:</strong></td><td style="text-align: right;">${payment.title}</td></tr>
          <tr><td><strong>Payment Method:</strong></td><td style="text-align: right;">${payment.method.toUpperCase()}</td></tr>
          <tr class="total"><td>Total Paid:</td><td style="text-align: right;">BDT ${payment.amountBDT.toLocaleString()}</td></tr>
        </table>
        <p style="font-size: 11px; color: #a0aec0; margin-top: 2rem;">Pathway &bull; Dhaka, Bangladesh &bull; info@pathway.support</p>
      </body>
    </html>
  `;

  const blob = new Blob([receiptHtml], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, '_blank');
  if (!win) {
    const a = document.createElement('a');
    a.href = url;
    a.download = `pathway-receipt-${payment.referenceId}.html`;
    a.click();
  }
}
