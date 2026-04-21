# LOS Form — Field Reference

**Purpose:** Complete mapping of every field in the loan application form — what step it's on, where the data comes from, which API field it maps to, and current status.  
**Last Updated:** 2026-04-14

> **Keep this document in sync.** Any time a field is added, removed, or moved between steps, update this document. See also: `docs/api-integration-fields.md` for the raw API spec.

---

## Step 1: KYC & Identity

| # | Field | DB Column | Required | Source | API Field | API Type | Status |
|---|-------|-----------|----------|--------|-----------|----------|--------|
| 1 | PAN Number | `pan_number` | Yes | Manual + VG Verify API | `panNo` | string | Ready |
| 2 | Aadhaar Verification | `aadhaar_last4` | Yes | DigiLocker OAuth | — (not sent to API) | — | Ready |
| 3 | First Name | `first_name` | Yes | PAN / DigiLocker / Voice Call | `firstName` | string | Ready |
| 4 | Middle Name | `middle_name` | No | PAN / DigiLocker | `middleName` | string | Ready |
| 5 | Last Name | `last_name` | No | PAN / DigiLocker | `lastName` | string | Ready |
| 6 | Date of Birth | `date_of_birth` | Yes | Manual / DigiLocker | `dateOfBirth` | string (YYYY-MM-DD) | Ready |
| 7 | Gender | `gender` | Yes | Manual / DigiLocker | `gender` | string | Ready |
| 8 | Marital Status | `marital_status` | No | Manual / DigiLocker | `maritalStatus` | string | Ready |

### Auto-Mapped (no form field — derived at API call time)

| API Field | Value | Source |
|-----------|-------|--------|
| `enqId` | `loan_id` | Auto-generated on application creation |
| `phoneNo` | Strip `+91` from `phone` | OTP login |

---

## Step 2: Address Details

All address fields are auto-filled from DigiLocker's Aadhaar address object when available. User can edit any field after auto-fill.

### Current Address

| # | Field | DB Column | Required | Source | API Field | API Type | Status |
|---|-------|-----------|----------|--------|-----------|----------|--------|
| 9 | House / Flat No | `current_house` | Yes | DigiLocker (`addr.house`) / Manual | concat -> `currentAddress1` | — | Ready (implemented) |
| 10 | Street / Road | `current_street` | Yes | DigiLocker (`addr.street` / `addr.locality`) / Manual | concat -> `currentAddress1` | — | Ready (implemented) |
| 11 | Landmark | `current_landmark` | No | DigiLocker (`addr.landmark` / `addr.lm`) / Manual | concat -> `currentAddress1` | — | Ready (implemented) |
| 12 | Locality / Area | `current_locality` | No | DigiLocker (`addr.loc` / `addr.vtc`) / Manual | concat -> `currentAddress1` | — | Ready (implemented) |
| 13 | Pincode | `current_pincode` | Yes | DigiLocker (`addr.pin`) / Manual | `pinCode` | string (6 digits) | Modify (was hidden) |
| 14 | State | `current_state_code` | Yes | DigiLocker (`addr.state`) -> map to code / Dropdown (API) | `curr_state` | string (code) | Ready (implemented) |
| 15 | City / District | `current_city_code` | Yes | DigiLocker (`addr.district`) -> map to code / Dropdown (API, filtered by state) | `curr_city` | string (code) | Ready (implemented) |
| — | Country | — | Auto | Hardcode | `curr_country` | `"1"` (India) | Ready |

### Permanent Address

| # | Field | DB Column | Required | Source | API Field | API Type | Status |
|---|-------|-----------|----------|--------|-----------|----------|--------|
| 16 | Same as Current | `same_as_current` | — | Checkbox | — | — | Ready |
| 17 | Perm. House / Flat | `permanent_house` | Cond. | Manual / Copy from current | concat -> `permanentAddress1` | — | Ready (implemented) |
| 18 | Perm. Street / Road | `permanent_street` | Cond. | Manual / Copy from current | concat -> `permanentAddress1` | — | Ready (implemented) |
| 19 | Perm. Landmark | `permanent_landmark` | No | Manual / Copy from current | concat -> `permanentAddress1` | — | Ready (implemented) |
| 20 | Perm. Locality | `permanent_locality` | No | Manual / Copy from current | concat -> `permanentAddress1` | — | Ready (implemented) |
| 21 | Perm. Pincode | `permanent_pincode` | Cond. | Manual / Copy from current | concat -> `permanentAddress1` | — | Ready (implemented) |
| 22 | Perm. State | `permanent_state_code` | Cond. | Dropdown / Copy from current | `per_state` | string (code) | Ready (implemented) |
| 23 | Perm. City | `permanent_city_code` | Cond. | Dropdown / Copy from current | `per_city` | string (code) | Ready (implemented) |
| — | Perm. Country | — | Auto | Hardcode | `per_country` | `"1"` (India) | Ready |

