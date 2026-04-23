import { useNavigate } from 'react-router-dom'
import { Button } from '../../components/Field'
import { BulkUploadPanel } from '../../components/calls/BulkUploadPanel'
import { adminCallsApi } from '../../services/api'

export default function AdminCallBulk() {
  const navigate = useNavigate()
  return (
    <div className="max-w-4xl space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Bulk upload</h1>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            Upload a customer list on behalf of a bank. Only one bank per file.
          </p>
        </div>
        <Button variant="secondary" onClick={() => navigate('/admin/calls')}>
          Back to calls
        </Button>
      </div>
      <BulkUploadPanel mode="admin" uploadApi={adminCallsApi.uploadBulk} />
    </div>
  )
}
