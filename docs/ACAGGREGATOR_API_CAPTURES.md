# AcAggregator (Digitap via VGDocverify) — captured responses

Live captures taken against `http://10.200.10.43/VGDocverify/AcAggregator.asmx`
on 2026-08-21. Everything below is a **real response**, not inferred. This closes
the four "NOT YET CONFIRMED" gaps in the vendor spec so the client can be written
once, against actual shapes.

Raw bodies are in the session scratchpad (`rep_type1.json`, `rep_type3.json`,
`inst_NetBanking.json`, `inst_Statement.json`) — move them somewhere durable if
they are needed for regression fixtures.

---

## Transport facts (all confirmed)

| Fact | Detail |
|---|---|
| Double JSON | Every body is `<payload>{"d":null}`. `json.loads` raises `Extra data`. Use `raw_decode`. |
| HTTP status | Always `200`, including for errors. |
| Real signal | The `status` field **inside** the body: `"success"` or `"error"`. |
| Error shape | `{"status":"error","message":"<http-ish>","result":{"status","code","msg"}}` — the useful part is `result.code`. |
| Auth | **None observed.** No key, token, or signature on any call. |
| Both hosts reachable | `10.200.10.43` (LAN) and `galaxypay.in:9002` (public) both answer. |

`backend/lrs/providers/vg_docverify.py::_parse_lenient_json` already handles the
double-JSON quirk and can be reused directly.

**Request envelope differs from the other VG APIs.** AcAggregator takes
`{"obj": { ... }}` — a bare object. The existing `_post()` helper sends
`{"obj": [ {...} ]}` (an array, plus `_common_params` bank/APICode fields).
AcAggregator needs its own transport function; do not reuse `_post`.

---

## 1. InstitutionList — CONFIRMED

`POST /InstitutionList` with `{"obj":{"type":"NetBanking"|"Statement"}}`

| type | count |
|---|---|
| `NetBanking` | 40 |
| `Statement` | 90 |

Row shape: `{id:int, name:str, inst_type:"Bank"|"FIP", form26as_enabled:bool, username_regex:str}`
(5 rows have `form26as_enabled: true`.)

### Corrections to the vendor spec

**Cooperative banks ARE present** — the spec said none. The `Statement` list has 11,
including several relevant to Finix's customer base:

```
73  Abhyudaya Co-Operative Bank Ltd      85  Janata Sahakari Bank Ltd.
173 Apna Sahakari Ban                    86  Kalyan Janata Sahakari Bank Ltd.
176 Gayatri Co Operative Urban Bank Ltd  69  Saraswat co-operative Bank Ltd
78  Thane Janata Sahakari Bank           83  Shamrao Vithal Co-op. Bank Ltd.
79  THE COSMOS CO-OP. BANK LTD           84  Telangana State Co-operative Apex Bank
90  Sarvodaya Commercial Co-Operactive Bank Limited
```

This changes the plan: the spec concluded "statement upload will be the primary
path, not AA" *because* no co-op banks were listed. That premise was wrong, so
the conclusion needs rechecking — though note `Apna Sahakari Ban` is truncated
and `Co-Operactive` is misspelled, so the data is untidy either way.

**Every `username_regex` compiles.** 0 failures across both lists. The `\s`→`s`
corruption the spec flagged is worse than a compile error: those patterns are
*silently wrong* (`[a-zA-Z0-9s@_]` accepts a literal `s`, not whitespace). Never
use these for validation — but the reason is wrongness, not breakage.

**Sandbox entities to filter** (ids): 93 ACME BANK, 94 FinShareBankServer,
96 Finvu Bank Ltd, 97 Finvu GSTN, 95 Setu FIP, 106 PineLabs, 107 Gpay.

**Defunct post-2019-amalgamation banks still listed:** Allahabad, Andhra,
Corporation, Dena, Oriental Bank of Commerce, Syndicate, United Bank of India,
Vijaya. Filter these — a borrower picking one cannot succeed.

---

## 2. Generateurl — CONFIRMED (per vendor spec, unchanged)

