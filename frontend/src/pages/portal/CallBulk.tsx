import { useNavigate } from 'react-router-dom'
import { Button } from '../../components/Field'
import { BulkUploadPanel } from '../../components/calls/BulkUploadPanel'
import { portalApi } from '../../services/api'

export default function PortalCallBulk() {
  const navigate = useNavigate()
  return (
    <div className="max-w-4xl space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Bulk upload</h1>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            Upload a CSV or Excel with your customer list. The AI agent will dial each row and
            log the conversation.
          </p>
        </div>
        <Button variant="secondary" onClick={() => navigate('/portal/calls')}>
          Back to calls
        </Button>
      </div>
      <BulkUploadPanel mode="portal" uploadApi={portalApi.uploadBulk} />
    </div>
  )
}