### DigiLocker Address Mapping

The DigiLocker Aadhaar response provides a structured `address` object. Backend currently concatenates all parts into a single `current_address` string. With the new split fields, we map:

| DigiLocker Field | Form Field |
|-----------------|------------|
| `addr.house` | House / Flat No |
| `addr.street`, `addr.locality` | Street / Road |
| `addr.landmark`, `addr.lm` | Landmark |
| `addr.loc`, `addr.vtc` | Locality / Area |
| `addr.pin`, `addr.pc` | Pincode |
| `addr.state` | State (text -> need to map to `code_mst_id` via `getCodeList` sqlMstId=5) |
| `addr.district`, `addr.dist` | City / District (text -> need to map to `code_mst_id` via `getCodeList` sqlMstId=6) |

### API Payload Construction

Backend concatenates split fields when building `currentAddress1` / `permanentAddress1`:
```
currentAddress1 = ", ".join([house, street, landmark, locality])
```
State, city, pincode, country are sent as separate code fields.

---

## Step 3: Occupation & Employment

| # | Field | DB Column | Required | Source | API Field | API Type | Lookup | Status |
|---|-------|-----------|----------|--------|-----------|----------|--------|--------|
| 24 | Qualification | `qualification` | Yes | Dropdown (API codes) | `qualification` | code | sqlMstId=7 | Ready (API-synced) |
| 25 | Occupation | `occupation` | Yes | Dropdown (API codes) | `occupation` | code | sqlMstId=8 | Ready (API-synced) |
| 26 | Industry Type | `industry_type` | Yes | Dropdown (API codes) / Voice Call | `industryType` | code | sqlMstId=10 | Ready (API-synced) |
| 27 | Employment Type | `employment_type` | Yes | Dropdown (API codes) / Voice Call | `employmentType` | code | sqlMstId=9 | Ready (API-synced) |
| 28 | Employer Name | `employer_name` | No | Manual / Voice Call | `employerName` | string | — | Ready |
| 29 | Designation | `designation` | Yes | Manual / Voice Call | `designation` | string | — | Ready |
| 30 | Total Experience (yrs) | `total_work_experience` | Yes | Manual | `totalWorkExp` | string | — | Ready |
| 31 | Experience Current Org (yrs) | `experience_current_org` | No | Manual | `totalWorkExpCurOrg` | string | — | Ready |
| 32 | Residential Status | `residential_status` | Yes | Dropdown (API codes) | `residentialStatus` | code | sqlMstId=11 | Ready (API-synced) |
| 33 | Tenure Stability | `tenure_stability` | Yes | Dropdown (API codes) | `tenureStatbility` | code | sqlMstId=12 | Ready (API-synced) |
| 34 | Employer Address | `employer_address` | Yes | Manual | `employerAddress` | string | — | Ready |

### Voice Call Auto-Fill Fields

The voice agent collects these fields during outbound calls. They appear with green "Voice Call" badges when the customer opens the form:

- `employer_name` — from `collected_data.employer_name`
- `designation` — from `collected_data.designation`
- `employment_type` — from `collected_data.employment_type`
- `industry_type` — from `collected_data.business_type`

---

## Step 4: Loan & Financial Details

| # | Field | DB Column | Required | Source | API Field | API Type | Lookup | Status |
|---|-------|-----------|----------|--------|-----------|----------|--------|--------|
| 35 | Loan Amount (Rs.) | `loan_amount_requested` | Yes | Manual / Voice Call | `requestedLoanAmt` | string | — | Ready |
| 36 | Repayment Period | `repayment_period_years` | No | Dropdown (years) | `loanRepaymentPeriod` | string (months) | — | Ready (converted in payload builder) |
| 37 | Purpose of Loan | `purpose_of_loan` | Yes | Dropdown (API codes) / Voice Call | `purposeOfLoan` | code | sqlMstId=13 | Ready (API-synced) |
| 38 | Scheme | `scheme` | No | Manual | `scheme` | string | — | Ready |
| 39 | Monthly Gross Income (Rs.) | `monthly_gross_income` | Yes | Manual / Voice Call | `monthlyGrossIncome` | string | — | Ready |
| 40 | Monthly Deductions (Rs.) | `monthly_deductions` | No | Manual | `monthlyDeduction` | string | — | Ready |
| 41 | Existing Monthly EMIs (Rs.) | `monthly_emi_existing` | No | Manual / Voice Call | `monthlyEMI` | string | — | Ready |
| 42 | Monthly Net Income (Rs.) | `monthly_net_income` | Yes | Manual | `monthlyNetIncome` | string | — | Ready |
| 43 | Criminal Records | `criminal_records` | No | Checkbox | — (internal) | — | — | Ready |

### Voice Call Auto-Fill Fields

