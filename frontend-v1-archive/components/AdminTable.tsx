'use client';
import { CheckCircle2, XCircle } from 'lucide-react';

import { useState } from 'react';
import { reviewApplication, formatCurrency, formatDate } from '@/lib/api';

interface Application {
  id: string;
  customer_name: string;
  phone: string;
  loan_id: string;
  loan_amount?: number;
  loan_type?: string;
  status: string;
  submitted_at?: string;
  created_at?: string;
  current_step: number;
  is_complete: boolean;
  pan_verified?: boolean;
  aadhaar_verified?: boolean;
  review_notes?: string;
  rejection_reason?: string;
}

interface AdminTableProps {
  applications: Application[];
  onRefresh: () => void;
  adminToken: string;
}

const statusColors: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-700',
  submitted: 'bg-blue-100 text-blue-700',
  under_review: 'bg-yellow-100 text-yellow-700',
  approved: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
};

export default function AdminTable({ applications, onRefresh, adminToken }: AdminTableProps) {
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [rejectionReason, setRejectionReason] = useState('');
  const [actionLoading, setActionLoading] = useState(false);

  const handleReview = async (id: string, action: string) => {
    setActionLoading(true);
    try {
      await reviewApplication(adminToken, id, action, notes, rejectionReason);
      setReviewingId(null);
      setNotes('');
      setRejectionReason('');
      onRefresh();
    } catch (error) {
      console.error('Review failed:', error);
      alert('Review action failed');
    } finally {
      setActionLoading(false);
    }
  };

  if (applications.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow p-8 text-center">
        <p className="text-gray-500 text-lg">No applications found</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow overflow-hidden">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Customer</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Loan ID</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Amount</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">KYC</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Date</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {applications.map((app) => (
              <tr key={app.id} className="hover:bg-gray-50">
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="text-sm font-medium text-gray-900">{app.customer_name}</div>
                  <div className="text-sm text-gray-500">{app.phone}</div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{app.loan_id}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                  {app.loan_amount ? formatCurrency(app.loan_amount) : '-'}
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <span className={`px-2 py-1 text-xs font-medium rounded-full ${statusColors[app.status] || 'bg-gray-100'}`}>
                    {app.status?.replace('_', ' ')}
                  </span>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm">
                  <div className="flex gap-2">
                    <span className={`flex items-center gap-1 ${app.pan_verified ? 'text-green-600' : 'text-gray-400'}`}>
                      {app.pan_verified ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />} PAN
                    </span>
                    <span className={`flex items-center gap-1 ${app.aadhaar_verified ? 'text-green-600' : 'text-gray-400'}`}>
                      {app.aadhaar_verified ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />} Aadhaar
                    </span>
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                  {app.submitted_at ? formatDate(app.submitted_at) : formatDate(app.created_at || '')}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm">
                  {app.status === 'submitted' && (
                    <>
                      {reviewingId === app.id ? (
                        <div className="space-y-2 min-w-[200px]">
                          <textarea
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            placeholder="Review notes..."
                            className="w-full text-xs border rounded p-1"
                            rows={2}
                          />
                          <input
                            value={rejectionReason}
                            onChange={(e) => setRejectionReason(e.target.value)}
                            placeholder="Rejection reason (if rejecting)"
                            className="w-full text-xs border rounded p-1"
                          />
                          <div className="flex gap-1">
                            <button
                              onClick={() => handleReview(app.id, 'approve')}
                              disabled={actionLoading}
                              className="px-2 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50"
                            >
                              Approve
                            </button>
                            <button
                              onClick={() => handleReview(app.id, 'reject')}
                              disabled={actionLoading}
                              className="px-2 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
                            >
                              Reject
                            </button>
                            <button
                              onClick={() => setReviewingId(null)}
                              className="px-2 py-1 text-xs bg-gray-200 text-gray-700 rounded hover:bg-gray-300"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          onClick={() => setReviewingId(app.id)}
                          className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
                        >
                          Review
                        </button>
                      )}
                    </>
                  )}
                  {app.status === 'approved' && (
                    <span className="text-green-600 font-medium">Approved</span>
                  )}
                  {app.status === 'rejected' && (
                    <span className="text-red-600 font-medium" title={app.rejection_reason || ''}>
                      Rejected
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
