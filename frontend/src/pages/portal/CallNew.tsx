import { useNavigate } from 'react-router-dom'
import { SingleCallForm, type SingleCallPayload } from '../../components/calls/SingleCallForm'
import { portalApi } from '../../services/api'

export default function CallNew() {
  const navigate = useNavigate()
  const submit = async (payload: SingleCallPayload) => {
    const res = await portalApi.initiateCall({
      customer_name: payload.customer_name,
      phone: payload.phone,
      loan_type: payload.loan_type,
      loan_amount: payload.loan_amount,
      language: payload.language,
    })
    navigate(`/portal/calls/${res.call.id}`)
  }

  return (
    <div className="max-w-2xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">New call</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          The AI agent will call the customer in the chosen language, answer their questions, and
          collect loan details.
        </p>
      </div>
      <SingleCallForm mode="portal" onSubmit={submit} onCancel={() => navigate('/portal/calls')} />
    </div>
  )
}