- `loan_amount_requested` — from `agent_calls.loan_amount`
- `monthly_gross_income` — from `collected_data.monthly_income`
- `monthly_emi_existing` — from `collected_data.existing_emi`
- `purpose_of_loan` — from `collected_data.loan_purpose`

---

## Step 5: Document Upload

| # | Document | DB Column | Required | Source | API Field | Status |
|---|----------|-----------|----------|--------|-----------|--------|
| 44 | Aadhaar Document | `aadhaar_front_url` | Yes | DigiLocker (auto-generated PDF) / Manual upload | — (internal) | Ready |
| 45 | Passport Photo | `photo_url` | Yes | DigiLocker (auto-extracted JPEG) / Manual upload | — (internal) | Ready |
| 46 | Salary Slips (3 months) | `salary_slips_url` | Yes | Manual upload | `salarySlip` | Ready |
| 47 | ITR / Form 16 | `itr_form16_url` | No | Manual upload | `itrDocument` | Ready |
| 48 | Bank Statements (6 months) | `bank_statements_url` | Yes | Manual upload | `bankStatementDocument` | Ready |
| 49 | Proof of Identification | `proof_of_identification_url` | No | Manual upload | — (internal) | Ready |
| 50 | Proof of Residence | `proof_of_residence_url` | No | Manual upload | — (internal) | Ready |

---

## Step 6: Review & Submit

Displays summary of all fields from steps 1-5. User must check declaration checkbox before submitting. No new data collected.

---

## API-Only Fields (no form field — auto-mapped or pending)

| API Field | Value | Source | Status |
|-----------|-------|--------|--------|
| `enqId` | `loan_id` | Auto-generated | Ready |
| `phoneNo` | Strip `+91` from `phone` | OTP login | Ready |
| `curr_country` | `"1"` | Hardcode (India) | Ready |
| `per_country` | `"1"` | Hardcode (India) | Ready |
| `itrJsonData` | `{}` | Pending — need parsing API from other team | Ask Team |
| `bankStatementJsonData` | `{}` | Pending — need parsing API from other team | Ask Team |

---

## Dropdown Lookup Endpoints

All dropdowns that need API codes use: `POST http://10.200.10.83:5020/api/getCodeList/`

| Dropdown | sqlMstId | Depends On | Used In |
|----------|----------|-----------|---------|
| State | 5 | — | Step 2: current/permanent state |
| City | 6 | State `code_mst_id` | Step 2: current/permanent city |
| Qualification | 7 | — | Step 3 |
| Occupation | 8 | — | Step 3 |
| Employment Type | 9 | — | Step 3 |
| Industry Type | 10 | — | Step 3 |
| Residential Status | 11 | — | Step 3 |
| Tenure Stability | 12 | — | Step 3 |
| Purpose of Loan | 13 | — | Step 4 |

Response format: `{ code_mst_id: "123", code_desc: "Label Text" }`

Dropdowns should show `code_desc` to the user but store `code_mst_id` in the database.

---

## Coverage Summary

| Status | Count | Details |
|--------|-------|---------|
| Ready | 40 | All form fields, dropdowns, address split, payload builder implemented |
| Pending other team | 2 | `itrJsonData`, `bankStatementJsonData` — send `{}` until parsing APIs available |
| **Total API fields** | **42** | **All covered** |

### Implementation Status (2026-04-14)
- DB migration: `database/migration_address_split.sql` — 14 address columns + field_sources + step constraint (1-6)
- Backend proxy: `GET /api/code-list/{sqlMstId}` — caches 1hr, hardcoded fallback on failure
- Backend DigiLocker: saves split address fields + resolves state/city codes
- Frontend: 6-step form, API-synced dropdowns, new Address step with DigiLocker auto-fill
- Payload builder: `build_api_payload()` in `backend/main.py` — ready but not called yet (awaiting public API endpoint)

---

## Data Source Legend

| Source | Description | Badge Color |
|--------|-------------|-------------|
| Manual | User types it in | No badge |
| PAN | Auto-filled from VG PAN Verify API | Blue "PAN" |
| DigiLocker | Auto-filled from Aadhaar via DigiLocker | Blue "Aadhaar" |
| Voice Call | Collected by AI voice agent during outbound call | Green "Voice Call" |
| Dropdown (API) | Selected from options fetched via `getCodeList` | No badge |
| Hardcode | Fixed value, no form field | N/A |
| Auto-generated | System-generated (e.g., loan_id) | N/A |

---

## Future Considerations

- **Voice Call coverage**: Currently collects employer, income, loan details. Could expand to collect more fields (qualification, experience, etc.) to reduce manual form filling.
- **Address via voice**: Address is complex to collect verbally. DigiLocker auto-fill is the primary source; manual entry is the fallback.
- **Accumn integration**: When credentials are obtained, ITR and bank statement parsing can populate `itrJsonData` and `bankStatementJsonData` automatically.
