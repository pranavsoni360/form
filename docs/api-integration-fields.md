# LOS Form — AI Review API Field Reference

**API Endpoint:** `http://10.200.10.83:5020/api/lrsAnalysisSummary/`  
**Method:** POST (JSON)  
**Purpose:** Submits applicant data for automated loan risk scoring  
**Last Updated:** 2026-04-09

---

## Status Legend

| Symbol | Meaning |
|--------|---------|
| ✅ | Ready — we have this field, no changes needed |
| 🔧 | Modify — we have the data but need format/code conversion |
| ➕ | Add — new field/column needed |
| ❓ | Ask Team — need clarification from the API team |

---

## 1. IDENTITY FIELDS

| # | API Field | Type | Example | Our Source | DB Column | Status |
|---|-----------|------|---------|------------|-----------|--------|
| 1 | `panNo` | string | `"ABCDE1234F"` | Form Step 1 (verified via VG API) | `pan_number` | ✅ |
| 2 | `firstName` | string | `"Rahul"` | Form Step 1 / PAN auto-fill | `first_name` | ✅ |
| 3 | `middleName` | string | `"Kumar"` | Form Step 1 / PAN auto-fill | `middle_name` | ✅ |
| 4 | `lastName` | string | `"Sharma"` | Form Step 1 / PAN auto-fill | `last_name` | ✅ |
| 5 | `dateOfBirth` | string | `"1995-08-15"` (YYYY-MM-DD) | Form Step 1 / DigiLocker | `date_of_birth` | ✅ |
| 6 | `phoneNo` | string | `"9876543210"` (10 digits, no +91) | OTP login | `phone` | ✅ (strip +91 prefix) |
| 7 | `gender` | string | `"Male"` | Form Step 1 / DigiLocker | `gender` | ✅ |
| 8 | `maritalStatus` | string | `"Single"` | Form Step 1 / DigiLocker | `marital_status` | ✅ |
| 9 | `enqId` | string | `"ENQ12345"` | Auto-generated | `loan_id` | ✅ (use loan_id) |

---

## 2. CURRENT ADDRESS

| # | API Field | Type | Example | Our Source | DB Column | Status | Notes |
|---|-----------|------|---------|------------|-----------|--------|-------|
| 10 | `currentAddress1` | string | `"123, MG Road, Near Station"` | Form Step 1 / DigiLocker | `current_address` | 🔧 | Split into: house, street, landmark, locality. Concatenate for API. |
| 11 | `pinCode` | string | `"440001"` | DigiLocker auto-fill | `pincode` | 🔧 | Currently hidden field. Show in split address UI. |
| 12 | `curr_state` | string (code) | `"269"` (Maharashtra) | DigiLocker (text) | `state` | 🔧 | Have text "Maharashtra". Need to map to API code using `getCodeList` (sqlMstId=5). |
| 13 | `curr_city` | string (code) | `"1234"` | DigiLocker (text) | `city` | 🔧 | Have text "Mumbai Suburban". Need to map to API code using `getCodeList` (sqlMstId=6, param=state_code). |
| 14 | `curr_country` | string (code) | `"1"` (India) | — | — | ✅ | Hardcode `"1"` (India). No form field. |

---

## 3. PERMANENT ADDRESS

| # | API Field | Type | Example | Our Source | DB Column | Status | Notes |
|---|-----------|------|---------|------------|-----------|--------|-------|
| 15 | `permanentAddress1` | string | `"456, Station Road"` | Form Step 1 | `permanent_address` | 🔧 | Split into structured fields. Mirror current when "Same as current" checked. |
| 16 | `per_state` | string (code) | `"269"` | — | — | ➕ | New DB column + form field needed. Copy from curr_state when same. |
| 17 | `per_city` | string (code) | `"1234"` | — | — | ➕ | New DB column + form field needed. Copy from curr_city when same. |
| 18 | `per_country` | string (code) | `"1"` | — | — | ✅ | Hardcode `"1"` (India). No form field. |

