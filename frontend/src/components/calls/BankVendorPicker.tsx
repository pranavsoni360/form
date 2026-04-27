// Admin-only dropdown pair. Admin must attribute every call to a bank (and
// optionally a vendor operating under that bank). Portal users don't see this
// because their bank/vendor is derived from their JWT.
import { useEffect, useMemo, useState } from 'react'
import { adminApi } from '../../services/api'
import { Field, Select } from '../Field'

export type BankVendor = { bankId: string; vendorId: string }

export function BankVendorPicker({
  value,
  onChange,
  disabled,
}: {
  value: BankVendor
  onChange: (next: BankVendor) => void
  disabled?: boolean
}) {
  const [banks, setBanks] = useState<any[]>([])
  const [vendors, setVendors] = useState<any[]>([])
  const [loadingBanks, setLoadingBanks] = useState(true)
  const [loadingVendors, setLoadingVendors] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoadingBanks(true)
    adminApi
      .banks()
      .then((d) => setBanks(d.banks || []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load banks'))
      .finally(() => setLoadingBanks(false))
  }, [])

  useEffect(() => {
    if (!value.bankId) {
      setVendors([])
      return
    }
    setLoadingVendors(true)
    adminApi
      .vendors(value.bankId)
      .then((d) => setVendors(d.vendors || []))
      .catch(() => setVendors([]))
      .finally(() => setLoadingVendors(false))
  }, [value.bankId])

  const selectedBank = useMemo(
    () => banks.find((b) => b.id === value.bankId),
    [banks, value.bankId],
  )

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <Field label="Bank" required hint={selectedBank?.code ? `Code: ${selectedBank.code}` : 'Select a bank to attribute the call to'}>
        <Select
          value={value.bankId}
          disabled={disabled || loadingBanks}
          onChange={(e) => onChange({ bankId: e.target.value, vendorId: '' })}
        >
          <option value="">{loadingBanks ? 'Loading…' : 'Select bank…'}</option>
          {banks.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name} {b.code ? `(${b.code})` : ''}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Vendor (optional)" hint={value.bankId ? 'Or leave blank to attribute directly to the bank' : 'Pick a bank first'}>
        <Select
          value={value.vendorId}
          disabled={disabled || !value.bankId || loadingVendors}
          onChange={(e) => onChange({ ...value, vendorId: e.target.value })}
        >
          <option value="">{loadingVendors ? 'Loading…' : value.bankId ? 'Direct (no vendor)' : '—'}</option>
          {vendors.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name} {v.code ? `(${v.code})` : ''}
            </option>
          ))}
        </Select>
      </Field>
      {error && <div className="md:col-span-2 text-xs text-red-500">{error}</div>}
    </div>
  )
}
