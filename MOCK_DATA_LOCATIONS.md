# Mock Data Locations

This document tracks all mock data in the LOS system. When integrating real data sources, update or remove these.

## Backend

| Location | What | Replace with |
|----------|------|-------------|
| `backend/main.py` → `POST /api/admin/seed-mock-data` | Seeds 3 banks, 6 bank users, 15 sample applications with mock AI suggestions | Remove endpoint when real data flows in |
| `backend/main.py` → `mock_ai_suggestion()` function | Generates random AI approve/deny/review with templated reasons based on income ratio | Replace with real AI scoring API |
| `backend/main.py` → mock applications in seed endpoint | 15 fake customer records with random names, phones, amounts, statuses | Real applications come from the form submission flow |

## Database

| Table | Mock data from | How to clean |
|-------|---------------|-------------|
| `banks` | Seed endpoint creates 3 banks (Buldhana Urban, HDFC Demo, SBI Demo) | `DELETE FROM banks WHERE code IN ('BUB', 'HDFC_DEMO', 'SBI_DEMO')` |
| `bank_users` | Seed creates 2 users per bank (officer + supervisor) | `DELETE FROM bank_users WHERE bank_id IN (SELECT id FROM banks WHERE code IN (...))` |
| `loan_applications` | Seed creates 15 apps with mock data | `DELETE FROM loan_applications WHERE loan_id LIKE 'MOCK-%'` |

## Frontend

| Location | What | Replace with |
|----------|------|-------------|
| No frontend mock data | All data comes from API | N/A |

## How to re-seed mock data

```bash
curl -sk -X POST https://localhost:8200/api/admin/seed-mock-data \
  -H "Authorization: Bearer <admin_token>"
```

## How to clean all mock data

```sql
DELETE FROM status_transitions WHERE application_id IN (SELECT id FROM loan_applications WHERE loan_id LIKE 'MOCK-%');
DELETE FROM loan_applications WHERE loan_id LIKE 'MOCK-%';
DELETE FROM bank_users WHERE bank_id IN (SELECT id FROM banks WHERE code IN ('BUB', 'HDFC_DEMO', 'SBI_DEMO'));
DELETE FROM banks WHERE code IN ('BUB', 'HDFC_DEMO', 'SBI_DEMO');
```