Success returns `{url, expires, status, request_id:int}`. No `txn_id` yet.
`url` points at `svcdemo.digitap.work` — Digitap's **demo** host.

---

## 3. statuscheck — **NOW CONFIRMED**

`POST /statuscheck` with `{"obj":{"request_id":"249722"}}`

```json
{
  "status": "success",
  "request_id": "249722",
  "txn_status": [
    {"code":"AAFIDataStatusError","status":"Failure",
     "msg":"FI Data request has been interrupted due to some error.",
     "txn_id":"da1216fb"},
    {"code":"ReportGenerated","status":"Success",
     "msg":"The report has been successfully generated for the transaction",
     "txn_id":"da1216fe"}
  ]
}
```

The important findings:

- **`txn_status` is an ARRAY, not a scalar** — one entry per attempt. A borrower
  who fails then retries produces several. Reading `[0]` would have picked up the
  FAILURE here and abandoned a request that actually succeeded.
- **`txn_id` is a STRING** (`"da1216fe"`), not an integer like `request_id`.
  Note `request_id` comes back as a string here but as an int from Generateurl.
- Two status levels: a coarse `status` (`Success`/`Failure`) and a specific
  `code` (`ReportGenerated`, `AAFIDataStatusError`).
- **Correct read:** scan the array for any entry with `status == "Success"` and
  take its `txn_id`. Only treat the request as failed when entries exist and none
  succeeded.

### Error cases

Unknown id (`999999`) **and** the spec's own `249979`:

```json
{"status":"error","message":"403-Forbidden",
 "result":{"status":"error","code":"TxnNotFound",
           "msg":"We could not find the Digitap Transaction referred by the client"}}
```

So `TxnNotFound` covers both "never existed" and "expired/other host" — the two
are indistinguishable. `249979` was valid in the earlier spec capture against
`galaxypay.in:9002`, which suggests request ids are **not shared across hosts**,
or they expire. Do not assume an id is reachable from a different host.

Codes seen: `ReportGenerated`, `AAFIDataStatusError`, `TxnNotFound`,
`TxnNotCompleted`. **This is not a complete enumeration** — keep treating
unrecognised codes as "still processing" rather than failing.

---

## 4. retrievereport — **NOW CONFIRMED**

`POST /retrievereport` with `{"obj":{"txn_id":"da1216fe","report_type":"json","report_subtype":"type3"}}`

| subtype | bytes | contents |
|---|---|---|
| `type1` | 4,965 | Raw statement: metadata + `banks[].accounts[].transactions[]` |
| `type2` | 100,980 | **Byte-identical to type3** |
| `type3` | 100,980 | type1 **plus** computed summaries and analysis blocks |

**type2 and type3 are the same response.** The spec assumed three distinct
payloads; there are two. Request `type3` and ignore the distinction.

### Use type3 — it carries the scoring metrics

`request_level_summary_var` (30 numeric fields, all `number`). Keys contain
spaces, dots and mixed case, so they must be quoted:

```
"Average EOD Balance"                  "Median EOD Balance"
"Max Balance" / "Min Balance"          "Max EOD Balance" / "Min EOD Balance"
"Total Amount of Credit Transactions"  "Total Amount of Debit Transactions"
"Total No. of Credit Transactions"     "Total No. of Debit Transactions"
"Total Amount of Cash Deposits"        "Total Amount of Cash Withdrawals"
"Total No. of Cash Deposits"           "Total No. of Cash Withdrawals"
"No. of EMI / loan payments"           "Total Amount of EMI / loan Payments"
"Sum of I/W Bounced"                   "Total No. of I/W Bounced"
"Total No. of I/W Chq Bounced"         "Total No.of I / W Bounced"
"Total Number of Outward Cheque Bounces"
"LoanDisbursal" / "loanDisbursal" / "totalLoanDisbursal"
"chqDeposits" / "totalChqDeposits"     "chqIssues" / "totalChqIssues"
"inw_chq_bounce_nonTechnical" / "total_inw_chq_bounce_nonTechnical"
```