---

## 4. OCCUPATION & EMPLOYMENT

These fields require fetching standardized codes from the API's lookup endpoints.

| # | API Field | Type | Example | Our Source | DB Column | Lookup Endpoint | Status |
|---|-----------|------|---------|------------|-----------|-----------------|--------|
| 19 | `qualification` | string (code) | `"440"` (Graduation) | Form Step 2 dropdown | `qualification` | `getCodeList` sqlMstId=7 | 🔧 |
| 20 | `occupation` | string (code) | `"131"` (Service) | Form Step 2 dropdown | `occupation` | `getCodeList` sqlMstId=8 | 🔧 |
| 21 | `industryType` | string (code) | `"260470"` (IT Sector) | Form Step 2 dropdown | `industry_type` | `getCodeList` sqlMstId=10 | 🔧 |
| 22 | `employmentType` | string (code) | `"260492"` (Salaried Govt) | Form Step 2 dropdown | `employment_type` | `getCodeList` sqlMstId=9 | 🔧 |
| 23 | `employerName` | string | `"ABC Pvt Ltd"` | Form Step 2 / Voice Agent | `employer_name` | — | ✅ |
| 24 | `designation` | string | `"Developer"` | Form Step 2 / Voice Agent | `designation` | — | ✅ |
| 25 | `totalWorkExp` | string | `"5"` (years) | Form Step 2 | `total_work_experience` | — | ✅ |
| 26 | `totalWorkExpCurOrg` | string | `"2"` (years) | Form Step 2 | `experience_current_org` | — | ✅ |
| 27 | `residentialStatus` | string (code) | `"260512"` (Owned, no mortgage) | Form Step 2 dropdown | `residential_status` | `getCodeList` sqlMstId=11 | 🔧 |
| 28 | `tenureStatbility` | string (code) | `"260521"` (>3 years) | Form Step 2 dropdown | `tenure_stability` | `getCodeList` sqlMstId=12 | 🔧 |
| 29 | `employerAddress` | string | `"Pune, Maharashtra"` | Form Step 2 | `employer_address` | — | ✅ |

### Lookup Endpoints for Dropdowns

All use: `POST http://10.200.10.83:5020/api/getCodeList/`

| Dropdown | sqlMstId | param | Response Fields |
|----------|----------|-------|-----------------|
| Religion | 1 | — | `code_mst_id`, `code_desc` |
| Category | 2 | — | `code_mst_id`, `code_desc` |
| Country | 3 | — | `code_mst_id`, `code_desc` |
| State | 5 | — | `code_mst_id`, `code_desc` |
| City | 6 | state `code_mst_id` | `code_mst_id`, `code_desc` |
| Qualification | 7 | — | `code_mst_id`, `code_desc` |
| Occupation | 8 | — | `code_mst_id`, `code_desc` |
| Employment Type | 9 | — | `code_mst_id`, `code_desc` |
| Industry Type | 10 | — | `code_mst_id`, `code_desc` |
| Residential Status | 11 | — | `code_mst_id`, `code_desc` |
| Tenure Stability | 12 | — | `code_mst_id`, `code_desc` |
| Purpose of Loan | 13 | — | `code_mst_id`, `code_desc` |

---

## 5. LOAN & FINANCIAL

| # | API Field | Type | Example | Our Source | DB Column | Status |
|---|-----------|------|---------|------------|-----------|--------|
| 30 | `requestedLoanAmt` | string | `"500000"` | Form Step 3 / Voice Agent | `loan_amount_requested` | ✅ |
| 31 | `loanRepaymentPeriod` | string | `"36"` (months) | Form Step 3 | `repayment_period_years` | ✅ (convert years→months) |
| 32 | `purposeOfLoan` | string (code) | `"1021"` (Computer) | Form Step 3 dropdown | `purpose_of_loan` | 🔧 Fetch codes from API (sqlMstId=13) |
| 33 | `scheme` | string | `"Standard"` | Form Step 3 | `scheme` | ✅ |
| 34 | `monthlyGrossIncome` | string | `"60000"` | Form Step 3 / Voice Agent | `monthly_gross_income` | ✅ |
| 35 | `monthlyDeduction` | string | `"5000"` | Form Step 3 | `monthly_deductions` | ✅ |
| 36 | `monthlyEMI` | string | `"10000"` | Form Step 3 / Voice Agent | `monthly_emi_existing` | ✅ |
| 37 | `monthlyNetIncome` | string | `"45000"` | Form Step 3 | `monthly_net_income` | ✅ |

