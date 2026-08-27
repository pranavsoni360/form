// Document specification for the loan application form.
//
// WHY THIS IS A MODULE AND NOT AN INLINE ARRAY
// The list used to live inside the step-5 JSX, which is why nothing could
// validate against it: `required: true` and the red asterisk were decoration,
// and an application could be submitted with no documents at all. Hoisting it
// means the gate, the render and the file-type rules all read one definition.
//
// EVERY DOCUMENT HAS ITS OWN JOURNEY
// "Upload" was the only verb the form knew, so every row got an Upload button —
// including ITR, which is fetchable, and Aadhaar, which DigiLocker already
// delivers during KYC. Asking someone to hunt for a PDF we can fetch (or have
// already fetched) is work we are pushing onto the customer for no reason, and
// it invites the wrong file: a photo of a bank statement is unparseable, but the
// form used to accept it.
//
// A document's journey is a property OF THE DOCUMENT, not of the screen. This
// module names it, and the step renders whatever that journey needs.

/**
 * How a document actually gets satisfied.
 *
 * - `fetch`     We retrieve it from a source the customer authorises (DigiLocker).
 *               No file is asked for. If the fetch already happened in KYC the
 *               row is simply shown as done.
 * - `vendor`    A third party collects and parses it through their own flow
 *               (Digitap bank-statement analysis). The customer is handed off
 *               and comes back; we never receive a raw file directly.
 * - `parse`     The customer uploads a file AND we extract data from it. The
 *               upload is not the end state — the extraction is.
 * - `upload`    We store the file for a human to read. No extraction, no API.
 *               The honest default when there is nothing smarter to do.
 */
export type DocJourney = "fetch" | "vendor" | "parse" | "upload";

/** Where a `fetch` journey gets its data. */
export type DocSource = "digilocker" | "upload";

export interface LoanDocSpec {
  key: string;
  label: string;
  required: boolean;
  /** How this document is obtained. Drives which UI the row renders. */
  journey: DocJourney;
  /** `accept` attribute — deliberately narrower than "any file". */
  accept: string;
  /** MIME/extension guard applied client-side before the upload fires. */
  extensions: string[];
  /** One line telling the customer what a valid file looks like. */
  hint: string;
  /**
   * What the customer is told the journey will DO, when it does more than
   * store the file. Shown on `parse` and `vendor` rows so the extra step is
   * expected rather than surprising.
   */
  journeyNote?: string;
  /**
   * Documents DigiLocker can satisfy on the customer's behalf during KYC. The
   * form shows these as already-provided rather than asking twice — which is
   * also why Documents must stay AFTER the KYC step, not before it.
   */
  autoFilledBy?: DocSource;
  /**
   * A `fetch`/`vendor` journey that is not yet wired end to end. The row still
   * renders and still accepts a manual upload, but we do NOT advertise an
   * automatic option the customer cannot actually use. Set to the reason.
   */
  automationPending?: string;
  /**
   * This document can ALSO be fetched from source, in addition to being
   * uploaded. Distinct from `journey: "fetch"`, where fetching is the expected
   * path — here upload stays a first-class equal, because the fetch costs the
   * customer something (ITR needs their income-tax portal password) and must
   * never be the only way through.
   */
  canGenerate?: boolean;
  /** Shown on the credential form, explaining what will and will not be kept. */
  generateNote?: string;
  /** Only shown for consumer-durable applications. */
  consumerDurableOnly?: boolean;
}

const IMG = [".jpg", ".jpeg", ".png"];
const PDF = [".pdf"];
const BOTH = [...IMG, ...PDF];

