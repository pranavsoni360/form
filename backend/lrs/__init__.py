"""LRS — Loan Recommendation System.

Config-driven credit scorecard: fetches applicant financials (Perfios/Karza),
runs a 5-pillar weighted scorecard, and outputs a decision + recommended
amount/tenure/EMI + risk-based interest rate. Isolated module (mirrors
backend/guarantor/): additive and best-effort — must never break form submit.
"""