Note the **duplicate-ish keys in three different naming styles**
(`LoanDisbursal`, `loanDisbursal`, `totalLoanDisbursal`; `Total No. of I/W
Bounced` vs `Total No.of I / W Bounced`). Pick one per metric deliberately and
comment why; do not assume they agree.

Also on type3:
- `status: "success"`, `statement_period_days: 31`
- `banks[].bank_level_summary_var` — same 30 keys, **identical to request level
  for a single account**. With multiple accounts they will diverge; use
  request-level for whole-applicant metrics.
- `banks[].accounts[]` adds: `analysis_data` (keys are per-month labels like
  `"May 2026*"` plus `Overall`, `Overall_max_sum`, `Overall_max_average` — note
  the asterisk), `daily_open_close_balances`, `recurrent_cr`, `recurrent_dr`,
  `loan_analysis` (empty `[]` here), `top_spent_categories`, `fraud_analysis`
  (keys are numeric strings `"0"`..`"22"` — a list-as-object), `credit_count_threshold`.

### Transaction shape

```json
{
  "amount": -10000,                    // NEGATIVE for debit
  "balance": "3162737.15",             // STRING
  "date": "2026-05-13",
  "transaction_timestamp": "2026-07-20T10:30:00.0",
  "type": "debit",                     // explicit direction
  "payment_mode": "IMPS",
  "mode_from_source": "OTHERS",
  "narration": "IMPS OUTWARD ORG ...",
  "category": "Transfer to XXXXXXXXXXXX0853 - KARUR VYSYA BANK",
  "sub_category": "", "reference": "...", "transaction_id": "...",
  "cheque_num": "", "remitter_beneficiary": "...", "legal_name": ""
}
```

**Mixed types:** `amount` is a number, `balance` is a string. Direction is
signalled twice — sign of `amount` and the `type` field. Prefer `type`; treat
the sign as corroboration.

### Error cases

Report for an incomplete txn (`da1216fb`, the failed attempt):

```json
{"status":"error","message":"400-Bad Request",
 "result":{"status":"error","code":"TxnNotCompleted",
           "msg":"The Digitap Transaction referred by Client has not been Completed"}}
```

---

## 5. PII warning — read before storing anything

The type3 report contains **unmasked personal data**:

```json
"customer_info": {"holding_type":"SINGLE","holders":[{
  "name":"Naveen kumar", "email":"Naveenkumar@gmail.com",
  "contact_number":"8422929344", "pan":"AAUPH1123J",
  "address":"450,aa Enclave, ... Bengaluru 560038",
  "dob":"1978-01-09", "landline":"08044123333",
  "ckyc_compliance":"YES", "nominee":"REGISTERED"}]}
```

Full name, email, phone, **PAN**, address, DOB — plus every transaction
narration with counterparty names. `source_report` is a **presigned S3 URL** to
`dg-bank-data-demo.s3.amazonaws.com` — anyone holding that link can fetch the
raw report until it expires.

Consequences for implementation:
- Storing the raw report means storing PAN + address + DOB. That interacts with
  the retention work (`services/retention.py`) and the PII-redaction setting
  already on the banks table.
- Do **not** log report bodies at info level.
- `source_report` should not be persisted or surfaced in an API response.

---

## Still open — vendor questions only

1. **Is there a production host?** Everything observed points at
   `svcdemo.digitap.work` and `dg-bank-data-demo.s3...`. Real borrower bank data
   must not flow through a demo environment — this is a go-live blocker.
2. **Is it genuinely unauthenticated?** No key/token/signature on any of the four
   calls. If so, anything that can reach the host can pull bank reports.
3. **HTTPS?** Both hosts are plaintext HTTP. Bank statements over unencrypted
   transport will not pass audit.
4. **Callback shape** — still unconfirmed; needs one real borrower journey with
   `txn_completed_cburl` pointed at a request bin. Capture body, `Content-Type`,
   all headers (signature?), source IP, and whether it retries.