export const LOAN_DOCUMENTS: LoanDocSpec[] = [
  {
    key: "aadhaar_front_url",
    label: "Aadhaar Document",
    required: true,
    // DigiLocker returns the Aadhaar PDF, plus name/DOB/gender/address/photo,
    // during step 1. By the time the customer reaches Documents this is
    // normally already satisfied — so the row must not demand an upload.
    journey: "fetch",
    accept: ".jpg,.jpeg,.png,.pdf",
    extensions: BOTH,
    hint: "Fetched from DigiLocker when you verify your Aadhaar. Upload only if you skipped that step.",
    journeyNote: "Verified via DigiLocker",
    autoFilledBy: "digilocker",
  },
  {
    key: "photo_url",
    label: "Passport Size Photo",
    required: true,
    // Also delivered by DigiLocker (base64 JPEG in the Aadhaar payload).
    journey: "fetch",
    // Images ONLY. A PDF here breaks every downstream consumer that renders a
    // face — and customers do attach PDFs when the picker allows it.
    accept: ".jpg,.jpeg,.png",
    extensions: IMG,
    hint: "Taken from your Aadhaar record. Upload a recent photo only if it is missing.",
    journeyNote: "Retrieved with your Aadhaar",
    autoFilledBy: "digilocker",
  },
  {
    key: "bank_statements_url",
    label: "Bank Statements (Last 6 months)",
    required: true,
    // Collected via VG Account Aggregator: the customer is redirected to the
    // VG upload portal and returns; we receive the analysed report, not a raw
    // file. The row renders an AA initiation button, not a file picker.
    journey: "vendor",
    accept: ".pdf",
    extensions: PDF,
    hint: "Upload securely via Account Aggregator — last 6 months are fetched automatically.",
    journeyNote: "Analysed automatically to assess your cash flow",
  },
  {
    key: "salary_slips_url",
    // Not required: Aadhaar and photo are usually DigiLocker-satisfied, and the
    // bank statement is what actually reaches scoring. Kept because it is the
    // clearest income evidence an officer can read by eye, and because statement
    // analysis does not yet extract salary credits reliably.
    label: "Salary Slips (Last 3 months)",
    required: false,
    journey: "upload",
    accept: ".jpg,.jpeg,.png,.pdf",
    extensions: BOTH,
    hint: "Optional. Helps if your salary is not obvious from the statement.",
  },
  {
    key: "itr_form16_url",
    label: "ITR / Form 16",
    required: false,
    // Deliberately NOT a credential-based fetch. The ITR_Advance API exists and
    // takes the applicant's income-tax portal username and password — a
    // credential that controls their entire tax identity. A lender collecting
    // that, even in transit and even unstored, takes on liability far out of
    // proportion to an optional document. Form 26AS (no password) is the route
    // to revisit; until then this is an upload we parse, not a login we ask for.
    journey: "upload",
    // Fetching is OFFERED but never required: ITR_Advance authenticates with the
    // applicant's income-tax portal password, so upload must remain an equal
    // path for anyone unwilling to type it — which is a reasonable choice.
    canGenerate: true,
    generateNote: "We use your income-tax portal login once to fetch your return, then discard it. It is never saved.",
    accept: ".pdf",
    extensions: PDF,
    hint: "Optional. Upload the PDF, or generate it from the income-tax portal.",
  },
  {
    key: "proof_of_identification_url",
    label: "Proof of Identification",
    required: false,
    journey: "fetch",
    accept: ".jpg,.jpeg,.png,.pdf",
    extensions: BOTH,
    hint: "Covered by your verified Aadhaar. Upload another ID only if you skipped DigiLocker.",
    journeyNote: "Satisfied by DigiLocker Aadhaar",
    autoFilledBy: "digilocker",
  },
  {
    key: "proof_of_residence_url",
    label: "Proof of Residence",
    required: false,
    journey: "fetch",
    accept: ".jpg,.jpeg,.png,.pdf",
    extensions: BOTH,
    hint: "Covered by the address on your verified Aadhaar. Upload another proof only if you skipped DigiLocker.",
    journeyNote: "Satisfied by DigiLocker Aadhaar",
    autoFilledBy: "digilocker",
  },
  {
    key: "quotation_url",
    label: "Dealer Quotation",
    required: true,
    journey: "upload",
    accept: ".jpg,.jpeg,.png,.pdf",
    extensions: BOTH,
    hint: "The quotation from the dealer for the item you are financing.",
    consumerDurableOnly: true,
  },
];

/** The documents that apply to this application. */
export function documentsFor(loanType: string | undefined): LoanDocSpec[] {
  const isCD = (loanType || "personal") === "consumer_durable";
  return LOAN_DOCUMENTS.filter((d) => !d.consumerDurableOnly || isCD);
}

/** Required documents still missing, in display order. */
export function missingRequired(
  loanType: string | undefined,
  formData: Record<string, any>,
): LoanDocSpec[] {
  return documentsFor(loanType).filter((d) => d.required && !formData[d.key]);
}

/**
 * Was this document satisfied automatically, rather than by the customer
 * choosing a file? Drives the "Verified via DigiLocker" treatment instead of a
 * bare "Uploaded", so the customer can see the difference between what we
 * fetched and what they provided.
 */
export function wasAutoFilled(
  spec: LoanDocSpec,
  formData: Record<string, any>,
): boolean {
  if (!formData[spec.key]) return false;
  if (spec.journey !== "fetch") return false;
  // field_sources is written by the DigiLocker/PAN handlers; a key present
  // there means the value did not come from a file the customer picked.
  const src = formData.field_sources?.[spec.key];
  if (src && !src.modified) return true;
  // Aadhaar-derived rows: a verified Aadhaar is itself the evidence.
  return spec.autoFilledBy === "digilocker" && !!formData.aadhaar_verified;
}

/**
 * What the row should offer right now.
 *
 * `done`     satisfied — show what satisfied it, offer replace
 * `awaiting` a fetch/vendor journey could satisfy this but has not yet
 * `manual`   the customer must provide the file themselves
 */
export function journeyState(
  spec: LoanDocSpec,
  formData: Record<string, any>,
): "done" | "awaiting" | "manual" {
  if (formData[spec.key]) return "done";
  if (spec.journey === "fetch" && spec.autoFilledBy === "digilocker" && !formData.aadhaar_verified) {
    return "awaiting";
  }
  return "manual";
}

/**
 * Validate a chosen file against ONE document's rules.
 *
 * Extension is checked rather than MIME type: browsers report inconsistent MIME
 * for PDFs and some Android pickers send `application/octet-stream`, which would
 * reject valid files. Returns an error string, or "" when acceptable.
 *
 * NOTE: this is convenience only. The server re-validates by reading the file's
 * own leading bytes (backend/main.py validate_upload_content), because anything
 * decided in the browser can be bypassed.
 */
export function validateDocFile(spec: LoanDocSpec, file: File): string {
  const name = (file.name || "").toLowerCase();
  const ok = spec.extensions.some((e) => name.endsWith(e));
  if (!ok) {
    const pretty = spec.extensions.map((e) => e.replace(".", "").toUpperCase()).join(" or ");
    return `${spec.label} must be a ${pretty} file.`;
  }
  if (file.size > 5 * 1024 * 1024) return "File too large. Max 5MB allowed";
  if (file.size === 0) return "That file is empty. Please choose another.";
  return "";
}
