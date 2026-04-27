import { useNavigate } from 'react-router-dom'
import { SingleCallForm, type SingleCallPayload } from '../../components/calls/SingleCallForm'
import { adminCallsApi } from '../../services/api'

export default function AdminCallNew() {
  const navigate = useNavigate()
  const submit = async (payload: SingleCallPayload) => {
    const res = await adminCallsApi.initiateCall({
      customer_name: payload.customer_name,
      phone: payload.phone,
      loan_type: payload.loan_type,
      loan_amount: payload.loan_amount,
      language: payload.language,
      bank_id: payload.bank_id!,
      vendor_id: payload.vendor_id ?? null,
    })
    navigate(`/admin/calls/${res.call.id}`)
  }

  return (
    <div className="max-w-2xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">New call</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Initiate a call on behalf of a bank (or a vendor operating under one). The AI agent
          dials the customer and records the conversation.
        </p>
      </div>
      <SingleCallForm mode="admin" onSubmit={submit} onCancel={() => navigate('/admin/calls')} />
    </div>
  )
}