5. **How long is a `txn_id` retrievable?** Determines whether the report must be
   stored or can be re-fetched. `TxnNotFound` on `249979` hints at expiry.
6. Rate limits. Full enumeration of `code` values. `aa_fi_types` beyond `DEPOSIT`.

---

## Implementation notes (for when we build)

- **Shape mismatch with LRS.** The provider contract (`fetch(ctx) -> dict`) is
  synchronous; this is a multi-step borrower journey with a callback. It needs a
  client + stored state, with the LRS provider reading the last completed fetch.
  `bank_statement` is currently served by `MockBankStmtProvider` — i.e. that
  pillar is scored on **fabricated numbers** today.
- Own transport function (bare `{"obj":{}}`, no `_common_params`).
- Parse `txn_status` as an array; success = any entry with `status=="Success"`.
- Request `type3` only.
- Treat unknown `code` values as "still processing".
- Callbacks are hints; always re-verify via statuscheck and always return 200.
  Keep this permanently, not just until the shape is known — without a signature
  the endpoint is forgeable.

---

# Addendum — corrections to the v2 vendor spec (verified 2026-08-21)

The updated spec is a big improvement (the `analysis_data.Overall` field list is
what makes the cash-flow pillar computable). Four claims in it are contradicted
by live captures. All four are recorded here so the client is not written against
them.

## 1. `username_regex` — absent from the Statement list entirely

The spec lists four banks with corrupted regexes and seven "safe" ones, implying
the field is present throughout. Measured:

| list | rows | rows WITH `username_regex` |
|---|---|---|
| `Statement` | 90 | **0** |
| `NetBanking` | 40 | 17 |

So `username_regex` exists **only on the NetBanking list**, and only on 17 of 40
rows. Reading `r.username_regex.includes(...)` throws `TypeError` on Statement
rows — which is exactly how this was found.

Of the 17 present, 3 are corrupted (backslashes stripped). They **compile
fine**, which is the danger — they are silently wrong, not broken:

```
4  Axis Bank        ^[a-zA-Z0-9s@_]{2,30}$          <- 's' is a literal s, not \s
17 Bank of Baroda   ^(?!.*..*.)[A-Za-z0-9.@s]{1,65}$
2  State Bank        ^(?![-_])(?!.*[_.-]{2})[ws.-@,]{3,30}(?<![-._])$
```

The spec also names IDFC FIRST as corrupted; it is not in the affected set here.

**Implementation:** treat `username_regex` as optional and never use it for
validation. It is irrelevant to statement upload anyway (no netbanking login).

## 2. Cooperative banks — present in Statement, absent from NetBanking

The spec says "No cooperative banks in the list" and draws the conclusion that
statement upload must therefore be the primary path. The premise is half right:

| list | co-op / sahakari entries |
|---|---|
| `Statement` | **10** — ids 69, 73, 78, 79, 83, 84, 85, 86, 90, 173, 176 |
| `NetBanking` | 0 |

So the conclusion holds for the AA/netbanking path but not for upload. Every one
of those ids was tested individually against `Generateurl` — **all 11 accepted**.

## 3. `institution_id` does NOT accept a comma-separated list

The spec says the pattern "accepts either bank name or comma-separated numeric
IDs". The regex permits commas, but Digitap rejects them:

```
institution_id = "1,2"        -> InvalidInstitution
institution_id = "69,73,78"   -> InvalidInstitution
institution_id = "69"         -> success
```

```json
{"status":"error","message":"400-Bad Request",
 "result":{"status":"error","code":"InvalidInstitution",
           "msg":"Client has sent an Institution Id that is not supported by Digitap"}}
```

**Implementation:** one institution per journey. A borrower with accounts at two
banks needs two journeys. New error code to handle: `InvalidInstitution`.

## 4. `TxnNotFound` also means "not started yet"

Not in the spec at all, and the most dangerous omission. A freshly created
request returns:

```json
{"status":"error","message":"403-Forbidden",
 "result":{"status":"error","code":"TxnNotFound","msg":"We could not find the Digitap Transaction..."}}
```