---

## 6. DOCUMENTS

| # | API Field | Type | Example | Our Source | DB Column | Status | Notes |
|---|-----------|------|---------|------------|-----------|--------|-------|
| 38 | `salarySlip` | string (URL/path) | `""` | Form Step 4 upload | — | ➕ | Add `salary_slips_url` column. UI exists, DB storage missing. |
| 39 | `itrDocument` | string (URL/path) | `""` | Form Step 4 upload | — | ➕ | Add `itr_form16_url` column. UI exists, DB storage missing. |
| 40 | `bankStatementDocument` | string (URL/path) | `""` | Form Step 4 upload | `bank_statement_url` | ✅ |

---

## 7. PARSED DOCUMENT DATA

| # | API Field | Type | Example | Our Source | DB Column | Status | Notes |
|---|-----------|------|---------|------------|-----------|--------|-------|
| 41 | `itrJsonData` | object | `{}` | — | — | ❓ | **Ask other team:** What structure? Do they provide parsing API? Send `{}` for now. |
| 42 | `bankStatementJsonData` | object | `{}` | — | — | ❓ | **Ask other team:** What structure? Do they provide parsing API? Send `{}` for now. |

---

## Summary

| Category | ✅ Ready | 🔧 Modify | ➕ Add | ❓ Ask Team | Total |
|----------|----------|-----------|--------|-------------|-------|
| Identity | 9 | 0 | 0 | 0 | 9 |
| Current Address | 1 | 3 | 0 | 0 | 4 |
| Permanent Address | 1 | 1 | 2 | 0 | 4 |
| Occupation | 4 | 6 | 0 | 0 | 10 |
| Loan & Financial | 7 | 1 | 0 | 0 | 8 |
| Documents | 1 | 0 | 2 | 0 | 3 |
| Parsed Data | 0 | 0 | 0 | 2 | 2 |
| **Total** | **23** | **11** | **4** | **2** | **42** |

---

## Implementation Priority

### Phase 1: DB + Form Changes
- Add columns: `salary_slips_url`, `itr_form16_url`, `per_state`, `per_city`
- Split address into structured fields (house, street, landmark, city, district, state, pincode)
- Add document upload handler for salary slips and ITR

### Phase 2: Dropdown Sync
- Fetch code lists from API's 12 `getCodeList` endpoints
- Cache responses (they rarely change)
- Update form dropdowns to show labels but store `code_mst_id`

### Phase 3: API Integration
- Build `api_mapping.py` — converts our data → API payload
- Call `lrsAnalysisSummary` as background task on form submission
- Store response in `system_suggestion`, `system_score`, `system_suggestion_reason`
- Transition status: `submitted` → `system_reviewed`

### Phase 4: Document Parsing (Pending)
- Waiting on other team for ITR/bank statement parsing APIs
- Send `{}` for `itrJsonData` and `bankStatementJsonData` until available

---

## Questions for API Team

1. What structure do you expect for `itrJsonData`? Do you provide an ITR parsing API?
2. What structure do you expect for `bankStatementJsonData`? Do you parse the uploaded PDF?
3. What exactly does `lrsAnalysisSummary` return? (fields, score range, suggestion format)
4. Which of the 42 fields are strictly required vs optional?
5. When will the public endpoint URL be available?
6. For `loanRepaymentPeriod` — do you expect months (`"36"`) or years (`"3"`)?