Digitap creates no transaction until the borrower actually opens the URL and
engages. So `TxnNotFound` covers three states — never existed, expired, and
**valid but untouched**.

**Implementation:** while `now < expires`, treat `TxnNotFound` as PENDING. Only
after `expires` is it failure. Getting this wrong marks a live application failed
while the borrower is still reading the upload page.

## 5. Upload rejects statements from a non-matching bank (client-side, code 065)

Confirmed by a real attempt. Uploading a `VIRTUAL URBAN CO-OPERATIVE BANK LTD`
statement into a journey scoped to Saraswat (69) gives, in the browser:

> Unable to detect the Bank Statement format for selected bank. Either the
> statement belong to different bank or unsupported format. (Error Code: 065)

Two consequences:

- **The `institution_id` must match the statement's actual issuing bank.** The UI
  has to make the borrower pick their bank before uploading, and the error has to
  be surfaced legibly.
- **`VIRTUAL URBAN CO-OPERATIVE BANK LTD` is not in Digitap's list** (the only
  "Urban" entry is 176 Gayatri). Digitap parses by per-bank PDF template, so an
  unlisted bank cannot be processed at any `institution_id`. Finix's customers
  are cooperative banks — **onboarding their formats with Digitap is a go-live
  dependency**, not a code task.

Also: error 065 is raised in Digitap's own UI, so it never reaches our callback
or `statuscheck`. A borrower can fail without producing any server-side signal —
another reason the request must expire to PENDING-then-failed rather than waiting
for a status that never arrives.

## 6. `form26as_enabled` — which banks

Relevant because it is an alternative income source that avoids collecting the
applicant's ITR-portal password:

```
1 HDFC Bank | 2 State Bank of India | 26 IndusInd Bank | 28 Karnataka Bank | 34 UCO Bank
```

## Still unconfirmed (unchanged)

- Callback body / headers / signature / retries
- A `statuscheck` response in pending/processing state
- type1 vs type2 — **note: type2 and type3 are byte-identical in the capture**,
  so the spec's "type1 and type2 report differences" is really one question
- Production host, auth, rate limits, `txn_id` retention window

---

# Addendum 2 — `TxnExpired` (captured 2026-08-21, after a real upload attempt)

The open question "what does a pending/processing status look like?" is partly
answered, and a **new terminal code** appeared:

```json
{"status":"success","request_id":"250131",
 "txn_status":[{"code":"TxnExpired","status":"Failure",
   "msg":"Requested transaction expired. (Error Code: 088)","txn_id":"da12185a"}]}
```

Two things this settles:

**1. `TxnExpired` is a distinct failure, reported as data not as an error
envelope.** `status:"success"` at the top level with a `Failure` attempt inside —
so the top-level status says "the query worked", not "the journey worked". Any
code that only checks the outer `status` would read this as success.

**2. A `txn_id` IS minted once the borrower engages, even on a doomed attempt**
(`da12185a` here). This is what distinguishes the two TxnNotFound cases:

| statuscheck result | meaning |
|---|---|
| `TxnNotFound` error envelope | borrower has not opened the link at all |
| `txn_status` with attempts | borrower engaged; read the attempts |

So the earlier reading holds — `TxnNotFound` is PENDING while unexpired — and it
now has a companion: once attempts exist, judge on them alone.

Confirmed code list grows to: `ReportGenerated` (Success),
`AAFIDataStatusError` (Failure), `TxnExpired` (Failure), plus the error-envelope
codes `TxnNotFound`, `TxnNotCompleted`, `InvalidInstitution`,
`InputValidationError`, `InvalidAAConsentRequestError`.

Still unseen: a genuinely *pending* attempt (borrower mid-upload). Treating any
unrecognised `status` as still-working remains the right default.

**Error 088 vs 065:** 065 (wrong bank format) fires inside Digitap's UI and never
reaches statuscheck. 088 (expired) does reach it. So the fallback sweep is still
required for 065 — some journeys fail with no server-side signal at all.
